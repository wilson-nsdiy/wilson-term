//! Kitty keyboard 协议编码器
//!
//! 借鉴 wezterm `wezterm-input-types/src/lib.rs:1711` 的 `encode_kitty(flags)` 设计。
//!
//! 本模块提供键盘事件 → Kitty keyboard 协议序列的编码能力:
//! - `encode_kitty`:核心编码函数,把按键事件转为 CSI-u 序列
//! - `ModifierKeys`:修饰键位标记
//! - `KeyCode`:按键码枚举
//! - `KeyEvent`:键盘事件结构
//! - `KittyKeyboardFlags`:协议标志位管理
//!
//! 关键行为（参考 wezterm-input-types/src/lib.rs:1726-1731）:
//! - 开启 DISAMBIGUATE_ESCAPE_CODES 时,ESC 键不能作为原始 \x1b 发送,
//!   必须走 CSI 27;1 u 路径（Ink/Bubble Tea 快捷键体验的关键细节）

/// 修饰键位标记
///
/// 对应 Kitty keyboard 协议中 modifiers 字段的 bit 位:
/// - SHIFT = 1
/// - ALT = 2
/// - CTRL = 4
/// - SUPER (Win/Cmd) = 8
/// - CAPS_LOCK = 64
/// - NUM_LOCK = 128
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Modifiers(u8);

impl Modifiers {
    pub const NONE: Self = Self(0);
    pub const SHIFT: Self = Self(1);
    pub const ALT: Self = Self(2);
    pub const CTRL: Self = Self(4);
    pub const SUPER: Self = Self(8);
    pub const CAPS_LOCK: Self = Self(64);
    pub const NUM_LOCK: Self = Self(128);

    pub const fn from_bits(bits: u8) -> Self {
        Self(bits)
    }

    pub const fn bits(self) -> u8 {
        self.0
    }

    pub const fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }

    pub const fn is_empty(self) -> bool {
        self.0 == 0
    }
}

impl core::ops::BitOr for Modifiers {
    type Output = Self;
    #[inline(always)]
    fn bitor(self, rhs: Self) -> Self {
        Self(self.0 | rhs.0)
    }
}

/// Kitty keyboard 协议标志位
///
/// 复制自 `escape/csi.rs` 以避免 keyboard 模块依赖 escape 模块。
/// 保持一致:与 `escape/csi.rs::KittyKeyboardFlags` 相同的位布局。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct KittyKeyboardFlags(u8);

impl KittyKeyboardFlags {
    pub const NONE: Self = Self(0);
    pub const DISAMBIGUATE_ESCAPE_CODES: Self = Self(1);
    pub const REPORT_EVENT_TYPES: Self = Self(2);
    pub const REPORT_ALTERNATE_KEYS: Self = Self(4);
    pub const REPORT_ALL_KEYS_AS_ESCAPE_CODES: Self = Self(8);
    pub const REPORT_ASSOCIATED_TEXT: Self = Self(16);

    pub const fn from_bits(bits: u8) -> Self {
        Self(bits)
    }

    pub const fn bits(self) -> u8 {
        self.0
    }

    pub const fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }
}

/// 按键码
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyCode {
    /// 可见字符
    Char(char),
    /// 回车
    Enter,
    /// Tab
    Tab,
    /// Backspace
    Backspace,
    /// Escape
    Escape,
    /// 方向键
    Up,
    Down,
    Left,
    Right,
    /// 功能键
    F(u8),
    /// PageUp / PageDown
    PageUp,
    PageDown,
    /// Home / End
    Home,
    End,
    /// Insert / Delete
    Insert,
    Delete,
    /// 数字小键盘
    Numpad(u8),
}

/// 键盘事件
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyEvent {
    /// 按键码
    pub key: KeyCode,
    /// 修饰键位
    pub modifiers: Modifiers,
    /// 是否按下（false=释放）
    pub key_is_down: bool,
}

impl KeyEvent {
    pub fn new(key: KeyCode, modifiers: Modifiers) -> Self {
        Self {
            key,
            modifiers,
            key_is_down: true,
        }
    }

    pub fn new_release(key: KeyCode, modifiers: Modifiers) -> Self {
        Self {
            key,
            modifiers,
            key_is_down: false,
        }
    }
}

