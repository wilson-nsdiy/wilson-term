//! 屏幕缓冲区（主屏/备屏 + 回滚 ring buffer）
//!
//! 借鉴 wezterm `term/src/screen.rs`（1155 行）的 `Screen` 结构设计:
//! - 主屏包含回滚缓冲区,备屏无回滚
//! - `VecDeque<Line>` 作为存储,尾部是可见行,头部是回滚行
//! - `phys_row` 将可视行索引转为物理行索引
//!
//! 本阶段实现最小功能集,支撑 performer 的写屏操作:
//! - 创建/调整大小
//! - 设置单元格（set_cell_grapheme）
//! - 滚动（new_line 推入一行,回滚行溢出时弹出）
//! - 擦除（ED/EL）
//! - 行插入/删除
//!
//! 完整功能（宽字符双向文本、语义标记等）在后续阶段扩充。

pub mod buffer;

use std::collections::VecDeque;

use crate::screen::buffer::{Cell, Line};

/// 默认回滚行数（未配置时的兜底值）
const DEFAULT_SCROLLBACK_SIZE: usize = 10000;

/// 屏幕缓冲区
///
/// 借鉴 wezterm `Screen`（screen.rs:15-47）:
/// - `lines` 是 `VecDeque<Line>`,尾部是可见行,头部是已滚动出去的回滚行
/// - `phys_row(visible_row)` 将可视行号转为 `lines` 中的物理索引
/// - `allow_scrollback` 控制是否保留回滚（主屏=true,备屏=false）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Screen {
    /// 所有行数据（回滚 + 可见行）
    lines: VecDeque<Line>,
    /// 物理可见行数（屏幕高度,不含回滚）
    pub physical_rows: usize,
    /// 物理可见列数（屏幕宽度）
    pub physical_cols: usize,
    /// 是否允许回滚（主屏=true,备屏=false）
    allow_scrollback: bool,
    /// 回滚区最大行数
    scrollback_capacity: usize,
    /// 每当一行从顶部回滚出去时递增,用于 StableRowIndex 计算
    stable_row_index_offset: usize,
}

impl Screen {
    /// 创建新屏幕,指定尺寸和是否允许回滚
    pub fn new(rows: usize, cols: usize) -> Self {
        Self::with_scrollback(rows, cols, true, DEFAULT_SCROLLBACK_SIZE)
    }

    /// 创建备屏（无回滚）
    pub fn new_alt(rows: usize, cols: usize) -> Self {
        Self::with_scrollback(rows, cols, false, 0)
    }

    /// 创建屏幕,指定所有参数
    pub fn with_scrollback(rows: usize, cols: usize, allow_scrollback: bool, scrollback_size: usize) -> Self {
        let capacity = rows + if allow_scrollback { scrollback_size } else { 0 };
        let mut lines = VecDeque::with_capacity(capacity);
        for _ in 0..rows {
            lines.push_back(Line::new(cols as u32));
        }
        Self {
            lines,
            physical_rows: rows,
            physical_cols: cols,
            allow_scrollback,
            scrollback_capacity: scrollback_size,
            stable_row_index_offset: 0,
        }
    }

    /// 调整屏幕尺寸
    pub fn resize(&mut self, new_rows: usize, new_cols: usize) {
        let old_rows = self.physical_rows;
        let old_cols = self.physical_cols;

        self.physical_rows = new_rows;
        self.physical_cols = new_cols;

        let total = self.lines.len();

        if new_cols != old_cols {
            // 每行调整列宽
            for line in self.lines.iter_mut() {
                line.resize(new_cols as u32);
            }
        }

        if new_rows > old_rows {
            // 增加行:在可见区末尾添加空行
            let to_add = new_rows - old_rows;
            for _ in 0..to_add {
                self.lines.push_back(Line::new(new_cols as u32));
            }
        } else if new_rows < old_rows {
            // 减少行:从可见区末尾移除行（回滚到回滚区）
            let to_remove = old_rows - new_rows;
            // 把要移除的行推入回滚
            if self.allow_scrollback {
                for _ in 0..to_remove {
                    let line = self.lines.pop_back().unwrap();
                    self.lines.push_front(line);
                }
            } else {
                for _ in 0..to_remove {
                    self.lines.pop_back();
                }
            }
        }

        // 确保回滚区不超容量
        self.trim_scrollback();
    }

    /// 获取可见行（物理行索引,从 0 到 physical_rows-1）
    pub fn line(&self, row: usize) -> Option<&Line> {
        let idx = self.phys_row(row);
        self.lines.get(idx)
    }

