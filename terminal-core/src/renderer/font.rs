//! 字体层 — fontdb 查找 + swash shaping + cosmic-text 排版
//!
//! 借鉴 wezterm `wezterm-font/lib.rs` 的 `FontConfiguration` 设计:
//! - 主字体 + 回退字体链（emoji/CJK）
//! - 各样式（Regular/Bold/Italic）独立 cache
//!
//! 分层:
//! - [`FontRequest`]:字形请求（家族/粗细/斜体/字号/DPI）
//! - [`FontConfiguration`]:主字体 + 回退链配置
//! - [`FontMatcher`]:fontdb 查找封装
//! - [`ShapedGlyph`]:swash shaping 输出的字形（glyph_id + advance + cluster）
//! - [`TextShaper`]:swash ShapeContext 封装,文本 → ShapedGlyph 序列
//!
//! 阶段 5.1 实现:fontdb 查找 + swash shaping。
//! 阶段 6 渲染时光栅化由 [`raster`] 模块接入 GlyphCache。

use fontdb::{Database, Family, ID, Query, Style, Weight};
use swash::shape::ShapeContext;
use swash::text::cluster::{CharCluster, Status};
use swash::FontRef;

/// 字体请求
///
/// 借鉴 wezterm `wezterm-font/src/lib.rs` 的 `FontRequest`:
/// 一个完整的字体匹配请求,包含家族名、粗细、斜体、字号、DPI。
#[derive(Debug, Clone)]
pub struct FontRequest {
    /// 字体家族名（如 "Cascadia Code"、"Noto Sans CJK"）
    pub family: String,
    /// 字体粗细（100-900,400=normal,700=bold）
    pub weight: u16,
    /// 是否斜体
    pub italic: bool,
    /// 字号（像素,逻辑像素 * scale_factor 后的物理像素）
    pub size: f32,
    /// DPI X（物理像素 / 逻辑像素,通常 1.0 或 2.0）
    pub dpi: f32,
}

impl FontRequest {
    /// 创建常规字体请求
    pub fn new(family: &str, size: f32) -> Self {
        Self {
            family: family.to_string(),
            weight: 400,
            italic: false,
            size,
            dpi: 96.0,
        }
    }

    /// 设置粗细
    pub fn with_weight(mut self, weight: u16) -> Self {
        self.weight = weight;
        self
    }

    /// 设置斜体
    pub fn with_italic(mut self, italic: bool) -> Self {
        self.italic = italic;
        self
    }

    /// 设置 DPI
    pub fn with_dpi(mut self, dpi: f32) -> Self {
        self.dpi = dpi;
        self
    }

    /// ppem（每全角像素数）= 字号 * DPI / 72
    pub fn ppem(&self) -> f32 {
        self.size * self.dpi / 72.0
    }
}

/// 字体配置（主字体 + 回退链）
///
/// 借鉴 wezterm 的「主字体 + emoji 字体 + CJK 字体」回退链设计。
/// 当主字体不含某字符时,按回退链顺序查找。
#[derive(Debug, Clone)]
pub struct FontConfiguration {
    /// 主字体家族
    pub primary: String,
    /// 回退字体链（emoji/CJK/通用 sans）
    pub fallback: Vec<String>,
    /// 默认字号
    pub default_size: f32,
    /// 默认 DPI
    pub default_dpi: f32,
}

impl Default for FontConfiguration {
    fn default() -> Self {
        Self {
            // 借鉴 wezterm 默认:Cascadia Code（含编程连字）
            primary: "Cascadia Code".to_string(),
            fallback: vec![
                "Noto Sans CJK".to_string(),     // CJK 回退
                "Noto Color Emoji".to_string(),  // emoji 回退
                "DejaVu Sans".to_string(),       // 通用 sans 回退
            ],
            default_size: 14.0,
            default_dpi: 96.0,
        }
    }
}

impl FontConfiguration {
    /// 创建字体配置
    pub fn new(primary: &str, size: f32) -> Self {
        Self {
            primary: primary.to_string(),
            ..Default::default()
        }
    }

    /// 添加回退字体
    pub fn add_fallback(mut self, family: &str) -> Self {
        self.fallback.push(family.to_string());
        self
    }

    /// 获取家族查找链（主 + 回退）
    pub fn family_chain(&self) -> Vec<&str> {
        let mut chain = vec![self.primary.as_str()];
        chain.extend(self.fallback.iter().map(|s| s.as_str()));
        chain
    }
}

