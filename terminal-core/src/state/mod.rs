//! 终端状态机应用层
//!
//! 借鉴 wezterm `term/src/terminalstate/mod.rs:247-395` 的 `TerminalState` 主结构,
//! 把 vtparse → escape 语义层产出的 `Action` 应用到本结构,驱动终端屏变化。
//!
//! 本模块是阶段 1.3 的第一步骨架:
//! - [`modes`]（已完成）:`TermMode` bitflags + DEC private mode 映射
//! - [`mod.rs`]（本文件）:`TerminalState` 主结构骨架 + 关键字段 + 基础访问器
//! - `performer.rs`（待办,阶段 1.3 第二步）:`impl VTActor for Performer`,
//!   把 `Action` 流应用到 `TerminalState`
//! - `screen/`（待办,阶段 1.3 第三步）:主屏/备屏 + 回滚 ring buffer
//!
//! 本阶段只定义结构 + 字段 + 基础 setter/getter,不实现具体应用逻辑。

pub mod modes;
pub mod performer;

use crate::escape::csi::{
    ColorSpec, DecPrivateModeCode, KittyKeyboardFlags, KittyKeyboardMode,
};
use modes::TermMode;

/// 鼠标编码方式（借鉴 wezterm `MouseEncoding`）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[repr(u8)]
pub enum MouseEncoding {
    /// X10 风格（默认）
    #[default]
    X10,
    /// UTF8 扩展（大屏坐标）
    Utf8,
    /// SGR（press=M / release=m 区分）
    Sgr,
    /// URXVT（1015 模式）
    Urxvt,
}

/// 光标样式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[repr(u8)]
pub enum CursorStyle {
    #[default]
    Block,
    Underline,
    Bar,
}

/// 单元格文本属性（SGR 当前生效的"画笔"状态）
///
/// 借鉴 wezterm `CellAttributes`,但只保留 TUI 程序常用项。
/// 具体字段在阶段 1.3 第二步（performer）随 SGR 应用逻辑充实。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CellAttributes {
    /// 亮度（Normal/Bold/Half）
    pub intensity: u8,
    /// 斜体
    pub italic: bool,
    /// 下划线样式（0=无 / 1=单 / 2=双 / 3=卷 / 4=点 / 5=虚）
    pub underline: u8,
    /// 闪烁（0=无 / 1=慢 / 2=快）
    pub blink: u8,
    /// 反色
    pub reverse: bool,
    /// 删除线
    pub strike: bool,
    /// 隐藏
    pub hidden: bool,
    /// 前景色
    pub foreground: ColorSpec,
    /// 背景色
    pub background: ColorSpec,
    /// 下划线颜色
    pub underline_color: ColorSpec,
}

/// 光标位置（0-based,行/列）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CursorPosition {
    pub row: u32,
    pub col: u32,
}

/// 终端状态主结构
///
/// 借鉴 wezterm `terminalstate/mod.rs:247-395`,但:
/// - 所有 DEC private mode + 终端开关集中到 [`mode`](#structfield.mode) bitflags
/// - 鼠标编码用 [`MouseEncoding`] 枚举而非散 bool
/// - 屏幕缓冲区（主屏/备屏 + 回滚）推迟到阶段 1.3 第三步的 `screen/` 子模块,
///   本阶段用占位字段 `alt_screen_active` 标记
/// - 不引入 wezterm 的 config/clipboard/handler 等运行时依赖,保持核心层纯数据
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalState {
    /// 屏幕列数（默认 80）
    pub cols: u32,
    /// 屏幕行数（默认 24）
    pub rows: u32,

    /// 所有 DEC private mode + 终端开关的位集合
    pub mode: TermMode,

    /// 当前"画笔"属性（下一个打印字符的属性）
    pub pen: CellAttributes,

    /// 光标位置（0-based,相对屏幕左上角）
    pub cursor: CursorPosition,

    /// 光标样式（Block/Underline/Bar）
    pub cursor_style: CursorStyle,

    /// `modifyOtherKeys` 状态（wezterm mod.rs:291）
    /// - `None`:默认
    /// - `Some(1)`:启用 mode 1
    /// - `Some(2)`:启用 mode 2
    pub modify_other_keys: Option<i64>,

    /// Kitty keyboard 协议当前 flags（wezterm `KittyKeyboardFlags`）
    pub kitty_keyboard_flags: KittyKeyboardFlags,

    /// 鼠标编码方式
    pub mouse_encoding: MouseEncoding,

    /// 终端标题（OSC 2）
    pub title: String,
    /// 图标标题（OSC 1）
    pub icon_title: Option<String>,

    /// 备用屏幕是否激活（wezterm mod.rs:1673-1677）
    ///
    /// 具体的主屏/备屏缓冲区在 `screen/` 子模块（待办）实现,
    /// 本字段先记录激活状态,供 performer 在 DEC 47/1047/1049 时切换。
    pub alt_screen_active: bool,

    /// 同步更新（BSU/ESU）的起始时间戳
    ///
    /// `mode.contains(TermMode::SYNCHRONIZED_OUTPUT)` 为真时,本字段记录 BSU 时刻;
    /// 渲染层据此实现「ESU 后立即 flush / BSU 后 200ms 超时强制 flush」逻辑
    /// （IMPLEMENTATION-GUIDELINE §2.3 + §10.4）。
    /// 用 `Option<u64>`（毫秒级单调时钟）而非 `Instant`,避免核心层依赖 `std::time`。
    pub synced_update_started_at: Option<u64>,
}

