//! Wilson Term 终端核心库
//!
//! 本 crate 提供终端模拟器的核心能力：
//! - VT/ANSI/CSI/DCS/OSC 序列解析（fork 自 wezterm `vtparse`）
//! - 序列语义层（CSI/OSC/DCS/APC）
//! - 终端状态机（TerminalState + TermMode bitflags）
//! - 屏幕缓冲区（主屏/备屏 + 回滚）
//!
//! 架构分层借鉴 wezterm：
//! ```text
//! vtparse (状态机,产生 Action)
//!   ↓ VTActor trait
//! escape (语义层,产生结构化 CSI/OSC)
//!   ↓ Action 枚举
//! state (应用层,修改 TerminalState)
//! ```
//!
//! 详见 `docs/IMPLEMENTATION-GUIDELINE.md`。

#![allow(clippy::upper_case_acronyms)]

pub mod parser;
pub mod escape;
pub mod state;

/// crate 版本（从 Cargo.toml 注入）
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
