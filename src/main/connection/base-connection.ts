import type { ConnectionType, SessionStatus } from '@shared/types'
import type { TerminalConnection, ConnectionOptions } from './types'
import { StreamUtf8Decoder } from './c1-convert'

/** 连接基类：封装 16ms 数据缓冲批处理逻辑 + 跨 chunk UTF-8 解码 */
export abstract class BaseConnection implements TerminalConnection {
  abstract readonly type: ConnectionType

  readonly sessionId: string
  protected options: ConnectionOptions
  protected dataBuffer = ''
  protected flushTimer: ReturnType<typeof setTimeout> | null = null
  protected fulfilled = false
  protected statusSent = false

  /**
   * 跨 chunk UTF-8 解码器实例集合。
   *
   * stream.on('data') 的 Buffer 切分点随机，多字节字符可能被切到两个 chunk
   * （如 "位" 字 UTF-8 E4 BD 8D 被切为 [E4 BD] + [8D]）。旧版无状态解码
   * 把独立的 continuation byte 0x8D 误转为 ESC M (RI 反向索引)，注入光标
   * 控制序列破坏 TUI 布局，表现为"吞字符"。
   *
   * 本解码器持有 pending 状态，跨 feed() 调用拼出完整字符。
   * 设计参考 WezTerm 的 vtparse：只支持 UTF-8，不识别裸 8-bit C1。
   *
   * **多流隔离**：SSH 有 stdout 和 stderr 两条独立字节流，各自的跨 chunk
   * pending 状态必须隔离，否则一条流的多字节字符残留会污染另一条流。
   * 用 Map<key, decoder> 管理多个 decoder 实例，默认 key 为 'default'。
   */
  private readonly decoders = new Map<string, StreamUtf8Decoder>()

  constructor(options: ConnectionOptions) {
    this.sessionId = options.sessionId
    this.options = options
  }

  abstract connect(): Promise<void>
  abstract write(data: string): void

  /** 模板方法：先刷出缓冲数据，再执行子类资源清理 */
  async disconnect(): Promise<void> {
    this.flushRemaining()
    await this.doDisconnect()
  }

  protected abstract doDisconnect(): Promise<void>

  protected emitStatus(status: SessionStatus, errorMessage?: string): void {
    if (this.statusSent) return
    this.statusSent = true
    this.options.onStatus(this.sessionId, status, errorMessage)
  }

  /**
   * 解码原始字节 Buffer 为终端字符串。
   *
   * @param streamKey 流标识，默认 'default'。同一连接内不同字节流
   *   （如 SSH 的 stdout 和 stderr）应使用不同 key，以隔离各自的
   *   跨 chunk pending 状态，避免多字节字符残留跨流污染。
   */
  protected decodeBuffer(buf: Buffer, streamKey = 'default'): string {
    let decoder = this.decoders.get(streamKey)
    if (!decoder) {
      decoder = new StreamUtf8Decoder()
      this.decoders.set(streamKey, decoder)
    }
    return decoder.feed(buf)
  }

  protected bufferData(data: string): void {
    this.dataBuffer += data
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushData(), 16)
    }
  }

  protected flushData(): void {
    if (!this.dataBuffer) return
    this.options.onData(this.sessionId, this.dataBuffer)
    this.dataBuffer = ''
    this.flushTimer = null
  }

  protected flushRemaining(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.flushData()
  }
}
