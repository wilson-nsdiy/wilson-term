import { ipcMain, BrowserWindow, dialog, app, net, shell } from 'electron'
import { join, extname } from 'path'
import { readFileSync } from 'fs'
import { networkInterfaces } from 'os'
import { registerConnectionHandlers, registerSSHSpecificHandlers, registerSerialSpecificHandlers, registerBashSpecificHandlers, getActiveClientsMap, connectionManager } from './connection/ipc'
import { registerSFTPHandlers, setActiveConnectionsGetter } from './sftp'
import { loadSavedSessionsFromDisk, saveSavedSessionsToDisk, loadIgnoredVersionsFromDisk, saveIgnoredVersionsFromDisk, loadCommandButtonGroupsFromDisk, saveCommandButtonGroupsToDisk, loadAppSettingsFromDisk, saveAppSettingsToDisk, loadViewStateFromDisk, saveViewStateToDisk, loadScheduledTasksFromDisk, saveScheduledTasksToDisk, loadProfilesFromDisk, saveProfilesToDisk, loadSavedSessionGroupsFromDisk, saveSavedSessionGroupsToDisk } from './storage'
import { logManager } from './logger'
import { appLogger } from './app-logger'
import { checkForUpdates, getCurrentVersion, downloadUpdate, quitAndInstall, cancelAutoInstall, getStatus, getIgnoredVersions, saveIgnoredVersions } from './updater'
import { getKeyboardLockState } from './keyboard'
import { getComputerDomain } from './domain'
import { mainPluginHost } from './plugin-host'
import type { SavedSession, LogConfig, ConnectionConfig, CommandButtonGroup, AppSettings, ScheduledTask, Profile, SavedSessionGroup } from '@shared/types'
import type { ViewState } from './storage'

