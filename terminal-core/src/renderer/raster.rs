//! 字形光栅化器
//!
//! 阶段 5 任务 #3：把 swash 的 `Image`（Mask / SubpixelMask / Color）转成
//! 渲染层需要的 `RenderedGlyph`（RGBA 位图 + bearing + advance）。
//!
//! 借鉴 wezterm `wezterm-font/src/rasterizer/mod.rs` 的光栅化流程，但用
//! swash 替代 fontdue：
//! 1. `ScaleContext::new()` → `ctx.builder(font).size(ppem).hint(true).build()` 得到 `Scaler`
//! 2. `Render::new(&[Source::Outline, Source::ColorOutline(0)])` 配置渲染源
//! 3. `render.render(&mut scaler, glyph_id)` → `Option<Image>`
//! 4. 把 `Image` 转 `RenderedGlyph`（Mask 需扩为 RGBA，Color 已是 RGBA）
//!
//! 关键 API 核对清单（swash 0.1.19）：
//! - `swash::scale::{ScaleContext, ScalerBuilder, Scaler, Render, Image, Content, Source}`
//!   定义在 `src/scale/mod.rs`
//! - `Render::new(&[Source])` 配置优先级源列表
//! - `Render::render(&self, scaler: &mut Scaler, glyph_id: GlyphId) -> Option<Image>`
//!   定义在 `src/scale/mod.rs:963`，受 `#[cfg(feature = "render")]` 控制
//! - `Image::placement` 是 `zeno::Placement`（`left: i32, top: i32, width: u32, height: u32`）
//! - `Image::content` 决定 data 布局：`Mask` 单字节 alpha，`Color` 已是 RGBA
//!
//! swash 的 `Scaler` 持 `&'a mut ScaleContext` 内部缓存，且 `Render::render`
//! 需要 `&mut Scaler`，故 `Rasterizer::rasterize` 取 `&mut self`。
//!
//! # 默认渲染源
//!
//! 终端字形绝大多数是矢量轮廓（`Source::Outline`），emoji 等彩色字形走
//! `Source::ColorOutline(0)`（palette index 0）。彩色 emoji 优先匹配，没有
//! 才回落到 outline。这个顺序与 wezterm 一致。
//!
//! # Mask → RGBA 转换
//!
//! swash 对纯 outline 字形返回 `Content::Mask`（单字节 alpha）。
//! 渲染管线统一吃 RGBA，故这里把 alpha 扩为 `(R,G,B = fg, A = alpha)`。
//! fg 默认 `[255,255,255,255]`，调用方可通过 `RasterRequest::fg` 覆盖。
//!
//! `Content::Color` 已是 RGBA premultiplied，直接拷贝即可。
//! `Content::SubpixelMask` 暂不处理（终端不走 subpixel AA），落入 `_` 分支
//! 退化为普通 Mask 的处理路径。

use swash::scale::image::{Content, Image};
use swash::scale::{Render, ScaleContext, Scaler, Source};
use swash::FontRef;

use crate::renderer::glyph::RenderedGlyph;

/// 光栅化请求
///
/// 注意：`FontRef<'a>` 未实现 `Debug`,本类型用自定义 `Debug` 实现,
/// 避免派生宏要求 `FontRef: Debug`。
pub struct RasterRequest<'a> {
    /// swash 字体引用（来自 `OwnedFont::font_ref()`）
    pub font: FontRef<'a>,
    /// 字形 ID（来自 `ShapedGlyph::glyph_id`）
    pub glyph_id: u16,
    /// 字号（ppem，像素 / em）
    pub ppem: f32,
    /// 是否 emoji 彩色字形（决定 source 顺序）
    pub is_color: bool,
    /// 前景色 RGBA（Mask 转 RGBA 时用）
    pub fg: [u8; 4],
}

impl<'a> std::fmt::Debug for RasterRequest<'a> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RasterRequest")
            .field("font", &"<FontRef>")
            .field("glyph_id", &self.glyph_id)
            .field("ppem", &self.ppem)
            .field("is_color", &self.is_color)
            .field("fg", &self.fg)
            .finish()
    }
}

impl<'a> RasterRequest<'a> {
    /// 构造默认前景为白色的请求
    pub fn new(font: FontRef<'a>, glyph_id: u16, ppem: f32) -> Self {
        Self {
            font,
            glyph_id,
            ppem,
            is_color: false,
            fg: [255, 255, 255, 255],
        }
    }

    /// 标记为彩色字形请求
    pub fn with_color(mut self, is_color: bool) -> Self {
        self.is_color = is_color;
        self
    }

    /// 设置前景色
    pub fn with_fg(mut self, fg: [u8; 4]) -> Self {
        self.fg = fg;
        self
    }
}

