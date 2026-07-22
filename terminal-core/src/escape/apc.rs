//! APC (Application Program Command) 语义解析
//!
//! fork 自 wezterm `wezterm-escape-parser/src/apc.rs` 的精简版,
//! 覆盖 Kitty 图形协议的入口解析:
//! - APC G … ST 表示 Kitty 图形协议帧
//! - 帧 payload 是 key=value 形式的控制字段 + 可选传输数据
//! - 传输模式:t=d 直接 / t=f 文件 / t=t 临时文件 / t=s 共享内存
//! - 控制:do delete / dq query / dq close / dd free / dd free
//!
//! 借鉴的 wezterm 类型:
//! - `KittyImageData`（apc.rs:20-65）
//! - `KittyImageFormat`（apc.rs:466-494）
//! - `KittyImageCompression`（apc.rs:496-520）
//! - `KittyImageTransmit`（apc.rs:522-579）
//! - `KittyImagePlacement`（apc.rs:581-628）
//! - `KittyImage`（apc.rs:1030+）
//!
//! 本阶段只做"APC 字节流 → KittyImage 枚举"的解析,
//! 不触及实际的图形解码（阶段 4 的 `image/kitty.rs` 实现）。

use std::collections::BTreeMap;

/// Kitty 图形数据传输方式
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KittyImageData {
    /// 直接传输（t=d）,payload 是原始图像数据
    Direct(Vec<u8>),
    /// 直接传输（t=d）,payload 是 base64 编码字符串
    DirectBase64(String),
    /// 从文件传输（t=f）,path 是图像文件路径
    File {
        path: String,
        data_size: Option<u32>,
        data_offset: Option<u32>,
    },
    /// 从临时文件传输（t=t）,读取后应删除临时文件
    TemporaryFile {
        path: String,
        data_size: Option<u32>,
        data_offset: Option<u32>,
    },
    /// 从共享内存传输（t=s）
    SharedMem {
        name: String,
        data_size: Option<u32>,
        data_offset: Option<u32>,
    },
}

/// Kitty 图形像素格式
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum KittyImageFormat {
    /// f=24:RGB
    Rgb,
    /// f=32:RGBA
    Rgba,
    /// f=100:PNG
    Png,
}

impl KittyImageFormat {
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "24" => Some(Self::Rgb),
            "32" => Some(Self::Rgba),
            "100" => Some(Self::Png),
            _ => None,
        }
    }
}

/// Kitty 图形压缩方式
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum KittyImageCompression {
    /// o=z:zlib deflate
    Deflate,
    /// o=o:zlib deflate + 形状
    Other(u8),
}

/// Kitty 图形传输参数
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KittyImageTransmit {
    /// f=...
    pub format: Option<KittyImageFormat>,
    /// t=... + payload
    pub data: KittyImageData,
    /// s=...
    pub width: Option<u32>,
    /// v=...
    pub height: Option<u32>,
    /// i=...
    pub image_id: Option<u32>,
    /// I=...
    pub image_number: Option<u32>,
    /// o=...
    pub compression: Option<KittyImageCompression>,
    /// m=0 或 m=1:是否还有后续帧
    pub more_data_follows: bool,
}

/// Kitty 图形 Placement 参数
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KittyImagePlacement {
    /// x/y/w/h=...
    pub src_x: Option<u32>,
    pub src_y: Option<u32>,
    pub src_w: Option<u32>,
    pub src_h: Option<u32>,
    /// X/Y=...
    pub x_offset: Option<u32>,
    pub y_offset: Option<u32>,
    /// c=...
    pub columns: Option<u32>,
    /// r=...
    pub rows: Option<u32>,
    /// z=...
    pub z_index: Option<i32>,
}

/// Kitty 图形控制命令
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KittyImageControl {
    /// do=... / dq=... / dc=... / dd=...:控制命令
    /// do delete image; dq query image; dc close; dd free
    DeleteImages(Vec<u32>),
    /// dq=...:查询图像信息
    QueryImages(Vec<u32>),
    /// dc=...:关闭数据传输通道
    Close(Vec<u32>),
    /// dd=...:释放图像数据
    Free(Vec<u32>),
}

/// 已解析的 Kitty 图形协议帧
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KittyImage {
    /// 传输新图像帧
    Transmit {
        control: Option<KittyImageControl>,
        transmit: KittyImageTransmit,
        placement: KittyImagePlacement,
    },
    /// 控制命令帧（do / dq / dc / dd）
    Control(KittyImageControl),
    /// 未能识别的 APC 帧,保留原始 payload
    Unrecognized(Vec<u8>),
}

