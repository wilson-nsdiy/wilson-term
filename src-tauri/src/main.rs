// Wilson Term - Tauri 主入口
// 由 Electron 迁移而来，前端 React + xterm.js 保持不变

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    wilson_term_lib::run();
}
