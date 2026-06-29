/**
 * SFTP 文件管理模块
 * 基于已建立的 SSH 连接进行 SFTP 文件操作
 */

import { ipcMain, BrowserWindow, dialog } from 'electron'
import type { Client } from 'ssh2'
import type { SFTPWrapper } from 'ssh2'
import type { SFTPFileEntry, SFTPResult } from '@shared/types'
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { appLogger } from './app-logger'

/** 活跃的 SFTP 通道映射 sessionId → SFTPWrapper */
const activeSFTP = new Map<string, SFTPWrapper>()

/** 获取 SSH 连接模块中的 activeConnections Map */
// 由于 ES module 的限制，通过全局引用来获取
let getActiveConnections: () => Map<string, Client>

/**
 * 设置 SSH 连接获取函数
 */
export function setActiveConnectionsGetter(fn: () => Map<string, Client>): void {
  getActiveConnections = fn
}

/**
 * 从已连接的 SSH 客户端获取 SFTP 通道
 * 如果已有缓存的 SFTP 通道则直接返回
 */
async function getSFTP(sessionId: string): Promise<SFTPWrapper> {
  const existing = activeSFTP.get(sessionId)
  if (existing) return existing

  if (!getActiveConnections) {
    throw new Error('SFTP 模块未初始化')
  }

  const connections = getActiveConnections()
  const client = connections.get(sessionId)
  if (!client) {
    throw new Error('SSH 连接不存在或已断开')
  }

  return new Promise<SFTPWrapper>((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) {
        if (err.message?.includes('exit code 127')) {
          reject(new Error('远程服务器未启用 SFTP 子系统（exit code 127），请确认服务器已安装 openssh-sftp-server'))
        } else {
          reject(new Error(`打开 SFTP 通道失败: ${err.message}`))
        }
        return
      }
      activeSFTP.set(sessionId, sftp)

      // SFTP 通道关闭时自动清理
      sftp.on('close', () => {
        activeSFTP.delete(sessionId)
      })

      resolve(sftp)
    })
  })
}

/**
 * 将 ssh2 的 FileEntry 格式化为可序列化的 SFTPFileEntry
 */
function formatEntry(entry: import('ssh2').FileEntry): SFTPFileEntry {
  return {
    filename: entry.filename,
    longname: entry.longname,
    attrs: {
      size: entry.attrs.size,
      mode: entry.attrs.mode,
      uid: entry.attrs.uid,
      gid: entry.attrs.gid,
      atime: entry.attrs.atime,
      mtime: entry.attrs.mtime,
      isDirectory: entry.attrs.isDirectory(),
      isFile: entry.attrs.isFile(),
      isSymbolicLink: entry.attrs.isSymbolicLink()
    }
  }
}

/**
 * 注册 SFTP 相关的 IPC 处理器
 */
