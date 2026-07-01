import { Client } from 'ssh2'
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, readFile } from 'fs'
import { join } from 'path'
import { homedir, hostname } from 'os'
import { createHash } from 'crypto'
import { execSync } from 'child_process'
import { app } from 'electron'
import type { SSHConfig, HostKeyVerifyRequest, KeyPairResult, PasswordRequest } from '@shared/types'
import type { ConnectionOptions } from './types'
import { BaseConnection } from './base-connection'
import { decodeBufferForTerminal } from './c1-convert'
import { logManager } from '../logger'
import { appLogger } from '../app-logger'
import { cleanupSFTP } from '../sftp'

const DEFAULT_KEY_FILES = ['id_ed25519', 'id_rsa', 'id_ecdsa', 'id_dsa', 'identity']

const KEY_TYPE_MAP: Record<string, string> = {
  'ssh-ed25519': 'ssh-ed25519',
  'ssh-rsa': 'ssh-rsa',
  'ecdsa-sha2-nistp256': 'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384': 'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521': 'ecdsa-sha2-nistp521',
  'ssh-dss': 'ssh-dss'
}

function getSshDir(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    if (localAppData) return join(localAppData, 'wilson-terminal', '.ssh')
  }
  return join(app.getPath('userData'), '.ssh')
}

function getKnownHostsPath(): string {
  return join(getSshDir(), 'known_hosts')
}

function ensureKnownHostsFile(): void {
  const sshDir = getSshDir()
  if (!existsSync(sshDir)) mkdirSync(sshDir, { recursive: true, mode: 0o700 })
  const p = getKnownHostsPath()
  if (!existsSync(p)) writeFileSync(p, '', { mode: 0o644 })
}

function getFingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}

function getKeyTypeName(key: Buffer): string {
  const typeLen = key.readUInt32BE(0)
  const type = key.subarray(4, 4 + typeLen).toString('ascii')
  return KEY_TYPE_MAP[type] || type
}

function findDefaultKeyInDir(dir: string): string | null {
  if (!existsSync(dir)) return null
  for (const f of DEFAULT_KEY_FILES) {
    const p = join(dir, f)
    if (existsSync(p)) return p
  }
  return null
}

function getDefaultPrivateKey(): string | null {
  const appKey = findDefaultKeyInDir(getSshDir())
  if (appKey) return appKey
  return findDefaultKeyInDir(join(homedir(), '.ssh'))
}

function getAvailableAgent(): string | null {
  if (process.platform === 'win32') {
    try {
      const r = execSync('tasklist /FI "IMAGENAME eq Pageant.exe" /NH', { encoding: 'utf-8', timeout: 3000, windowsHide: true })
      if (r.includes('Pageant.exe')) return 'pageant'
    } catch { /* */ }
    try {
      const r = execSync('sc query ssh-agent', { encoding: 'utf-8', timeout: 3000, windowsHide: true })
      if (r.includes('RUNNING')) return '\\\\.\\pipe\\openssh-ssh-agent'
    } catch { /* */ }
    const sock = process.env.SSH_AUTH_SOCK
    if (sock) return sock
    return null
  }
  const sock = process.env.SSH_AUTH_SOCK
  return sock && existsSync(sock) ? sock : null
}

function findKnownHostEntries(host: string, port: number): string[] {
  const p = getKnownHostsPath()
  if (!existsSync(p)) return []
  const content = readFileSync(p, 'utf-8')
  const hostPattern = port === 22 ? host : `[${host}]:${port}`
  return content.split('\n').filter(l => {
    if (!l.trim() || l.startsWith('#')) return false
    const parts = l.split(' ')
    return parts.length >= 3 && parts[0] === hostPattern
  })
}

function verifyKnownHostKey(host: string, port: number, key: Buffer): 'match' | 'mismatch' | 'unknown' {
  const entries = findKnownHostEntries(host, port)
  if (entries.length === 0) return 'unknown'
  const keyBase64 = key.toString('base64')
  for (const entry of entries) {
    const parts = entry.split(' ')
    if (parts.length >= 3 && parts[2] === keyBase64) return 'match'
  }
  return 'mismatch'
}

