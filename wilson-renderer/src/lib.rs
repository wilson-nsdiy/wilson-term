//! Wilson Term 渲染管线
//!
//! 桥接 [`terminal_core`] 终端核心与 wgpu 渲染。
//!
//! # 架构
//!
//! ```text
//! terminal-core (TerminalState + Screen)
//!   ↓
//! wilson-renderer (Renderer)
//!   ├── 从 Screen 提取可见行
//!   ├── 对每个 cell 查询 GlyphCache
//!   ├── 构建 vertex buffer（每个 cell 6 个顶点）
//!   └── 提交 wgpu render pass
//! ```
//!
//! 借鉴 WezTerm `wezterm-gui/src/termwindow/render/paint.rs`。

pub mod renderer;

pub use renderer::Renderer;
