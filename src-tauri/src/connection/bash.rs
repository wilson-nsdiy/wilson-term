// 本地终端 PTY 实现
// 对应 src/main/connection/bash-connection.ts
//
// 基于 portable-pty 0.8:
//   PtyPair { slave: Box<dyn SlavePty + Send>, master: Box<dyn MasterPty + Send> }
//   SlavePty::spawn_command(cmd) -> Box<dyn Child + Send + Sync>
//   MasterPty::take_writer() -> Box<dyn Write + Send>
//   MasterPty::try_clone_reader() -> Box<dyn Read + Send>
//   MasterPty::resize(size) / get_size()
//   Child::wait() -> ExitStatus, ChildKiller::kill()

use std::io::{Read, Write};
use std::process::Command;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};

use crate::types::{BashConfig, BashShellType, ShellInfo, SessionStatus};

/// 检测可用 Shell
pub fn detect_available_shells() -> Vec<ShellInfo> {
    let mut shells: Vec<ShellInfo> = vec![
        ShellInfo {
            kind: BashShellType::Auto,
            label: "自动检测".into(),
            available: true,
        },
        ShellInfo {
            kind: BashShellType::Cmd,
            label: "CMD".into(),
            available: true,
        },
    ];

    let ps_available = Command::new("where")
        .arg("powershell")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    shells.push(ShellInfo {
        kind: BashShellType::Powershell,
        label: "PowerShell".into(),
        available: ps_available,
    });

    shells
}

/// 解析 Shell 可执行文件
fn resolve_shell_program(shell_type: BashShellType) -> (&'static str, Vec<&'static str>) {
    match shell_type {
        BashShellType::Cmd => ("cmd.exe", vec![]),
        BashShellType::Powershell => ("powershell.exe", vec![]),
        BashShellType::Auto => {
            let ps = Command::new("where")
                .arg("powershell")
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            if ps {
                ("powershell.exe", vec![])
            } else {
                ("cmd.exe", vec![])
            }
        }
    }
}

/// Bash 连接
pub struct BashConnection {
    session_id: String,
    config: BashConfig,
    /// PTY master:用于写入数据和 resize
    master: Arc<tokio::sync::Mutex<Option<Box<dyn MasterPty + Send>>>>,
    /// 子进程:用于 wait/kill
    child: Arc<tokio::sync::Mutex<Option<Box<dyn portable_pty::Child + Send + Sync>>>>,
    /// writer:take_writer 后的写入句柄
    writer: Arc<tokio::sync::Mutex<Option<Box<dyn Write + Send>>>>,
}

impl BashConnection {
    pub fn new(session_id: String, config: BashConfig) -> Self {
        Self {
            session_id,
            config,
            master: Arc::new(tokio::sync::Mutex::new(None)),
            child: Arc::new(tokio::sync::Mutex::new(None)),
            writer: Arc::new(tokio::sync::Mutex::new(None)),
        }
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// 启动 PTY 并读取输出
    pub async fn connect(
        &self,
        on_data: Box<dyn Fn(String, String) + Send + Sync>,
        on_status: Box<dyn Fn(String, SessionStatus, Option<String>) + Send + Sync>,
    ) -> Result<()> {
        let shell_type = self.config.shell.unwrap_or(BashShellType::Auto);
        let (program, args) = resolve_shell_program(shell_type);

        // 启动目录
        let home = dirs::home_dir().unwrap_or_default();
        let cwd = self
            .config
            .cwd
            .as_ref()
            .map(|s| {
                if s.starts_with('~') {
                    let stripped: String = s.chars().skip(1).collect();
                    let trimmed = stripped.trim_start_matches('/').to_string();
                    home.join(trimmed)
                } else {
                    std::path::PathBuf::from(s)
                }
            })
            .unwrap_or_else(|| home.clone());
        let cwd = if cwd.exists() { cwd } else { home };

        // 构建 CommandBuilder
        let mut cmd = CommandBuilder::new(program);
        for a in &args {
            cmd.arg(a);
        }
        cmd.cwd(&cwd);

        // 注入环境
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        for (k, v) in std::env::vars() {
            cmd.env(k, v);
        }

        // 打开 PTY
        let pty_system = native_pty_system();
        let pty_pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| anyhow!("打开 PTY 失败: {}", e))?;

        // 启动子进程
        let child = pty_pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| anyhow!("启动本地终端失败: {}", e))?;

        // 获取 writer 和 reader
        let writer = pty_pair
            .master
            .take_writer()
            .map_err(|e| anyhow!("获取 PTY writer 失败: {}", e))?;
        let reader = pty_pair
            .master
            .try_clone_reader()
            .map_err(|e| anyhow!("获取 PTY reader 失败: {}", e))?;

