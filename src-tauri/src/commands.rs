// Tauri 命令注册中心
// 对应 src/main/ipc.ts 中所有 ipcMain.handle/on 注册

use std::sync::Mutex as StdMutex;

use once_cell::sync::Lazy;
use tauri::{AppHandle, Emitter, Window};

use crate::connection::{
    manager, ssh::{generate_key_pair, respond_host_key, respond_password},
    serial::list_ports, bash::detect_available_shells,
};
use crate::keyboard::get_keyboard_lock_state;
use crate::logger;
use crate::plugin_host;
use crate::sftp;
use crate::storage;
use crate::types::*;

// ========== Tauri 命令定义 ==========

#[tauri::command]
pub fn window_minimize(window: Window) {
    let _ = window.minimize();
}

#[tauri::command]
pub fn window_maximize(window: Window) {
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
}

#[tauri::command]
pub fn window_close(window: Window) {
    let _ = window.close();
}

#[tauri::command]
pub fn window_is_maximized(window: Window) -> bool {
    window.is_maximized().unwrap_or(false)
}

#[tauri::command]
pub fn window_toggle_devtools(app: AppHandle) {
    // Tauri 2 的 devtools 控制通过 WebviewWindow
    #[cfg(debug_assertions)]
    {
        use tauri::Manager;
        if let Some(webview) = app.get_webview_window("main") {
            if webview.is_devtools_open() {
                webview.close_devtools();
            } else {
                webview.open_devtools();
            }
        }
    }
    let _ = app;
}

#[tauri::command]
pub fn window_start_dragging(window: Window) {
    let _ = window.start_dragging();
}