/// 解析 APC payload 为 Kitty 图形帧
///
/// 输入是 APC 的 payload（已去掉 ESC G 前缀和 ST 后缀）。
/// payload 格式:逗号分隔的 key=value 字段,最后一个字段可能是 payload。
///
/// 控制命令通过 do/dq/dc/dd 键区分,传输帧通过 t/f/s/v/c 键识别。
pub fn parse_apc(payload: &[u8]) -> KittyImage {
    parse_kitty(payload).unwrap_or_else(|| KittyImage::Unrecognized(payload.to_vec()))
}

fn parse_kitty(payload: &[u8]) -> Option<KittyImage> {
    // payload 是 key=value,以逗号分隔
    // 找第一个 '=' 前的键名,判断是否是控制命令
    let (keys_map, image_payload) = parse_keys(payload);

    // 控制命令:do / dq / dc / dd
    if let Some(do_val) = keys_map.get("do") {
        return Some(KittyImage::Control(KittyImageControl::DeleteImages(
            parse_id_list(do_val),
        )));
    }
    if let Some(dq_val) = keys_map.get("dq") {
        return Some(KittyImage::Control(KittyImageControl::QueryImages(
            parse_id_list(dq_val),
        )));
    }
    if let Some(dc_val) = keys_map.get("dc") {
        return Some(KittyImage::Control(KittyImageControl::Close(parse_id_list(
            dc_val,
        ))));
    }
    if let Some(dd_val) = keys_map.get("dd") {
        return Some(KittyImage::Control(KittyImageControl::Free(parse_id_list(
            dd_val,
        ))));
    }

    // 传输帧:必须有 t 或 payload
    let transmit = KittyImageTransmit::from_keys(&keys_map, image_payload)?;

    // Placement
    let placement = KittyImagePlacement::from_keys(&keys_map);

    Some(KittyImage::Transmit {
        control: None,
        transmit,
        placement,
    })
}

/// 解析 payload 为 (keys_map, image_payload)
///
/// payload 是逗号分隔的 key=value 字段。最后一个字段若是 payload,
/// 则其键名会是 "payload" 或直接是原始数据。
fn parse_keys(payload: &[u8]) -> (BTreeMap<&'static str, String>, &[u8]) {
    let mut keys: BTreeMap<&'static str, String> = BTreeMap::new();
    let mut image_payload: &[u8] = &[];

    // 找到 payload 键名后的原始数据起始
    // payload 键名固定为 "payload",其值是 raw bytes
    let payload_key_start = find_key_value(payload, b"payload");

    let (header, rest) = if let Some(pos) = payload_key_start {
        // 从 payload=value 处分割
        (&payload[..pos], &payload[pos + b"payload=".len()..])
    } else {
        // 没有显式 payload 键,整个 payload 都当作 key=value
        (payload, &[][..])
    };

    // 解析 header 的 key=value 字段
    // 对控制命令（do/dq/dc/dd）做特殊处理:其值延伸到下一个键=value 或 header 结尾
    parse_fields(header, &mut keys);

    if !rest.is_empty() {
        // payload 的值后面可能还跟着 key=value 字段（如 "t=s,payload=myshm, S=1024"）
        // 这种情况下 payload 值只到下一个键=value 为止,后续字段继续解析进 keys
        let payload_end = find_next_keyed_field(rest).unwrap_or(rest.len());
        // 剥去 payload 值末尾的逗号（payload_end 处可能正好在下一个键的逗号之后）
        let mut payload_end_trimmed = payload_end;
        while payload_end_trimmed > 0 && rest[payload_end_trimmed - 1] == b',' {
            payload_end_trimmed -= 1;
        }
        image_payload = &rest[..payload_end_trimmed];
        if payload_end < rest.len() {
            // 剩下的部分形如 "S=1024,O=0",继续解析进 keys
            parse_fields(&rest[payload_end..], &mut keys);
        }
    }

    (keys, image_payload)
}

