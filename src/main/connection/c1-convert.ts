/**
 * 流式 UTF-8 解码器 —— 字节流 → 终端字符串
 *
 * 设计参考 WezTerm (wezterm-escape-parser / vtparse) 的 UTF-8 解码策略：
 *   "WezTerm considers the output from the terminal to be a UTF-8 encoded
 *    stream of codepoints. No other encoding is supported.
 *    The 8-bit values are recognized, but only if the 8-bit value is treated
 *    as a unicode code point and encoded via a UTF-8 multi-byte sequence.
 *    Sending the 8-bit binary value will not be recognized as intended, as
 *    those bitsequences are passing through a UTF-8 decoder."
 *
 * 关键洞察：
 * 1. C1 控制字符的字节范围 (0x80-0x9F) 与 UTF-8 continuation bytes
 *    (0x80-0xBF) 重叠。无法在字节层面区分"裸 8-bit C1"和"UTF-8 多字节
 *    字符的 continuation byte"。
 * 2. WezTerm 的解决：只支持 UTF-8，不识别裸 8-bit C1。裸 0x80-0x9F 字节
 *    被 UTF-8 解码器视为非法 continuation byte，输出 U+FFFD 替换字符，
 *    不会触发任何 C1 控制动作。
 * 3. 真正的 8-bit C1 控制字符以 UTF-8 多字节序列形式出现：例如 RI (U+008D)
 *    编码为 0xC2 0x8D，CSI (U+009B) 编码为 0xC2 0x9B。这些序列被 UTF-8
 *    解码器正确识别为 C1 码点，随后由调用方（或 xterm.js）处理。
 *
 * 实现要点：
 * - 跨 chunk 的 UTF-8 解码状态：SSH/Telnet/串口/node-pty 的 stream.on('data')
 *   的 Buffer 切分点随机，多字节字符可能被切到两个 chunk。本解码器持有"等待中"
 *   的字节缓冲，能跨调用正确拼出完整字符。
 * - 完整的 UTF-8 验证：检查 continuation bytes 的 0xC0 掩码，以及过度长编码
 *   (overlong encoding) 和代理对范围。
 * - 非法字节回退策略：独立的 continuation byte (0x80-0xBF) 在 UTF-8 中非法，
 *   WezTerm 的处理是输出 U+FFFD。本实现沿用此策略，避免裸 8-bit C1 误触发。
 *
 * 修复的 bug：旧版 decodeBufferForTerminal 把 UTF-8 多字节字符的 continuation
 * byte 0x8D 误转成 ESC M (RI 反向索引)，导致光标上移、后续字符被覆盖。
 * 例子：位字 (UTF-8 E4 BD 8D) 被 SSH stream 切到 [E4 BD] + [8D] 两个 chunk，
 * 旧逻辑把 8D 转为 ESC M，注入光标控制序列，破坏 TUI 布局。
 */

/** 跨 chunk UTF-8 解码状态 */
interface Utf8State {
  /** 等待中的多字节序列字节（已收到但未拼成完整字符） */
  pending: number[]
  /** 当前序列的期望总长度 */
  expectedLen: number
}

/**
 * 流式 UTF-8 解码器。
 *
 * 每次 feed() 接受一段字节，返回解码后的字符串。内部保持 pending 状态，
 * 可正确处理多字节字符跨 chunk 边界的情况。
 *
 * 解码规则：
 * - 0x00-0x7F：单字节 ASCII，直接输出
 * - 0xC2-0xDF：2 字节序列，解码为 U+0080-U+07FF
 * - 0xE0-0xEF：3 字节序列，解码为 U+0800-U+FFFF
 * - 0xF0-0xF4：4 字节序列，解码为 U+10000-U+10FFFF
 * - 0xC0-0xC1：过度长编码，非法，输出 U+FFFD
 * - 0x80-0xBF：独立 continuation byte，非法，输出 U+FFFD
 * - 0xF5-0xFF：超出 Unicode 范围，非法，输出 U+FFFD
 *
 * 非法序列不消耗后续字节（不吞字节），保持解码器与输入流同步。
 */
export class StreamUtf8Decoder {
  private state: Utf8State = { pending: [], expectedLen: 0 }

