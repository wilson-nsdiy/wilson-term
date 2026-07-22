//! 行缓冲区
//!
//! 终端屏幕的基本单元。借鉴 wezterm `wezterm-cell/src/lib.rs` 的 `Cell` + `Line` 设计,
//! 但本阶段只需最小实现:一行字素 + 属性,支持 resize 和 set_cell。

use crate::escape::csi::ColorSpec;

/// 终端单元格
///
/// 借鉴 wezterm `Cell`（wezterm-cell/src/lib.rs:715-725）:
/// 每个单元格包含一个字素和一组属性。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cell {
    /// 单元格中的字素（可见字符）
    pub text: String,
    /// 单元格宽度（1=ASCII,2=CJK）
    pub width: u32,
    /// 前景色
    pub foreground: ColorSpec,
    /// 背景色
    pub background: ColorSpec,
    /// 亮度（0=Normal,1=Bold,2=Half）
    pub intensity: u8,
    /// 斜体
    pub italic: bool,
    /// 下划线样式
    pub underline: u8,
    /// 闪烁
    pub blink: u8,
    /// 反色
    pub reverse: bool,
    /// 删除线
    pub strike: bool,
    /// 隐藏
    pub hidden: bool,
}

impl Default for Cell {
    fn default() -> Self {
        Self {
            text: String::new(),
            width: 1,
            foreground: ColorSpec::Default,
            background: ColorSpec::Default,
            intensity: 0,
            italic: false,
            underline: 0,
            blink: 0,
            reverse: false,
            strike: false,
            hidden: false,
        }
    }
}

impl Cell {
    /// 从字素和宽度创建单元格
    pub fn new(text: &str, width: u32) -> Self {
        Self {
            text: text.to_string(),
            width,
            ..Default::default()
        }
    }

    /// 是否为空白单元格
    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }
}

/// 终端行（一行单元格）
///
/// 借鉴 wezterm `Line`（wezterm-cell/src/lib.rs 中未直接导出,但通过 `Screen` 的 `line_mut` 访问）:
/// 每个行包含一组单元格,支持 resize 和 set_cell。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
    /// 单元格列表
    cells: Vec<Cell>,
    /// 行宽（单元格数）
    cols: u32,
}

impl Line {
    /// 创建新行,指定列数
    pub fn new(cols: u32) -> Self {
        let mut cells = Vec::with_capacity(cols as usize);
        for _ in 0..cols {
            cells.push(Cell::default());
        }
        Self { cells, cols }
    }

    /// 获取列数
    pub fn cols(&self) -> u32 {
        self.cols
    }

    /// 获取指定列的单元格引用
    pub fn cell(&self, col: usize) -> Option<&Cell> {
        self.cells.get(col)
    }

    /// 获取指定列的单元格可变引用
    pub fn cell_mut(&mut self, col: usize) -> Option<&mut Cell> {
        self.cells.get_mut(col)
    }

    /// 设置指定列的单元格
    pub fn set_cell(&mut self, col: usize, cell: Cell) {
        if col < self.cells.len() {
            self.cells[col] = cell;
        }
    }

    /// 设置指定列的字素和属性
    pub fn set_cell_grapheme(&mut self, col: usize, text: &str, width: u32, pen: &Cell) {
        if col >= self.cells.len() {
            return;
        }
        // 设置主单元格
        self.cells[col].text = text.to_string();
        self.cells[col].width = width;
        self.cells[col].foreground = pen.foreground;
        self.cells[col].background = pen.background;
        self.cells[col].intensity = pen.intensity;
        self.cells[col].italic = pen.italic;
        self.cells[col].underline = pen.underline;
        self.cells[col].blink = pen.blink;
        self.cells[col].reverse = pen.reverse;
        self.cells[col].strike = pen.strike;
        self.cells[col].hidden = pen.hidden;

        // 宽字符占用多列,后续列置空
        if width > 1 {
            for i in 1..width {
                let next = col + i as usize;
                if next < self.cells.len() {
                    self.cells[next].text = String::new();
                    self.cells[next].width = 0;
                }
            }
        }
    }

    /// 调整列数
    pub fn resize(&mut self, new_cols: u32) {
        let old_len = self.cells.len();
        let new_len = new_cols as usize;
        if new_len > old_len {
            self.cells.resize_with(new_len, Cell::default);
        } else if new_len < old_len {
            self.cells.truncate(new_len);
        }
        self.cols = new_cols;
    }

    /// 判断行是否全空
    pub fn is_blank(&self) -> bool {
        self.cells.iter().all(|c| c.is_empty())
    }

    /// 填充指定范围
    pub fn fill_range(&mut self, range: std::ops::Range<usize>, cell: &Cell) {
        for i in range {
            if i < self.cells.len() {
                self.cells[i] = cell.clone();
            }
        }
    }

    /// 插入一个单元格,右侧单元右移
    pub fn insert_cell(&mut self, col: usize, margin: usize) {
        if col >= self.cells.len() || margin > self.cells.len() {
            return;
        }
        // 从右向左移动
        for i in (col..margin - 1).rev() {
            self.cells[i + 1] = self.cells[i].clone();
        }
        self.cells[col] = Cell::default();
    }

    /// 删除一个单元格,右侧单元左移
    pub fn delete_cell(&mut self, col: usize, margin: usize) {
        if col >= self.cells.len() || margin > self.cells.len() {
            return;
        }
        for i in col..margin - 1 {
            self.cells[i] = self.cells[i + 1].clone();
        }
        self.cells[margin - 1] = Cell::default();
    }

    /// 获取空白行（所有单元格为默认值）
    pub fn blank_line(cols: u32) -> Self {
        Self::new(cols)
    }
}