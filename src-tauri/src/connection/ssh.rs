// SSH 连接实现
// 对应 src/main/connection/ssh-connection.ts
//
// 基于 russh 0.50 + russh-keys 0.50 + russh-sftp 2.3
// 自管理 known_hosts、agent、密钥
// 主机密钥验证与密码输入通过 tokio::sync::oneshot 异步等待前端响应

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use russh::client::{self, AuthResult, Handle};
use russh::keys::PrivateKeyWithHashAlg;
use russh::keys::ssh_key::PublicKey as SshKeyPublicKey;
use russh::keys::PublicKeyBase64;
use russh::{ChannelId, ChannelMsg};
use tokio::sync::{oneshot, Mutex, RwLock};

use crate::types::{
    HostKeyVerifyRequest, KeyPairResult, PasswordRequest, SshConfig, SessionStatus,
};

use super::c1_convert::decode_buffer_for_terminal;

const DEFAULT_KEY_FILES: &[&str] = &[
    "id_ed25519",
    "id_rsa",
    "id_ecdsa",
    "id_dsa",
    "identity",
];

const HOST_KEY_VERIFY_TIMEOUT: u64 = 60_000;
const PASSWORD_REQUEST_TIMEOUT: u64 = 120_000;

/// SSH 应用目录
fn get_ssh_dir() -> PathBuf {
    if cfg!(windows) {
        if let Ok(lad) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(lad).join("wilson-terminal").join(".ssh");
        }
    }
    dirs::home_dir().unwrap_or_default().join(".ssh")
}

fn get_known_hosts_path() -> PathBuf {
    get_ssh_dir().join("known_hosts")
}

fn ensure_known_hosts_file() -> std::io::Result<()> {
    let dir = get_ssh_dir();
    if !dir.exists() {
        std::fs::create_dir_all(&dir)?;
    }
    let p = get_known_hosts_path();
    if !p.exists() {
        std::fs::write(&p, "")?;
    }
    Ok(())
}

fn host_pattern(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_string()
    } else {
        format!("[{}]:{}", host, port)
    }
}

fn find_known_host_entries(host: &str, port: u16) -> Vec<String> {
    let p = get_known_hosts_path();
    let content = match std::fs::read_to_string(&p) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let pattern = host_pattern(host, port);
    content
        .lines()
        .filter(|l| {
            if l.trim().is_empty() || l.starts_with('#') {
                return false;
            }
            let parts: Vec<&str> = l.split_whitespace().collect();
            parts.len() >= 3 && parts[0] == pattern
        })
        .map(|s| s.to_string())
        .collect()
}

fn base64_encode(data: &[u8]) -> String {
    // 简化实现:使用 std::io::Write 接口
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity((data.len() + 2) / 3 * 4);
    let mut i = 0;
    while i + 3 <= data.len() {
        let b = &data[i..i + 3];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | (b[2] as u32);
        result.push(CHARS[((n >> 18) & 0x3f) as usize] as char);
        result.push(CHARS[((n >> 12) & 0x3f) as usize] as char);
        result.push(CHARS[((n >> 6) & 0x3f) as usize] as char);
        result.push(CHARS[(n & 0x3f) as usize] as char);
        i += 3;
    }
    if i < data.len() {
        let b = &data[i..];
        let n = (b[0] as u32) << 16 | (if b.len() > 1 { b[1] as u32 } else { 0 }) << 8;
        result.push(CHARS[((n >> 18) & 0x3f) as usize] as char);
        result.push(CHARS[((n >> 12) & 0x3f) as usize] as char);
        if b.len() > 1 {
            result.push(CHARS[((n >> 6) & 0x3f) as usize] as char);
        } else {
            result.push('=');
        }
        result.push('=');
    }
    result
}

fn verify_known_host_key(host: &str, port: u16, key: &[u8]) -> &'static str {
    let entries = find_known_host_entries(host, port);
    if entries.is_empty() {
        return "unknown";
    }
    let key_b64 = base64_encode(key);
    for entry in entries {
        let parts: Vec<&str> = entry.split_whitespace().collect();
        if parts.len() >= 3 && parts[2] == key_b64 {
            return "match";
        }
    }
    "mismatch"
}