    /// 获取可见行可变引用
    pub fn line_mut(&mut self, row: usize) -> Option<&mut Line> {
        let idx = self.phys_row(row);
        self.lines.get_mut(idx)
    }

    /// 获取指定物理行索引的行
    pub fn line_by_phys(&self, phys_idx: usize) -> Option<&Line> {
        self.lines.get(phys_idx)
    }

    /// 获取指定物理行索引的行可变引用
    pub fn line_by_phys_mut(&mut self, phys_idx: usize) -> Option<&mut Line> {
        self.lines.get_mut(phys_idx)
    }

    /// 设置单元格字素
    ///
    /// 借鉴 wezterm `set_cell_grapheme`（screen.rs:411-459）:
    /// 在指定可视位置设置字素 + 属性,宽字符自动填满后续列。
    pub fn set_cell_grapheme(&mut self, col: usize, row: usize, text: &str, width: u32, pen: &Cell) {
        if row >= self.physical_rows || col >= self.physical_cols {
            return;
        }
        let idx = self.phys_row(row);
        if let Some(line) = self.lines.get_mut(idx) {
            line.set_cell_grapheme(col, text, width, pen);
        }
    }

    /// 新行（LF 换行）:推入一行,必要时滚动
    ///
    /// 借鉴 wezterm `new_line`（screen.rs 中通过 `Screen::scroll` 和 `LineBuffer` 实现）:
    /// 在可见区末尾插入一个空行,原最上面一行移入回滚区。
    /// 返回新行的物理行索引。
    pub fn new_line(&mut self) -> usize {
        let new_line = Line::new(self.physical_cols as u32);
        self.lines.push_back(new_line);

        // 如果回滚区超容量,从头部弹出
        if self.allow_scrollback
            && self.lines.len() > self.physical_rows + self.scrollback_capacity
        {
            self.lines.pop_front();
            self.stable_row_index_offset += 1;
        }

        // 返回新行的物理行索引（可见区最后一行）
        self.lines.len() - 1
    }

    /// 将可视行索引转为物理行索引
    ///
    /// 借鉴 wezterm `phys_row`（screen.rs:464-472）:
    /// 物理行索引 = lines.len() - physical_rows + row
    #[inline]
    pub fn phys_row(&self, row: usize) -> usize {
        let base = self.lines.len().saturating_sub(self.physical_rows);
        base + row
    }

    /// 回滚区行数
    pub fn scrollback_rows(&self) -> usize {
        self.lines.len().saturating_sub(self.physical_rows)
    }

    /// 总行数（回滚 + 可见）
    pub fn total_rows(&self) -> usize {
        self.lines.len()
    }

    /// 擦除显示（ED）
    ///
    /// 借鉴 wezterm 的 ED 实现:
    /// - 0:擦除光标到行尾
    /// - 1:擦除行首到光标
    /// - 2:擦除全部
    /// - 3:擦除回滚区
    pub fn erase_display(&mut self, kind: u8, cursor_row: usize, cursor_col: usize) {
        let blank = Cell::default();
        let cols = self.physical_cols;
        let rows = self.physical_rows;
        match kind {
            0 => {
                // 擦除光标到行尾
                if let Some(line) = self.line_mut(cursor_row) {
                    for col in cursor_col..cols {
                        line.set_cell(col, blank.clone());
                    }
                }
                // 擦除以下所有行
                for row in (cursor_row + 1)..rows {
                    if let Some(line) = self.line_mut(row) {
                        line.fill_range(0..cols, &blank);
                    }
                }
            }
            1 => {
                // 擦除行首到光标
                if let Some(line) = self.line_mut(cursor_row) {
                    for col in 0..=cursor_col {
                        line.set_cell(col, blank.clone());
                    }
                }
                // 擦除以上所有行
                for row in 0..cursor_row {
                    if let Some(line) = self.line_mut(row) {
                        line.fill_range(0..cols, &blank);
                    }
                }
            }
            2 => {
                // 擦除全部
                for row in 0..rows {
                    if let Some(line) = self.line_mut(row) {
                        line.fill_range(0..cols, &blank);
                    }
                }
            }
            3 => {
                // 擦除回滚区
                self.clear_scrollback();
            }
            _ => {}
        }
    }

