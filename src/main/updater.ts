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
let isManual = false

function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

function buildSnapshot(): UpdateStatusSnapshot {
  return {
    status: currentStatus,
    info: updateInfo,
    progress: downloadProgress,
    error: lastError,
    manual: isManual
  }
}

function pushStatus(): void {
  sendToRenderer('update:status-changed', buildSnapshot())
}

function setStatus(status: UpdateStatus): void {
  currentStatus = status
  pushStatus()
}

/** 将 GitHub atom feed 里的 HTML releaseNotes 转回 markdown 文本 */
function htmlToMarkdown(html: string): string {
  return html
    .replace(/<h([1-6])>([^<]*)<\/h\1>/g, (_, level, text) => `${'#'.repeat(Number(level))} ${text}`)
    .replace(/<li>([^<]*)<\/li>/g, '- $1')
    .replace(/<\/?(ul|ol|table|thead|tbody|tr|th|td|p|hr|div|blockquote|a|code|pre|strong|em)[^>]*>/g, '')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 从 GitHub Release body 中提取 changelog 部分，去掉标题、项目介绍、下载表格、系统要求等无关内容 */
function extractChangelog(raw: string): string | null {
  const text = htmlToMarkdown(raw)
  const lines = text.split(/\r?\n/)
  const headings = ['### Added', '### Changed', '### Fixed', '### Removed', '### Deprecated', '### Security']
  const startIdx = lines.findIndex((l) => headings.some((h) => l.startsWith(h)))
  if (startIdx === -1) return null
  const endIdx = lines.findIndex((l, i) => i > startIdx && /^### /.test(l) && !headings.some((h) => l.startsWith(h)))
  const end = endIdx === -1 ? lines.length : endIdx
  const block = lines.slice(startIdx, end).join('\n').trim()
  return block || null
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
    const rawNotes = typeof info.releaseNotes === 'string'
      ? info.releaseNotes
      : Array.isArray(info.releaseNotes)
        ? info.releaseNotes.map((n) => n.note).filter(Boolean).join('\n')
        : null
    updateInfo = {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: rawNotes ? extractChangelog(rawNotes) : null
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
  })

  autoUpdater.on('error', (err) => {
    lastError = err?.message || '未知错误'
    setStatus('error')
  })
}

export function getStatus(): UpdateStatusSnapshot {
  return buildSnapshot()
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
        // 距离上次检查不足7天，跳过自动检查
        return getStatus()
      }
    }
  }

  try {
    await autoUpdater.checkForUpdates()
    saveLastAutoCheckTimestamp(Date.now()).catch((err) => {
      console.error('保存上次检查时间戳失败:', err)
    })
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
  autoUpdater.quitAndInstall()
}

export function getIgnoredVersions(): string[] {
  return loadIgnoredVersionsFromDisk()
}

export async function saveIgnoredVersions(versions: string[]): Promise<void> {
  await saveIgnoredVersionsToDisk(versions)
}

export function shouldSkipUpdate(version: string): boolean {
  const ignored = loadIgnoredVersionsFromDisk()
  return ignored.includes(version)
}
