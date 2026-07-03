import React, { useState, useCallback, useEffect, useRef } from 'react'
import { useAppStore } from '../store'
import { rendererPluginHost } from '@renderer/plugin-host.ts'
import NewConnectDialog from './NewConnectDialog'
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

  // 拖拽排序状态
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [dragType, setDragType] = useState<'session' | 'group' | null>(null)
  const [dragGroupId, setDragGroupId] = useState<string | null>(null)
  const dragStartY = useRef(0)

  // 侧边栏宽度调整状态
  const [isResizing, setIsResizing] = useState(false)
  const sidebarRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return
      const newWidth = e.clientX
      if (newWidth >= 150 && newWidth <= 400) {
        if (sidebarRef.current) {
          sidebarRef.current.style.width = `${newWidth}px`
        }
      }
    }

    const handleMouseUp = () => {
      setIsResizing(false)
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

  const handleResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
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
    addSavedSession(config, config.name)
    const { savedSessions: currentSessions } = useAppStore.getState()
    const latest = currentSessions[currentSessions.length - 1]
    if (latest) {
      const updates: Partial<SavedSession> = {}
      if (scheduledTasks && scheduledTasks.length > 0) updates.scheduledTasks = scheduledTasks
      if (profileId) updates.profileId = profileId
      if (Object.keys(updates).length > 0) {
        useAppStore.getState().updateSavedSession(latest.id, updates)
      }
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
  const handleGroupContextMenuAction = (action: 'rename' | 'delete' | 'addSubgroup' | 'addGroup') => {
    const { group } = contextMenu
    if (!group) return

    switch (action) {
      case 'rename': {
        const newName = prompt('重命名分组', group.name)
        if (newName && newName.trim()) {
          updateSessionGroup(group.id, { name: newName.trim() })
        }
        break
      }
      case 'delete': {
        if (confirm(`确定删除分组 "${group.name}" 吗？\n分组内的连接将移到未分组。`)) {
          removeSessionGroup(group.id)
        }
        break
      }
      case 'addSubgroup': {
        const name = prompt('新建子分组名称')
        if (name && name.trim()) {
          addSessionGroup(name.trim(), group.id)
        }
        break
      }
      case 'addGroup': {
        const name = prompt('新建分组名称')
        if (name && name.trim()) {
          addSessionGroup(name.trim(), group.parentId)
        }
        break
      }
    }
    handleContextMenuClose()
  }

  /** 构建侧边栏列表项（分组和未分组连接混合排序，支持搜索过滤） */
  const buildSidebarItems = useCallback(() => {
    const items: Array<
      | { type: 'group'; group: SavedSessionGroup; depth: number }
      | { type: 'session'; session: SavedSession; depth: number }
    > = []

    /** 检查会话是否匹配搜索关键词 */
    const sessionMatchesSearch = (session: SavedSession): boolean => {
      if (!searchKeyword.trim()) return true
      const keyword = searchKeyword.toLowerCase()
      return (
        session.name.toLowerCase().includes(keyword) ||
        (session.config.type === 'ssh' && session.config.host?.toLowerCase().includes(keyword)) ||
        (session.config.type === 'telnet' && session.config.host?.toLowerCase().includes(keyword)) ||
        (session.config.type === 'serial' && session.config.port?.toLowerCase().includes(keyword))
      )
    }

    /** 检查分组是否匹配搜索关键词 */
    const groupMatchesSearch = (group: SavedSessionGroup): boolean => {
      if (!searchKeyword.trim()) return true
      const keyword = searchKeyword.toLowerCase()
      return group.name.toLowerCase().includes(keyword)
    }

    /** 检查分组内是否有匹配的会话 */
    const groupHasMatchingSessions = (group: SavedSessionGroup): boolean => {
      if (!searchKeyword.trim()) return true
      return group.sessionIds.some(sessionId => {
        const session = savedSessions.find(s => s.id === sessionId)
        return session && sessionMatchesSearch(session)
      })
    }

    /** 递归添加分组及其子项 */
    const addGroupAndChildren = (parentId: string | undefined, depth: number) => {
      const groups = savedSessionGroups
        .filter(g => g.parentId === parentId)
        .sort((a, b) => a.order - b.order)

      for (const group of groups) {
        const shouldShow = !searchKeyword.trim() || groupMatchesSearch(group) || groupHasMatchingSessions(group)

        if (shouldShow) {
          items.push({ type: 'group', group, depth })

          // 搜索模式下强制展开所有分组
          if (!collapsedSessionGroupIds.has(group.id) || searchKeyword.trim()) {
            const sessions = savedSessions
              .filter(s => s.groupId === group.id && sessionMatchesSearch(s))
              .sort((a, b) => a.order - b.order)

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
    const ungroupedSessions = savedSessions
      .filter(s => !s.groupId && sessionMatchesSearch(s))
      .sort((a, b) => a.order - b.order)

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
          <button
            onClick={() => { setNewConnectDialogOpen(true); setEditingConfig(null); setEditingSavedSessionId(null) }}
            className="px-2 py-1 bg-blue-600 hover:bg-blue-700 rounded text-sm transition-colors"
          >
            新连接
          </button>
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
                      <div key={`group-${item.group.id}`}>
                        <div
                          style={{ paddingLeft: `${item.depth * 16 + 8}px` }}
                          className={`flex items-center gap-1 px-2 py-1.5 cursor-pointer hover:bg-gray-700 rounded text-sm text-gray-300 select-none ${
                            dragType === 'group' && dragGroupId === item.group.id ? 'opacity-50' : ''
                          } ${dropIndex === index && dragType === 'group' && dragGroupId !== item.group.id ? 'border-t-2 border-blue-400' : ''}`}
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
                              }
                            }
                          }}
                          onDragEnd={() => {
                            if (dragType === 'group' && dragIndex !== null && dropIndex !== null && dragIndex !== dropIndex) {
                              const items = buildSidebarItems()
                              const dragItem = items[dragIndex]
                              const dropItem = items[dropIndex]
                              if (dragItem?.type === 'group' && dropItem?.type === 'group') {
                                const groupItems = items.filter(i => i.type === 'group')
                                const fromIdx = groupItems.findIndex(i => i.type === 'group' && i.group.id === dragItem.group.id)
                                const toIdx = groupItems.findIndex(i => i.type === 'group' && i.group.id === dropItem.group.id)
                                if (fromIdx !== -1 && toIdx !== -1) {
                                  moveSessionGroup(fromIdx, toIdx, dragItem.group.parentId)
                                }
                              }
                            }
                            setDragIndex(null)
                            setDropIndex(null)
                            setDragType(null)
                            setDragGroupId(null)
                          }}
                          onClick={() => toggleSessionGroupCollapsed(item.group.id)}
                          onContextMenu={(e) => handleGroupContextMenu(e, item.group)}
                        >
                          <span className="text-xs">
                            {collapsedSessionGroupIds.has(item.group.id) ? '▶' : '▼'}
                          </span>
                          <span className="flex-1 truncate font-medium">{item.group.name}</span>
                          <span className="text-xs text-gray-500">[{item.group.sessionIds.length}]</span>
                        </div>
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
                            }
                          } else if (dragType === 'session' && item.type === 'group') {
                            setDropIndex(index)
                          }
                        }}
                        onDragEnd={() => {
                          if (dragIndex !== null && dropIndex !== null && dragIndex !== dropIndex) {
                            const items = buildSidebarItems()
                            const dragItem = items[dragIndex]
                            const dropItem = items[dropIndex]

                            if (dragType === 'session' && dragItem?.type === 'session') {
                              if (dropItem?.type === 'group') {
                                moveSessionToGroup(dragItem.session.id, dropItem.group.id)
                              } else if (dropItem?.type === 'session') {
                                moveSessionInList(dragItem.session.id, dropItem.session.id)
                              }
                            }
                          }
                          setDragIndex(null)
                          setDropIndex(null)
                          setDragType(null)
                          setDragGroupId(null)
                        }}
                        onDoubleClick={() => handleSavedSessionConnect(saved)}
                        onContextMenu={(e) => handleContextMenu(e, saved)}
                        style={{ paddingLeft: `${item.depth * 16 + 24}px` }}
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
              {getGroupDepth(contextMenu.group.id) < 3 && (
                <button
                  onClick={() => handleGroupContextMenuAction('addSubgroup')}
                  className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-gray-700 transition-colors"
                >
                  ➕ 新建子分组
                </button>
              )}
              <button
                onClick={() => handleGroupContextMenuAction('addGroup')}
                className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-gray-700 transition-colors"
              >
                ➕ 新建同级分组
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
    </>
  )
}

export default Sidebar