/// 字体匹配器（fontdb 封装）
///
/// 借鉴 wezterm `wezterm-font/lib.rs` 的 `FontConfiguration::load_font`:
/// - 加载系统字体到 fontdb Database
/// - 按 FontRequest 查找最佳匹配
/// - 返回 fontdb ID,后续用 ID 获取字体数据
pub struct FontMatcher {
    /// fontdb 数据库
    db: Database,
}

impl Default for FontMatcher {
    fn default() -> Self {
        let mut db = Database::new();
        db.load_system_fonts();
        Self { db }
    }
}

impl FontMatcher {
    /// 创建字体匹配器,加载系统字体
    pub fn new() -> Self {
        Self::default()
    }

    /// 创建空字体匹配器（不加载系统字体,用于测试）
    pub fn empty() -> Self {
        Self {
            db: Database::new(),
        }
    }

    /// 加载系统字体
    pub fn load_system_fonts(&mut self) {
        self.db.load_system_fonts();
    }

    /// 加载指定路径的字体文件
    pub fn load_font_file(&mut self, path: &str) -> Result<(), String> {
        self.db
            .load_font_file(path)
            .map_err(|e| format!("load font file failed: {e}"))
    }

    /// 按 FontRequest 查找字体
    ///
    /// 返回 fontdb ID,后续用 `face_data` 获取字体数据。
    /// 借鉴 wezterm `FontConfiguration::load_font`:
    /// - 优先按家族名查找
    /// - 按粗细/斜体过滤
    pub fn query(&self, request: &FontRequest) -> Option<ID> {
        let style = if request.italic {
            Style::Italic
        } else {
            Style::Normal
        };
        let weight = Weight(request.weight);
        let query = Query {
            families: &[Family::Name(&request.family)],
            weight,
            stretch: fontdb::Stretch::Normal,
            style,
        };
        self.db.query(&query)
    }

    /// 按家族链查找字体（主 + 回退）
    ///
    /// 遍历家族链,返回第一个找到的 fontdb ID。
    /// 用于 Unicode 字符不在主字体中时的回退。
    pub fn query_chain(&self, families: &[&str], weight: u16, italic: bool) -> Option<ID> {
        let style = if italic { Style::Italic } else { Style::Normal };
        let weight = Weight(weight);
        for family in families {
            let query = Query {
                families: &[Family::Name(family)],
                weight,
                stretch: fontdb::Stretch::Normal,
                style,
            };
            if let Some(id) = self.db.query(&query) {
                return Some(id);
            }
        }
        None
    }

    /// 获取字体数据（字节切片）
    ///
    /// 借鉴 wezterm `Database::with_face_data`:
    /// 由于 fontdb 不直接暴露数据引用,用闭包处理。
    /// 本方法返回数据的 Vec clone（简化测试,生产可改用闭包）。
    pub fn face_data(&self, id: ID) -> Option<Vec<u8>> {
        let face = self.db.face(id)?;
        match &face.source {
            fontdb::Source::Binary(data) => {
                let data = data.as_ref();
                Some(data.as_ref().to_vec())
            }
            #[cfg(feature = "fs")]
            fontdb::Source::File(path) => {
                std::fs::read(path).ok()
            }
            #[cfg(all(feature = "fs", feature = "memmap"))]
            fontdb::Source::SharedFile(_, data) => {
                let data = data.as_ref();
                Some(data.as_ref().to_vec())
            }
            _ => None,
        }
    }

    /// 获取字体数据并创建 swash FontRef
    ///
    /// 借鉴 wezterm `FontRef::from_index`:
    /// fontdb 的 Source::Binary 是 Arc<dyn AsRef<[u8]>>,
    /// 需 clone 出 Vec<u8> 以获得 'static 生命周期（简化,生产可优化为 Arc 共享）。
    pub fn font_ref(&self, id: ID) -> Option<OwnedFont> {
        let face = self.db.face(id)?;
        let data: Vec<u8> = match &face.source {
            fontdb::Source::Binary(data) => data.as_ref().as_ref().to_vec(),
            #[cfg(feature = "fs")]
            fontdb::Source::File(path) => std::fs::read(path).ok()?,
            #[cfg(all(feature = "fs", feature = "memmap"))]
            fontdb::Source::SharedFile(_, data) => data.as_ref().as_ref().to_vec(),
            _ => return None,
        };
        let font = FontRef::from_index(&data, face.index as usize)?;
        Some(OwnedFont { data, font_offset: face.index })
    }

