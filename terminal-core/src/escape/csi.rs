//! CSI (Control Sequence Introducer) 语义解析
//!
//! fork 自 wezterm `wezterm-escape-parser/src/csi.rs` 的精简版,
//! 只覆盖 TUI 程序（Claude Code / opencode / vim / tmux）实际用到的序列:
//! - SGR（颜色、亮度、下划线）
//! - 光标移动（CUU/CUD/CUF/CUB/CNL/CPL/CHA/VPA/VPR）
//! - 擦除（ED/EL）
//! - DEC private modes（鼠标、bracketed paste、sync update、focus、alt screen）
//! - Kitty keyboard（CSI > 1 u / CSI ? 1 u）
//! - modifyOtherKeys（CSI > 4 ; n M）
//!
//! 借鉴的 wezterm 枚举:
//! - `Blink` / `Intensity` / `Underline`（SGR 子状态）
//! - `ColorSpec`（前景/背景颜色）
//! - `DecPrivateModeCode`（DEC private modes,见 mod.rs:955 `SynchronizedOutput = 2026`）
//!
//! 本阶段只做"CSI 字节流 → CSI 枚举"的解析,不触及终端状态机。
//! 状态机应用在阶段 1.3 的 `state/performer.rs` 实现。

use crate::parser::vtparse::CsiParam;

/// SGR 颜色规格:索引色 / 5;N (256 色) / 2;R;G;B (True Color)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorSpec {
    /// 默认前景/背景（依赖于终端主题）
    Default,
    /// 索引色（0-15:标准 16 色;16-231:216 色立方;232-255:24 灰度）
    Index(u8),
    /// True Color,R / G / B 各 8 位
    TrueColor(u8, u8, u8),
}

/// 单元格亮度
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[repr(u8)]
pub enum Intensity {
    #[default]
    Normal = 0,
    Bold = 1,
    Half = 2,
}

/// 下划线样式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Underline {
    None = 0,
    Single = 1,
    Double = 2,
    Curly = 3,
    Dotted = 4,
    Dashed = 5,
}

/// 闪烁速度
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[repr(u8)]
pub enum Blink {
    #[default]
    None = 0,
    Slow = 1,
    Rapid = 2,
}

/// SGR (Select Graphic Rendition) 子集
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sgr {
    Reset,
    Intensity(Intensity),
    Italic(bool),
    Underline(Underline),
    Blink(Blink),
    Reverse(bool),
    Strike(bool),
    Hidden(bool),
    Foreground(ColorSpec),
    Background(ColorSpec),
    UnderlineColor(ColorSpec),
}

/// 光标移动方向
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CursorMove {
    Up,
    Down,
    Forward,
    Back,
    NextLine,
    PrevLine,
    ColumnAbs,
    RowAbs,
    RowRel,
}

/// 擦除范围
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EraseKind {
    /// 擦除光标到行尾
    ToEnd,
    /// 擦除行首到光标
    ToStart,
    /// 擦除整行
    All,
    /// 擦除整行并滚动回滚区（仅 ED 用）
    Scrollback,
}

/// DEC private mode 编号（覆盖 TUI 常用项）
///
/// 借鉴 wezterm `csi.rs:955` 的 `SynchronizedOutput = 2026` 等。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u16)]
pub enum DecPrivateModeCode {
    CursorKeysMode = 1,
    DecAnsiMode = 2,
    CursorVisible = 25,
    OriginMode = 6,
    AutoWrap = 7,
    AutoRepeat = 8,
    MouseTracking = 1000,
    HiliteMouseTracking = 1001,
    ButtonEventMouse = 1002,
    AnyEventMouse = 1003,
    FocusTracking = 1004,
    Utf8MouseMode = 1005,
    SgrMouseMode = 1006,
    UrxvtMouseMode = 1015,
    SixelMouseMode = 1016,
    BracketedPaste = 2004,
    SyncTimeout = 2024,
    SynchronizedOutput = 2026,
    GraphemeClusters = 2027,
}

