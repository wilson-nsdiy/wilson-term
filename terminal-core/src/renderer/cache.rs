//! 字形缓存集成层
//!
//! 把 [`glyph::GlyphCache`] + [`font::FontMatcher`] + [`raster::Rasterizer`]
//! 三者串成一个完整的「字形请求 → sprite」链路:
//!
//! 1. `GlyphCache::get_or_load(key, render_fn)` 查缓存
//! 2. 未命中时 `render_fn` 被调用,本模块实现的 `render_glyph` 负责:
//!    - 用 `FontMatcher` 按 `GlyphKey.font_family` 查 fontdb ID
//!    - 用 `OwnedFont` 缓存避免每次光栅化都重读字体文件
//!    - 用 `Rasterizer` 把 swash `FontRef` + glyph_id 光栅化成 `RenderedGlyph`
//! 3. `GlyphCache` 在 `AtlasList` 分配空间并写入缓存
//!
//! # 字体缓存策略
//!
//! `GlyphKey.font_family` 是字符串,每次 `FontMatcher::query` 都要走 fontdb
//! 查找流程。本模块额外维护一份 `family → ID` 缓存,命中即跳过 query。
//!
//! `OwnedFont`（持 `Vec<u8>` 字体字节）按 fontdb ID 缓存,避免重复读盘。
//! 生产可优化为 `Arc<dyn AsRef<[u8]>>` 共享,减少 clone 开销。

use std::collections::HashMap;

use fontdb::ID;

use crate::renderer::font::{FontMatcher, FontRequest, OwnedFont};
use crate::renderer::glyph::{GlyphCache, GlyphKey, RenderedGlyph};
use crate::renderer::raster::{RasterRequest, Rasterizer};

/// 字形缓存集成层
///
/// 持有:
/// - `GlyphCache`:缓存 + AtlasList 分配
/// - `FontMatcher`:fontdb 字体查找
/// - `Rasterizer`:swash 光栅化
/// - `OwnedFont` 缓存:避免重复读盘
/// - `family → ID` 缓存:避免重复 query
pub struct GlyphRenderer {
    cache: GlyphCache,
    matcher: FontMatcher,
    rasterizer: Rasterizer,
    /// fontdb ID → OwnedFont 缓存
    fonts: HashMap<ID, OwnedFont>,
    /// family 字符串 → fontdb ID 缓存
    family_ids: HashMap<(String, u16, bool), ID>,
}

impl GlyphRenderer {
    /// 创建字形渲染器
    ///
    /// `max_cache_entries`:`GlyphCache` 的 LRU 容量
    /// `load_system`:是否加载系统字体（测试可传 false）
    pub fn new(max_cache_entries: usize, load_system: bool) -> Self {
        let matcher = if load_system {
            FontMatcher::new()
        } else {
            FontMatcher::empty()
        };
        Self {
            cache: GlyphCache::new(max_cache_entries),
            matcher,
            rasterizer: Rasterizer::new(),
            fonts: HashMap::new(),
            family_ids: HashMap::new(),
        }
    }

    /// 获取或光栅化一个字形
    ///
    /// 返回 `(atlas_id, Sprite)`。未命中缓存时走完整光栅化流程。
    /// 光栅化失败（字体找不到 / 字形不存在）返回 `None`。
    pub fn get_or_render(&mut self, key: &GlyphKey) -> Option<(usize, crate::renderer::atlas::Sprite)> {
        // 借一份 cache + rasterizer + matcher + 缓存的引用给 render_fn
        let cache = &mut self.cache;
        let rasterizer = &mut self.rasterizer;
        let matcher = &self.matcher;
        let fonts = &mut self.fonts;
        let family_ids = &mut self.family_ids;

        cache.get_or_load(key, |k| {
            render_glyph(k, matcher, fonts, family_ids, rasterizer)
        })
    }

    /// 缓存命中率（透传 GlyphCache）
    pub fn hit_rate(&self) -> f32 {
        self.cache.hit_rate()
    }

    /// 缓存条目数
    pub fn len(&self) -> usize {
        self.cache.len()
    }

    /// 是否为空
    pub fn is_empty(&self) -> bool {
        self.cache.is_empty()
    }

    /// 清除缓存（透传 GlyphCache）
    pub fn clear(&mut self) {
        self.cache.clear();
        self.fonts.clear();
        self.family_ids.clear();
    }

    /// 加载额外字体文件
    pub fn load_font_file(&mut self, path: &str) -> Result<(), String> {
        self.matcher.load_font_file(path)
    }

    /// 加载系统字体
    pub fn load_system_fonts(&mut self) {
        self.matcher.load_system_fonts();
    }

    /// GlyphCache 引用（供阶段 6 上传 atlas 像素）
    pub fn cache(&self) -> &GlyphCache {
        &self.cache
    }

    /// GlyphCache 可变引用
    pub fn cache_mut(&mut self) -> &mut GlyphCache {
        &mut self.cache
    }
}

