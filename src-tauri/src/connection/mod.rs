// 连接管理模块入口
// 对应 src/main/connection/*

pub mod manager;
pub mod telnet;
pub mod ssh;
pub mod serial;
pub mod bash;
pub mod c1_convert;
pub mod protocol_parser;

use tauri::AppHandle;

/// 初始化连接管理器
pub fn init(_app: AppHandle) {
    // 全局状态在 manager 模块内通过 once_cell 持有
    manager::ensure_init();
}
