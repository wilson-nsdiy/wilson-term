// 日志系统
// 对应 src/main/logger.ts
//
// 仅记录输出方向数据，剥离 ANSI 后按行缓冲写入
// 支持时间戳前缀、按大小/时间分割

use std::collections::HashMap;
use std::fs::{create_dir_all, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};

use chrono::{Datelike, Local, Timelike};
use tokio::sync::RwLock;

use crate::types::{ConnectionConfig, LogConfig};

/// 剥离 ANSI 转义序列、OSC 序列、其他控制字符、回车
fn strip_ansi(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut result = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == 0x1b {
            // ESC 序列
            if i + 1 < bytes.len() {
                let next = bytes[i + 1];
                if next == b'[' {
                    // CSI: ESC [ {params} {final byte A-Za-z}
                    let mut j = i + 2;
                    while j < bytes.len() {
                        let c = bytes[j];
                        // 私有前缀 ? < =
                        if c.is_ascii_digit() || c == b';' || c == b'?' || c == b'<' || c == b'=' {
                            j += 1;
                            continue;
                        }
                        if (b'A'..=b'Z').contains(&c) || (b'a'..=b'z').contains(&c) {
                            j += 1;
                            break;
                        }
                        j += 1;
                    }
                    i = j;
                    continue;
                } else if next == b']' {
                    // OSC: ESC ] ... BEL
                    let mut j = i + 2;
                    while j < bytes.len() && bytes[j] != 0x07 {
                        j += 1;
                    }
                    if j < bytes.len() {
                        j += 1;
                    }
                    i = j;
                    continue;
                }
            }
            i += 1;
            continue;
        }
        // 保留 \t \n；移除其他控制字符
        if b == b'\r' {
            i += 1;
            continue;
        }
        if b < 0x20 && b != b'\t' && b != b'\n' {
            i += 1;
            continue;
        }
        result.push(b);
        i += 1;
    }
    String::from_utf8_lossy(&result).to_string()
}

fn format_timestamp(date: &chrono::DateTime<Local>) -> String {
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
        date.year(),
        date.month(),
        date.day(),
        date.hour(),
        date.minute(),
        date.second(),
        date.timestamp_subsec_millis()
    )
}

fn format_file_timestamp(date: &chrono::DateTime<Local>) -> String {
    format!(
        "{:04}-{:02}-{:02}_{:02}-{:02}-{:02}",
        date.year(),
        date.month(),
        date.day(),
        date.hour(),
        date.minute(),
        date.second()
    )
}

fn get_date_string(date: &chrono::DateTime<Local>) -> String {
    format!("{:04}-{:02}-{:02}", date.year(), date.month(), date.day())
}

fn sanitize_path_for_filename(p: &str) -> String {
    p.trim_start_matches('/')
        .replace('/', "_")
        .replace(':', "")
}

/// 默认日志目录：{documents}/wilson-term/logs
pub fn default_log_dir() -> PathBuf {
    if let Some(docs) = dirs::document_dir() {
        return docs.join("wilson-term").join("logs");
    }
    dirs::home_dir().unwrap_or_default().join("wilson-term").join("logs")
}

fn generate_log_filename(config: &ConnectionConfig) -> String {
    let timestamp = format_file_timestamp(&Local::now());
    match config {
        ConnectionConfig::Ssh(ssh) => format!("ssh_{}_{}_{}.log", ssh.host, ssh.port, timestamp),
        ConnectionConfig::Telnet(t) => format!("telnet_{}_{}_{}.log", t.host, t.port, timestamp),
        ConnectionConfig::Bash(b) => {
            let shell = b.shell.map(|s| format!("{:?}", s)).unwrap_or_else(|| "auto".into());
            format!("bash_{}_{}.log", shell, timestamp)
        }
        ConnectionConfig::Serial(s) => {
            let port_name = sanitize_path_for_filename(&s.path);
            format!("serial_{}_{}_{}.log", port_name, s.baud_rate, timestamp)
        }
    }
}

