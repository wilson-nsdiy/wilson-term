import { create } from 'zustand'
import type { TerminalSession, AppSettings, ConnectionConfig, SavedSession, SavedSessionGroup, CommandButtonGroup, ViewState, KeyboardLockState, ScheduledTask, Profile, ProfileOverrides } from '@shared/types'
import { createLogConfigFromSettings, resolveLogConfig } from '../utils/logConfig'
import { rendererPluginHost } from '@renderer/plugin-host.ts'

/** persistSessionGroups 的 debounce timer，合并拖拽期间的多次保存 */
let persistSessionGroupsTimer: ReturnType<typeof setTimeout> | null = null
/** 应用状态 */
interface AppState {
  /** 当前活跃的会话标签页 ID */
  activeSessionId: string | null
  /** 所有活跃会话 */
  sessions: TerminalSession[]
  /** 保存的会话模板列表 */
  savedSessions: SavedSession[]
  /** 应用设置 */
  settings: AppSettings
  /** 侧边栏是否展开 */
  sidebarOpen: boolean
  /** 新建连接对话框是否打开 */
  newConnectDialogOpen: boolean
  /** 设置对话框是否打开 */
  settingsDialogOpen: boolean
  /** 是否有新版本（用于菜单栏角标） */
  hasNewVersion: boolean
  /** 手动检查更新对话框是否打开（打开时抑制 Toast） */
  updateDialogOpen: boolean
  /** 每个会话的键盘锁状态 */
  keyboardLockStates: Record<string, KeyboardLockState>
  /** 命令行输入框是否可见 */
  commandInputVisible: boolean
  /** 命令行输入框文本 */
  commandInputText: string
  /** 状态栏是否可见 */
  statusBarVisible: boolean

  /** SFTP 文件管理器对话框是否打开 */
  sftpDialogOpen: boolean
  /** 全局选项对话框是否打开 */
  globalOptionsDialogOpen: boolean

  // 分组管理
  /** 保存的会话分组列表 */
  savedSessionGroups: SavedSessionGroup[]
  /** 折叠的分组 ID 集合 */
  collapsedSessionGroupIds: Set<string>

  // 按钮栏
  /** 按钮栏是否可见 */
  buttonBarVisible: boolean
  /** 命令按钮分组列表 */
  commandButtonGroups: CommandButtonGroup[]
  /** 当前激活的按钮分组 ID */
  activeButtonGroupId: string | null
  /** 按钮管理对话框是否打开 */
  buttonBarManagerOpen: boolean
  /** 搜索栏是否可见 */
  searchVisible: boolean

  /** 每个会话的定时任务 { sessionId -> tasks } */
  scheduledTasks: Record<string, ScheduledTask[]>
  /** 定时任务对话框是否打开 */
  scheduledTaskDialogOpen: boolean

  // Profile 管理
  /** Profile 列表 */
  profiles: Profile[]

  // Actions - 活跃会话
  setActiveSession: (id: string | null) => void
  setNewConnectDialogOpen: (open: boolean) => void
  setSettingsDialogOpen: (open: boolean) => void
  addSession: (config: ConnectionConfig, id?: string) => string
  removeSession: (id: string) => void
  updateSessionStatus: (id: string, status: TerminalSession['status']) => void
  /** 在终端中写入错误信息并设置状态为 error */
  writeSessionError: (id: string, message: string) => void
  /** 拖拽移动标签页顺序 */
  moveSessionTab: (fromIndex: number, toIndex: number) => void
  /** 更新会话关联的 Profile ID */
  updateSessionProfile: (id: string, profileId: string) => void

  // Actions - 保存的会话模板
  addSavedSession: (config: ConnectionConfig, name?: string, groupId?: string) => string
  updateSavedSession: (id: string, updates: Partial<Pick<SavedSession, 'name' | 'config' | 'scheduledTasks' | 'profileId' | 'groupId' | 'order'>>) => void
  removeSavedSession: (id: string) => void
  /** 拖拽移动保存的会话顺序 */
  moveSavedSession: (fromIndex: number, toIndex: number) => void
  connectSavedSession: (id: string) => string | null
  loadSavedSessions: () => Promise<void>
  persistSavedSessions: () => Promise<void>

