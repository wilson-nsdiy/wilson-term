import type {
  PluginDefinition,
  PluginContext,
  RendererPlugin,
  PluginMenuItem,
  PluginListItem,
  PluginStatusBarItem,
  PluginManifest
} from '@shared/types/plugin'

class RendererPluginHost {
  private plugins = new Map<string, {
    definition: PluginDefinition
    renderer: RendererPlugin
    ctx: PluginContext
    active: boolean
    unsubscribes: Map<string, Array<() => void>>
  }>()
  private inputCallbacks = new Map<string, Set<(data: string) => void>>()
  private outputCallbacks = new Map<string, Set<(data: string) => void>>()

  async loadFromMain(): Promise<void> {
    for (const [, entry] of this.plugins) {
      if (entry.active) {
        for (const [, unsubs] of entry.unsubscribes) {
          for (const unsub of unsubs) { try { unsub() } catch {} }
        }
        entry.unsubscribes.clear()
        await entry.renderer.deactivate?.()
      }
    }
    this.plugins.clear()

    const list: PluginListItem[] = await window.api.plugin.list()
    for (const item of list) {
      if (!item.enabled) continue

      const code = await window.api.plugin.getRendererCode(item.manifest.id)
      if (!code) continue

      try {
        const fn = new Function('exports', 'module', code)
        const moduleObj: { exports: any } = { exports: {} }
        fn(moduleObj.exports, moduleObj)
        const moduleExports = moduleObj.exports
        let renderer = moduleExports.default || moduleExports

        if (typeof renderer === 'function') {
          renderer = new renderer()
        }

        if (!renderer) continue

        const entry: { definition: PluginDefinition; renderer: RendererPlugin; ctx: PluginContext; active: boolean; unsubscribes: Map<string, Array<() => void>> } = {
          definition: { manifest: item.manifest, renderer },
          renderer, ctx: null!, active: false,
          unsubscribes: new Map(),
        }
        this.plugins.set(item.manifest.id, entry)
        entry.ctx = this.createContext(item.manifest)
      } catch (err) {
        console.error(`[PluginHost] 加载插件 ${item.manifest.id} 失败:`, err)
      }
    }
  }

  async activate(id: string): Promise<void> {
    const entry = this.plugins.get(id)
    if (!entry || entry.active) return
    await entry.renderer.activate?.(entry.ctx)
    entry.active = true
  }

  async deactivate(id: string): Promise<void> {
    const entry = this.plugins.get(id)
    if (!entry || !entry.active) return
    for (const [, unsubs] of entry.unsubscribes) {
      for (const unsub of unsubs) { try { unsub() } catch {} }
    }
    entry.unsubscribes.clear()
    await entry.renderer.deactivate?.()
    entry.active = false
  }

  feedInput(sessionId: string, data: string): void {
    this.inputCallbacks.get(sessionId)?.forEach(cb => {
      try { cb(data) } catch (err) { console.error('[PluginHost] feedInput error:', err) }
    })
  }

  feedOutput(sessionId: string, data: string): void {
    this.outputCallbacks.get(sessionId)?.forEach(cb => {
      try { cb(data) } catch (err) { console.error('[PluginHost] feedOutput error:', err) }
    })
  }

  notifySessionCreated(sessionId: string): void {
    for (const [, entry] of this.plugins) {
      if (entry.active) entry.renderer.onSessionCreated?.(sessionId)
    }
  }

  notifySessionDestroyed(sessionId: string): void {
    for (const [, entry] of this.plugins) {
      if (entry.active) entry.renderer.onSessionDestroyed?.(sessionId)
    }
    this.inputCallbacks.delete(sessionId)
    this.outputCallbacks.delete(sessionId)
  }

  notifySessionReconnect(sessionId: string): void {
    for (const [, entry] of this.plugins) {
      if (entry.active) entry.renderer.onSessionReconnect?.(sessionId)
    }
  }

  collectStatusBarItems(sessionId: string): PluginStatusBarItem[] {
    const items: PluginStatusBarItem[] = []
    for (const [, entry] of this.plugins) {
      if (!entry.active || !entry.renderer.statusBarItem) continue
      const item = entry.renderer.statusBarItem(sessionId)
      if (item) items.push({ ...item, pluginId: entry.definition.manifest.id })
    }
    return items
  }

  collectMenuItems(): PluginMenuItem[] {
    const items: PluginMenuItem[] = []
    for (const [, entry] of this.plugins) {
      if (!entry.active || !entry.renderer.menuItems) continue
      items.push(...entry.renderer.menuItems())
    }
    return items
  }

  getAll() {
    return this.plugins.entries()
  }

  private createContext(manifest: PluginManifest): PluginContext {
    const perms = new Set(manifest.permissions)
    const pluginId = manifest.id
    const host = this

    return {
      storage: createNamespacedStorageIPC(pluginId),
      terminal: perms.has('terminal:input') || perms.has('terminal:output') || perms.has('terminal:write')
        ? {
            onInput: (sid: string, cb: (data: string) => void) => {
              if (!host.inputCallbacks.has(sid)) host.inputCallbacks.set(sid, new Set())
              host.inputCallbacks.get(sid)!.add(cb)
              const unsub = () => host.inputCallbacks.get(sid)?.delete(cb)
              const entry = host.plugins.get(pluginId)
              if (entry) {
                if (!entry.unsubscribes.has(sid)) entry.unsubscribes.set(sid, [])
                entry.unsubscribes.get(sid)!.push(unsub)
              }
              return unsub
            },
            onOutput: (sid: string, cb: (data: string) => void) => {
              if (!host.outputCallbacks.has(sid)) host.outputCallbacks.set(sid, new Set())
              host.outputCallbacks.get(sid)!.add(cb)
              const unsub = () => host.outputCallbacks.get(sid)?.delete(cb)
              const entry = host.plugins.get(pluginId)
              if (entry) {
                if (!entry.unsubscribes.has(sid)) entry.unsubscribes.set(sid, [])
                entry.unsubscribes.get(sid)!.push(unsub)
              }
              return unsub
            },
            write: (sid: string, data: string) => window.api.plugin.write(sid, data),
          }
        : undefined,
      host: {
        getDomain: () => window.api.app.getDomain()
      },
      logger: createPluginLogger(pluginId),
    }
  }
}

function createNamespacedStorageIPC(pluginId: string): PluginContext['storage'] {
  return {
    get: async <T>(key: string): Promise<T | null> => {
      try {
        const result = await window.api.plugin.invoke(`plugin:${pluginId}:storage:get`, key)
        return result as T ?? null
      } catch { return null }
    },
    set: async (key: string, value: unknown): Promise<void> => {
      try {
        await window.api.plugin.invoke(`plugin:${pluginId}:storage:set`, key, value)
      } catch {}
    }
  }
}

function createPluginLogger(pluginId: string): PluginContext['logger'] {
  return {
    info: (msg: string) => console.log(`[Plugin:${pluginId}] ${msg}`),
    error: (msg: string) => console.error(`[Plugin:${pluginId}] ${msg}`)
  }
}

export const rendererPluginHost = new RendererPluginHost()