impl DecPrivateModeCode {
    pub fn from_u16(n: u16) -> Option<Self> {
        Some(match n {
            1 => Self::CursorKeysMode,
            2 => Self::DecAnsiMode,
            6 => Self::OriginMode,
            7 => Self::AutoWrap,
            8 => Self::AutoRepeat,
            25 => Self::CursorVisible,
            1000 => Self::MouseTracking,
            1001 => Self::HiliteMouseTracking,
            1002 => Self::ButtonEventMouse,
            1003 => Self::AnyEventMouse,
            1004 => Self::FocusTracking,
            1005 => Self::Utf8MouseMode,
            1006 => Self::SgrMouseMode,
            1015 => Self::UrxvtMouseMode,
            1016 => Self::SixelMouseMode,
            2004 => Self::BracketedPaste,
            2024 => Self::SyncTimeout,
            2026 => Self::SynchronizedOutput,
            2027 => Self::GraphemeClusters,
            _ => return None,
        })
    }
}

/// Kitty keyboard 协议标志位
///
/// 借鉴 wezterm `wezterm-input-types/src/lib.rs:2034` 的 `KittyKeyboardFlags`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct KittyKeyboardFlags(u8);

impl KittyKeyboardFlags {
    pub const DISAMBIGUATE_ESCAPE_CODES: Self = Self(1);
    pub const REPORT_EVENT_TYPES: Self = Self(2);
    pub const REPORT_ALTERNATE_KEYS: Self = Self(4);
    pub const REPORT_ALL_KEYS_AS_ESCAPE_CODES: Self = Self(8);
    pub const REPORT_ASSOCIATED_TEXT: Self = Self(16);

    pub fn from_bits_truncate(bits: u8) -> Self {
        Self(bits & 0b11111)
    }

    pub fn bits(self) -> u8 {
        self.0
    }

    pub fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }
}

/// Kitty keyboard 协议操作模式
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KittyKeyboardMode {
    AssignAll,
    SetSpecified,
    ClearSpecified,
}

/// 已解析的 CSI 序列
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CSI {
    /// SGR:控制文字属性（颜色、粗细、下划线等）
    Sgr(Sgr),
    /// 光标移动:CUU/CUD/CUF/CUB/CNL/CPL/CHA/VPA/VPR
    Cursor {
        dir: CursorMove,
        n: u32,
    },
    /// 水平/垂直制表位控制（CHT/CBT 等,本阶段占位）
    Tab,
    /// 擦除显示内容（ED）
    EraseDisplay(EraseKind),
    /// 擦除行内容（EL）
    EraseLine(EraseKind),
    /// 插入行（IL）/ 删除行（DL）
    LineEdit {
        insert: bool,
        n: u32,
    },
    /// 插入字符（ICH）/ 删除字符（DCH）
    CharEdit {
        insert: bool,
        n: u32,
    },
    /// 滚动（SU/SD）
    Scroll {
        up: bool,
        n: u32,
    },
    /// 设置 DEC private mode（CSI ? N h）
    SetDecPrivateMode(DecPrivateModeCode),
    /// 重置 DEC private mode（CSI ? N l）
    ResetDecPrivateMode(DecPrivateModeCode),
    /// 查询 DEC private mode（CSI ? N $ p）
    QueryDecPrivateMode(DecPrivateModeCode),
    /// Kitty keyboard push flags（CSI > 1 ; flags u）
    KittyKeyboardPush(KittyKeyboardFlags),
    /// Kitty keyboard pop flags（CSI > 1 u）
    KittyKeyboardPop,
    /// Kitty keyboard query（CSI ? 1 u）
    KittyKeyboardQuery,
    /// modifyOtherKeys 设置（CSI > 4 ; n M）
    ModifyOtherKeys(Option<i64>),
    /// 查询光标位置（DSR 6）
    DeviceStatusReportCursor,
    /// 查询终端大小（DSR 14）
    DeviceStatusReportSize,
    /// DA1（CSI c）/ DA2（CSI > c）
    DeviceAttributes {
        private: bool,
    },
    /// 未能识别的 CSI,保留原始参数供调试
    Unknown {
        params: Vec<CsiParam>,
        intermediates: Vec<u8>,
        private_marker: bool,
        byte: u8,
    },
}