fn add_to_known_hosts(host: &str, port: u16, key: &[u8], key_type: &str) -> std::io::Result<()> {
    ensure_known_hosts_file()?;
    let pattern = host_pattern(host, port);
    let key_b64 = base64_encode(key);
    let line = format!("{} {} {}\n", pattern, key_type, key_b64);
    let p = get_known_hosts_path();
    let mut file = std::fs::OpenOptions::new().append(true).open(p)?;
    use std::io::Write;
    file.write_all(line.as_bytes())?;
    Ok(())
}

fn get_default_private_key() -> Option<PathBuf> {
    let app_dir = get_ssh_dir();
    if app_dir.exists() {
        for f in DEFAULT_KEY_FILES {
            let p = app_dir.join(f);
            if p.exists() {
                return Some(p);
            }
        }
    }
    let home_ssh = dirs::home_dir()?.join(".ssh");
    if home_ssh.exists() {
        for f in DEFAULT_KEY_FILES {
            let p = home_ssh.join(f);
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}

fn get_available_agent() -> Option<String> {
    #[cfg(windows)]
    {
        if let Ok(out) = std::process::Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq Pageant.exe", "/NH"])
            .output()
        {
            if String::from_utf8_lossy(&out.stdout).contains("Pageant.exe") {
                return Some("pageant".into());
            }
        }
        let pipe = r"\\.\pipe\openssh-ssh-agent";
        if std::path::Path::new(pipe).exists() {
            return Some(pipe.into());
        }
        std::env::var("SSH_AUTH_SOCK").ok()
    }
    #[cfg(not(windows))]
    {
        std::env::var("SSH_AUTH_SOCK")
            .ok()
            .filter(|s| std::path::Path::new(s).exists())
    }
}

/// 生成 SSH 密钥对
pub fn generate_key_pair(key_type: &str) -> KeyPairResult {
    use std::process::Command;
    let ssh_dir = get_ssh_dir();
    if let Err(e) = ensure_known_hosts_file() {
        return KeyPairResult {
            success: false,
            private_key_path: None,
            public_key_path: None,
            error: Some(format!("创建 .ssh 目录失败: {}", e)),
        };
    }
    let key_name = match key_type {
        "rsa" => "id_rsa",
        _ => "id_ed25519",
    };
    let private_key_path = ssh_dir.join(key_name);
    let public_key_path = ssh_dir.join(format!("{}.pub", key_name));
    if private_key_path.exists() {
        return KeyPairResult {
            success: false,
            private_key_path: None,
            public_key_path: None,
            error: Some(format!(
                "密钥文件已存在：{}。如需重新生成，请先删除现有文件。",
                private_key_path.display()
            )),
        };
    }
    let t = match key_type {
        "rsa" => "rsa",
        _ => "ed25519",
    };
    let result = Command::new("ssh-keygen")
        .args(["-t", t, "-f", private_key_path.to_str().unwrap_or(""), "-N", ""])
        .output();
    match result {
        Ok(_) => KeyPairResult {
            success: true,
            private_key_path: Some(private_key_path.to_string_lossy().into()),
            public_key_path: Some(public_key_path.to_string_lossy().into()),
            error: None,
        },
        Err(e) => KeyPairResult {
            success: false,
            private_key_path: None,
            public_key_path: None,
            error: Some(format!("密钥生成失败: {}", e)),
        },
    }
}

/// SSH 异步回调 trait
pub trait SshCallbacks: Send + Sync {
    fn request_host_key_verify(
        &self,
        request: HostKeyVerifyRequest,
    ) -> oneshot::Receiver<bool>;
    fn request_password(
        &self,
        request: PasswordRequest,
    ) -> oneshot::Receiver<String>;
}

/// russh 自定义 handler
struct ClientHandler {
    session_id: String,
    config: SshConfig,
    callbacks: Arc<dyn SshCallbacks>,
}

impl client::Handler for ClientHandler {
    type Error = anyhow::Error;

    #[allow(refining_impl_trait_internal)]
    fn check_server_key(
        &mut self,
        server_public_key: &SshKeyPublicKey,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<bool>> + Send + 'static>> {
        // 把所需数据 clone 出来,避免生命周期绑定到 &'_ self
        let session_id = self.session_id.clone();
        let host = self.config.host.clone();
        let port = self.config.port;
        let callbacks = self.callbacks.clone();
        let key_bytes = server_public_key.public_key_bytes();
        let key_type = server_public_key.algorithm().to_string();
        Box::pin(async move {
            let verify_result = verify_known_host_key(&host, port, &key_bytes);

            if verify_result == "match" {
                return Ok(true);
            }

            let request = HostKeyVerifyRequest {
                session_id: session_id.clone(),
                host: host.clone(),
                port,
                key_type: key_type.clone(),
                fingerprint: base64_encode(&key_bytes),
                changed: verify_result == "mismatch",
            };

            let rx = callbacks.request_host_key_verify(request);
            match tokio::time::timeout(Duration::from_millis(HOST_KEY_VERIFY_TIMEOUT), rx).await {
                Ok(Ok(accepted)) => {
                    if accepted {
                        let _ = add_to_known_hosts(&host, port, &key_bytes, &key_type);
                        return Ok(true);
                    }
                    Ok(false)
                }
                _ => Ok(false),
            }
        })
    }
}

/// 全局回调注册表
static HOST_KEY_VERIFY_RESOLVERS: Lazy<RwLock<HashMap<String, oneshot::Sender<bool>>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));
static PASSWORD_RESOLVERS: Lazy<RwLock<HashMap<String, oneshot::Sender<String>>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

