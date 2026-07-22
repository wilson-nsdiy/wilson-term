//! 单纹理 Atlas + guillotiere 分配器
//!
//! 借鉴 wezterm `window/src/bitmaps/atlas.rs`（172 行）的设计:
//! - 每个 `Atlas` 包装一个逻辑纹理 + guillotiere `SimpleAtlasAllocator`
//! - `allocate()` 返回 `Sprite`（位置 + UV 坐标）或 `OutOfTextureSpace`（下一档尺寸）
//! - 纹理尺寸始终为 2 的幂（64/128/256/512/1024/2048/4096）
//!
//! 本阶段不实际创建 wgpu 纹理,只管理逻辑分配器。
//! 阶段 6 集成 Tauri 时,由 `src-tauri/` 负责创建 `wgpu::Texture` 并绑定到本 Atlas。

use guillotiere::{Allocation, SimpleAtlasAllocator, Size};

/// 纹理空间耗尽错误
///
/// 借鉴 wezterm `atlas.rs:58-122` 的 `OutOfTextureSpace`:
/// 当 `allocate()` 在当前纹理上分配失败时,返回下一档尺寸供上层创建新 atlas。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutOfTextureSpace {
    /// 建议的下一档纹理尺寸
    pub size: Option<u16>,
    /// 当前纹理尺寸
    pub current_size: u16,
}

/// Sprite 信息（位置 + UV 坐标）
///
/// 借鉴 wezterm `Sprite`（atlas.rs 中 `allocate` 的返回值）:
/// 记录分配结果,供渲染层构建 vertex buffer 时使用。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sprite {
    /// 在 Atlas 中的 X 坐标（像素）
    pub x: u16,
    /// 在 Atlas 中的 Y 坐标（像素）
    pub y: u16,
    /// 宽度（像素）
    pub width: u16,
    /// 高度（像素）
    pub height: u16,
    /// UV 坐标（归一化,用于 shader 采样）
    pub u_min: f32,
    pub v_min: f32,
    pub u_max: f32,
    pub v_max: f32,
}

/// 单纹理 Atlas
///
/// 借鉴 wezterm `Atlas`（atlas.rs:21-28）:
/// 一个 2 的幂的纹理,配合 guillotiere 的矩形分配器管理字形位置。
///
/// # 像素存储
///
/// 本阶段为逻辑分配器 + CPU 端 RGBA 像素缓冲区。阶段 6 集成 wgpu 时,
/// 由 `src-tauri/` 把 `pixels` 上传到 `wgpu::Texture`。这样光栅化→缓存→
/// 上传三步解耦,便于单测和后续替换后端。
pub struct Atlas {
    /// 纹理尺寸（2 的幂,如 512）
    side: u16,
    /// guillotiere 矩形分配器
    allocator: SimpleAtlasAllocator,
    /// 已用空间（像素²）
    allocated_pixels: u32,
    /// 总空间（像素²）
    total_pixels: u32,
    /// 纹理 ID（逻辑标识,用于 AtlasList 查找）
    id: usize,
    /// RGBA 像素缓冲区（长度 = side * side * 4）
    ///
    /// 初始全 0（完全透明）。`write` 把光栅化位图拷到指定位置。
    /// 阶段 6 上传到 wgpu 纹理时直接 read 这个 Vec。
    pixels: Vec<u8>,
}

impl core::fmt::Debug for Atlas {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Atlas")
            .field("side", &self.side)
            .field("id", &self.id)
            .field("allocated_pixels", &self.allocated_pixels)
            .field("total_pixels", &self.total_pixels)
            .field("fill_ratio", &self.fill_ratio())
            .finish()
    }
}

impl Atlas {
    /// 创建新 Atlas,指定尺寸（将被向上取整到 2 的幂）
    pub fn new(side: u16, id: usize) -> Self {
        let side = next_power_of_two(side);
        let total = side as u32 * side as u32;
        Self {
            side,
            allocator: SimpleAtlasAllocator::new(Size::new(side as i32, side as i32)),
            allocated_pixels: 0,
            total_pixels: total,
            id,
            pixels: vec![0u8; (side as usize) * (side as usize) * 4],
        }
    }

    /// 分配一个指定尺寸的矩形区域
    ///
    /// 成功返回 `Sprite`（含位置 + UV 坐标）;
    /// 失败返回 `OutOfTextureSpace`（含下一档尺寸建议）。
    ///
    /// 借鉴 wezterm `allocate`（atlas.rs:58-122）。
    pub fn allocate(&mut self, width: u16, height: u16) -> Result<Sprite, OutOfTextureSpace> {
        let allocation = self
            .allocator
            .allocate(Size::new(width as i32, height as i32));

        match allocation {
            Some(allocation) => {
                let rect = &allocation;
                let x = rect.min.x as u16;
                let y = rect.min.y as u16;
                let side_f = self.side as f32;

                self.allocated_pixels += width as u32 * height as u32;

                Ok(Sprite {
                    x,
                    y,
                    width,
                    height,
                    u_min: x as f32 / side_f,
                    v_min: y as f32 / side_f,
                    u_max: (x + width) as f32 / side_f,
                    v_max: (y + height) as f32 / side_f,
                })
            }
            None => {
                let next_size = next_power_of_two(self.side * 2);
                // 最大 4096
                let size = if next_size > 4096 {
                    None
                } else {
                    Some(next_size)
                };
                Err(OutOfTextureSpace {
                    size,
                    current_size: self.side,
                })
            }
        }
    }

