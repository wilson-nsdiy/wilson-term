//! 终端模式标志位（TermMode bitflags）
//!
//! 借鉴 wezterm `term/src/terminalstate/mod.rs:247-395` 的 TerminalState 字段管理,
//! 但把所有 DEC private mode + 终端开关集中到一个 bitflags 里,方便集中管理、
//! 整体快照、并发无锁读取。
//!
//! 对齐本 crate `escape/csi.rs::DecPrivateModeCode` 枚举的编号覆盖:
//! - CursorKeysMode(1) / DecAnsiMode(2) / OriginMode(6) / AutoWrap(7) / AutoRepeat(8)
//! - CursorVisible(25)
//! - MouseTracking(1000) / ButtonEventMouse(1002) / AnyEventMouse(1003)
//! - FocusTracking(1004) / Utf8MouseMode(1005) / SgrMouseMode(1006)
//! - BracketedPaste(2004) / SynchronizedOutput(2026) / GraphemeClusters(2027)
//!
//! 借鉴的 wezterm 字段（mod.rs:260-322）:
//! - wrap_next / insert / dec_auto_wrap / reverse_wraparound_mode
//! - reverse_video_mode / dec_origin_mode / application_cursor_keys
//! - application_keypad / bracketed_paste / focus_tracking
//! - mouse_tracking / button_event_mouse / any_event_mouse / cursor_visible

/// 终端模式标志位集合
///
/// 用 `u64` 作为底层整数,以容纳全部 DEC private mode + 终端开关。
/// 本阶段（1.3 第一步）只定义位 + 基础集合操作,具体应用到 `TerminalState`
/// 在 `performer.rs`（阶段 1.3 第二步）实现。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TermMode(u64);

impl TermMode {
    // ── DEC private mode（CSI ? N h / l）──
    /// DEC 1:光标键模式（Application Cursor Keys）
    pub const CURSOR_KEYS_MODE: Self = Self(1 << 0);
    /// DEC 2:ANSI 模式
    pub const DEC_ANSI_MODE: Self = Self(1 << 1);
    /// DEC 6:Origin Mode（光标限制在滚动区内）
    pub const ORIGIN_MODE: Self = Self(1 << 2);
    /// DEC 7:Auto Wrap（行尾自动换行）
    pub const AUTO_WRAP: Self = Self(1 << 3);
    /// DEC 8:Auto Repeat（按键自动重复）
    pub const AUTO_REPEAT: Self = Self(1 << 4);
    /// DEC 25:光标可见
    pub const CURSOR_VISIBLE: Self = Self(1 << 5);

    // ── 鼠标 ──
    /// DEC 1000:鼠标追踪（X10 风格）
    pub const MOUSE_TRACKING: Self = Self(1 << 6);
    /// DEC 1001:HiLite 鼠标追踪
    pub const HILITE_MOUSE_TRACKING: Self = Self(1 << 7);
    /// DEC 1002:按钮事件鼠标追踪
    pub const BUTTON_EVENT_MOUSE: Self = Self(1 << 8);
    /// DEC 1003:任意事件鼠标追踪
    pub const ANY_EVENT_MOUSE: Self = Self(1 << 9);
    /// DEC 1005:UTF8 鼠标编码
    pub const UTF8_MOUSE_MODE: Self = Self(1 << 10);
    /// DEC 1006:SGR 鼠标编码
    pub const SGR_MOUSE_MODE: Self = Self(1 << 11);
    /// DEC 1015:URXVT 鼠标编码
    pub const URXVT_MOUSE_MODE: Self = Self(1 << 12);
    /// DEC 1016:Sixel 鼠标模式
    pub const SIXEL_MOUSE_MODE: Self = Self(1 << 13);

    // ── 焦点 / 粘贴 / 同步 ──
    /// DEC 1004:焦点追踪
    pub const FOCUS_TRACKING: Self = Self(1 << 14);
    /// DEC 2004:Bracketed Paste
    pub const BRACKETED_PASTE: Self = Self(1 << 15);
    /// DEC 2024:Sync Timeout（渲染超时）
    pub const SYNC_TIMEOUT: Self = Self(1 << 16);
    /// DEC 2026:Synchronized Output（BSU/ESU 同步更新）
    pub const SYNCHRONIZED_OUTPUT: Self = Self(1 << 17);
    /// DEC 2027:Grapheme Clusters（unicode 版本控制）
    pub const GRAPHEME_CLUSTERS: Self = Self(1 << 18);