/// 响应主机密钥验证
pub async fn respond_host_key(session_id: &str, accepted: bool) {
    let mut guard = HOST_KEY_VERIFY_RESOLVERS.write().await;
    if let Some(tx) = guard.remove(session_id) {
        let _ = tx.send(accepted);
    }
}

/// 响应密码输入请求
pub async fn respond_password(session_id: &str, password: String) {
    let mut guard = PASSWORD_RESOLVERS.write().await;
    if let Some(tx) = guard.remove(session_id) {
        let _ = tx.send(password);
    }
}

/// 全局回调实现:桥接 Tauri 事件
pub struct GlobalSshCallbacks {
    pub app: tauri::AppHandle,
}

#[async_trait::async_trait]
impl SshCallbacks for GlobalSshCallbacks {
    fn request_host_key_verify(
        &self,
        request: HostKeyVerifyRequest,
    ) -> oneshot::Receiver<bool> {
        use tauri::Emitter;
        let (tx, rx) = oneshot::channel();
        let sid = request.session_id.clone();
        HOST_KEY_VERIFY_RESOLVERS.blocking_write().insert(sid, tx);
        let _ = self.app.emit("ssh:hostKeyVerify", request);
        rx
    }

    fn request_password(
        &self,
        request: PasswordRequest,
    ) -> oneshot::Receiver<String> {
        use tauri::Emitter;
        let (tx, rx) = oneshot::channel();
        let sid = request.session_id.clone();
        PASSWORD_RESOLVERS.blocking_write().insert(sid, tx);
        let _ = self.app.emit("ssh:passwordRequest", request);
        rx
    }
}

/// SSH 连接实例
pub struct SshConnection {
    session_id: String,
    config: SshConfig,
    handle: Arc<Mutex<Option<Handle<ClientHandler>>>>,
    channel_id: Arc<Mutex<Option<ChannelId>>>,
    /// 写入 channel 的发送端(用户输入数据)
    channel_writer: Arc<Mutex<Option<tokio::sync::mpsc::UnboundedSender<Vec<u8>>>>>,
    /// resize 请求发送端:(cols, rows)
    /// 通过同一 channel task 调 window_change,避免 Channel 跨 await 借用冲突
    resize_sender: Arc<Mutex<Option<tokio::sync::mpsc::UnboundedSender<(u32, u32)>>>>,
    /// SFTP 会话懒初始化复用,避免每次操作新开 channel + SFTP 握手
    /// (原 bug:每次命令都新开 channel,反复新建/销毁,SSH 服务器限流甚至拒连;
    ///  SftpSession 用完未显式关闭,channel 泄漏)
    /// russh-sftp 2.3 SftpSession 不 Clone,用 Arc<SftpSession> 共享
    sftp: Arc<Mutex<Option<Arc<russh_sftp::client::SftpSession>>>>,
}

