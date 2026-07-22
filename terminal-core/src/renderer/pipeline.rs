//! 渲染管线抽象
//!
//! 借鉴 wezterm `renderstate.rs:22-26` 的 `RenderContext` 枚举模式:
//! - 主路径:wgpu 渲染
//! - 未来可选 fallback（如软件渲染）
//!
//! 本阶段只定义类型骨架 + 顶点/索引缓冲区管理数据结构。
//! 实际的 wgpu 设备/队列/表面创建在阶段 6 集成 Tauri 时实现。

/// 渲染上下文枚举
///
/// 借鉴 wezterm `renderstate.rs:22-26` 的 `RenderContext`:
/// 当前只有 wgpu 路径,未来可加其他后端。
#[derive(Debug)]
pub enum RenderContext {
    /// wgpu 渲染
    Wgpu(WgpuState),
}

/// wgpu 渲染状态（占位）
///
/// 阶段 6 集成 Tauri 时,由 `src-tauri/` 负责创建实际的 `wgpu::Device`/`Queue`/`Surface`。
/// 本阶段只定义类型骨架,所有字段为 `Option` 占位。
#[derive(Debug)]
pub struct WgpuState {
    /// wgpu 实例
    pub instance: Option<()>,
    /// wgpu 适配器
    pub adapter: Option<()>,
    /// wgpu 设备
    pub device: Option<()>,
    /// wgpu 命令队列
    pub queue: Option<()>,
    /// 表面配置
    pub surface_config: Option<()>,
}

impl Default for WgpuState {
    fn default() -> Self {
        Self {
            instance: None,
            adapter: None,
            device: None,
            queue: None,
            surface_config: None,
        }
    }
}

/// 顶点属性（2D 位置 + UV 坐标）
///
/// 每个终端单元格由 2 个三角形（6 个顶点）构成。
/// 借鉴 wezterm vertex buffer 的布局:
/// - 位置:2 个 f32（x, y）
/// - UV 坐标:2 个 f32（u, v）
/// - 颜色:4 个 u8（R, G, B, A）
#[derive(Debug, Clone, Copy, PartialEq)]
#[repr(C)]
pub struct GlyphVertex {
    /// 屏幕位置 X
    pub x: f32,
    /// 屏幕位置 Y
    pub y: f32,
    /// UV 坐标 U
    pub u: f32,
    /// 纹理坐标 V
    pub v: f32,
    /// 前景色 R
    pub r: u8,
    /// 前景色 G
    pub g: u8,
    /// 前景色 B
    pub b: u8,
    /// 前景色 A
    pub a: u8,
}

/// 顶点缓冲区管理器
///
/// 管理每帧动态分配的顶点数据,复用缓冲区。
/// 借鉴 wezterm `renderstate.rs` 的 `allocate_vertex_buffer`。
#[derive(Debug)]
pub struct VertexBuffer {
    /// 最大顶点数
    max_vertices: usize,
    /// 当前已用顶点数
    used: usize,
    /// 顶点数据
    pub vertices: Vec<GlyphVertex>,
    /// 顶点索引（每个单元格 6 个索引,2 个三角形）
    pub indices: Vec<u16>,
}

impl VertexBuffer {
    /// 创建顶点缓冲区,指定最大顶点数
    pub fn new(max_vertices: usize) -> Self {
        Self {
            max_vertices,
            used: 0,
            vertices: Vec::with_capacity(max_vertices),
            indices: Vec::new(),
        }
    }

    /// 添加一个四边形（6 个顶点,2 个三角形）
    ///
    /// 返回 `Ok(())` 或 `Err("buffer full")`。
    pub fn add_quad(
        &mut self,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        u_min: f32,
        v_min: f32,
        u_max: f32,
        v_max: f32,
        r: u8,
        g: u8,
        b: u8,
        a: u8,
    ) -> Result<(), &'static str> {
        if self.used + 6 > self.max_vertices {
            return Err("vertex buffer full");
        }

        let base = self.used as u16;

        // 三角形 1:左上,右上,左下
        // 三角形 2:右上,右下,左下
        // 顶点顺序:左上,右上,左下,右上,右下,左下
        let verts = [
            GlyphVertex { x, y, u: u_min, v: v_min, r, g, b, a },           // 左上
            GlyphVertex { x: x + w, y, u: u_max, v: v_min, r, g, b, a },   // 右上
            GlyphVertex { x, y: y + h, u: u_min, v: v_max, r, g, b, a },   // 左下
            GlyphVertex { x: x + w, y, u: u_max, v: v_min, r, g, b, a },   // 右上（重复）
            GlyphVertex { x: x + w, y: y + h, u: u_max, v: v_max, r, g, b, a }, // 右下
            GlyphVertex { x, y: y + h, u: u_min, v: v_max, r, g, b, a },   // 左下（重复）
        ];

        self.vertices.extend_from_slice(&verts);
        self.indices.extend_from_slice(&[base, base + 1, base + 2, base + 3, base + 4, base + 5]);
        self.used += 6;