function addToKnownHosts(host: string, port: number, key: Buffer, keyType: string): void {
  ensureKnownHostsFile()
  const hostPattern = port === 22 ? host : `[${host}]:${port}`
  const keyBase64 = key.toString('base64')
  const line = `${hostPattern} ${keyType} ${keyBase64}\n`
  const existing = findKnownHostEntries(host, port)
  for (const entry of existing) {
    const parts = entry.split(' ')
    if (parts.length >= 3 && parts[1] === keyType && parts[2] === keyBase64) return
  }
  appendFileSync(getKnownHostsPath(), line)
}

/** 主机密钥验证的 Promise 解析器 */
const hostKeyVerifyResolvers = new Map<
  string,
  { resolve: (accepted: boolean) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
>()

const HOST_KEY_VERIFY_TIMEOUT = 60000

/** 密码输入的 Promise 解析器 */
const passwordResolvers = new Map<
  string,
  { resolve: (password: string) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
>()

const PASSWORD_REQUEST_TIMEOUT = 120000

/** 响应主机密钥验证 */
export function respondHostKey(sessionId: string, accepted: boolean): void {
  const resolver = hostKeyVerifyResolvers.get(sessionId)
  if (resolver) {
    clearTimeout(resolver.timer)
    hostKeyVerifyResolvers.delete(sessionId)
    resolver.resolve(accepted)
  }
}

/** 响应密码输入请求 */
export function respondPassword(sessionId: string, password: string): void {
  const resolver = passwordResolvers.get(sessionId)
  if (resolver) {
    clearTimeout(resolver.timer)
    passwordResolvers.delete(sessionId)
    resolver.resolve(password)
  }
}

/** 生成 SSH 密钥对 */
export function generateKeyPair(type: 'ed25519' | 'rsa' = 'ed25519'): KeyPairResult {
  try {
    const sshDir = getSshDir()
    if (!existsSync(sshDir)) mkdirSync(sshDir, { recursive: true, mode: 0o700 })
    const privateKeyPath = join(sshDir, type === 'ed25519' ? 'id_ed25519' : 'id_rsa')
    const publicKeyPath = `${privateKeyPath}.pub`
    if (existsSync(privateKeyPath)) {
      return { success: false, error: `密钥文件已存在：${privateKeyPath}。如需重新生成，请先删除现有文件。` }
    }
    const comment = `${process.env.USERNAME || process.env.USER || 'user'}@${hostname()}`
    execSync(`ssh-keygen -t ${type === 'ed25519' ? 'ed25519' : 'rsa'} -C "${comment}" -f "${privateKeyPath}" -N ""`, {
      encoding: 'utf-8', timeout: 10000, windowsHide: true
    })
    return { success: true, privateKeyPath, publicKeyPath }
  } catch (err) {
    console.error('[SSH] 密钥生成失败:', err)
    appLogger.error('SSH', err)
    return { success: false, error: (err as Error).message }
  }
}

/** 全局活跃 SSH Client 注册表（供 SFTP 模块使用） */
const activeClients = new Map<string, Client>()

/** 获取指定会话的 SSH Client 实例 */
export function getActiveClient(sessionId: string): Client | undefined {
  return activeClients.get(sessionId)
}

/** 获取所有活跃 SSH 连接的 Map（供 SFTP 模块初始化使用） */
export function getActiveClientsMap(): Map<string, Client> {
  return activeClients
}

/** 内部注册表，存储 SSHConnection 实例 */
const connectionInstances = new Map<string, SSHConnection>()

export class SSHConnection extends BaseConnection {
  readonly type = 'ssh' as const

  private client: Client | null = null
  private channel: import('ssh2').ClientChannel | null = null

  constructor(options: ConnectionOptions) {
    super(options)
  }

  async connect(): Promise<void> {
    const config = this.options.config as SSHConfig
    const logConfig = this.options.logConfig
    const sender = this.options.sender

    ensureKnownHostsFile()

    const connectConfig: import('ssh2').ConnectConfig = {
      host: config.host,
      port: config.port,
      username: config.username,
      readyTimeout: 30000,
      keepaliveInterval: 30000
    }

    let agentPath: string | null = null
    let defaultKey: string | null = null
    let needPasswordFallback = false

    switch (config.authType) {
      case 'password': {
        if (config.password) {
          connectConfig.password = config.password
        } else {
          agentPath = getAvailableAgent()
          defaultKey = getDefaultPrivateKey()
          if (agentPath) connectConfig.agent = agentPath
          if (defaultKey) {
            try { connectConfig.privateKey = await readFile(defaultKey) }
            catch { throw new Error(`免密认证失败：无法读取密钥文件 "${defaultKey}"，请检查文件权限`) }
          }
          needPasswordFallback = true
        }
        break
      }
      case 'privateKey': {
        const keyPath = config.privateKey
        if (keyPath) {
          try {
            const resolvedPath = keyPath.startsWith('~') ? join(homedir(), keyPath.slice(1).replace(/^\/+/, '')) : keyPath
            connectConfig.privateKey = await readFile(resolvedPath)
            if (config.passphrase) connectConfig.passphrase = config.passphrase
          } catch (err) {
            throw new Error(`读取密钥文件失败: ${(err as Error).message}`, { cause: err })
          }
        }
        break
      }
      case 'none': {
        agentPath = getAvailableAgent()
        defaultKey = getDefaultPrivateKey()
        if (agentPath) connectConfig.agent = agentPath
        if (defaultKey) {
          try { connectConfig.privateKey = await readFile(defaultKey) }
          catch { throw new Error(`免密认证失败：无法读取密钥文件 "${defaultKey}"，请检查文件权限`) }
        }
        needPasswordFallback = true
        break
      }
    }

    // 未填写密码时，用 authHandler 控制认证流程：
    // 有 agent/密钥 → 先尝试免密，失败后若服务端支持 password 则弹窗输入
    // 无 agent/密钥 → 直接弹窗请求密码
    type AuthCallback = Parameters<NonNullable<import('ssh2').ConnectConfig['authHandler']>>[2]
    if (needPasswordFallback) {
      connectConfig.authHandler = (methodsLeft, _partialSuccess, callback) => {
        if (methodsLeft === null) {
          // 首次调用：有免密手段则先尝试，否则直接请求密码
          if (agentPath) {
            callback({ type: 'agent', username: config.username, agent: agentPath })
          } else if (defaultKey) {
            callback({ type: 'publickey', username: config.username, key: connectConfig.privateKey })
          } else {
            requestPassword(callback, false)
          }
          return
        }

        // 免密失败后，检查服务端是否支持 password
        if (methodsLeft.includes('password')) {
          requestPassword(callback, true)
        } else {
          callback(false)
        }
      }

      const requestPassword = (callback: AuthCallback, retry: boolean) => {
        const request: PasswordRequest = {
          sessionId: this.sessionId,
          host: config.host,
          port: config.port,
          username: config.username,
          prompt: config.username,
          retry
        }

        const timer = setTimeout(() => {
          const resolver = passwordResolvers.get(this.sessionId)
          if (resolver) {
            passwordResolvers.delete(this.sessionId)
            resolver.reject(new Error('timeout'))
          }
        }, PASSWORD_REQUEST_TIMEOUT)

        const passwordPromise = new Promise<string>((res, rej) => {
          passwordResolvers.set(this.sessionId, { resolve: res, reject: rej, timer })
        })

        try {
          if (!sender.isDestroyed()) {
            sender.send('ssh:passwordRequest', request)
          }
        } catch { /* */ }

        passwordPromise.then((password) => {
          clearTimeout(timer)
          if (password === '') {
            callback(false)
          } else {
            callback({ type: 'password', username: config.username, password })
          }
        }).catch(() => {
          clearTimeout(timer)
          callback(false)
        })
      }
    }

    return new Promise<void>((resolve, reject) => {
      const client = new Client()
      this.client = client

      const cleanup = (): void => {
        logManager.closeLogger(this.sessionId)
        this.channel = null
        this.client = null
        activeClients.delete(this.sessionId)
        connectionInstances.delete(this.sessionId)
        const pwResolver = passwordResolvers.get(this.sessionId)
        if (pwResolver) {
          clearTimeout(pwResolver.timer)
          passwordResolvers.delete(this.sessionId)
        }
      }

      connectConfig.hostVerifier = (key: Buffer, callback: (verified: boolean) => void) => {
        const verifyResult = verifyKnownHostKey(config.host, config.port, key)
        const fingerprint = getFingerprint(key)
        const keyType = getKeyTypeName(key)

        if (verifyResult === 'match') { callback(true); return }

        const request: HostKeyVerifyRequest = {
          sessionId: this.sessionId,
          host: config.host,
          port: config.port,
          keyType,
          fingerprint,
          changed: verifyResult === 'mismatch'
        }

        const verifyKey = this.sessionId
        const timer = setTimeout(() => {
          hostKeyVerifyResolvers.delete(verifyKey)
          callback(false)
        }, HOST_KEY_VERIFY_TIMEOUT)

        const verifyPromise = new Promise<boolean>((res, rej) => {
          hostKeyVerifyResolvers.set(verifyKey, { resolve: res, reject: rej, timer })
        })

        try {
          if (!sender.isDestroyed()) {
            sender.send('ssh:hostKeyVerify', request)
          }
        } catch { /* */ }

        verifyPromise.then((accepted) => {
          clearTimeout(timer)
          if (accepted) {
            addToKnownHosts(config.host, config.port, key, keyType)
            callback(true)
          } else {
            callback(false)
          }
        }).catch(() => {
          clearTimeout(timer)
          callback(false)
        })
      }

      client.on('ready', () => {
        client.shell({ rows: 24, cols: 80, term: 'xterm-256color' }, (err, stream) => {
          if (err) {
            client.end()
            reject(new Error(`创建 shell 失败: ${err.message}`))
            return
          }

          this.channel = stream
          activeClients.set(this.sessionId, client)
          connectionInstances.set(this.sessionId, this)

          if (logConfig && logConfig.logEnabled) {
            logManager.createLogger(this.sessionId, logConfig, config)
          }

          stream.on('data', (data: Buffer) => {
            const s = decodeBufferForTerminal(data)
            logManager.write(this.sessionId, 'output', s)
            this.bufferData(s)
          })

          stream.stderr.on('data', (data: Buffer) => {
            const s = decodeBufferForTerminal(data)
            logManager.write(this.sessionId, 'output', s)
            this.bufferData(s)
          })

          stream.on('close', () => {
            this.flushRemaining()
            this.channel = null
            this.client?.end()
          })

          this.fulfilled = true
          resolve()
        })
      })

      client.on('error', (err) => {
        console.error(`SSH [${this.sessionId}] 连接错误:`, err.message)
        appLogger.error('SSH', err)
        cleanup()

        let message = err.message
        if (/ECONNREFUSED/.test(message)) message = `连接被拒绝：${config.host}:${config.port}，请检查主机地址和端口`
        else if (/ENOTFOUND/.test(message)) message = `无法解析主机名：${config.host}`
        else if (/ETIMEDOUT|timed out/.test(message)) message = `连接超时：${config.host}:${config.port}，请检查网络连接`
        else if (/All configured authentication methods failed/.test(message)) {
          message = needPasswordFallback
            ? '认证失败：密码不正确或已取消输入，请检查密码后重试'
            : '认证失败：所有认证方式均被拒绝'
        }
        else if (/authentication methods failed/.test(message)) message = '认证失败：请检查用户名和认证信息'
        else if (/Host key verification failed/.test(message)) message = '主机密钥验证失败'

        if (!this.fulfilled) {
          this.fulfilled = true
          reject(new Error(message))
        }
      })

      client.on('close', () => {
        cleanupSFTP(this.sessionId)
        cleanup()
        this.emitStatus('disconnected')
      })

      client.connect(connectConfig)
    })
  }

  async disconnect(): Promise<void> {
    this.statusSent = true
    logManager.closeLogger(this.sessionId)
    if (this.channel) {
      this.channel.close()
      this.channel = null
    }
    if (this.client) {
      this.client.end()
      this.client = null
    }
    connectionInstances.delete(this.sessionId)
    activeClients.delete(this.sessionId)
  }

  write(data: string): void {
    if (!this.channel) {
      console.error(`SSH [${this.sessionId}] 通道未打开，无法写入数据`)
      return
    }
    this.channel.write(data)
  }

  resize(cols: number, rows: number): void {
    if (!this.channel) return
    this.channel.setWindow(rows, cols, 0, 0)
  }
}
