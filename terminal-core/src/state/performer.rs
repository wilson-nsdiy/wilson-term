//! 终端状态执行器（Performer）
//!
//! 借鉴 wezterm `term/src/terminalstate/performer.rs`（1109 行）的架构,
//! 把 `parser/actor.rs::Action` 流应用到 `TerminalState`。
//!
//! 分层:
//! ```text
//! vtparse (字节流 → VTAction)
//!   → actor (VTAction → Action)
//!     → performer (Action → TerminalState 字段变更)
//! ```
//!
//! 本阶段（1.3 第二步）只实现核心的状态变更逻辑:
//! - Print/PrintString → 写屏（暂用占位,实际 screen 缓冲区在阶段 1.3 第三步）
//! - Control (C0/C1) → LF/CR/BS/HT/BEL/制表等
//! - CSI → 分派到 CSI 枚举 + 应用到 TerminalState
//! - OSC → 分派到 OperatingSystemCommand + 应用到 TerminalState
//! - ESC → 分派到 DEC 字符集 / 键位 / 保存/恢复光标等
//! - DCS → Sixel / DECRQSS / XTGETTCAP（占位,阶段 4 实现）
//! - APC → Kitty 图形协议（占位,阶段 4 实现）

use crate::escape::csi::{
    parse_csi, parse_sgr, CursorMove, KittyKeyboardFlags, KittyKeyboardMode, Sgr,
};
use crate::escape::osc::{
    parse_osc, ITermProprietary, OperatingSystemCommand,
};
use crate::parser::actor::Action;
use crate::state::CursorPosition;
use crate::state::TerminalState;

/// 终端执行器
///
/// 持有 `TerminalState` 的可变引用,把 `Action` 流应用到状态上。
/// 借鉴 wezterm `Performer<'a>`（performer.rs:33-36）的 `state` + `print` 缓冲设计。
pub struct Performer<'a> {
    /// 终端状态
    pub state: &'a mut TerminalState,
    /// 打印字符缓冲区（合并相邻 Print 以提升性能）
    print: String,
    /// 已保存的光标位置（DECSC/DECRC）
    saved_cursor: Option<CursorPosition>,
}

impl<'a> Performer<'a> {
    /// 创建执行器
    pub fn new(state: &'a mut TerminalState) -> Self {
        Self {
            state,
            print: String::new(),
            saved_cursor: None,
        }
    }

    /// 刷新打印缓冲区,把累积的字符应用到屏幕
    ///
    /// 借鉴 wezterm `flush_print`（performer.rs:117-236）:
    /// 每个字符先检查 wrap_next → 换行,再设置单元格。
    /// 本阶段因 screen 缓冲区（阶段 1.3 第三步）未实现,暂用占位记录。
    fn flush_print(&mut self) {
        if self.print.is_empty() {
            return;
        }
        let text = std::mem::take(&mut self.print);

        // 写屏（阶段 4：接入真实 Screen 缓冲区）
        let cols = self.state.cols as usize;
        let rows = self.state.rows as u32;
        // 画笔 snapshot,避免借用冲突
        let pen_cell = self.pen_to_cell();
        let screen = self.state.screens.current();

        for c in text.chars() {
            let width = char_width(c);

            if self.state.mode.contains(crate::state::modes::TermMode::WRAP_NEXT) {
                // 行尾自动换行（上一字符已填满行尾）
                self.state.cursor.row += 1;
                self.state.cursor.col = 0;
                self.state
                    .mode
                    .remove(crate::state::modes::TermMode::WRAP_NEXT);
                // 超出屏幕底部 → 滚动
                if self.state.cursor.row >= rows {
                    screen.scroll(true, 1);
                    self.state.cursor.row = rows - 1;
                }
            }

            // 写入当前光标位置
            screen.set_cell_grapheme(
                self.state.cursor.col as usize,
                self.state.cursor.row as usize,
                &c.to_string(),
                width,
                &pen_cell,
            );

            // 光标右移
            if self.state.cursor.col as usize + width as usize >= cols {
                // 行尾：置 WRAP_NEXT（下个字符触发换行）
                self.state
                    .mode
                    .insert(crate::state::modes::TermMode::WRAP_NEXT);
            } else {
                self.state.cursor.col += width;
            }
        }
    }

    /// 把当前 `pen`（画笔属性）转为 `Cell` 用于写入屏幕
    fn pen_to_cell(&self) -> crate::screen::buffer::Cell {
        use crate::screen::buffer::Cell;
        let mut cell = Cell::default();
        cell.foreground = self.state.pen.foreground.clone();
        cell.background = self.state.pen.background.clone();
        cell.intensity = self.state.pen.intensity;
        cell.italic = self.state.pen.italic;
        cell.underline = self.state.pen.underline;
        cell.blink = self.state.pen.blink;
        cell.reverse = self.state.pen.reverse;
        cell.strike = self.state.pen.strike;
        cell.hidden = self.state.pen.hidden;
        cell
    }

