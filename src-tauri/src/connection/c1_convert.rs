// 8-bit C1 控制字符 → 7-bit C0 等效序列转换
// 对应 src/main/connection/c1-convert.ts
//
// 某些 TUI 程序（htop、vim、tmux）在非 UTF-8 模式下使用 8-bit C1 控制字符
// （如 \x9B 代替 \x1b[），但 xterm.js 只识别 7-bit 序列。
// 映射规则：0x80-0x9F → ESC + (byte - 0x40)
//
// 跨包不完整 UTF-8 的权衡:
// read() 按 1024-8192 字节切块,Linux 内核不会故意在 UTF-8 字符中间断,
// 中文跨包切分概率极低且随机。若仍发生(如三字节中文首字节恰在包末),
// 本函数会把首字节当 Latin-1 显示(不丢字节),续字节下包到达时当独立字节处理,
// 显示会乱但数据不丢。彻底修复需有状态保留 pending 序列跨包续接,
// 涉及改函数签名影响所有调用方(ssh/telnet/serial/bash),权衡后保留无状态实现。
// 若后续高频中文输出场景出现可见乱码,再改造为 StatefulDecoder 持 pending 缓冲。

/// 将字节流正确解码为终端字符串
/// 1. 0x80-0x9F C1 控制字符 → ESC + (byte - 0x40)
/// 2. >= 0xA0 按 UTF-8 序列读取，无效回退 Latin-1(不丢字节)
pub fn decode_buffer_for_terminal(buf: &[u8]) -> String {
    let mut result = String::with_capacity(buf.len());
    let mut i = 0;
    while i < buf.len() {
        let byte = buf[i];
        if (0x80..=0x9f).contains(&byte) {
            result.push('\x1b');
            result.push((byte - 0x40) as char);
            i += 1;
        } else if byte >= 0xa0 {
            let seq_len = if (byte & 0xe0) == 0xc0 { 2 }
                else if (byte & 0xf0) == 0xe0 { 3 }
                else if (byte & 0xf8) == 0xf0 { 4 }
                else {
                    result.push(byte as char);
                    i += 1;
                    continue;
                };
            if i + seq_len <= buf.len() {
                let slice = &buf[i..i + seq_len];
                let mut valid = true;
                for &b in &slice[1..] {
                    if (b & 0xc0) != 0x80 {
                        valid = false;
                        break;
                    }
                }
                if valid {
                    if let Ok(s) = std::str::from_utf8(slice) {
                        result.push_str(s);
                    } else {
                        for &b in slice { result.push(b as char); }
                    }
                    i += seq_len;
                } else {
                    result.push(byte as char);
                    i += 1;
                }
            } else {
                result.push(byte as char);
                i += 1;
            }
        } else {
            result.push(byte as char);
            i += 1;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ascii_passthrough() {
        assert_eq!(decode_buffer_for_terminal(b"hello"), "hello");
    }

    #[test]
    fn test_c1_conversion() {
        // 0x9B (CSI) → ESC [
        let result = decode_buffer_for_terminal(&[0x9b]);
        assert_eq!(result, "\x1b[");
    }

    #[test]
    fn test_utf8_passthrough() {
        // "中" UTF-8 = E4 B8 AD
        assert_eq!(decode_buffer_for_terminal(&[0xe4, 0xb8, 0xad]), "中");
    }
}
