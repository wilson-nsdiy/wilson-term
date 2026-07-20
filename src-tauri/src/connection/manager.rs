// 连接管理器：工厂 + 注册表 + 数据批处理
// 对应 src/main/connection/manager.ts + base-connection.ts

use std::collections::HashMap;
use std::sync::Arc;

use once_cell::sync::Lazy;
use parking_lot::RwLock;
use tauri::Emitter;

use crate::types::{ConnectionConfig, ConnectionType, LogConfig, SessionStatus};

use super::bash::BashConnection;
use super::serial::SerialConnection;
use super::ssh::{GlobalSshCallbacks, SshConnection};
use super::telnet::TelnetConnection;

/// 连接管理器单例持有的状态
pub struct ManagerState {
    pub ssh: RwLock<HashMap<String, Arc<SshConnection>>>,
    pub telnet: RwLock<HashMap<String, Arc<TelnetConnection>>>,
    pub serial: RwLock<HashMap<String, Arc<SerialConnection>>>,
    pub bash: RwLock<HashMap<String, Arc<BashConnection>>>,
}

impl Default for ManagerState {
    fn default() -> Self {
        Self {
            ssh: RwLock::new(HashMap::new()),
            telnet: RwLock::new(HashMap::new()),
            serial: RwLock::new(HashMap::new()),
            bash: RwLock::new(HashMap::new()),
        }
    }
}

static MANAGER_STATE: Lazy<ManagerState> = Lazy::new(ManagerState::default);

/// 初始化连接管理器
pub fn ensure_init() {
    // no-op: 状态由 Lazy 自动初始化
}

/// 创建并建立连接
pub async fn create(
    app: tauri::AppHandle,
    config: ConnectionConfig,
    log_config: Option<LogConfig>,
) -> Result<(), anyhow::Error> {
    let session_id = config.id().to_string();
    let kind = config.kind();

    // 创建日志写入器
    if let Some(log_config) = log_config.as_ref() {
        if log_config.log_enabled {
            crate::logger::create_logger(&session_id, log_config.clone(), config.clone());
        }
    }

    let on_data: Arc<dyn Fn(String, String) + Send + Sync> = Arc::new({
        let app = app.clone();
        move |sid: String, data: String| {
            let _ = app.emit("connection:data", (sid, data));
        }
    });

    let on_status: Arc<dyn Fn(String, SessionStatus, Option<String>) + Send + Sync> = Arc::new({
        let app = app.clone();
        move |sid: String, status: SessionStatus, err: Option<String>| {
            let _ = app.emit("connection:status", (sid, status, err));
        }
    });

    match kind {
        ConnectionType::Ssh => {
            let ssh_config = match &config {
                ConnectionConfig::Ssh(c) => c.clone(),
                _ => unreachable!(),
            };
            let conn = Arc::new(SshConnection::new(session_id.clone(), ssh_config));
            MANAGER_STATE.ssh.write().insert(session_id.clone(), conn.clone());
            let callbacks = Arc::new(GlobalSshCallbacks { app: app.clone() });
            conn.connect(callbacks, on_data, on_status).await?;
        }
        ConnectionType::Telnet => {
            let telnet_config = match &config {
                ConnectionConfig::Telnet(c) => c.clone(),
                _ => unreachable!(),
            };
            let conn = Arc::new(TelnetConnection::new(session_id.clone(), telnet_config));
            MANAGER_STATE.telnet.write().insert(session_id.clone(), conn.clone());
            let on_data_boxed: Box<dyn Fn(String, String) + Send + Sync> = {
                let on_data = on_data.clone();
                Box::new(move |s, d| on_data(s, d))
            };
            let on_status_boxed: Box<dyn Fn(String, SessionStatus, Option<String>) + Send + Sync> = {
                let on_status = on_status.clone();
                Box::new(move |s, st, e| on_status(s, st, e))
            };
            conn.connect(on_data_boxed, on_status_boxed).await?;
        }
        ConnectionType::Serial => {
            let serial_config = match &config {
                ConnectionConfig::Serial(c) => c.clone(),
                _ => unreachable!(),
            };
            let conn = Arc::new(SerialConnection::new(session_id.clone(), serial_config));
            MANAGER_STATE.serial.write().insert(session_id.clone(), conn.clone());
            let on_data_boxed: Box<dyn Fn(String, String) + Send + Sync> = {
                let on_data = on_data.clone();
                Box::new(move |s, d| on_data(s, d))
            };
            let on_status_boxed: Box<dyn Fn(String, SessionStatus, Option<String>) + Send + Sync> = {
                let on_status = on_status.clone();
                Box::new(move |s, st, e| on_status(s, st, e))
            };
            conn.connect(on_data_boxed, on_status_boxed).await?;
        }
        ConnectionType::Bash => {
            let bash_config = match &config {
                ConnectionConfig::Bash(c) => c.clone(),
                _ => unreachable!(),
            };
            let conn = Arc::new(BashConnection::new(session_id.clone(), bash_config));
            MANAGER_STATE.bash.write().insert(session_id.clone(), conn.clone());
            let on_data_boxed: Box<dyn Fn(String, String) + Send + Sync> = {
                let on_data = on_data.clone();
                Box::new(move |s, d| on_data(s, d))
            };
            let on_status_boxed: Box<dyn Fn(String, SessionStatus, Option<String>) + Send + Sync> = {
                let on_status = on_status.clone();
                Box::new(move |s, st, e| on_status(s, st, e))
            };
            conn.connect(on_data_boxed, on_status_boxed).await?;
        }
    }

    Ok(())
}

