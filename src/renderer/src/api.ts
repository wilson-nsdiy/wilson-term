// 渲染进程 API 适配层
// 用 Tauri 的 invoke + listen 重新实现原 Electron 的 window.api
// 保持组件代码无需修改

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import type {
  ConnectionConfig,
  HostKeyVerifyRequest,
  KeyboardLockState,
  LogConfig,
  PasswordRequest,
  SerialPortInfo,
  ShellInfo,
  SftpFileEntry,
  SftpResult,
  UpdateStatusSnapshot,
  PluginListItem,
  PluginImportResult,
  PluginExportResult
} from '@shared/types'

// ============== 事件监听工具 ==============

/**
 * 安全事件监听器工厂:消除 listen() 异步注册与 cleanup 同步调用的竞态。
 *
 * 原竞态:`listen(...).then((fn) => { unlisten = fn })` 异步赋值,返回的 cleanup
 * `() => { unlisten?.() }` 在 listen 注册完成前调则无效,事件已派发但 cleanup 丢失。
 *
 * 修复:用 pending 标记同步已调过 cleanup,listen 完成后若 pending 则立即 unlisten。
 * 返回的 cleanup 仍是同步 `() => void`,调用方无需改。
 */
function safeListen<T>(event: string, handler: (payload: T) => void): () => void {
  let unlisten: UnlistenFn | null = null
  let disposed = false
  listen<T>(event, (e) => handler(e.payload)).then((fn) => {
    if (disposed) {
      // cleanup 已先于 listen 完成,立即 unlisten 避免泄漏
      fn()
    } else {
      unlisten = fn
    }
  })
  return () => {
    disposed = true
    unlisten?.()
    unlisten = null
  }
}

// ============== window ==============

async function windowMinimize(): Promise<void> {
  await invoke('window_minimize')
}
async function windowMaximize(): Promise<void> {
  await invoke('window_maximize')
}
async function windowClose(): Promise<void> {
  await invoke('window_close')
}
async function windowIsMaximized(): Promise<boolean> {
  return invoke<boolean>('window_is_maximized')
}
async function windowToggleDevtools(): Promise<void> {
  await invoke('window_toggle_devtools')
}
async function windowStartDragging(): Promise<void> {
  await invoke('window_start_dragging')
}

// ============== dialog ==============

async function dialogOpenDirectory(): Promise<string | null> {
  // 使用 tauri-plugin-dialog
  const { open } = await import('@tauri-apps/plugin-dialog')
  const result = await open({ directory: true })
  return result as string | null
}

async function dialogOpenImage(): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const result = await open({
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] }]
  })
  return result as string | null
}

async function dialogReadImageAsDataURL(filePath: string): Promise<string | null> {
  try {
    const { readFile } = await import('@tauri-apps/plugin-fs')
    const bytes = await readFile(filePath)
    // 转 base64
    let binary = ''
    const chunkSize = 0x8000
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize)
      binary += String.fromCharCode.apply(null, Array.from(chunk))
    }
    const base64 = btoa(binary)
    const ext = filePath.split('.').pop()?.toLowerCase() || 'png'
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
      : ext === 'png' ? 'image/png'
      : ext === 'gif' ? 'image/gif'
      : ext === 'webp' ? 'image/webp'
      : 'image/png'
    return `data:${mime};base64,${base64}`
  } catch {
    return null
  }
}

// ============== connection ==============

async function connectionConnect(config: ConnectionConfig, logConfig?: LogConfig): Promise<void> {
  await invoke('connection_connect', { config, logConfig: logConfig ?? null })
}

async function connectionDisconnect(sessionId: string): Promise<void> {
  await invoke('connection_disconnect', { sessionId })
}

async function connectionWrite(sessionId: string, data: string): Promise<void> {
  await invoke('connection_write', { sessionId, data })
}

async function connectionResize(sessionId: string, cols: number, rows: number): Promise<void> {
  await invoke('connection_resize', { sessionId, cols, rows })
}

function connectionOnData(callback: (sessionId: string, data: string) => void): () => void {
  return safeListen<[string, string]>('connection:data', (payload) => {
    callback(payload[0], payload[1])
  })
}

function connectionOnStatus(
  callback: (sessionId: string, status: string, errorMessage?: string) => void
): () => void {
  return safeListen<[string, string, string | undefined]>('connection:status', (payload) => {
    callback(payload[0], payload[1], payload[2])
  })
}