impl SshConnection {
    pub fn new(session_id: String, config: SshConfig) -> Self {
        Self {
            session_id,
            config,
            handle: Arc::new(Mutex::new(None)),
            channel_id: Arc::new(Mutex::new(None)),
            channel_writer: Arc::new(Mutex::new(None)),
            resize_sender: Arc::new(Mutex::new(None)),
            sftp: Arc::new(Mutex::new(None)),
        }
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// 建立 SSH 连接并打开 shell channel
    pub async fn connect(
        &self,
        callbacks: Arc<dyn SshCallbacks>,
        on_data: Arc<dyn Fn(String, String) + Send + Sync>,
        on_status: Arc<dyn Fn(String, SessionStatus, Option<String>) + Send + Sync>,
    ) -> Result<()> {
        let _ = ensure_known_hosts_file();

        let config = russh::client::Config::default();
        let handler = ClientHandler {
            session_id: self.session_id.clone(),
            config: self.config.clone(),
            callbacks: callbacks.clone(),
        };

        let addr = format!("{}:{}", self.config.host, self.config.port);
        let connect_fut = russh::client::connect(Arc::new(config), &addr, handler);
        let mut handle = tokio::time::timeout(Duration::from_secs(30), connect_fut)
            .await
            .map_err(|_| anyhow!("连接超时：{}:{}", self.config.host, self.config.port))??;

        // 认证流程
        let auth_result = self.authenticate(&mut handle, callbacks.clone()).await?;
        if !auth_result {
            return Err(anyhow!("认证失败：所有认证方式均被拒绝"));
        }

        // 打开 shell channel
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| anyhow!("创建 shell 失败: {}", e))?;

        // 请求 PTY
        channel
            .request_pty(false, "xterm-256color", 80, 24, 0, 0, &[])
            .await
            .map_err(|e| anyhow!("PTY 请求失败: {}", e))?;

        // 请求 shell
        channel
            .request_shell(false)
            .await
            .map_err(|e| anyhow!("请求 shell 失败: {}", e))?;

        let channel_id = channel.id();
        *self.channel_id.lock().await = Some(channel_id);

        // 创建 channel 写入队列(用户输入数据)
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        *self.channel_writer.lock().await = Some(tx);

        // 创建 resize 请求队列:(cols, rows)
        // russh 0.50 Channel 不可 Clone 且 wait() 需 &mut,与 data()/window_change() 的 &self 冲突。
        // 解决:同一 task 持有 owned channel,用 select! 同时处理三类事件:
        //   1) 用户输入(rx.recv)→ channel.data()
        //   2) 服务器输出(channel.wait)→ 解码后 on_data 派发给前端
        //   3) resize 请求(resize_rx.recv)→ channel.window_change()
        let (resize_tx, mut resize_rx) =
            tokio::sync::mpsc::unbounded_channel::<(u32, u32)>();
        *self.resize_sender.lock().await = Some(resize_tx);

        let sid = self.session_id.clone();
        let on_status_clone = on_status.clone();

        tokio::spawn(async move {
            let mut channel = channel;
            let mut stdin_closed = false;
            let mut eof_sent = false;

            loop {
                tokio::select! {
                    // 用户输入 → 写入 channel
                    maybe_data = rx.recv(), if !stdin_closed => {
                        match maybe_data {
                            Some(data) => {
                                let cursor = std::io::Cursor::new(data);
                                if channel.data(cursor).await.is_err() {
                                    // channel 已坏,退出循环
                                    on_status(
                                        sid.clone(),
                                        SessionStatus::Disconnected,
                                        Some("channel 写入失败".to_string()),
                                    );
                                    break;
                                }
                            }
                            None => {
                                // 用户端关闭写入,送 EOF
                                stdin_closed = true;
                                if !eof_sent {
                                    let _ = channel.eof().await;
                                    eof_sent = true;
                                }
                            }
                        }
                    }
                    // resize 请求 → 通知服务器窗口变化
                    // russh 0.50 window_change 签名:(col_width, row_height, pix_width, pix_height)
                    maybe_resize = resize_rx.recv() => {
                        if let Some((cols, rows)) = maybe_resize {
                            let _ = channel
                                .window_change(cols, rows, 0, 0)
                                .await;
                        } else {
                            // resize 通道关闭(连接断开),忽略,等 channel.wait 收到 EOF 再退出
                        }
                    }
                    // 服务器输出 → 派发给前端
                    maybe_msg = channel.wait() => {
                        match maybe_msg {
                            Some(msg) => match msg {
                                ChannelMsg::Data { data } => {
                                    let decoded = decode_buffer_for_terminal(&data);
                                    // logger::write 先借 &decoded,再 on_data 把 decoded 移走
                                    crate::logger::write(&sid, "output", &decoded);
                                    on_data(sid.clone(), decoded);
                                }
                                ChannelMsg::Eof => {
                                    // 服务器关闭写端,等 channel.wait() 返回 None 后退出
                                }
                                ChannelMsg::Close => {
                                    let _ = channel.close().await;
                                    on_status(
                                        sid.clone(),
                                        SessionStatus::Disconnected,
                                        None,
                                    );
                                    break;
                                }
                                ChannelMsg::ExitStatus { exit_status: _ } => {
                                    // 命令退出码,不动作;继续等 Close
                                }
                                _ => {}
                            },
                            None => {
                                // channel 已关闭
                                on_status(
                                    sid.clone(),
                                    SessionStatus::Disconnected,
                                    None,
                                );
                                break;
                            }
                        }
                    }
                }
            }

            // 清理:确保 EOF 已发
            if !eof_sent {
                let _ = channel.eof().await;
            }
            let _ = on_status_clone;
        });

        *self.handle.lock().await = Some(handle);

        Ok(())
    }

