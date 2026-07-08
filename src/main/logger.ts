/**
 * 日志写入模块
 * 负责会话日志的创建、写入、分割和关闭
 */

import { app } from 'electron'
import { createWriteStream, mkdirSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import type { LogConfig, ConnectionConfig, SSHConfig, SerialConfig, TelnetConfig, BashConfig } from '@shared/types'

/** 剥离 ANSI 转义序列和回车符，保持日志可读性 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text
    // CSI 序列：ESC [ {私有前缀 ? < = >} {参数 0-9 ;} {最终字节 A-Za-z}
    // 覆盖 SGR、光标控制、private mode（如 ?2004 bracketed paste、?25 光标显隐、?1049 备用屏幕）
    .replace(/\x1B\[[0-9;?<>=]*[A-Za-z]/g, '')
    // OSC 序列：ESC ] ... BEL（如设置窗口标题）
    .replace(/\x1B\].*?\x07/g, '')
    // 其他控制字符（保留 \t \n）
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/\r/g, '')         // 移除回车符
}

/** 格式化时间戳：YYYY-MM-DD HH:mm:ss.SSS */
function formatTimestamp(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${date.getMilliseconds().toString().padStart(3, '0')}`
}

/** 格式化文件名时间戳：YYYY-MM-DD_HH-mm-ss */
function formatFileTimestamp(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
}

/** 获取日期字符串：YYYY-MM-DD */
function getDateString(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 清理路径中的特殊字符，用于文件名 */
function sanitizePathForFilename(p: string): string {
  return p.replace(/^\//, '').replace(/\//g, '_').replace(/:/g, '')
}

/** 获取默认日志目录 */
function getDefaultLogDir(): string {
  return join(app.getPath('documents'), 'wilson-terminal', 'logs')
}

/** 生成日志文件名 */
function generateLogFilename(config: ConnectionConfig): string {
  const timestamp = formatFileTimestamp(new Date())
  if (config.type === 'ssh') {
    const ssh = config as SSHConfig
    return `ssh_${ssh.host}_${ssh.port}_${timestamp}.log`
  } else if (config.type === 'telnet') {
    const telnet = config as TelnetConfig
    return `telnet_${telnet.host}_${telnet.port}_${timestamp}.log`
  } else if (config.type === 'bash') {
    const bash = config as BashConfig
    return `bash_${bash.shell || 'auto'}_${timestamp}.log`
  } else {
    const serial = config as SerialConfig
    const portName = sanitizePathForFilename(serial.path)
    return `serial_${portName}_${serial.baudRate}_${timestamp}.log`
  }
}

/** 获取日志子目录路径（按日期） */
function getDateSubDir(logDir: string, date: string): string {
  return join(logDir, date)
}

/** 单个会话的日志写入器 */
class SessionLogger {
  private config: LogConfig
  private baseLogDir: string
  private currentFilePath = ''
  private writeStream: ReturnType<typeof createWriteStream> | null = null
  private currentFileSize = 0
  private currentDate = ''
  private connectionConfig: ConnectionConfig
  /** 输出缓冲区：累积片段直到遇到换行再整行写入 */
  private outputBuffer = ''

  constructor(config: LogConfig, connectionConfig: ConnectionConfig) {
    this.config = config
    this.connectionConfig = connectionConfig
    this.baseLogDir = config.logPath || getDefaultLogDir()
    this.currentDate = getDateString(new Date())
    this.openNewFile()
  }

  /** 写入日志数据 */
  write(direction: 'input' | 'output', data: string): void {
    // 仅记录输出，不记录输入
    if (direction !== 'output') return
    if (!this.config.logEnabled || !this.writeStream) return

    // 按时间分割检查
    if (this.config.logSplitByTime) {
      const today = getDateString(new Date())
      if (today !== this.currentDate) {
        this.currentDate = today
        this.rotateFile()
      }
    }

    // 按大小分割检查
    if (this.config.logSplitBySize && this.currentFileSize >= this.config.logMaxSize) {
      this.rotateFile()
    }

    const cleanData = stripAnsi(data)
    if (!cleanData) return

    // 追加到缓冲区
    this.outputBuffer += cleanData

    // 按换行符切分缓冲区，整行写出
    const lines = this.outputBuffer.split('\n')
    // 最后一段可能不完整（没有换行结尾），留在缓冲区
    this.outputBuffer = lines.pop() || ''

    const now = new Date()
    for (const line of lines) {
      if (!line) continue
      const formatted = this.config.logWithTimestamp
        ? `[${formatTimestamp(now)}] ${line}\n`
        : `${line}\n`
      this.writeStream!.write(formatted)
      this.currentFileSize += Buffer.byteLength(formatted, 'utf-8')
    }
  }

  /** 强制刷出缓冲区剩余内容 */
  private flush(): void {
    if (!this.outputBuffer || !this.writeStream) return
    const line = this.outputBuffer
    this.outputBuffer = ''
    const formatted = this.config.logWithTimestamp
      ? `[${formatTimestamp(new Date())}] ${line}\n`
      : `${line}\n`
    this.writeStream.write(formatted)
    this.currentFileSize += Buffer.byteLength(formatted, 'utf-8')
  }

  /** 关闭日志写入器，等待 writeStream end() 完成以保证最后一批数据落盘 */
  close(): Promise<void> {
    this.flush()
    return this.closeStreamAsync()
  }

  /** 同步关闭流（用于 rotate 场景，无法阻塞主进程） */
  private closeSync(): void {
    this.flush()
    if (this.writeStream) {
      this.writeStream.end()
      this.writeStream = null
    }
  }

  /** 异步关闭流并等待 finish，带 1s 兜底 */
  private closeStreamAsync(): Promise<void> {
    const stream = this.writeStream
    this.writeStream = null
    if (!stream) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const guard = setTimeout(() => resolve(), 1000)
      const done = (): void => {
        clearTimeout(guard)
        resolve()
      }
      stream.on('close', done)
      stream.on('error', done)
      stream.end()
    })
  }

  /** 确保目录存在 */
  private ensureDir(dir: string): void {
    try {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
    } catch (err) {
      console.error(`创建日志目录失败 [${dir}]:`, err)
    }
  }

  /** 打开新的日志文件 */
  private openNewFile(): void {
    try {
      const dateDir = getDateSubDir(this.baseLogDir, this.currentDate)
      this.ensureDir(dateDir)
      const filename = generateLogFilename(this.connectionConfig)
      this.currentFilePath = join(dateDir, filename)
      this.writeStream = createWriteStream(this.currentFilePath, { flags: 'a', encoding: 'utf-8' })
      this.currentFileSize = existsSync(this.currentFilePath)
        ? statSync(this.currentFilePath).size
        : 0

      this.writeStream.on('error', (err) => {
        console.error(`日志写入错误 [${this.currentFilePath}]:`, err.message)
      })
    } catch (err) {
      console.error('打开日志文件失败:', err)
    }
  }

  /** 分割日志文件 */
  private rotateFile(): void {
    this.closeSync()
    this.openNewFile()
  }

}

/** 管理所有会话的日志写入器 */
class LogManager {
  private loggers = new Map<string, SessionLogger>()
  /** fire-and-forget 调用方启动的 close promise，closeAll 兜底等待 */
  private readonly pendingCloses = new Set<Promise<void>>()

  /** 为会话创建日志写入器 */
  createLogger(sessionId: string, config: LogConfig, connectionConfig: ConnectionConfig): void {
    // 如果已有，先关闭
    void this.closeLogger(sessionId)
    if (!config.logEnabled) return
    try {
      const logger = new SessionLogger(config, connectionConfig)
      this.loggers.set(sessionId, logger)
    } catch (err) {
      console.error(`创建日志写入器失败 [${sessionId}]:`, err)
    }
  }

  /** 写入日志 */
  write(sessionId: string, direction: 'input' | 'output', data: string): void {
    const logger = this.loggers.get(sessionId)
    if (logger) {
      logger.write(direction, data)
    }
  }

  /** 关闭会话的日志写入器，等待落盘完成 */
  async closeLogger(sessionId: string): Promise<void> {
    const logger = this.loggers.get(sessionId)
    if (!logger) return
    this.loggers.delete(sessionId)
    const p = logger.close()
    this.pendingCloses.add(p)
    try {
      await p
    } finally {
      this.pendingCloses.delete(p)
    }
  }

  /** 获取会话的当前日志文件路径 */
  getLogFilePath(sessionId: string): string | null {
    const logger = this.loggers.get(sessionId)
    return logger ? logger['currentFilePath'] || null : null
  }

  /** 获取日志根目录路径 */
  getLogDir(sessionId: string): string | null {
    const logger = this.loggers.get(sessionId)
    return logger ? logger['baseLogDir'] || null : null
  }

  /** 关闭所有日志写入器，等待全部落盘完成 */
  async closeAll(): Promise<void> {
    const ids = [...this.loggers.keys()]
    await Promise.all(ids.map((id) => this.closeLogger(id)))
    if (this.pendingCloses.size > 0) {
      await Promise.all([...this.pendingCloses])
    }
  }
}

/** 日志管理器单例 */
export const logManager = new LogManager()
