//! 渲染层
//!
//! Wilson Term 的纯 Rust + wgpu 原生终端渲染器。
//!
//! 分层（借鉴 wezterm）:
//! - [`atlas`]:单纹理 + guillotiere 分配器
//! - [`atlas_list`]:多纹理管理,allocate() 失败时动态扩容
//! - [`glyph`]:字形 → sprite 缓存层（GlyphCache）
//! - [`sync`]:BSU/ESU 同步更新状态机
//! - [`pipeline`]:渲染管线抽象 + 顶点缓冲区管理
//! - [`shader`]:WGSL 着色器源代码（内联常量）
//!
//! 阶段 2 实现 Atlas 数据结构 + GlyphCache + 渲染管线骨架 + 着色器源代码,
//! 不依赖实际 GPU 设备。
//! 阶段 6 集成到 Tauri 时,由 `src-tauri/` 负责创建 wgpu Device/Queue/Surface
//! 并加载着色器到 GPU。

pub mod atlas;
pub mod atlas_list;
pub mod cache;
pub mod font;
pub mod glyph;
pub mod pipeline;
pub mod raster;
pub mod shader;
pub mod sync;