impl Default for TerminalState {
    fn default() -> Self {
        // 借鉴 wezterm `TerminalState::new` 的初始状态
        Self {
            cols: 80,
            rows: 24,
            mode: TermMode::AUTO_WRAP              // DEC 7 默认开
                | TermMode::CURSOR_VISIBLE,        // DEC 25 默认开
            // WRAP_NEXT 默认 false,仅当字符打印到行尾后置 true
            pen: CellAttributes::default(),
            cursor: CursorPosition::default(),
            cursor_style: CursorStyle::default(),
            modify_other_keys: None,
            kitty_keyboard_flags: KittyKeyboardFlags::default(),
            mouse_encoding: MouseEncoding::default(),
            title: String::new(),
            icon_title: None,
            alt_screen_active: false,
            synced_update_started_at: None,
        }
    }
}

impl TerminalState {
    /// 创建默认状态的终端
    pub fn new() -> Self {
        Self::default()
    }

    // ── DEC private mode set/reset/query ──
    // 借鉴 wezterm `terminalstate/mod.rs:1663+` 的 set/reset 分派

    /// 设置 DEC private mode（CSI ? N h）
    pub fn set_dec_private_mode(&mut self, code: DecPrivateModeCode) {
        let bit = modes::dec_private_mode_to_term_mode(code);
        self.mode.insert(bit);
        // SynchronizedOutput 的 BSU 入口:记录起始时间戳
        // 具体时钟由运行时（Tauri / 渲染层）注入,本核心层只置位
        if code == DecPrivateModeCode::SynchronizedOutput && self.synced_update_started_at.is_none() {
            // 用 0 占位,实际时刻由上层在 BSU 时覆写
            self.synced_update_started_at = Some(0);
        }
    }

    /// 重置 DEC private mode（CSI ? N l）
    pub fn reset_dec_private_mode(&mut self, code: DecPrivateModeCode) {
        let bit = modes::dec_private_mode_to_term_mode(code);
        self.mode.remove(bit);
        // SynchronizedOutput 的 ESU 入口:清时间戳
        if code == DecPrivateModeCode::SynchronizedOutput {
            self.synced_update_started_at = None;
        }
    }

    /// 查询 DEC private mode（CSI ? N $ p）→ 返回 1 / 0
    pub fn query_dec_private_mode(&self, code: DecPrivateModeCode) -> u8 {
        let bit = modes::dec_private_mode_to_term_mode(code);
        if self.mode.contains(bit) { 1 } else { 0 }
    }

    // ── Kitty keyboard ──

    /// 应用 Kitty keyboard 模式操作
    pub fn apply_kitty_keyboard(&mut self, op: KittyKeyboardMode, flags: KittyKeyboardFlags) {
        use KittyKeyboardMode::*;
        match op {
            AssignAll => self.kitty_keyboard_flags = flags,
            SetSpecified => {
                self.kitty_keyboard_flags |= flags;
            }
            ClearSpecified => {
                self.kitty_keyboard_flags -= flags;
            }
        }
    }

    // ── 标题 ──

    /// 设置窗口标题（OSC 2 / OSC 0）
    pub fn set_title(&mut self, title: String) {
        self.title = title;
    }

    /// 设置图标名（OSC 1）
    pub fn set_icon_title(&mut self, title: String) {
        self.icon_title = Some(title);
    }

    // ── 同步更新（BSU/ESU）辅助 ──

    /// 是否处于同步更新（BSU）中
    pub fn is_in_synchronized_update(&self) -> bool {
        self.mode.contains(TermMode::SYNCHRONIZED_OUTPUT)
    }

