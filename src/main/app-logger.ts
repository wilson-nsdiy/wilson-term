/**
 * 应用错误日志模块
 * 捕获主进程未处理异常并写入日志文件，存储在用户可写日志目录下
 */

import { app } from 'electron'
import { createWriteStream, mkdirSync, existsSync, readdirSync, unlinkSync, statSync } from 'fs'
import { join } from 'path'

/** 日志文件最大保留数量 */
const MAX_LOG_FILES = 10

/** 单个日志文件最大大小 5MB */
const MAX_LOG_SIZE = 5 * 1024 * 1024

/** 获取应用日志目录路径 */
function getAppLogDir(): string {
  // 优先使用系统日志目录（打包后位于用户可写位置，避免 Program Files UAC 限制）
  // 回退到 userData，最后回退到开发环境项目目录
  try {
    return app.getPath('logs')
  } catch {
    try {
      return join(app.getPath('userData'), 'log')
    } catch {
      return join(app.getAppPath(), 'log')
    }
  }
}

/** 格式化时间戳：YYYY-MM-DD HH:mm:ss.SSS */
function formatTimestamp(date: Date): string {
  const pad = (n: number, len = 2) => n.toString().padStart(len, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

/** 格式化文件名日期：YYYY-MM-DD */
function getFileDateStr(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

class AppLogger {
  private logDir: string
  private currentStream: ReturnType<typeof createWriteStream> | null = null
  private currentFilePath = ''
  private currentDate = ''
  private currentFileSize = 0

  constructor() {
    this.logDir = getAppLogDir()
    this.ensureDir()
    this.openFile()
  }

  /** 记录错误信息 */
  error(source: string, err: unknown): void {
    const timestamp = formatTimestamp(new Date())
    let message: string

    if (err instanceof Error) {
      message = `[${timestamp}] [ERROR] [${source}] ${err.message}\n${err.stack || ''}\n`
    } else {
      message = `[${timestamp}] [ERROR] [${source}] ${String(err)}\n`
    }

    this.write(message)
  }

  /** 记录警告信息 */
  warn(source: string, msg: string): void {
    const timestamp = formatTimestamp(new Date())
    this.write(`[${timestamp}] [WARN] [${source}] ${msg}\n`)
  }

  /** 记录信息 */
  info(source: string, msg: string): void {
    const timestamp = formatTimestamp(new Date())
    this.write(`[${timestamp}] [INFO] [${source}] ${msg}\n`)
  }

  /** 写入日志内容 */
  private write(content: string): void {
    // 检查日期切换
    const today = getFileDateStr(new Date())
    if (today !== this.currentDate) {
      this.currentDate = today
      this.rotateFile()
    }

    // 检查文件大小
    if (this.currentFileSize >= MAX_LOG_SIZE) {
      this.rotateFile()
    }

    if (!this.currentStream) {
      this.openFile()
    }

    if (this.currentStream) {
      this.currentStream.write(content)
      this.currentFileSize += Buffer.byteLength(content, 'utf-8')
    }
  }

  /** 确保日志目录存在 */
  private ensureDir(): void {
    try {
      if (!existsSync(this.logDir)) {
        mkdirSync(this.logDir, { recursive: true })
      }
    } catch {
      // 目录创建失败时无法记录，只能输出到控制台
    }
  }

  /** 打开日志文件 */
  private openFile(): void {
    try {
      const now = new Date()
      this.currentDate = getFileDateStr(now)
      const filename = `app_${this.currentDate}.log`
      this.currentFilePath = join(this.logDir, filename)

      // 如果文件已存在，获取当前大小
      this.currentFileSize = existsSync(this.currentFilePath)
        ? statSync(this.currentFilePath).size
        : 0

      this.currentStream = createWriteStream(this.currentFilePath, { flags: 'a', encoding: 'utf-8' })
      this.currentStream.on('error', () => {
        this.currentStream = null
      })

      // 清理旧日志文件
      this.cleanupOldFiles()
    } catch {
      this.currentStream = null
    }
  }

  /** 分割日志文件 */
  private rotateFile(): void {
    this.close()
    this.openFile()
  }

  /** 关闭日志流 */
  close(): void {
    if (this.currentStream) {
      this.currentStream.end()
      this.currentStream = null
    }
  }

  /** 清理超出数量限制的旧日志文件 */
  private cleanupOldFiles(): void {
    try {
      const files = readdirSync(this.logDir)
        .filter(f => f.startsWith('app_') && f.endsWith('.log'))
        .sort()
        .reverse()

      // 保留最新的 MAX_LOG_FILES 个文件
      const toDelete = files.slice(MAX_LOG_FILES)
      for (const file of toDelete) {
        try {
          unlinkSync(join(this.logDir, file))
        } catch {
          // 忽略删除失败
        }
      }
    } catch {
      // 忽略清理失败
    }
  }
}

/** 应用日志单例 */
export const appLogger = new AppLogger()

/**
 * 注册全局异常捕获
 * 捕获未处理的异常和 Promise 拒绝，写入日志文件
 */
export function setupGlobalErrorHandling(): void {
  // 捕获未处理的异常
  process.on('uncaughtException', (err) => {
    appLogger.error('uncaughtException', err)
  })

  // 捕获未处理的 Promise 拒绝
  process.on('unhandledRejection', (reason) => {
    appLogger.error('unhandledRejection', reason)
  })
}