    /// 主入口:执行一个 `Action`
    ///
    /// 借鉴 wezterm `perform`（performer.rs:252-288）,按 Action 变体分派。
    pub fn perform(&mut self, action: Action) {
        match action {
            Action::Print(c) => self.print(c),
            Action::PrintString(s) => {
                for c in s.chars() {
                    self.print(c);
                }
            }
            Action::Control(byte) => self.control(byte),
            Action::CsiDispatch {
                params,
                parameters_truncated: _,
                byte,
            } => {
                self.flush_print();
                // SGR（byte=b'm'）可能含多个参数（如 \x1b[1;31m 含 Bold + Red）,
                // 直接调 parse_sgr 逐个应用,避免 parse_csi 只返回第一个 Sgr
                if byte == b'm' {
                    for sgr in parse_sgr(&params) {
                        self.apply_sgr(sgr);
                    }
                } else {
                    let csi = parse_csi(&params, &[], false, byte);
                    self.csi_dispatch(csi);
                }
            }
            Action::EscDispatch {
                params,
                intermediates,
                ignored_excess_intermediates: _,
                byte,
            } => {
                self.flush_print();
                let _ = params;
                let _ = intermediates;
                self.esc_dispatch(byte, &intermediates);
            }
            Action::OscDispatch(params) => {
                self.flush_print();
                let params_refs: Vec<&[u8]> = params.iter().map(|v| v.as_slice()).collect();
                let osc = parse_osc(&params_refs);
                self.osc_dispatch(osc);
            }
            Action::DcsHook { .. } => {
                self.flush_print();
                // Sixel / DECRQSS — 阶段 4 实现
            }
            Action::DcsPut(_) => {}
            Action::DcsUnhook => {}
            Action::ApcDispatch(_) => {
                self.flush_print();
                // Kitty 图形协议 — 阶段 4 实现
            }
        }
    }

    // ── 打印 ──

    /// 打印单个字符（缓冲到 print 中,flush 时刷新到屏幕）
    fn print(&mut self, c: char) {
        self.print.push(c);
    }

    // ── C0/C1 控制字符 ──

    /// 处理 C0/C1 控制字符
    ///
    /// 借鉴 wezterm `control`（performer.rs:375-489）。
    fn control(&mut self, byte: u8) {
        self.flush_print();
        match byte {
            // LF / VT / FF:换行
            0x0A | 0x0B | 0x0C => {
                let next_row = self.state.cursor.row + 1;
                if next_row >= self.state.rows {
                    // 滚动（阶段 4：接入 Screen）
                    self.state.screens.current().scroll(true, 1);
                } else {
                    self.state.cursor.row = next_row;
                }
                self.state
                    .mode
                    .remove(crate::state::modes::TermMode::WRAP_NEXT);
            }
            // CR:回车
            0x0D => {
                self.state.cursor.col = 0;
                self.state
                    .mode
                    .remove(crate::state::modes::TermMode::WRAP_NEXT);
            }
            // BS:退格
            0x08 => {
                if self.state.cursor.col > 0 {
                    self.state.cursor.col -= 1;
                }
            }
            // HT:水平制表
            0x09 => {
                let next_tab = ((self.state.cursor.col / 8) + 1) * 8;
                self.state.cursor.col = next_tab.min(self.state.cols - 1);
            }
            // BEL:响铃
            0x07 => {
                // 本阶段暂不处理,渲染层可捕捉
            }
            // SO:Shift Out → G1 字符集
            0x0E => {}
            // SI:Shift In → G0 字符集
            0x0F => {}
            // 其他控制字符忽略
            _ => {}
        }
    }

    // ── CSI 分派 ──

