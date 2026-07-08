import React, { useState, useCallback, useEffect, useRef } from 'react'
import { useAppStore } from '../store'
import { rendererPluginHost } from '@renderer/plugin-host.ts'
import NewConnectDialog from './NewConnectDialog'
import InputDialog from './InputDialog'
import { resolveLogConfig } from '../utils/logConfig'
import type { SavedSession, SavedSessionGroup, ConnectionConfig, ScheduledTask } from '@shared/types'

/** 右键菜单状态 */
interface ContextMenuState {
  visible: boolean
  x: number
  y: number
  session: SavedSession | null
  group: SavedSessionGroup | null
}

const Sidebar: React.FC = () => {
  const sidebarOpen = useAppStore((state) => state.sidebarOpen)
  const savedSessions = useAppStore((state) => state.savedSessions)
  const addSession = useAppStore((state) => state.addSession)
  const addSavedSession = useAppStore((state) => state.addSavedSession)
  const setActiveSession = useAppStore((state) => state.setActiveSession)
  const updateSessionStatus = useAppStore((state) => state.updateSessionStatus)
  const updateSessionProfile = useAppStore((state) => state.updateSessionProfile)
  const writeSessionError = useAppStore((state) => state.writeSessionError)
  const updateSavedSession = useAppStore((state) => state.updateSavedSession)
  const removeSavedSession = useAppStore((state) => state.removeSavedSession)
  const newConnectDialogOpen = useAppStore((state) => state.newConnectDialogOpen)
  const setNewConnectDialogOpen = useAppStore((state) => state.setNewConnectDialogOpen)

  // 分组相关状态和 actions
  const savedSessionGroups = useAppStore((state) => state.savedSessionGroups)
  const collapsedSessionGroupIds = useAppStore((state) => state.collapsedSessionGroupIds)
  const toggleSessionGroupCollapsed = useAppStore((state) => state.toggleSessionGroupCollapsed)
  const addSessionGroup = useAppStore((state) => state.addSessionGroup)
  const updateSessionGroup = useAppStore((state) => state.updateSessionGroup)
  const removeSessionGroup = useAppStore((state) => state.removeSessionGroup)
  const moveSessionGroup = useAppStore((state) => state.moveSessionGroup)

  // 编辑模式状态
  const [editingConfig, setEditingConfig] = useState<ConnectionConfig | null>(null)
  const [editingSavedSessionId, setEditingSavedSessionId] = useState<string | null>(null)

  // 右键菜单状态
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    session: null,
    group: null
  })

  const [searchKeyword, setSearchKeyword] = useState('')

  // 新建菜单状态
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const newMenuRef = useRef<HTMLDivElement>(null)

  // 输入对话框状态
  const [inputDialogOpen, setInputDialogOpen] = useState(false)
  const [inputDialogTitle, setInputDialogTitle] = useState('')
  const [inputDialogMessage, setInputDialogMessage] = useState('')
  const [inputDialogDefault, setInputDialogDefault] = useState('')
  const [inputDialogPlaceholder, setInputDialogPlaceholder] = useState('')
  const inputDialogCallback = useRef<(value: string) => void>(() => {})

  // 拖拽排序状态
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [dragType, setDragType] = useState<'session' | 'group' | null>(null)
  const [dragGroupId, setDragGroupId] = useState<string | null>(null)
  const [dropGroupId, setDropGroupId] = useState<string | null>(null)
  const [dropSessionId, setDropSessionId] = useState<string | null>(null)
  const [dropPosition, setDropPosition] = useState<'before' | 'inside' | 'after' | null>(null)
  const [dropToTopLevel, setDropToTopLevel] = useState(false)
  const dragStartY = useRef(0)

  // 侧边栏宽度调整状态
  const [isResizing, setIsResizing] = useState(false)
  const sidebarRef = useRef<HTMLDivElement>(null)
  // 拖动期间以 rAF 节流派发 resize，触发终端 fit
  const resizeRafRef = useRef<number | null>(null)

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return
      const newWidth = e.clientX
      if (newWidth >= 150 && newWidth <= 400) {
        if (sidebarRef.current) {
          sidebarRef.current.style.width = `${newWidth}px`
        }
        if (resizeRafRef.current == null) {
          resizeRafRef.current = requestAnimationFrame(() => {
            resizeRafRef.current = null
            window.dispatchEvent(new Event('resize'))
          })
        }
      }
    }

    const handleMouseUp = () => {
      setIsResizing(false)
      if (resizeRafRef.current != null) {
        cancelAnimationFrame(resizeRafRef.current)
        resizeRafRef.current = null
      }
      // 拖动结束兜底触发一次 fit，确保最终尺寸对齐
      window.dispatchEvent(new Event('resize'))
    }

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing])

  // 点击外部关闭新建菜单
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node)) {
        setNewMenuOpen(false)
      }
    }

    if (newMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [newMenuOpen])

  const handleResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
  }

  /** 显示输入对话框 */
  const showInputDialog = (
    title: string,
    message: string,
    defaultValue: string,
    placeholder: string,
    callback: (value: string) => void
  ) => {
    setInputDialogTitle(title)
    setInputDialogMessage(message)
    setInputDialogDefault(defaultValue)
    setInputDialogPlaceholder(placeholder)
    inputDialogCallback.current = callback
    setInputDialogOpen(true)
  }

  /** 新建目录 */
  const handleNewGroup = () => {
    setNewMenuOpen(false)
    showInputDialog(
      '新建目录',
      '请输入目录名称',
      '',
      '目录名称',
      (name) => {
        if (name && name.trim()) {
          addSessionGroup(name.trim())
        }
      }
    )
  }

  /** 新建连接 */
  const handleNewConnection = () => {
    setNewMenuOpen(false)
    setNewConnectDialogOpen(true)
    setEditingConfig(null)
    setEditingSavedSessionId(null)
  }

  /** 从 IPC 错误中提取用户友好的消息 */
  const extractErrorMessage = (err: unknown): string => {
    const raw = err instanceof Error ? err.message : String(err)
    // 去掉 IPC 通道前缀，如 "Error invoking remote method 'serial:open': Error: xxx"
    return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/i, '')
  }

  // ---- 新建连接 ----
  // 所有连接函数先创建 session（显示终端），再发起连接
  // 连接成功 -> 更新状态为 connected
  // 连接失败 -> 在终端中显示错误信息

  /** 统一连接逻辑：创建 session → 连接 → 更新状态 → 处理定时任务/Profile */
  const doConnect = async (config: ConnectionConfig, tasks?: ScheduledTask[], profileId?: string) => {
    const id = addSession(config)
    config.id = id
    setActiveSession(id)
    rendererPluginHost.notifySessionCreated(id)
    try {
      const resolvedLogConfig = resolveLogConfig(config.logConfig, useAppStore.getState().settings)
      await window.api.connection.connect(config, resolvedLogConfig)
      updateSessionStatus(id, 'connected')
      if (profileId) updateSessionProfile(id, profileId)
      if (tasks && tasks.length > 0) {
        const { addScheduledTask } = useAppStore.getState()
        for (const task of tasks) addScheduledTask(id, { ...task, sessionId: id, enabled: false, executedCount: 0 })
      }
    } catch (err) {
      console.error('连接失败:', err)
      writeSessionError(id, extractErrorMessage(err))
    }
  }

  const handleConnect = (config: ConnectionConfig, scheduledTasks?: ScheduledTask[], profileId?: string) => {
    doConnect(config, scheduledTasks, profileId)
  }

  const handleSavedSessionConnect = (saved: SavedSession) => {
    if (!saved.config) return
    doConnect(saved.config, saved.scheduledTasks || [], saved.profileId)
  }

  const handleEditSavedSession = (saved: SavedSession) => {
    if (!saved.config) return
    setEditingSavedSessionId(saved.id)
    setEditingConfig(saved.config)
    setNewConnectDialogOpen(true)
  }

  const handleDeleteSavedSession = (id: string) => {
    removeSavedSession(id)
  }

  const handleConfigEdit = (config: ConnectionConfig, scheduledTasks?: ScheduledTask[], profileId?: string) => {
    if (editingSavedSessionId) {
      updateSavedSession(editingSavedSessionId, { config, name: config.name, scheduledTasks: scheduledTasks || [], profileId })
    }
    setEditingSavedSessionId(null)
    setEditingConfig(null)
  }

  const handleSaveAndConnect = (config: ConnectionConfig, scheduledTasks?: ScheduledTask[], profileId?: string) => {
    const savedSessionId = addSavedSession(config, config.name)
    const updates: Partial<SavedSession> = {}
    if (scheduledTasks && scheduledTasks.length > 0) updates.scheduledTasks = scheduledTasks
    if (profileId) updates.profileId = profileId
    if (Object.keys(updates).length > 0) {
      updateSavedSession(savedSessionId, updates)
    }
    handleConnect(config, scheduledTasks, profileId)
  }

  // ---- 右键菜单 ----

  const handleContextMenu = useCallback((e: React.MouseEvent, saved: SavedSession) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      session: saved,
      group: null
    })
  }, [])

  const handleContextMenuClose = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false }))
  }, [])

  const handleContextMenuAction = (action: 'connect' | 'edit' | 'delete') => {
    const saved = contextMenu.session
    if (!saved) return

    switch (action) {
      case 'connect':
        handleSavedSessionConnect(saved)
        break
      case 'edit':
        handleEditSavedSession(saved)
        break
      case 'delete':
        handleDeleteSavedSession(saved.id)
        break
    }
    handleContextMenuClose()
  }

  // 点击其他区域关闭右键菜单
  const handleSidebarClick = () => {
    if (contextMenu.visible) {
      handleContextMenuClose()
    }
  }

  // ---- 分组右键菜单 ----

  const handleGroupContextMenu = useCallback((e: React.MouseEvent, group: SavedSessionGroup) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      session: null,
      group
    })
  }, [])

  /** 获取分组深度 */
  const getGroupDepth = useCallback((groupId: string): number => {
    let depth = 0
    let currentId: string | undefined = groupId

    while (currentId) {
      const group = savedSessionGroups.find(g => g.id === currentId)
      if (!group || !group.parentId) break
      currentId = group.parentId
      depth++
    }

    return depth
  }, [savedSessionGroups])

  /** 分组右键菜单操作 */
  const handleGroupContextMenuAction = (action: 'rename' | 'delete') => {
    const { group } = contextMenu
    if (!group) return

    // 先关闭右键菜单
    handleContextMenuClose()

    switch (action) {
      case 'rename': {
        showInputDialog(
          '重命名分组',
          '请输入新的分组名称',
          group.name,
          '分组名称',
          (newName) => {
            if (newName && newName.trim()) {
              updateSessionGroup(group.id, { name: newName.trim() })
            }
          }
        )
        break
      }
      case 'delete': {
        if (confirm(`确定删除分组 "${group.name}" 吗？\n分组内的连接将移到未分组。`)) {
          removeSessionGroup(group.id)
        }
        break
      }
    }
  }

  /** 构建侧边栏列表项（分组和未分组连接混合排序，支持搜索过滤） */
  const buildSidebarItems = useCallback(() => {
    const items: Array<
      | { type: 'group'; group: SavedSessionGroup; depth: number; totalSessionCount: number }
      | { type: 'session'; session: SavedSession; depth: number }
    > = []

    const keyword = searchKeyword.trim().toLowerCase()
    const isSearching = keyword.length > 0

    /** 检查会话是否匹配搜索关键词 */
    const sessionMatchesSearch = (session: SavedSession): boolean => {
      if (!isSearching) return true
      return (
        session.name.toLowerCase().includes(keyword) ||
        (session.config.type === 'ssh' && session.config.host?.toLowerCase().includes(keyword)) ||
        (session.config.type === 'telnet' && session.config.host?.toLowerCase().includes(keyword)) ||
        (session.config.type === 'serial' && session.config.port?.toLowerCase().includes(keyword))
      )
    }

    /** 检查分组是否匹配搜索关键词 */
    const groupMatchesSearch = (group: SavedSessionGroup): boolean => {
      if (!isSearching) return true
      return group.name.toLowerCase().includes(keyword)
    }

    const childGroupsByParentId = new Map<string | undefined, SavedSessionGroup[]>()
    for (const group of savedSessionGroups) {
      const siblings = childGroupsByParentId.get(group.parentId) || []
      siblings.push(group)
      childGroupsByParentId.set(group.parentId, siblings)
    }
    for (const groups of childGroupsByParentId.values()) {
      groups.sort((a, b) => a.order - b.order)
    }

    const sessionsByGroupId = new Map<string | undefined, SavedSession[]>()
    for (const session of savedSessions) {
      const siblings = sessionsByGroupId.get(session.groupId) || []
      siblings.push(session)
      sessionsByGroupId.set(session.groupId, siblings)
    }
    for (const sessions of sessionsByGroupId.values()) {
      sessions.sort((a, b) => a.order - b.order)
    }

    const visibleGroupIds = new Set<string>()

    const groupHasVisibleContent = (group: SavedSessionGroup): boolean => {
      if (!isSearching) {
        return true
      }

      if (groupMatchesSearch(group)) {
        visibleGroupIds.add(group.id)
        return true
      }

      const directSessions = sessionsByGroupId.get(group.id) || []
      if (directSessions.some(sessionMatchesSearch)) {
        visibleGroupIds.add(group.id)
        return true
      }

      const childGroups = childGroupsByParentId.get(group.id) || []
      if (childGroups.some(groupHasVisibleContent)) {
        visibleGroupIds.add(group.id)
        return true
      }

      return false
    }

    /** 递归计算分组及其所有子分组中匹配搜索的会话总数 */
    const countGroupSessions = (groupId: string): number => {
      const directSessions = (sessionsByGroupId.get(groupId) || []).filter(session => !isSearching || sessionMatchesSearch(session))
      let count = directSessions.length
      const childGroups = childGroupsByParentId.get(groupId) || []
      for (const child of childGroups) {
        count += countGroupSessions(child.id)
      }
      return count
    }

    /** 递归添加分组及其子项 */
    const addGroupAndChildren = (parentId: string | undefined, depth: number) => {
      const groups = childGroupsByParentId.get(parentId) || []

      for (const group of groups) {
        const shouldShow = !isSearching || visibleGroupIds.has(group.id) || groupHasVisibleContent(group)

        if (shouldShow) {
          items.push({ type: 'group', group, depth, totalSessionCount: countGroupSessions(group.id) })

          // 搜索模式下强制展开所有分组
          if (!collapsedSessionGroupIds.has(group.id) || isSearching) {
            const sessions = (sessionsByGroupId.get(group.id) || []).filter(session => !isSearching || sessionMatchesSearch(session))

            for (const session of sessions) {
              items.push({ type: 'session', session, depth: depth + 1 })
            }

            // 递归添加子分组
            addGroupAndChildren(group.id, depth + 1)
          }
        }
      }
    }

    // 添加顶级分组和未分组连接
    addGroupAndChildren(undefined, 0)

    // 添加未分组连接
    const ungroupedSessions = (sessionsByGroupId.get(undefined) || []).filter(session => !isSearching || sessionMatchesSearch(session))

    for (const session of ungroupedSessions) {
      items.push({ type: 'session', session, depth: 0 })
    }

    return items
  }, [savedSessionGroups, savedSessions, collapsedSessionGroupIds, searchKeyword])

  // ---- 拖拽辅助函数 ----

  /** 判断是否为子分组（防止循环嵌套） */
  const isDescendant = useCallback((parentId: string, childId: string): boolean => {
    const { savedSessionGroups } = useAppStore.getState()

    const check = (currentId: string, targetId: string): boolean => {
      if (currentId === targetId) return true
      const children = savedSessionGroups.filter(g => g.parentId === currentId)
      return children.some(c => check(c.id, targetId))
    }

    return check(parentId, childId)
  }, [])

  /** 移动会话到分组 */
  const moveSessionToGroup = useCallback((sessionId: string, targetGroupId: string) => {
    const { savedSessions, savedSessionGroups, updateSavedSession, updateSessionGroup } = useAppStore.getState()

    const session = savedSessions.find(s => s.id === sessionId)
    if (!session) return

    // 从原分组移除
    if (session.groupId) {
      const sourceGroup = savedSessionGroups.find(g => g.id === session.groupId)
      if (sourceGroup) {
        updateSessionGroup(session.groupId, {
          sessionIds: sourceGroup.sessionIds.filter(id => id !== sessionId)
        })
      }
    }

    // 添加到目标分组
    const targetGroup = savedSessionGroups.find(g => g.id === targetGroupId)
    if (targetGroup) {
      updateSessionGroup(targetGroupId, {
        sessionIds: [...targetGroup.sessionIds, sessionId]
      })
    }

    // 更新会话的 groupId
    updateSavedSession(sessionId, { groupId: targetGroupId })
  }, [])

  /** 移动会话到顶层（脱离分组） */
  const moveSessionToTopLevel = useCallback((sessionId: string) => {
    const { savedSessions, savedSessionGroups, updateSavedSession, updateSessionGroup } = useAppStore.getState()
    const session = savedSessions.find(s => s.id === sessionId)
    if (!session) return

    if (session.groupId) {
      const sourceGroup = savedSessionGroups.find(g => g.id === session.groupId)
      if (sourceGroup) {
        updateSessionGroup(sourceGroup.id, {
          sessionIds: sourceGroup.sessionIds.filter(id => id !== sessionId)
        })
      }
    }

    const ungroupedSessions = savedSessions
      .filter(s => !s.groupId && s.id !== sessionId)
      .sort((a, b) => a.order - b.order)

    updateSavedSession(sessionId, {
      groupId: undefined,
      order: ungroupedSessions.length
    })
  }, [])

  /** 在列表中移动会话（同分组内排序或跨分组移动） */
  const moveSessionInList = useCallback((sessionId: string, targetSessionId: string) => {
    const { savedSessions, savedSessionGroups, updateSavedSession, updateSessionGroup } = useAppStore.getState()

    const session = savedSessions.find(s => s.id === sessionId)
    const targetSession = savedSessions.find(s => s.id === targetSessionId)

    if (!session || !targetSession) return

    // 如果在同一个分组内
    if (session.groupId === targetSession.groupId) {
      // 重新排序分组内的 sessionIds
      const group = savedSessionGroups.find(g => g.id === session.groupId)
      if (group) {
        const newSessionIds = [...group.sessionIds]
        const fromIdx = newSessionIds.indexOf(sessionId)
        const toIdx = newSessionIds.indexOf(targetSessionId)
        if (fromIdx !== -1 && toIdx !== -1) {
          newSessionIds.splice(fromIdx, 1)
          newSessionIds.splice(toIdx, 0, sessionId)
          updateSessionGroup(group.id, { sessionIds: newSessionIds })
        }
      } else if (!session.groupId) {
        // 未分组会话排序：按 order 重排
        const ungroupedSessions = savedSessions
          .filter(s => !s.groupId)
          .sort((a, b) => a.order - b.order)
        const fromIdx = ungroupedSessions.findIndex(s => s.id === sessionId)
        const toIdx = ungroupedSessions.findIndex(s => s.id === targetSessionId)
        if (fromIdx !== -1 && toIdx !== -1) {
          const reordered = [...ungroupedSessions]
          const [moved] = reordered.splice(fromIdx, 1)
          reordered.splice(toIdx, 0, moved)
          reordered.forEach((s, i) => {
            if (s.order !== i) updateSavedSession(s.id, { order: i })
          })
        }
      }
    } else {
      // 跨分组移动
      if (targetSession.groupId) {
        moveSessionToGroup(sessionId, targetSession.groupId)
      } else {
        // 移动到未分组
        if (session.groupId) {
          const sourceGroup = savedSessionGroups.find(g => g.id === session.groupId)
          if (sourceGroup) {
            updateSessionGroup(session.groupId, {
              sessionIds: sourceGroup.sessionIds.filter(id => id !== sessionId)
            })
          }
        }
        updateSavedSession(sessionId, { groupId: undefined })
      }
    }
  }, [moveSessionToGroup])

  if (!sidebarOpen) {
    return (
      <>
        <NewConnectDialog
          open={newConnectDialogOpen}
          onClose={() => { setNewConnectDialogOpen(false); setEditingConfig(null); setEditingSavedSessionId(null) }}
          onConnect={handleConnect}
          editConfig={editingConfig}
          onEdit={handleConfigEdit}
          onSaveAndConnect={handleSaveAndConnect}
        />
      </>
    )
  }

  return (
    <>
      <div 
        ref={sidebarRef}
        className="w-64 bg-gray-800 border-r border-gray-700 flex flex-col relative" 
        onClick={handleSidebarClick}
        style={{ minWidth: '150px', maxWidth: '400px' }}
      >
        {/* 侧边栏头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <span className="text-sm font-medium text-gray-300">会话管理</span>
          <div className="relative" ref={newMenuRef}>
            <button
              onClick={() => setNewMenuOpen(!newMenuOpen)}
              className="px-2 py-1 bg-blue-600 hover:bg-blue-700 rounded text-sm transition-colors"
            >
              新建
            </button>
            {newMenuOpen && (
              <div className="absolute right-0 top-full mt-1 bg-gray-800 border border-gray-600 rounded-lg shadow-xl py-1 min-w-[120px] z-50">
                <button
                  onClick={handleNewGroup}
                  className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-gray-700 transition-colors"
                >
                  新建目录
                </button>
                <button
                  onClick={handleNewConnection}
                  className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-gray-700 transition-colors"
                >
                  新建连接
                </button>
              </div>
            )}
          </div>
        </div>

        {/* 搜索框 */}
        <div className="px-3 py-2 border-b border-gray-700">
          <input
            type="text"
            placeholder="搜索连接..."
            value={searchKeyword}
            onChange={(e) => setSearchKeyword(e.target.value)}
            className="w-full px-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-gray-300 placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
        </div>

        {/* 保存的连接 */}
        <div className="flex-1 overflow-y-auto p-3">
          {(() => {
            const items = buildSidebarItems()

            return items.length === 0 ? (
              <div className="text-sm text-gray-500 italic">{searchKeyword ? '未找到匹配的连接' : '暂无保存的连接'}</div>
            ) : (
              <div className="space-y-1">
                {items.map((item, index) => {
                  if (item.type === 'group') {
                    return (
                        <div
                          key={`group-${item.group.id}`}
                          draggable={!searchKeyword.trim()}
                          onDragStart={(e) => {
                            setDragIndex(index)
                            setDragType('group')
                            setDragGroupId(item.group.id)
                            dragStartY.current = e.clientY
                            e.dataTransfer.effectAllowed = 'move'
                            e.dataTransfer.setData('text/plain', `group:${item.group.id}`)
                          }}
                          onDragOver={(e) => {
                            e.preventDefault()
                            e.dataTransfer.dropEffect = 'move'
                            if (dragType === 'group' && item.type === 'group') {
                              if (dragGroupId !== item.group.id && !isDescendant(item.group.id, dragGroupId || '')) {
                                setDropIndex(index)
                                setDropGroupId(item.group.id)
                                setDropSessionId(null)
                                // 判断鼠标位置：上方1/4排序，中间2/4嵌套，下方1/4排序
                                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                                const y = e.clientY - rect.top
                                const height = rect.height
                                if (y < height * 0.25) {
                                  setDropPosition('before')
                                } else if (y > height * 0.75) {
                                  setDropPosition('after')
                                } else {
                                  setDropPosition('inside')
                                }
                              }
                            } else if (dragType === 'session' && item.type === 'group') {
                              setDropIndex(index)
                              setDropGroupId(item.group.id)
                              setDropSessionId(null)
                              setDropPosition('inside')
                            }
                          }}
                          onDragEnd={() => {
                            if (dragType === 'group' && dragGroupId && dropGroupId && dragGroupId !== dropGroupId) {
                              const dragItem = savedSessionGroups.find(group => group.id === dragGroupId)
                              const dropItem = savedSessionGroups.find(group => group.id === dropGroupId)
                              if (dragItem && dropItem) {
                                // 判断是嵌套还是排序
                                if (dropPosition === 'inside') {
                                  const targetDepth = getGroupDepth(dropItem.id)
                                  if (targetDepth < 3) {
                                    const targetSiblingCount = savedSessionGroups.filter(
                                      g => g.parentId === dropItem.id && g.id !== dragItem.id
                                    ).length
                                    moveSessionGroup(dragItem.id, dropItem.id, targetSiblingCount)
                                  }
                                } else {
                                  const targetParentId = dropItem.parentId
                                  const siblingGroups = savedSessionGroups
                                    .filter(g => g.parentId === targetParentId)
                                    .sort((a, b) => a.order - b.order)
                                  const targetSiblingIndex = siblingGroups.findIndex(g => g.id === dropItem.id)
                                  if (targetSiblingIndex !== -1) {
                                    const insertIndex = dropPosition === 'after' ? targetSiblingIndex + 1 : targetSiblingIndex
                                    moveSessionGroup(dragItem.id, targetParentId, insertIndex)
                                  }
                                }
                              }
                            }
                            setDragIndex(null)
                            setDropIndex(null)
                            setDragType(null)
                            setDragGroupId(null)
                            setDropGroupId(null)
                            setDropSessionId(null)
                            setDropPosition(null)
                          }}
                          onClick={() => toggleSessionGroupCollapsed(item.group.id)}
                          onContextMenu={(e) => handleGroupContextMenu(e, item.group)}
                          style={{ paddingLeft: `${item.depth * 16 + 8}px` }}
                          className={`flex items-center gap-1 px-2 py-1.5 cursor-pointer hover:bg-gray-700 rounded text-sm text-gray-300 select-none ${
                            dragType === 'group' && dragGroupId === item.group.id ? 'opacity-50' : ''
                          } ${
                            dropIndex === index && ((dragType === 'group' && dragGroupId !== item.group.id) || dragType === 'session')
                              ? dropPosition === 'before'
                                ? 'border-t-2 border-blue-400'
                                : dropPosition === 'after'
                                  ? 'border-b-2 border-blue-400'
                                  : 'bg-blue-600/30'
                              : ''
                          }`}
                        >
                          <span className="text-[10px] font-mono font-bold px-1 rounded text-yellow-400 bg-yellow-400/10">
                            {collapsedSessionGroupIds.has(item.group.id) ? '▶' : '▼'}
                          </span>
                          <span className="flex-1 truncate font-medium">{item.group.name}</span>
                          <span className="text-xs text-gray-500">[{item.totalSessionCount}]</span>
                        </div>
                    )
                  } else {
                    const saved = item.session
                    return (
                      <div
                        key={saved.id}
                        draggable={!searchKeyword.trim()}
                        onDragStart={(e) => {
                          setDragIndex(index)
                          setDragType('session')
                          setDragGroupId(null)
                          dragStartY.current = e.clientY
                          e.dataTransfer.effectAllowed = 'move'
                          e.dataTransfer.setData('text/plain', `session:${saved.id}`)
                        }}
                        onDragOver={(e) => {
                          e.preventDefault()
                          e.dataTransfer.dropEffect = 'move'
                          if (dragType === 'session' && item.type === 'session') {
                            if (dragIndex !== null && dragIndex !== index) {
                              setDropIndex(index)
                              setDropSessionId(saved.id)
                              setDropGroupId(null)
                            }
                          } else if (dragType === 'session' && item.type === 'group') {
                            setDropIndex(index)
                            setDropGroupId(item.group.id)
                            setDropSessionId(null)
                          }
                        }}
                        onDragEnd={() => {
                          if (dragType === 'session' && dragIndex !== null) {
                            const items = buildSidebarItems()
                            const dragItem = items[dragIndex]

                            if (dragItem?.type === 'session') {
                              if (dropToTopLevel) {
                                moveSessionToTopLevel(dragItem.session.id)
                              } else if (dropGroupId) {
                                moveSessionToGroup(dragItem.session.id, dropGroupId)
                              } else if (dropSessionId && dropSessionId !== dragItem.session.id) {
                                moveSessionInList(dragItem.session.id, dropSessionId)
                              }
                            }
                          }
                          setDragIndex(null)
                          setDropIndex(null)
                          setDragType(null)
                          setDragGroupId(null)
                          setDropGroupId(null)
                          setDropSessionId(null)
                          setDropPosition(null)
                          setDropToTopLevel(false)
                        }}
                        onDoubleClick={() => handleSavedSessionConnect(saved)}
                        onContextMenu={(e) => handleContextMenu(e, saved)}
                        style={{ paddingLeft: `${item.depth * 16 + 8}px` }}
                        className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-default transition-colors text-sm text-gray-300 select-none ${
                          dragType === 'session' && dragIndex === index ? 'opacity-50' : 'hover:bg-gray-700'
                        } ${dropIndex === index && dragType === 'session' && dragIndex !== null && dragIndex !== index ? 'border-t-2 border-blue-400' : ''}`}
                      >
                        <span className={`text-[10px] font-mono font-bold px-1 rounded ${
                          saved.config.type === 'ssh'
                            ? 'text-blue-400 bg-blue-400/10'
                            : saved.config.type === 'telnet'
                              ? 'text-purple-400 bg-purple-400/10'
                              : saved.config.type === 'bash'
                                ? 'text-orange-400 bg-orange-400/10'
                                : 'text-green-400 bg-green-400/10'
                        }`}>
                          {saved.config.type === 'ssh' ? 'SSH' : saved.config.type === 'telnet' ? 'TLN' : saved.config.type === 'bash' ? 'BASH' : 'SRL'}
                        </span>
                        <span className="flex-1 truncate">{saved.name}</span>
                      </div>
                    )
                  }
                })}
                {dragType === 'session' && (
                  <div
                    onDragOver={(e) => {
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                      setDropToTopLevel(true)
                      setDropIndex(null)
                      setDropGroupId(null)
                      setDropSessionId(null)
                    }}
                    onDragLeave={() => setDropToTopLevel(false)}
                    className={`mt-2 py-2 text-center text-xs rounded transition-colors cursor-default ${
                      dropToTopLevel
                        ? 'border-2 border-dashed border-blue-400 bg-blue-400/10 text-blue-400'
                        : 'border border-dashed border-gray-600 text-gray-500'
                    }`}
                  >
                    拖放至此移至顶层
                  </div>
                )}
              </div>
            )
          })()}
        </div>

        {/* 宽度调整手柄 */}
        <div
          className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-blue-500/50 transition-colors"
          onMouseDown={handleResizeMouseDown}
        />
      </div>

      {/* 右键菜单 */}
      {contextMenu.visible && (
        <div
          className="fixed z-50 bg-gray-800 border border-gray-600 rounded-lg shadow-xl py-1 min-w-[140px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.group ? (
            // 分组右键菜单
            <>
              <button
                onClick={() => handleGroupContextMenuAction('rename')}
                className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-gray-700 transition-colors"
              >
                ✏️ 重命名
              </button>
              <div className="border-t border-gray-600 my-1" />
              <button
                onClick={() => handleGroupContextMenuAction('delete')}
                className="w-full px-4 py-2 text-left text-sm text-red-400 hover:bg-gray-700 transition-colors"
              >
                🗑️ 删除分组
              </button>
            </>
          ) : (
            // 原有的会话右键菜单
            <>
              <button
                onClick={() => handleContextMenuAction('connect')}
                className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-gray-700 transition-colors"
              >
                🔗 连接
              </button>
              <button
                onClick={() => handleContextMenuAction('edit')}
                className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-gray-700 transition-colors"
              >
                ✏️ 编辑
              </button>
              <div className="border-t border-gray-600 my-1" />
              <button
                onClick={() => handleContextMenuAction('delete')}
                className="w-full px-4 py-2 text-left text-sm text-red-400 hover:bg-gray-700 transition-colors"
              >
                🗑️ 删除
              </button>
            </>
          )}
        </div>
      )}

      {/* 统一新建连接对话框 */}
      <NewConnectDialog
        open={newConnectDialogOpen}
        onClose={() => { setNewConnectDialogOpen(false); setEditingConfig(null); setEditingSavedSessionId(null) }}
        onConnect={handleConnect}
        editConfig={editingConfig}
        onEdit={handleConfigEdit}
        onSaveAndConnect={handleSaveAndConnect}
      />

      {/* 输入对话框 */}
      <InputDialog
        open={inputDialogOpen}
        title={inputDialogTitle}
        message={inputDialogMessage}
        defaultValue={inputDialogDefault}
        placeholder={inputDialogPlaceholder}
        onConfirm={(value) => {
          setInputDialogOpen(false)
          inputDialogCallback.current(value)
        }}
        onCancel={() => setInputDialogOpen(false)}
      />
    </>
  )
}

export default Sidebar
