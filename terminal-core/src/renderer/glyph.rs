//! GlyphCache 字形 → sprite 缓存层
//!
//! 借鉴 wezterm `wezterm-gui/src/glyphcache.rs`（1376 行）的设计:
//! - 输入:`GlyphRequest { font, codepoint, style, size }`
//! - 输出:`(atlas_id, Sprite)`
//! - 缓存:LRU 缓存最近使用的字形,避免重复光栅化
//!
//! 本阶段实现缓存数据结构 + LRU 策略,不实际调用 swash 光栅化。
//! 阶段 5（字体处理）接入 swash 后,由 `font/swash.rs` 提供实际光栅化能力。

use std::collections::HashMap;
use std::hash::{Hash, Hasher};

use crate::renderer::atlas::Sprite;
use crate::renderer::atlas_list::AtlasList;

/// 字形请求键（font + codepoint + style + size）
///
/// 借鉴 wezterm `GlyphRequest`（`glyphcache.rs` 中的 `GlyphInfo`）:
/// 唯一标识一个字形,用于缓存查找。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct GlyphKey {
    /// 字体家族（如 "Cascadia Code"）
    pub font_family: String,
    /// Unicode 码点
    pub codepoint: char,
    /// 字体粗细（100-900,400=normal,700=bold）
    pub weight: u16,
    /// 是否斜体
    pub italic: bool,
    /// 字号（像素 * 100,取整,如 14.5 → 1450）
    pub font_size_100: u32,
    /// 是否 emoji 彩色字形
    pub is_color: bool,
}

/// 字形缓存条目
#[derive(Debug, Clone)]
struct CacheEntry {
    /// 所在 atlas 的 ID
    atlas_id: usize,
    /// Sprite 信息（位置 + UV）
    sprite: Sprite,
    /// 最近使用序号（值越大越新）
    seq: u64,
}

/// 渲染字形（光栅化后的位图数据）
///
/// 由 `font/swash.rs` 在阶段 5 产生,本阶段只做占位。
#[derive(Debug, Clone)]
pub struct RenderedGlyph {
    /// 位图数据（RGBA）
    pub data: Vec<u8>,
    /// 宽度（像素）
    pub width: u16,
    /// 高度（像素）
    pub height: u16,
    /// 基线偏移 X（像素）
    pub bearing_x: i16,
    /// 基线偏移 Y（像素）
    pub bearing_y: i16,
    /// 前进宽度（像素）
    pub advance: f32,
}

/// 字形 → sprite 缓存层
///
/// 借鉴 wezterm `GlyphCache`（`glyphcache.rs` 1376 行）:
/// - 输入 `GlyphKey` 查缓存,命中直接返回 `(atlas_id, Sprite)`
/// - 未命中则调用光栅化 + AtlasList 分配,写入缓存后返回
/// - LRU 淘汰:缓存满时淘汰最久未用的条目
///
/// 本阶段只实现缓存管理 + LRU 策略,光栅化由阶段 5 的 `font/swash.rs` 填补。
#[derive(Debug)]
pub struct GlyphCache {
    /// 缓存映射
    entries: HashMap<GlyphKey, CacheEntry>,
    /// AtlasList 纹理管理器
    atlas_list: AtlasList,
    /// 缓存最大条目数
    max_entries: usize,
    /// 全局序号（用于 LRU）
    seq: u64,
    /// 统计:命中次数
    hits: u64,
    /// 统计:未命中次数
    misses: u64,
}

impl GlyphCache {
    /// 创建 GlyphCache,指定缓存容量
    pub fn new(max_entries: usize) -> Self {
        Self {
            entries: HashMap::with_capacity(max_entries),
            atlas_list: AtlasList::new(),
            max_entries,
            seq: 0,
            hits: 0,
            misses: 0,
        }
    }

    /// 获取或缓存一个字形
    ///
    /// 返回 `(atlas_id, Sprite)`。
    /// 若未命中,调用 `render_fn` 光栅化后分配并缓存。
    ///
    /// 借鉴 wezterm `glyph_cache` 的 `get_or_load` 模式。
    pub fn get_or_load<F>(
        &mut self,
        key: &GlyphKey,
        render_fn: F,
    ) -> Option<(usize, Sprite)>
    where
        F: FnOnce(&GlyphKey) -> Option<RenderedGlyph>,
    {
        self.seq += 1;

        // 查缓存
        if let Some(entry) = self.entries.get_mut(key) {
            entry.seq = self.seq;
            self.hits += 1;
            return Some((entry.atlas_id, entry.sprite));
        }

        // 未命中,光栅化
        self.misses += 1;
        let rendered = render_fn(key)?;

        // 在 AtlasList 中分配空间
        let (atlas_id, sprite) = self
            .atlas_list
            .allocate(rendered.width, rendered.height)
            .ok()?;

        // 写入缓存
        let entry = CacheEntry {
            atlas_id,
            sprite,
            seq: self.seq,
        };
        self.entries.insert(key.clone(), entry);

        // LRU 淘汰
        if self.entries.len() > self.max_entries {
            self.evict_lru();
        }

        Some((atlas_id, sprite))
    }

