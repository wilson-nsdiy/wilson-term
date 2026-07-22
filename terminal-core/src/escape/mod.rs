//! 序列语义层
//!
//! 把 vtparse 产生的低层回调（`Action`）解析为结构化的终端控制枚举:
//! - [`csi`]:CSI 序列(SGR / 光标 / DEC private modes / Kitty keyboard)
//! - [`osc`]:OSC 命令(标题 / 颜色查询 / 超链接)
//! - [`dcs`]:DCS 入口(Sixel / 终端能力查询)
//! - [`apc`]:APC 入口(Kitty 图形协议)
//!
//! 借鉴 wezterm `wezterm-escape-parser/` 的分层架构。

pub mod apc;
pub mod csi;
pub mod dcs;
pub mod osc;
