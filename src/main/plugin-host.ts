import { ipcMain, app, dialog, net } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, lstatSync } from 'fs'
import { readFile } from 'fs/promises'
import { join, dirname } from 'path'
import AdmZip from 'adm-zip'
import type {
  PluginDefinition,
  PluginContext,
  PluginManifest,
  PluginRegistryEntry,
  PluginImportResult,
  PluginExportResult,
  PluginListItem
} from '@shared/types/plugin'

const ZIP_MAX_ENTRIES = 100
const ZIP_MAX_FILE_SIZE = 10 * 1024 * 1024
const ZIP_MAX_TOTAL_SIZE = 50 * 1024 * 1024
const LIFECYCLE_TIMEOUT = 5000
const ALLOWED_EXTENSIONS = new Set([
  'json', 'js', 'css', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'woff', 'woff2', 'ttf', 'eot'
])

class MainPluginHost {
  private plugins = new Map<string, {
    definition: PluginDefinition
    ctx: PluginContext
    active: boolean
    activating: boolean
    registeredChannels: string[]
    storageChannels: string[]
    unsubscribes: Array<() => void>
  }>()
  private registry: PluginRegistryEntry[] = []
  private pendingStorageChannels: string[] = []
  /**
   * createContext 在 plugins.set 之前执行，若此时有 ipc.handle 注册（目前仅 storage handler，
   * 未来可能扩展），channel 暂存此处，set 后转移给 entry，避免 cleanupPluginResources 无法移除。
   */
  private pendingRegisteredChannels: string[] = []

