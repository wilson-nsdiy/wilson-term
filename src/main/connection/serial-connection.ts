import { SerialPort } from 'serialport'
import type { SerialConfig } from '@shared/types'
import type { ConnectionOptions } from './types'
import { BaseConnection } from './base-connection'
import { decodeBufferForTerminal } from './c1-convert'
import { logManager } from '../logger'
import { appLogger } from '../app-logger'

export class SerialConnection extends BaseConnection {
  readonly type = 'serial' as const

  private port: SerialPort | null = null

  constructor(options: ConnectionOptions) {
    super(options)
  }

  async connect(): Promise<void> {
    const config = this.options.config as SerialConfig
    const logConfig = this.options.logConfig

    const openOptions: Record<string, unknown> = {
      path: config.path,
      baudRate: config.baudRate,
      dataBits: config.dataBits,
      stopBits: config.stopBits,
      parity: config.parity,
      autoOpen: false
    }

    if (config.flowControl === 'hardware') {
      openOptions.rtscts = true
    } else if (config.flowControl === 'software') {
      openOptions.xon = true
      openOptions.xoff = true
      openOptions.xany = true
    }

    const port = new SerialPort(openOptions)
    this.port = port

    return new Promise<void>((resolve, reject) => {
      port.open((err) => {
        if (err) {
          const msg = err.message || ''
          if (/Access denied|EACCES|EPERM|busy/i.test(msg)) {
            reject(new Error(`串口 ${config.path} 已被其他程序占用，请关闭占用该串口的程序后重试`, { cause: err }))
          } else if (/error code 31|ERROR_GEN_FAILURE|GetOverlappedResult/i.test(msg)) {
            reject(new Error(`串口 ${config.path} 设备异常，请检查设备连接或重新插拔后重试`, { cause: err }))
          } else {
            reject(new Error(`打开串口失败: ${msg}`, { cause: err }))
          }
          return
        }

        if (logConfig && logConfig.logEnabled) {
          logManager.createLogger(this.sessionId, logConfig, config)
        }

        port.on('data', (data: Buffer) => {
          const s = decodeBufferForTerminal(data)
          logManager.write(this.sessionId, 'output', s)
          this.bufferData(s)
        })

        port.on('close', () => {
          this.flushRemaining()
          void logManager.closeLogger(this.sessionId)
          this.port = null
          this.emitStatus('disconnected')
        })

        port.on('error', (err: Error) => {
          console.error(`串口 [${this.sessionId}] 错误:`, err.message)
          appLogger.error('Serial', err)
          this.flushRemaining()
          void logManager.closeLogger(this.sessionId)
          this.port = null
          this.emitStatus('error', err.message)
        })

        resolve()
      })
    })
  }

  protected async doDisconnect(): Promise<void> {
    this.statusSent = true
    if (!this.port) return

    return new Promise<void>((resolve) => {
      this.port!.close((err) => {
        if (err) {
          console.error(`关闭串口 [${this.sessionId}] 失败:`, err.message)
          appLogger.error('Serial', `关闭串口失败 [${this.sessionId}]: ${err.message}`)
        }
        this.port = null
        resolve()
      })
    })
  }

  write(data: string): void {
    if (!this.port || !this.port.isOpen) {
      console.error(`串口 [${this.sessionId}] 未打开，无法写入数据`)
      return
    }
    this.port.write(data, (err) => {
      if (err) {
        console.error(`串口 [${this.sessionId}] 写入失败:`, err.message)
        appLogger.error('Serial', err)
      }
    })
  }

  resize(_cols: number, _rows: number): void {
    // no-op
  }
}
