import { spawn, IPty } from 'node-pty'
import { homedir } from 'os'
import { existsSync } from 'fs'
import { execSync } from 'child_process'
import type { BashConfig, BashShellType } from '@shared/types'
import type { ConnectionOptions } from './types'
import { BaseConnection } from './base-connection'
import { logManager } from '../logger'
import { appLogger } from '../app-logger'

/** 检测系统可用的 Shell 列表 */
export function detectAvailableShells(): { type: BashShellType; label: string; available: boolean }[] {
  const shells: { type: BashShellType; label: string; available: boolean }[] = [
    { type: 'auto', label: '自动检测', available: true },
    { type: 'cmd', label: 'CMD', available: true }
  ]

  // 检测 PowerShell
  let psAvailable = false
  try {
    execSync('where powershell', { encoding: 'utf-8', timeout: 3000, windowsHide: true })
    psAvailable = true
  } catch { /* */ }
  shells.push({ type: 'powershell', label: 'PowerShell', available: psAvailable })

  return shells
}

/** 根据 Shell 类型解析可执行文件路径和参数 */
function resolveShellConfig(shellType: BashShellType): { file: string; args: string[] } {
  switch (shellType) {
    case 'cmd':
      return { file: 'cmd.exe', args: [] }
    case 'powershell':
      return { file: 'powershell.exe', args: [] }
    case 'auto':
    default:
      try {
        execSync('where powershell', { encoding: 'utf-8', timeout: 3000, windowsHide: true })
        return { file: 'powershell.exe', args: [] }
      } catch {
        return { file: 'cmd.exe', args: [] }
      }
  }
}

/** 构建 node-pty 所需的 env（过滤 undefined 值，注入终端能力标识） */
function buildEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, val] of Object.entries(process.env)) {
    if (val !== undefined) env[key] = val
  }
  env.COLORTERM = 'truecolor'
  return env
}

export class BashConnection extends BaseConnection {
  readonly type = 'bash' as const

  private pty: IPty | null = null

  constructor(options: ConnectionOptions) {
    super(options)
  }

  /** 本地终端无网络延迟，直接透传数据避免 ANSI 序列拆分 */
  protected bufferData(data: string): void {
    this.options.onData(this.sessionId, data)
  }

  async connect(): Promise<void> {
    const config = this.options.config as BashConfig
    const logConfig = this.options.logConfig
    const shellType = config.shell || 'auto'
    const cwd = config.cwd || homedir()

    const { file, args } = resolveShellConfig(shellType)

    return new Promise<void>((resolve, reject) => {
      try {
        const pty = spawn(file, args, {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd: existsSync(cwd) ? cwd : homedir(),
          env: buildEnv()
        })
        this.pty = pty

        if (logConfig && logConfig.logEnabled) {
          logManager.createLogger(this.sessionId, logConfig, config)
        }

        pty.onData((data) => {
          logManager.write(this.sessionId, 'output', data)
          this.bufferData(data)
        })

        pty.onExit(({ exitCode }) => {
          this.flushRemaining()
          void logManager.closeLogger(this.sessionId)
          this.pty = null
          const msg = exitCode === 0 ? undefined : `进程退出，代码: ${exitCode}`
          this.emitStatus('disconnected', msg)
        })

        resolve()
      } catch (err) {
        console.error(`[Bash] ${this.sessionId} 启动失败:`, err)
        appLogger.error('Bash', err)
        reject(new Error(`启动本地终端失败: ${(err as Error).message}`, { cause: err }))
      }
    })
  }

  protected async doDisconnect(): Promise<void> {
    this.statusSent = true
    await logManager.closeLogger(this.sessionId)
    if (this.pty) {
      this.pty.kill()
      this.pty = null
    }
  }

  write(data: string): void {
    if (!this.pty) {
      console.error(`[Bash] ${this.sessionId} PTY 未打开，无法写入数据`)
      return
    }
    this.pty.write(data)
  }

  resize(cols: number, rows: number): void {
    if (!this.pty) return
    this.pty.resize(cols, rows)
  }
}