// ============== ssh ==============

function sshOnHostKeyVerify(callback: (request: HostKeyVerifyRequest) => void): () => void {
  return safeListen<HostKeyVerifyRequest>('ssh:hostKeyVerify', (payload) => callback(payload))
}

function sshOnPasswordRequest(callback: (request: PasswordRequest) => void): () => void {
  return safeListen<PasswordRequest>('ssh:passwordRequest', (payload) => callback(payload))
}

async function sshRespondHostKey(sessionId: string, accepted: boolean): Promise<void> {
  await invoke('ssh_respond_host_key', { sessionId, accepted })
}

async function sshRespondPassword(sessionId: string, password: string): Promise<void> {
  await invoke('ssh_respond_password', { sessionId, password })
}

async function sshGenerateKeyPair(type?: 'ed25519' | 'rsa') {
  return invoke('ssh_generate_key_pair', { keyType: type ?? 'ed25519' })
}

// ============== serial ==============

async function serialListPorts(): Promise<SerialPortInfo[]> {
  return invoke<SerialPortInfo[]>('serial_list_ports')
}

// ============== bash ==============

async function bashListShells(): Promise<ShellInfo[]> {
  return invoke<ShellInfo[]>('bash_list_shells')
}

// ============== sftp ==============

async function sftpList(sessionId: string, remotePath: string): Promise<SftpFileEntry[]> {
  return invoke<SftpFileEntry[]>('sftp_list', { sessionId, remotePath })
}

async function sftpUpload(sessionId: string, localPath: string, remotePath: string): Promise<SftpResult> {
  return invoke<SftpResult>('sftp_upload', { sessionId, localPath, remotePath })
}

async function sftpDownload(sessionId: string, remotePath: string, localPath: string): Promise<SftpResult> {
  return invoke<SftpResult>('sftp_download', { sessionId, remotePath, localPath })
}

async function sftpDelete(sessionId: string, remotePath: string, isDir: boolean): Promise<SftpResult> {
  return invoke<SftpResult>('sftp_delete', { sessionId, remotePath, isDir })
}

async function sftpMkdir(sessionId: string, remotePath: string): Promise<SftpResult> {
  return invoke<SftpResult>('sftp_mkdir', { sessionId, remotePath })
}

async function sftpRename(sessionId: string, oldPath: string, newPath: string): Promise<SftpResult> {
  return invoke<SftpResult>('sftp_rename', { sessionId, oldPath, newPath })
}

async function sftpSelectUploadFiles(): Promise<string[]> {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const result = await open({ multiple: true })
  if (!result) return []
  return Array.isArray(result) ? result : [result]
}

async function sftpSelectDownloadPath(defaultName: string): Promise<string | null> {
  const { save } = await import('@tauri-apps/plugin-dialog')
  const result = await save({ defaultPath: defaultName })
  return result
}

// ============== storage ==============

async function storageLoadSavedSessions() {
  return invoke<SavedSession[]>('storage_load_saved_sessions')
}
async function storageSaveSavedSessions(sessions: SavedSession[]) {
  await invoke('storage_save_saved_sessions', { sessions })
}
async function storageLoadSavedSessionGroups() {
  return invoke<SavedSessionGroup[]>('storage_load_saved_session_groups')
}
async function storageSaveSavedSessionGroups(groups: SavedSessionGroup[]) {
  await invoke('storage_save_saved_session_groups', { groups })
}
async function storageLoadCommandButtonGroups() {
  return invoke<CommandButtonGroup[]>('storage_load_command_button_groups')
}
async function storageSaveCommandButtonGroups(groups: CommandButtonGroup[]) {
  await invoke('storage_save_command_button_groups', { groups })
}
async function storageLoadAppSettings() {
  return invoke<AppSettings | null>('storage_load_app_settings')
}
async function storageSaveAppSettings(settings: AppSettings) {
  await invoke('storage_save_app_settings', { settings })
}
async function storageLoadViewState() {
  return invoke<ViewState | null>('storage_load_view_state')
}
async function storageSaveViewState(state: ViewState) {
  await invoke('storage_save_view_state', { state })
}
async function storageLoadScheduledTasks() {
  return invoke<Record<string, ScheduledTask[]>>('storage_load_scheduled_tasks')
}
async function storageSaveScheduledTasks(tasks: Record<string, ScheduledTask[]>) {
  await invoke('storage_save_scheduled_tasks', { tasks })
}
async function storageLoadProfiles() {
  return invoke<Profile[]>('storage_load_profiles')
}
async function storageSaveProfiles(profiles: Profile[]) {
  await invoke('storage_save_profiles', { profiles })
}

