//! wgpu 上下文管理
//!
//! 全局共享 `Instance` + `Adapter`，每窗口独立 `Device` + `Queue` + `Surface`。
//!
//! 借鉴 WezTerm `wezterm-gui/src/termwindow/webgpu.rs` 的多窗口 Surface 管理。

use std::sync::Arc;

use anyhow::{Context, Result};
use wgpu::Surface;
use winit::window::Window;

/// 全局 wgpu 上下文（进程内单例）
#[derive(Debug)]
pub struct WgpuContext {
    instance: wgpu::Instance,
    adapter: wgpu::Adapter,
}

impl WgpuContext {
    /// 创建 wgpu 上下文，请求高性能 Adapter。
    pub async fn new() -> Result<Self> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                compatible_surface: None,
            })
            .await
            .context("无法找到合适的 wgpu Adapter")?;

        Ok(Self { instance, adapter })
    }

    pub fn instance(&self) -> &wgpu::Instance {
        &self.instance
    }

    pub fn adapter(&self) -> &wgpu::Adapter {
        &self.adapter
    }
}

/// 每窗口独立的 wgpu 设备上下文
///
/// 持有 `Arc<Window>` + `Device` + `Queue` + `Surface`。
/// `Surface` 持有 `Arc<Window>` 的引用，生命周期自洽。
/// 窗口关闭时随 `WgpuDevice` 一起 drop。
///
/// 借鉴 WezTerm `webgpu.rs`：用 `Arc<Window>` 让 surface 与窗口共享所有权。
#[derive(Debug)]
pub struct WgpuDevice {
    /// winit 窗口（Arc 共享，surface 持同一 Arc）
    window: Arc<Window>,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    /// surface 持 `Arc<Window>` 引用，生命周期与 `WgpuDevice` 相同
    surface: Surface<'static>,
    pub surface_config: wgpu::SurfaceConfiguration,
}

impl WgpuDevice {
    /// 为指定 winit 窗口创建 wgpu 设备上下文
    ///
    /// `window` 的所有权（通过 `Arc`）转移到 `WgpuDevice`。
    ///
    /// # 生命周期
    ///
    /// `Surface<'static>` 通过 `transmute` 放宽生命周期。
    /// 实际上 surface 借用 `Arc<Window>`，只要 `WgpuDevice` 存活，借用有效。
    /// 这是 wgpu + winit 集成的标准模式（WezTerm、wgpu examples 都这么做）。
    pub async fn new(
        ctx: &WgpuContext,
        window: Arc<Window>,
    ) -> Result<Self> {
        // surface 持有 Arc<Window> 的引用
        let surface = ctx
            .instance
            .create_surface(window.clone())
            .context("无法为窗口创建 wgpu Surface")?;

        let (device, queue) = ctx
            .adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("Wilson Term Device"),
                    required_features: wgpu::Features::empty(),
                    required_limits: wgpu::Limits::downlevel_defaults(),
                    memory_hints: wgpu::MemoryHints::Performance,
                },
                None,
            )
            .await
            .context("无法请求 wgpu Device")?;

        let surface_caps = surface.get_capabilities(&ctx.adapter);
        let surface_format = surface_caps
            .formats
            .iter()
            .copied()
            .find(|f| f.is_srgb())
            .unwrap_or(
                surface_caps
                    .formats
                    .first()
                    .copied()
                    .unwrap_or(wgpu::TextureFormat::Bgra8Unorm),
            );

        let window_size = window.inner_size();
        let surface_config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format: surface_format,
            width: window_size.width,
            height: window_size.height,
            desired_maximum_frame_latency: 2,
            present_mode: surface_caps
                .present_modes
                .iter()
                .copied()
                .find(|m| *m == wgpu::PresentMode::Mailbox)
                .unwrap_or(wgpu::PresentMode::Fifo),
            alpha_mode: surface_caps
                .alpha_modes
                .iter()
                .copied()
                .next()
                .unwrap_or(wgpu::CompositeAlphaMode::Auto),
            view_formats: vec![],
        };

        surface.configure(&device, &surface_config);

        // SAFETY: surface 持有 Arc<Window> 引用,Arc 与 WgpuDevice 同生命周期。
        // transmute 放宽 'window 到 'static,实际借用有效。
        let surface: Surface<'static> = unsafe { std::mem::transmute(surface) };

        Ok(Self {
            window,
            device,
            queue,
            surface,
            surface_config,
        })
    }

    /// 窗口尺寸变化时重新配置 Surface
    pub fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        self.surface_config.width = width;
        self.surface_config.height = height;
        self.surface.configure(&self.device, &self.surface_config);
    }

    /// 获取当前 Surface 纹理格式
    pub fn surface_format(&self) -> wgpu::TextureFormat {
        self.surface_config.format
    }

    /// 获取 winit 窗口引用
    pub fn window(&self) -> &Arc<Window> {
        &self.window
    }

    /// 获取 wgpu Surface 引用
    pub fn surface(&self) -> &Surface<'static> {
        &self.surface
    }
}
