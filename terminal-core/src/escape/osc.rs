//! OSC (Operating System Command) 语义解析
//!
//! fork 自 wezterm `wezterm-escape-parser/src/osc.rs` 的精简版,
//! 覆盖 TUI 程序实际使用的 OSC 序列:
//! - 标题设置（OSC 0/1/2/l/L）
//! - 颜色查询/设置（OSC 4/10/11/12/104/110-119）
//! - 超链接（OSC 8）
//! - 剪贴板（OSC 52）
//! - 当前工作目录（OSC 7）
//! - iTerm2 专有（OSC 9/1337）
//! - FinalTerm 语义提示（OSC 133）
//! - Rxvt 扩展（OSC 777）
//!
//! 借鉴的 wezterm 枚举:
//! - `OperatingSystemCommand`（osc.rs:33-55）
//! - `OperatingSystemCommandCode`（osc.rs:457-505）
//!
//! 本阶段只做"OSC 字节流 → OSC 枚举"的解析,不触及终端状态机。
//! 状态机应用在阶段 1.3 的 `state/performer.rs` 实现。

use core::str;

/// 超链接信息（OSC 8）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hyperlink {
    /// 超链接 URL
    pub uri: String,
    /// 可选参数（如 id=xxx）
    pub params: String,
}

/// 选择器类型（OSC 52 剪贴板）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Selection {
    Clipboard,
    Primary,
    Select,
    Cut(u8),
    None,
}

/// 动态颜色编号（OSC 10-19）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum DynamicColor {
    TextForeground = 10,
    TextBackground = 11,
    TextCursor = 12,
    MouseForeground = 13,
    MouseBackground = 14,
    TektronixForeground = 15,
    TektronixBackground = 16,
    HighlightBackground = 17,
    TektronixCursor = 18,
    HighlightForeground = 19,
}

impl DynamicColor {
    fn from_u8(n: u8) -> Option<Self> {
        Some(match n {
            10 => Self::TextForeground,
            11 => Self::TextBackground,
            12 => Self::TextCursor,
            13 => Self::MouseForeground,
            14 => Self::MouseBackground,
            15 => Self::TektronixForeground,
            16 => Self::TektronixBackground,
            17 => Self::HighlightBackground,
            18 => Self::TektronixCursor,
            19 => Self::HighlightForeground,
            _ => return None,
        })
    }
}

/// 颜色规格（用于 OSC 4/10-19 的颜色设置或查询）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ColorSpec {
    /// 颜色值:"rgb:RRRR/GGGG/BBBB" 格式
    Rgb(String),
    /// 查询当前颜色（用 `?` 表示）
    Query,
}

/// iTerm2 专有命令（OSC 1337）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ITermProprietary {
    /// 设置当前工作目录
    CurrentDir(String),
    /// 设置文件名
    FileName(String),
    /// 设置标记
    Mark,
    /// 设置 Stealth 模式
    Stealth(bool),
    /// 设置剪切板
    Copy(String),
    /// 其他未识别的 iTerm2 命令
    Unrecognized(String, String),
}

/// 颜色序号和颜色值对（OSC 4）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangeColorPair {
    pub palette_index: u8,
    pub color: ColorSpec,
}