    /// 当前纹理尺寸
    pub fn side(&self) -> u16 {
        self.side
    }

    /// 纹理 ID
    pub fn id(&self) -> usize {
        self.id
    }

    /// 已用空间占比（0.0 ~ 1.0）
    pub fn fill_ratio(&self) -> f32 {
        if self.total_pixels == 0 {
            return 0.0;
        }
        self.allocated_pixels as f32 / self.total_pixels as f32
    }

    /// 重置分配器（清除所有分配）
    pub fn clear(&mut self) {
        self.allocator = SimpleAtlasAllocator::new(Size::new(self.side as i32, self.side as i32));
        self.allocated_pixels = 0;
        // 清零像素缓冲区
        self.pixels.fill(0);
    }

    /// 把 RGBA 位图写入指定位置
    ///
    /// `x`/`y` 是 atlas 内的像素坐标（来自 `Sprite`）。
    /// `data` 是源位图（RGBA,每像素 4 字节）。
    /// `w`/`h` 是源位图尺寸。
    ///
    /// 越界或尺寸不匹配时静默忽略（调用方应保证 Sprite 与源位图尺寸一致）。
    /// 借鉴 wezterm `Atlas::write` 的逐行拷贝模式。
    pub fn write(&mut self, x: u16, y: u16, w: u16, h: u16, data: &[u8]) {
        let side = self.side as usize;
        let w = w as usize;
        let h = h as usize;
        let x = x as usize;
        let y = y as usize;

        if x + w > side || y + h > side {
            return;
        }
        if data.len() < w * h * 4 {
            return;
        }

        for row in 0..h {
            let src_off = row * w * 4;
            let dst_off = ((y + row) * side + x) * 4;
            self.pixels[dst_off..dst_off + w * 4]
                .copy_from_slice(&data[src_off..src_off + w * 4]);
        }
    }

    /// 获取像素缓冲区（RGBA）
    ///
    /// 阶段 6 由 wgpu 上传逻辑 read 这个缓冲区。
    pub fn pixels(&self) -> &[u8] {
        &self.pixels
    }

    /// 获取像素缓冲区可变引用
    pub fn pixels_mut(&mut self) -> &mut [u8] {
        &mut self.pixels
    }
}

/// 向上取整到 2 的幂
fn next_power_of_two(n: u16) -> u16 {
    if n == 0 {
        return 1;
    }
    let mut v = n;
    v -= 1;
    v |= v >> 1;
    v |= v >> 2;
    v |= v >> 4;
    v |= v >> 8;
    v + 1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_atlas_create() {
        let atlas = Atlas::new(512, 0);
        assert_eq!(atlas.side(), 512);
        assert_eq!(atlas.id(), 0);
        assert!(atlas.fill_ratio() < 0.01);
    }

    #[test]
    fn test_atlas_allocate_small() {
        let mut atlas = Atlas::new(512, 0);
        let sprite = atlas.allocate(32, 32).expect("should allocate");
        assert_eq!(sprite.width, 32);
        assert_eq!(sprite.height, 32);
        assert!(atlas.fill_ratio() > 0.0);
    }

    #[test]
    fn test_atlas_allocate_multiple() {
        let mut atlas = Atlas::new(128, 0);
        // 分配多个 16x16 区域
        for _ in 0..50 {
            let result = atlas.allocate(16, 16);
            assert!(result.is_ok(), "should fit 50x 16x16 in 128x128");
        }
    }

    #[test]
    fn test_atlas_out_of_space() {
        let mut atlas = Atlas::new(64, 0);
        // 分配一个 64x64 区域（占满）
        atlas.allocate(64, 64).expect("first should fit");
        // 再分配一个
        let result = atlas.allocate(1, 1);
        assert!(result.is_err());
        if let Err(err) = result {
            assert_eq!(err.current_size, 64);
            assert_eq!(err.size, Some(128));
        }
    }

    #[test]
    fn test_atlas_clear() {
        let mut atlas = Atlas::new(128, 0);
        atlas.allocate(64, 64).expect("should fit");
        assert!(atlas.fill_ratio() > 0.0);
        atlas.clear();
        assert!(atlas.fill_ratio() < 0.01);
        // 清除后应能重新分配
        atlas.allocate(64, 64).expect("should fit after clear");
    }

    #[test]
    fn test_next_power_of_two() {
        assert_eq!(next_power_of_two(0), 1);
        assert_eq!(next_power_of_two(1), 1);
        assert_eq!(next_power_of_two(2), 2);
        assert_eq!(next_power_of_two(3), 4);
        assert_eq!(next_power_of_two(64), 64);
        assert_eq!(next_power_of_two(100), 128);
        assert_eq!(next_power_of_two(4000), 4096);
    }

    #[test]
    fn test_uv_coordinates() {
        let mut atlas = Atlas::new(256, 0);
        let sprite = atlas.allocate(64, 64).expect("should allocate");
        // UV 坐标应为规范化值
        assert!((sprite.u_min - 0.0).abs() < f32::EPSILON);
        assert!((sprite.v_min - 0.0).abs() < f32::EPSILON);
        assert!((sprite.u_max - 0.25).abs() < f32::EPSILON);
        assert!((sprite.v_max - 0.25).abs() < f32::EPSILON);
    }
}