/// 编码 Kitty keyboard 协议序列
///
/// 借鉴 wezterm `encode_kitty`（lib.rs:1711-2030）:
///
/// 行为:
/// 1. 如果没有 REPORT_EVENT_TYPES 且按键已释放,返回空字符串
/// 2. 如果没有修饰键且没有 REPORT_ALL_KEYS_AS_ESCAPE_CODES,尝试简单文本输出
/// 3. 特殊:ESC 键在 DISAMBIGUATE_ESCAPE_CODES 时走 CSI-u 路径
/// 4. 常规 CSI-u 格式: `\x1b[<keycode>;<modifiers>u`
/// 5. 释放事件后缀: `\x1b[<keycode>;<modifiers>:3u`
pub fn encode_kitty(event: &KeyEvent, flags: &KittyKeyboardFlags) -> String {
    use KeyCode::*;

    // 不追踪释放事件时,释放事件不输出
    if !flags.contains(KittyKeyboardFlags::REPORT_EVENT_TYPES) && !event.key_is_down {
        return String::new();
    }

    // 无修饰键 + 无 REPORT_ALL 时,尝试简单文本输出
    if event.modifiers.is_empty()
        && !flags.contains(KittyKeyboardFlags::REPORT_ALL_KEYS_AS_ESCAPE_CODES)
        && event.key_is_down
    {
        match &event.key {
            Char('\x08') => return "\x7f".to_string(), // BS → DEL
            Char('\x7f') => return "\x08".to_string(), // DEL → BS
            // ESC 必须走 CSI-u 路径（核心兼容性修复）
            Char('\x1b') if flags.contains(KittyKeyboardFlags::DISAMBIGUATE_ESCAPE_CODES) => {}
            Escape if flags.contains(KittyKeyboardFlags::DISAMBIGUATE_ESCAPE_CODES) => {}
            Char(c) => return c.to_string(),
            Enter => return "\r".to_string(),
            Tab => return "\t".to_string(),
            Escape => return "\x1b".to_string(),
            _ => {}
        }
    }

    // 计算修饰键位（参考 wezterm: 先 bitwise OR,最后 +1）
    let mut mods = 0;
    if event.modifiers.contains(Modifiers::SHIFT) {
        mods |= 1;
    }
    if event.modifiers.contains(Modifiers::ALT) {
        mods |= 2;
    }
    if event.modifiers.contains(Modifiers::CTRL) {
        mods |= 4;
    }
    if event.modifiers.contains(Modifiers::SUPER) {
        mods |= 8;
    }
    mods += 1;

    // 释放事件后缀
    let event_type = if flags.contains(KittyKeyboardFlags::REPORT_EVENT_TYPES) && !event.key_is_down
    {
        ":3"
    } else {
        ""
    };

    // 按按键码类型分派
    let result = match &event.key {
        Char(c) => {
            let keycode = *c as u32;
            let use_legacy = !flags.contains(KittyKeyboardFlags::REPORT_ALTERNATE_KEYS)
                && event_type.is_empty()
                && (c.is_ascii_alphanumeric() || c.is_ascii_punctuation())
                && !(flags.contains(KittyKeyboardFlags::DISAMBIGUATE_ESCAPE_CODES)
                    && (event.modifiers.contains(Modifiers::CTRL)
                        || event.modifiers.contains(Modifiers::ALT)))
                && !event.modifiers.contains(Modifiers::SUPER);

            if use_legacy {
                // 传统文本键路径
                let mut output = String::new();
                if event.modifiers.contains(Modifiers::ALT) {
                    output.push('\x1b');
                }
                // 处理 Ctrl 组合
                if event.modifiers.contains(Modifiers::CTRL) {
                    match c {
                        'a'..='z' => {
                            let ctrl = (*c as u8 - b'a' + 1) as char;
                            output.push(ctrl);
                        }
                        _ => output.push(*c),
                    }
                } else {
                    output.push(*c);
                }
                return output;
            }

            format!("\x1b[{keycode};{mods}{event_type}u")
        }
        Enter => format!("\x1b[13;{mods}{event_type}u"),
        Tab => format!("\x1b[9;{mods}{event_type}u"),
        Backspace => format!("\x1b[127;{mods}{event_type}u"),
        Escape => format!("\x1b[27;{mods}{event_type}u"),
        Up => format!("\x1b[A"),
        Down => format!("\x1b[B"),
        Right => format!("\x1b[C"),
        Left => format!("\x1b[D"),
        Home => format!("\x1b[1;{mods}{event_type}H"),
        End => format!("\x1b[1;{mods}{event_type}F"),
        Insert => format!("\x1b[2;{mods}{event_type}~"),
        Delete => format!("\x1b[3;{mods}{event_type}~"),
        PageUp => format!("\x1b[5;{mods}{event_type}~"),
        PageDown => format!("\x1b[6;{mods}{event_type}~"),
        F(n) => format!("\x1b[{};{mods}{event_type}R", 10 + *n as u32),
        Numpad(n) => format!("\x1b[573{:02};{mods}{event_type}u", n),
    };

    result
}