async function getSystemFonts(): Promise<string[]> {
  try {
    const { default: fontList } = await import('font-list')
    const fonts = await fontList.getFonts()
    return fonts.map(f => f.replace(/^['"]|['"]$/g, '').trim()).filter(Boolean)
  } catch (err) {
    console.error('获取系统字体列表失败:', err)
    return []
  }
}

/**
 * 注册所有 IPC 通信处理器
 * 主进程与渲染进程之间的通信桥梁
 */
export function registerIpcHandlers(): void {
  // 窗口控制
  ipcMain.on('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  ipcMain.on('window:maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win?.isMaximized()) {
      win.unmaximize()
    } else {
      win?.maximize()
    }
  })

  ipcMain.on('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  ipcMain.handle('window:isMaximized', (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
  })

  ipcMain.on('window:toggle-devtools', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      if (win.webContents.isDevToolsOpened()) {
        win.webContents.closeDevTools()
      } else {
        win.webContents.openDevTools({ mode: 'undocked' })
      }
    }
  })

  // 文件对话框
  ipcMain.handle('dialog:openDirectory', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory']
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle('dialog:openImage', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'bmp', 'gif', 'webp', 'svg'] }]
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle('dialog:readImageAsDataURL', async (_event, filePath: string) => {
    try {
      const ext = extname(filePath).toLowerCase().replace('.', '')
      const mimeMap: Record<string, string> = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
        gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml'
      }
      const mime = mimeMap[ext] || 'image/png'
      const buf = readFileSync(filePath)
      const base64 = buf.toString('base64')
      return `data:${mime};base64,${base64}`
    } catch {
      return null
    }
  })

  // 存储：加载保存的会话
  ipcMain.handle('storage:load-saved-sessions', () => {
    return loadSavedSessionsFromDisk()
  })

  // 存储：保存会话到磁盘
  ipcMain.handle('storage:save-saved-sessions', (_event, sessions: SavedSession[]) => {
    saveSavedSessionsToDisk(sessions)
  })

  // 存储：加载保存的会话
  ipcMain.handle('app:get-default-log-dir', () => {
    return join(app.getPath('documents'), 'wilson-terminal', 'logs')
  })

  // 统一连接管理
  registerConnectionHandlers()
  registerSSHSpecificHandlers()
  registerSerialSpecificHandlers()
  registerBashSpecificHandlers()

  // SFTP 文件管理
  setActiveConnectionsGetter(() => getActiveClientsMap())
  registerSFTPHandlers()

  // 键盘锁状态查询（使用 koffi 调用 Windows API）
  ipcMain.handle('keyboard:get-lock-state', () => {
    return getKeyboardLockState()
  })

  // 日志管理
  ipcMain.handle('log:start', (_event, sessionId: string, logConfig: LogConfig, connectionConfig: ConnectionConfig) => {
    logManager.createLogger(sessionId, logConfig, connectionConfig)
  })

  ipcMain.handle('log:stop', async (_event, sessionId: string) => {
    await logManager.closeLogger(sessionId)
  })

  ipcMain.handle('log:get-file-path', (_event, sessionId: string) => {
    return logManager.getLogFilePath(sessionId)
  })

  ipcMain.handle('log:get-dir', (_event, sessionId: string) => {
    return logManager.getLogDir(sessionId) || join(app.getPath('documents'), 'wilson-terminal', 'logs')
  })

  ipcMain.handle('log:open-file', async (_event, sessionId: string) => {
    const filePath = logManager.getLogFilePath(sessionId)
    if (filePath) {
      shell.openPath(filePath)
      return true
    }
    return false
  })

  ipcMain.handle('log:open-dir', async (_event, sessionIdOrPath: string) => {
    // 优先尝试获取当前会话的日志文件路径，有文件则用 showItemInFolder 选中它
    const filePath = logManager.getLogFilePath(sessionIdOrPath)
    if (filePath) {
      shell.showItemInFolder(filePath)
      return
    }
    // 没有活跃会话或没有日志文件时，至少打开目录
    const dir = logManager.getLogDir(sessionIdOrPath) || join(app.getPath('documents'), 'wilson-terminal', 'logs')
    shell.openPath(dir)
  })

  // 应用版本
  ipcMain.handle('app:get-version', () => {
    return getCurrentVersion()
  })

  // 检查更新
  ipcMain.handle('app:check-update', (_event, force?: boolean) => {
    return checkForUpdates(force)
  })

  // 下载更新
  ipcMain.handle('app:download-update', () => {
    return downloadUpdate()
  })

  // 安装更新
  ipcMain.handle('app:install-update', () => {
    quitAndInstall()
  })

  // 取消自动安装倒计时
  ipcMain.handle('app:cancel-auto-install', () => {
    cancelAutoInstall()
  })

  // 获取更新状态
  ipcMain.handle('app:get-update-status', () => {
    return getStatus()
  })

  // 忽略版本
  ipcMain.handle('app:get-ignored-versions', () => {
    return getIgnoredVersions()
  })

  ipcMain.handle('app:save-ignored-versions', (_event, versions: string[]) => {
    saveIgnoredVersions(versions)
  })

  // 存储：按钮栏分组数据
  ipcMain.handle('storage:load-command-button-groups', () => {
    return loadCommandButtonGroupsFromDisk()
  })

  ipcMain.handle('storage:save-command-button-groups', (_event, groups: CommandButtonGroup[]) => {
    saveCommandButtonGroupsToDisk(groups)
  })

  // 存储：应用设置
  ipcMain.handle('storage:load-app-settings', () => {
    return loadAppSettingsFromDisk()
  })

  ipcMain.handle('storage:save-app-settings', (_event, settings: AppSettings) => {
    saveAppSettingsToDisk(settings)
  })

  // 存储：视图状态
  ipcMain.handle('storage:load-view-state', () => {
    return loadViewStateFromDisk()
  })

  ipcMain.handle('storage:save-view-state', (_event, state: ViewState) => {
    saveViewStateToDisk(state)
  })

  // 存储：定时任务
  ipcMain.handle('storage:load-scheduled-tasks', () => {
    return loadScheduledTasksFromDisk()
  })

  ipcMain.handle('storage:save-scheduled-tasks', (_event, tasks: Record<string, ScheduledTask[]>) => {
    saveScheduledTasksToDisk(tasks)
  })

  // 存储：Profile 列表
  ipcMain.handle('storage:load-profiles', () => {
    return loadProfilesFromDisk()
  })

  ipcMain.handle('storage:save-profiles', (_event, profiles: Profile[]) => {
    saveProfilesToDisk(profiles)
  })

  // 存储：会话分组
  ipcMain.handle('storage:loadSavedSessionGroups', async () => {
    return loadSavedSessionGroupsFromDisk()
  })

  ipcMain.handle('storage:saveSavedSessionGroups', async (_event, groups: SavedSessionGroup[]) => {
    saveSavedSessionGroupsToDisk(groups)
  })

  // 插件管理
  ipcMain.handle('plugin:list', () => mainPluginHost.getPluginList())

  ipcMain.handle('plugin:get-renderer-code', (_e, id: string) => mainPluginHost.readRendererCode(id))

  ipcMain.handle('plugin:toggle', async (_e, id: string, enabled: boolean) => {
    if (enabled) await mainPluginHost.activate(id)
    else await mainPluginHost.deactivate(id)
    return true
  })

  ipcMain.handle('plugin:import-zip', async (_e, zipPath?: string) => {
    if (!zipPath) {
      const result = await dialog.showOpenDialog({
        title: '选择插件 ZIP 文件',
        filters: [{ name: 'ZIP 文件', extensions: ['zip'] }],
        properties: ['openFile']
      })
      if (result.canceled || result.filePaths.length === 0) return { success: false, error: '用户取消' }
      zipPath = result.filePaths[0]
    }
    return mainPluginHost.importZip(zipPath)
  })

  ipcMain.handle('plugin:export-zip', (_e, id: string) => mainPluginHost.exportZip(id))

  ipcMain.handle('plugin:uninstall', async (_e, id: string) => mainPluginHost.uninstall(id))

  // 插件写入终端：主进程统一出口（支持所有连接类型）
  ipcMain.handle('plugin:write', async (_e, sessionId: string, data: string) => {
    const conn = connectionManager.get(sessionId)
    if (conn) conn.write(data)
  })

  // 获取活跃会话列表（支持所有连接类型）
  ipcMain.handle('plugin:get-sessions', () => {
    return connectionManager.getSessionIds()
  })

  // 获取系统字体列表
  ipcMain.handle('app:get-system-fonts', async () => {
    return await getSystemFonts()
  })

  // 在系统默认浏览器中打开 URL
  ipcMain.handle('shell:open-external', (_event, url: unknown) => {
    if (typeof url === 'string' && (url.startsWith('http:') || url.startsWith('https:'))) {
      shell.openExternal(url)
    }
  })

  // 获取当前计算机域名（用于判断是否为公司域）
  ipcMain.handle('app:get-domain', () => {
    return getComputerDomain()
  })
}

