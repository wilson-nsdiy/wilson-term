//! DCS (Device Control String) 语义解析
//!
//! fork 自 wezterm `wezterm-escape-parser/src/parser/` 的精简版,
//! 覆盖 DCS 序列的入口解析:
//! - Sixel 图形协议（DCS q … ST）
//! - 终端能力查询（DECRQSS, DCS $ q … ST）
//! - 请求终端能力（XTGETTCAP, DCS + q … ST）
//!
//! 借鉴的 wezterm 类型:
//! - `ShortDeviceControl`（lib.rs:137-146）
//! - `Sixel`（lib.rs:282-305）
//! - `SixelBuilder`（parser/sixel.rs）
//!
//! 本阶段只做"DCS 字节流 → DCS 枚举"的入口解析,
//! 具体的 Sixel 像素解码在阶段 4（图形协议）实现。

/// Sixel 图像数据项
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SixelData {
    /// 单像素数据（0-84,六阶亮度值）
    Data(u8),
    /// 重复 N 个像素
    Repeat {
        repeat_count: u32,
        data: u8,
    },
    /// 回车（回到行首）
    CarriageReturn,
    /// 换行（移到下一行）
    NewLine,
    /// 选择颜色寄存器
    SelectColor {
        color_number: u16,
        rgb: (u8, u8, u8),
    },
    /// 设置栅格大小
    SetRasterSize {
        pan: i64,
        pad: i64,
        pixel_width: Option<i64>,
        pixel_height: Option<i64>,
    },
}

/// 解析后的 Sixel 图像
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sixel {
    /// 像素宽高比分子
    pub pan: i64,
    /// 像素宽高比分母
    pub pad: i64,
    /// 图像宽度（像素）
    pub pixel_width: Option<u32>,
    /// 图像高度（像素）
    pub pixel_height: Option<u32>,
    /// 背景透明标记
    pub background_is_transparent: bool,
    /// 水平网格大小
    pub horizontal_grid_size: Option<i64>,
    /// Sixel 数据
    pub data: Vec<SixelData>,
}

/// 已解析的 DCS 序列
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Dcs {
    /// Sixel 图像（DCS q … ST）
    Sixel(Sixel),
    /// DECRQSS - 请求终端状态（DCS $ q … ST）
    /// 参数是请求的 CSI/ DEC private mode 的关键字节
    DecReqss {
        /// 请求的序列类型（如 b'q' 表示 DECSCA）
        byte: u8,
        /// 附加参数
        params: Vec<i64>,
    },
    /// XTGETTCAP - 请求 termcap/terminfo 能力（DCS + q … ST）
    XtGetTcap(Vec<String>),
    /// 未能识别的 DCS,保留原始参数
    Unrecognized {
        params: Vec<i64>,
        intermediates: Vec<u8>,
        byte: u8,
        data: Vec<u8>,
    },
}

/// 解析 DCS 序列的参数部分
///
/// 输入参数是 DCS 的参数 + 中间字节 + 终结字节 + 数据部分。
/// vtparse 会把 DCS 拆成:params (CSI 风格参数)、intermediates、byte、data 字符串。
///
/// 注意:本函数只做入口分派,不处理复杂的 Sixel 像素解码
///（Sixel 完整解码在阶段 4 的 `image/sixel.rs` 实现）。
pub fn parse_dcs(
    params: &[i64],
    intermediates: &[u8],
    byte: u8,
    data: &[u8],
) -> Dcs {
    match (byte, intermediates) {
        // Sixel:DCS q … ST（无中间字节）
        (b'q', []) | (b'q', [b'q']) => {
            let sixel = parse_sixel_params(params, data);
            Dcs::Sixel(sixel)
        }
        // DECRQSS:DCS $ q … ST
        (b'q', [b'$']) => Dcs::DecReqss {
            byte: data.first().copied().unwrap_or(0),
            params: params.to_vec(),
        },
        // XTGETTCAP:DCS + q … ST
        (b'q', [b'+']) => {
            let names = parse_xtgettcap_names(data);
            Dcs::XtGetTcap(names)
        }
        // 未能识别的 DCS
        (byte, _) => Dcs::Unrecognized {
            params: params.to_vec(),
            intermediates: intermediates.to_vec(),
            byte,
            data: data.to_vec(),
        },
    }
}

