//! VT 序列解析层
//!
//! 分层（借鉴 wezterm）：
//! - [`vtparse`]：低层状态机，把字节流分类成 `Action`，不做语义解释
//! - [`actor`]（待实现）：`VTActor` trait 桥接，把状态机输出转成结构化事件
//!
//! 当前仅完成 `vtparse` 的 fork，语义层在阶段 1.2 实现。

pub mod vtparse;
pub mod actor;
