//! Wilson Term 顶层应用
//!
//! 组装 [`wilson_window`]（窗口管理）+ [`wilson_renderer`]（渲染管线）
//! + [`terminal_core`]（终端核心）。
//!
//! # 架构
//!
//! 借鉴 WezTerm `wezterm-gui/src/main.rs`:
//!
//! ```text
//! main()
//!   ├── 创建 winit EventLoop
//!   ├── 创建 WgpuContext（全局共享 Instance + Adapter）
//!   ├── 创建主窗口 + WgpuDevice
//!   ├── 创建 Renderer
//!   └── run() 进入事件循环
//! ```
//!
//! # 生命周期
//!
//! `WgpuDevice` 持 `Arc<Window>`，`Surface<'static>` 通过 transmute 放宽。
//! 这是 wgpu + winit 集成的标准模式（WezTerm、wgpu examples 都这么做）。

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{Context, Result};
use log::info;
use winit::application::ApplicationHandler;
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::window::WindowId;

use wilson_renderer::Renderer;
use wilson_window::{WgpuContext, WgpuDevice, default_window_attributes};

/// 顶层应用状态
///
/// 持有 wgpu 上下文、所有窗口的运行时状态、渲染器。
struct App {
    /// wgpu 上下文（事件循环启动后异步初始化）
    wgpu_ctx: Option<WgpuContext>,
    /// 所有窗口的运行时状态
    windows: HashMap<WindowId, WgpuDevice>,
    /// 渲染器（按窗口 ID 索引）
    renderers: HashMap<WindowId, Renderer>,
    /// 是否已请求退出
    exiting: bool,
}

impl App {
    fn new() -> Self {
        Self {
            wgpu_ctx: None,
            windows: HashMap::new(),
            renderers: HashMap::new(),
            exiting: false,
        }
    }

    /// 创建主窗口
    fn create_main_window(&mut self, event_loop: &ActiveEventLoop) -> Result<()> {
        let window = Arc::new(
            event_loop
                .create_window(default_window_attributes())
                .context("无法创建主窗口")?,
        );

        let wgpu_ctx = self
            .wgpu_ctx
            .as_ref()
            .context("wgpu 上下文未初始化")?;

        // 为窗口创建 wgpu 设备上下文（WgpuDevice 持 Arc<Window>）
        let wgpu_dev = futures::executor::block_on(WgpuDevice::new(wgpu_ctx, window.clone()))
            .context("无法创建 wgpu 设备上下文")?;

        let surface_format = wgpu_dev.surface_format();
        let window_id = wgpu_dev.window().id();

        // 为窗口创建渲染器
        let renderer = Renderer::new(&wgpu_dev.device, surface_format)
            .context("无法创建渲染器")?;

        self.renderers.insert(window_id, renderer);
        self.windows.insert(window_id, wgpu_dev);

        Ok(())
    }

    /// 请求退出事件循环
    fn request_exit(&mut self, event_loop: &ActiveEventLoop) {
        self.exiting = true;
        event_loop.exit();
    }

    /// 渲染所有窗口
    fn render_all(&mut self) {
        for (id, wgpu_dev) in self.windows.iter_mut() {
            let Some(renderer) = self.renderers.get(id) else {
                continue;
            };
            let _ = renderer; // TODO: 完整渲染管线

            // 获取当前帧的 Surface 纹理
            let surface_texture = match wgpu_dev.surface().get_current_texture() {
                Ok(texture) => texture,
                Err(e) => {
                    log::warn!("获取 Surface 纹理失败: {e}");
                    continue;
                }
            };

            let view = surface_texture
                .texture
                .create_view(&wgpu::TextureViewDescriptor::default());

            // 清屏为深灰色（Catppuccin Mocha base #1e1e2e）
            let mut encoder = wgpu_dev
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("Clear Encoder"),
                });

            {
                let _render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("Clear Pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color {
                                r: 0.117, // #1e1e2e
                                g: 0.117,
                                b: 0.180,
                                a: 1.0,
                            }),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });
            }

            wgpu_dev.queue.submit(std::iter::once(encoder.finish()));
            surface_texture.present();
        }
    }
}

impl ApplicationHandler for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        // 首次 resumed:初始化 wgpu 上下文 + 创建主窗口
        if self.wgpu_ctx.is_none() {
            let wgpu_ctx = futures::executor::block_on(WgpuContext::new())
                .context("无法初始化 wgpu 上下文");
            match wgpu_ctx {
                Ok(ctx) => self.wgpu_ctx = Some(ctx),
                Err(e) => {
                    log::error!("wgpu 初始化失败: {e}");
                    self.request_exit(event_loop);
                    return;
                }
            }
        }

        if self.windows.is_empty() {
            if let Err(e) = self.create_main_window(event_loop) {
                log::error!("创建主窗口失败: {e}");
                self.request_exit(event_loop);
            }
        }
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        window_id: WindowId,
        event: WindowEvent,
    ) {
        match event {
            WindowEvent::Resized(physical_size) => {
                if let Some(wgpu_dev) = self.windows.get_mut(&window_id) {
                    wgpu_dev.resize(
                        physical_size.width,
                        physical_size.height,
                    );
                }
            }
            WindowEvent::RedrawRequested => {
                self.render_all();
            }
            WindowEvent::CloseRequested => {
                self.windows.remove(&window_id);
                self.renderers.remove(&window_id);
                if self.windows.is_empty() {
                    self.request_exit(event_loop);
                }
            }
            _ => {}
        }
    }
}

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();

    info!("Wilson Term 启动");

    let event_loop = EventLoop::new().context("无法创建 EventLoop")?;
    event_loop.set_control_flow(ControlFlow::Wait);

    let mut app = App::new();
    event_loop.run_app(&mut app).context("事件循环异常")?;

    Ok(())
}
