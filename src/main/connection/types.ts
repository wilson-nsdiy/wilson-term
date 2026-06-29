import type { ConnectionType, SessionStatus, ConnectionConfig, LogConfig } from '@shared/types'
import type { WebContents } from 'electron'

/** 终端连接抽象接口 */
export interface TerminalConnection {
  readonly sessionId: string
  readonly type: ConnectionType

  connect(): Promise<void>
  disconnect(): Promise<void>
  write(data: string): void
  resize?(cols: number, rows: number): void
}

/** 连接状态变更回调 */
export type StatusCallback = (sessionId: string, status: SessionStatus, errorMessage?: string) => void

/** 数据接收回调 */
export type DataCallback = (sessionId: string, data: string) => void

/** 连接构造参数 */
export interface ConnectionOptions {
  sessionId: string
  config: ConnectionConfig
  logConfig?: LogConfig
  sender: WebContents
  onStatus: StatusCallback
  onData: DataCallback
}

export { BaseConnection } from './base-connection'