    /// 根据 auth_type 进行认证
    async fn authenticate(
        &self,
        handle: &mut Handle<ClientHandler>,
        callbacks: Arc<dyn SshCallbacks>,
    ) -> Result<bool> {
        let username = self.config.username.clone();

        match self.config.auth_type {
            crate::types::SshAuthType::Password => {
                if let Some(pw) = self.config.password.as_ref() {
                    let result = handle
                        .authenticate_password(username, pw.clone())
                        .await?;
                    return Ok(result == AuthResult::Success);
                }
                // 空密码:尝试免密 + 密码回退
                self.try_keys_and_password(handle, callbacks).await
            }
            crate::types::SshAuthType::PrivateKey => {
                if let Some(path) = self.config.private_key.as_ref() {
                    let path = if path.starts_with('~') {
                        let stripped: String = path.chars().skip(1).collect();
                        let trimmed = stripped.trim_start_matches('/').to_string();
                        dirs::home_dir().unwrap_or_default().join(trimmed)
                    } else {
                        PathBuf::from(path)
                    };
                    let passphrase = self.config.passphrase.clone();
                    let key = russh::keys::load_secret_key(&path, passphrase.as_deref())?;
                    let key_arc = Arc::new(key);
                    let key_with_alg = PrivateKeyWithHashAlg::new(key_arc, None);
                    let result = handle
                        .authenticate_publickey(username, key_with_alg)
                        .await?;
                    return Ok(result == AuthResult::Success);
                }
                Err(anyhow!("密钥认证未提供 private_key 路径"))
            }
            crate::types::SshAuthType::None => {
                self.try_keys_and_password(handle, callbacks).await
            }
        }
    }

    /// 尝试默认私钥,失败后请求密码
    async fn try_keys_and_password(
        &self,
        handle: &mut Handle<ClientHandler>,
        callbacks: Arc<dyn SshCallbacks>,
    ) -> Result<bool> {
        let username = self.config.username.clone();
        let _ = get_available_agent();

        // 尝试默认私钥
        if let Some(key_path) = get_default_private_key() {
            if let Ok(key) = russh::keys::load_secret_key(&key_path, None) {
                let key_arc = Arc::new(key);
                let key_with_alg = PrivateKeyWithHashAlg::new(key_arc, None);
                let result = handle
                    .authenticate_publickey(username.clone(), key_with_alg)
                    .await?;
                if result == AuthResult::Success {
                    return Ok(true);
                }
            }
        }

        // 请求密码
        let request = PasswordRequest {
            session_id: self.session_id.clone(),
            host: self.config.host.clone(),
            port: self.config.port,
            username: username.clone(),
            prompt: username.clone(),
            retry: false,
        };
        let rx = callbacks.request_password(request);
        match tokio::time::timeout(Duration::from_millis(PASSWORD_REQUEST_TIMEOUT), rx).await {
            Ok(Ok(password)) => {
                if password.is_empty() {
                    return Ok(false);
                }
                let result = handle
                    .authenticate_password(username, password)
                    .await?;
                Ok(result == AuthResult::Success)
            }
            _ => Ok(false),
        }
    }

