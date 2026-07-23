//! winit 窗口属性
//!
//! 窗口创建时的默认属性。
//! 窗口管理本身由 [`wilson_app`] 的 `ApplicationHandler` 实现,
//! 本 crate 只提供 wgpu 上下文 + 默认窗口属性。

use winit::window::WindowAttributes;

/// 默认窗口属性
///
/// 借鉴 WezTerm `window/src/os/winit.rs:WindowAttributes` 默认值。
pub fn default_window_attributes() -> WindowAttributes {
    WindowAttributes::default()
        .with_title("Wilson Term")
        .with_inner_size(winit::dpi::LogicalSize::new(1024, 768))
}