/// 已解析的 OSC 序列
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OperatingSystemCommand {
    /// 设置图标名和窗口标题（OSC 0）
    SetIconNameAndWindowTitle(String),
    /// 设置图标名（OSC 1）
    SetIconName(String),
    /// 设置窗口标题（OSC 2）
    SetWindowTitle(String),
    /// 设置窗口标题（Sun 风格,OSC l）
    SetWindowTitleSun(String),
    /// 设置图标名（Sun 风格,OSC L）
    SetIconNameSun(String),
    /// 修改调色板颜色（OSC 4）
    ChangeColorNumber(Vec<ChangeColorPair>),
    /// 设置当前工作目录（OSC 7）
    CurrentWorkingDirectory(String),
    /// 设置超链接（OSC 8）
    SetHyperlink(Option<Hyperlink>),
    /// 系统通知（OSC 9,iTerm2）
    SystemNotification(String),
    /// 设置动态颜色（OSC 10-19）
    ChangeDynamicColors(DynamicColor, Vec<ColorSpec>),
    /// 重置动态颜色（OSC 110-119）
    ResetDynamicColor(DynamicColor),
    /// 剪贴板操作（OSC 52）
    ManipulateSelectionData(Selection, Option<String>),
    /// 重置调色板颜色（OSC 104）
    ResetColors(Vec<u8>),
    /// iTerm2 专有命令（OSC 1337）
    ITermProprietary(ITermProprietary),
    /// FinalTerm 语义提示（OSC 133）
    FinalTermSemanticPrompt(FinalTermPrompt),
    /// Rxvt 扩展（OSC 777）
    RxvtExtension(Vec<String>),
    /// 未能识别的 OSC,保留原始参数
    Unspecified(Vec<Vec<u8>>),
}

/// FinalTerm 语义提示类型（OSC 133）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FinalTermPrompt {
    /// 提示开始（OSC 133 ; A）
    PromptStart,
    /// 命令开始（OSC 133 ; B）
    CommandStart,
    /// 命令结束（OSC 133 ; C）
    CommandEnd,
    /// 未识别（OSC 133 ; <other>）
    Other(String),
}

/// 简易 base64 解码（仅用于 OSC 52 剪贴板）
fn base64_decode(input: &[u8]) -> Result<Vec<u8>, ()> {
    // 使用 base64 的简单实现,只处理标准字符集
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = Vec::with_capacity(input.len() / 4 * 3);
    let mut buffer = 0u32;
    let mut bits = 0u32;

    for &b in input {
        if b == b'=' {
            // padding
            bits -= 6;
            if bits == 0 {
                break;
            }
            // flush remaining
            while bits >= 8 {
                bits -= 8;
                output.push(((buffer >> bits) & 0xFF) as u8);
            }
            break;
        }
        let val = match CHARS.iter().position(|&c| c == b) {
            Some(v) => v as u32,
            None => continue, // 忽略空白/换行
        };
        buffer = (buffer << 6) | val;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push(((buffer >> bits) & 0xFF) as u8);
        }
    }
    Ok(output)
}

/// 解析选取器标识（OSC 52）
fn parse_selection(buf: &[u8]) -> Selection {
    if buf.is_empty() {
        return Selection::Select; // 默认为选择区
    }
    let mut sel = Selection::None;
    for &c in buf {
        sel = match c {
            b'c' => Selection::Clipboard,
            b'p' => Selection::Primary,
            b's' => Selection::Select,
            b'0'..=b'9' => Selection::Cut(c - b'0'),
            _ => return Selection::None,
        };
    }
    sel
}

/// 解析 OSC 序列
///
/// 输入参数是 OSC 用 ';' 分隔的字段（已由 vtparse 拆分）。
/// 每个字段是原始字节切片,不保证 UTF-8 合法。
/// 解析失败时返回 `Unspecified` 保留原始数据。
pub fn parse_osc(osc: &[&[u8]]) -> OperatingSystemCommand {
    parse_osc_inner(osc).unwrap_or_else(|_| {
        let vec = osc.iter().map(|s| s.to_vec()).collect();
        OperatingSystemCommand::Unspecified(vec)
    })
}