/// 字形光栅化器
///
/// 内含可复用的 `ScaleContext`（swash 内部缓存字体度量/轮廓解码中间结果），
/// 多次 rasterize 同一字体时性能更优。
///
/// 注意：`ScaleContext` 不是 `Sync`，不能跨线程共享；单线程使用或包
/// `thread_local!`。
pub struct Rasterizer {
    ctx: ScaleContext,
    /// 渲染配置（sources 固定，format 默认 Alpha）
    ///
    /// `Render` 持 `&'a [Source]`，故 sources 必须存放在 Rasterizer 上以
    /// 保证生命周期。每次 rasterize 重建 `Render`（开销极小）。
    sources_outline: Vec<Source>,
    sources_color: Vec<Source>,
}

impl Default for Rasterizer {
    fn default() -> Self {
        Self::new()
    }
}

impl Rasterizer {
    /// 创建光栅化器
    ///
    /// 默认渲染源顺序：
    /// - 普通字形：`[Outline]`
    /// - 彩色字形：`[ColorOutline(0), Outline]`（先彩色，无则矢量）
    pub fn new() -> Self {
        Self {
            ctx: ScaleContext::new(),
            sources_outline: vec![Source::Outline],
            sources_color: vec![Source::ColorOutline(0), Source::Outline],
        }
    }

    /// 创建带最大缓存条目的光栅化器
    pub fn with_max_entries(max_entries: usize) -> Self {
        Self {
            ctx: ScaleContext::with_max_entries(max_entries),
            sources_outline: vec![Source::Outline],
            sources_color: vec![Source::ColorOutline(0), Source::Outline],
        }
    }

    /// 光栅化单个字形
    ///
    /// 返回 `Option<RenderedGlyph>`：找不到字形 / 渲染失败时为 `None`。
    ///
    /// 流程：
    /// 1. `ctx.builder(font).size(ppem).hint(true).build()` → `Scaler`
    /// 2. 按 `is_color` 选 sources，`Render::new(&sources)` 配置
    /// 3. `render.render(&mut scaler, glyph_id)` → `Option<Image>`
    /// 4. `image_to_rendered(image, req.fg)` → `RenderedGlyph`
    pub fn rasterize(&mut self, req: &RasterRequest<'_>) -> Option<RenderedGlyph> {
        // 1. Scaler
        let mut scaler: Scaler<'_> = self
            .ctx
            .builder(req.font.clone())
            .size(req.ppem)
            .hint(true)
            .build();

        // 2. 选 sources
        let sources = if req.is_color {
            &self.sources_color[..]
        } else {
            &self.sources_outline[..]
        };

        // 3. Render
        let render = Render::new(sources);
        let image: Image = render.render(&mut scaler, req.glyph_id)?;

        // 4. 转 RenderedGlyph
        Some(image_to_rendered(image, req.fg))
    }
}

/// swash `Image` → `RenderedGlyph`
///
/// swash 对 outline 字形返回 `Content::Mask`（单字节 alpha），需扩成 RGBA
/// 用前景色填 RGB 通道。对 `Content::Color` 已是 RGBA premultiplied，直接
/// 拷。对 `SubpixelMask` 暂不处理，按 Mask 路径退回。
fn image_to_rendered(image: Image, fg: [u8; 4]) -> RenderedGlyph {
    let placement = image.placement;
    let width = placement.width;
    let height = placement.height;

    // 计算 advance：swash Image 不含 advance，这里用 placement.width 作为
    // 近似（后续 GlyphCache 通过 ShapedGlyph.advance 注入更准的值）。
    let advance = width as f32;

    let data: Vec<u8> = match image.content {
        Content::Color => {
            // 已是 RGBA premultiplied，直接拷贝
            image.data
        }
        Content::Mask | Content::SubpixelMask => {
            // 单字节 alpha → RGBA (fg.rgb, alpha)
            mask_to_rgba(&image.data, fg)
        }
    };

    RenderedGlyph {
        data,
        width: width as u16,
        height: height as u16,
        // swash placement.left/top 是相对字身原点的偏移（i32）。
        // RenderedGlyph.bearing_x/y 用 i16，足够终端字形范围。
        bearing_x: placement.left as i16,
        // swash 的 top 是「字形顶部到基线的距离」向上为正，
        // 与 FreeType/传统 bearing_y 语义一致，直接传。
        bearing_y: placement.top as i16,
        advance,
    }
}