// ============== keyboard ==============

async function keyboardGetLockState(): Promise<KeyboardLockState> {
  return invoke<KeyboardLockState>('keyboard_get_lock_state')
}

function keyboardOnLockStateChanged(callback: (state: KeyboardLockState) => void): () => void {
  return safeListen<KeyboardLockState>('keyboard:lock-state-changed', (payload) => callback(payload))
}

async function keyboardSetPollingEnabled(enabled: boolean): Promise<void> {
  // 简化：Tauri 暂不实现按需轮询，保留接口
}

// ============== log ==============

async function logStart(sessionId: string, logConfig: LogConfig, connectionConfig: ConnectionConfig): Promise<void> {
  // Rust 端在 connect 时已创建 logger，本接口保留以兼容现有代码
}

async function logStop(sessionId: string): Promise<void> {
  await invoke('log_stop', { sessionId })
}

async function logGetDefaultLogDir(): Promise<string> {
  return invoke<string>('app_get_default_log_dir')
}

async function logGetFilePath(sessionId: string): Promise<string | null> {
  return invoke<string | null>('log_get_file_path', { sessionId })
}

async function logGetDir(sessionId: string): Promise<string | null> {
  return invoke<string | null>('log_get_dir', { sessionId })
}

async function logOpenFile(sessionId: string): Promise<void> {
  const path = await logGetFilePath(sessionId)
  if (path) {
    await invoke('shell_open_path', { path })
  }
}

async function logOpenDir(sessionId: string): Promise<void> {
  const dir = await logGetDir(sessionId)
  if (dir) {
    await invoke('shell_open_path', { path: dir })
  }
}

// ============== app ==============

async function appGetVersion(): Promise<string> {
  return invoke<string>('app_get_version')
}

async function appGetDomain(): Promise<string> {
  return invoke<string>('app_get_domain')
}

async function appGetSystemFonts(): Promise<string[]> {
  return invoke<string[]>('app_get_system_fonts')
}

async function appCheckUpdate(force?: boolean): Promise<UpdateStatusSnapshot> {
  return invoke<UpdateStatusSnapshot>('app_check_update', { force: force ?? false })
}

async function appDownloadUpdate(): Promise<void> {
  await invoke('app_download_update')
}

async function appCancelDownloadUpdate(): Promise<void> {
  await invoke('app_cancel_download_update')
}

async function appInstallUpdate(): Promise<void> {
  await invoke('app_install_update')
}

async function appGetUpdateStatus(): Promise<UpdateStatusSnapshot> {
  return invoke<UpdateStatusSnapshot>('app_get_update_status')
}

async function appGetIgnoredVersions(): Promise<string[]> {
  return invoke<string[]>('app_get_ignored_versions')
}

async function appSaveIgnoredVersions(versions: string[]): Promise<void> {
  await invoke('app_save_ignored_versions', { versions })
}

function appOnUpdateStatusChanged(
  callback: (snapshot: UpdateStatusSnapshot) => void
): () => void {
  return safeListen<UpdateStatusSnapshot>('update:status-changed', (payload) => callback(payload))
}

// ============== plugin ==============

async function pluginList(): Promise<PluginListItem[]> {
  return invoke<PluginListItem[]>('plugin_list')
}

async function pluginToggle(id: string, enabled: boolean): Promise<boolean> {
  return invoke<boolean>('plugin_toggle', { id, enabled })
}

async function pluginImportZip(zipPath?: string): Promise<PluginImportResult> {
  return invoke<PluginImportResult>('plugin_import_zip', { zipPath: zipPath ?? null })
}

async function pluginExportZip(id: string): Promise<PluginExportResult> {
  return invoke<PluginExportResult>('plugin_export_zip', { id })
}

async function pluginUninstall(id: string): Promise<boolean> {
  return invoke<boolean>('plugin_uninstall', { id })
}