    /// 擦除行（EL）
    ///
    /// 借鉴 wezterm 的 EL 实现:
    /// - 0:擦除光标到行尾
    /// - 1:擦除行首到光标
    /// - 2:擦除整行
    pub fn erase_line(&mut self, kind: u8, row: usize, cursor_col: usize) {
        let blank = Cell::default();
        let cols = self.physical_cols;
        if let Some(line) = self.line_mut(row) {
            match kind {
                0 => {
                    for col in cursor_col..cols {
                        line.set_cell(col, blank.clone());
                    }
                }
                1 => {
                    for col in 0..=cursor_col {
                        line.set_cell(col, blank.clone());
                    }
                }
                2 => {
                    line.fill_range(0..cols, &blank);
                }
                _ => {}
            }
        }
    }

    /// 插入行（IL）
    pub fn insert_lines(&mut self, n: u32, row: usize) {
        let n = n as usize;
        let cols = self.physical_cols;
        for _ in 0..n {
            let new_line = Line::new(cols as u32);
            // 在 row 位置插入,可见区最后一行被推出
            // 先找到物理行索引
            let phys = self.phys_row(row);
            if phys < self.lines.len() {
                self.lines.insert(phys, new_line);
                // 保持可见区大小不变,移除最后一行
                self.lines.pop_back();
            }
        }
    }

    /// 删除行（DL）
    pub fn delete_lines(&mut self, n: u32, row: usize) {
        let n = n as usize;
        for _ in 0..n {
            let phys = self.phys_row(row);
            if phys < self.lines.len() {
                self.lines.remove(phys);
                // 在可见区末尾添加空行补偿
                self.lines.push_back(Line::new(self.physical_cols as u32));
            }
        }
    }

    /// 插入字符（ICH）
    pub fn insert_chars(&mut self, n: u32, row: usize, col: usize) {
        let cols = self.physical_cols;
        if let Some(line) = self.line_mut(row) {
            for _ in 0..n {
                line.insert_cell(col, cols);
            }
        }
    }

    /// 删除字符（DCH）
    pub fn delete_chars(&mut self, n: u32, row: usize, col: usize) {
        let cols = self.physical_cols;
        if let Some(line) = self.line_mut(row) {
            for _ in 0..n {
                line.delete_cell(col, cols);
            }
        }
    }

    /// 滚动（SU/SD）
    ///
    /// - `up=true`:SU,向上滚动 n 行（顶部行消失,底部加空行）
    /// - `up=false`:SD,向下滚动 n 行（底部行消失,顶部加空行）
    pub fn scroll(&mut self, up: bool, n: u32) {
        let n = n as usize;
        if up {
            for _ in 0..n {
                self.new_line();
            }
        } else {
            for _ in 0..n {
                // 在可见区顶部插入空行,底部行移入回滚（或丢弃）
                let new_line = Line::new(self.physical_cols as u32);
                let phys = self.phys_row(0);
                if phys < self.lines.len() {
                    self.lines.insert(phys, new_line);
                    // 移除最后一行以保持可见区大小不变
                    self.lines.pop_back();
                }
            }
        }
    }

    /// 清除回滚区
    pub fn clear_scrollback(&mut self) {
        let visible_count = self.physical_rows;
        // 只保留最后 visible_count 行
        while self.lines.len() > visible_count {
            self.lines.pop_front();
            self.stable_row_index_offset += 1;
        }
    }

    /// 修剪回滚区,确保不超容量
    fn trim_scrollback(&mut self) {
        let max_total = self.physical_rows
            + if self.allow_scrollback {
                self.scrollback_capacity
            } else {
                0
            };
        while self.lines.len() > max_total {
            self.lines.pop_front();
            self.stable_row_index_offset += 1;
        }
    }

    /// 获取可见行范围（物理行索引）
    pub fn visible_range(&self) -> std::ops::Range<usize> {
        let base = self.lines.len().saturating_sub(self.physical_rows);
        base..base + self.physical_rows
    }
}

/// 双屏管理器（主屏 + 备屏）
///
/// 借鉴 wezterm 的 `ScreenOrAlt` 设计:
/// 主屏（primary）包含回滚,备屏（alternate）无回滚。
/// 切换时交换主屏/备屏,但保留原内容。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenManager {
    /// 主屏（包含回滚）
    primary: Screen,
    /// 备屏（无回滚）
    alternate: Option<Screen>,
    /// 当前激活的是否为备屏
    pub alt_screen_active: bool,
}

