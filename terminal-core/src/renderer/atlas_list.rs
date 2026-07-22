//! AtlasList 多纹理管理
//!
//! 借鉴 wezterm `window/src/bitmaps/mod.rs`（468 行）的 `AtlasList` 设计:
//! - 管理一组 `Atlas` 实例,每个代表一个 wgpu 纹理
//! - `allocate()` 在当前 atlas 分配失败时,创建下一档尺寸的新 atlas
//! - 纹理尺寸从 64 开始,倍增到 4096 上限
//!
//! 本阶段只管理逻辑分配器,不实际创建 wgpu 纹理。
//! 阶段 6 集成 Tauri 时,由 `src-tauri/` 为每个 Atlas 创建对应的 `wgpu::Texture`。

use crate::renderer::atlas::{Atlas, OutOfTextureSpace, Sprite};

/// 初始纹理尺寸（2 的幂）
const INITIAL_ATLAS_SIZE: u16 = 64;

/// 最大纹理尺寸（2 的幂）
const MAX_ATLAS_SIZE: u16 = 4096;

/// 多纹理 Atlas 管理器
///
/// 借鉴 wezterm `AtlasList`（`window/src/bitmaps/mod.rs`）:
/// 按需创建新 atlas,动态扩容。
/// 每次 `allocate()` 失败时自动创建下一档尺寸的 atlas 并重试。
#[derive(Debug)]
pub struct AtlasList {
    /// 所有 Atlas 实例
    atlases: Vec<Atlas>,
    /// 下一档尺寸
    next_size: u16,
    /// 已分配像素总数
    total_allocated_pixels: u64,
}

impl AtlasList {
    /// 创建 AtlasList,初始包含一个 64x64 的 atlas
    pub fn new() -> Self {
        let first = Atlas::new(INITIAL_ATLAS_SIZE, 0);
        Self {
            atlases: vec![first],
            next_size: INITIAL_ATLAS_SIZE * 2,
            total_allocated_pixels: 0,
        }
    }

    /// 分配指定尺寸的矩形区域
    ///
    /// 在当前 atlas 中尝试分配;若失败则创建下一档尺寸的新 atlas 并重试。
    /// 返回 `(atlas_id, sprite)`。
    ///
    /// 借鉴 wezterm `allocate`（`atlas.rs:58-122` 的 `OutOfTextureSpace` 错误传播机制）:
    /// 满时创建新 atlas 而非扩容旧 atlas。
    pub fn allocate(&mut self, width: u16, height: u16) -> Result<(usize, Sprite), OutOfTextureSpace> {
        // 先尝试最后一个 atlas（最可能仍有空间）
        if let Some(last) = self.atlases.last_mut() {
            match last.allocate(width, height) {
                Ok(sprite) => {
                    let id = last.id();
                    self.total_allocated_pixels += width as u64 * height as u64;
                    return Ok((id, sprite));
                }
                Err(_) => {
                    // 当前 atlas 已满,创建新 atlas
                }
            }
        }

        // 创建新 atlas
        // 判断是否已达最大尺寸且当前 atlas 也是最大尺寸
        let last_at_max = self.atlases.last().map_or(false, |a| a.side() >= MAX_ATLAS_SIZE);
        let new_size = self.next_size;
        if new_size > MAX_ATLAS_SIZE || last_at_max {
            return Err(OutOfTextureSpace {
                size: None,
                current_size: MAX_ATLAS_SIZE,
            });
        }

        let new_id = self.atlases.len();
        let mut new_atlas = Atlas::new(new_size, new_id);
        self.next_size = (new_size * 2).min(MAX_ATLAS_SIZE);

        // 在新 atlas 中分配
        match new_atlas.allocate(width, height) {
            Ok(sprite) => {
                let id = new_atlas.id();
                self.total_allocated_pixels += width as u64 * height as u64;
                self.atlases.push(new_atlas);
                Ok((id, sprite))
            }
            Err(e) => {
                // 新 atlas 也放不下,返回错误
                Err(e)
            }
        }
    }

    /// 获取指定索引的 Atlas 引用
    pub fn get(&self, idx: usize) -> Option<&Atlas> {
        self.atlases.get(idx)
    }