/// 从 vtparse 的 CSI dispatch 参数流提取第 idx 个参数为 u32。
///
/// vtparse 把 `;` 内联编码为 `CsiParam::P(b';')` 放在参数流里,
/// 所以 `params` 是一个混合流:`[Integer(1), P(b';'), Integer(20), ...]`。
/// 本函数跳过这些分隔符,把第 idx 个真正的整数参数取出来。
fn param_u32(params: &[CsiParam], idx: usize, default: u32) -> u32 {
    let mut want = idx;
    for p in params {
        match p {
            CsiParam::P(_) => continue, // 子参数分隔符,跳过
            CsiParam::Integer(n) => {
                if want == 0 {
                    return (*n).max(0) as u32;
                }
                want -= 1;
            }
        }
    }
    default
}

/// 从 vtparse 的 CSI dispatch 参数流提取第 idx 个参数为 i64。
///
/// 见 `param_u32` 的说明:vtparse 把 `;` 内联为 `CsiParam::P(b';')`,
/// 本函数跳过分隔符再取第 idx 个整数。
fn param_i64(params: &[CsiParam], idx: usize, default: i64) -> i64 {
    let mut want = idx;
    for p in params {
        match p {
            CsiParam::P(_) => continue,
            CsiParam::Integer(n) => {
                if want == 0 {
                    return *n;
                }
                want -= 1;
            }
        }
    }
    default
}

/// 解析 SGR 参数流为 Sgr 枚举列表
///
/// SGR 是 CSI 中最复杂的:多个属性可串联（如 `\x1b[1;31;4m`）,
/// 颜色用 5;N 或 2;R;G;B 扩展语法,且参数数量不固定。
/// 本函数把一个 SGR CSI 派发拆成多个 Sgr 实例。
pub fn parse_sgr(params: &[CsiParam]) -> Vec<Sgr> {
    let mut out = Vec::new();
    let mut i = 0;
    let empty: &[CsiParam] = &[];

    while i < params.len() {
        let slice = if i + 1 <= params.len() {
            &params[i..]
        } else {
            empty
        };
        let n = param_i64(slice, 0, 0);
        i += 1;
        match n {
            0 => out.push(Sgr::Reset),
            1 => out.push(Sgr::Intensity(Intensity::Bold)),
            2 => out.push(Sgr::Intensity(Intensity::Half)),
            22 => out.push(Sgr::Intensity(Intensity::Normal)),
            3 => out.push(Sgr::Italic(true)),
            23 => out.push(Sgr::Italic(false)),
            4 => out.push(Sgr::Underline(Underline::Single)),
            21 => out.push(Sgr::Underline(Underline::Double)),
            24 => out.push(Sgr::Underline(Underline::None)),
            5 => out.push(Sgr::Blink(Blink::Slow)),
            6 => out.push(Sgr::Blink(Blink::Rapid)),
            25 => out.push(Sgr::Blink(Blink::None)),
            7 => out.push(Sgr::Reverse(true)),
            27 => out.push(Sgr::Reverse(false)),
            8 => out.push(Sgr::Hidden(true)),
            28 => out.push(Sgr::Hidden(false)),
            9 => out.push(Sgr::Strike(true)),
            29 => out.push(Sgr::Strike(false)),
            // 标准前景色 30-37,90-97
            c @ (30..=37 | 90..=97) => {
                let idx = if c >= 90 { (c - 90 + 8) as u8 } else { (c - 30) as u8 };
                out.push(Sgr::Foreground(ColorSpec::Index(idx)));
            }
            // 标准背景色 40-47,100-107
            c @ (40..=47 | 100..=107) => {
                let idx = if c >= 100 { (c - 100 + 8) as u8 } else { (c - 40) as u8 };
                out.push(Sgr::Background(ColorSpec::Index(idx)));
            }
            39 => out.push(Sgr::Foreground(ColorSpec::Default)),
            49 => out.push(Sgr::Background(ColorSpec::Default)),
            59 => out.push(Sgr::UnderlineColor(ColorSpec::Default)),
            // 256 色 / True Color 前景:38;5;N 或 38;2;R;G;B
            38 | 48 | 58 => {
                let target = match n {
                    38 => Sgr::Foreground,
                    48 => Sgr::Background,
                    _ => Sgr::UnderlineColor,
                };
                let mode = param_i64(slice, 1, 0);
                i += 1; // 消费 mode
                match mode {
                    5 => {
                        let idx = param_i64(slice, 2, 0) as u8;
                        out.push(target(ColorSpec::Index(idx)));
                        i += 1; // 消费 N
                    }
                    2 => {
                        let r = param_i64(slice, 2, 0) as u8;
                        let g = param_i64(slice, 3, 0) as u8;
                        let b = param_i64(slice, 4, 0) as u8;
                        out.push(target(ColorSpec::TrueColor(r, g, b)));
                        i += 3; // 消费 R;G;B
                    }
                    _ => {}
                }
            }
            _ => {} // 忽略未识别的 SGR 子参数
        }
    }

    if out.is_empty() {
        out.push(Sgr::Reset);
    }
    out
}