/// 编码 Xterm 修饰键位（用于 modifyOtherKeys 等场景）
///
/// 返回 xterm 风格的修饰键位码:
/// - SHIFT=1, ALT=2, CTRL=4, SUPER=8
pub fn encode_xterm_modifiers(modifiers: Modifiers) -> u8 {
    let mut m = 0u8;
    if modifiers.contains(Modifiers::SHIFT) {
        m |= 1;
    }
    if modifiers.contains(Modifiers::ALT) {
        m |= 2;
    }
    if modifiers.contains(Modifiers::CTRL) {
        m |= 4;
    }
    if modifiers.contains(Modifiers::SUPER) {
        m |= 8;
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_simple_text_no_modifiers() {
        let event = KeyEvent::new(KeyCode::Char('a'), Modifiers::NONE);
        let flags = KittyKeyboardFlags::NONE;
        assert_eq!(encode_kitty(&event, &flags), "a");
    }

    #[test]
    fn test_ctrl_a_with_disambiguate() {
        let event = KeyEvent::new(KeyCode::Char('a'), Modifiers::CTRL);
        let flags = KittyKeyboardFlags::DISAMBIGUATE_ESCAPE_CODES;
        let result = encode_kitty(&event, &flags);
        // Ctrl+A → CSI 1;5 u (mods=1+4=5)
        assert_eq!(result, "\x1b[97;5u"); // 'a' is 97, mods=1+4=5
    }

    #[test]
    fn test_esc_with_disambiguate() {
        let event = KeyEvent::new(KeyCode::Escape, Modifiers::NONE);
        let flags = KittyKeyboardFlags::DISAMBIGUATE_ESCAPE_CODES;
        // ESC 必须走 CSI-u 路径,不能是原始 \x1b
        let result = encode_kitty(&event, &flags);
        assert_eq!(result, "\x1b[27;1u");
    }

    #[test]
    fn test_esc_raw_without_disambiguate() {
        let event = KeyEvent::new(KeyCode::Escape, Modifiers::NONE);
        let flags = KittyKeyboardFlags::NONE;
        // 没有 DISAMBIGUATE 时,ESC 走原始路径
        let result = encode_kitty(&event, &flags);
        assert_eq!(result, "\x1b");
    }

    #[test]
    fn test_ctrl_i_as_tab() {
        let event = KeyEvent::new(KeyCode::Tab, Modifiers::NONE);
        let flags = KittyKeyboardFlags::NONE;
        // 无修饰键时 Tab 走原始路径
        let result = encode_kitty(&event, &flags);
        assert_eq!(result, "\t");
    }

    #[test]
    fn test_ctrl_i_as_csi_u() {
        let event = KeyEvent::new(KeyCode::Tab, Modifiers::NONE);
        let flags = KittyKeyboardFlags::REPORT_ALL_KEYS_AS_ESCAPE_CODES;
        // REPORT_ALL 时,Tab 走 CSI-u
        let result = encode_kitty(&event, &flags);
        assert_eq!(result, "\x1b[9;1u");
    }

    #[test]
    fn test_release_event_suppressed() {
        let event = KeyEvent::new_release(KeyCode::Char('a'), Modifiers::NONE);
        let flags = KittyKeyboardFlags::NONE;
        // 没有 REPORT_EVENT_TYPES 时,释放事件不输出
        assert!(encode_kitty(&event, &flags).is_empty());
    }

    #[test]
    fn test_release_event_with_report() {
        let event = KeyEvent::new_release(KeyCode::Char('a'), Modifiers::NONE);
        let flags = KittyKeyboardFlags::REPORT_EVENT_TYPES;
        // REPORT_EVENT_TYPES 时,释放事件带 :3 后缀
        let result = encode_kitty(&event, &flags);
        assert_eq!(result, "\x1b[97;1:3u");
    }

    #[test]
    fn test_shift_enter() {
        let event = KeyEvent::new(KeyCode::Enter, Modifiers::SHIFT);
        let flags = KittyKeyboardFlags::REPORT_ALTERNATE_KEYS;
        // Shift+Enter → CSI 13;2 u (mods=1+1=2)
        let result = encode_kitty(&event, &flags);
        assert_eq!(result, "\x1b[13;2u");
    }

    #[test]
    fn test_ctrl_c() {
        let event = KeyEvent::new(KeyCode::Char('c'), Modifiers::CTRL);
        let flags = KittyKeyboardFlags::NONE;
        // Ctrl+C 无 DISAMBIGUATE 时走传统路径
        let result = encode_kitty(&event, &flags);
        assert_eq!(result, "\x03"); // C-c = 3
    }

    #[test]
    fn test_ctrl_c_with_disambiguate() {
        let event = KeyEvent::new(KeyCode::Char('c'), Modifiers::CTRL);
        let flags = KittyKeyboardFlags::DISAMBIGUATE_ESCAPE_CODES;
        let result = encode_kitty(&event, &flags);
        assert_eq!(result, "\x1b[99;5u"); // 'c' is 99, mods=1+4=5
    }

    #[test]
    fn test_arrow_keys() {
        let event = KeyEvent::new(KeyCode::Up, Modifiers::NONE);
        let flags = KittyKeyboardFlags::NONE;
        assert_eq!(encode_kitty(&event, &flags), "\x1b[A");
    }

    #[test]
    fn test_arrow_keys_with_ctrl() {
        let event = KeyEvent::new(KeyCode::Up, Modifiers::CTRL);
        let flags = KittyKeyboardFlags::NONE;
        // Ctrl+Up 无 Kitty 编码时走原始 CSI
        let result = encode_kitty(&event, &flags);
        assert_eq!(result, "\x1b[A");
    }

    #[test]
    fn test_function_keys() {
        let event = KeyEvent::new(KeyCode::F(1), Modifiers::NONE);
        let flags = KittyKeyboardFlags::NONE;
        assert_eq!(encode_kitty(&event, &flags), "\x1b[11;1R");
    }

    #[test]
    fn test_modifier_encoding() {
        let mods = Modifiers::SHIFT | Modifiers::CTRL;
        assert_eq!(mods.bits(), 5); // 1 + 4 = 5
    }

    #[test]
    fn test_xterm_modifiers() {
        assert_eq!(encode_xterm_modifiers(Modifiers::NONE), 0);
        assert_eq!(encode_xterm_modifiers(Modifiers::SHIFT), 1);
        assert_eq!(encode_xterm_modifiers(Modifiers::CTRL), 4);
        assert_eq!(
            encode_xterm_modifiers(Modifiers::SHIFT | Modifiers::CTRL),
            5
        );
    }

    #[test]
    fn test_backspace_special() {
        // BS 在无修饰键时映射为 DEL (\x7f)
        let event = KeyEvent::new(KeyCode::Char('\x08'), Modifiers::NONE);
        let flags = KittyKeyboardFlags::NONE;
        assert_eq!(encode_kitty(&event, &flags), "\x7f");
    }

    #[test]
    fn test_alt_letter() {
        let event = KeyEvent::new(KeyCode::Char('x'), Modifiers::ALT);
        let flags = KittyKeyboardFlags::NONE;
        // Alt+x 走传统路径: ESC + x
        let result = encode_kitty(&event, &flags);
        assert_eq!(result, "\x1b\x78");
    }
}