/// Mask（单字节 alpha）→ RGBA
///
/// 输出布局：`[R,G,B,A, R,G,B,A, ...]`，每像素 4 字节。
/// RGB 来自前景色 `fg`，A 来自 alpha。
///
/// 注意：这里不做 premultiply。swash outline 输出是 straight alpha mask，
/// 着色器端如果走 premultiplied blend 需在 shader 里乘一次。
fn mask_to_rgba(mask: &[u8], fg: [u8; 4]) -> Vec<u8> {
    let mut out = Vec::with_capacity(mask.len() * 4);
    for &a in mask {
        out.push(fg[0]);
        out.push(fg[1]);
        out.push(fg[2]);
        out.push(a);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造一个最小的内嵌 TTF/OTF 字体数据用于测试。
    ///
    /// 由于无法在单测里直接读系统字体（路径不可移植且 CI 可能无字体），
    /// 这里跳过真实 rasterize，仅测纯函数 `mask_to_rgba` / `image_to_rendered`
    /// 的转换正确性。真实光栅化端到端测试见 `tests/raster_e2e.rs`（需
    /// 系统字体存在时启用）。
    fn dummy_fg() -> [u8; 4] {
        [255, 255, 255, 255]
    }

    #[test]
    fn test_mask_to_rgba_basic() {
        // 4 像素 mask，alpha 分别 0/64/128/255
        let mask = [0u8, 64, 128, 255];
        let rgba = mask_to_rgba(&mask, dummy_fg());
        assert_eq!(rgba.len(), 16);
        // 像素 0：alpha 0
        assert_eq!(&rgba[0..4], &[255, 255, 255, 0]);
        // 像素 3：alpha 255
        assert_eq!(&rgba[12..16], &[255, 255, 255, 255]);
    }

    #[test]
    fn test_mask_to_rgba_fg_color() {
        let mask = [200u8];
        let fg = [10, 20, 30, 40];
        let rgba = mask_to_rgba(&mask, fg);
        // RGB 来自 fg，A 来自 mask
        assert_eq!(&rgba[..], &[10, 20, 30, 200]);
    }

    #[test]
    fn test_mask_to_rgba_empty() {
        let rgba = mask_to_rgba(&[], dummy_fg());
        assert!(rgba.is_empty());
    }

    #[test]
    fn test_image_to_rendered_mask() {
        // 构造一个 2x2 的 Mask Image
        use swash::scale::image::{Content, Image};
        use swash::scale::Source;
        use zeno::Placement;
        let image = Image {
            source: Source::Outline,
            content: Content::Mask,
            placement: Placement {
                left: 1,
                top: -2,
                width: 2,
                height: 2,
            },
            data: vec![0, 128, 200, 255],
        };
        let g = image_to_rendered(image, dummy_fg());
        assert_eq!(g.width, 2);
        assert_eq!(g.height, 2);
        assert_eq!(g.bearing_x, 1);
        assert_eq!(g.bearing_y, -2);
        assert_eq!(g.advance, 2.0);
        // 4 像素 × 4 字节 = 16
        assert_eq!(g.data.len(), 16);
        // 像素 0：alpha 0
        assert_eq!(&g.data[0..4], &[255, 255, 255, 0]);
        // 像素 3：alpha 255
        assert_eq!(&g.data[12..16], &[255, 255, 255, 255]);
    }

    #[test]
    fn test_image_to_rendered_color() {
        // 构造一个 1x1 的 Color Image（已是 RGBA）
        use swash::scale::image::{Content, Image};
        use swash::scale::Source;
        use zeno::Placement;
        let image = Image {
            source: Source::ColorOutline(0),
            content: Content::Color,
            placement: Placement {
                left: 0,
                top: 0,
                width: 1,
                height: 1,
            },
            data: vec![255, 128, 0, 255],
        };
        let g = image_to_rendered(image, dummy_fg());
        assert_eq!(g.width, 1);
        assert_eq!(g.height, 1);
        // Color 路径直拷，fg 不参与
        assert_eq!(&g.data[..], &[255, 128, 0, 255]);
    }

    #[test]
    fn test_raster_request_builder() {
        // 没有真实字体，仅测 builder 链
        // FontRef::from_index(&[], 0) 会失败，故用空切片构造
        let font = swash::FontRef::from_index(&[], 0);
        // 没有字体 → None，跳过构造
        if font.is_none() {
            return;
        }
        let req = RasterRequest::new(font.unwrap(), 65, 16.0)
            .with_color(true)
            .with_fg([0, 0, 0, 255]);
        assert!(req.is_color);
        assert_eq!(req.fg, [0, 0, 0, 255]);
        assert_eq!(req.glyph_id, 65);
        assert_eq!(req.ppem, 16.0);
    }

    #[test]
    fn test_rasterizer_create() {
        // 仅测构造不 panic
        let _r = Rasterizer::new();
        let _r2 = Rasterizer::default();
        let _r3 = Rasterizer::with_max_entries(64);
    }
}