        Ok(())
    }

    /// 清空缓冲区
    pub fn clear(&mut self) {
        self.vertices.clear();
        self.indices.clear();
        self.used = 0;
    }

    /// 当前顶点数
    pub fn len(&self) -> usize {
        self.used
    }

    /// 是否为空
    pub fn is_empty(&self) -> bool {
        self.used == 0
    }

    /// 最大容量
    pub fn capacity(&self) -> usize {
        self.max_vertices
    }
}

/// 渲染管线控制器
///
/// 管理一帧渲染的完整流程:
/// 1. 收集脏区域 → 生成顶点
/// 2. 提交 wgpu render pass
/// 3. 处理 BSU/ESU 同步
///
/// 本阶段只定义骨架,具体 wgpu 操作在阶段 6 实现。
#[derive(Debug)]
pub struct Pipeline {
    /// 顶点缓冲区
    pub vertex_buffer: VertexBuffer,
    /// 是否正在渲染
    rendering: bool,
}

impl Pipeline {
    /// 创建渲染管线
    pub fn new(max_vertices: usize) -> Self {
        Self {
            vertex_buffer: VertexBuffer::new(max_vertices),
            rendering: false,
        }
    }

    /// 开始一帧渲染（收集顶点数据）
    pub fn begin_frame(&mut self) {
        self.vertex_buffer.clear();
        self.rendering = true;
    }

    /// 结束一帧渲染（提交 draw call）
    ///
    /// 返回顶点数,供渲染层提交 wgpu draw call。
    pub fn end_frame(&mut self) -> usize {
        self.rendering = false;
        self.vertex_buffer.len()
    }

    /// 是否正在渲染一帧
    pub fn is_rendering(&self) -> bool {
        self.rendering
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vertex_buffer_create() {
        let vb = VertexBuffer::new(600);
        assert_eq!(vb.capacity(), 600);
        assert!(vb.is_empty());
    }

    #[test]
    fn test_vertex_buffer_add_quad() {
        let mut vb = VertexBuffer::new(600);
        vb.add_quad(0.0, 0.0, 10.0, 20.0, 0.0, 0.0, 0.5, 0.5, 255, 0, 0, 255)
            .expect("should add quad");
        assert_eq!(vb.len(), 6); // 6 vertices per quad
        assert_eq!(vb.vertices.len(), 6);
        assert_eq!(vb.indices.len(), 6);
    }

    #[test]
    fn test_vertex_buffer_clear() {
        let mut vb = VertexBuffer::new(600);
        vb.add_quad(0.0, 0.0, 10.0, 20.0, 0.0, 0.0, 1.0, 1.0, 255, 255, 255, 255)
            .expect("should add quad");
        assert!(!vb.is_empty());
        vb.clear();
        assert!(vb.is_empty());
        assert_eq!(vb.len(), 0);
    }

    #[test]
    fn test_vertex_buffer_full() {
        let mut vb = VertexBuffer::new(6); // 仅够 1 个 quad
        vb.add_quad(0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 255, 255, 255, 255)
            .expect("first quad");
        let result = vb.add_quad(0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 255, 255, 255, 255);
        assert!(result.is_err());
    }

    #[test]
    fn test_vertex_position() {
        let mut vb = VertexBuffer::new(600);
        vb.add_quad(10.0, 20.0, 100.0, 50.0, 0.0, 0.0, 1.0, 1.0, 255, 255, 255, 255)
            .expect("should add quad");
        // 左上顶点
        assert_eq!(vb.vertices[0].x, 10.0);
        assert_eq!(vb.vertices[0].y, 20.0);
        // 右上顶点
        assert_eq!(vb.vertices[1].x, 110.0);
        assert_eq!(vb.vertices[1].y, 20.0);
        // 右下顶点（第 5 个 = index 4）
        assert_eq!(vb.vertices[4].x, 110.0);
        assert_eq!(vb.vertices[4].y, 70.0);
    }

    #[test]
    fn test_pipeline_frame() {
        let mut pipeline = Pipeline::new(600);
        assert!(!pipeline.is_rendering());
        pipeline.begin_frame();
        assert!(pipeline.is_rendering());
        pipeline.vertex_buffer.add_quad(0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0, 0, 0, 255)
            .expect("should add quad");
        let count = pipeline.end_frame();
        assert_eq!(count, 6);
        assert!(!pipeline.is_rendering());
    }

    #[test]
    fn test_render_context_creation() {
        let ctx = RenderContext::Wgpu(WgpuState::default());
        match ctx {
            RenderContext::Wgpu(_) => {} // 预期
        }
    }

    #[test]
    fn test_vertex_color() {
        let mut vb = VertexBuffer::new(600);
        vb.add_quad(0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 128, 64, 32, 255)
            .expect("should add quad");
        assert_eq!(vb.vertices[0].r, 128);
        assert_eq!(vb.vertices[0].g, 64);
        assert_eq!(vb.vertices[0].b, 32);
        assert_eq!(vb.vertices[0].a, 255);
    }
}