export function registerSFTPHandlers(): void {
  // 列出远程目录内容
  ipcMain.handle('sftp:list', async (_event, sessionId: string, remotePath: string): Promise<SFTPFileEntry[]> => {
    try {
      const sftp = await getSFTP(sessionId)
      return new Promise<SFTPFileEntry[]>((resolve, reject) => {
        sftp.readdir(remotePath, (err, list) => {
          if (err) {
            reject(new Error(`读取目录失败: ${err.message}`))
            return
          }
          resolve(list.map(formatEntry))
        })
      })
    } catch (err) {
      console.error('[SFTP] list error:', err)
      appLogger.error('SFTP', err)
      throw err
    }
  })

  // 上传文件（本地 → 远程）
  ipcMain.handle('sftp:upload', async (event, sessionId: string, localPath: string, remotePath: string): Promise<SFTPResult> => {
    try {
      const sftp = await getSFTP(sessionId)
      const data = readFileSync(localPath)

      return new Promise<SFTPResult>((resolve, reject) => {
        sftp.writeFile(remotePath, data, (err) => {
          if (err) {
            reject(new Error(`上传文件失败: ${err.message}`))
            return
          }
          resolve({ success: true })
        })
      })
    } catch (err) {
      console.error('[SFTP] upload error:', err)
      appLogger.error('SFTP', err)
      return { success: false, error: (err as Error).message }
    }
  })

  // 下载文件（远程 → 本地）
  ipcMain.handle('sftp:download', async (event, sessionId: string, remotePath: string, localPath: string): Promise<SFTPResult> => {
    try {
      const sftp = await getSFTP(sessionId)

      // 确保本地目录存在
      const localDir = dirname(localPath)
      if (!existsSync(localDir)) {
        mkdirSync(localDir, { recursive: true })
      }

      return new Promise<SFTPResult>((resolve, reject) => {
        sftp.fastGet(remotePath, localPath, {
          concurrency: 3,
          chunkSize: 32768
        }, (err) => {
          if (err) {
            reject(new Error(`下载文件失败: ${err.message}`))
            return
          }
          resolve({ success: true })
        })
      })
    } catch (err) {
      console.error('[SFTP] download error:', err)
      appLogger.error('SFTP', err)
      return { success: false, error: (err as Error).message }
    }
  })

  // 删除远程文件/目录
  ipcMain.handle('sftp:delete', async (_event, sessionId: string, remotePath: string, isDir: boolean): Promise<SFTPResult> => {
    try {
      const sftp = await getSFTP(sessionId)

      if (isDir) {
        return new Promise<SFTPResult>((resolve, reject) => {
          // 尝试删除空目录
          sftp.rmdir(remotePath, (err) => {
            if (err) {
              reject(new Error(`删除目录失败: ${err.message}`))
              return
            }
            resolve({ success: true })
          })
        })
      } else {
        return new Promise<SFTPResult>((resolve, reject) => {
          sftp.unlink(remotePath, (err) => {
            if (err) {
              reject(new Error(`删除文件失败: ${err.message}`))
              return
            }
            resolve({ success: true })
          })
        })
      }
    } catch (err) {
      console.error('[SFTP] delete error:', err)
      appLogger.error('SFTP', err)
      return { success: false, error: (err as Error).message }
    }
  })

  // 创建远程目录
  ipcMain.handle('sftp:mkdir', async (_event, sessionId: string, remotePath: string): Promise<SFTPResult> => {
    try {
      const sftp = await getSFTP(sessionId)
      return new Promise<SFTPResult>((resolve, reject) => {
        sftp.mkdir(remotePath, (err) => {
          if (err) {
            reject(new Error(`创建目录失败: ${err.message}`))
            return
          }
          resolve({ success: true })
        })
      })
    } catch (err) {
      console.error('[SFTP] mkdir error:', err)
      appLogger.error('SFTP', err)
      return { success: false, error: (err as Error).message }
    }
  })

  // 重命名远程文件/目录
  ipcMain.handle('sftp:rename', async (_event, sessionId: string, oldPath: string, newPath: string): Promise<SFTPResult> => {
    try {
      const sftp = await getSFTP(sessionId)
      return new Promise<SFTPResult>((resolve, reject) => {
        sftp.rename(oldPath, newPath, (err) => {
          if (err) {
            reject(new Error(`重命名失败: ${err.message}`))
            return
          }
          resolve({ success: true })
        })
      })
    } catch (err) {
      console.error('[SFTP] rename error:', err)
      appLogger.error('SFTP', err)
      return { success: false, error: (err as Error).message }
    }
  })

  // 获取文件/目录信息
  ipcMain.handle('sftp:stat', async (_event, sessionId: string, remotePath: string): Promise<SFTPFileEntry | null> => {
    try {
      const sftp = await getSFTP(sessionId)
      return new Promise<SFTPFileEntry>((resolve, reject) => {
        sftp.stat(remotePath, (err, attrs) => {
          if (err) {
            reject(new Error(`获取文件信息失败: ${err.message}`))
            return
          }
          const filename = remotePath.split('/').filter(Boolean).pop() || ''
          resolve({
            filename,
            longname: filename,
            attrs: {
              size: attrs.size,
              mode: attrs.mode,
              uid: attrs.uid,
              gid: attrs.gid,
              atime: attrs.atime,
              mtime: attrs.mtime,
              isDirectory: attrs.isDirectory(),
              isFile: attrs.isFile(),
              isSymbolicLink: attrs.isSymbolicLink()
            }
          })
        })
      })
    } catch (err) {
      console.error('[SFTP] stat error:', err)
      appLogger.error('SFTP', err)
      return null
    }
  })

  // 选择上传文件对话框
  ipcMain.handle('sftp:selectUploadFiles', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return []
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections']
    })
    return result.canceled ? [] : result.filePaths
  })

  // 选择下载保存路径
  ipcMain.handle('sftp:selectDownloadPath', async (event, defaultName: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const result = await dialog.showSaveDialog(win, {
      defaultPath: defaultName
    })
    return result.canceled ? null : result.filePath
  })
}

/**
 * 清理指定会话的 SFTP 通道（在 SSH 断开时调用）
 */
export function cleanupSFTP(sessionId: string): void {
  const sftp = activeSFTP.get(sessionId)
  if (sftp) {
    try {
      sftp.end()
    } catch {
      // 忽略关闭时的错误
    }
    activeSFTP.delete(sessionId)
  }
}
