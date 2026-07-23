//! 渲染器
//!
//! 从 [`terminal_core`] 的 `TerminalState` 提取可见行，
//! 构建 wgpu 顶点缓冲区并提交渲染。
//!
//! 借鉴 WezTerm `wezterm-gui/src/termwindow/render/paint.rs`。

use anyhow::Result;
use wgpu::{Device, Queue, TextureFormat, TextureView, RenderPass};

/// 渲染器
///
/// 持有 wgpu 渲染管线（着色器 + bind group + pipeline），
/// 每帧从终端状态提取可见行并渲染。
///
/// 借鉴 WezTerm `wezterm-gui/src/termwindow/render/mod.rs`。
pub struct Renderer {
    /// Surface 纹理格式（决定着色器输出）
    surface_format: TextureFormat,
    // TODO 阶段 6.2: wgpu render pipeline
    // TODO 阶段 6.3: vertex buffer 管理
    // TODO 阶段 6.4: GlyphCache 接入
}

impl Renderer {
    /// 创建渲染器
    ///
    /// `surface_format` 决定着色器输出格式。
    /// 在 Surface 配置完成后调用。
    pub fn new(device: &Device, surface_format: TextureFormat) -> Result<Self> {
        // TODO: 编译 WGSL 着色器、创建 render pipeline
        Ok(Self { surface_format })
    }

    /// Surface 格式变化时重新创建管线
    pub fn resize(&mut self, _width: u32, _height: u32) {
        // TODO: 重新配置 pipeline（如果格式变化）
    }

    /// 渲染一帧
    ///
    /// 流程（借鉴 WezTerm `paint.rs`）：
    /// 1. 从 `TerminalState` 提取可见行
    /// 2. 对每个 cell 查询 `GlyphCache`
    /// 3. 构建 vertex buffer（每个 cell 6 个顶点，2 个三角形）
    /// 4. 提交 wgpu render pass
    ///
    /// 当前为骨架实现：清屏为指定背景色。
    pub fn render(&self, _device: &Device, _queue: &Queue, _view: &TextureView) {
        // TODO: 完整渲染管线
    }

    /// 获取 Surface 纹理格式
    pub fn surface_format(&self) -> TextureFormat {
        self.surface_format
    }
}
