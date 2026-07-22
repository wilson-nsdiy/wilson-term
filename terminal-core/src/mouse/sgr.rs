//! 鼠标编码器
//!
//! 借鉴 wezterm `term/src/terminalstate/mouse.rs`（364 行）的四种编码实现:
//! - X10:最简,`CSI M <btn+32> <x+32> <y+32>`
//! - UTF8:坐标用 UTF-8 编码（大屏坐标）
//! - SGR: `CSI < btn ; col ; row M/m`（按/释区分）
//! - URXVT:1015 模式,`CSI <btn+32> ; <col> ; <row> M`
//!
//! 关键细节（来自 wezterm `mouse.rs:148,196,272` 分支）:
//! - Press 用大写 M,Release 用小写 m（写反会导致 fzf/lazygit 点击失效）
//! - 按钮编号:Left=0,Middle=1,Right=2,Release=3,WheelUp=64,WheelDown=65
//! - 修饰键:SHIFT+=4,ALT+=8,CTRL+=16

/// 鼠标按钮
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MouseButton {
    #[default]
    None,
    Left,
    Middle,
    Right,
    WheelUp,
    WheelDown,
    WheelLeft,
    WheelRight,
}

/// 鼠标编码方式
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

/// 鼠标事件
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MouseEvent {
    /// 按钮
    pub button: MouseButton,
    /// 列（1-based）
    pub col: u16,
    /// 行（1-based）
    pub row: u16,
    /// 修饰键位
    pub modifiers: Modifiers,
    /// 是否按下
    pub is_press: bool,
}

/// 修饰键位（与 keyboard/kitty.rs 保持一致）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Modifiers(u8);