    /// 获取指定索引的 Atlas 可变引用
    pub fn get_mut(&mut self, idx: usize) -> Option<&mut Atlas> {
        self.atlases.get_mut(idx)
    }

    /// Atlas 数量
    pub fn len(&self) -> usize {
        self.atlases.len()
    }

    /// 是否为空
    pub fn is_empty(&self) -> bool {
        self.atlases.is_empty()
    }

    /// 所有 atlas 的 fill_ratio 迭代器
    pub fn fill_ratios(&self) -> Vec<f32> {
        self.atlases.iter().map(|a| a.fill_ratio()).collect()
    }

    /// 清除所有 atlas（重置分配器）
    pub fn clear(&mut self) {
        for atlas in &mut self.atlases {
            atlas.clear();
        }
        self.total_allocated_pixels = 0;
    }

    /// 把 RGBA 位图写入指定 atlas 的指定位置
    ///
    /// `atlas_id` 来自 `allocate` 返回值的第一个元素。
    /// `sprite` 来自 `allocate` 返回值的第二个元素。
    /// `data` 是源位图（RGBA,每像素 4 字节）,尺寸应与 sprite 一致。
    ///
    /// 越界或尺寸不匹配时静默忽略。
    pub fn write(&mut self, atlas_id: usize, sprite: &Sprite, data: &[u8]) {
        if let Some(atlas) = self.atlases.get_mut(atlas_id) {
            atlas.write(sprite.x, sprite.y, sprite.width, sprite.height, data);
        }
    }

    /// 获取指定 atlas 的像素缓冲区引用
    ///
    /// 阶段 6 由 wgpu 上传逻辑 read。
    pub fn pixels(&self, atlas_id: usize) -> Option<&[u8]> {
        self.atlases.get(atlas_id).map(|a| a.pixels())
    }
}

impl Default for AtlasList {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_atlas_list_create() {
        let list = AtlasList::new();
        assert_eq!(list.len(), 1);
        assert!(!list.is_empty());
    }

    #[test]
    fn test_atlas_list_allocate_small() {
        let mut list = AtlasList::new();
        let (id, sprite) = list.allocate(16, 16).expect("should allocate");
        assert_eq!(id, 0);
        assert_eq!(sprite.width, 16);
        assert_eq!(sprite.height, 16);
    }

    #[test]
    fn test_atlas_list_auto_grow() {
        let mut list = AtlasList::new();
        // 填满初始 64x64 atlas
        // 每次分配 32x32,可放 4 个;第 5 个触发新 atlas
        for _ in 0..4 {
            list.allocate(32, 32).expect("should fit in first atlas");
        }
        assert_eq!(list.len(), 1);

        // 第 5 个触发新 atlas
        let (id, _) = list.allocate(32, 32).expect("should create new atlas");
        assert_eq!(id, 1);
        assert_eq!(list.len(), 2);
    }

    #[test]
    fn test_atlas_list_max_size() {
        let mut list = AtlasList::new();
        // 分配超大尺寸,应触发 OutOfTextureSpace
        let result = list.allocate(5000, 5000);
        assert!(result.is_err());
    }

    #[test]
    fn test_atlas_list_clear() {
        let mut list = AtlasList::new();
        list.allocate(16, 16).expect("should allocate");
        list.allocate(16, 16).expect("should allocate");
        assert!(list.fill_ratios()[0] > 0.0);
        list.clear();
        assert!(list.fill_ratios()[0] < 0.01);
    }

    #[test]
    fn test_atlas_list_grow_to_max() {
        let mut list = AtlasList::new();
        // 逐步填满直到最大
        let mut allocated = 0;
        loop {
            match list.allocate(16, 16) {
                Ok((_, _)) => allocated += 1,
                Err(_) => break,
            }
            if allocated > 1000000 {
                panic!("infinite loop");
            }
        }
        // 应该有多个 atlas
        assert!(list.len() > 1);
        // 最后应达到 4096 上限
        let last = list.get(list.len() - 1).unwrap();
        assert_eq!(last.side(), 4096);
        // 至少分配了 10000 个字形（每个 16x16,总容量约 87381）
        assert!(allocated > 10000);
    }
}