#[tauri::command]
pub async fn connection_connect(
    app: AppHandle,
    config: ConnectionConfig,
    log_config: Option<LogConfig>,
) -> Result<(), String> {
    // 创建日志
    if let Some(lc) = log_config.as_ref() {
        if lc.log_enabled {
            logger::create_logger(config.id(), lc.clone(), config.clone());
        }
    }
    manager::create(app, config, log_config).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn connection_disconnect(session_id: String) -> Result<(), String> {
    manager::remove(&session_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn connection_write(session_id: String, data: String) -> Result<(), String> {
    manager::write(&session_id, &data).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn connection_resize(session_id: String, cols: u32, rows: u32) -> Result<(), String> {
    manager::resize(&session_id, cols, rows).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ssh_respond_host_key(session_id: String, accepted: bool) {
    respond_host_key(&session_id, accepted).await;
}

#[tauri::command]
pub async fn ssh_respond_password(session_id: String, password: String) {
    respond_password(&session_id, password).await;
}

#[tauri::command]
pub async fn ssh_generate_key_pair(key_type: Option<String>) -> KeyPairResult {
    let t = key_type.as_deref().unwrap_or("ed25519");
    generate_key_pair(t)
}

#[tauri::command]
pub fn serial_list_ports() -> Vec<SerialPortInfo> {
    list_ports()
}

#[tauri::command]
pub fn bash_list_shells() -> Vec<ShellInfo> {
    detect_available_shells()
}

#[tauri::command]
pub async fn sftp_list(session_id: String, remote_path: String) -> Result<Vec<SftpFileEntry>, String> {
    sftp::list(&session_id, &remote_path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_upload(session_id: String, local_path: String, remote_path: String) -> Result<SftpResult, String> {
    sftp::upload(&session_id, &local_path, &remote_path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_download(session_id: String, remote_path: String, local_path: String) -> Result<SftpResult, String> {
    sftp::download(&session_id, &remote_path, &local_path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_delete(session_id: String, remote_path: String, is_dir: bool) -> Result<SftpResult, String> {
    sftp::delete(&session_id, &remote_path, is_dir).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_mkdir(session_id: String, remote_path: String) -> Result<SftpResult, String> {
    sftp::mkdir(&session_id, &remote_path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_rename(session_id: String, old_path: String, new_path: String) -> Result<SftpResult, String> {
    sftp::rename(&session_id, &old_path, &new_path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn storage_load_saved_sessions() -> Vec<SavedSession> {
    storage::load_saved_sessions()
}

#[tauri::command]
pub fn storage_save_saved_sessions(sessions: Vec<SavedSession>) -> Result<(), String> {
    storage::save_saved_sessions(&sessions).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn storage_load_saved_session_groups() -> Vec<SavedSessionGroup> {
    storage::load_saved_session_groups()
}

#[tauri::command]
pub fn storage_save_saved_session_groups(groups: Vec<SavedSessionGroup>) -> Result<(), String> {
    storage::save_saved_session_groups(&groups).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn storage_load_command_button_groups() -> Vec<CommandButtonGroup> {
    storage::load_command_button_groups()
}

#[tauri::command]
pub fn storage_save_command_button_groups(groups: Vec<CommandButtonGroup>) -> Result<(), String> {
    storage::save_command_button_groups(&groups).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn storage_load_app_settings() -> Option<AppSettings> {
    storage::load_app_settings()
}

#[tauri::command]
pub fn storage_save_app_settings(settings: AppSettings) -> Result<(), String> {
    storage::save_app_settings(&settings).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn storage_load_view_state() -> Option<ViewState> {
    storage::load_view_state()
}

#[tauri::command]
pub fn storage_save_view_state(state: ViewState) -> Result<(), String> {
    storage::save_view_state(&state).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn storage_load_scheduled_tasks() -> std::collections::HashMap<String, Vec<ScheduledTask>> {
    storage::load_scheduled_tasks()
}

#[tauri::command]
pub fn storage_save_scheduled_tasks(tasks: std::collections::HashMap<String, Vec<ScheduledTask>>) -> Result<(), String> {
    storage::save_scheduled_tasks(&tasks).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn storage_load_profiles() -> Vec<Profile> {
    storage::load_profiles()
}

#[tauri::command]
pub fn storage_save_profiles(profiles: Vec<Profile>) -> Result<(), String> {
    storage::save_profiles(&profiles).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn keyboard_get_lock_state() -> KeyboardLockState {
    get_keyboard_lock_state()
}

#[tauri::command]
pub fn app_get_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub fn app_get_default_log_dir() -> String {
    logger::default_log_dir_str()
}

#[tauri::command]
pub fn app_get_domain() -> String {
    #[cfg(windows)]
    {
        use std::process::Command;
        // 简化：返回计算机名
        Command::new("hostname")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| "localhost".into())
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOSTNAME").unwrap_or_else(|_| "localhost".into())
    }
}

#[tauri::command]
pub async fn app_get_system_fonts() -> Result<Vec<String>, String> {
    // 简化：返回常见等宽字体列表
    Ok(vec![
        "Cascadia Code".into(),
        "Cascadia Mono".into(),
        "Consolas".into(),
        "Courier New".into(),
        "JetBrains Mono".into(),
        "Fira Code".into(),
        "Menlo".into(),
        "Monaco".into(),
        "Monospace".into(),
    ])
}

#[tauri::command]
pub async fn log_stop(session_id: String) -> Result<(), String> {
    logger::close_logger(&session_id).await;
    Ok(())
}

#[tauri::command]
pub async fn log_get_file_path(session_id: String) -> Option<String> {
    logger::get_file_path(&session_id).await
}

#[tauri::command]
pub async fn log_get_dir(session_id: String) -> Option<String> {
    logger::get_log_dir(&session_id).await
}

#[tauri::command]
pub async fn shell_open_external(app: AppHandle, url: String) -> Result<(), String> {
    // 已迁移到 tauri-plugin-opener(原 tauri-plugin-shell::open 已废弃且仅接受 URL)。
    // open_url 专门打开 http(s)/mailto/tel 等外部链接。
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn shell_open_path(app: AppHandle, path: String) -> Result<(), String> {
    // 用 tauri-plugin-opener 的 open_path 打开本地文件/目录。
    // 旧方案用 @tauri-apps/plugin-shell 的 open(path),其内部对参数做 URL 正则校验
    // ^((mailto:\w+)|(tel:\w+)|(https?://\w+)),本地路径无法匹配故报错。
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn shell_reveal_path(app: AppHandle, path: String) -> Result<(), String> {
    // 在文件管理器中打开 path 所在目录并选中 path(Win: explorer /select, macOS: Finder reveal, Linux: xdg-open)
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|e| e.to_string())
}

// ========== 插件命令 ==========
// 对应前端 window.api.plugin.* 的 8 个 invoke
// 底层逻辑在 plugin_host.rs(导入/导出/注册表/渲染代码)与 connection::manager(write/sessions)

#[tauri::command]
pub fn plugin_list() -> Vec<plugin_host::PluginListItem> {
    plugin_host::list_plugins()
}

#[tauri::command]
pub fn plugin_toggle(id: String, enabled: bool) -> bool {
    plugin_host::toggle_plugin(&id, enabled)
}

#[tauri::command]
pub fn plugin_import_zip(zip_path: Option<String>) -> plugin_host::PluginImportResult {
    // 前端未传路径时返回失败,引导用户通过对话框选择
    match zip_path {
        Some(p) if !p.is_empty() => plugin_host::import_plugin(&p),
        _ => plugin_host::PluginImportResult {
            success: false,
            plugin_id: None,
            error: Some("未提供插件 ZIP 路径".into()),
        },
    }
}

#[tauri::command]
pub fn plugin_export_zip(id: String) -> plugin_host::PluginExportResult {
    plugin_host::export_plugin(&id)
}

#[tauri::command]
pub fn plugin_uninstall(id: String) -> bool {
    plugin_host::uninstall_plugin(&id)
}

#[tauri::command]
pub fn plugin_get_renderer_code(id: String) -> Option<String> {
    plugin_host::get_renderer_code(&id)
}

/// 插件向终端会话写入数据(主进程统一出口,支持所有连接类型)
#[tauri::command]
pub async fn plugin_write(session_id: String, data: String) -> Result<(), String> {
    manager::write(&session_id, &data).await.map_err(|e| e.to_string())
}

/// 获取所有活跃会话 ID(插件启用时向现有会话派发 notifySessionCreated 用)
#[tauri::command]
pub fn plugin_get_sessions() -> Vec<String> {
    manager::get_session_ids()
}

// ========== 全局事件派发回调 ==========

/// 全局 AppHandle（事件派发用）
static GLOBAL_APP: Lazy<StdMutex<Option<AppHandle>>> = Lazy::new(|| StdMutex::new(None));

pub fn set_global_app(app: AppHandle) {
    *GLOBAL_APP.lock().unwrap() = Some(app);
}

/// 由 ssh.rs 调用：派发主机密钥验证请求事件给前端
pub fn dispatch_host_key_verify(request: HostKeyVerifyRequest) {
    if let Some(app) = GLOBAL_APP.lock().unwrap().as_ref() {
        let _ = app.emit("ssh:hostKeyVerify", request.clone());
    }
}

/// 由 ssh.rs 调用：派发密码输入请求事件给前端
pub fn dispatch_password_request(request: PasswordRequest) {
    if let Some(app) = GLOBAL_APP.lock().unwrap().as_ref() {
        let _ = app.emit("ssh:passwordRequest", request.clone());
    }
}

// ========== 命令注册 ==========

pub fn register_all() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        window_minimize,
        window_maximize,
        window_close,
        window_is_maximized,
        window_toggle_devtools,
        window_start_dragging,
        connection_connect,
        connection_disconnect,
        connection_write,
        connection_resize,
        ssh_respond_host_key,
        ssh_respond_password,
        ssh_generate_key_pair,
        serial_list_ports,
        bash_list_shells,
        sftp_list,
        sftp_upload,
        sftp_download,
        sftp_delete,
        sftp_mkdir,
        sftp_rename,
        storage_load_saved_sessions,
        storage_save_saved_sessions,
        storage_load_saved_session_groups,
        storage_save_saved_session_groups,
        storage_load_command_button_groups,
        storage_save_command_button_groups,
        storage_load_app_settings,
        storage_save_app_settings,
        storage_load_view_state,
        storage_save_view_state,
        storage_load_scheduled_tasks,
        storage_save_scheduled_tasks,
        storage_load_profiles,
        storage_save_profiles,
        keyboard_get_lock_state,
        app_get_version,
        app_get_default_log_dir,
        app_get_domain,
        app_get_system_fonts,
        log_stop,
        log_get_file_path,
        log_get_dir,
        shell_open_external,
        shell_open_path,
        shell_reveal_path,
        plugin_list,
        plugin_toggle,
        plugin_import_zip,
        plugin_export_zip,
        plugin_uninstall,
        plugin_get_renderer_code,
        plugin_write,
        plugin_get_sessions,
    ]
}