    /// 渲染层应在 ESU 收到后调本方法,清同步状态
    pub fn end_synchronized_update(&mut self) {
        self.reset_dec_private_mode(DecPrivateModeCode::SynchronizedOutput);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::escape::csi::DecPrivateModeCode;

    #[test]
    fn test_default_state() {
        let s = TerminalState::default();
        // 默认开:auto wrap + cursor visible
        assert!(s.mode.contains(TermMode::AUTO_WRAP));
        assert!(s.mode.contains(TermMode::CURSOR_VISIBLE));
        // WRAP_NEXT 默认 false,仅当字符打印到行尾后置 true
        assert!(!s.mode.contains(TermMode::WRAP_NEXT));
        // 默认关:bracketed paste / focus / mouse
        assert!(!s.mode.contains(TermMode::BRACKETED_PASTE));
        assert!(!s.mode.contains(TermMode::FOCUS_TRACKING));
        assert!(!s.mode.contains(TermMode::MOUSE_TRACKING));
        // 默认无同步更新
        assert!(!s.is_in_synchronized_update());
        assert_eq!(s.synced_update_started_at, None);
    }

    #[test]
    fn test_dec_private_mode_set_reset_query() {
        let mut s = TerminalState::new();
        // set bracketed paste
        s.set_dec_private_mode(DecPrivateModeCode::BracketedPaste);
        assert!(s.mode.contains(TermMode::BRACKETED_PASTE));
        assert_eq!(s.query_dec_private_mode(DecPrivateModeCode::BracketedPaste), 1);
        // reset
        s.reset_dec_private_mode(DecPrivateModeCode::BracketedPaste);
        assert!(!s.mode.contains(TermMode::BRACKETED_PASTE));
        assert_eq!(s.query_dec_private_mode(DecPrivateModeCode::BracketedPaste), 0);
    }

    #[test]
    fn test_synchronized_output_bsu_esu() {
        let mut s = TerminalState::new();
        // BSU: CSI ? 2026 h
        s.set_dec_private_mode(DecPrivateModeCode::SynchronizedOutput);
        assert!(s.is_in_synchronized_update());
        assert!(s.synced_update_started_at.is_some());
        // ESU: CSI ? 2026 l
        s.end_synchronized_update();
        assert!(!s.is_in_synchronized_update());
        assert_eq!(s.synced_update_started_at, None);
    }

    #[test]
    fn test_kitty_keyboard_assign_all() {
        let mut s = TerminalState::new();
        let flags = KittyKeyboardFlags::DISAMBIGUATE_ESCAPE_CODES
            | KittyKeyboardFlags::REPORT_EVENT_TYPES;
        s.apply_kitty_keyboard(KittyKeyboardMode::AssignAll, flags);
        assert!(s.kitty_keyboard_flags.contains(KittyKeyboardFlags::DISAMBIGUATE_ESCAPE_CODES));
        assert!(s.kitty_keyboard_flags.contains(KittyKeyboardFlags::REPORT_EVENT_TYPES));
    }

    #[test]
    fn test_kitty_keyboard_set_clear_specified() {
        let mut s = TerminalState::new();
        // 先 assign 全部为 0
        s.apply_kitty_keyboard(KittyKeyboardMode::AssignAll, KittyKeyboardFlags::default());
        // set specified:加 DISAMBIGUATE
        s.apply_kitty_keyboard(
            KittyKeyboardMode::SetSpecified,
            KittyKeyboardFlags::DISAMBIGUATE_ESCAPE_CODES,
        );
        assert!(s.kitty_keyboard_flags.contains(KittyKeyboardFlags::DISAMBIGUATE_ESCAPE_CODES));
        // clear specified:移除 DISAMBIGUATE
        s.apply_kitty_keyboard(
            KittyKeyboardMode::ClearSpecified,
            KittyKeyboardFlags::DISAMBIGUATE_ESCAPE_CODES,
        );
        assert!(!s.kitty_keyboard_flags.contains(KittyKeyboardFlags::DISAMBIGUATE_ESCAPE_CODES));
    }

    #[test]
    fn test_title_setters() {
        let mut s = TerminalState::new();
        s.set_title("My Window".to_string());
        assert_eq!(s.title, "My Window");
        s.set_icon_title("My Icon".to_string());
        assert_eq!(s.icon_title.as_deref(), Some("My Icon"));
    }

    #[test]
    fn test_alt_screen_default_off() {
        let s = TerminalState::new();
        assert!(!s.alt_screen_active);
        assert!(!s.mode.contains(TermMode::ALT_SCREEN_ACTIVE));
    }
}