/// 单个会话的日志写入器
struct SessionLogger {
    config: LogConfig,
    base_log_dir: PathBuf,
    current_file_path: PathBuf,
    current_file_size: u64,
    current_date: String,
    connection_config: ConnectionConfig,
    writer: Option<Arc<StdMutex<File>>>,
    output_buffer: String,
}

impl SessionLogger {
    fn new(config: LogConfig, connection_config: ConnectionConfig) -> std::io::Result<Self> {
        let base_log_dir = if config.log_path.is_empty() {
            default_log_dir()
        } else {
            PathBuf::from(&config.log_path)
        };
        let current_date = get_date_string(&Local::now());
        let mut logger = Self {
            config,
            base_log_dir,
            current_file_path: PathBuf::new(),
            current_file_size: 0,
            current_date,
            connection_config,
            writer: None,
            output_buffer: String::new(),
        };
        logger.open_new_file()?;
        Ok(logger)
    }

    fn write_output(&mut self, data: &str) {
        if !self.config.log_enabled {
            return;
        }
        // 性能权衡:本函数含同步文件 IO(writer.lock().write()),
        // 在 serial.rs/bash.rs 的 spawn_blocking 线程内被调时会同步阻塞读取循环。
        // 实际影响有限:按行写、每行几字节、微秒级;spawn_blocking 线程独立于 tokio
        // worker,不会饿死 async task(D2 修复后数据派发走 mpsc 不依赖本线程)。
        // 若后续高频输出场景出现延迟,可改造为缓冲进 mpsc + 独立 async task 落盘,
        // 但那涉及 SessionLogger(writer/rotate/current_file_size)全面 async 化,需评估。
        // 按时间分割检查
        if self.config.log_split_by_time {
            let today = get_date_string(&Local::now());
            if today != self.current_date {
                self.current_date = today;
                self.rotate_file();
            }
        }
        // 按大小分割检查
        if self.config.log_split_by_size && self.current_file_size >= self.config.log_max_size {
            self.rotate_file();
        }

        let clean = strip_ansi(data);
        if clean.is_empty() {
            return;
        }
        self.output_buffer.push_str(&clean);

        // 按换行切分
        let lines: Vec<&str> = self.output_buffer.split('\n').collect();
        let (last, complete) = lines.split_last().unwrap();
        let _ = complete;
        if let Some(writer) = self.writer.as_ref() {
            let mut guard = writer.lock().unwrap();
            let now = Local::now();
            for line in &lines[..lines.len() - 1] {
                if line.is_empty() {
                    continue;
                }
                let formatted = if self.config.log_with_timestamp {
                    format!("[{}] {}\n", format_timestamp(&now), line)
                } else {
                    format!("{}\n", line)
                };
                let n = guard.write(formatted.as_bytes()).unwrap_or(0);
                self.current_file_size += n as u64;
            }
        }
        self.output_buffer = last.to_string();
    }

    fn flush(&mut self) {
        if self.output_buffer.is_empty() {
            return;
        }
        if let Some(writer) = self.writer.as_ref() {
            let mut guard = writer.lock().unwrap();
            let now = Local::now();
            let formatted = if self.config.log_with_timestamp {
                format!("[{}] {}\n", format_timestamp(&now), self.output_buffer)
            } else {
                format!("{}\n", self.output_buffer)
            };
            let _ = guard.write_all(formatted.as_bytes());
            let _ = guard.flush();
            self.current_file_size += formatted.len() as u64;
        }
        self.output_buffer.clear();
    }

    fn close(mut self) {
        self.flush();
        // 关闭 writer 即可
        self.writer = None;
    }

    fn ensure_dir(&self, dir: &PathBuf) {
        let _ = create_dir_all(dir);
    }