/// 解析 header 的 key=value 字段,对控制命令做特殊处理
fn parse_fields(header: &[u8], keys: &mut BTreeMap<&'static str, String>) {
    let mut field_start = 0usize;
    let bytes = header;

    while field_start < bytes.len() {
        let remaining = &bytes[field_start..];
        // 找当前字段的 '=' 或 ',' 位置
        let sep_pos = match remaining
            .iter()
            .position(|&b| b == b'=' || b == b',')
        {
            Some(p) => p,
            None => return, // 剩下的都是无键内容,跳过
        };

        if remaining[sep_pos] == b',' {
            // 没有 '=' 的字段（可能是控制命令值的续部分）,跳过
            field_start += sep_pos + 1;
            continue;
        }

        let key = &remaining[..sep_pos];
        let value_start = field_start + sep_pos + 1;

        // 检查是否是控制命令（do/dq/dc/dd）,其值可能延伸到下一个键=value
        let is_control_cmd = matches!(key, b"do" | b"dq" | b"dc" | b"dd");

        // 找下一个字段的起始位置,以及当前 value 的结束位置（不含分隔符）
        let (value_end, next_field_start) = if is_control_cmd {
            // 控制命令:值延伸到下一个 "key=" 字段或 header 结尾
            let next = find_next_keyed_field(&bytes[value_start..])
                .map(|p| value_start + p)
                .unwrap_or(bytes.len());
            (next, next)
        } else {
            // 普通 key=value:下一个字段在逗号之后
            match bytes[value_start..]
                .iter()
                .position(|&b| b == b',')
            {
                Some(p) => {
                    // value 不含逗号;下一个字段在逗号之后
                    (value_start + p, value_start + p + 1)
                }
                None => (bytes.len(), bytes.len()),
            }
        };

        let value_end = value_end.min(bytes.len());
        let value = &bytes[value_start..value_end];

        if let Some(static_key) = static_key_name(key) {
            keys.insert(static_key, String::from_utf8_lossy(value).to_string());
        }

        if next_field_start >= bytes.len() {
            return;
        }
        field_start = next_field_start;
    }
}

/// 找下一个 "key=value" 字段的起始位置（跳过形如 `,123,456` 的无键续部分）
///
/// 输入是 header 中从某个 value 起始的切片。本函数返回下一个 key=value 的
/// 起始字节偏移（相对于本切片）,找不到则返回 None。
fn find_next_keyed_field(slice: &[u8]) -> Option<usize> {
    let mut pos = 0usize;
    while pos < slice.len() {
        if slice[pos] == b',' {
            let after = &slice[pos + 1..];
            let next_sep = after
                .iter()
                .position(|&b| b == b'=' || b == b',')?;
            if after[next_sep] == b'=' {
                return Some(pos + 1);
            }
            pos += 1 + next_sep + 1;
        } else {
            pos += 1;
        }
    }
    None
}

/// 把键名转为 &'static str
///
/// 我们使用固定的键名集合,这样能避免在 BTreeMap 里持有 String 键名
/// 带来的生命周期管理问题。
fn static_key_name(key: &[u8]) -> Option<&'static str> {
    match key {
        b"t" => Some("t"),
        b"s" => Some("s"),
        b"v" => Some("v"),
        b"i" => Some("i"),
        b"I" => Some("I"),
        b"f" => Some("f"),
        b"o" => Some("o"),
        b"m" => Some("m"),
        b"x" => Some("x"),
        b"y" => Some("y"),
        b"w" => Some("w"),
        b"h" => Some("h"),
        b"X" => Some("X"),
        b"Y" => Some("Y"),
        b"c" => Some("c"),
        b"r" => Some("r"),
        b"z" => Some("z"),
        b"q" => Some("q"),
        b"do" => Some("do"),
        b"dq" => Some("dq"),
        b"dc" => Some("dc"),
        b"dd" => Some("dd"),
        b"payload" => Some("payload"),
        _ => None,
    }
}

/// 找 payload 中 "key=value" 子串的起始位置
///
/// 我们需要找到形如 ",payload=" 或 "^payload=" 的子串,
/// 因为 payload 的值是原始数据,不能再按逗号分割。
fn find_key_value(payload: &[u8], key: &[u8]) -> Option<usize> {
    // 构造 ",payload=" 和 "payload=" 两种 needle
    let mut needle1 = Vec::with_capacity(1 + key.len() + 1);
    needle1.push(b',');
    needle1.extend_from_slice(key);
    needle1.push(b'=');

    let mut needle2 = Vec::with_capacity(key.len() + 1);
    needle2.extend_from_slice(key);
    needle2.push(b'=');

    // 先找 ",payload=" 的位置
    if let Some(pos) = find_subslice(payload, &needle1) {
        return Some(pos + 1); // 跳过逗号
    }
    // 找 "^payload=" 的位置
    if payload.starts_with(&needle2) {
        return Some(0);
    }
    None
}

/// 在 payload 中找 sub 的位置
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack
        .windows(needle.len())
        .position(|w| w == needle)
}

/// 解析 ID 列表（如 "1,2,3" 或 "*"）
fn parse_id_list(s: &str) -> Vec<u32> {
    if s == "*" {
        return Vec::new(); // 用空 Vec 表示"所有"
    }
    s.split(',')
        .filter_map(|n| n.parse().ok())
        .collect()
}

