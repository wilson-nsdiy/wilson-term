import type { ConnectionType, SessionStatus } from '@shared/types'
import type { TerminalConnection, ConnectionOptions } from './types'

/** 连接基类：封装 16ms 数据缓冲批处理逻辑 */
export abstract class BaseConnection implements TerminalConnection {
  abstract readonly type: ConnectionType

  readonly sessionId: string
  protected options: ConnectionOptions
  protected dataBuffer = ''
  protected flushTimer: ReturnType<typeof setTimeout> | null = null
  protected fulfilled = false
  protected statusSent = false

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