  // Actions - 分组管理
  addSessionGroup: (name: string, parentId?: string) => string
  updateSessionGroup: (id: string, updates: Partial<Pick<SavedSessionGroup, 'name' | 'parentId' | 'sessionIds' | 'order'>>) => void
  removeSessionGroup: (id: string) => void
  moveSessionGroup: (groupId: string, targetParentId: string | undefined, targetIndex: number) => void
  toggleSessionGroupCollapsed: (id: string) => void
  loadSessionGroups: () => Promise<void>
  persistSessionGroups: () => Promise<void>

  // Actions - 设置
  updateSettings: (settings: Partial<AppSettings>) => void
  toggleSidebar: () => void
  /** 初始化默认日志目录 */
  initDefaultLogDir: () => Promise<void>

  // Actions - 新版本角标
  setHasNewVersion: (has: boolean) => void
  setUpdateDialogOpen: (open: boolean) => void

  // Actions - 键盘锁状态
  updateKeyboardLockState: (sessionId: string, state: KeyboardLockState) => void

  // Actions - 命令行输入
  setCommandInputVisible: (visible: boolean) => void
  setCommandInputText: (text: string) => void

  // Actions - 状态栏
  setStatusBarVisible: (visible: boolean) => void

  // Actions - SFTP 文件管理
  setSftpDialogOpen: (open: boolean) => void

  // Actions - 全局选项
  setGlobalOptionsDialogOpen: (open: boolean) => void

  // Actions - 按钮栏
  setButtonBarVisible: (visible: boolean) => void
  setCommandButtonGroups: (groups: CommandButtonGroup[]) => void
  setActiveButtonGroupId: (id: string | null) => void
  setButtonBarManagerOpen: (open: boolean) => void
  /** 设置搜索栏可见性 */
  setSearchVisible: (visible: boolean) => void
  loadCommandButtonGroups: () => Promise<void>
  persistCommandButtonGroups: () => Promise<void>

  // Actions - 视图状态持久化
  loadViewState: () => Promise<void>
  persistViewState: () => Promise<void>

  // Actions - 应用设置持久化
  loadAppSettings: () => Promise<void>
  persistAppSettings: () => Promise<void>

  // Actions - 日志
  toggleSessionLog: (sessionId: string) => void
  getSessionLogEnabled: (sessionId: string) => boolean

  // Actions - 定时任务
  setScheduledTaskDialogOpen: (open: boolean) => void
  addScheduledTask: (sessionId: string, task: ScheduledTask) => void
  removeScheduledTask: (sessionId: string, taskId: string) => void
  updateScheduledTask: (sessionId: string, taskId: string, updates: Partial<ScheduledTask>) => void
  moveScheduledTaskUp: (sessionId: string, taskId: string) => void
  moveScheduledTaskDown: (sessionId: string, taskId: string) => void
  pauseSessionTasks: (sessionId: string) => void
  removeSessionTasks: (sessionId: string) => void
  loadScheduledTasks: () => Promise<void>
  persistScheduledTasks: () => Promise<void>

  // Profile Actions
  loadProfiles: () => Promise<void>
  persistProfiles: () => Promise<void>
  addProfile: (name: string, appliesTo: ConnectionType[], overrides: Partial<ProfileOverrides>) => string
  updateProfile: (id: string, updates: Partial<Pick<Profile, 'name' | 'appliesTo' | 'overrides'>>) => void
  removeProfile: (id: string) => void
}

/** 生成唯一 ID */
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2)
}

/** 默认设置 */
const defaultSettings: AppSettings = {
  theme: 'catppuccin-mocha',
  fontSize: 14,
  fontFamily: 'Cascadia Code',
  fontWeight: 'normal',
  fontWeightBold: 'bold',
  lineHeight: 1.0,
  letterSpacing: 0,
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  backgroundImage: '',
  backgroundOpacity: 1,
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 1000,
  logEnabled: true,
  logPath: '',
  logWithTimestamp: true,
  logSplitBySize: false,
  logSplitByTime: true,
  logMaxSize: 10 * 1024 * 1024, // 10MB
  language: 'zh-CN',
  rightClickPaste: true,
  trimPaste: true,
  multiLinePasteWarning: 'auto'
}