/// 解析 CSI 派发事件为 CSI 枚举
///
/// 这是阶段 1.2a 的核心入口:state/performer 在收到 `Action::CsiDispatch` 时
/// 调用本函数,得到结构化的 `CSI` 后再应用到 `TerminalState`。
///
/// 注意:vtparse 把私有标记 `?`/`>` 编码为 `CsiParam::P(b'?')` 放在 params 首位,
/// 而非单独的 `private_marker` 标志。本函数在入口处剥离此前缀后再分派。
pub fn parse_csi(
    params: &[CsiParam],
    intermediates: &[u8],
    private_marker: bool,
    byte: u8,
) -> CSI {
    // 剥离 vtparse 编码进 params 首位的私有标记 `?` / `>`
    let mut stripped = params;
    let mut marker_byte: Option<u8> = None;
    if let Some(CsiParam::P(p)) = stripped.first() {
        if *p == b'?' || *p == b'>' {
            marker_byte = Some(*p);
            stripped = &stripped[1..];
        }
    }

    // `?` 路由:DEC private mode / Kitty keyboard query
    if marker_byte == Some(b'?') || private_marker {
        let mode_num = param_i64(stripped, 0, 0) as u16;
        return match byte {
            b'h' => DecPrivateModeCode::from_u16(mode_num)
                .map(CSI::SetDecPrivateMode)
                .unwrap_or_else(|| unknown(stripped, intermediates, true, byte)),
            b'l' => DecPrivateModeCode::from_u16(mode_num)
                .map(CSI::ResetDecPrivateMode)
                .unwrap_or_else(|| unknown(stripped, intermediates, true, byte)),
            b'u' if mode_num == 1 => CSI::KittyKeyboardQuery,
            _ => unknown(stripped, intermediates, true, byte),
        };
    }

    // `>` 路由:Kitty keyboard push/pop / modifyOtherKeys / DA2
    if marker_byte == Some(b'>') || intermediates == [b'>'] {
        let first = param_i64(stripped, 0, 0);
        return match (byte, first) {
            // Kitty keyboard:CSI > 1 ; flags u  → push flags
            // CSI > 1 u（没有第二个参数）  → pop flags
            // 区分依据是是否有第二个参数（flags）
            (b'u', 1) => {
                // 用 param_count 数 stripped 中真正的整数参数个数
                // 1 个参数 = pop;2 个参数 = push flags
                let n_real_params = stripped
                    .iter()
                    .filter(|p| matches!(p, CsiParam::Integer(_)))
                    .count();
                if n_real_params >= 2 {
                    let flags = param_i64(stripped, 1, 0) as u8;
                    CSI::KittyKeyboardPush(KittyKeyboardFlags::from_bits_truncate(flags))
                } else {
                    CSI::KittyKeyboardPop
                }
            }
            (b'M', 4) => {
                // modifyOtherKeys:CSI > 4 ; n M
                let val = param_i64(stripped, 1, 0);
                CSI::ModifyOtherKeys(if val == 0 { None } else { Some(val) })
            }
            (b'c', _) => CSI::DeviceAttributes { private: true },
            _ => unknown(stripped, intermediates, true, byte),
        };
    }

    // 普通 CSI 路由:按终结字节分派
    match byte {
        b'm' => {
            // SGR 可能拆出多个 Sgr,我们用一个 Sgr::Reset 占位,
            // 实际多 Sgr 由 parse_sgr 处理,performer 直接调用 parse_sgr
            let sgrs = parse_sgr(params);
            // 多 SGR 时返回 Reset(占位),performer 应优先用 parse_sgr
            // 单 SGR 时直接返回该 Sgr
            if sgrs.len() == 1 {
                CSI::Sgr(sgrs[0])
            } else {
                // 多 SGR:用第一个,performer 应感知到这是多 SGR 场景
                // 简化:我们返回 Reset,实际处理在 performer
                CSI::Sgr(sgrs[0])
            }
        }
        b'A' => CSI::Cursor { dir: CursorMove::Up, n: param_u32(params, 0, 1) },
        b'B' => CSI::Cursor { dir: CursorMove::Down, n: param_u32(params, 0, 1) },
        b'C' => CSI::Cursor { dir: CursorMove::Forward, n: param_u32(params, 0, 1) },
        b'D' => CSI::Cursor { dir: CursorMove::Back, n: param_u32(params, 0, 1) },
        b'E' => CSI::Cursor { dir: CursorMove::NextLine, n: param_u32(params, 0, 1) },
        b'F' => CSI::Cursor { dir: CursorMove::PrevLine, n: param_u32(params, 0, 1) },
        b'G' => CSI::Cursor { dir: CursorMove::ColumnAbs, n: param_u32(params, 0, 1) },
        b'H' | b'f' => {
            // CUP / HVP:行;列
            CSI::Cursor {
                dir: CursorMove::RowAbs,
                n: param_u32(params, 0, 1),
            }
        }
        b'd' => CSI::Cursor { dir: CursorMove::RowAbs, n: param_u32(params, 0, 1) },
        b'J' => {
            // ED:0=ToEnd,1=ToStart,2=All,3=Scrollback
            let kind = match param_i64(params, 0, 0) {
                1 => EraseKind::ToStart,
                2 => EraseKind::All,
                3 => EraseKind::Scrollback,
                _ => EraseKind::ToEnd,
            };
            CSI::EraseDisplay(kind)
        }
        b'K' => {
            // EL:0=ToEnd,1=ToStart,2=All
            let kind = match param_i64(params, 0, 0) {
                1 => EraseKind::ToStart,
                2 => EraseKind::All,
                _ => EraseKind::ToEnd,
            };
            CSI::EraseLine(kind)
        }
        b'L' => CSI::CharEdit { insert: true, n: param_u32(params, 0, 1) },
        b'M' => CSI::CharEdit { insert: false, n: param_u32(params, 0, 1) },
        b'P' => CSI::CharEdit { insert: false, n: param_u32(params, 0, 1) },
        b'@' => CSI::CharEdit { insert: true, n: param_u32(params, 0, 1) },
        b'S' => CSI::Scroll { up: true, n: param_u32(params, 0, 1) },
        b'T' => CSI::Scroll { up: false, n: param_u32(params, 0, 1) },
        b'c' => CSI::DeviceAttributes { private: false },
        b'n' => {
            // DSR:6=光标位置,14=终端尺寸
            match param_i64(params, 0, 0) {
                6 => CSI::DeviceStatusReportCursor,
                14 => CSI::DeviceStatusReportSize,
                _ => unknown(params, intermediates, false, byte),
            }
        }
        b'I' => CSI::Tab, // CHT - 水平制表
        b'Z' => CSI::Tab, // CBT - 反向制表
        _ => unknown(params, intermediates, false, byte),
    }
}