/// 断开并移除连接
pub async fn remove(session_id: &str) -> Result<(), anyhow::Error> {
    // 依次从各类型注册表移除,找到即断开
    let ssh_conn: Option<Arc<SshConnection>> = {
        MANAGER_STATE.ssh.write().remove(session_id)
    };
    if let Some(conn) = ssh_conn {
        let _ = conn.disconnect().await;
        crate::logger::close_logger(session_id).await;
        return Ok(());
    }
    let telnet_conn: Option<Arc<TelnetConnection>> = {
        MANAGER_STATE.telnet.write().remove(session_id)
    };
    if let Some(conn) = telnet_conn {
        let _ = conn.disconnect().await;
        crate::logger::close_logger(session_id).await;
        return Ok(());
    }
    let serial_conn: Option<Arc<SerialConnection>> = {
        MANAGER_STATE.serial.write().remove(session_id)
    };
    if let Some(conn) = serial_conn {
        let _ = conn.disconnect().await;
        crate::logger::close_logger(session_id).await;
        return Ok(());
    }
    let bash_conn: Option<Arc<BashConnection>> = {
        MANAGER_STATE.bash.write().remove(session_id)
    };
    if let Some(conn) = bash_conn {
        let _ = conn.disconnect().await;
        crate::logger::close_logger(session_id).await;
        return Ok(());
    }
    Ok(())
}

/// 写入数据
pub async fn write(session_id: &str, data: &str) -> Result<(), anyhow::Error> {
    // SSH
    let conn: Option<Arc<SshConnection>> = {
        let guard = MANAGER_STATE.ssh.read();
        guard.get(session_id).cloned()
    };
    if let Some(conn) = conn {
        return conn.write(data).await;
    }
    // Telnet
    let conn: Option<Arc<TelnetConnection>> = {
        let guard = MANAGER_STATE.telnet.read();
        guard.get(session_id).cloned()
    };
    if let Some(conn) = conn {
        return conn.write(data).await;
    }
    // Serial
    let conn: Option<Arc<SerialConnection>> = {
        let guard = MANAGER_STATE.serial.read();
        guard.get(session_id).cloned()
    };
    if let Some(conn) = conn {
        return conn.write(data).await;
    }
    // Bash
    let conn: Option<Arc<BashConnection>> = {
        let guard = MANAGER_STATE.bash.read();
        guard.get(session_id).cloned()
    };
    if let Some(conn) = conn {
        return conn.write(data).await;
    }
    Err(anyhow::anyhow!("会话 {} 不存在", session_id))
}

/// 调整终端尺寸
pub async fn resize(session_id: &str, cols: u32, rows: u32) -> Result<(), anyhow::Error> {
    let conn: Option<Arc<SshConnection>> = {
        let guard = MANAGER_STATE.ssh.read();
        guard.get(session_id).cloned()
    };
    if let Some(conn) = conn {
        return conn.resize(cols, rows).await;
    }
    let conn: Option<Arc<TelnetConnection>> = {
        let guard = MANAGER_STATE.telnet.read();
        guard.get(session_id).cloned()
    };
    if let Some(conn) = conn {
        return conn.resize(cols as u16, rows as u16).await;
    }
    let conn: Option<Arc<SerialConnection>> = {
        let guard = MANAGER_STATE.serial.read();
        guard.get(session_id).cloned()
    };
    if let Some(_conn) = conn {
        // 串口不支持 resize
        return Ok(());
    }
    let conn: Option<Arc<BashConnection>> = {
        let guard = MANAGER_STATE.bash.read();
        guard.get(session_id).cloned()
    };
    if let Some(conn) = conn {
        return conn.resize(cols, rows).await;
    }
    Err(anyhow::anyhow!("会话 {} 不存在", session_id))
}

/// 获取指定会话的 SSH 连接（供 SFTP 模块使用）
pub fn get_ssh_connection(session_id: &str) -> Option<Arc<SshConnection>> {
    let guard = MANAGER_STATE.ssh.read();
    guard.get(session_id).cloned()
}

/// 获取所有活跃会话 ID（跨所有连接类型）
/// 供插件系统在插件启用时向现有会话派发 notifySessionCreated。
pub fn get_session_ids() -> Vec<String> {
    let mut ids = Vec::new();
    {
        let guard = MANAGER_STATE.ssh.read();
        ids.extend(guard.keys().cloned());
    }
    {
        let guard = MANAGER_STATE.telnet.read();
        ids.extend(guard.keys().cloned());
    }
    {
        let guard = MANAGER_STATE.serial.read();
        ids.extend(guard.keys().cloned());
    }
    {
        let guard = MANAGER_STATE.bash.read();
        ids.extend(guard.keys().cloned());
    }
    ids
}
