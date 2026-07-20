import { app } from 'electron'
import { readFileSync, existsSync } from 'fs'
import { promises as fsPromises } from 'fs'
import { join, dirname } from 'path'
import type { SavedSession, CommandButtonGroup, AppSettings, ScheduledTask, Profile, SavedSessionGroup } from '@shared/types'

/** 视图状态（需要持久化的 UI 开关） */
export interface ViewState {
  sidebarOpen: boolean
  commandInputVisible: boolean
  statusBarVisible: boolean
  buttonBarVisible: boolean
}

/** 已确认存在的目录缓存，避免每次写入都重复 existsSync */
const ensuredDirs = new Set<string>()

/**
 * 异步确保目录存在（带缓存）。
 * save 路径专用：避免每次写入都重复 existsSync + mkdirSync 阻塞主进程。
 */
async function ensureDirAsync(dir: string): Promise<void> {
  if (ensuredDirs.has(dir)) return
  if (existsSync(dir)) {
    ensuredDirs.add(dir)
    return
  }
  await fsPromises.mkdir(dir, { recursive: true })
  ensuredDirs.add(dir)
}

/** 将数据以 JSON 写入存储目录下的指定文件（统一 ensureDir + 异步写入） */
async function writeJsonFile(filename: string, data: unknown): Promise<void> {
  const filePath = getStoragePath(filename)
  await ensureDirAsync(dirname(filePath))
  await fsPromises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
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
    // 兼容旧数据：为没有 groupId 和 order 的记录添加默认值
    return sessions
      .filter(s => s && s.config)
      .map((s, index) => ({
        ...s,
        groupId: s.groupId,
        order: s.order ?? index
      }))
  } catch {
    return []
  }
}

/** 将保存的会话写入磁盘 */
export async function saveSavedSessionsToDisk(sessions: SavedSession[]): Promise<void> {
  await writeJsonFile('saved-sessions.json', sessions)
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
export async function saveIgnoredVersionsToDisk(versions: string[]): Promise<void> {
  await writeJsonFile('ignored-versions.json', versions)
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
export async function saveCommandButtonGroupsToDisk(groups: CommandButtonGroup[]): Promise<void> {
  await writeJsonFile('command-button-groups.json', groups)
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
export async function saveAppSettingsToDisk(settings: AppSettings): Promise<void> {
  await writeJsonFile('app-settings.json', settings)
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
export async function saveViewStateToDisk(state: ViewState): Promise<void> {
  await writeJsonFile('view-state.json', state)
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
export async function saveScheduledTasksToDisk(tasks: Record<string, ScheduledTask[]>): Promise<void> {
  await writeJsonFile('scheduled-tasks.json', tasks)
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
export async function saveProfilesToDisk(profiles: Profile[]): Promise<void> {
  await writeJsonFile('profiles.json', profiles)
}

/** 从磁盘加载上次自动检查更新的时间戳 */
export function loadLastAutoCheckTimestamp(): number | null {
  const filePath = getStoragePath('last-auto-check.json')
  if (!existsSync(filePath)) {
    return null
  }
  try {
    const data = readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(data) as { timestamp?: number }
    return typeof parsed.timestamp === 'number' ? parsed.timestamp : null
  } catch {
    return null
  }
}

/** 将上次自动检查更新的时间戳写入磁盘 */
export async function saveLastAutoCheckTimestamp(timestamp: number): Promise<void> {
  await writeJsonFile('last-auto-check.json', { timestamp })
}

/** 从磁盘加载保存的会话分组 */
export function loadSavedSessionGroupsFromDisk(): SavedSessionGroup[] {
  const filePath = getStoragePath('saved-session-groups.json')
  if (!existsSync(filePath)) {
    return []
  }
  try {
    const data = readFileSync(filePath, 'utf-8')
    return JSON.parse(data) as SavedSessionGroup[]
  } catch {
    return []
  }
}

/** 将保存的会话分组写入磁盘 */
export async function saveSavedSessionGroupsToDisk(groups: SavedSessionGroup[]): Promise<void> {
  await writeJsonFile('saved-session-groups.json', groups)
}
