/**
 * 8-bit C1 控制字符 → 7-bit C0 等效序列转换
 *
 * 某些 TUI 程序（如 htop、vim、tmux）在非 UTF-8 模式下使用 8-bit C1 控制字符
 * （如 \x9B 代替 \x1b[），但 xterm.js 只识别 7-bit 序列。
 * 此外，Buffer.toString('utf-8') 会将 C1 区域字节替换为 �，
 * 导致 ANSI 序列被破坏，在终端中显示为 "35;90;40M" 之类的乱码。
 *
 * C1→C0 映射规则：0x80-0x9F → ESC + (byte - 0x40)
 * 例如 0x9B (CSI) → ESC [ (0x1B 0x5B)
 */

/**
 * 将 Buffer 正确解码为终端字符串
 * 1. 将 8-bit C1 控制字符 (0x80-0x9F) 转换为 7-bit 等效序列 (ESC + byte-0x40)
 * 2. 非 ASCII 字节按 UTF-8 序列读取，无效时回退到 Latin-1
 */
export function decodeBufferForTerminal(buf: Buffer): string {
  let result = ''
  let i = 0
  while (i < buf.length) {
    const byte = buf[i]
    if (byte >= 0x80 && byte <= 0x9f) {
      result += '\x1b' + String.fromCharCode(byte - 0x40)
      i++
    } else if (byte >= 0xa0) {
      let seqLen = 1
      if ((byte & 0xe0) === 0xc0) seqLen = 2
      else if ((byte & 0xf0) === 0xe0) seqLen = 3
      else if ((byte & 0xf8) === 0xf0) seqLen = 4
      else {
        result += String.fromCharCode(byte)
        i++
        continue
      }
      if (i + seqLen <= buf.length) {
        const slice = buf.subarray(i, i + seqLen)
        let valid = true
        for (let j = 1; j < seqLen; j++) {
          if ((slice[j] & 0xc0) !== 0x80) {
            valid = false
            break
          }
        }
        if (valid) {
          result += slice.toString('utf-8')
          i += seqLen
        } else {
          result += String.fromCharCode(byte)
          i++
        }
      } else {
        result += String.fromCharCode(byte)
        i++
      }
    } else {
      result += String.fromCharCode(byte)
      i++
    }
  }
  return result
}
