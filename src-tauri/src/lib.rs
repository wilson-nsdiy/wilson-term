// Wilson Term - 库入口
// 主进程 Rust 实现，对应原 Electron src/main/*

pub mod commands;
pub mod connection;
pub mod keyboard;
pub mod logger;
pub mod plugin_host;
pub mod sftp;
pub mod storage;
pub mod updater;
pub mod types;

/// 应用运行入口
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let handle = app.handle().clone();
            // 注入各模块所需的全局 AppHandle（事件派发用）
            // 三个模块各自持 static GLOBAL_APP,setup 必须显式注入,否则
            // dispatch_host_key_verify/dispatch_password_request(ssh)
            // update:status-changed 派发、插件 IPC 命名空间派发都会失效
            commands::set_global_app(handle.clone());
            updater::set_global_app(handle.clone());
            plugin_host::set_global_app(handle.clone());
            // 初始化连接管理器、键盘锁监听等
            connection::manager::ensure_init();
            keyboard::init(&handle);
            log::info!("Wilson Term 启动完成");
            Ok(())
        })
        .invoke_handler(commands::register_all())
        .run(tauri::generate_context!())
        .expect("Tauri 启动失败");
}