impl KittyImageTransmit {
    fn from_keys(keys: &BTreeMap<&'static str, String>, payload: &[u8]) -> Option<Self> {
        let format = keys
            .get("f")
            .and_then(|s| KittyImageFormat::from_str(s));

        let data = KittyImageData::from_keys(keys, payload)?;

        let compression = keys.get("o").map(|s| match s.as_str() {
            "z" => KittyImageCompression::Deflate,
            _ => KittyImageCompression::Other(0),
        });

        let more_data_follows = match keys.get("m").map(|s| s.as_str()) {
            None | Some("0") => false,
            Some("1") => true,
            _ => return None,
        };

        Some(Self {
            format,
            data,
            width: keys.get("s").and_then(|s| s.parse().ok()),
            height: keys.get("v").and_then(|s| s.parse().ok()),
            image_id: keys.get("i").and_then(|s| s.parse().ok()),
            image_number: keys.get("I").and_then(|s| s.parse().ok()),
            compression,
            more_data_follows,
        })
    }
}

impl KittyImageData {
    fn from_keys(keys: &BTreeMap<&'static str, String>, payload: &[u8]) -> Option<Self> {
        let t = keys.get("t").map(|s| s.as_str()).unwrap_or("d");

        match t {
            "d" => {
                // 直接传输:payload 是图像数据
                if payload.is_empty() {
                    // 也可能是 base64 编码字符串放在 payload 字段
                    // 但这里我们简单处理:payload 为空时用空 Vec
                    Some(Self::Direct(Vec::new()))
                } else {
                    Some(Self::Direct(payload.to_vec()))
                }
            }
            "f" => Some(Self::File {
                path: String::from_utf8(payload.to_vec()).ok()? ,
                data_size: keys.get("S").and_then(|s| s.parse().ok()),
                data_offset: keys.get("O").and_then(|s| s.parse().ok()),
            }),
            "t" => Some(Self::TemporaryFile {
                path: String::from_utf8(payload.to_vec()).ok()? ,
                data_size: keys.get("S").and_then(|s| s.parse().ok()),
                data_offset: keys.get("O").and_then(|s| s.parse().ok()),
            }),
            "s" => Some(Self::SharedMem {
                name: String::from_utf8(payload.to_vec()).ok()? ,
                data_size: keys.get("S").and_then(|s| s.parse().ok()),
                data_offset: keys.get("O").and_then(|s| s.parse().ok()),
            }),
            _ => None,
        }
    }
}

