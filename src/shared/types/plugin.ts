// 修改时同步至 docs/plugin-demo/src/plugin-types.ts

/** 插件权限 */
export type PluginPermission =
  | 'ipc:register'
  | 'storage:read-write'
  | 'network:fetch'
  | 'terminal:input'
  | 'terminal:output'
  | 'terminal:write'

/** 插件元数据（与 manifest.json 对应） */
export interface PluginManifest {
  id: string
  name: string
  version: string
  description: string
  main?: string
  renderer?: string
  permissions: PluginPermission[]
}

/** 注册表条目 */
export interface PluginRegistryEntry {
  id: string
  enabled: boolean
  installedAt: number
  updatedAt: number
}

/** 声明式状态栏项（插件返回数据，宿主负责渲染） */
export interface PluginStatusBarItem {
  pluginId?: string
  label: string
  style?: {
    backgroundColor?: string
    color?: string
    border?: string
  }
  tooltip?: string
}

/** 声明式菜单项 */
export interface PluginMenuItem {
  label: string
  checked?: boolean
  disabled?: boolean
  onClick: () => void
}

/** 插件运行时上下文 */
export interface PluginContext {
  storage: {
    get: <T>(key: string) => Promise<T | null>
    set: (key: string, value: unknown) => Promise<void>
  }
  /** 注册 IPC handler（自动添加 plugin:{id}: 前缀） */
  ipc?: {
    handle: (channel: string, handler: (...args: any[]) => any) => void
  }
  /** 网络请求（仅 http/https 协议） */
  network?: {
    fetch: (
      url: string,
      options?: { method?: string; headers?: Record<string, string>; body?: string }
    ) => Promise<{ ok: boolean; status: number; text: string }>
  }
  /** 终端数据流 */
  terminal?: {
    onInput: (sessionId: string, callback: (data: string) => void) => () => void
    onOutput: (sessionId: string, callback: (data: string) => void) => () => void
    /** 通过 IPC 转发到主进程统一写入 */
    write: (sessionId: string, data: string) => void
  }
  /** 宿主环境信息 */
  host: {
    getDomain(): Promise<string>
  }
  logger: { info: (msg: string) => void; error: (msg: string) => void }
}

/** 生命周期 */
export interface PluginLifecycle {
  activate?(ctx: PluginContext): void | Promise<void>
  deactivate?(): void | Promise<void>
  dispose?(): void | Promise<void>
  onSessionCreated?(sessionId: string): void
  onSessionDestroyed?(sessionId: string): void
  onSessionReconnect?(sessionId: string): void
}

/** 主进程插件 */
export interface MainPlugin extends PluginLifecycle {
  registerHandlers?(ctx: PluginContext): void
}

/** 渲染进程插件 */
export interface RendererPlugin extends PluginLifecycle {
  statusBarItem?(sessionId: string): PluginStatusBarItem | null
  menuItems?(): PluginMenuItem[]
}

/** 插件定义 */
export interface PluginDefinition {
  manifest: PluginManifest
  main?: MainPlugin
  renderer?: RendererPlugin
}

/** 导入/导出结果 */
export interface PluginImportResult {
  success: boolean
  pluginId?: string
  error?: string
}

export interface PluginExportResult {
  success: boolean
  zipPath?: string
  error?: string
}

/** 列表项（渲染进程用） */
export interface PluginListItem {
  manifest: PluginManifest
  enabled: boolean
}

/** 插件 API（预加载脚本暴露） */
export interface PluginAPI {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  on: (channel: string, callback: (...args: unknown[]) => void) => () => void
  list: () => Promise<PluginListItem[]>
  getRendererCode: (id: string) => Promise<string | null>
  toggle: (id: string, enabled: boolean) => Promise<boolean>
  importZip: (zipPath?: string) => Promise<PluginImportResult>
  exportZip: (id: string) => Promise<PluginExportResult>
  uninstall: (id: string) => Promise<boolean>
  write: (sessionId: string, data: string) => Promise<void>
  getSessions: () => Promise<string[]>
}