impl ScreenManager {
    /// 创建屏幕管理器,初始为主屏
    pub fn new(rows: usize, cols: usize) -> Self {
        Self {
            primary: Screen::new(rows, cols),
            alternate: None,
            alt_screen_active: false,
        }
    }

    /// 获取当前屏幕的可变引用
    pub fn current(&mut self) -> &mut Screen {
        if self.alt_screen_active {
            self.alternate.as_mut().unwrap()
        } else {
            &mut self.primary
        }
    }

    /// 获取当前屏幕的不可变引用
    pub fn current_ref(&self) -> &Screen {
        if self.alt_screen_active {
            self.alternate.as_ref().unwrap()
        } else {
            &self.primary
        }
    }

    /// 切换备屏（DEC 47/1047/1049）
    pub fn switch_to_alt(&mut self, rows: usize, cols: usize) {
        if self.alternate.is_none() {
            self.alternate = Some(Screen::new_alt(rows, cols));
        }
        // 调整备屏尺寸
        if let Some(ref mut alt) = self.alternate {
            if alt.physical_rows != rows || alt.physical_cols != cols {
                alt.resize(rows, cols);
            }
        }
        self.alt_screen_active = true;
    }

    /// 切换回主屏（DEC 47/1047/1049）
    pub fn switch_to_primary(&mut self) {
        self.alt_screen_active = false;
    }

    /// 调整尺寸（同时调整主屏和备屏）
    pub fn resize(&mut self, rows: usize, cols: usize) {
        self.primary.resize(rows, cols);
        if let Some(ref mut alt) = self.alternate {
            alt.resize(rows, cols);
        }
    }

    /// 备屏是否存在
    pub fn has_alt(&self) -> bool {
        self.alternate.is_some()
    }

