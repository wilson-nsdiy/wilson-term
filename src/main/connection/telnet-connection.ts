import { createConnection, Socket } from 'net'
import type { TelnetConfig, LogConfig } from '@shared/types'
import type { ConnectionOptions } from './types'
import { BaseConnection } from './base-connection'
import { TelnetProtocol } from './telnet-protocol'
import { logManager } from '../logger'
import { appLogger } from '../app-logger'

export class TelnetConnection extends BaseConnection {
  readonly type = 'telnet' as const

  private socket: Socket | null = null
  private protocol: TelnetProtocol | null = null

  constructor(options: ConnectionOptions) {
    super(options)
  }

  async connect(): Promise<void> {
    const config = this.options.config as TelnetConfig
    const logConfig = this.options.logConfig
    const sender = this.options.sender
    const timeout = config.timeout || 15000

    return new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: config.host, port: config.port, timeout })
      this.socket = socket
      this.protocol = new TelnetProtocol(socket)

      const cleanup = (): void => {
        if (this.fulfilled) return
        logManager.closeLogger(this.sessionId)
        this.socket = null
        this.protocol = null
      }

      socket.on('connect', () => {
        console.log(`[Telnet] ${this.sessionId} TCP 连接建立成功`)

        if (logConfig && logConfig.logEnabled) {
          logManager.createLogger(this.sessionId, logConfig, config)
        }

        socket.on('data', (data: Buffer) => {
          const cleanStr = this.protocol!.feed(data)
          if (cleanStr) {
            logManager.write(this.sessionId, 'output', cleanStr)
            this.bufferData(cleanStr)
          }
        })

        socket.on('close', () => {
          this.flushRemaining()
          logManager.closeLogger(this.sessionId)
          this.socket = null
          this.protocol = null
          this.emitStatus('disconnected')
        })

        this.fulfilled = true
        resolve()
      })

      socket.on('timeout', () => {
        console.error(`[Telnet] ${this.sessionId} 连接超时`)
        socket.destroy()
        if (!this.fulfilled) {
          this.fulfilled = true
          cleanup()
          reject(new Error(`连接超时：${config.host}:${config.port}，请检查网络连接或防火墙设置`))
        }
      })

      socket.on('error', (err: Error) => {
        console.error(`[Telnet] ${this.sessionId} 连接错误:`, err.message)
        appLogger.error('Telnet', err)
        if (!this.fulfilled) {
          this.fulfilled = true
          cleanup()
          let message = err.message
          if (/ECONNREFUSED/.test(message)) message = `连接被拒绝：${config.host}:${config.port}，请检查主机地址和端口`
          else if (/ENOTFOUND/.test(message)) message = `无法解析主机名：${config.host}`
          else if (/ETIMEDOUT/.test(message)) message = `连接超时：${config.host}:${config.port}`
          reject(new Error(message))
        }
      })
    })
  }

  async disconnect(): Promise<void> {
    this.statusSent = true
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }
    this.protocol = null
  }

  write(data: string): void {
    if (!this.socket || !this.socket.writable) {
      console.error(`[Telnet] ${this.sessionId} 连接未打开，无法写入数据`)
      return
    }
    const outData = data.replace(/\r(?!\n)/g, '\r\n')
    this.socket.write(outData)
  }

  resize(cols: number, rows: number): void {
    this.protocol?.resize(cols, rows)
  }
}