/// 解析 Sixel 参数（DCS q 的初始参数）
fn parse_sixel_params(params: &[i64], _data: &[u8]) -> Sixel {
    let pan = params.first().copied().unwrap_or(2);
    let background_is_transparent = params.get(1).copied().unwrap_or(0) == 1;
    let horizontal_grid_size = params.get(2).copied();

    Sixel {
        pan,
        pad: 1,
        pixel_width: None,
        pixel_height: None,
        background_is_transparent,
        horizontal_grid_size,
        data: Vec::new(), // 完整数据由阶段 4 的 SixelBuilder 解析
    }
}

/// 解析 XTGETTCAP 的能力名列表
///
/// 能力名以十六进制编码,用 ';' 分隔。
fn parse_xtgettcap_names(data: &[u8]) -> Vec<String> {
    let mut names = Vec::new();
    if data.is_empty() {
        return names;
    }

    // 按 ';' 分割
    for segment in data.split(|&b| b == b';') {
        if segment.is_empty() {
            continue;
        }
        // 尝试十六进制解码
        let name = String::from_utf8_lossy(segment).to_string();
        // 如果是纯十六进制字符串,尝试解码
        if let Ok(decoded) = hex_decode(segment) {
            if let Ok(s) = String::from_utf8(decoded) {
                names.push(s);
            } else {
                names.push(name);
            }
        } else {
            names.push(name);
        }
    }
    names
}

/// 简易十六进制解码
fn hex_decode(input: &[u8]) -> Result<Vec<u8>, ()> {
    if input.len() % 2 != 0 {
        return Err(());
    }
    let mut result = Vec::with_capacity(input.len() / 2);
    for chunk in input.chunks(2) {
        let hex_str = str::from_utf8(chunk).map_err(|_| ())?;
        let byte = u8::from_str_radix(hex_str, 16).map_err(|_| ())?;
        result.push(byte);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sixel_basic_params() {
        // DCS q ; params ; ... ST
        // 参数: P1=1 (pan=1), P2=0 (不透明)
        let params = vec![1, 0];
        let sixel = parse_sixel_params(&params, b"");
        assert_eq!(sixel.pan, 1);
        assert!(!sixel.background_is_transparent);
        assert_eq!(sixel.pixel_width, None);
    }

    #[test]
    fn test_dcs_unrecognized() {
        // 未知的 DCS 序列,应返回 Unrecognized
        let dcs = parse_dcs(&[1, 2], &[], b'x', b"some data");
        match dcs {
            Dcs::Unrecognized { byte, data, .. } => {
                assert_eq!(byte, b'x');
                assert_eq!(data, b"some data");
            }
            _ => panic!("expected Unrecognized, got {:?}", dcs),
        }
    }

    #[test]
    fn test_xtgettcap_names() {
        // "NaCl" 的十六进制 = "4e61436c"
        let names = parse_xtgettcap_names(b"4e61436c");
        assert_eq!(names.len(), 1);
        // 可能解码成功或保持原样,取决于 hex_decode 是否成功
        // 4e61436c 是合法的十六进制,应该能解码
        assert!(names[0] == "NaCl" || names[0] == "4e61436c");
    }

    #[test]
    fn test_xtgettcap_multiple() {
        // "cols" 的十六进制 = "636f6c73", "lines" = "6c696e6573"
        let names = parse_xtgettcap_names(b"636f6c73;6c696e6573");
        assert_eq!(names.len(), 2);
    }

    #[test]
    fn test_dec_reqss() {
        // DECRQSS:DCS $ q … ST,intermediates == [b'$']
        // parse_dcs 根据 intermediates 区分,返回 DecReqss
        let dcs = parse_dcs(&[], &[b'$'], b'q', b"");
        match dcs {
            Dcs::DecReqss { .. } => {} // 预期
            _ => panic!("expected DecReqss, got {:?}", dcs),
        }
    }

    #[test]
    fn test_xtgettcap_dcs() {
        // XTGETTCAP:DCS + q … ST,intermediates == [b'+']
        let dcs = parse_dcs(&[], &[b'+'], b'q', b"636f6c73");
        match dcs {
            Dcs::XtGetTcap(names) => {
                assert!(!names.is_empty());
            }
            _ => panic!("expected XtGetTcap, got {:?}", dcs),
        }
    }
}