    pub async fn disconnect(&self) -> Result<()> {
        let mut guard = self.handle.lock().await;
        if let Some(handle) = guard.take() {
            let _ = handle.disconnect(russh::Disconnect::ByApplication, "", "en").await;
        }
        Ok(())
    }

    pub async fn write(&self, data: &str) -> Result<()> {
        let guard = self.channel_writer.lock().await;
        if let Some(tx) = guard.as_ref() {
            tx.send(data.as_bytes().to_vec())
                .map_err(|_| anyhow!("channel 已关闭"))?;
        }
        Ok(())
    }

    pub async fn resize(&self, cols: u32, rows: u32) -> Result<()> {
        // 通过 mpsc 把 (cols, rows) 送进 connect 启动的 channel task,
        // 由该 task 调 channel.window_change —— 避免跨 await 借用 Channel
        let guard = self.resize_sender.lock().await;
        if let Some(tx) = guard.as_ref() {
            tx.send((cols, rows))
                .map_err(|_| anyhow!("resize 通道已关闭(连接已断开)"))?;
        } else {
            return Err(anyhow!("resize 通道未建立(连接未建立或已断开)"));
        }
        Ok(())
    }

    /// 在已建立的 SSH 连接上打开 SFTP subsystem channel
    pub async fn open_sftp_channel(&self) -> Result<russh::Channel<russh::client::Msg>> {
        let handle_guard = self.handle.lock().await;
        let handle = handle_guard
            .as_ref()
            .ok_or_else(|| anyhow!("SSH 连接已断开"))?;
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| anyhow!("打开 SFTP channel 失败: {}", e))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| anyhow!("请求 SFTP subsystem 失败: {}", e))?;
        Ok(channel)
    }

    /// 懒初始化并复用 SFTP 会话
    ///
    /// 避免每次 SFTP 操作(list/upload/download/delete/mkdir/rename)都新开
    /// SSH channel + SFTP 握手,导致服务器限流甚至拒连、channel 泄漏。
    /// 首次调用建立 SftpSession 并存进 self.sftp,后续命令复用同一会话。
    /// russh-sftp 2.3 SftpSession 不 Clone,用 Arc<SftpSession> 共享。
    pub async fn get_or_create_sftp(&self) -> Result<Arc<russh_sftp::client::SftpSession>> {
        // 快路径:已存在直接 clone Arc
        {
            let guard = self.sftp.lock().await;
            if let Some(s) = guard.as_ref() {
                return Ok(s.clone());
            }
        }
        // 慢路径:建立新 SftpSession
        let channel = self.open_sftp_channel().await?;
        let session = russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| anyhow!("创建 SFTP 会话失败: {}", e))?;
        let session = Arc::new(session);
        // 双检:另一并发任务可能已建立
        {
            let mut guard = self.sftp.lock().await;
            if let Some(s) = guard.as_ref() {
                // 已被并发建立,丢弃本 session 用已有的
                return Ok(s.clone());
            }
            *guard = Some(session.clone());
        }
        Ok(session)
    }

    /// 显式关闭 SFTP 会话(disconnect 时调)
    pub async fn close_sftp(&self) {
        let mut guard = self.sftp.lock().await;
        if let Some(s) = guard.take() {
            // Arc::try_unwrap 取独占;若仍有其他命令持引用则跳过关闭,
            // 等所有引用 drop 后由 Arc 析构关闭
            if let Ok(s) = Arc::try_unwrap(s) {
                let _ = s.close().await;
            }
        }
    }
}

use once_cell::sync::Lazy;