async function pluginGetRendererCode(id: string): Promise<string | null> {
  return invoke<string | null>('plugin_get_renderer_code', { id })
}

async function pluginWrite(sessionId: string, data: string): Promise<void> {
  await invoke('plugin_write', { sessionId, data })
}

async function pluginGetSessions(): Promise<string[]> {
  return invoke<string[]>('plugin_get_sessions')
}

// ============== shell ==============

async function shellOpenExternal(url: string): Promise<void> {
  await invoke('shell_open_external', { url })
}

// ============== 导出 api ==============

export const api = {
  window: {
    minimize: windowMinimize,
    maximize: windowMaximize,
    close: windowClose,
    isMaximized: windowIsMaximized,
    toggleDevtools: windowToggleDevtools,
    startDragging: windowStartDragging
  },
  dialog: {
    openDirectory: dialogOpenDirectory,
    openImage: dialogOpenImage,
    readImageAsDataURL: dialogReadImageAsDataURL
  },
  connection: {
    connect: connectionConnect,
    disconnect: connectionDisconnect,
    write: connectionWrite,
    resize: connectionResize,
    onData: connectionOnData,
    onStatus: connectionOnStatus
  },
  ssh: {
    onHostKeyVerify: sshOnHostKeyVerify,
    onPasswordRequest: sshOnPasswordRequest,
    respondHostKey: sshRespondHostKey,
    respondPassword: sshRespondPassword,
    generateKeyPair: sshGenerateKeyPair
  },
  serial: {
    listPorts: serialListPorts
  },
  bash: {
    listShells: bashListShells
  },
  sftp: {
    list: sftpList,
    upload: sftpUpload,
    download: sftpDownload,
    delete: sftpDelete,
    mkdir: sftpMkdir,
    rename: sftpRename,
    selectUploadFiles: sftpSelectUploadFiles,
    selectDownloadPath: sftpSelectDownloadPath
  },
  storage: {
    loadSavedSessions: storageLoadSavedSessions,
    saveSavedSessions: storageSaveSavedSessions,
    loadSavedSessionGroups: storageLoadSavedSessionGroups,
    saveSavedSessionGroups: storageSaveSavedSessionGroups,
    loadCommandButtonGroups: storageLoadCommandButtonGroups,
    saveCommandButtonGroups: storageSaveCommandButtonGroups,
    loadAppSettings: storageLoadAppSettings,
    saveAppSettings: storageSaveAppSettings,
    loadViewState: storageLoadViewState,
    saveViewState: storageSaveViewState,
    loadScheduledTasks: storageLoadScheduledTasks,
    saveScheduledTasks: storageSaveScheduledTasks,
    loadProfiles: storageLoadProfiles,
    saveProfiles: storageSaveProfiles
  },
  keyboard: {
    getLockState: keyboardGetLockState,
    onLockStateChanged: keyboardOnLockStateChanged,
    setPollingEnabled: keyboardSetPollingEnabled
  },
  log: {
    start: logStart,
    stop: logStop,
    getDefaultLogDir: logGetDefaultLogDir,
    getFilePath: logGetFilePath,
    getDir: logGetDir,
    openFile: logOpenFile,
    openDir: logOpenDir
  },
  app: {
    getVersion: appGetVersion,
    getDomain: appGetDomain,
    getSystemFonts: appGetSystemFonts,
    checkUpdate: appCheckUpdate,
    downloadUpdate: appDownloadUpdate,
    cancelDownloadUpdate: appCancelDownloadUpdate,
    installUpdate: appInstallUpdate,
    getUpdateStatus: appGetUpdateStatus,
    getIgnoredVersions: appGetIgnoredVersions,
    saveIgnoredVersions: appSaveIgnoredVersions,
    onUpdateStatusChanged: appOnUpdateStatusChanged
  },
  plugin: {
    list: pluginList,
    toggle: pluginToggle,
    importZip: pluginImportZip,
    exportZip: pluginExportZip,
    uninstall: pluginUninstall,
    getRendererCode: pluginGetRendererCode,
    write: pluginWrite,
    getSessions: pluginGetSessions
  },
  shell: {
    openExternal: shellOpenExternal
  }
}

// 暴露到 window，兼容现有 `window.api.xxx` 写法
declare global {
  interface Window {
    api: typeof api
  }
}

export default api