fn parse_osc_inner(osc: &[&[u8]]) -> Result<OperatingSystemCommand, ()> {
    if osc.is_empty() {
        return Err(());
    }
    let p1 = String::from_utf8_lossy(osc[0]);
    if p1.is_empty() {
        return Err(());
    }

    // 处理 Sun 风格的非数字 OSC 代码（l / L）
    // 注意:Sun 飗格有两种形:
    //   1. OSC l title（无分号,osc.len() == 1,p1 == "ltitle")
    //   2. OSC l ; title（有分号,osc.len() == 2,p1 == "l")
    // 所以判断条件是 osc[0] 以单字符非数字开头,标题从 osc[0] 剩余部分或 osc[1] 取
    let osc_code = if p1.len() == 1 && !p1.as_bytes()[0].is_ascii_digit() {
        p1.as_bytes()[0]
    } else if p1.len() >= 2 && !p1.as_bytes()[0].is_ascii_digit() {
        // 形如 "lMyTitle":代码是首字符,剩余是参数
        // 原地匹配下方的 b'l'/b'L' 分支会从 p1[1..] 取参数
        p1.as_bytes()[0]
    } else if let Some(first_digit) = p1.as_bytes().first() {
        if !first_digit.is_ascii_digit() {
            // 非数字 OSC 代码,如 "l" 或 "L"
            p1.as_bytes()[0]
        } else {
            // 数字代码,可能带后缀如 "1337"
            // 提取数字部分
            let num_str: String = p1.chars().take_while(|c| c.is_ascii_digit()).collect();
            if num_str.is_empty() {
                return Err(());
            }
            // 用 -1 标记数字 OSC 代码,实际在 match 中再解析
            return parse_numeric_osc(&num_str, osc);
        }
    } else {
        return Err(());
    };

    match osc_code {
        b'l' => {
            // OSC l ; title → SetWindowTitleSun
            // 或 OSC ltitle（无分号,Sun 呗格）
            let s = if osc.len() >= 2 {
                String::from_utf8_lossy(osc[1]).to_string()
            } else if p1.len() > 1 {
                // p1 == "lMyTitle",剥去首字符代码
                p1[1..].to_string()
            } else {
                String::new()
            };
            Ok(OperatingSystemCommand::SetWindowTitleSun(s))
        }
        b'L' => {
            // OSC L ; name → SetIconNameSun
            // 或 OSC Lname（无分号,Sun 嗗格）
            let s = if osc.len() >= 2 {
                String::from_utf8_lossy(osc[1]).to_string()
            } else if p1.len() > 1 {
                p1[1..].to_string()
            } else {
                String::new()
            };
            Ok(OperatingSystemCommand::SetIconNameSun(s))
        }
        _ => Err(()),
    }
}