    /// 列出所有字体家族（去重）
    pub fn families(&self) -> Vec<String> {
        let mut families: Vec<String> = self
            .db
            .faces()
            .flat_map(|face| {
                face.families
                    .iter()
                    .map(|(name, _)| name.clone())
                    .collect::<Vec<_>>()
            })
            .collect();
        families.sort();
        families.dedup();
        families
    }

    /// 数据库引用（用于高级查询）
    pub fn database(&self) -> &Database {
        &self.db
    }
}

/// 拥有所有权的字体（Vec<u8> + offset,可生成 FontRef）
///
/// 借鉴 wezterm 的「owned font」模式:
/// fontdb 的数据是 Arc 共享的,但 swash FontRef 需 &'a [u8]。
/// 本结构持 Vec<u8> 副本,提供生命周期安全的 FontRef。
pub struct OwnedFont {
    /// 字体文件数据
    pub data: Vec<u8>,
    /// 字体在文件中的索引（TTC 集合可能含多个）
    pub font_offset: u32,
}

impl OwnedFont {
    /// 生成 swash FontRef（借用 self.data）
    pub fn font_ref(&self) -> Option<FontRef<'_>> {
        FontRef::from_index(&self.data, self.font_offset as usize)
    }
}

/// Shaping 输出的单个字形
#[derive(Debug, Clone, Copy)]
pub struct ShapedGlyph {
    /// 字形 ID（字体内部编号）
    pub glyph_id: u16,
    /// 前进宽度（像素,已按字号缩放）
    pub advance: f32,
    /// 字符簇偏移（用于 caret 移动 / 选区）
    pub cluster: u32,
    /// 字符的 Unicode 码点（用于回退链查找）
    pub source_char: char,
}

/// 文本 Shaper（swash ShapeContext 封装）
///
/// 借鉴 wezterm `wezterm-font/src/lib.rs` 的 shaping 流程:
/// - ShapeContext 是可复用的 shaping 上下文（含缓存）
/// - ShaperBuilder 配置字体/字号/方向
/// - CharCluster 分组 → shape_with 回调收集结果
pub struct TextShaper {
    /// swash shaping 上下文（含缓存,可复用）
    ctx: ShapeContext,
}

impl Default for TextShaper {
    fn default() -> Self {
        Self {
            ctx: ShapeContext::new(),
        }
    }
}

impl TextShaper {
    /// 创建文本 shaper
    pub fn new() -> Self {
        Self::default()
    }

    /// 对文本进行 shaping,返回 ShapedGlyph 序列
    ///
    /// 借鉴 wezterm 的 `shape_text`:
    /// - 把文本按 CharCluster 分组
    /// - 每个 cluster 用 swash Shaper 处理
    /// - 收集 glyph_id + advance + cluster
    ///
    /// `font`:swash FontRef（来自 FontMatcher::font_ref）
    /// `size`:字号（ppem,像素）
    pub fn shape(&mut self, font: &FontRef<'_>, text: &str, size: f32) -> Vec<ShapedGlyph> {
        let mut shaper = self
            .ctx
            .builder(font)
            .size(size)
            .build();

        let mut result: Vec<ShapedGlyph> = Vec::new();
        let chars: Vec<char> = text.chars().collect();
        let mut cluster = CharCluster::default();

        let mut char_iter = chars.iter().enumerate();
        while let Some((idx, &c)) = char_iter.next() {
            let status = cluster.push(idx, c as u32);
            // 当 cluster 完成或无法继续接收字符时,shape 它
            if matches!(status, Status::Complete) || matches!(status, Status::Full) {
                shape_cluster(&mut shaper, &cluster, &mut result, c);
                cluster.reset();
            }
        }
        // 处理剩余未完成的 cluster
        if !cluster.is_empty() {
            if let Some((_, &last_char)) = char_iter.last().or(Some((chars.len() - 1, &'\0'))) {
                shape_cluster(&mut shaper, &cluster, &mut result, last_char);
            }
        }

        result
    }
}