    /// 处理已解析的 CSI 序列
    ///
    /// 借鉴 wezterm `csi_dispatch`（performer.rs:491-583）。
    fn csi_dispatch(&mut self, csi: crate::escape::csi::CSI) {
        use crate::escape::csi::CSI::*;
        match csi {
            Sgr(sgr) => {
                // 单 SGR,直接应用
                self.apply_sgr(sgr);
            }
            Cursor { dir, n } => {
                let n = n.max(1);
                match dir {
                    CursorMove::Up => {
                        self.state.cursor.row = self.state.cursor.row.saturating_sub(n);
                    }
                    CursorMove::Down => {
                        let max = self.state.rows - 1;
                        self.state.cursor.row = (self.state.cursor.row + n).min(max);
                    }
                    CursorMove::Forward => {
                        let max = self.state.cols - 1;
                        self.state.cursor.col = (self.state.cursor.col + n).min(max);
                    }
                    CursorMove::Back => {
                        self.state.cursor.col = self.state.cursor.col.saturating_sub(n);
                    }
                    CursorMove::NextLine => {
                        let max = self.state.rows - 1;
                        self.state.cursor.row = (self.state.cursor.row + n).min(max);
                        self.state.cursor.col = 0;
                    }
                    CursorMove::PrevLine => {
                        self.state.cursor.row = self.state.cursor.row.saturating_sub(n);
                        self.state.cursor.col = 0;
                    }
                    CursorMove::ColumnAbs => {
                        self.state.cursor.col = (n - 1).min(self.state.cols - 1);
                    }
                    CursorMove::RowAbs => {
                        self.state.cursor.row = (n - 1).min(self.state.rows - 1);
                    }
                    CursorMove::RowRel => {
                        let max = self.state.rows - 1;
                        self.state.cursor.row = (self.state.cursor.row + n).min(max);
                    }
                }
            }
            Tab => {
                // 制表,同 HT
                let next_tab = ((self.state.cursor.col / 8) + 1) * 8;
                self.state.cursor.col = next_tab.min(self.state.cols - 1);
            }
            EraseDisplay(kind) => {
                // 擦除显示（阶段 4：接入 Screen）
                use crate::escape::csi::EraseKind::*;
                let k = match kind {
                    ToEnd => 0u8,
                    ToStart => 1,
                    All => 2,
                    Scrollback => 3,
                };
                self.state.screens.current().erase_display(
                    k,
                    self.state.cursor.row as usize,
                    self.state.cursor.col as usize,
                );
            }
            EraseLine(kind) => {
                // 擦除行（阶段 4：接入 Screen）
                use crate::escape::csi::EraseKind::*;
                let k = match kind {
                    ToEnd => 0u8,
                    ToStart => 1,
                    All => 2,
                    Scrollback => 2, // EL 不支持 scrollback,退化为 All
                };
                self.state.screens.current().erase_line(
                    k,
                    self.state.cursor.row as usize,
                    self.state.cursor.col as usize,
                );
            }
            LineEdit { insert, n } => {
                // 插入/删除行（阶段 4：接入 Screen）
                let row = self.state.cursor.row as usize;
                if insert {
                    self.state.screens.current().insert_lines(n, row);
                } else {
                    self.state.screens.current().delete_lines(n, row);
                }
            }
            CharEdit { insert, n } => {
                // 插入/删除字符（阶段 4：接入 Screen）
                let row = self.state.cursor.row as usize;
                let col = self.state.cursor.col as usize;
                if insert {
                    self.state.screens.current().insert_chars(n, row, col);
                } else {
                    self.state.screens.current().delete_chars(n, row, col);
                }
            }
            Scroll { up, n } => {
                // 滚动（阶段 4：接入 Screen）
                self.state.screens.current().scroll(up, n);
            }
            SetDecPrivateMode(code) => {
                self.state.set_dec_private_mode(code);
            }
            ResetDecPrivateMode(code) => {
                self.state.reset_dec_private_mode(code);
            }
            QueryDecPrivateMode(code) => {
                let _ = self.state.query_dec_private_mode(code);
                // 查询结果应通过 writer 回写,本阶段暂不实现
            }
            KittyKeyboardPush(flags) => {
                self.state
                    .apply_kitty_keyboard(KittyKeyboardMode::AssignAll, flags);
            }
            KittyKeyboardPop => {
                self.state.apply_kitty_keyboard(
                    KittyKeyboardMode::AssignAll,
                    KittyKeyboardFlags::default(),
                );
            }
            KittyKeyboardQuery => {
                // 查询结果应通过 writer 回写,本阶段暂不实现
            }
            ModifyOtherKeys(val) => {
                self.state.modify_other_keys = val;
            }
            DeviceStatusReportCursor => {
                // 查询结果应通过 writer 回写,本阶段暂不实现
            }
            DeviceStatusReportSize => {
                // 查询结果应通过 writer 回写,本阶段暂不实现
            }
            DeviceAttributes { private: _ } => {
                // 查询结果应通过 writer 回写,本阶段暂不实现
            }
            Unknown { .. } => {
                // 未识别的 CSI,静默忽略
            }
        }
    }

    // ── SGR 应用 ──

    /// 应用单个 SGR 到 pen（当前画笔属性）
    fn apply_sgr(&mut self, sgr: Sgr) {
        use crate::escape::csi::Intensity::*;
        use crate::escape::csi::Underline::*;
        match sgr {
            Sgr::Reset => {
                self.state.pen = Default::default();
            }
            Sgr::Intensity(Bold) => self.state.pen.intensity = 1,
            Sgr::Intensity(Half) => self.state.pen.intensity = 2,
            Sgr::Intensity(Normal) => self.state.pen.intensity = 0,
            Sgr::Italic(val) => self.state.pen.italic = val,
            Sgr::Underline(Single) => self.state.pen.underline = 1,
            Sgr::Underline(Double) => self.state.pen.underline = 2,
            Sgr::Underline(Curly) => self.state.pen.underline = 3,
            Sgr::Underline(Dotted) => self.state.pen.underline = 4,
            Sgr::Underline(Dashed) => self.state.pen.underline = 5,
            Sgr::Underline(None) => self.state.pen.underline = 0,
            Sgr::Blink(blink) => self.state.pen.blink = blink as u8,
            Sgr::Reverse(val) => self.state.pen.reverse = val,
            Sgr::Strike(val) => self.state.pen.strike = val,
            Sgr::Hidden(val) => self.state.pen.hidden = val,
            Sgr::Foreground(c) => self.state.pen.foreground = c,
            Sgr::Background(c) => self.state.pen.background = c,
            Sgr::UnderlineColor(c) => self.state.pen.underline_color = c,
        }
    }