    /// 直接插入一个已渲染的字形到缓存（跳过光栅化回调）
    pub fn insert(&mut self, key: GlyphKey, rendered: &RenderedGlyph) -> Option<(usize, Sprite)> {
        let (atlas_id, sprite) = self
            .atlas_list
            .allocate(rendered.width, rendered.height)
            .ok()?;

        let entry = CacheEntry {
            atlas_id,
            sprite,
            seq: self.seq,
        };
        self.entries.insert(key, entry);

        if self.entries.len() > self.max_entries {
            self.evict_lru();
        }

        Some((atlas_id, sprite))
    }

    /// 淘汰最久未使用的条目
    fn evict_lru(&mut self) {
        if self.entries.is_empty() {
            return;
        }
        // 找最小 seq 的条目
        let min_key = self
            .entries
            .iter()
            .min_by_key(|(_, entry)| entry.seq)
            .map(|(key, _)| key.clone());

        if let Some(key) = min_key {
            self.entries.remove(&key);
        }
    }

    /// 清除所有缓存
    pub fn clear(&mut self) {
        self.entries.clear();
        self.atlas_list.clear();
    }

    /// 缓存命中率
    pub fn hit_rate(&self) -> f32 {
        let total = self.hits + self.misses;
        if total == 0 {
            return 1.0;
        }
        self.hits as f32 / total as f32
    }

    /// 缓存条目数
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// 是否为空
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// AtlasList 引用
    pub fn atlas_list(&self) -> &AtlasList {
        &self.atlas_list
    }

    /// AtlasList 可变引用
    pub fn atlas_list_mut(&mut self) -> &mut AtlasList {
        &mut self.atlas_list
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_key(c: char) -> GlyphKey {
        GlyphKey {
            font_family: "test".to_string(),
            codepoint: c,
            weight: 400,
            italic: false,
            font_size_100: 1400,
            is_color: false,
        }
    }

    fn make_rendered(w: u16, h: u16) -> RenderedGlyph {
        RenderedGlyph {
            data: vec![0u8; (w as usize) * (h as usize) * 4],
            width: w,
            height: h,
            bearing_x: 0,
            bearing_y: 0,
            advance: w as f32,
        }
    }

    #[test]
    fn test_glyph_cache_hit() {
        let mut cache = GlyphCache::new(100);
        let key = make_key('A');

        // 第一次:未命中,渲染
        let result = cache.get_or_load(&key, |k| {
            assert_eq!(k.codepoint, 'A');
            Some(make_rendered(10, 20))
        });
        assert!(result.is_some());
        assert_eq!(cache.misses, 1);
        assert_eq!(cache.hits, 0);

        // 第二次:命中
        let result = cache.get_or_load(&key, |_| {
            panic!("should not be called");
        });
        assert!(result.is_some());
        assert_eq!(cache.misses, 1);
        assert_eq!(cache.hits, 1);
    }

    #[test]
    fn test_glyph_cache_lru_eviction() {
        let mut cache = GlyphCache::new(3); // 最多 3 个条目
        let key_a = make_key('A');
        let key_b = make_key('B');
        let key_c = make_key('C');
        let key_d = make_key('D');

        // 插入 A, B, C
        cache.get_or_load(&key_a, |_| Some(make_rendered(8, 8)));
        cache.get_or_load(&key_b, |_| Some(make_rendered(8, 8)));
        cache.get_or_load(&key_c, |_| Some(make_rendered(8, 8)));
        assert_eq!(cache.len(), 3);

        // 访问 A（更新 LRU 顺序）
        cache.get_or_load(&key_a, |_| {
            panic!("should be cached");
        });

        // 插入 D,应淘汰 B（最久未用）
        cache.get_or_load(&key_d, |_| Some(make_rendered(8, 8)));
        assert_eq!(cache.len(), 3);

        // B 应被淘汰
        let b_miss = cache.get_or_load(&key_b, |_| Some(make_rendered(8, 8)));
        assert!(b_miss.is_some());
        // B 被淘汰后重新加载,这是一次未命中
        // 总命中:仅 A 访问 1 次 = 1
        assert_eq!(cache.hits, 1);
    }

    #[test]
    fn test_glyph_cache_clear() {
        let mut cache = GlyphCache::new(100);
        cache.get_or_load(&make_key('X'), |_| Some(make_rendered(8, 8)));
        assert_eq!(cache.len(), 1);
        cache.clear();
        assert_eq!(cache.len(), 0);
    }

    #[test]
    fn test_glyph_cache_insert_direct() {
        let mut cache = GlyphCache::new(100);
        let key = make_key('😀');
        let rendered = make_rendered(32, 32);
        let result = cache.insert(key.clone(), &rendered);
        assert!(result.is_some());

        // 应命中缓存
        let hit = cache.get_or_load(&key, |_| {
            panic!("should be cached");
        });
        assert!(hit.is_some());
    }

    #[test]
    fn test_glyph_cache_hit_rate() {
        let mut cache = GlyphCache::new(100);
        assert!((cache.hit_rate() - 1.0).abs() < f32::EPSILON); // 空缓存 = 100%

        cache.get_or_load(&make_key('A'), |_| Some(make_rendered(8, 8))); // miss
        cache.get_or_load(&make_key('A'), |_| None); // hit
        cache.get_or_load(&make_key('B'), |_| Some(make_rendered(8, 8))); // miss

        // 2 hits / 3 total ≈ 0.33
        let rate = cache.hit_rate();
        assert!((rate - 0.333).abs() < 0.01);
    }
}