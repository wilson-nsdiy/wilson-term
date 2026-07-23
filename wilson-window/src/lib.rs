//! Wilson Term 窗口管理
//!
//! 基于 winit 0.30 的多窗口管理 + wgpu Surface 创建。
//!
//! # 架构
//!
//! 借鉴 WezTerm 的多窗口架构：
//! - 全局共享一个 wgpu `Instance` + `Adapter`
//! - 每个窗口独立 `Surface` + `Device` + `Queue`
//! - winit 负责窗口生命周期、事件循环
//!
//! # 多窗口协调
//!
//! ```text
//! App (wilson-app, 持 winit EventLoop + WgpuContext)
//!   ├── Window 1 → Surface 1 + Device 1 + Queue 1
//!   ├── Window 2 → Surface 2 + Device 2 + Queue 2
//!   └── Window N → Surface N + Device N + Queue N
//! ```

pub mod wgpu_state;

pub use wgpu_state::{WgpuContext, WgpuDevice};
pub use window::default_window_attributes;

mod window;