    // ── 终端开关（wezterm TerminalState 散落 bool 字段集中化）──
    /// 行尾自动换行（wrap_next,wezterm mod.rs:260）
    pub const WRAP_NEXT: Self = Self(1 << 19);
    /// 写字符时插入而非覆盖（insert,wezterm mod.rs:265）
    pub const INSERT: Self = Self(1 << 20);
    /// 反向换行（reverse_wraparound_mode,wezterm mod.rs:271）
    pub const REVERSE_WRAPAROUND: Self = Self(1 << 21);
    /// 反色显示（reverse_video_mode,wezterm mod.rs:274）
    pub const REVERSE_VIDEO: Self = Self(1 << 22);
    /// 应用键盘（application_keypad,wezterm mod.rs:305）
    pub const APPLICATION_KEYPAD: Self = Self(1 << 23);
    /// 新行模式（newline_mode,wezterm mod.rs:330）
    pub const NEWLINE_MODE: Self = Self(1 << 24);
    /// 备用屏幕激活
    pub const ALT_SCREEN_ACTIVE: Self = Self(1 << 25);

    /// 空集
    pub const NONE: Self = Self(0);

    /// 从原始位构造
    #[inline(always)]
    pub const fn from_bits(bits: u64) -> Self {
        Self(bits)
    }

    /// 取底层位
    #[inline(always)]
    pub const fn bits(self) -> u64 {
        self.0
    }

    /// 是否包含 other 的全部位
    #[inline(always)]
    pub const fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }

    /// 是否包含 other 的任意位
    #[inline(always)]
    pub const fn intersects(self, other: Self) -> bool {
        self.0 & other.0 != 0
    }

    /// 集合合并
    #[inline(always)]
    pub const fn union(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }

    /// 集合差（self 中去掉 other 也有的位）
    #[inline(always)]
    pub const fn difference(self, other: Self) -> Self {
        Self(self.0 & !other.0)
    }

    /// 插入位（原地修改）
    #[inline(always)]
    pub fn insert(&mut self, other: Self) {
        self.0 |= other.0;
    }

    /// 移除位（原地修改）
    #[inline(always)]
    pub fn remove(&mut self, other: Self) {
        self.0 &= !other.0;
    }

    /// 切换位（原地修改）
    #[inline(always)]
    pub fn toggle(&mut self, other: Self) {
        self.0 ^= other.0;
    }

    /// 是否为空集
    #[inline(always)]
    pub const fn is_empty(self) -> bool {
        self.0 == 0
    }
}

impl core::ops::BitOr for TermMode {
    type Output = Self;
    #[inline(always)]
    fn bitor(self, rhs: Self) -> Self {
        self.union(rhs)
    }
}

impl core::ops::BitOrAssign for TermMode {
    #[inline(always)]
    fn bitor_assign(&mut self, rhs: Self) {
        self.insert(rhs);
    }
}

impl core::ops::BitAnd for TermMode {
    type Output = Self;
    #[inline(always)]
    fn bitand(self, rhs: Self) -> Self {
        Self(self.0 & rhs.0)
    }
}

impl core::ops::BitAndAssign for TermMode {
    #[inline(always)]
    fn bitand_assign(&mut self, rhs: Self) {
        self.0 &= rhs.0;
    }
}

impl core::ops::Sub for TermMode {
    type Output = Self;
    #[inline(always)]
    fn sub(self, rhs: Self) -> Self {
        self.difference(rhs)
    }
}

impl core::ops::Not for TermMode {
    type Output = Self;
    #[inline(always)]
    fn not(self) -> Self {
        Self(!self.0)
    }
}

