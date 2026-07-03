import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import type { SavedSession, CommandButtonGroup, AppSettings, ScheduledTask, Profile } from '@shared/types'

/** 视图状态（需要持久化的 UI 开关） */
export interface ViewState {
  sidebarOpen: boolean
  commandInputVisible: boolean
  statusBarVisible: boolean
  buttonBarVisible: boolean
}

/** 获取存储目录路径 */
function getStorageDir(): string {
  if (process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'wilson-terminal')
  }
  return app.getPath('userData')
}

/** 获取存储文件路径 */
function getStoragePath(filename: string): string {
  return join(getStorageDir(), filename)
}

/** 从磁盘加载保存的会话（过滤掉无 config 字段的无效记录） */
export function loadSavedSessionsFromDisk(): SavedSession[] {
  const filePath = getStoragePath('saved-sessions.json')
  if (!existsSync(filePath)) {
    return []
  }
  try {
    const data = readFileSync(filePath, 'utf-8')
    const sessions = JSON.parse(data) as SavedSession[]
    return sessions.filter(s => s && s.config)
  } catch {
    return []
  }
}

/** 将保存的会话写入磁盘 */
export function saveSavedSessionsToDisk(sessions: SavedSession[]): void {
  const filePath = getStoragePath('saved-sessions.json')
  const dir = dirname(filePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(filePath, JSON.stringify(sessions, null, 2), 'utf-8')
}

/** 从磁盘加载被忽略的版本列表 */
export function loadIgnoredVersionsFromDisk(): string[] {
  const filePath = getStoragePath('ignored-versions.json')
  if (!existsSync(filePath)) {
    return []
  }
  try {
    const data = readFileSync(filePath, 'utf-8')
    return JSON.parse(data) as string[]
  } catch {
    return []
  }
}

/** 将被忽略的版本写入磁盘 */
export function saveIgnoredVersionsToDisk(versions: string[]): void {
  const filePath = getStoragePath('ignored-versions.json')
  const dir = dirname(filePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(filePath, JSON.stringify(versions), 'utf-8')
}

/** 从磁盘加载命令按钮分组（兼容旧版 command 字段） */
export function loadCommandButtonGroupsFromDisk(): CommandButtonGroup[] {
  const filePath = getStoragePath('command-button-groups.json')
  if (!existsSync(filePath)) {
    return []
  }
  try {
    const data = readFileSync(filePath, 'utf-8')
    const groups = JSON.parse(data) as CommandButtonGroup[]
    // 兼容旧格式：command → commands + delay
    for (const group of groups) {
      for (const button of group.buttons) {
        if ('command' in button && typeof (button as any).command === 'string') {
          button.commands = [(button as any).command]
          delete (button as any).command
        }
        if (!('delay' in button) || typeof button.delay !== 'number') {
          button.delay = 100
        }
      }
    }
    return groups
  } catch {
    return []
  }
}

/** 将命令按钮分组写入磁盘 */
export function saveCommandButtonGroupsToDisk(groups: CommandButtonGroup[]): void {
  const filePath = getStoragePath('command-button-groups.json')
  const dir = dirname(filePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(filePath, JSON.stringify(groups, null, 2), 'utf-8')
}

/** 从磁盘加载应用设置 */
export function loadAppSettingsFromDisk(): AppSettings | null {
  const filePath = getStoragePath('app-settings.json')
  if (!existsSync(filePath)) {
    return null
  }
  try {
    const data = readFileSync(filePath, 'utf-8')
    return JSON.parse(data) as AppSettings
  } catch {
    return null
  }
}

/** 将应用设置写入磁盘 */
export function saveAppSettingsToDisk(settings: AppSettings): void {
  const filePath = getStoragePath('app-settings.json')
  const dir = dirname(filePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf-8')
}

/** 从磁盘加载视图状态 */
export function loadViewStateFromDisk(): ViewState | null {
  const filePath = getStoragePath('view-state.json')
  if (!existsSync(filePath)) {
    return null
  }
  try {
    const data = readFileSync(filePath, 'utf-8')
    return JSON.parse(data) as ViewState
  } catch {
    return null
  }
}

/** 将视图状态写入磁盘 */
export function saveViewStateToDisk(state: ViewState): void {
  const filePath = getStoragePath('view-state.json')
  const dir = dirname(filePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8')
}

/** 从磁盘加载定时任务 */
export function loadScheduledTasksFromDisk(): Record<string, ScheduledTask[]> {
  const filePath = getStoragePath('scheduled-tasks.json')
  if (!existsSync(filePath)) {
    return {}
  }
  try {
    const data = readFileSync(filePath, 'utf-8')
    return JSON.parse(data) as Record<string, ScheduledTask[]>
  } catch {
    return {}
  }
}

/** 将定时任务写入磁盘 */
export function saveScheduledTasksToDisk(tasks: Record<string, ScheduledTask[]>): void {
  const filePath = getStoragePath('scheduled-tasks.json')
  const dir = dirname(filePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(filePath, JSON.stringify(tasks, null, 2), 'utf-8')
}

/** 从磁盘加载 Profile 列表 */
export function loadProfilesFromDisk(): Profile[] {
  const filePath = getStoragePath('profiles.json')
  if (!existsSync(filePath)) {
    return []
  }
  try {
    const data = readFileSync(filePath, 'utf-8')
    return JSON.parse(data) as Profile[]
  } catch {
    return []
  }
}

/** 将 Profile 列表写入磁盘 */
export function saveProfilesToDisk(profiles: Profile[]): void {
  const filePath = getStoragePath('profiles.json')
  const dir = dirname(filePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(filePath, JSON.stringify(profiles, null, 2), 'utf-8')
}