    // ── OSC 分派 ──

    /// 处理已解析的 OSC 命令
    ///
    /// 借鉴 wezterm `osc_dispatch`（performer.rs:737-）。
    fn osc_dispatch(&mut self, osc: OperatingSystemCommand) {
        match osc {
            OperatingSystemCommand::SetIconNameAndWindowTitle(title) => {
                self.state.title = title.clone();
                self.state.icon_title = None;
            }
            OperatingSystemCommand::SetWindowTitle(title)
            | OperatingSystemCommand::SetWindowTitleSun(title) => {
                self.state.title = title;
            }
            OperatingSystemCommand::SetIconName(title)
            | OperatingSystemCommand::SetIconNameSun(title) => {
                if title.is_empty() {
                    self.state.icon_title = None;
                } else {
                    self.state.icon_title = Some(title);
                }
            }
            OperatingSystemCommand::SetHyperlink(link) => {
                // 超链接（阶段 4 实现）
                let _ = link;
            }
            OperatingSystemCommand::CurrentWorkingDirectory(path) => {
                // 当前工作目录（记录用途）
                let _ = path;
            }
            OperatingSystemCommand::ChangeColorNumber(pairs) => {
                // 调色板颜色修改（阶段 5 实现）
                let _ = pairs;
            }
            OperatingSystemCommand::ChangeDynamicColors(color, colors) => {
                // 动态颜色修改（阶段 5 实现）
                let _ = (color, colors);
            }
            OperatingSystemCommand::ResetDynamicColor(color) => {
                // 重置动态颜色（阶段 5 实现）
                let _ = color;
            }
            OperatingSystemCommand::ResetColors(colors) => {
                // 重置调色板颜色（阶段 5 实现）
                let _ = colors;
            }
            OperatingSystemCommand::ManipulateSelectionData(sel, data) => {
                // 剪贴板操作（需通过 writer 交互,本阶段暂不实现）
                let _ = (sel, data);
            }
            OperatingSystemCommand::SystemNotification(msg) => {
                // 系统通知（需通过 writer 交互,本阶段暂不实现）
                let _ = msg;
            }
            OperatingSystemCommand::ITermProprietary(iterm) => {
                match iterm {
                    ITermProprietary::CurrentDir(path) => {
                        // iTerm2 当前目录
                        let _ = path;
                    }
                    ITermProprietary::Mark => {
                        // iTerm2 标记
                    }
                    _ => {
                        // 其他 iTerm2 命令忽略
                    }
                }
            }
            OperatingSystemCommand::FinalTermSemanticPrompt(prompt) => {
                // FinalTerm 语义提示
                let _ = prompt;
            }
            OperatingSystemCommand::RxvtExtension(parts) => {
                // Rxvt 扩展
                let _ = parts;
            }
            OperatingSystemCommand::Unspecified(_) => {
                // 未识别的 OSC,静默忽略
            }
        }
    }

    // ── ESC 分派 ──

    /// 处理 ESC 序列
    ///
    /// 借鉴 wezterm `esc_dispatch`（performer.rs:585-734）。
    fn esc_dispatch(&mut self, byte: u8, _intermediates: &[u8]) {
        match byte {
            // DEC 键位
            b'=' => {
                // DECKPAM:应用键盘
                self.state
                    .mode
                    .insert(crate::state::modes::TermMode::APPLICATION_KEYPAD);
            }
            b'>' => {
                // DECKPNM:数字键盘
                self.state
                    .mode
                    .remove(crate::state::modes::TermMode::APPLICATION_KEYPAD);
            }
            // 保存/恢复光标
            b'7' => {
                // DECSC:保存光标
                self.saved_cursor = Some(self.state.cursor);
            }
            b'8' => {
                // DECRC:恢复光标
                if let Some(saved) = self.saved_cursor {
                    self.state.cursor = saved;
                }
            }
            // 行控制
            b'D' => {
                // IND:索引（光标下移一行,可能滚动）
                let next_row = self.state.cursor.row + 1;
                if next_row >= self.state.rows {
                    // 滚动（阶段 4：接入 Screen）
                    self.state.screens.current().scroll(true, 1);
                } else {
                    self.state.cursor.row = next_row;
                }
            }
            b'E' => {
                // NEL:下一行（CR + LF）
                self.state.cursor.col = 0;
                let next_row = self.state.cursor.row + 1;
                if next_row >= self.state.rows {
                    // 滚动（阶段 4：接入 Screen）
                    self.state.screens.current().scroll(true, 1);
                } else {
                    self.state.cursor.row = next_row;
                }
            }
            b'H' => {
                // HTS:设置制表位
                // 本阶段暂不实现制表位管理
            }
            b'M' => {
                // RI:反向索引（光标上移一行,可能反向滚动）
                if self.state.cursor.row > 0 {
                    self.state.cursor.row -= 1;
                }
            }
            b'Z' => {
                // DECID:识别终端（同 DA）
            }
            b'c' => {
                // RIS:复位（全复位）
                *self.state = TerminalState::default();
            }
            // 字符集选择（G0/G1）
            b'(' => {
                // G0 字符集选择（后续字节在中间字节中）
                // 本阶段暂不实现
            }
            b')' => {
                // G1 字符集选择
            }
            // 屏幕对齐显示（DECALN）
            b'#' => {
                // 中间字节是 '8',本阶段暂不实现
            }
            _ => {}
        }
    }
}

