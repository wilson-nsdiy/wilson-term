import type { ConnectionConfig, LogConfig, SessionStatus } from '@shared/types'
import type { WebContents } from 'electron'
import type { TerminalConnection, ConnectionOptions, StatusCallback, DataCallback } from './types'
import { SSHConnection } from './ssh-connection'
import { TelnetConnection } from './telnet-connection'
import { SerialConnection } from './serial-connection'
import { BashConnection } from './bash-connection'

/** 连接管理器：工厂 + 注册表 */
export class ConnectionManager {
  private connections = new Map<string, TerminalConnection>()
  /** 正在 disconnect 的会话：value 为 disconnect 完成的 Promise，防止并发重复 disconnect */
  private disconnecting = new Map<string, Promise<void>>()

  create(config: ConnectionConfig, logConfig: LogConfig | undefined, sender: WebContents): TerminalConnection {
    const sessionId = config.id
    if (this.connections.has(sessionId)) {
      throw new Error(`会话 ${sessionId} 已存在`)
    }

    const onStatus: StatusCallback = (sid, status, errMsg) => {
      this.sendStatus(sender, sid, status, errMsg)
    }

    const onData: DataCallback = (sid, data) => {
      this.sendData(sender, sid, data)
    }

    const options: ConnectionOptions = {
      sessionId,
      config,
      logConfig,
      sender,
      onStatus,
      onData
    }

    const conn = this.buildConnection(options)
    this.connections.set(sessionId, conn)
    return conn
  }

  get(sessionId: string): TerminalConnection | undefined {
    return this.connections.get(sessionId)
  }

  async remove(sessionId: string): Promise<void> {
    // 并发 disconnect 保护：若已有正在进行的 disconnect，复用其 Promise
    const pending = this.disconnecting.get(sessionId)
    if (pending) return pending

    const conn = this.connections.get(sessionId)
    if (!conn) return

    // 立即从注册表移除，使重连（相同 sessionId 的 create）可立即成功
    this.connections.delete(sessionId)

    const p = (async (): Promise<void> => {
      try {
        await conn.disconnect()
      } finally {
        this.disconnecting.delete(sessionId)
      }
    })()
    this.disconnecting.set(sessionId, p)
    return p
  }

  has(sessionId: string): boolean {
    return this.connections.has(sessionId)
  }

  /** 获取所有活跃会话 ID */
  getSessionIds(): string[] {
    return [...this.connections.keys()]
  }

  private buildConnection(options: ConnectionOptions): TerminalConnection {
    switch (options.config.type) {
      case 'ssh':
        return new SSHConnection(options)
      case 'telnet':
        return new TelnetConnection(options)
      case 'serial':
        return new SerialConnection(options)
      case 'bash':
        return new BashConnection(options)
      default:
        throw new Error(`不支持的连接类型: ${(options.config as { type: string }).type}`)
    }
  }

  private sendData(sender: WebContents, sessionId: string, data: string): void {
    try {
      if (!sender.isDestroyed()) {
        sender.send('connection:data', sessionId, data)
      }
    } catch {
      // 窗口已销毁
    }
  }

  private sendStatus(sender: WebContents, sessionId: string, status: SessionStatus, errorMessage?: string): void {
    try {
      if (!sender.isDestroyed()) {
        sender.send('connection:status', sessionId, status, errorMessage)
      }
    } catch {
      // 窗口已销毁
    }
  }
}

export const connectionManager = new ConnectionManager()