    /// 销毁备屏（DEC 1047 不带备屏保存）
    pub fn destroy_alt(&mut self) {
        self.alternate = None;
        self.alt_screen_active = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_screen_create() {
        let s = Screen::new(24, 80);
        assert_eq!(s.physical_rows, 24);
        assert_eq!(s.physical_cols, 80);
        assert_eq!(s.scrollback_rows(), 0);
        assert_eq!(s.total_rows(), 24);
    }

    #[test]
    fn test_alt_screen_no_scrollback() {
        let s = Screen::new_alt(24, 80);
        assert_eq!(s.physical_rows, 24);
        assert_eq!(s.scrollback_rows(), 0);
    }

    #[test]
    fn test_set_cell_grapheme() {
        let mut s = Screen::new(24, 80);
        let pen = Cell::new("X", 1);
        s.set_cell_grapheme(0, 0, "X", 1, &pen);
        let line = s.line(0).unwrap();
        let cell = line.cell(0).unwrap();
        assert_eq!(cell.text, "X");
    }

    #[test]
    fn test_new_line_scroll() {
        let mut s = Screen::new(3, 80);
        // 填满 3 行
        s.set_cell_grapheme(0, 0, "A", 1, &Cell::new("A", 1));
        s.set_cell_grapheme(0, 1, "B", 1, &Cell::new("B", 1));
        s.set_cell_grapheme(0, 2, "C", 1, &Cell::new("C", 1));
        // 推入新行,第 0 行进入回滚
        s.new_line();
        assert_eq!(s.scrollback_rows(), 1);
        assert_eq!(s.total_rows(), 4);
        // 可见行 0 现在是原来的第 1 行
        let line = s.line(0).unwrap();
        let cell = line.cell(0).unwrap();
        assert_eq!(cell.text, "B");
    }

    #[test]
    fn test_erase_display_all() {
        let mut s = Screen::new(3, 80);
        let pen = Cell::new("X", 1);
        s.set_cell_grapheme(0, 0, "X", 1, &pen);
        s.set_cell_grapheme(0, 1, "Y", 1, &pen);
        s.erase_display(2, 0, 0);
        let line = s.line(0).unwrap();
        assert!(line.cell(0).unwrap().is_empty());
        assert!(line.cell(1).unwrap().is_empty());
    }

    #[test]
    fn test_erase_line_to_end() {
        let mut s = Screen::new(3, 80);
        let pen = Cell::new("X", 1);
        s.set_cell_grapheme(0, 0, "A", 1, &pen);
        s.set_cell_grapheme(1, 0, "B", 1, &pen);
        s.set_cell_grapheme(2, 0, "C", 1, &pen);
        // 擦除第 0 行从 col=1 到行尾
        s.erase_line(0, 0, 1);
        assert_eq!(s.line(0).unwrap().cell(0).unwrap().text, "A");
        assert!(s.line(0).unwrap().cell(1).unwrap().is_empty());
    }

    #[test]
    fn test_scroll_up() {
        let mut s = Screen::new(3, 80);
        let pen = Cell::new("X", 1);
        s.set_cell_grapheme(0, 0, "A", 1, &pen);
        s.set_cell_grapheme(0, 1, "B", 1, &pen);
        s.set_cell_grapheme(0, 2, "C", 1, &pen);
        // SU 1
        s.scroll(true, 1);
        assert_eq!(s.scrollback_rows(), 1);
        // 可见行 0 现在是 B
        assert_eq!(s.line(0).unwrap().cell(0).unwrap().text, "B");
    }

    #[test]
    fn test_scroll_down() {
        let mut s = Screen::new(3, 80);
        let pen = Cell::new("X", 1);
        s.set_cell_grapheme(0, 0, "A", 1, &pen);
        s.set_cell_grapheme(0, 1, "B", 1, &pen);
        s.set_cell_grapheme(0, 2, "C", 1, &pen);
        // SD 1
        s.scroll(false, 1);
        // 可见行 0 现在为空,原各行下移
        assert!(s.line(0).unwrap().cell(0).unwrap().is_empty());
        assert_eq!(s.line(1).unwrap().cell(0).unwrap().text, "A");
    }

    #[test]
    fn test_clear_scrollback() {
        let mut s = Screen::new(3, 80);
        s.new_line();
        s.new_line();
        assert_eq!(s.scrollback_rows(), 2);
        s.clear_scrollback();
        assert_eq!(s.scrollback_rows(), 0);
        assert_eq!(s.total_rows(), 3);
    }

    #[test]
    fn test_screen_manager_switch() {
        let mut mgr = ScreenManager::new(24, 80);
        assert!(!mgr.alt_screen_active);
        assert!(!mgr.has_alt());

        // 切到备屏
        mgr.switch_to_alt(24, 80);
        assert!(mgr.alt_screen_active);
        assert!(mgr.has_alt());

        // 在备屏上写
        let pen = Cell::new("X", 1);
        mgr.current().set_cell_grapheme(0, 0, "X", 1, &pen);

        // 切回主屏
        mgr.switch_to_primary();
        assert!(!mgr.alt_screen_active);
        // 主屏没有备屏的内容
        assert!(mgr.current_ref().line(0).unwrap().cell(0).unwrap().is_empty());

        // 再切回备屏,内容保留
        mgr.switch_to_alt(24, 80);
        assert_eq!(mgr.current_ref().line(0).unwrap().cell(0).unwrap().text, "X");
    }

    #[test]
    fn test_resize() {
        let mut s = Screen::new(3, 80);
        assert_eq!(s.physical_cols, 80);
        s.resize(5, 132);
        assert_eq!(s.physical_rows, 5);
        assert_eq!(s.physical_cols, 132);
        assert_eq!(s.line(0).unwrap().cols(), 132);
    }

    #[test]
    fn test_insert_lines() {
        let mut s = Screen::new(3, 80);
        let pen = Cell::new("X", 1);
        s.set_cell_grapheme(0, 0, "A", 1, &pen);
        s.set_cell_grapheme(0, 2, "C", 1, &pen);
        // 在行 0 处插入 1 行
        s.insert_lines(1, 0);
        // 行 0 变为空
        assert!(s.line(0).unwrap().cell(0).unwrap().is_empty());
        // 原行 0 的内容（A）移到行 1
        assert_eq!(s.line(1).unwrap().cell(0).unwrap().text, "A");
    }

    #[test]
    fn test_delete_lines() {
        let mut s = Screen::new(3, 80);
        let pen = Cell::new("X", 1);
        s.set_cell_grapheme(0, 0, "A", 1, &pen);
        s.set_cell_grapheme(0, 1, "B", 1, &pen);
        // 删除行 0
        s.delete_lines(1, 0);
        // 行 0 现在是原来的行 1
        assert_eq!(s.line(0).unwrap().cell(0).unwrap().text, "B");
    }

    #[test]
    fn test_scrollback_overflow() {
        let mut s = Screen::with_scrollback(3, 80, true, 5);
        // 推入 10 行,回滚区容量 5
        for _ in 0..10 {
            s.new_line();
        }
        // 可见行 3 行 + 回滚 5 行 = 8 行
        assert_eq!(s.total_rows(), 8);
        assert_eq!(s.scrollback_rows(), 5);
    }
}