/// 对单个 CharCluster 执行 shaping 并收集结果
fn shape_cluster(
    shaper: &mut swash::shape::Shaper<'_>,
    cluster: &CharCluster,
    result: &mut Vec<ShapedGlyph>,
    source_char: char,
) {
    shaper.add_cluster(cluster);
    shaper.shape_with(|gc| {
        for glyph in gc.glyphs.iter() {
            result.push(ShapedGlyph {
                glyph_id: glyph.id,
                advance: glyph.advance,
                cluster: glyph.cluster,
                source_char,
            });
        }
    });
}

/// 字号 → 像素换算（DPI 感知）
///
/// 借鉴 wezterm `wezterm-font/src/units.rs`:
/// - 输入:字号（pt）+ DPI
/// - 输出:物理像素
/// - 公式:像素 = pt * DPI / 72
pub fn font_size_to_pixels(pt: f32, dpi: f32) -> f32 {
    pt * dpi / 72.0
}

/// 像素 → 字号换算
pub fn pixels_to_font_size(px: f32, dpi: f32) -> f32 {
    px * 72.0 / dpi
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_font_request_default() {
        let req = FontRequest::new("Cascadia Code", 14.0);
        assert_eq!(req.family, "Cascadia Code");
        assert_eq!(req.weight, 400);
        assert!(!req.italic);
        assert_eq!(req.size, 14.0);
    }

    #[test]
    fn test_font_request_builder() {
        let req = FontRequest::new("Cascadia Code", 14.0)
            .with_weight(700)
            .with_italic(true)
            .with_dpi(192.0);
        assert_eq!(req.weight, 700);
        assert!(req.italic);
        assert_eq!(req.dpi, 192.0);
    }

    #[test]
    fn test_font_request_ppem() {
        let req = FontRequest::new("Cascadia Code", 14.0).with_dpi(96.0);
        // ppem = 14 * 96 / 72 = 18.666...
        let ppem = req.ppem();
        assert!((ppem - 18.666).abs() < 0.1);
    }

    #[test]
    fn test_font_configuration_default() {
        let config = FontConfiguration::default();
        assert_eq!(config.primary, "Cascadia Code");
        assert!(!config.fallback.is_empty());
        assert!(config.fallback.contains(&"Noto Color Emoji".to_string()));
    }

    #[test]
    fn test_font_configuration_chain() {
        let config = FontConfiguration::default();
        let chain = config.family_chain();
        assert_eq!(chain[0], "Cascadia Code");
        assert!(chain.len() > 1);
    }

    #[test]
    fn test_font_configuration_builder() {
        let config = FontConfiguration::new("JetBrains Mono", 16.0)
            .add_fallback("Noto Sans CJK");
        assert_eq!(config.primary, "JetBrains Mono");
        assert_eq!(config.default_size, 14.0); // 默认未改
        assert!(config.fallback.contains(&"Noto Sans CJK".to_string()));
    }

    #[test]
    fn test_font_matcher_empty() {
        let matcher = FontMatcher::empty();
        // 空数据库,查找应返回 None
        let req = FontRequest::new("Nonexistent", 14.0);
        assert!(matcher.query(&req).is_none());
    }

    #[test]
    fn test_font_matcher_families_empty() {
        let matcher = FontMatcher::empty();
        // 空数据库,家族列表应为空
        let families = matcher.families();
        assert!(families.is_empty());
    }

    #[test]
    fn test_font_matcher_query_chain_empty_db() {
        let matcher = FontMatcher::empty();
        let chain = vec!["Nonexistent1", "Nonexistent2"];
        assert!(matcher.query_chain(&chain, 400, false).is_none());
    }

    #[test]
    fn test_font_size_to_pixels() {
        // 14pt @ 96dpi → 14 * 96 / 72 = 18.666...
        let px = font_size_to_pixels(14.0, 96.0);
        assert!((px - 18.666).abs() < 0.1);
    }

    #[test]
    fn test_pixels_to_font_size() {
        // 18.666px @ 96dpi → 14pt
        let pt = pixels_to_font_size(18.666, 96.0);
        assert!((pt - 14.0).abs() < 0.1);
    }

    #[test]
    fn test_font_size_roundtrip() {
        let original_pt = 16.0;
        let dpi = 144.0;
        let px = font_size_to_pixels(original_pt, dpi);
        let back_pt = pixels_to_font_size(px, dpi);
        assert!((back_pt - original_pt).abs() < 0.01);
    }

    #[test]
    fn test_text_shaper_create() {
        let shaper = TextShaper::new();
        // 仅验证创建成功
        let _ = shaper;
    }
}