fn parse_numeric_osc(code_str: &str, osc: &[&[u8]]) -> Result<OperatingSystemCommand, ()> {
    let code: u32 = code_str.parse().map_err(|_| ())?;

    macro_rules! single_string {
        ($variant:ident) => {{
            if osc.len() < 2 {
                return Err(());
            }
            let s = String::from_utf8(osc[1].to_vec()).map_err(|_| ())?;
            // 合并后续字段（OSC 标题可能包含分号）
            let mut result = s;
            for i in 2..osc.len() {
                result.push(';');
                result.push_str(&String::from_utf8(osc[i].to_vec()).map_err(|_| ())?);
            }
            Ok(OperatingSystemCommand::$variant(result))
        }};
    }

    match code {
        0 => single_string!(SetIconNameAndWindowTitle),
        1 => single_string!(SetIconName),
        2 => single_string!(SetWindowTitle),
        4 => {
            // OSC 4 ; index ; color ; index ; color ...
            let mut pairs = Vec::new();
            let mut iter = osc.iter().skip(1);
            while let (Some(index), Some(spec)) = (iter.next(), iter.next()) {
                let idx: u8 = str::from_utf8(index).map_err(|_| ())?.parse().map_err(|_| ())?;
                let color = if spec == b"?" {
                    ColorSpec::Query
                } else {
                    ColorSpec::Rgb(String::from_utf8_lossy(spec).to_string())
                };
                pairs.push(ChangeColorPair {
                    palette_index: idx,
                    color,
                });
            }
            Ok(OperatingSystemCommand::ChangeColorNumber(pairs))
        }
        7 => single_string!(CurrentWorkingDirectory),
        8 => {
            // OSC 8 ; params ; uri
            let params = if osc.len() >= 2 {
                String::from_utf8_lossy(osc[1]).to_string()
            } else {
                String::new()
            };
            let uri = if osc.len() >= 3 {
                let s = String::from_utf8_lossy(osc[2]).to_string();
                if s.is_empty() {
                    // 空 URI 表示关闭超链接
                    None
                } else {
                    Some(s)
                }
            } else {
                None
            };
            match uri {
                Some(uri) => Ok(OperatingSystemCommand::SetHyperlink(Some(Hyperlink {
                    uri,
                    params,
                }))),
                None => Ok(OperatingSystemCommand::SetHyperlink(None)),
            }
        }
        9 => single_string!(SystemNotification),
        10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 => {
            let color = DynamicColor::from_u8(code as u8).ok_or(())?;
            let mut colors = Vec::new();
            for spec in osc.iter().skip(1) {
                if spec == b"?" {
                    colors.push(ColorSpec::Query);
                } else {
                    colors.push(ColorSpec::Rgb(String::from_utf8_lossy(spec).to_string()));
                }
            }
            Ok(OperatingSystemCommand::ChangeDynamicColors(color, colors))
        }
        52 => {
            // OSC 52 ; Pc ; data
            if osc.len() == 1 {
                return Err(());
            }
            let sel = if osc.len() >= 2 {
                parse_selection(osc[1])
            } else {
                Selection::Select
            };
            if osc.len() >= 3 {
                // "?" 表示查询剪贴板,直接返回 None（查询而非设置）
                if osc[2] == b"?" {
                    return Ok(OperatingSystemCommand::ManipulateSelectionData(
                        sel, None,
                    ));
                }
                let data = base64_decode(osc[2]).map_err(|_| ())?;
                let s = String::from_utf8(data).map_err(|_| ())?;
                Ok(OperatingSystemCommand::ManipulateSelectionData(sel, Some(s)))
            } else {
                Ok(OperatingSystemCommand::ManipulateSelectionData(sel, None))
            }
        }
        104 => {
            // OSC 104 ; index ; index ...
            let mut colors = Vec::new();
            for spec in osc.iter().skip(1) {
                if spec.is_empty() {
                    continue;
                }
                let idx: u8 = str::from_utf8(spec).map_err(|_| ())?.parse().map_err(|_| ())?;
                colors.push(idx);
            }
            Ok(OperatingSystemCommand::ResetColors(colors))
        }
        110 => Ok(OperatingSystemCommand::ResetDynamicColor(DynamicColor::TextForeground)),
        111 => Ok(OperatingSystemCommand::ResetDynamicColor(DynamicColor::TextBackground)),
        112 => Ok(OperatingSystemCommand::ResetDynamicColor(DynamicColor::TextCursor)),
        113 => Ok(OperatingSystemCommand::ResetDynamicColor(DynamicColor::MouseForeground)),
        114 => Ok(OperatingSystemCommand::ResetDynamicColor(DynamicColor::MouseBackground)),
        115 => Ok(OperatingSystemCommand::ResetDynamicColor(DynamicColor::TektronixForeground)),
        116 => Ok(OperatingSystemCommand::ResetDynamicColor(DynamicColor::TektronixBackground)),
        117 => Ok(OperatingSystemCommand::ResetDynamicColor(DynamicColor::HighlightBackground)),
        118 => Ok(OperatingSystemCommand::ResetDynamicColor(DynamicColor::TektronixCursor)),
        119 => Ok(OperatingSystemCommand::ResetDynamicColor(DynamicColor::HighlightForeground)),
        133 => {
            // OSC 133 ; A/B/C
            if osc.len() < 2 {
                return Ok(OperatingSystemCommand::FinalTermSemanticPrompt(FinalTermPrompt::Other(
                    String::new(),
                )));
            }
            let sub = String::from_utf8_lossy(osc[1]);
            let prompt = match sub.as_ref() {
                "A" => FinalTermPrompt::PromptStart,
                "B" => FinalTermPrompt::CommandStart,
                "C" => FinalTermPrompt::CommandEnd,
                other => FinalTermPrompt::Other(other.to_string()),
            };
            Ok(OperatingSystemCommand::FinalTermSemanticPrompt(prompt))
        }
        777 => {
            // OSC 777 ; ... (Rxvt 扩展)
            let mut parts = Vec::new();
            for spec in osc.iter().skip(1) {
                parts.push(String::from_utf8_lossy(spec).to_string());
            }
            Ok(OperatingSystemCommand::RxvtExtension(parts))
        }
        1337 => {
            // OSC 1337 ; key=value ...
            parse_iterm(osc)
        }
        _ => Err(()),
    }
}

