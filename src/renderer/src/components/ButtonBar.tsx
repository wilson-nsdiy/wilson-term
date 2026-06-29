import React from 'react'
import { useAppStore } from '../store'
import type { CommandButton } from '@shared/types'

/** 延迟工具 */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** 按钮栏组件：位于命令行栏顶部，显示当前分组的命令按钮 */
const ButtonBar: React.FC = () => {
  const visible = useAppStore((state) => state.buttonBarVisible && state.activeSessionId != null)
  const groups = useAppStore((state) => state.commandButtonGroups)
  const activeGroupId = useAppStore((state) => state.activeButtonGroupId)
  const setActiveButtonGroupId = useAppStore((state) => state.setActiveButtonGroupId)
  const activeSessionId = useAppStore((state) => state.activeSessionId)

  const setButtonBarManagerOpen = useAppStore((state) => state.setButtonBarManagerOpen)

  if (!visible) return null

  const activeGroup = groups.find((g) => g.id === activeGroupId)
  const buttons = activeGroup?.buttons ?? []

  /** 点击按钮：逐条发送命令，命令间延迟 */
  const handleButtonClick = async (btn: CommandButton) => {
    if (!activeSessionId) return
    for (const cmd of btn.commands) {
      if (!cmd.trim()) continue
      window.api.connection.write(activeSessionId, cmd + '\r')
      if (btn.delay > 0) await sleep(btn.delay)
    }
  }

  return (
    <div
      className="flex items-center gap-1 select-none overflow-x-auto scrollbar-none"
      style={{
        height: '26px',
        backgroundColor: '#1a1a2a',
        borderTop: '1px solid #3a3a4a'
      }}
    >
      {/* 分组下拉 */}
      {groups.length > 1 && (
        <div className="relative shrink-0 px-1 border-r border-[#3a3a4a] mr-0.5">
          <select
            value={activeGroupId ?? ''}
            onChange={(e) => setActiveButtonGroupId(e.target.value)}
            className="appearance-none bg-transparent text-xs text-gray-300 outline-none pr-3 cursor-pointer"
            style={{ WebkitAppearance: 'none' }}
          >
            {groups.map((group) => (
              <option key={group.id} value={group.id} style={{ backgroundColor: '#2a2a3a', color: '#cdd6f4' }}>
                {group.name}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-gray-500">▼</span>
        </div>
      )}

      {/* 按钮列表 */}
      <div className="flex items-center gap-0.5 px-1">
        {buttons.length === 0 && (
          <span className="text-xs text-gray-400 px-1">无按钮，请点击右侧图标添加</span>
        )}
        {buttons.map((btn) => (
          <button
            key={btn.id}
            className="px-1.5 py-0 text-xs font-mono font-bold rounded transition-colors whitespace-nowrap"
            style={{
              backgroundColor: '#2a2a3a',
              color: '#cdd6f4',
              border: '1px solid #4a4a5a'
            }}
            onClick={() => handleButtonClick(btn)}
            title={`${btn.commands.length > 1 ? '多条命令' : '发送'}: ${btn.commands.join(' | ')}`}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = '#3a3a4a'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = '#2a2a3a'
            }}
          >
            {btn.label}
          </button>
        ))}
      </div>
      {/* 设置按钮 */}
      <div className="ml-auto shrink-0 pr-1">
        <button
          className="px-1 py-0 text-[11px] rounded transition-colors text-gray-500 hover:text-gray-300 hover:bg-[#2a2a3a]"
          onClick={() => setButtonBarManagerOpen(true)}
          title="管理按钮"
        >
          ⚙
        </button>
      </div>
    </div>
  )
}

export default ButtonBar