        // 保存状态
        {
            let mut guard = self.master.lock().await;
            *guard = Some(pty_pair.master);
        }
        {
            let mut guard = self.child.lock().await;
            *guard = Some(child);
        }
        {
            let mut guard = self.writer.lock().await;
            *guard = Some(writer);
        }

        // 启动读取循环
        let sid = self.session_id.clone();
        let on_data = Arc::new(on_data);
        let on_status = Arc::new(on_status);
        let child_arc = self.child.clone();

        // 派发通道:把 spawn_blocking 线程内读到的数据/状态送回 async task 派发,
        // 避免在 spawn_blocking 内 tokio::spawn 派发任务,单线程 runtime 下会饿死
        let (data_tx, mut data_rx) =
            tokio::sync::mpsc::unbounded_channel::<Option<String>>();
        let (status_tx, mut status_rx) =
            tokio::sync::mpsc::unbounded_channel::<(
                String,
                SessionStatus,
                Option<String>,
            )>();
        // spawn_blocking 会 move sid 进闭包,先 clone 出 async task 所需副本
        let sid_data = sid.clone();

        tokio::task::spawn_blocking(move || {
            let mut reader = reader;
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data =
                            super::c1_convert::decode_buffer_for_terminal(&buf[..n]);
                        if !data.is_empty() {
                            crate::logger::write(&sid, "output", &data);
                            // 数据通过 mpsc 送回 async task 派发,避免 spawn_blocking 内
                            // tokio::spawn 在单线程 runtime 下饿死
                            let _ = data_tx.send(Some(data));
                        }
                    }
                    Err(_) => break,
                }
            }
            // 读取循环退出,通知 async task 数据流结束
            let _ = data_tx.send(None);

            // 等待子进程退出
            let mut child_guard = child_arc.blocking_lock();
            if let Some(mut child) = child_guard.take() {
                let status = child.wait();
                let success = status.as_ref().map(|s| s.success()).unwrap_or(false);
                let msg = if success { None } else { Some("进程退出".into()) };
                let _ = status_tx.send((
                    sid.clone(),
                    SessionStatus::Disconnected,
                    msg,
                ));
            }
        });

        // async 派发任务:消费 mpsc,调 on_data/on_status(在 tokio runtime 内,不会饿死)
        let on_data_async = on_data.clone();
        let on_status_async = on_status.clone();
        tokio::spawn(async move {
            while let Some(Some(data)) = data_rx.recv().await {
                on_data_async(sid_data.clone(), data);
            }
        });
        tokio::spawn(async move {
            while let Some((sid, status, msg)) = status_rx.recv().await {
                on_status_async(sid, status, msg);
            }
        });

        Ok(())
    }

    pub async fn disconnect(&self) -> Result<()> {
        {
            let mut guard = self.writer.lock().await;
            *guard = None;
        }
        {
            let mut guard = self.child.lock().await;
            if let Some(mut child) = guard.take() {
                // Child 也实现了 ChildKiller
                use portable_pty::ChildKiller;
                let mut killer = child.clone_killer();
                let _ = killer.kill();
                // 回收子进程避免僵尸进程:
                // kill 后内核把子进程标为 zombie,需 wait 才能彻底清理 PCB,
                // 长期运行不回收会耗 PID 表资源
                let _ = child.wait();
            }
        }
        Ok(())
    }

    pub async fn write(&self, data: &str) -> Result<()> {
        // PTY writer 是同步 std::io::Write,在 async 命令中直接调会阻塞 tokio worker。
        // 改用 spawn_blocking 把同步写投到专用阻塞线程池,async 上下文 await 其完成,
        // 不占用 tokio runtime worker。数据 clone 进闭包,writer 通过 Arc<Mutex> 共享。
        let writer_arc = self.writer.clone();
        let data_owned = data.as_bytes().to_vec();
        tokio::task::spawn_blocking(move || {
            use std::io::Write;
            let mut guard = writer_arc.blocking_lock();
            if let Some(writer) = guard.as_mut() {
                writer
                    .write_all(&data_owned)
                    .map_err(|e| anyhow!("PTY 写入失败: {}", e))?;
                writer.flush().ok();
            }
            Ok(())
        })
        .await
        .map_err(|e| anyhow!("write task join 失败: {}", e))?
    }

    pub async fn resize(&self, cols: u32, rows: u32) -> Result<()> {
        let guard = self.master.lock().await;
        if let Some(master) = guard.as_ref() {
            master
                .resize(PtySize {
                    rows: rows as u16,
                    cols: cols as u16,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| anyhow!("PTY resize 失败: {}", e))?;
        }
        Ok(())
    }
}