/// DEC private mode 编号 → TermMode 位映射
///
/// 借鉴 wezterm `terminalstate/mod.rs:1663+` 的 set/reset 分派逻辑,
/// 但用静态映射表替代其长串 match,便于扩展。
///
/// 返回 `None` 表示未识别的 DEC private mode 编号,调用方应按 Unknown 处理。
pub fn dec_private_mode_to_term_mode(code: crate::escape::csi::DecPrivateModeCode) -> TermMode {
    use crate::escape::csi::DecPrivateModeCode::*;
    match code {
        CursorKeysMode => TermMode::CURSOR_KEYS_MODE,
        DecAnsiMode => TermMode::DEC_ANSI_MODE,
        OriginMode => TermMode::ORIGIN_MODE,
        AutoWrap => TermMode::AUTO_WRAP,
        AutoRepeat => TermMode::AUTO_REPEAT,
        CursorVisible => TermMode::CURSOR_VISIBLE,
        MouseTracking => TermMode::MOUSE_TRACKING,
        HiliteMouseTracking => TermMode::HILITE_MOUSE_TRACKING,
        ButtonEventMouse => TermMode::BUTTON_EVENT_MOUSE,
        AnyEventMouse => TermMode::ANY_EVENT_MOUSE,
        FocusTracking => TermMode::FOCUS_TRACKING,
        Utf8MouseMode => TermMode::UTF8_MOUSE_MODE,
        SgrMouseMode => TermMode::SGR_MOUSE_MODE,
        UrxvtMouseMode => TermMode::URXVT_MOUSE_MODE,
        SixelMouseMode => TermMode::SIXEL_MOUSE_MODE,
        BracketedPaste => TermMode::BRACKETED_PASTE,
        SyncTimeout => TermMode::SYNC_TIMEOUT,
        SynchronizedOutput => TermMode::SYNCHRONIZED_OUTPUT,
        GraphemeClusters => TermMode::GRAPHEME_CLUSTERS,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty_and_default() {
        assert!(TermMode::NONE.is_empty());
        assert!(TermMode::default().is_empty());
    }

    #[test]
    fn test_contains_and_intersects() {
        let m = TermMode::BRACKETED_PASTE | TermMode::FOCUS_TRACKING;
        assert!(m.contains(TermMode::BRACKETED_PASTE));
        assert!(m.contains(TermMode::FOCUS_TRACKING));
        assert!(!m.contains(TermMode::AUTO_WRAP));
        assert!(m.intersects(TermMode::FOCUS_TRACKING | TermMode::AUTO_WRAP));
        assert!(!m.intersects(TermMode::AUTO_WRAP));
    }

    #[test]
    fn test_union_difference() {
        let a = TermMode::BRACKETED_PASTE;
        let b = TermMode::FOCUS_TRACKING;
        let u = a | b;
        assert!(u.contains(a));
        assert!(u.contains(b));
        let d = u - b;
        assert!(d.contains(a));
        assert!(!d.contains(b));
    }

    #[test]
    fn test_insert_remove_toggle() {
        let mut m = TermMode::NONE;
        m.insert(TermMode::BRACKETED_PASTE);
        assert!(m.contains(TermMode::BRACKETED_PASTE));
        m.toggle(TermMode::BRACKETED_PASTE);
        assert!(!m.contains(TermMode::BRACKETED_PASTE));
        m.toggle(TermMode::BRACKETED_PASTE);
        assert!(m.contains(TermMode::BRACKETED_PASTE));
        m.remove(TermMode::BRACKETED_PASTE);
        assert!(!m.contains(TermMode::BRACKETED_PASTE));
    }

    #[test]
    fn test_bit_ops() {
        let m = !TermMode::NONE;
        // NOT 会把所有位都置 1,包括未定义位;这是预期行为
        assert!(!m.is_empty());

        let a = TermMode::AUTO_WRAP & TermMode::AUTO_WRAP;
        assert_eq!(a, TermMode::AUTO_WRAP);

        let b = TermMode::AUTO_WRAP & TermMode::FOCUS_TRACKING;
        assert!(b.is_empty());
    }

    #[test]
    fn test_dec_private_mode_mapping() {
        use crate::escape::csi::DecPrivateModeCode;
        let m = dec_private_mode_to_term_mode(DecPrivateModeCode::BracketedPaste);
        assert_eq!(m, TermMode::BRACKETED_PASTE);

        let m = dec_private_mode_to_term_mode(DecPrivateModeCode::SynchronizedOutput);
        assert_eq!(m, TermMode::SYNCHRONIZED_OUTPUT);

        let m = dec_private_mode_to_term_mode(DecPrivateModeCode::FocusTracking);
        assert_eq!(m, TermMode::FOCUS_TRACKING);

        let m = dec_private_mode_to_term_mode(DecPrivateModeCode::SgrMouseMode);
        assert_eq!(m, TermMode::SGR_MOUSE_MODE);
    }

    #[test]
    fn test_dec_private_mode_all_mapped() {
        // 确保所有 DecPrivateModeCode 枚举成员都有对应 TermMode 位
        use crate::escape::csi::DecPrivateModeCode;
        for code in [
            DecPrivateModeCode::CursorKeysMode,
            DecPrivateModeCode::DecAnsiMode,
            DecPrivateModeCode::OriginMode,
            DecPrivateModeCode::AutoWrap,
            DecPrivateModeCode::AutoRepeat,
            DecPrivateModeCode::CursorVisible,
            DecPrivateModeCode::MouseTracking,
            DecPrivateModeCode::HiliteMouseTracking,
            DecPrivateModeCode::ButtonEventMouse,
            DecPrivateModeCode::AnyEventMouse,
            DecPrivateModeCode::FocusTracking,
            DecPrivateModeCode::Utf8MouseMode,
            DecPrivateModeCode::SgrMouseMode,
            DecPrivateModeCode::UrxvtMouseMode,
            DecPrivateModeCode::SixelMouseMode,
            DecPrivateModeCode::BracketedPaste,
            DecPrivateModeCode::SyncTimeout,
            DecPrivateModeCode::SynchronizedOutput,
            DecPrivateModeCode::GraphemeClusters,
        ] {
            let m = dec_private_mode_to_term_mode(code);
            // 不为空集说明映射成功
            assert!(!m.is_empty(), "code {:?} 映射到空集", code);
        }
    }
}
