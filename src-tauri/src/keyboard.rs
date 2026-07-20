// 键盘锁状态检测：CapsLock / NumLock / ScrollLock
// 对应 src/main/keyboard.ts

use std::sync::OnceLock;

use crate::types::KeyboardLockState;

/// 全局上次状态快照,用于变化检测
static LAST_STATE: OnceLock<std::sync::Mutex<KeyboardLockState>> = OnceLock::new();

/// 初始化键盘锁监听
///
/// 启动一个 tokio interval task 定期调 `get_keyboard_lock_state` 对比上次状态,
/// 变化时向所有窗口派发 `keyboard:lock-state-changed` 事件。
///
/// 原 Electron 实现通过定时轮询 + IPC 推送,Tauri 侧沿用同一思路:
/// - 间隔 250ms(与原 keyboard.ts 的 setInterval 一致)
/// - 状态无变化时不派发,减少前端 Zustand 更新
pub fn init(app: &tauri::AppHandle) {
    LAST_STATE
        .set(std::sync::Mutex::new(get_keyboard_lock_state()))
        .ok(); // 已初始化时忽略(测试重复 init 场景)

    let app_handle = app.clone();
    // 用 tauri::async_runtime::spawn 而非 tokio::spawn:
    // setup 闭包是同步的,此时主线程未进入 Tokio runtime 上下文,
    // 直接 tokio::spawn 会 panic "there is no reactor running"。
    // tauri::async_runtime::spawn 走 Tauri 内置 runtime,setup 阶段即可用。
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(250));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let current = get_keyboard_lock_state();

            // 对比上次状态,无变化跳过派发
            let changed = {
                let cell = LAST_STATE
                    .get()
                    .expect("keyboard::init 必须先被调用以初始化 LAST_STATE");
                let mut guard = cell.lock().expect("LAST_STATE 锁未毒化");
                let prev = *guard;
                if prev != current {
                    *guard = current;
                    true
                } else {
                    false
                }
            };

            if changed {
                use tauri::Emitter;
                let _ = app_handle.emit("keyboard:lock-state-changed", current);
            }
        }
    });
}

#[cfg(windows)]
pub fn get_keyboard_lock_state() -> KeyboardLockState {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CAPITAL, VK_NUMLOCK, VK_SCROLL};

    unsafe {
        let caps = (GetKeyState(VK_CAPITAL.0 as i32) & 0x0001) != 0;
        let num = (GetKeyState(VK_NUMLOCK.0 as i32) & 0x0001) != 0;
        let scroll = (GetKeyState(VK_SCROLL.0 as i32) & 0x0001) != 0;
        KeyboardLockState {
            caps_lock: caps,
            num_lock: num,
            scroll_lock: scroll,
        }
    }
}

#[cfg(not(windows))]
pub fn get_keyboard_lock_state() -> KeyboardLockState {
    KeyboardLockState {
        caps_lock: false,
        num_lock: false,
        scroll_lock: false,
    }
}