impl KittyImagePlacement {
    fn from_keys(keys: &BTreeMap<&'static str, String>) -> Self {
        Self {
            src_x: keys.get("x").and_then(|s| s.parse().ok()),
            src_y: keys.get("y").and_then(|s| s.parse().ok()),
            src_w: keys.get("w").and_then(|s| s.parse().ok()),
            src_h: keys.get("h").and_then(|s| s.parse().ok()),
            x_offset: keys.get("X").and_then(|s| s.parse().ok()),
            y_offset: keys.get("Y").and_then(|s| s.parse().ok()),
            columns: keys.get("c").and_then(|s| s.parse().ok()),
            rows: keys.get("r").and_then(|s| s.parse().ok()),
            z_index: keys.get("z").and_then(|s| s.parse().ok()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(input: &[u8]) -> KittyImage {
        // 去掉 ESC G 前缀和 ST 后缀
        let mut start = 0;
        let mut end = input.len();
        if input.starts_with(b"\x1bG") {
            start = 2;
        }
        if input.ends_with(b"\x1b\\") {
            end -= 2;
        }
        parse_apc(&input[start..end])
    }

    #[test]
    fn test_kitty_direct_transmit() {
        // APC G f=24,s=10,v=10,payload=<raw>\x1b\\
        let payload = b"f=24,s=10,v=10,payload=abcde";
        let img = parse(payload);
        match img {
            KittyImage::Transmit { transmit, .. } => {
                assert_eq!(transmit.format, Some(KittyImageFormat::Rgb));
                assert_eq!(transmit.width, Some(10));
                assert_eq!(transmit.height, Some(10));
                match transmit.data {
                    KittyImageData::Direct(d) => {
                        assert_eq!(d, b"abcde");
                    }
                    _ => panic!("expected Direct, got {:?}", transmit.data),
                }
            }
            _ => panic!("expected Transmit, got {:?}", img),
        }
    }

    #[test]
    fn test_kitty_control_delete() {
        // APC G do=1,2,3
        let payload = b"do=1,2,3";
        let img = parse(payload);
        match img {
            KittyImage::Control(KittyImageControl::DeleteImages(ids)) => {
                assert_eq!(ids, vec![1, 2, 3]);
            }
            _ => panic!("expected Control::DeleteImages, got {:?}", img),
        }
    }

    #[test]
    fn test_kitty_control_query() {
        let payload = b"dq=5";
        let img = parse(payload);
        match img {
            KittyImage::Control(KittyImageControl::QueryImages(ids)) => {
                assert_eq!(ids, vec![5]);
            }
            _ => panic!("expected Control::QueryImages, got {:?}", img),
        }
    }

    #[test]
    fn test_kitty_file_transmit() {
        // APC G t=f,payload=/path/to/image.png
        let payload = b"t=f,payload=/path/to/image.png";
        let img = parse(payload);
        match img {
            KittyImage::Transmit { transmit, .. } => {
                match transmit.data {
                    KittyImageData::File { path, .. } => {
                        assert_eq!(path, "/path/to/image.png");
                    }
                    _ => panic!("expected File, got {:?}", transmit.data),
                }
            }
            _ => panic!("expected Transmit, got {:?}", img),
        }
    }

    #[test]
    fn test_kitty_more_data_follows() {
        // APC G m=1,payload=<partial>
        let payload = b"m=1,payload=abc";
        let img = parse(payload);
        match img {
            KittyImage::Transmit { transmit, .. } => {
                assert!(transmit.more_data_follows);
            }
            _ => panic!("expected Transmit, got {:?}", img),
        }
    }

    #[test]
    fn test_kitty_placement() {
        // APC G x=10,y=20,w=100,h=200,c=5,r=5,payload=data
        let payload = b"x=10,y=20,w=100,h=200,c=5,r=5,payload=data";
        let img = parse(payload);
        match img {
            KittyImage::Transmit { placement, .. } => {
                assert_eq!(placement.src_x, Some(10));
                assert_eq!(placement.src_y, Some(20));
                assert_eq!(placement.src_w, Some(100));
                assert_eq!(placement.src_h, Some(200));
                assert_eq!(placement.columns, Some(5));
                assert_eq!(placement.rows, Some(5));
            }
            _ => panic!("expected Transmit, got {:?}", img),
        }
    }

    #[test]
    fn test_kitty_rgba_format() {
        // APC G f=32,s=5,v=5,payload=<rgba>
        let payload = b"f=32,s=5,v=5,payload=rgba";
        let img = parse(payload);
        match img {
            KittyImage::Transmit { transmit, .. } => {
                assert_eq!(transmit.format, Some(KittyImageFormat::Rgba));
            }
            _ => panic!("expected Transmit, got {:?}", img),
        }
    }

    #[test]
    fn test_kitty_png_format() {
        let payload = b"f=100,payload=png-bytes";
        let img = parse(payload);
        match img {
            KittyImage::Transmit { transmit, .. } => {
                assert_eq!(transmit.format, Some(KittyImageFormat::Png));
            }
            _ => panic!("expected Transmit, got {:?}", img),
        }
    }

    #[test]
    fn test_kitty_unrecognized() {
        // 不含任何已知键的 payload,应返回 Unrecognized
        let payload = b"unknown=stuff";
        let img = parse(payload);
        match img {
            KittyImage::Unrecognized(_) => {} // 预期
            KittyImage::Transmit { .. } => {
                // 也可能被当作 t=d 的直接传输（默认）,这是可接受的
            }
            _ => panic!("unexpected: {:?}", img),
        }
    }

    #[test]
    fn test_kitty_delete_all() {
        // do=* 表示删除所有图像
        let payload = b"do=*";
        let img = parse(payload);
        match img {
            KittyImage::Control(KittyImageControl::DeleteImages(ids)) => {
                assert!(ids.is_empty()); // 空 Vec 表示"所有"
            }
            _ => panic!("expected Control::DeleteImages, got {:?}", img),
        }
    }

    #[test]
    fn test_kitty_shared_mem() {
        // t=s,payload=<name>
        let payload = b"t=s,payload=myshm, S=1024, O=0";
        let img = parse(payload);
        match img {
            KittyImage::Transmit { transmit, .. } => {
                match transmit.data {
                    KittyImageData::SharedMem { name, .. } => {
                        assert_eq!(name, "myshm");
                    }
                    _ => panic!("expected SharedMem, got {:?}", transmit.data),
                }
            }
            _ => panic!("expected Transmit, got {:?}", img),
        }
    }
}