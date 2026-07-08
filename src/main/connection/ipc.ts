import { ipcMain } from 'electron'
import { SerialPort } from 'serialport'
import { connectionManager } from './manager'
import { respondHostKey, generateKeyPair, getActiveClient, getActiveClientsMap, respondPassword } from './ssh-connection'
import { detectAvailableShells } from './bash-connection'
import type { ConnectionConfig, LogConfig } from '@shared/types'

/** 注册统一的连接 IPC 处理器 */
export function registerConnectionHandlers(): void {
  // 建立连接
  ipcMain.handle('connection:connect', async (event, config: ConnectionConfig, logConfig?: LogConfig) => {
    const conn = connectionManager.create(config, logConfig, event.sender)
    try {
      await conn.connect()
    } catch (err) {
      void connectionManager.remove(config.id).catch((e) => {
        console.error('清理失败连接时出错:', e)
      })
      throw err
    }
  })

  // 断开连接
  ipcMain.handle('connection:disconnect', async (_event, sessionId: string) => {
    await connectionManager.remove(sessionId)
  })

  // 写入数据
  ipcMain.on('connection:write', (_event, sessionId: string, data: string) => {
    const conn = connectionManager.get(sessionId)
    if (conn) {
      conn.write(data)
    } else {
      console.error(`[Connection] 会话 ${sessionId} 不存在，无法写入数据`)
    }
  })

  // 调整终端尺寸
  ipcMain.on('connection:resize', (_event, sessionId: string, cols: number, rows: number) => {
    const conn = connectionManager.get(sessionId)
    if (conn?.resize) {
      conn.resize(cols, rows)
    }
  })
}

/** 注册 SSH 特有的 IPC 处理器 */
export function registerSSHSpecificHandlers(): void {
  // 渲染进程回复主机密钥验证结果
  ipcMain.on('ssh:respondHostKey', (_event, sessionId: string, accepted: boolean) => {
    respondHostKey(sessionId, accepted)
  })

  // 渲染进程回复密码输入
  ipcMain.on('ssh:respondPassword', (_event, sessionId: string, password: string) => {
    respondPassword(sessionId, password)
  })

  // 生成 SSH 密钥对
  ipcMain.handle('ssh:generateKeyPair', async (_event, type: 'ed25519' | 'rsa' = 'ed25519') => {
    return generateKeyPair(type)
  })
}

/** 注册串口特有的 IPC 处理器 */
export function registerSerialSpecificHandlers(): void {
  ipcMain.handle('serial:list-ports', async () => {
    try {
      const ports = await SerialPort.list()
      return ports.map((p) => ({
        path: p.path,
        manufacturer: p.manufacturer ?? undefined,
        serialNumber: p.serialNumber ?? undefined,
        pnpId: p.pnpId ?? undefined,
        locationId: p.locationId ?? undefined,
        productId: p.productId ?? undefined,
        vendorId: p.vendorId ?? undefined,
        // friendlyName 由 Windows bindings-cpp 返回
        friendlyName: (p as { friendlyName?: string }).friendlyName ?? undefined
      }))
    } catch (err) {
      console.error('列出串口失败:', err)
      return []
    }
  })
}

/** 注册 Bash 特有的 IPC 处理器 */
export function registerBashSpecificHandlers(): void {
  ipcMain.handle('bash:list-shells', async () => {
    return detectAvailableShells()
  })
}

/** 导出 getActiveClient、getActiveClientsMap 和 connectionManager 供其他模块使用 */
export { getActiveClient, getActiveClientsMap, connectionManager }