/// 光栅化单个字形
///
/// 流程:
/// 1. 按 `family + weight + italic` 查 fontdb ID（带缓存）
/// 2. 按 ID 查 `OwnedFont`（带缓存,避免重读盘）
/// 3. 用 `OwnedFont::font_ref()` 生成 swash `FontRef`
/// 4. 构造 `RasterRequest`,调用 `Rasterizer::rasterize`
///
/// 任何一步失败返回 `None`,由 `GlyphCache::get_or_load` 传播。
fn render_glyph(
    key: &GlyphKey,
    matcher: &FontMatcher,
    fonts: &mut HashMap<ID, OwnedFont>,
    family_ids: &mut HashMap<(String, u16, bool), ID>,
    rasterizer: &mut Rasterizer,
) -> Option<RenderedGlyph> {
    // 1. family → ID（带缓存）
    let cache_key = (key.font_family.clone(), key.weight, key.italic);
    let id = if let Some(id) = family_ids.get(&cache_key) {
        *id
    } else {
        let req = FontRequest::new(&key.font_family, key.font_size_100 as f32 / 100.0)
            .with_weight(key.weight)
            .with_italic(key.italic);
        let id = matcher.query(&req)?;
        family_ids.insert(cache_key, id);
        id
    };

    // 2. ID → OwnedFont（带缓存）
    let owned = if let Some(o) = fonts.get(&id) {
        o
    } else {
        let o = matcher.font_ref(id)?;
        fonts.insert(id, o);
        fonts.get(&id)?
    };

    // 3. OwnedFont → swash FontRef
    let font_ref = owned.font_ref()?;

    // 4. cmap 查找:codepoint → glyph_id
    //    swash Charmap::map 返回 GlyphId(= u16),值为 0 表示 .notdef
    //    (字体里不存在该码点的映射)。按字体惯例返回 None,
    //    让 GlyphCache 视为光栅化失败,上层走回退链或显示方框。
    let charmap = swash::Charmap::from_font(&font_ref);
    let glyph_id = charmap.map(key.codepoint);
    if glyph_id == 0 {
        return None;
    }

    let ppem = key.font_size_100 as f32 / 100.0;
    let req = RasterRequest::new(font_ref, glyph_id, ppem)
        .with_color(key.is_color);

    let rendered = rasterizer.rasterize(&req)?;
    Some(rendered)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_glyph_renderer_create_empty() {
        // 不加载系统字体,仅测构造不 panic
        let r = GlyphRenderer::new(64, false);
        assert!(r.is_empty());
        assert_eq!(r.len(), 0);
        assert!((r.hit_rate() - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn test_glyph_renderer_clear() {
        let mut r = GlyphRenderer::new(64, false);
        r.clear();
        assert!(r.is_empty());
    }

    #[test]
    fn test_glyph_renderer_get_or_render_missing_font() {
        // 无系统字体,查一个不存在的家族 → None
        let mut r = GlyphRenderer::new(64, false);
        let key = GlyphKey {
            font_family: "DefinitelyNotARealFont".to_string(),
            codepoint: 'A',
            weight: 400,
            italic: false,
            font_size_100: 1400,
            is_color: false,
        };
        let result = r.get_or_render(&key);
        assert!(result.is_none(), "should be None for missing font");
    }

    #[test]
    fn test_render_glyph_missing_family() {
        let matcher = FontMatcher::empty();
        let mut fonts = HashMap::new();
        let mut family_ids = HashMap::new();
        let mut rasterizer = Rasterizer::new();

        let key = GlyphKey {
            font_family: "Nope".to_string(),
            codepoint: 'A',
            weight: 400,
            italic: false,
            font_size_100: 1400,
            is_color: false,
        };

        let result = render_glyph(&key, &matcher, &mut fonts, &mut family_ids, &mut rasterizer);
        assert!(result.is_none());
        // family_ids 不应被填充（query 返回 None 时不缓存）
        assert!(family_ids.is_empty());
    }

    /// Smoke 测试:走完整 cmap 查找 + 光栅化链路
    ///
    /// 需要系统字体存在,标注 `#[ignore]` 避免在无字体环境(如 CI 容器)失败。
    /// 手动运行:`cargo test --lib -- --ignored test_render_glyph_cmap_lookup`
    ///
    /// 验证点:
    /// 1. `render_glyph` 用 swash `Charmap::map` 查找 glyph_id(非 Identity cmap 假设)
    /// 2. 找到字形后能走完 `Rasterizer::rasterize` 链路返回 `RenderedGlyph`
    /// 3. `family_ids` 缓存被正确填充
    #[test]
    #[ignore]
    fn test_render_glyph_cmap_lookup() {
        use std::collections::HashMap;

        let mut matcher = FontMatcher::empty();
        matcher.load_system_fonts();

        // 找一个系统里确实存在的字体家族
        let families = matcher.families();
        let family = families
            .iter()
            .find(|f| !f.is_empty())
            .cloned()
            .expect("系统应至少有一个字体家族");

        let mut fonts = HashMap::new();
        let mut family_ids = HashMap::new();
        let mut rasterizer = Rasterizer::new();

        let key = GlyphKey {
            font_family: family.clone(),
            codepoint: 'A',
            weight: 400,
            italic: false,
            font_size_100: 1400,
            is_color: false,
        };

        let result =
            render_glyph(&key, &matcher, &mut fonts, &mut family_ids, &mut rasterizer);

        // 系统字体存在,'A' 是基本 ASCII,几乎所有字体都包含
        assert!(result.is_some(), "系统字体 {family} 应能光栅化 'A'");
        let glyph = result.unwrap();
        assert!(glyph.width > 0 || glyph.height > 0, "光栅化位图不应为空");
        // family_ids 缓存应被填充
        assert_eq!(family_ids.len(), 1);
    }
}