/// 计算字符宽度（ASCII/常见符号=1,CJK=2）
fn char_width(c: char) -> u32 {
    if c >= '\u{2e80}' && c <= '\u{9fff}' // CJK Unified Ideographs
        || c >= '\u{ac00}' && c <= '\u{d7af}' // Hangul
    {
        2
    } else {
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::escape::csi::ColorSpec;
    use crate::parser::vtparse::CsiParam;
    use crate::state::TerminalState;

    // 辅助:创建临时状态 + performer
    fn with_performer<F>(f: F)
    where
        F: FnOnce(&mut Performer),
    {
        let mut state = TerminalState::new();
        let mut performer = Performer::new(&mut state);
        f(&mut performer);
    }

    #[test]
    fn test_print_ascii() {
        with_performer(|p| {
            p.perform(Action::Print('h'));
            p.perform(Action::Print('i'));
            p.flush_print();
            // 光标右移了 2 格
            assert_eq!(p.state.cursor.col, 2);
            assert_eq!(p.state.cursor.row, 0);
        });
    }

    #[test]
    fn test_print_string() {
        with_performer(|p| {
            p.perform(Action::PrintString("hello".to_string()));
            p.flush_print();
            assert_eq!(p.state.cursor.col, 5);
        });
    }

    #[test]
    fn test_control_lf() {
        with_performer(|p| {
            p.perform(Action::Control(b'\n'));
            assert_eq!(p.state.cursor.row, 1);
            assert_eq!(p.state.cursor.col, 0);
        });
    }

    #[test]
    fn test_control_cr() {
        with_performer(|p| {
            p.state.cursor.col = 10;
            p.perform(Action::Control(b'\r'));
            assert_eq!(p.state.cursor.col, 0);
        });
    }

    #[test]
    fn test_control_bs() {
        with_performer(|p| {
            p.state.cursor.col = 5;
            p.perform(Action::Control(b'\x08'));
            assert_eq!(p.state.cursor.col, 4);
        });
    }

    #[test]
    fn test_control_ht() {
        with_performer(|p| {
            p.state.cursor.col = 1;
            p.perform(Action::Control(b'\t'));
            assert_eq!(p.state.cursor.col, 8);
        });
    }

    #[test]
    fn test_csi_cursor_up() {
        with_performer(|p| {
            p.state.cursor.row = 5;
            // CSI A → CUU 1
            let csi = crate::escape::csi::CSI::Cursor {
                dir: CursorMove::Up,
                n: 1,
            };
            // 直接通过 CSI 枚举调用 dispatch
            // 但我们的 csi_dispatch 是私有的...用 perform 路径
            // 改用 CsiDispatch action
            p.perform(Action::CsiDispatch {
                params: vec![],
                parameters_truncated: false,
                byte: b'A',
            });
            assert_eq!(p.state.cursor.row, 4);
        });
    }

    #[test]
    fn test_csi_cursor_down() {
        with_performer(|p| {
            p.perform(Action::CsiDispatch {
                params: vec![],
                parameters_truncated: false,
                byte: b'B',
            });
            assert_eq!(p.state.cursor.row, 1);
        });
    }

    #[test]
    fn test_csi_cursor_forward() {
        with_performer(|p| {
            p.perform(Action::CsiDispatch {
                params: vec![],
                parameters_truncated: false,
                byte: b'C',
            });
            assert_eq!(p.state.cursor.col, 1);
        });
    }

    #[test]
    fn test_csi_cursor_back() {
        with_performer(|p| {
            p.state.cursor.col = 3;
            p.perform(Action::CsiDispatch {
                params: vec![],
                parameters_truncated: false,
                byte: b'D',
            });
            assert_eq!(p.state.cursor.col, 2);
        });
    }

    #[test]
    fn test_csi_sgr_reset() {
        with_performer(|p| {
            p.state.pen.intensity = 1;
            p.state.pen.italic = true;
            // ESC [ 0 m → SGR reset
            p.perform(Action::CsiDispatch {
                params: vec![],
                parameters_truncated: false,
                byte: b'm',
            });
            assert_eq!(p.state.pen.intensity, 0);
            assert!(!p.state.pen.italic);
        });
    }

    #[test]
    fn test_csi_sgr_bold() {
        with_performer(|p| {
            // ESC [ 1 m → Bold
            // 使用 CsiParam 构建
            use crate::parser::vtparse::CsiParam;
            p.perform(Action::CsiDispatch {
                params: vec![CsiParam::Integer(1)],
                parameters_truncated: false,
                byte: b'm',
            });
            assert_eq!(p.state.pen.intensity, 1);
        });
    }

    #[test]
    fn test_dec_private_mode_bracketed_paste() {
        with_performer(|p| {
            // CSI ? 2004 h → set bracketed paste
            use crate::parser::vtparse::CsiParam;
            p.perform(Action::CsiDispatch {
                params: vec![CsiParam::P(b'?'), CsiParam::Integer(2004)],
                parameters_truncated: false,
                byte: b'h',
            });
            assert!(p.state.mode.contains(crate::state::modes::TermMode::BRACKETED_PASTE));
        });
    }

    #[test]
    fn test_osc_set_window_title() {
        with_performer(|p| {
            // OSC 2 ; title ST
            p.perform(Action::OscDispatch(vec![
                b"2".to_vec(),
                b"My Title".to_vec(),
            ]));
            assert_eq!(p.state.title, "My Title");
        });
    }

    #[test]
    fn test_osc_icon_title() {
        with_performer(|p| {
            // OSC 1 ; icon ST
            p.perform(Action::OscDispatch(vec![
                b"1".to_vec(),
                b"My Icon".to_vec(),
            ]));
            assert_eq!(p.state.icon_title.as_deref(), Some("My Icon"));
        });
    }

    #[test]
    fn test_perform_print_then_control() {
        with_performer(|p| {
            p.perform(Action::Print('a'));
            p.perform(Action::Control(b'\n'));
            p.flush_print();
            // flush_print 打印 'a' 后光标移到 col=1, LF 换行到 row=1
            assert_eq!(p.state.cursor.row, 1);
            assert_eq!(p.state.cursor.col, 1);
        });
    }

    #[test]
    fn test_perform_sgr_then_print() {
        with_performer(|p| {
            // ESC [ 1 ; 31 m → bold + red
            use crate::parser::vtparse::CsiParam;
            p.perform(Action::CsiDispatch {
                params: vec![
                    CsiParam::Integer(1),
                    CsiParam::P(b';'),
                    CsiParam::Integer(31),
                ],
                parameters_truncated: false,
                byte: b'm',
            });
            // 打印字符
            p.perform(Action::Print('X'));
            p.flush_print();
            // pen 应保留 bold + red
            assert_eq!(p.state.pen.intensity, 1);
            assert_eq!(p.state.pen.foreground, ColorSpec::Index(1));
        });
    }

    #[test]
    fn test_esc_application_keypad() {
        with_performer(|p| {
            // ESC = → DECKPAM
            p.perform(Action::EscDispatch {
                params: vec![],
                intermediates: vec![],
                ignored_excess_intermediates: false,
                byte: b'=',
            });
            assert!(p.state.mode.contains(crate::state::modes::TermMode::APPLICATION_KEYPAD));
        });
    }

    #[test]
    fn test_esc_normal_keypad() {
        with_performer(|p| {
            p.perform(Action::EscDispatch {
                params: vec![],
                intermediates: vec![],
                ignored_excess_intermediates: false,
                byte: b'>',
            });
            assert!(!p.state.mode.contains(crate::state::modes::TermMode::APPLICATION_KEYPAD));
        });
    }

    #[test]
    fn test_esc_ris_reset() {
        with_performer(|p| {
            p.state.title = "test".to_string();
            p.state.cursor.row = 5;
            // ESC c → RIS
            p.perform(Action::EscDispatch {
                params: vec![],
                intermediates: vec![],
                ignored_excess_intermediates: false,
                byte: b'c',
            });
            assert_eq!(p.state.title, "");
            assert_eq!(p.state.cursor.row, 0);
        });
    }

    #[test]
    fn test_synchronized_output_bsu() {
        with_performer(|p| {
            // CSI ? 2026 h → BSU
            use crate::parser::vtparse::CsiParam;
            p.perform(Action::CsiDispatch {
                params: vec![CsiParam::P(b'?'), CsiParam::Integer(2026)],
                parameters_truncated: false,
                byte: b'h',
            });
            assert!(p.state.is_in_synchronized_update());
        });
    }

    #[test]
    fn test_synchronized_output_esu() {
        with_performer(|p| {
            use crate::parser::vtparse::CsiParam;
            // BSU
            p.perform(Action::CsiDispatch {
                params: vec![CsiParam::P(b'?'), CsiParam::Integer(2026)],
                parameters_truncated: false,
                byte: b'h',
            });
            // ESU
            p.perform(Action::CsiDispatch {
                params: vec![CsiParam::P(b'?'), CsiParam::Integer(2026)],
                parameters_truncated: false,
                byte: b'l',
            });
            assert!(!p.state.is_in_synchronized_update());
        });
    }

    // ===== 阶段 4 端到端：字节流 → performer → screen buffer =====

    /// 辅助:读取当前光标位置的单元格文本
    fn cell_text(state: &TerminalState, col: usize, row: usize) -> String {
        state
            .screens
            .current_ref()
            .line(row)
            .expect("row exists")
            .cell(col)
            .map(|c| c.text.clone())
            .unwrap_or_default()
    }

    #[test]
    fn test_e2e_print_single_char_writes_screen() {
        with_performer(|p| {
            p.perform(Action::Print('A'));
            p.flush_print();
            assert_eq!(cell_text(p.state, 0, 0), "A");
            assert_eq!(p.state.cursor.col, 1);
        });
    }

    #[test]
    fn test_e2e_print_string_writes_screen() {
        with_performer(|p| {
            p.perform(Action::PrintString("Hello".to_string()));
            p.flush_print();
            assert_eq!(cell_text(p.state, 0, 0), "H");
            assert_eq!(cell_text(p.state, 1, 0), "e");
            assert_eq!(cell_text(p.state, 2, 0), "l");
            assert_eq!(cell_text(p.state, 3, 0), "l");
            assert_eq!(cell_text(p.state, 4, 0), "o");
            assert_eq!(p.state.cursor.col, 5);
        });
    }

    #[test]
    fn test_e2e_control_lf_moves_cursor_and_no_scroll() {
        with_performer(|p| {
            p.perform(Action::PrintString("AB".to_string()));
            p.flush_print();
            // LF:光标下移一行,不滚动（row 0 → row 1）
            p.perform(Action::Control(0x0A));
            assert_eq!(cell_text(p.state, 0, 0), "A");
            assert_eq!(cell_text(p.state, 1, 0), "B");
            assert_eq!(p.state.cursor.row, 1);
            assert_eq!(p.state.cursor.col, 2); // LF 不重置 col（CSI 风格）
        });
    }

    #[test]
    fn test_e2e_control_lf_at_bottom_row_triggers_scroll() {
        with_performer(|p| {
            // 默认 24 行,先把光标移到最后一行
            p.state.cursor.row = 23;
            p.perform(Action::Control(0x0A));
            // 滚动触发后光标行保持在最后一行
            assert_eq!(p.state.cursor.row, 23);
            // 屏幕滚动了一行,首行应变为空（原首行已推入回滚）
            assert_eq!(cell_text(p.state, 0, 0), "");
        });
    }

    #[test]
    fn test_e2e_control_cr_resets_col() {
        with_performer(|p| {
            p.perform(Action::PrintString("XYZ".to_string()));
            p.flush_print();
            assert_eq!(p.state.cursor.col, 3);
            p.perform(Action::Control(0x0D)); // CR
            assert_eq!(p.state.cursor.col, 0);
        });
    }

    #[test]
    fn test_e2e_control_bs_moves_back() {
        with_performer(|p| {
            p.perform(Action::PrintString("AB".to_string()));
            p.flush_print();
            p.perform(Action::Control(0x08)); // BS
            assert_eq!(p.state.cursor.col, 1);
        });
    }

    #[test]
    fn test_e2e_csi_erase_line_to_end() {
        with_performer(|p| {
            use crate::parser::vtparse::CsiParam;
            p.perform(Action::PrintString("Hello".to_string()));
            p.flush_print();
            // CHA col=2 (1-based → 0-based col=1),然后 EL 0（光标到行尾）
            p.perform(Action::CsiDispatch {
                params: vec![CsiParam::Integer(2)],
                parameters_truncated: false,
                byte: b'G', // CHA: col=2
            });
            p.perform(Action::CsiDispatch {
                params: vec![CsiParam::Integer(0)],
                parameters_truncated: false,
                byte: b'K', // EL 0
            });
            // col 0 应保留,col 1+ 应为空
            assert_eq!(cell_text(p.state, 0, 0), "H");
            assert_eq!(cell_text(p.state, 1, 0), "");
            assert_eq!(cell_text(p.state, 2, 0), "");
        });
    }

    #[test]
    fn test_e2e_csi_erase_display_all() {
        with_performer(|p| {
            use crate::parser::vtparse::CsiParam;
            p.perform(Action::PrintString("Hello".to_string()));
            p.flush_print();
            // ED 2:擦除全部
            p.perform(Action::CsiDispatch {
                params: vec![CsiParam::Integer(2)],
                parameters_truncated: false,
                byte: b'J',
            });
            assert_eq!(cell_text(p.state, 0, 0), "");
            assert_eq!(cell_text(p.state, 1, 0), "");
        });
    }

    #[test]
    fn test_e2e_csi_scroll_up() {
        with_performer(|p| {
            use crate::parser::vtparse::CsiParam;
            p.perform(Action::PrintString("Line0".to_string()));
            p.flush_print();
            p.perform(Action::Control(0x0A));
            p.perform(Action::PrintString("Line1".to_string()));
            p.flush_print();
            // SU 1:向上滚动 1 行
            p.perform(Action::CsiDispatch {
                params: vec![CsiParam::Integer(1)],
                parameters_truncated: false,
                byte: b'S',
            });
            // 原 row 0 内容应消失（已推入回滚）
            assert_eq!(cell_text(p.state, 0, 0), "");
        });
    }

    #[test]
    fn test_e2e_csi_insert_delete_lines() {
        with_performer(|p| {
            use crate::parser::vtparse::CsiParam;
            p.perform(Action::PrintString("Keep".to_string()));
            p.flush_print();
            // 移到 row 5,插入 2 行
            p.perform(Action::CsiDispatch {
                params: vec![CsiParam::Integer(6)],
                parameters_truncated: false,
                byte: b'd', // VPA: row=6 (1-based → 5)
            });
            p.perform(Action::CsiDispatch {
                params: vec![CsiParam::Integer(2)],
                parameters_truncated: false,
                byte: b'L', // IL 2
            });
            // 原 row 0 内容仍存在
            assert_eq!(cell_text(p.state, 0, 0), "K");
            // row 5,6 应为空（新插入的空行）
            assert_eq!(cell_text(p.state, 0, 5), "");
            assert_eq!(cell_text(p.state, 0, 6), "");
        });
    }

    #[test]
    fn test_e2e_csi_insert_delete_chars() {
        with_performer(|p| {
            use crate::parser::vtparse::CsiParam;
            p.perform(Action::PrintString("ABCDEF".to_string()));
            p.flush_print();
            // 光标到 col=2,ICH 2（插入 2 空字符）
            p.perform(Action::CsiDispatch {
                params: vec![CsiParam::Integer(3)],
                parameters_truncated: false,
                byte: b'G', // CHA col=3 (1-based → 2)
            });
            p.perform(Action::CsiDispatch {
                params: vec![CsiParam::Integer(2)],
                parameters_truncated: false,
                byte: b'@', // ICH 2
            });
            // col 0,1 保留,col 2,3 应为空（被插入的空字符挤过来）
            assert_eq!(cell_text(p.state, 0, 0), "A");
            assert_eq!(cell_text(p.state, 1, 0), "B");
            assert_eq!(cell_text(p.state, 2, 0), "");
            assert_eq!(cell_text(p.state, 3, 0), "");
            // DCH 2:删除 col 2,3 的字符,后续左移
            p.perform(Action::CsiDispatch {
                params: vec![CsiParam::Integer(2)],
                parameters_truncated: false,
                byte: b'P', // DCH 2
            });
            assert_eq!(cell_text(p.state, 2, 0), "C");
            assert_eq!(cell_text(p.state, 3, 0), "D");
        });
    }

    #[test]
    fn test_e2e_sgr_then_print_carries_pen() {
        with_performer(|p| {
            use crate::parser::vtparse::CsiParam;
            // SGR 1 (Bold) + 31 (Red)
            p.perform(Action::CsiDispatch {
                params: vec![CsiParam::Integer(1), CsiParam::Integer(31)],
                parameters_truncated: false,
                byte: b'm',
            });
            p.perform(Action::Print('Z'));
            p.flush_print();
            // 单元格应携带 Bold + Red 前景色
            let cell = p
                .state
                .screens
                .current_ref()
                .line(0)
                .expect("row exists")
                .cell(0)
                .expect("cell exists");
            assert_eq!(cell.intensity, 1); // Bold
            // Red = SGR 31 → ColorSpec::Index(1)
            assert_eq!(cell.foreground, crate::escape::csi::ColorSpec::Index(1));
        });
    }

    #[test]
    fn test_e2e_ind_at_bottom_triggers_scroll() {
        with_performer(|p| {
            p.state.cursor.row = 23;
            p.perform(Action::EscDispatch {
                params: vec![],
                intermediates: vec![],
                ignored_excess_intermediates: false,
                byte: b'D', // IND
            });
            assert_eq!(p.state.cursor.row, 23); // 滚动后保持在最后一行
        });
    }

    #[test]
    fn test_e2e_nel_at_bottom_triggers_scroll() {
        with_performer(|p| {
            p.perform(Action::PrintString("X".to_string()));
            p.flush_print();
            p.state.cursor.row = 23;
            p.perform(Action::EscDispatch {
                params: vec![],
                intermediates: vec![],
                ignored_excess_intermediates: false,
                byte: b'E', // NEL
            });
            assert_eq!(p.state.cursor.col, 0);
            assert_eq!(p.state.cursor.row, 23); // 滚动后保持
        });
    }
}