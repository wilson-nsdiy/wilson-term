import React, { useState, useCallback, useEffect, useRef } from 'react'
import { useAppStore } from '../store'
import { rendererPluginHost } from '@renderer/plugin-host.ts'
import NewConnectDialog from './NewConnectDialog'
import { resolveLogConfig } from '../utils/logConfig'
import type { SavedSession, ConnectionConfig, SSHConfig, TelnetConfig, SerialConfig, BashConfig, ScheduledTask } from '@shared/types'

/** 右键菜单状态 */
interface ContextMenuState {
  visible: boolean
  x: number
  y: number
  session: SavedSession | null
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
  const moveSavedSession = useAppStore((state) => state.moveSavedSession)
  const newConnectDialogOpen = useAppStore((state) => state.newConnectDialogOpen)
  const setNewConnectDialogOpen = useAppStore((state) => state.setNewConnectDialogOpen)

  // 编辑模式状态
  const [editingConfig, setEditingConfig] = useState<ConnectionConfig | null>(null)
  const [editingSavedSessionId, setEditingSavedSessionId] = useState<string | null>(null)

  // 右键菜单状态
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    session: null
  })

  // 拖拽排序状态
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const dragStartY = useRef(0)

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
    doConnect(saved.config, saved.scheduledTasks || [], saved.profileId)
  }

  const handleEditSavedSession = (saved: SavedSession) => {
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
      session: saved
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
      <div className="w-64 bg-gray-800 border-r border-gray-700 flex flex-col" onClick={handleSidebarClick}>
        {/* 侧边栏头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <span className="text-sm font-medium text-gray-300">会话管理</span>
        </div>

        {/* 新建连接按钮 */}
        <div className="p-3">
          <button
            onClick={() => { setNewConnectDialogOpen(true); setEditingConfig(null); setEditingSavedSessionId(null) }}
            className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm transition-colors"
          >
            🔗 新建连接
          </button>
        </div>

        {/* 保存的连接 */}
        <div className="flex-1 overflow-y-auto p-3">
          <div className="text-xs text-gray-500 mb-2">保存的连接</div>
          {savedSessions.length === 0 ? (
            <div className="text-sm text-gray-500 italic">暂无保存的连接</div>
          ) : (
            <div className="space-y-1">
              {savedSessions.map((saved, index) => (
                <div
                  key={saved.id}
                  draggable
                  onDragStart={(e) => { setDragIndex(index); dragStartY.current = e.clientY; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', index.toString()) }}
                  onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dragIndex !== null && dragIndex !== index) setDropIndex(index) }}
                  onDragEnd={() => { if (dragIndex !== null && dropIndex !== null && dragIndex !== dropIndex) moveSavedSession(dragIndex, dropIndex); setDragIndex(null); setDropIndex(null) }}
                  onDoubleClick={() => handleSavedSessionConnect(saved)}
                  onContextMenu={(e) => handleContextMenu(e, saved)}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-default transition-colors text-sm text-gray-300 select-none ${
                    dragIndex === index ? 'opacity-50' : 'hover:bg-gray-700'
                  } ${dropIndex === index && dragIndex !== null && dragIndex !== index ? 'border-t-2 border-blue-400' : ''}`}
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
                  <span className="text-xs text-gray-400 font-mono shrink-0 drop-shadow-[0_1px_1px_rgba(0,0,0,0.6)]">
                    {saved.config.type === 'serial'
                      ? `${(saved.config as SerialConfig).path}`
                      : saved.config.type === 'bash'
                        ? `${(saved.config as BashConfig).shell || 'auto'}`
                        : `${(saved.config as SSHConfig | TelnetConfig).host}:${(saved.config as SSHConfig | TelnetConfig).port}`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 右键菜单 */}
      {contextMenu.visible && (
        <div
          className="fixed z-50 bg-gray-800 border border-gray-600 rounded-lg shadow-xl py-1 min-w-[140px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
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