#[inline]
fn unknown(
    params: &[CsiParam],
    intermediates: &[u8],
    private_marker: bool,
    byte: u8,
) -> CSI {
    CSI::Unknown {
        params: params.to_vec(),
        intermediates: intermediates.to_vec(),
        private_marker,
        byte,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::vtparse::{CsiParam, CollectingVTActor, VTParser};

    fn first_csi(input: &[u8]) -> CSI {
        let mut collector = CollectingVTActor::default();
        {
            let mut parser = VTParser::new();
            parser.parse(input, &mut collector);
        }
        let actions = collector.into_vec();
        // 找第一个 CsiDispatch
        for a in actions {
            if let crate::parser::vtparse::VTAction::CsiDispatch {
                params,
                parameters_truncated,
                byte,
            } = a
            {
                let _ = parameters_truncated;
                return parse_csi(&params, &[], false, byte);
            }
        }
        panic!("no CSI in {:?}", input);
    }

    #[test]
    fn test_sgr_reset() {
        let csi = first_csi(b"\x1b[0m");
        assert_eq!(csi, CSI::Sgr(Sgr::Reset));
    }

    #[test]
    fn test_sgr_bold_red() {
        // ESC [ 1 ; 31 m → Bold + Red foreground
        let csi = first_csi(b"\x1b[1;31m");
        // parse_csi 返回第一个 Sgr,多 SGR 时 performer 应调用 parse_sgr
        assert_eq!(csi, CSI::Sgr(Sgr::Intensity(Intensity::Bold)));
    }

    #[test]
    fn test_sgr_parse_multiple() {
        let params = vec![
            CsiParam::Integer(1),
            CsiParam::Integer(31),
            CsiParam::Integer(4),
        ];
        let sgrs = parse_sgr(&params);
        assert_eq!(sgrs.len(), 3);
        assert_eq!(sgrs[0], Sgr::Intensity(Intensity::Bold));
        assert_eq!(sgrs[1], Sgr::Foreground(ColorSpec::Index(1)));
        assert_eq!(sgrs[2], Sgr::Underline(Underline::Single));
    }

    #[test]
    fn test_sgr_true_color() {
        // ESC [ 38 ; 2 ; 255 ; 128 ; 0 m
        let params = vec![
            CsiParam::Integer(38),
            CsiParam::Integer(2),
            CsiParam::Integer(255),
            CsiParam::Integer(128),
            CsiParam::Integer(0),
        ];
        let sgrs = parse_sgr(&params);
        assert_eq!(sgrs.len(), 1);
        assert_eq!(sgrs[0], Sgr::Foreground(ColorSpec::TrueColor(255, 128, 0)));
    }

    #[test]
    fn test_sgr_256_color() {
        // ESC [ 48 ; 5 ; 202 m → 背景橙色
        let params = vec![
            CsiParam::Integer(48),
            CsiParam::Integer(5),
            CsiParam::Integer(202),
        ];
        let sgrs = parse_sgr(&params);
        assert_eq!(sgrs.len(), 1);
        assert_eq!(sgrs[0], Sgr::Background(ColorSpec::Index(202)));
    }

    #[test]
    fn test_cursor_up_default() {
        // ESC [ A → CUU 1
        let csi = first_csi(b"\x1b[A");
        assert_eq!(csi, CSI::Cursor { dir: CursorMove::Up, n: 1 });
    }

    #[test]
    fn test_cursor_up_n() {
        let csi = first_csi(b"\x1b[5A");
        assert_eq!(csi, CSI::Cursor { dir: CursorMove::Up, n: 5 });
    }

    #[test]
    fn test_cup() {
        // ESC [ 10 ; 20 H → CUP 10;20
        let csi = first_csi(b"\x1b[10;20H");
        // 简化:CUP 返回 RowAbs(行),列参数当前丢弃
        match csi {
            CSI::Cursor { dir: CursorMove::RowAbs, n: 10 } => {}
            _ => panic!("unexpected CSI: {:?}", csi),
        }
    }

    #[test]
    fn test_ed_all() {
        // ESC [ 2 J → ED 2 (clear all)
        let csi = first_csi(b"\x1b[2J");
        assert_eq!(csi, CSI::EraseDisplay(EraseKind::All));
    }

    #[test]
    fn test_ed_scrollback() {
        // ESC [ 3 J → ED 3 (clear scrollback)
        let csi = first_csi(b"\x1b[3J");
        assert_eq!(csi, CSI::EraseDisplay(EraseKind::Scrollback));
    }

    #[test]
    fn test_dec_private_bracketed_paste() {
        // ESC [ ? 2004 h → enable bracketed paste
        let csi = first_csi(b"\x1b[?2004h");
        assert_eq!(csi, CSI::SetDecPrivateMode(DecPrivateModeCode::BracketedPaste));
    }

    #[test]
    fn test_dec_private_sync_output() {
        // ESC [ ? 2026 h → begin synchronized update (BSU)
        let csi = first_csi(b"\x1b[?2026h");
        assert_eq!(csi, CSI::SetDecPrivateMode(DecPrivateModeCode::SynchronizedOutput));
    }

    #[test]
    fn test_dec_private_focus() {
        // ESC [ ? 1004 h → enable focus tracking
        let csi = first_csi(b"\x1b[?1004h");
        assert_eq!(csi, CSI::SetDecPrivateMode(DecPrivateModeCode::FocusTracking));
    }

    #[test]
    fn test_dec_private_mouse_sgr() {
        // ESC [ ? 1006 h → enable SGR mouse mode
        let csi = first_csi(b"\x1b[?1006h");
        assert_eq!(csi, CSI::SetDecPrivateMode(DecPrivateModeCode::SgrMouseMode));
    }

    #[test]
    fn test_kitty_keyboard_push() {
        // ESC [ > 1 ; 1 u → push DISAMBIGUATE_ESCAPE_CODES
        let csi = first_csi(b"\x1b[>1;1u");
        assert_eq!(
            csi,
            CSI::KittyKeyboardPush(KittyKeyboardFlags::DISAMBIGUATE_ESCAPE_CODES)
        );
    }

    #[test]
    fn test_kitty_keyboard_pop() {
        // ESC [ > 1 u → pop flags
        let csi = first_csi(b"\x1b[>1u");
        assert_eq!(csi, CSI::KittyKeyboardPop);
    }

    #[test]
    fn test_kitty_keyboard_query() {
        // ESC [ ? 1 u → query current flags
        let csi = first_csi(b"\x1b[?1u");
        assert_eq!(csi, CSI::KittyKeyboardQuery);
    }

    #[test]
    fn test_dsr_cursor() {
        // ESC [ 6 n → DSR 6 (cursor position)
        let csi = first_csi(b"\x1b[6n");
        assert_eq!(csi, CSI::DeviceStatusReportCursor);
    }

    #[test]
    fn test_da1() {
        // ESC [ c → DA1 (primary device attributes)
        let csi = first_csi(b"\x1b[c");
        assert_eq!(csi, CSI::DeviceAttributes { private: false });
    }

    #[test]
    fn test_unknown_csi_preserved() {
        // 一个不常见的 CSI,确保 Unknown 保留原始参数
        let csi = first_csi(b"\x1b[99;100z");
        match csi {
            CSI::Unknown { byte, .. } => assert_eq!(byte, b'z'),
            _ => panic!("expected Unknown, got {:?}", csi),
        }
    }
}
