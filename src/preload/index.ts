import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { LogConfig, HostKeyVerifyRequest, KeyboardLockState, PasswordRequest, UpdateStatusSnapshot } from '@shared/types'

// 自定义 API 暴露给渲染进程
const api = {
  // 文件对话框
  dialog: {
    openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
    openImage: () => ipcRenderer.invoke('dialog:openImage'),
    readImageAsDataURL: (filePath: string) => ipcRenderer.invoke('dialog:readImageAsDataURL', filePath)
  },

  // 窗口控制
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    toggleDevtools: () => ipcRenderer.send('window:toggle-devtools')
  },

  // 统一连接 API
  connection: {
    connect: (config: unknown, logConfig?: unknown) => ipcRenderer.invoke('connection:connect', config, logConfig),
    disconnect: (sessionId: string) => ipcRenderer.invoke('connection:disconnect', sessionId),
    reopen: (sessionId: string) => ipcRenderer.invoke('connection:reopen', sessionId),
    write: (sessionId: string, data: string) => ipcRenderer.send('connection:write', sessionId, data),
    resize: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.send('connection:resize', sessionId, cols, rows),
    onData: (callback: (sessionId: string, data: string) => void) => {
      const subscription = (_event: Electron.IpcRendererEvent, sessionId: string, data: string) =>
        callback(sessionId, data)
      ipcRenderer.on('connection:data', subscription)
      return () => ipcRenderer.removeListener('connection:data', subscription)
    },
    onStatus: (callback: (sessionId: string, status: string, errorMessage?: string) => void) => {
      const subscription = (_event: Electron.IpcRendererEvent, sessionId: string, status: string, errorMessage?: string) =>
        callback(sessionId, status, errorMessage)
      ipcRenderer.on('connection:status', subscription)
      return () => ipcRenderer.removeListener('connection:status', subscription)
    }
  },

  // SSH 专属 API（主机密钥验证、密钥生成、密码输入）
  ssh: {
    onHostKeyVerify: (callback: (request: HostKeyVerifyRequest) => void) => {
      const subscription = (_event: Electron.IpcRendererEvent, request: HostKeyVerifyRequest) =>
        callback(request)
      ipcRenderer.on('ssh:hostKeyVerify', subscription)
      return () => ipcRenderer.removeListener('ssh:hostKeyVerify', subscription)
    },
    respondHostKey: (sessionId: string, accepted: boolean) =>
      ipcRenderer.send('ssh:respondHostKey', sessionId, accepted),
    generateKeyPair: (type?: 'ed25519' | 'rsa') =>
      ipcRenderer.invoke('ssh:generateKeyPair', type || 'ed25519'),
    onPasswordRequest: (callback: (request: PasswordRequest) => void) => {
      const subscription = (_event: Electron.IpcRendererEvent, request: PasswordRequest) =>
        callback(request)
      ipcRenderer.on('ssh:passwordRequest', subscription)
      return () => ipcRenderer.removeListener('ssh:passwordRequest', subscription)
    },
    respondPassword: (sessionId: string, password: string) =>
      ipcRenderer.send('ssh:respondPassword', sessionId, password)
  },

  // SFTP 文件管理
  sftp: {
    list: (sessionId: string, remotePath: string) =>
      ipcRenderer.invoke('sftp:list', sessionId, remotePath),
    upload: (sessionId: string, localPath: string, remotePath: string) =>
      ipcRenderer.invoke('sftp:upload', sessionId, localPath, remotePath),
    download: (sessionId: string, remotePath: string, localPath: string) =>
      ipcRenderer.invoke('sftp:download', sessionId, remotePath, localPath),
    delete: (sessionId: string, remotePath: string, isDir: boolean) =>
      ipcRenderer.invoke('sftp:delete', sessionId, remotePath, isDir),
    mkdir: (sessionId: string, remotePath: string) =>
      ipcRenderer.invoke('sftp:mkdir', sessionId, remotePath),
    rename: (sessionId: string, oldPath: string, newPath: string) =>
      ipcRenderer.invoke('sftp:rename', sessionId, oldPath, newPath),
    selectUploadFiles: () => ipcRenderer.invoke('sftp:selectUploadFiles'),
    selectDownloadPath: (defaultName: string) => ipcRenderer.invoke('sftp:selectDownloadPath', defaultName)
  },

  // 串口专属 API（列表查询）
  serial: {
    listPorts: () => ipcRenderer.invoke('serial:list-ports')
  },

  // Bash 专属 API（Shell 列表查询）
  bash: {
    listShells: () => ipcRenderer.invoke('bash:list-shells') as Promise<ShellInfo[]>
  },

  // 存储
  storage: {
    loadSavedSessions: () => ipcRenderer.invoke('storage:load-saved-sessions'),
    saveSavedSessions: (sessions: unknown) => ipcRenderer.invoke('storage:save-saved-sessions', sessions),
    loadSavedSessionGroups: () => ipcRenderer.invoke('storage:loadSavedSessionGroups'),
    saveSavedSessionGroups: (groups: unknown) => ipcRenderer.invoke('storage:saveSavedSessionGroups', groups),
    loadCommandButtonGroups: () => ipcRenderer.invoke('storage:load-command-button-groups'),
    saveCommandButtonGroups: (groups: unknown) => ipcRenderer.invoke('storage:save-command-button-groups', groups),
    loadAppSettings: () => ipcRenderer.invoke('storage:load-app-settings'),
    saveAppSettings: (settings: unknown) => ipcRenderer.invoke('storage:save-app-settings', settings),
    loadViewState: () => ipcRenderer.invoke('storage:load-view-state'),
    saveViewState: (state: unknown) => ipcRenderer.invoke('storage:save-view-state', state),
    loadScheduledTasks: () => ipcRenderer.invoke('storage:load-scheduled-tasks'),
    saveScheduledTasks: (tasks: unknown) => ipcRenderer.invoke('storage:save-scheduled-tasks', tasks),
    loadProfiles: () => ipcRenderer.invoke('storage:load-profiles'),
    saveProfiles: (profiles: unknown) => ipcRenderer.invoke('storage:save-profiles', profiles)
  },

  // 键盘状态
  keyboard: {
    getLockState: () => ipcRenderer.invoke('keyboard:get-lock-state'),
    onLockStateChanged: (callback: (state: KeyboardLockState) => void) => {
      const subscription = (_event: Electron.IpcRendererEvent, state: KeyboardLockState) =>
        callback(state)
      ipcRenderer.on('keyboard:lock-state-changed', subscription)
      return () => ipcRenderer.removeListener('keyboard:lock-state-changed', subscription)
    },
    setPollingEnabled: (enabled: boolean) => ipcRenderer.send('keyboard:set-polling-enabled', enabled)
  },

  // 日志管理
  log: {
    start: (sessionId: string, logConfig: unknown, connectionConfig: unknown) =>
      ipcRenderer.invoke('log:start', sessionId, logConfig, connectionConfig),
    stop: (sessionId: string) =>
      ipcRenderer.invoke('log:stop', sessionId),
    getDefaultLogDir: () => ipcRenderer.invoke('app:get-default-log-dir'),
    getFilePath: (sessionId: string) => ipcRenderer.invoke('log:get-file-path', sessionId),
    getDir: (sessionId: string) => ipcRenderer.invoke('log:get-dir', sessionId),
    openFile: (sessionId: string) => ipcRenderer.invoke('log:open-file', sessionId),
    openDir: (sessionId: string) => ipcRenderer.invoke('log:open-dir', sessionId)
  },

  // 应用更新
  app: {
    getVersion: () => ipcRenderer.invoke('app:get-version'),
    checkUpdate: (force?: boolean) => ipcRenderer.invoke('app:check-update', force),
    downloadUpdate: () => ipcRenderer.invoke('app:download-update'),
    installUpdate: () => ipcRenderer.invoke('app:install-update'),
    getUpdateStatus: () => ipcRenderer.invoke('app:get-update-status'),
    getIgnoredVersions: () => ipcRenderer.invoke('app:get-ignored-versions'),
    saveIgnoredVersions: (versions: string[]) => ipcRenderer.invoke('app:save-ignored-versions', versions),
    onUpdateStatusChanged: (callback: (snapshot: UpdateStatusSnapshot) => void) => {
      const subscription = (_event: Electron.IpcRendererEvent, snapshot: UpdateStatusSnapshot) =>
        callback(snapshot)
      ipcRenderer.on('update:status-changed', subscription)
      return () => ipcRenderer.removeListener('update:status-changed', subscription)
    },
    getDomain: () => ipcRenderer.invoke('app:get-domain'),
    getSystemFonts: () => ipcRenderer.invoke('app:get-system-fonts')
  },

  // 插件管理
  plugin: {
    invoke: (channel: string, ...args: unknown[]) => {
      if (!channel.startsWith('plugin:')) {
        throw new Error(`插件仅允许调用 plugin: 前缀的 channel`)
      }
      return ipcRenderer.invoke(channel, ...args)
    },
    on: (channel: string, callback: (...args: unknown[]) => void) => {
      if (!channel.startsWith('plugin:')) {
        throw new Error(`插件仅允许监听 plugin: 前缀的事件`)
      }
      const sub = (_e: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args)
      ipcRenderer.on(channel, sub)
      return () => ipcRenderer.removeListener(channel, sub)
    },
    list: () => ipcRenderer.invoke('plugin:list'),
    getRendererCode: (id: string) => ipcRenderer.invoke('plugin:get-renderer-code', id),
    toggle: (id: string, enabled: boolean) => ipcRenderer.invoke('plugin:toggle', id, enabled),
    importZip: (zipPath?: string) => ipcRenderer.invoke('plugin:import-zip', zipPath),
    exportZip: (id: string) => ipcRenderer.invoke('plugin:export-zip', id),
    uninstall: (id: string) => ipcRenderer.invoke('plugin:uninstall', id),
    write: (sessionId: string, data: string) => ipcRenderer.invoke('plugin:write', sessionId, data),
    getSessions: () => ipcRenderer.invoke('plugin:get-sessions'),
  },

  // 系统工具
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url)
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('electron', electronAPI)
  contextBridge.exposeInMainWorld('api', api)
} else {
  // @ts-expect-error fallback for contextIsolation disabled
  window.electron = electronAPI
  // @ts-expect-error fallback for contextIsolation disabled
  window.api = api
}