impl Modifiers {
    pub const NONE: Self = Self(0);
    pub const SHIFT: Self = Self(1);
    pub const ALT: Self = Self(2);
    pub const CTRL: Self = Self(4);
    pub const SUPER: Self = Self(8);

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

impl core::ops::BitOr for Modifiers {
    type Output = Self;
    #[inline(always)]
    fn bitor(self, rhs: Self) -> Self {
        Self(self.0 | rhs.0)
    }
}

/// 计算鼠标按钮编号（含修饰键偏移）
///
/// 借鉴 wezterm `mouse_report_button_number`（mouse.rs:43-74）:
/// - 按钮编号:Left=0,Middle=1,Right=2,Release=3,WheelUp=64,WheelDown=65
/// - 修饰键偏移:SHIFT+=4,ALT+=8,CTRL+=16
fn mouse_button_number(button: MouseButton, modifiers: Modifiers) -> u8 {
    let mut code = match button {
        MouseButton::None => 3,
        MouseButton::Left => 0,
        MouseButton::Middle => 1,
        MouseButton::Right => 2,
        MouseButton::WheelUp => 64,
        MouseButton::WheelDown => 65,
        MouseButton::WheelLeft => 66,
        MouseButton::WheelRight => 67,
    };

    if modifiers.contains(Modifiers::SHIFT) {
        code += 4;
    }
    if modifiers.contains(Modifiers::ALT) {
        code += 8;
    }
    if modifiers.contains(Modifiers::CTRL) {
        code += 16;
    }

    code
}

/// 编码坐标（X10 或 SGR 风格）
///
/// X10/URXVT:坐标 = 1-based + 32（偏移到可打印字符区）
/// SGR:坐标直接输出 1-based 数字
fn encode_coord(coord: u16) -> u8 {
    ((coord as i16 + 32) as u8).max(32)
}

/// 编码鼠标事件为 SGR 序列
///
/// 借鉴 wezterm `mouse.rs:148,196,272` 分支:
/// - Press: `CSI < btn ; col ; row M`（大写 M）
/// - Release: `CSI < btn ; col ; row m`（小写 m）
/// - 关键:M/m 不能写反,否则 fzf / lazygit 的点击交互失效
pub fn encode_sgr(event: &MouseEvent) -> String {
    let btn = mouse_button_number(event.button, event.modifiers);
    let terminator = if event.is_press { 'M' } else { 'm' };
    format!("\x1b[<{};{};{}{}", btn, event.col, event.row, terminator)
}

/// 编码鼠标事件为 X10 序列
///
/// 格式: `CSI M <btn+32> <x+32> <y+32>`
/// 坐标 = 1-based + 32（偏移到可打印字符区）
pub fn encode_x10(event: &MouseEvent) -> String {
    let btn = mouse_button_number(event.button, event.modifiers);
    let btn = if event.is_press { btn } else { 3 }; // Release=3
    let x = encode_coord(event.col);
    let y = encode_coord(event.row);
    format!("\x1b[M{}{}{}", (32 + btn) as u8 as char, x as char, y as char)
}

/// 编码鼠标事件为 UTF8 序列
///
/// 格式: `CSI M <btn+32> <utf8(x)> <utf8(y)>`
/// 坐标用 UTF-8 编码,支持大屏幕坐标（> 223 列）
pub fn encode_utf8(event: &MouseEvent) -> String {
    let btn = mouse_button_number(event.button, event.modifiers);
    let btn = if event.is_press { btn } else { 3 };

    // 坐标 UTF-8 编码
    let x = utf8_encode_coord(event.col);
    let y = utf8_encode_coord(event.row);

    format!("\x1b[M{}{}{}", (32 + btn) as u8 as char, x, y)
}

/// 将坐标编码为 UTF-8 字符串
fn utf8_encode_coord(coord: u16) -> String {
    let value = coord as u32 + 32;
    if value < 0x80 {
        String::from_utf8_lossy(&[value as u8]).to_string()
    } else if value < 0x800 {
        let b0 = 0xC0 | ((value >> 6) & 0x1F) as u8;
        let b1 = 0x80 | (value & 0x3F) as u8;
        String::from_utf8_lossy(&[b0, b1]).to_string()
    } else {
        // 超出范围,返回 0
        String::from_utf8_lossy(&[0x00]).to_string()
    }
}

/// 编码鼠标事件为 URXVT 序列
///
/// 格式: `CSI <btn+32> ; <col> ; <row> M`
/// URXVT 使用 1015 模式,坐标始终是数字
pub fn encode_urxvt(event: &MouseEvent) -> String {
    let btn = mouse_button_number(event.button, event.modifiers);
    let btn = if event.is_press { btn } else { 3 };
    format!("\x1b[{};{};{}M", btn + 32, event.col, event.row)
}

/// 统一编码入口:根据编码方式选择合适的方法
///
/// 返回对应编码的字符串,none 表示不支持该编码方式
pub fn encode_mouse(event: &MouseEvent, encoding: MouseEncoding) -> String {
    match encoding {
        MouseEncoding::X10 => encode_x10(event),
        MouseEncoding::Utf8 => encode_utf8(event),
        MouseEncoding::Sgr => encode_sgr(event),
        MouseEncoding::Urxvt => encode_urxvt(event),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_event(button: MouseButton, col: u16, row: u16, is_press: bool) -> MouseEvent {
        MouseEvent {
            button,
            col,
            row,
            modifiers: Modifiers::NONE,
            is_press,
        }
    }

    #[test]
    fn test_sgr_press_left() {
        // Left click at col=1, row=1
        let event = make_event(MouseButton::Left, 1, 1, true);
        assert_eq!(encode_sgr(&event), "\x1b[<0;1;1M");
    }

    #[test]
    fn test_sgr_release_left() {
        // Left release at col=1, row=1
        let event = make_event(MouseButton::Left, 1, 1, false);
        assert_eq!(encode_sgr(&event), "\x1b[<0;1;1m");
    }

    #[test]
    fn test_sgr_press_with_modifiers() {
        let mut event = make_event(MouseButton::Left, 5, 10, true);
        event.modifiers = Modifiers::CTRL;
        // Left=0, CTRL+=16 → btn=16
        assert_eq!(encode_sgr(&event), "\x1b[<16;5;10M");
    }

    #[test]
    fn test_sgr_wheel_up() {
        let event = make_event(MouseButton::WheelUp, 1, 1, true);
        assert_eq!(encode_sgr(&event), "\x1b[<64;1;1M");
    }

    #[test]
    fn test_sgr_wheel_down() {
        let event = make_event(MouseButton::WheelDown, 1, 1, true);
        assert_eq!(encode_sgr(&event), "\x1b[<65;1;1M");
    }

    #[test]
    fn test_x10_press() {
        let event = make_event(MouseButton::Left, 1, 1, true);
        // Left=0, btn=32→space, coord=1+32=33→'!'
        // 格式: \x1b[M <space> <!> <!>
        let result = encode_x10(&event);
        assert_eq!(result.len(), 6);
        assert!(result.starts_with("\x1b[M"));
        // 第 4 字节是 btn+32 = 32 → space
        // 第 5-6 字节是 coord+32 = 33 → '!'
        assert_eq!(result.as_bytes()[3], 32); // space
        assert_eq!(result.as_bytes()[4], 33); // '!'
        assert_eq!(result.as_bytes()[5], 33); // '!'
    }

    #[test]
    fn test_x10_release() {
        let event = make_event(MouseButton::Left, 1, 1, false);
        // Release=3, coord=33
        assert_eq!(encode_x10(&event), "\x1b[M#!!"); // 32+3=35→#, 33→!, 33→!
    }

    #[test]
    fn test_utf8_encode() {
        let event = make_event(MouseButton::Left, 1, 1, true);
        let result = encode_utf8(&event);
        assert!(result.starts_with("\x1b[M"));
        // 小坐标,UTF-8 = ASCII
        assert!(result.len() >= 5);
    }

    #[test]
    fn test_urxvt_encode() {
        let event = make_event(MouseButton::Left, 5, 10, true);
        // Left=0, +32=32 → "32;5;10M"
        assert_eq!(encode_urxvt(&event), "\x1b[32;5;10M");
    }

    #[test]
    fn test_urxvt_release() {
        let event = make_event(MouseButton::Left, 5, 10, false);
        // Release=3, +32=35 → "35;5;10M"
        assert_eq!(encode_urxvt(&event), "\x1b[35;5;10M");
    }

    #[test]
    fn test_unified_encoding_sgr() {
        let event = make_event(MouseButton::Right, 3, 7, true);
        let result = encode_mouse(&event, MouseEncoding::Sgr);
        assert_eq!(result, "\x1b[<2;3;7M"); // Right=2
    }

    #[test]
    fn test_unified_encoding_x10() {
        let event = make_event(MouseButton::Right, 3, 7, true);
        let result = encode_mouse(&event, MouseEncoding::X10);
        // Right=2, +32=34→'"', coord=3+32=35→'#'
        assert!(result.starts_with("\x1b[M"));
    }

    #[test]
    fn test_button_number_mapping() {
        assert_eq!(mouse_button_number(MouseButton::Left, Modifiers::NONE), 0);
        assert_eq!(mouse_button_number(MouseButton::Middle, Modifiers::NONE), 1);
        assert_eq!(mouse_button_number(MouseButton::Right, Modifiers::NONE), 2);
        assert_eq!(mouse_button_number(MouseButton::None, Modifiers::NONE), 3);
        assert_eq!(mouse_button_number(MouseButton::WheelUp, Modifiers::NONE), 64);
        assert_eq!(mouse_button_number(MouseButton::WheelDown, Modifiers::NONE), 65);
    }

    #[test]
    fn test_sgr_modifier_shift() {
        let mut event = make_event(MouseButton::Left, 1, 1, true);
        event.modifiers = Modifiers::SHIFT;
        // Left=0, SHIFT+=4 → btn=4
        assert_eq!(encode_sgr(&event), "\x1b[<4;1;1M");
    }

    #[test]
    fn test_sgr_modifier_shift_ctrl() {
        let mut event = make_event(MouseButton::Right, 1, 1, true);
        event.modifiers = Modifiers::SHIFT | Modifiers::CTRL;
        // Right=2, SHIFT+=4, CTRL+=16 → btn=22
        assert_eq!(encode_sgr(&event), "\x1b[<22;1;1M");
    }
}