export const useAppStore = create<AppState>((set, get) => ({
  activeSessionId: null,
  sessions: [],
  savedSessions: [],
  settings: defaultSettings,
  sidebarOpen: true,
  newConnectDialogOpen: false,
  settingsDialogOpen: false,
  hasNewVersion: false,
  updateDialogOpen: false,
  keyboardLockStates: {},
  commandInputVisible: false,
  commandInputText: '',
  statusBarVisible: true,
  sftpDialogOpen: false,
  globalOptionsDialogOpen: false,
  savedSessionGroups: [],
  collapsedSessionGroupIds: new Set(),
  buttonBarVisible: false,
  commandButtonGroups: [],
  activeButtonGroupId: null,
  buttonBarManagerOpen: false,
  searchVisible: false,
  scheduledTasks: {},
  scheduledTaskDialogOpen: false,
  profiles: [],

  // ---- 活跃会话 Actions ----

  setActiveSession: (id) => set({ activeSessionId: id }),

  setNewConnectDialogOpen: (open) => set({ newConnectDialogOpen: open }),

  setSettingsDialogOpen: (open) => set({ settingsDialogOpen: open }),

  addSession: (config, id?: string) => {
    const sessionId = id || generateId()
    const session: TerminalSession = {
      id: sessionId,
      config: { ...config, id: sessionId, logConfig: config.logConfig ? { ...config.logConfig } : undefined },
      status: 'connecting',
      createdAt: Date.now(),
      lastActiveAt: Date.now()
    }
    set((state) => ({
      sessions: [...state.sessions, session],
      activeSessionId: sessionId
    }))

    return sessionId
  },

  removeSession: (id) => {
    const session = get().sessions.find((s) => s.id === id)
    if (session) {
      window.api.connection.disconnect(id)
    }
    rendererPluginHost.notifySessionDestroyed(id)
    set((state) => {
      const { [id]: _removed, ...restTasks } = state.scheduledTasks
      return {
        sessions: state.sessions.filter((s) => s.id !== id),
        activeSessionId:
          state.activeSessionId === id
            ? state.sessions.find((s) => s.id !== id)?.id ?? null
            : state.activeSessionId,
        scheduledTasks: restTasks
      }
    })
  },

  updateSessionStatus: (id, status) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, status, lastActiveAt: Date.now() } : s
      )
    })),

  writeSessionError: (id, message) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, status: 'error', lastActiveAt: Date.now(), errorMessage: message } : s
      )
    })),

  moveSessionTab: (fromIndex, toIndex) =>
    set((state) => {
      if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= state.sessions.length || toIndex >= state.sessions.length) return state
      const sessions = [...state.sessions]
      const [moved] = sessions.splice(fromIndex, 1)
      sessions.splice(toIndex, 0, moved)
      return { sessions }
    }),

  updateSessionProfile: (id, profileId) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, profileId } : s
      )
    })),

  // ---- 保存的会话模板 Actions ----

  addSavedSession: (config, name?: string, groupId?: string) => {
    const id = generateId()
    const now = Date.now()
    const { savedSessions, savedSessionGroups } = get()

    // 计算 order
    let order: number
    if (groupId) {
      const group = savedSessionGroups.find(g => g.id === groupId)
      order = group ? group.sessionIds.length : 0
    } else {
      // 未分组连接的 order
      const ungroupedSessions = savedSessions.filter(s => !s.groupId)
      order = ungroupedSessions.length
    }

    const savedSession: SavedSession = {
      id,
      name: name || config.name,
      config: { ...config },
      groupId,
      order,
      scheduledTasks: [],
      createdAt: now,
      updatedAt: now
    }
    set((state) => ({
      savedSessions: [...state.savedSessions, savedSession]
    }))

    // 如果有 groupId，更新分组的 sessionIds
    if (groupId) {
      set((state) => ({
        savedSessionGroups: state.savedSessionGroups.map(g =>
          g.id === groupId ? { ...g, sessionIds: [...g.sessionIds, id], updatedAt: Date.now() } : g
        )
      }))
      get().persistSessionGroups()
    }

    get().persistSavedSessions()
    return id
  },

  updateSavedSession: (id, updates) => {
    set((state) => ({
      savedSessions: state.savedSessions.map((s) =>
        s.id === id ? { ...s, ...updates, updatedAt: Date.now() } : s
      )
    }))
    get().persistSavedSessions()
  },

  removeSavedSession: (id) => {
    set((state) => ({
      savedSessions: state.savedSessions.filter((s) => s.id !== id),
      savedSessionGroups: state.savedSessionGroups.map((group) =>
        group.sessionIds.includes(id)
          ? { ...group, sessionIds: group.sessionIds.filter((sessionId) => sessionId !== id), updatedAt: Date.now() }
          : group
      )
    }))
    get().persistSavedSessions()
    get().persistSessionGroups()
  },

  moveSavedSession: (fromIndex, toIndex) => {
    set((state) => {
      if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= state.savedSessions.length || toIndex >= state.savedSessions.length) return state
      const savedSessions = [...state.savedSessions]
      const [moved] = savedSessions.splice(fromIndex, 1)
      savedSessions.splice(toIndex, 0, moved)
      return { savedSessions }
    })
    get().persistSavedSessions()
  },

  connectSavedSession: (id) => {
    const { savedSessions } = get()
    const saved = savedSessions.find((s) => s.id === id)
    if (!saved) return null

    // 从模板创建新的活跃会话（不重复创建模板）
    const sessionId = generateId()
    const session: TerminalSession = {
      id: sessionId,
      config: { ...saved.config, id: sessionId, logConfig: saved.config.logConfig ? { ...saved.config.logConfig } : undefined },
      status: 'connecting',
      createdAt: Date.now(),
      lastActiveAt: Date.now()
    }
    set((state) => ({
      sessions: [...state.sessions, session],
      activeSessionId: sessionId
    }))
    return sessionId
  },

  loadSavedSessions: async () => {
    try {
      const sessions = await window.api.storage.loadSavedSessions()
      set({ savedSessions: sessions })
    } catch (err) {
      console.error('加载保存的会话失败:', err)
    }
  },

  persistSavedSessions: async () => {
    try {
      const { savedSessions } = get()
      await window.api.storage.saveSavedSessions(savedSessions)
    } catch (err) {
      console.error('保存会话到磁盘失败:', err)
    }
  },

  // ---- 分组管理 Actions ----

  addSessionGroup: (name, parentId) => {
    const id = generateId()
    const now = Date.now()
    const { savedSessionGroups } = get()

    // 防护：parentId 不能是自身 ID
    const validParentId = parentId && parentId !== id ? parentId : undefined

    // 计算同级最大 order
    const siblings = savedSessionGroups.filter(g => g.parentId === validParentId)
    const maxOrder = siblings.reduce((max, g) => Math.max(max, g.order), -1)

    const group: SavedSessionGroup = {
      id,
      name,
      parentId: validParentId,
      sessionIds: [],
      order: maxOrder + 1,
      createdAt: now,
      updatedAt: now
    }

    set((state) => ({
      savedSessionGroups: [...state.savedSessionGroups, group]
    }))
    get().persistSessionGroups()
    return id
  },

  updateSessionGroup: (id, updates) => {
    // 防护：parentId 不能指向自身
    if (updates.parentId === id) {
      const { parentId: _, ...safeUpdates } = updates
      updates = safeUpdates as typeof updates
    }
    set((state) => ({
      savedSessionGroups: state.savedSessionGroups.map(g =>
        g.id === id ? { ...g, ...updates, updatedAt: Date.now() } : g
      )
    }))
    get().persistSessionGroups()
  },

  removeSessionGroup: (id) => {
    const { savedSessionGroups, savedSessions } = get()

    // 递归获取所有子分组 ID
    const getAllDescendantIds = (parentId: string): string[] => {
      const children = savedSessionGroups.filter(g => g.parentId === parentId)
      return [
        ...children.map(c => c.id),
        ...children.flatMap(c => getAllDescendantIds(c.id))
      ]
    }

    const idsToRemove = [id, ...getAllDescendantIds(id)]

    set((state) => ({
      savedSessionGroups: state.savedSessionGroups.filter(g => !idsToRemove.includes(g.id)),
      savedSessions: state.savedSessions.map(s => {
        if (s.groupId && idsToRemove.includes(s.groupId)) {
          return { ...s, groupId: undefined }
        }
        return s
      })
    }))
    get().persistSessionGroups()
    get().persistSavedSessions()
  },

  moveSessionGroup: (groupId, targetParentId, targetIndex) => {
    set((state) => {
      const movingGroup = state.savedSessionGroups.find(g => g.id === groupId)
      if (!movingGroup) {
        return state
      }

      // 防护：不能将分组设为自身的子节点
      const safeTargetParentId = targetParentId === groupId ? undefined : targetParentId

      const normalizeParentId = (parentId: string | undefined) => parentId ?? null

      const now = Date.now()
      const sourceParentId = movingGroup.parentId
      const normalizedSourceParentId = normalizeParentId(sourceParentId)
      const normalizedTargetParentId = normalizeParentId(safeTargetParentId)
      const sameParent = normalizedSourceParentId === normalizedTargetParentId

      const sourceSiblings = state.savedSessionGroups
        .filter(g => normalizeParentId(g.parentId) === normalizedSourceParentId)
        .sort((a, b) => a.order - b.order)
      const fromIndex = sourceSiblings.findIndex(g => g.id === groupId)
      if (fromIndex === -1) {
        return state
      }

      const sourceWithoutMoving = sourceSiblings.filter(g => g.id !== groupId)
      const targetSiblings = sameParent
        ? [...sourceWithoutMoving]
        : state.savedSessionGroups
            .filter(g => normalizeParentId(g.parentId) === normalizedTargetParentId && g.id !== groupId)
            .sort((a, b) => a.order - b.order)

      const adjustedTargetIndex = sameParent && fromIndex < targetIndex ? targetIndex - 1 : targetIndex
      const insertIndex = Math.max(0, Math.min(adjustedTargetIndex, targetSiblings.length))

      const movedGroup: SavedSessionGroup = {
        ...movingGroup,
        ...(safeTargetParentId === undefined ? {} : { parentId: safeTargetParentId }),
        ...(safeTargetParentId === undefined && movingGroup.parentId !== undefined ? { parentId: undefined } : {}),
        updatedAt: now
      }

      targetSiblings.splice(insertIndex, 0, movedGroup)

      const updatedSourceSiblings = sameParent
        ? []
        : sourceWithoutMoving.map((group, index) => ({ ...group, order: index, updatedAt: now }))
      const updatedTargetSiblings = targetSiblings.map((group, index) => ({ ...group, order: index, updatedAt: now }))

      const unaffectedGroups = state.savedSessionGroups.filter(g => {
        if (g.id === groupId) return false
        const normalizedParentId = normalizeParentId(g.parentId)
        if (normalizedParentId === normalizedSourceParentId) return false
        if (normalizedParentId === normalizedTargetParentId) return false
        return true
      })

      return {
        savedSessionGroups: [...unaffectedGroups, ...updatedSourceSiblings, ...updatedTargetSiblings]
      }
    })
    get().persistSessionGroups()
  },

  toggleSessionGroupCollapsed: (id) => {
    set((state) => {
      const newCollapsed = new Set(state.collapsedSessionGroupIds)
      if (newCollapsed.has(id)) {
        newCollapsed.delete(id)
      } else {
        newCollapsed.add(id)
      }
      return { collapsedSessionGroupIds: newCollapsed }
    })
  },

  loadSessionGroups: async () => {
    try {
      const groups = await window.api.storage.loadSavedSessionGroups()
      // 第一步：移除自引用 parentId 和指向不存在分组的 parentId
      const groupIds = new Set(groups.map(g => g.id))
      let sanitized = groups.map(g => {
        if (g.parentId) {
          if (g.parentId === g.id || !groupIds.has(g.parentId)) {
            const { parentId: _, ...rest } = g
            return rest
          }
        }
        return g
      })

      // 第二步：检测并打破循环引用
      // 从所有根节点（parentId 为 undefined）出发 DFS，标记可达节点
      const visited = new Set<string>()
      const stack: string[] = sanitized
        .filter(g => !g.parentId)
        .map(g => g.id)

      while (stack.length > 0) {
        const currentId = stack.pop()!
        if (visited.has(currentId)) continue
        visited.add(currentId)
        const children = sanitized.filter(g => g.parentId === currentId)
        for (const child of children) {
          if (!visited.has(child.id)) {
            stack.push(child.id)
          }
        }
      }

      // 任何未被访问到的分组都处于循环中，移除其 parentId 使其成为顶级分组
      sanitized = sanitized.map(g => {
        if (g.parentId && !visited.has(g.id)) {
          const { parentId: _, ...rest } = g
          return rest
        }
        return g
      })

      set({ savedSessionGroups: sanitized })
    } catch (err) {
      console.error('加载保存的会话分组失败:', err)
    }
  },

  persistSessionGroups: async () => {
    // debounce：拖拽分组时频繁触发，合并 300ms 内的多次调用，只保留最后一次的数据快照
    if (persistSessionGroupsTimer) clearTimeout(persistSessionGroupsTimer)
    const snapshot = get().savedSessionGroups
    persistSessionGroupsTimer = setTimeout(async () => {
      persistSessionGroupsTimer = null
      try {
        await window.api.storage.saveSavedSessionGroups(snapshot)
      } catch (err) {
        console.error('保存会话分组到磁盘失败:', err)
      }
    }, 300)
  },

  // ---- 设置 Actions ----

  updateSettings: (newSettings) => {
    set((state) => ({
      settings: { ...state.settings, ...newSettings }
    }))
    get().persistAppSettings()
  },

  toggleSidebar: () => {
    set((state) => ({ sidebarOpen: !state.sidebarOpen }))
    get().persistViewState()
  },

  // ---- 初始化 ----

  initDefaultLogDir: async () => {
    try {
      const defaultLogDir = await window.api.log.getDefaultLogDir()
      if (defaultLogDir) {
        set((state) => ({
          settings: { ...state.settings, logPath: defaultLogDir }
        }))
      }
    } catch (err) {
      console.error('获取默认日志目录失败:', err)
    }
  },

  // ---- 新版本角标 Actions ----

  setHasNewVersion: (has) => set({ hasNewVersion: has }),

  setUpdateDialogOpen: (open) => set({ updateDialogOpen: open }),

  // ---- 键盘锁状态 Actions ----

  updateKeyboardLockState: (sessionId, state) =>
    set((prev) => ({
      keyboardLockStates: {
        ...prev.keyboardLockStates,
        [sessionId]: state
      }
    })),

  // ---- 命令行输入 Actions ----

  setCommandInputVisible: (visible) => {
    set({ commandInputVisible: visible, commandInputText: '' })
    get().persistViewState()
  },
  setCommandInputText: (text) => set({ commandInputText: text }),

  // ---- 状态栏 Actions ----

  setStatusBarVisible: (visible) => {
    set({ statusBarVisible: visible })
    get().persistViewState()
  },

  // ---- SFTP 文件管理 Actions ----

  setSftpDialogOpen: (open) => set({ sftpDialogOpen: open }),

  setGlobalOptionsDialogOpen: (open) => set({ globalOptionsDialogOpen: open }),

  // ---- 按钮栏 Actions ----

  setButtonBarVisible: (visible) => {
    set({ buttonBarVisible: visible })
    get().persistViewState()
  },
  setCommandButtonGroups: (groups) => set({ commandButtonGroups: groups }),
  setActiveButtonGroupId: (id) => set({ activeButtonGroupId: id }),
  setButtonBarManagerOpen: (open) => set({ buttonBarManagerOpen: open }),

  setSearchVisible: (visible) => set({ searchVisible: visible }),

  // ---- 定时任务 Actions ----

  setScheduledTaskDialogOpen: (open) => set({ scheduledTaskDialogOpen: open }),

  addScheduledTask: (sessionId, task) => {
    set((state) => ({
      scheduledTasks: {
        ...state.scheduledTasks,
        [sessionId]: [...(state.scheduledTasks[sessionId] || []), task]
      }
    }))
    get().persistScheduledTasks()
  },

  removeScheduledTask: (sessionId, taskId) => {
    set((state) => ({
      scheduledTasks: {
        ...state.scheduledTasks,
        [sessionId]: (state.scheduledTasks[sessionId] || []).filter((t) => t.id !== taskId)
      }
    }))
    get().persistScheduledTasks()
  },

  updateScheduledTask: (sessionId, taskId, updates) => {
    set((state) => ({
      scheduledTasks: {
        ...state.scheduledTasks,
        [sessionId]: (state.scheduledTasks[sessionId] || []).map((t) =>
          t.id === taskId ? { ...t, ...updates } : t
        )
      }
    }))
    get().persistScheduledTasks()
  },

  moveScheduledTaskUp: (sessionId, taskId) => {
    set((state) => {
      const tasks = state.scheduledTasks[sessionId] || []
      const idx = tasks.findIndex((t) => t.id === taskId)
      if (idx <= 0) return state
      const updated = [...tasks]
      ;[updated[idx - 1], updated[idx]] = [updated[idx], updated[idx - 1]]
      return { scheduledTasks: { ...state.scheduledTasks, [sessionId]: updated } }
    })
    get().persistScheduledTasks()
  },

  moveScheduledTaskDown: (sessionId, taskId) => {
    set((state) => {
      const tasks = state.scheduledTasks[sessionId] || []
      const idx = tasks.findIndex((t) => t.id === taskId)
      if (idx < 0 || idx >= tasks.length - 1) return state
      const updated = [...tasks]
      ;[updated[idx], updated[idx + 1]] = [updated[idx + 1], updated[idx]]
      return { scheduledTasks: { ...state.scheduledTasks, [sessionId]: updated } }
    })
    get().persistScheduledTasks()
  },

  /** 暂停某个会话的所有定时任务 */
  pauseSessionTasks: (sessionId) => {
    set((state) => ({
      scheduledTasks: {
        ...state.scheduledTasks,
        [sessionId]: (state.scheduledTasks[sessionId] || []).map((t) =>
          t.enabled ? { ...t, enabled: false } : t
        )
      }
    }))
    get().persistScheduledTasks()
  },

  /** 删除某个会话的所有定时任务 */
  removeSessionTasks: (sessionId) => {
    set((state) => {
      const { [sessionId]: _removed, ...rest } = state.scheduledTasks
      return { scheduledTasks: rest }
    })
    get().persistScheduledTasks()
  },

  loadScheduledTasks: async () => {
    try {
      const tasks = await window.api.storage.loadScheduledTasks()
      set({ scheduledTasks: tasks })
    } catch (err) {
      console.error('加载定时任务失败:', err)
    }
  },

  persistScheduledTasks: async () => {
    try {
      const { scheduledTasks } = get()
      await window.api.storage.saveScheduledTasks(scheduledTasks)
    } catch (err) {
      console.error('保存定时任务失败:', err)
    }
  },

  loadCommandButtonGroups: async () => {
    try {
      const groups = await window.api.storage.loadCommandButtonGroups()
      set({ commandButtonGroups: groups, activeButtonGroupId: groups.length > 0 ? groups[0].id : null })
    } catch (err) {
      console.error('加载命令按钮分组失败:', err)
    }
  },

  persistCommandButtonGroups: async () => {
    try {
      const { commandButtonGroups } = get()
      await window.api.storage.saveCommandButtonGroups(commandButtonGroups)
    } catch (err) {
      console.error('保存命令按钮分组失败:', err)
    }
  },

  // ---- 日志 Actions ----

  toggleSessionLog: (sessionId) => {
    const state = get()
    const session = state.sessions.find((s) => s.id === sessionId)
    if (!session) return
    const config = session.config
    const currentEnabled = config.logConfig?.logEnabled ?? state.settings.logEnabled
    const newEnabled = !currentEnabled
    // 更新会话配置中的 logConfig
    set((s) => ({
      sessions: s.sessions.map((ss) =>
        ss.id === sessionId
          ? {
              ...ss,
              config: {
                ...ss.config,
                logConfig: { ...(ss.config.logConfig || createLogConfigFromSettings(s.settings)), logEnabled: newEnabled }
              } as ConnectionConfig
            }
          : ss
      )
    }))
    // 通知主进程更新日志状态
    const updatedSession = get().sessions.find((s) => s.id === sessionId)
    if (updatedSession) {
      const resolvedLogConfig = resolveLogConfig(updatedSession.config.logConfig, get().settings)
      if (newEnabled) {
        window.api.log.start(sessionId, resolvedLogConfig, updatedSession.config)
      } else {
        window.api.log.stop(sessionId)
      }
    }
  },
  getSessionLogEnabled: (sessionId) => {
    const state = get()
    const session = state.sessions.find((s) => s.id === sessionId)
    if (!session) return state.settings.logEnabled
    return session.config.logConfig?.logEnabled ?? state.settings.logEnabled
  },

  // ---- 视图状态持久化 Actions ----

  loadViewState: async () => {
    try {
      const state = await window.api.storage.loadViewState()
      if (state) {
        set({
          sidebarOpen: state.sidebarOpen,
          commandInputVisible: state.commandInputVisible,
          statusBarVisible: state.statusBarVisible,
          buttonBarVisible: state.buttonBarVisible
        })
      }
    } catch (err) {
      console.error('加载视图状态失败:', err)
    }
  },

  persistViewState: async () => {
    try {
      const { sidebarOpen, commandInputVisible, statusBarVisible, buttonBarVisible } = get()
      await window.api.storage.saveViewState({ sidebarOpen, commandInputVisible, statusBarVisible, buttonBarVisible })
    } catch (err) {
      console.error('保存视图状态失败:', err)
    }
  },

  // ---- 应用设置持久化 Actions ----

  loadAppSettings: async () => {
    try {
      const saved = await window.api.storage.loadAppSettings()
      if (saved) {
        set({ settings: { ...defaultSettings, ...saved } })
      }
    } catch (err) {
      console.error('加载应用设置失败:', err)
    }
  },

  persistAppSettings: async () => {
    try {
      const { settings } = get()
      await window.api.storage.saveAppSettings(settings)
    } catch (err) {
      console.error('保存应用设置失败:', err)
    }
  },

  // ---- Profile Actions ----

  loadProfiles: async () => {
    try {
      const profiles = await window.api.storage.loadProfiles()
      set({ profiles })
    } catch (err) {
      console.error('加载 Profile 失败:', err)
    }
  },

  persistProfiles: async () => {
    try {
      const { profiles } = get()
      await window.api.storage.saveProfiles(profiles)
    } catch (err) {
      console.error('保存 Profile 失败:', err)
    }
  },

  addProfile: (name, appliesTo, overrides) => {
    const id = generateId()
    const now = Date.now()
    const profile: Profile = { id, name, appliesTo, overrides, createdAt: now, updatedAt: now }
    set((state) => ({ profiles: [...state.profiles, profile] }))
    get().persistProfiles()
    return id
  },

  updateProfile: (id, updates) => {
    set((state) => ({
      profiles: state.profiles.map((p) =>
        p.id === id ? { ...p, ...updates, updatedAt: Date.now() } : p
      )
    }))
    get().persistProfiles()
  },

  removeProfile: (id) => {
    set((state) => ({ profiles: state.profiles.filter((p) => p.id !== id) }))
    get().persistProfiles()
  }
}))
