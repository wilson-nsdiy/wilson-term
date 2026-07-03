import { autoUpdater } from 'electron-updater'
import { BrowserWindow, app } from 'electron'
import { loadIgnoredVersionsFromDisk, saveIgnoredVersionsToDisk, loadLastAutoCheckTimestamp, saveLastAutoCheckTimestamp } from './storage'
import type { UpdateStatus, UpdateInfoSnapshot, UpdateProgressSnapshot, UpdateStatusSnapshot } from '@shared/types'

/** 自动检查更新的最小间隔（7天，毫秒） */
const AUTO_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

let mainWindow: BrowserWindow | null = null
let currentStatus: UpdateStatus = 'idle'
let updateInfo: UpdateInfoSnapshot | undefined
let downloadProgress: UpdateProgressSnapshot | undefined
let lastError: string | undefined
let autoInstallTimer: ReturnType<typeof setTimeout> | null = null
let autoInstallCountdown = 0
let isManual = false

function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

function pushStatus(): void {
  const snapshot: UpdateStatusSnapshot = {
    status: currentStatus,
    info: updateInfo,
    progress: downloadProgress,
    error: lastError,
    autoInstallCountdown: autoInstallCountdown > 0 ? autoInstallCountdown : undefined,
    manual: isManual
  }
  sendToRenderer('update:status-changed', snapshot)
}

function setStatus(status: UpdateStatus): void {
  currentStatus = status
  pushStatus()
}

export function initAutoUpdater(win: BrowserWindow): void {
  mainWindow = win

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('checking-for-update', () => {
    setStatus('checking')
  })

  autoUpdater.on('update-available', (info) => {
    if (shouldSkipUpdate(info.version)) {
      updateInfo = undefined
      setStatus('not-available')
      return
    }
    updateInfo = {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: typeof info.releaseNotes === 'string'
        ? info.releaseNotes
        : Array.isArray(info.releaseNotes)
          ? info.releaseNotes.map((n) => n.note).filter(Boolean).join('\n')
          : null
    }
    downloadProgress = undefined
    lastError = undefined
    setStatus('available')
  })

  autoUpdater.on('update-not-available', () => {
    updateInfo = undefined
    setStatus('not-available')
  })

  autoUpdater.on('download-progress', (progress) => {
    downloadProgress = {
      bytesPerSecond: progress.bytesPerSecond,
      percent: progress.percent,
      total: progress.total,
      transferred: progress.transferred
    }
    currentStatus = 'downloading'
    pushStatus()
  })

  autoUpdater.on('update-downloaded', () => {
    downloadProgress = undefined
    setStatus('downloaded')
    startAutoInstallCountdown()
  })

  autoUpdater.on('error', (err) => {
    lastError = err?.message || '未知错误'
    setStatus('error')
  })
}

export function getStatus(): UpdateStatusSnapshot {
  return {
    status: currentStatus,
    info: updateInfo,
    progress: downloadProgress,
    error: lastError,
    autoInstallCountdown: autoInstallCountdown > 0 ? autoInstallCountdown : undefined,
    manual: isManual
  }
}

export function getCurrentVersion(): string {
  return app.getVersion()
}

export async function checkForUpdates(force = false): Promise<UpdateStatusSnapshot> {
  isManual = force
  if (!app.isPackaged) {
    currentStatus = 'error'
    lastError = '开发模式下无法检查更新'
    pushStatus()
    return getStatus()
  }

  // 非强制模式下检查间隔
  if (!force) {
    const lastCheck = loadLastAutoCheckTimestamp()
    if (lastCheck !== null) {
      const elapsed = Date.now() - lastCheck
      if (elapsed < AUTO_CHECK_INTERVAL_MS) {
        currentStatus = 'not-available'
        updateInfo = undefined
        pushStatus()
        return getStatus()
      }
    }
  }

  // 记录本次检查时间
  saveLastAutoCheckTimestamp(Date.now())

  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    lastError = err instanceof Error ? err.message : '检查更新失败'
    setStatus('error')
  }
  return getStatus()
}

export async function downloadUpdate(): Promise<void> {
  try {
    await autoUpdater.downloadUpdate()
  } catch (err) {
    lastError = err instanceof Error ? err.message : '下载更新失败'
    setStatus('error')
  }
}

export function quitAndInstall(): void {
  cancelAutoInstall()
  autoUpdater.quitAndInstall()
}

function startAutoInstallCountdown(): void {
  cancelAutoInstall()
  autoInstallCountdown = 5
  pushStatus()

  const tick = (): void => {
    autoInstallCountdown--
    if (autoInstallCountdown <= 0) {
      autoInstallTimer = null
      quitAndInstall()
      return
    }
    pushStatus()
    autoInstallTimer = setTimeout(tick, 1000)
  }

  autoInstallTimer = setTimeout(tick, 1000)
}

export function cancelAutoInstall(): void {
  if (autoInstallTimer) {
    clearTimeout(autoInstallTimer)
    autoInstallTimer = null
  }
  autoInstallCountdown = 0
  pushStatus()
}

export function getIgnoredVersions(): string[] {
  return loadIgnoredVersionsFromDisk()
}

export function saveIgnoredVersions(versions: string[]): void {
  saveIgnoredVersionsToDisk(versions)
}

export function shouldSkipUpdate(version: string): boolean {
  const ignored = loadIgnoredVersionsFromDisk()
  return ignored.includes(version)
}