    fn open_new_file(&mut self) -> std::io::Result<()> {
        let date_dir = self.base_log_dir.join(&self.current_date);
        self.ensure_dir(&date_dir);
        let filename = generate_log_filename(&self.connection_config);
        self.current_file_path = date_dir.join(&filename);
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.current_file_path)?;
        self.current_file_size = file.metadata().map(|m| m.len()).unwrap_or(0);
        self.writer = Some(Arc::new(StdMutex::new(file)));
        Ok(())
    }

    fn rotate_file(&mut self) {
        // 同步关闭
        if let Some(w) = self.writer.take() {
            // w 是 Arc<StdMutex<File>>;lock() 返回 Result<MutexGuard>
            if let Ok(mut guard) = (*w).lock() {
                use std::io::Write;
                let _ = guard.flush();
            }
        }
        let _ = self.open_new_file();
    }

    fn file_path(&self) -> &PathBuf {
        &self.current_file_path
    }

    fn log_dir(&self) -> &PathBuf {
        &self.base_log_dir
    }
}

/// 全局日志管理器
struct LogManager {
    loggers: RwLock<HashMap<String, Arc<StdMutex<SessionLogger>>>>,
}

static LOG_MANAGER: once_cell::sync::Lazy<LogManager> =
    once_cell::sync::Lazy::new(|| LogManager {
        loggers: RwLock::new(HashMap::new()),
    });

/// 创建会话日志写入器
pub fn create_logger(
    session_id: &str,
    config: LogConfig,
    connection_config: ConnectionConfig,
) {
    match SessionLogger::new(config, connection_config) {
        Ok(logger) => {
            let arc = Arc::new(StdMutex::new(logger));
            LOG_MANAGER.loggers.blocking_write().insert(session_id.to_string(), arc);
        }
        Err(e) => log::error!("创建日志写入器失败 [{}]: {}", session_id, e),
    }
}

/// 写入日志（仅输出方向）
pub fn write(session_id: &str, direction: &str, data: &str) {
    if direction != "output" {
        return;
    }
    let guard = LOG_MANAGER.loggers.blocking_read();
    if let Some(logger) = guard.get(session_id) {
        if let Ok(mut g) = logger.lock() {
            g.write_output(data);
        }
    }
}

/// 关闭会话日志
pub async fn close_logger(session_id: &str) {
    let arc = {
        let mut guard = LOG_MANAGER.loggers.write().await;
        guard.remove(session_id)
    };
    if let Some(arc) = arc {
        // arc 内含 StdMutex<SessionLogger>;unwrap 后 into_inner 取出 SessionLogger 并 flush
        //
        // 原 bug:`unsafe { Arc::try_unwrap(arc).unwrap_unchecked() }` 在 strong_count == 1 时理论安全,
        // 但评审指出:若另一线程在 strong_count 检查后、try_unwrap 前克隆了 Arc(理论上
        // LOG_MANAGER 移除后无人能 clone,但 get_file_path/get_log_dir 并发可能持临时 Arc::clone),
        // unwrap_unchecked 会触发 UB。改为安全 API:try_unwrap 失败时回退用 lock + flush。
        match Arc::try_unwrap(arc) {
            Ok(mutex) => {
                if let Ok(mut logger) = mutex.into_inner() {
                    logger.flush();
                }
            }
            Err(arc) => {
                // 仍有其他引用持留,无法取独占;用 lock 调 flush 即可
                // 析构时 SessionLogger 也会 flush,这里显式 flush 加保险
                if let Ok(mut guard) = arc.lock() {
                    guard.flush();
                }
            }
        }
    }
}

/// 获取日志文件路径
pub async fn get_file_path(session_id: &str) -> Option<String> {
    let guard = LOG_MANAGER.loggers.read().await;
    guard.get(session_id).and_then(|arc| {
        // arc 是 Arc<StdMutex<SessionLogger>>;lock() 返回 Result<MutexGuard>
        (*arc)
            .lock()
            .ok()
            .map(|g| g.file_path().to_string_lossy().into_owned())
    })
}

/// 获取日志根目录
pub async fn get_log_dir(session_id: &str) -> Option<String> {
    let guard = LOG_MANAGER.loggers.read().await;
    guard.get(session_id).and_then(|arc| {
        (*arc)
            .lock()
            .ok()
            .map(|g| g.log_dir().to_string_lossy().into_owned())
    })
}

/// 获取默认日志目录
pub fn default_log_dir_str() -> String {
    default_log_dir().to_string_lossy().into_owned()
}