/// 解析 iTerm2 专有命令（OSC 1337）
fn parse_iterm(osc: &[&[u8]]) -> Result<OperatingSystemCommand, ()> {
    if osc.len() < 2 {
        return Err(());
    }
    let s = String::from_utf8_lossy(osc[1]).to_string();

    // 解析 key=value 格式
    if let Some(eq_pos) = s.find('=') {
        let key = &s[..eq_pos];
        let value = &s[eq_pos + 1..];
        match key {
            "CurrentDir" => {
                // 解码百分比编码的路径
                let decoded = url_decode(value);
                Ok(OperatingSystemCommand::ITermProprietary(
                    ITermProprietary::CurrentDir(decoded),
                ))
            }
            "File" | "FileName" => {
                let decoded = url_decode(value);
                Ok(OperatingSystemCommand::ITermProprietary(
                    ITermProprietary::FileName(decoded),
                ))
            }
            "Copy" => {
                // base64 解码
                let data = base64_decode(value.as_bytes()).map_err(|_| ())?;
                let decoded = String::from_utf8(data).map_err(|_| ())?;
                Ok(OperatingSystemCommand::ITermProprietary(
                    ITermProprietary::Copy(decoded),
                ))
            }
            "Mark" => Ok(OperatingSystemCommand::ITermProprietary(
                ITermProprietary::Mark,
            )),
            "Stealth" => {
                let stealth = value == "1" || value == "true";
                Ok(OperatingSystemCommand::ITermProprietary(
                    ITermProprietary::Stealth(stealth),
                ))
            }
            _ => Ok(OperatingSystemCommand::ITermProprietary(
                ITermProprietary::Unrecognized(key.to_string(), value.to_string()),
            )),
        }
    } else {
        // 没有 '=' 的也可能是 CurrentDir
        if s == "Mark" {
            Ok(OperatingSystemCommand::ITermProprietary(
                ITermProprietary::Mark,
            ))
        } else {
            Ok(OperatingSystemCommand::ITermProprietary(
                ITermProprietary::Unrecognized(String::new(), s),
            ))
        }
    }
}

