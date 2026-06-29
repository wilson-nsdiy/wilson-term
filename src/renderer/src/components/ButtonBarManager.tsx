import React, { useState, useEffect } from 'react'
import { useAppStore } from '../store'
import type { CommandButtonGroup, CommandButton } from '@shared/types'

/** 生成唯一 ID */
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2)
}

/** 空按钮定义 */
function createEmptyButton(groupId: string): CommandButton {
  return { id: generateId(), label: '', commands: [''], delay: 100, groupId }
}

/** 按钮管理对话框：管理分组和按钮 */
const ButtonBarManager: React.FC = () => {
  const open = useAppStore((state) => state.buttonBarManagerOpen)
  const setOpen = useAppStore((state) => state.setButtonBarManagerOpen)
  const groups = useAppStore((state) => state.commandButtonGroups)
  const setGroups = useAppStore((state) => state.setCommandButtonGroups)
  const setActiveButtonGroupId = useAppStore((state) => state.setActiveButtonGroupId)
  const persist = useAppStore((state) => state.persistCommandButtonGroups)

  // 本地编辑状态
  const [localGroups, setLocalGroups] = useState<CommandButtonGroup[]>([])

  useEffect(() => {
    if (open) {
      setLocalGroups(JSON.parse(JSON.stringify(groups)))
    }
  }, [open, groups])

  /** 添加新分组 */
  const handleAddGroup = () => {
    const newGroup: CommandButtonGroup = {
      id: generateId(),
      name: `分组 ${localGroups.length + 1}`,
      buttons: []
    }
    setLocalGroups([...localGroups, newGroup])
  }

  /** 更新分组名称 */
  const handleUpdateGroupName = (groupId: string, name: string) => {
    setLocalGroups(localGroups.map((g) => (g.id === groupId ? { ...g, name } : g)))
  }

  /** 删除分组 */
  const handleDeleteGroup = (groupId: string) => {
    setLocalGroups(localGroups.filter((g) => g.id !== groupId))
  }

  /** 添加按钮到分组 */
  const handleAddButton = (groupId: string) => {
    setLocalGroups(
      localGroups.map((g) =>
        g.id === groupId ? { ...g, buttons: [...g.buttons, createEmptyButton(groupId)] } : g
      )
    )
  }

  /** 更新按钮字段 */
  const handleUpdateButton = (groupId: string, buttonId: string, field: keyof CommandButton, value: string | number | string[]) => {
    setLocalGroups(
      localGroups.map((g) =>
        g.id === groupId
          ? {
              ...g,
              buttons: g.buttons.map((b) => (b.id === buttonId ? { ...b, [field]: value } : b))
            }
          : g
      )
    )
  }

  /** 删除按钮 */
  const handleDeleteButton = (groupId: string, buttonId: string) => {
    setLocalGroups(
      localGroups.map((g) =>
        g.id === groupId
          ? { ...g, buttons: g.buttons.filter((b) => b.id !== buttonId) }
          : g
      )
    )
  }

  /** 上移按钮 */
  const handleMoveButtonUp = (groupId: string, index: number) => {
    if (index <= 0) return
    setLocalGroups(
      localGroups.map((g) => {
        if (g.id !== groupId) return g
        const buttons = [...g.buttons]
        ;[buttons[index - 1], buttons[index]] = [buttons[index], buttons[index - 1]]
        return { ...g, buttons }
      })
    )
  }

  /** 下移按钮 */
  const handleMoveButtonDown = (groupId: string, index: number) => {
    const group = localGroups.find((g) => g.id === groupId)
    if (!group || index >= group.buttons.length - 1) return
    setLocalGroups(
      localGroups.map((g) => {
        if (g.id !== groupId) return g
        const buttons = [...g.buttons]
        ;[buttons[index], buttons[index + 1]] = [buttons[index + 1], buttons[index]]
        return { ...g, buttons }
      })
    )
  }

  /** 保存 */
  const handleSave = () => {
    // 删除空按钮和空分组
    const cleaned = localGroups
      .filter((g) => g.name.trim() !== '')
      .map((g) => ({
        ...g,
        buttons: g.buttons.filter((b) => b.label.trim() !== '' && b.commands.some((c) => c.trim() !== ''))
      }))
    setGroups(cleaned)
    // 确保 activeButtonGroupId 有效
    const currentActiveId = useAppStore.getState().activeButtonGroupId
    const stillValid = cleaned.some((g) => g.id === currentActiveId)
    if (!stillValid && cleaned.length > 0) {
      setActiveButtonGroupId(cleaned[0].id)
    }
    persist()
    setOpen(false)
  }

  /** 取消 */
  const handleCancel = () => {
    setOpen(false)
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        className="w-[650px] max-h-[80vh] flex flex-col rounded-lg shadow-2xl"
        style={{ backgroundColor: '#1e1e2e', border: '1px solid #4a4a5a' }}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: '#4a4a5a' }}>
          <span className="text-sm font-medium text-gray-200">管理按钮栏</span>
          <button
            className="text-gray-500 hover:text-gray-300 text-lg leading-none"
            onClick={handleCancel}
          >
            ✕
          </button>
        </div>

        {/* 内容 */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {/* 添加分组按钮 */}
          <button
            className="w-full py-2 text-sm rounded border border-dashed transition-colors"
            style={{ borderColor: '#4a4a5a', color: '#89b4fa' }}
            onClick={handleAddGroup}
          >
            + 添加分组
          </button>

          {localGroups.map((group) => (
            <div key={group.id} className="rounded p-3" style={{ backgroundColor: '#181825', border: '1px solid #3a3a4a' }}>
              {/* 分组头 */}
              <div className="flex items-center gap-2 mb-3">
                <input
                  type="text"
                  value={group.name}
                  onChange={(e) => handleUpdateGroupName(group.id, e.target.value)}
                  placeholder="分组名称"
                  className="flex-1 bg-transparent text-sm text-gray-200 outline-none px-2 py-1 rounded"
                  style={{ border: '1px solid #3a3a4a' }}
                />
                <button
                  className="text-xs px-2 py-1 rounded text-red-400 hover:bg-red-500/20 transition-colors"
                  onClick={() => handleDeleteGroup(group.id)}
                >
                  删除分组
                </button>
              </div>

              {/* 按钮列表 */}
              <div className="space-y-2">
                {group.buttons.length === 0 && (
                  <div className="text-xs text-gray-500 text-center py-2">该分组暂无按钮</div>
                )}
                {group.buttons.map((button, index) => (
                  <div key={button.id} className="flex items-start gap-2">
                    <span className="text-[10px] text-gray-600 w-4 text-right shrink-0 mt-1">{index + 1}</span>
                    <input
                      type="text"
                      value={button.label}
                      onChange={(e) => handleUpdateButton(group.id, button.id, 'label', e.target.value)}
                      placeholder="按钮标签"
                      className="w-28 bg-transparent text-xs text-gray-200 outline-none px-2 py-1 rounded shrink-0"
                      style={{ border: '1px solid #3a3a4a' }}
                    />
                    <textarea
                      value={button.commands.join('\n')}
                      onChange={(e) => handleUpdateButton(group.id, button.id, 'commands', e.target.value.split('\n'))}
                      placeholder="每行一条命令"
                      rows={Math.max(1, Math.min(button.commands.length, 5))}
                      className="flex-1 bg-transparent text-xs font-mono text-gray-200 outline-none px-2 py-1 rounded resize-y min-h-[24px]"
                      style={{ border: '1px solid #3a3a4a' }}
                    />
                    <span className="text-[10px] text-gray-400 shrink-0 mt-1">间隔</span>
                    <input
                      type="number"
                      value={button.delay}
                      onChange={(e) => handleUpdateButton(group.id, button.id, 'delay', parseInt(e.target.value) || 0)}
                      title="多条命令之间的发送间隔(毫秒)"
                      className="w-12 bg-transparent text-xs text-gray-300 outline-none px-0.5 py-1 rounded shrink-0 text-center"
                      style={{ border: '1px solid #3a3a4a' }}
                    />
                    <span className="text-[10px] text-gray-400 shrink-0 mt-1">ms</span>
                    {/* 排序按钮 */}
                    <button
                      className="text-xs px-1.5 py-1 rounded text-gray-500 hover:text-gray-300 hover:bg-[#2a2a3a] disabled:opacity-30"
                      onClick={() => handleMoveButtonUp(group.id, index)}
                      disabled={index === 0}
                      title="上移"
                    >
                      ↑
                    </button>
                    <button
                      className="text-xs px-1.5 py-1 rounded text-gray-500 hover:text-gray-300 hover:bg-[#2a2a3a] disabled:opacity-30"
                      onClick={() => handleMoveButtonDown(group.id, index)}
                      disabled={index >= group.buttons.length - 1}
                      title="下移"
                    >
                      ↓
                    </button>
                    <button
                      className="text-xs px-1.5 py-1 rounded text-red-400 hover:bg-red-500/20 transition-colors"
                      onClick={() => handleDeleteButton(group.id, button.id)}
                      title="删除按钮"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>

              {/* 添加按钮 */}
              <button
                className="mt-2 w-full py-1 text-xs rounded border border-dashed transition-colors"
                style={{ borderColor: '#4a4a5a', color: '#a6e3a1' }}
                onClick={() => handleAddButton(group.id)}
              >
                + 添加按钮
              </button>
            </div>
          ))}
        </div>

        {/* 底部按钮 */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t" style={{ borderColor: '#4a4a5a' }}>
          <button
            className="px-4 py-1.5 text-sm rounded transition-colors text-gray-400 hover:text-gray-200"
            style={{ backgroundColor: '#2a2a3a' }}
            onClick={handleCancel}
          >
            取消
          </button>
          <button
            className="px-4 py-1.5 text-sm rounded transition-colors text-white"
            style={{ backgroundColor: '#3a5a8a' }}
            onClick={handleSave}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

export default ButtonBarManager