  private getPluginsDir(): string {
    const base = process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'wilson-terminal')
      : app.getPath('userData')
    return join(base, 'plugins')
  }

  private getRegistryPath(): string { return join(this.getPluginsDir(), 'registry.json') }

  private loadRegistry(): void {
    const path = this.getRegistryPath()
    if (!existsSync(path)) { this.registry = []; return }
    try { this.registry = JSON.parse(readFileSync(path, 'utf-8')) } catch { this.registry = [] }
  }

  private saveRegistry(): void {
    const path = this.getRegistryPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(this.registry, null, 2), 'utf-8')
  }

  /** 将单个插件从磁盘加载到内存（供 importZip 和运行时使用） */
  private loadPluginFromDisk(pluginId: string): boolean {
    const pluginDir = join(this.getPluginsDir(), pluginId)
    const manifestPath = join(pluginDir, 'manifest.json')
    if (!existsSync(manifestPath)) return false

    try {
      const manifest: PluginManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
      const definition: PluginDefinition = { manifest }

      const mainFile = manifest.main || 'main.js'
      const mainPath = join(pluginDir, mainFile)
      if (existsSync(mainPath)) {
        delete require.cache[require.resolve(mainPath)]
        const mainModule = require(mainPath)
        definition.main = mainModule.default || mainModule
      }

      const ctx = this.createContext(definition)
      this.plugins.set(manifest.id, {
        definition, ctx, active: false, activating: false,
        registeredChannels: this.pendingRegisteredChannels.splice(0),
        storageChannels: this.pendingStorageChannels.splice(0),
        unsubscribes: [],
      })
      return true
    } catch (err) {
      console.error(`[PluginHost] 加载插件 ${pluginId} 失败:`, err)
      return false
    }
  }

  async loadInstalledPlugins(): Promise<void> {
    this.loadRegistry()
    for (const entry of this.registry) {
      this.loadPluginFromDisk(entry.id)
    }
  }

  async activate(id: string): Promise<void> {
    // 插件可能尚未加载到内存（例如启动时为禁用状态），先从磁盘加载
    if (!this.plugins.has(id)) {
      this.loadPluginFromDisk(id)
    }
    const entry = this.plugins.get(id)
    if (!entry || entry.active || entry.activating) return
    entry.activating = true
    try {
      if (entry.definition.main?.registerHandlers) {
        entry.definition.main.registerHandlers(entry.ctx)
      }
      await this.withTimeout(entry.definition.main?.activate?.(entry.ctx), LIFECYCLE_TIMEOUT)
      entry.active = true
      const regEntry = this.registry.find(e => e.id === id)
      if (regEntry) { regEntry.enabled = true }
      this.saveRegistry()
    } catch (err) {
      console.error(`[PluginHost] 激活插件 ${id} 失败:`, err)
      this.cleanupPluginResources(id)
    } finally {
      entry.activating = false
    }
  }

  async deactivate(id: string): Promise<void> {
    const entry = this.plugins.get(id)
    if (!entry || !entry.active) return
    try {
      await this.withTimeout(entry.definition.main?.deactivate?.(), LIFECYCLE_TIMEOUT)
    } catch (err) {
      console.error(`[PluginHost] 插件 ${id} deactivate 超时或出错:`, err)
    }
    this.cleanupPluginResources(id)
    entry.active = false
    const regEntry = this.registry.find(e => e.id === id)
    if (regEntry) { regEntry.enabled = false }
    this.saveRegistry()
  }

  async uninstall(id: string): Promise<boolean> {
    const entry = this.plugins.get(id)
    if (!entry) return false
    if (entry.active) {
      await this.deactivate(id)
      try { await this.withTimeout(entry.definition.main?.dispose?.(), LIFECYCLE_TIMEOUT) } catch {}
    }
    this.cleanupAllPluginResources(id)
    const dir = join(this.getPluginsDir(), id)
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    this.registry = this.registry.filter(e => e.id !== id)
    this.saveRegistry()
    this.plugins.delete(id)
    return true
  }

  async importZip(zipPath: string): Promise<PluginImportResult> {
    try {
      const zip = new AdmZip(zipPath)

      const manifestEntry = zip.getEntry('manifest.json')
      if (!manifestEntry) return { success: false, error: '缺少 manifest.json' }

      let manifest: PluginManifest
      try { manifest = JSON.parse(manifestEntry.getData().toString('utf-8')) }
      catch { return { success: false, error: 'manifest.json 格式错误' } }

      if (!manifest.id || !manifest.name || !manifest.version)
        return { success: false, error: 'manifest.json 缺少必填字段 (id, name, version)' }
      if (!/^[a-z0-9-]+$/.test(manifest.id))
        return { success: false, error: '插件 ID 仅允许小写字母、数字和短横线' }
      if (manifest.main && /[/\\]/.test(manifest.main))
        return { success: false, error: 'manifest.main 不允许包含路径分隔符' }
      if (manifest.renderer && /[/\\]/.test(manifest.renderer))
        return { success: false, error: 'manifest.renderer 不允许包含路径分隔符' }

      const entries = zip.getEntries()
      if (entries.length > ZIP_MAX_ENTRIES)
        return { success: false, error: `ZIP 文件条目数超过 ${ZIP_MAX_ENTRIES} 限制` }

      let totalSize = 0
      for (const entry of entries) {
        const normalized = entry.entryName.replace(/\\/g, '/')
        if (normalized.startsWith('/') || normalized.includes('..'))
          return { success: false, error: `路径非法: ${entry.entryName}` }

        const ext = entry.entryName.split('.').pop()?.toLowerCase()
        if (ext && !ALLOWED_EXTENSIONS.has(ext))
          return { success: false, error: `不允许的文件类型: ${entry.entryName}` }

        totalSize += entry.header.size
        if (entry.header.size > ZIP_MAX_FILE_SIZE)
          return { success: false, error: `文件过大: ${entry.entryName}` }
        if (totalSize > ZIP_MAX_TOTAL_SIZE)
          return { success: false, error: '插件包解压后超过 50MB 限制' }
      }

      this.loadRegistry()
      const existing = this.registry.find(e => e.id === manifest.id)
      if (existing) {
        const dir = join(this.getPluginsDir(), manifest.id)
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
      }

      const pluginDir = join(this.getPluginsDir(), manifest.id)
      mkdirSync(pluginDir, { recursive: true })
      zip.extractAllTo(pluginDir, true)

      this.checkSymlinks(pluginDir)

      const now = Date.now()
      if (existing) { existing.updatedAt = now }
      else this.registry.push({ id: manifest.id, enabled: false, installedAt: now, updatedAt: now })
      this.saveRegistry()

      // 导入后立即加载到内存，这样用户可以直接启用
      this.loadPluginFromDisk(manifest.id)

      return { success: true, pluginId: manifest.id }
    } catch (err) {
      return { success: false, error: `导入失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  async exportZip(pluginId: string, savePath?: string): Promise<PluginExportResult> {
    try {
      const dir = join(this.getPluginsDir(), pluginId)
      if (!existsSync(dir)) return { success: false, error: `插件 ${pluginId} 未安装` }

      if (!savePath) {
        const result = await dialog.showSaveDialog({
          title: '导出插件',
          defaultPath: `${pluginId}.zip`,
          filters: [{ name: 'ZIP 文件', extensions: ['zip'] }]
        })
        if (result.canceled || !result.filePath) return { success: false, error: '用户取消' }
        savePath = result.filePath
      }

      const zip = new AdmZip()
      zip.addLocalFolder(dir)
      zip.writeZip(savePath)
      return { success: true, zipPath: savePath }
    } catch (err) {
      return { success: false, error: `导出失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  getPluginList(): PluginListItem[] {
    return this.registry.map(entry => {
      const plugin = this.plugins.get(entry.id)
      const manifest = plugin?.definition.manifest ?? { id: entry.id, name: entry.id, version: '0.0.0', description: '', permissions: [] }
      return { manifest, enabled: entry.enabled }
    })
  }

  async readRendererCode(pluginId: string): Promise<string | null> {
    const entry = this.registry.find(e => e.id === pluginId)
    if (!entry || !entry.enabled) return null

    const dir = join(this.getPluginsDir(), pluginId)
    const manifestPath = join(dir, 'manifest.json')
    if (!existsSync(manifestPath)) return null

    try {
      const manifest: PluginManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
      const file = manifest.renderer || 'renderer.js'
      const path = join(dir, file)
      return existsSync(path) ? await readFile(path, 'utf-8') : null
    } catch { return null }
  }

  private cleanupPluginResources(id: string): void {
    const entry = this.plugins.get(id)
    if (!entry) return
    for (const ch of entry.registeredChannels) { ipcMain.removeHandler(ch) }
    entry.registeredChannels = []
    for (const unsub of entry.unsubscribes) { try { unsub() } catch {} }
    entry.unsubscribes = []
  }

  /** 卸载时清理所有资源，包括 storage handler */
  private cleanupAllPluginResources(id: string): void {
    this.cleanupPluginResources(id)
    const entry = this.plugins.get(id)
    if (!entry) return
    for (const ch of entry.storageChannels) { ipcMain.removeHandler(ch) }
    entry.storageChannels = []
  }

  private checkSymlinks(dir: string): void {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      const fullPath = join(dir, name)
      try {
        if (lstatSync(fullPath).isSymbolicLink()) {
          throw new Error(`发现符号链接，拒绝加载: ${fullPath}`)
        }
        if (lstatSync(fullPath).isDirectory()) { this.checkSymlinks(fullPath) }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('发现符号链接')) throw err
      }
    }
  }

  private createContext(def: PluginDefinition): PluginContext {
    const perms = new Set(def.manifest.permissions)
    const pluginId = def.manifest.id

    const ctx: PluginContext = {
      storage: this.createNamespacedStorage(pluginId),
      ipc: perms.has('ipc:register')
        ? {
            handle: (channel: string, handler: (...args: any[]) => any) => {
              const namespacedChannel = `plugin:${pluginId}:${channel}`
              const entry = this.plugins.get(pluginId)
              if (entry) entry.registeredChannels.push(namespacedChannel)
              else this.pendingRegisteredChannels.push(namespacedChannel)
              ipcMain.handle(namespacedChannel, handler)
            }
          }
        : undefined,
      network: perms.has('network:fetch')
        ? {
            fetch: async (url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string }) => {
              const parsed = new URL(url)
              if (!['http:', 'https:'].includes(parsed.protocol)) {
                throw new Error(`不允许的协议: ${parsed.protocol}`)
              }
              const response = await net.fetch(url, opts as any)
              const text = await response.text()
              return { ok: response.ok, status: response.status, text }
            }
          }
        : undefined,
      host: {
        getDomain: () => getComputerDomain()
      },
      logger: this.createPluginLogger(pluginId),
    }

    // 为有 storage 权限的插件注册 IPC handler，供渲染进程侧使用
    if (perms.has('storage:read-write')) {
      const storage = ctx.storage
      const getChannel = `plugin:${pluginId}:storage:get`
      const setChannel = `plugin:${pluginId}:storage:set`
      ipcMain.handle(getChannel, async (_e, key: string) => storage.get(key))
      ipcMain.handle(setChannel, async (_e, key: string, value: unknown) => storage.set(key, value))
      // storage handler 不随 deactivate 清理，只随 uninstall 清理
      const entry = this.plugins.get(pluginId)
      if (entry) {
        entry.storageChannels.push(getChannel, setChannel)
      } else {
        this.pendingStorageChannels.push(getChannel, setChannel)
      }
    }

    return ctx
  }

  private createNamespacedStorage(pluginId: string): PluginContext['storage'] {
    const dir = join(this.getPluginsDir(), pluginId, 'storage')
    return {
      get: async <T>(key: string): Promise<T | null> => {
        if (/[/\\]/.test(key)) return null
        const filePath = join(dir, `${key}.json`)
        if (!existsSync(filePath)) return null
        try { return JSON.parse(readFileSync(filePath, 'utf-8')) as T } catch { return null }
      },
      set: async (key: string, value: unknown): Promise<void> => {
        if (/[/\\]/.test(key)) return
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, `${key}.json`), JSON.stringify(value), 'utf-8')
      }
    }
  }

  private createPluginLogger(pluginId: string): PluginContext['logger'] {
    return {
      info: (msg: string) => console.log(`[Plugin:${pluginId}] ${msg}`),
      error: (msg: string) => console.error(`[Plugin:${pluginId}] ${msg}`)
    }
  }

  private async withTimeout<T>(promise: Promise<T> | undefined, ms: number): Promise<T | undefined> {
    if (!promise) return undefined
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
    ])
  }
}

function getComputerDomain(): Promise<string> {
  // 复用 domain.ts 的逻辑，通过 IPC 间接调用
  try {
    const { getComputerDomain: _getDomain } = require('./domain')
    return _getDomain()
  } catch {
    return Promise.resolve('')
  }
}

export const mainPluginHost = new MainPluginHost()