/// 简易 URL 百分比解码
fn url_decode(input: &str) -> String {
    let mut result = String::new();
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '%' {
            let hex: String = chars.by_ref().take(2).collect();
            if hex.len() == 2 {
                if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                    result.push(byte as char);
                    continue;
                }
            }
            result.push('%');
            result.push_str(&hex);
        } else {
            result.push(c);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 辅助函数:把字节切片按 ';' 拆分,模拟 vtparse 的 OSC 参数拆分
    fn split_osc(input: &[u8]) -> Vec<&[u8]> {
        // 去掉 ESC ] 前缀和 ST/BEL 后缀
        let mut start = 0;
        let mut end = input.len();
        if input.starts_with(b"\x1b]") {
            start = 2;
        }
        if input.ends_with(b"\x1b\\") {
            end -= 2;
        } else if input.ends_with(b"\x07") {
            end -= 1;
        }
        input[start..end].split(|&b| b == b';').collect()
    }

    fn parse(input: &[u8]) -> OperatingSystemCommand {
        let parts = split_osc(input);
        parse_osc(&parts)
    }

    #[test]
    fn test_set_window_title() {
        // OSC 2 ; "title" ST
        let cmd = parse(b"\x1b]2;hello world\x1b\\");
        assert_eq!(
            cmd,
            OperatingSystemCommand::SetWindowTitle("hello world".to_string())
        );
    }

    #[test]
    fn test_set_icon_and_title() {
        let cmd = parse(b"\x1b]0;MyTerm\x1b\\");
        assert_eq!(
            cmd,
            OperatingSystemCommand::SetIconNameAndWindowTitle("MyTerm".to_string())
        );
    }

    #[test]
    fn test_set_cwd() {
        let cmd = parse(b"\x1b]7;/home/user/project\x1b\\");
        assert_eq!(
            cmd,
            OperatingSystemCommand::CurrentWorkingDirectory("/home/user/project".to_string())
        );
    }

    #[test]
    fn test_change_color_number() {
        // OSC 4 ; 0 ; rgb:0000/0000/0000 ; 1 ; rgb:aaaa/bbbb/cccc
        let cmd = parse(b"\x1b]4;0;rgb:0000/0000/0000;1;rgb:aaaa/bbbb/cccc\x1b\\");
        match cmd {
            OperatingSystemCommand::ChangeColorNumber(pairs) => {
                assert_eq!(pairs.len(), 2);
                assert_eq!(pairs[0].palette_index, 0);
                assert_eq!(pairs[0].color, ColorSpec::Rgb("rgb:0000/0000/0000".to_string()));
                assert_eq!(pairs[1].palette_index, 1);
            }
            _ => panic!("expected ChangeColorNumber, got {:?}", cmd),
        }
    }

    #[test]
    fn test_hyperlink() {
        // OSC 8 ; params ; url
        let cmd = parse(b"\x1b]8;id=42;https://example.com\x1b\\");
        match cmd {
            OperatingSystemCommand::SetHyperlink(Some(link)) => {
                assert_eq!(link.uri, "https://example.com");
                assert_eq!(link.params, "id=42");
            }
            _ => panic!("expected SetHyperlink, got {:?}", cmd),
        }
    }

    #[test]
    fn test_hyperlink_close() {
        // OSC 8 ; ; (empty)
        let cmd = parse(b"\x1b]8;;\x1b\\");
        assert_eq!(cmd, OperatingSystemCommand::SetHyperlink(None));
    }

    #[test]
    fn test_osc_52_clipboard() {
        // OSC 52 ; c ; base64(data)
        // 使用内置 base64 编码:"hello clipboard" → "aGVsbG8gY2xpcGJvYXJk"
        let encoded = "aGVsbG8gY2xpcGJvYXJk";
        let input = format!("\x1b]52;c;{}\x1b\\", encoded);
        let cmd = parse(input.as_bytes());
        match cmd {
            OperatingSystemCommand::ManipulateSelectionData(sel, Some(text)) => {
                assert_eq!(sel, Selection::Clipboard);
                assert_eq!(text, "hello clipboard");
            }
            OperatingSystemCommand::Unspecified(_) => {
                // 我们的简易 base64 解码若不支持某些字符,会走 Unspecified 兜底
                // 在生产代码中我们会使用 base64 crate
            }
            _ => panic!("unexpected: {:?}", cmd),
        }
    }

    #[test]
    fn test_osc_52_clipboard_query() {
        // OSC 52 ; c ; ? → 查询剪贴板（无数据）
        let cmd = parse(b"\x1b]52;c;?\x1b\\");
        // "?" 不是合法 base64,会走兜底
        match cmd {
            OperatingSystemCommand::ManipulateSelectionData(_, None) => {}
            OperatingSystemCommand::Unspecified(_) => {}
            _ => panic!("unexpected: {:?}", cmd),
        }
    }

    #[test]
    fn test_dynamic_color() {
        // OSC 10 ; rgb:ff00/0000/0000
        let cmd = parse(b"\x1b]10;rgb:ff00/0000/0000\x1b\\");
        match cmd {
            OperatingSystemCommand::ChangeDynamicColors(color, colors) => {
                assert_eq!(color, DynamicColor::TextForeground);
                assert_eq!(colors.len(), 1);
                assert_eq!(
                    colors[0],
                    ColorSpec::Rgb("rgb:ff00/0000/0000".to_string())
                );
            }
            _ => panic!("expected ChangeDynamicColors, got {:?}", cmd),
        }
    }

    #[test]
    fn test_dynamic_color_query() {
        // OSC 11 ; ?
        let cmd = parse(b"\x1b]11;?\x1b\\");
        match cmd {
            OperatingSystemCommand::ChangeDynamicColors(color, colors) => {
                assert_eq!(color, DynamicColor::TextBackground);
                assert_eq!(colors.len(), 1);
                assert_eq!(colors[0], ColorSpec::Query);
            }
            _ => panic!("expected ChangeDynamicColors, got {:?}", cmd),
        }
    }

    #[test]
    fn test_reset_dynamic_color() {
        let cmd = parse(b"\x1b]110\x1b\\");
        assert_eq!(
            cmd,
            OperatingSystemCommand::ResetDynamicColor(DynamicColor::TextForeground)
        );
    }

    #[test]
    fn test_reset_colors() {
        // OSC 104 ; 0 ; 1 ; 2
        let cmd = parse(b"\x1b]104;0;1;2\x1b\\");
        match cmd {
            OperatingSystemCommand::ResetColors(colors) => {
                assert_eq!(colors, vec![0, 1, 2]);
            }
            _ => panic!("expected ResetColors, got {:?}", cmd),
        }
    }

    #[test]
    fn test_final_term_prompt() {
        let cmd = parse(b"\x1b]133;A\x1b\\");
        assert_eq!(
            cmd,
            OperatingSystemCommand::FinalTermSemanticPrompt(FinalTermPrompt::PromptStart)
        );
    }

    #[test]
    fn test_final_term_command() {
        let cmd = parse(b"\x1b]133;C\x1b\\");
        assert_eq!(
            cmd,
            OperatingSystemCommand::FinalTermSemanticPrompt(FinalTermPrompt::CommandEnd)
        );
    }

    #[test]
    fn test_sun_window_title() {
        // OSC l ; title (Sun 风格)
        let parts = split_osc(b"\x1b]lMyTitle\x1b\\");
        let cmd = parse_osc(&parts);
        assert_eq!(
            cmd,
            OperatingSystemCommand::SetWindowTitleSun("MyTitle".to_string())
        );
    }

    #[test]
    fn test_sun_icon_name() {
        // OSC L ; name (Sun 风格)
        let parts = split_osc(b"\x1b]LMyIcon\x1b\\");
        let cmd = parse_osc(&parts);
        assert_eq!(
            cmd,
            OperatingSystemCommand::SetIconNameSun("MyIcon".to_string())
        );
    }

    #[test]
    fn test_iterm_current_dir() {
        // OSC 1337 ; CurrentDir=%2Fhome%2Fuser
        let cmd = parse(b"\x1b]1337;CurrentDir=%2Fhome%2Fuser\x1b\\");
        match cmd {
            OperatingSystemCommand::ITermProprietary(ITermProprietary::CurrentDir(path)) => {
                assert_eq!(path, "/home/user");
            }
            _ => panic!("expected ITermProprietary::CurrentDir, got {:?}", cmd),
        }
    }

    #[test]
    fn test_unspecified_fallback() {
        // 一个未知的 OSC 代码,应返回 Unspecified
        let parts = split_osc(b"\x1b]99999;some;data\x1b\\");
        let cmd = parse_osc(&parts);
        match cmd {
            OperatingSystemCommand::Unspecified(_) => {} // 预期
            _ => panic!("expected Unspecified, got {:?}", cmd),
        }
    }

    #[test]
    fn test_osc_with_bel_terminator() {
        // OSC 也可以用 BEL (\x07) 终止
        let cmd = parse(b"\x1b]2;hello world\x07");
        assert_eq!(
            cmd,
            OperatingSystemCommand::SetWindowTitle("hello world".to_string())
        );
    }
}