  /**
   * 喂入一段字节，返回解码后的字符串。
   * 多字节字符跨 chunk 边界时，本调用可能返回空字符串，
   * 下一次 feed() 调用会补全。
   */
  feed(buf: Buffer): string {
    let result = ''
    let i = 0

    // 先尝试补全上次未完成的序列
    if (this.state.pending.length > 0) {
      while (this.state.pending.length < this.state.expectedLen && i < buf.length) {
        const next = buf[i]
        // 补全的必须是合法 continuation byte (0x80-0xBF)。
        // 若不是，pending 序列非法：立即输出 U+FFFD，清空 pending，
        // 且不消耗 buf[i] —— 让主循环重新处理这个字节（可能是 ASCII、
        // 新的 lead byte 或另一个非法字节）。这避免了把后续合法字节
        // 误并入坏序列、然后整体丢弃的数据丢失 bug。
        if ((next & 0xc0) !== 0x80) {
          // pending 后续字节非法：输出 U+FFFD、清空 pending、不消耗 buf[i]
          // （让主循环重新处理这个字节，避免吞掉后续合法字节）
          result += '\uFFFD'
          this.state.pending = []
          this.state.expectedLen = 0
          break
        }
        this.state.pending.push(next)
        i++
      }
      // 若 while 因 i 用尽退出而 pending 仍不完整，等待下次 feed
      if (this.state.pending.length > 0 && this.state.pending.length >= this.state.expectedLen) {
        // 序列已完整，尝试解码
        result += this.tryDecodePending()
      } else if (this.state.pending.length === 0) {
        // pending 已被上面 break 清空，主循环从当前 i 继续
      }
    }

    // 处理剩余字节
    while (i < buf.length) {
      const byte = buf[i]

      if (byte <= 0x7f) {
        // ASCII 单字节
        result += String.fromCharCode(byte)
        i++
        continue
      }

      // 多字节序列起始字节
      let seqLen: number
      if (byte >= 0xc2 && byte <= 0xdf) {
        seqLen = 2
      } else if (byte >= 0xe0 && byte <= 0xef) {
        seqLen = 3
      } else if (byte >= 0xf0 && byte <= 0xf4) {
        seqLen = 4
      } else {
        // 0xC0-0xC1 (过度长编码), 0xF5-0xFF (超出范围), 0x80-0xBF (独立 continuation)
        // 均为非法 UTF-8 起始字节，输出替换字符并跳过此字节
        result += '\uFFFD'
        i++
        continue
      }

      // 收集完整序列
      const seq: number[] = [byte]
      let j = 1
      while (j < seqLen && i + j < buf.length) {
        const next = buf[i + j]
        // 同步检查：若中途遇到非 continuation byte，立即停止收集。
        // 已收集的部分是非法序列，输出一个 U+FFFD 并只消耗已验证的字节，
        // 让主循环从非法字节处重新开始（避免吞掉后续合法字节）。
        if ((next & 0xc0) !== 0x80) {
          result += '\uFFFD'
          i += j // 跳过已收集的字节（lead byte + 0 个或多个无效 continuation）
          seq.length = 0 // 标记已处理
          break
        }
        seq.push(next)
        j++
      }

      if (seq.length === 0) {
        // 上面 break 已处理，继续主循环
        continue
      }

      if (j < seqLen) {
        // 序列跨 chunk 边界，保存 pending 状态等待下次 feed
        this.state.pending = seq
        this.state.expectedLen = seqLen
        i = buf.length // 退出循环，剩余字节已在 seq 中
        break
      }

      // 序列在本 chunk 内完整，验证并解码
      result += this.decodeSequence(seq)
      i += seqLen
    }

    return result
  }

  /**
   * 尝试解码 pending 中的完整序列。
   * 若验证失败，输出替换字符并丢弃序列。
   */
  private tryDecodePending(): string {
    const seq = this.state.pending
    this.state.pending = []
    this.state.expectedLen = 0

    // 重新走 decodeSequence 的验证流程
    return this.decodeSequence(seq)
  }

  /**
   * 解码并验证一个完整的 UTF-8 多字节序列。
   * 验证失败时输出 U+FFFD 替换字符。
   *
   * 注意：调用方负责根据返回值决定 i 的推进量。
   * 当序列非法时，本函数只返回一个 U+FFFD；
   * 调方应只消耗"已确认为非法的那部分"字节，让非法字节之后的内容
   * 重新进入主循环（否则会吞掉紧跟在坏序列后的合法字节）。
   */
  private decodeSequence(seq: number[]): string {
    const len = seq.length

    // 验证所有 continuation bytes 的 0xC0 掩码
    for (let j = 1; j < len; j++) {
      if ((seq[j] & 0xc0) !== 0x80) {
        // 非法 continuation byte，输出替换字符
        return '\uFFFD'
      }
    }

    // 检查过度长编码和无效范围
    const b0 = seq[0]
    if (len === 3) {
      // 排除过度长编码：E0 80-9F 应为 E0 A0-BF
      if (b0 === 0xe0 && seq[1] < 0xa0) return '\uFFFD'
      // 排除代理对：ED A0-BF 解码出 U+D800-U+DFFF
      if (b0 === 0xed && seq[1] >= 0xa0) return '\uFFFD'
    } else if (len === 4) {
      // 排除过度长编码：F0 80-8F 应为 F0 90-BF
      if (b0 === 0xf0 && seq[1] < 0x90) return '\uFFFD'
      // 排除超出 Unicode 范围：F4 90-BF 解码出 > U+10FFFF
      if (b0 === 0xf4 && seq[1] >= 0x90) return '\uFFFD'
    }

    // 验证通过，使用 Buffer.toString('utf-8') 解码
    return Buffer.from(seq).toString('utf-8')
  }

  /** 重置解码状态（用于连接重置等场景） */
  reset(): void {
    this.state.pending = []
    this.state.expectedLen = 0
  }

  /** 是否有等待中的不完整序列 */
  hasPending(): boolean {
    return this.state.pending.length > 0
  }
}
