import React from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store'
import { rendererPluginHost } from '@renderer/plugin-host.ts'
import type { SerialConfig, SSHConfig, TelnetConfig, BashConfig, KeyboardLockState } from '@shared/types'

interface TerminalStatusBarProps {
  /** 会话 ID */
  sessionId: string
}

/** 会话状态指示器 */
const StatusDot: React.FC<{ status: string }> = ({ status }) => {
  const colorMap: Record<string, string> = {
    connected: '#a6e3a1',
    connecting: '#f9e2af',
    disconnected: '#585b70',
    error: '#f38ba8'
  }
  const labelMap: Record<string, string> = {
    connected: '已连接',
    connecting: '连接中',
    disconnected: '已断开',
    error: '错误'
  }
  return (
    <span className="flex items-center gap-1">
      <span
        className="inline-block w-1.5 h-1.5 rounded-full"
        style={{ backgroundColor: colorMap[status] || '#585b70' }}
      />
      <span className="text-gray-400">{labelMap[status] || status}</span>
    </span>
  )
}

/** 键盘锁状态指示器 */
const KeyboardLockIndicators: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const keyboardLockStates = useAppStore((state) => state.keyboardLockStates)
  const state = keyboardLockStates[sessionId]

  if (!state) return null

  const indicators: { key: keyof KeyboardLockState; label: string; onColor: string; offColor: string }[] = [
    { key: 'capsLock', label: 'Caps', onColor: '#f9e2af', offColor: '#585b70' },
    { key: 'numLock', label: 'Num', onColor: '#a6e3a1', offColor: '#585b70' },
    { key: 'scrollLock', label: 'Scr', onColor: '#89b4fa', offColor: '#585b70' }
  ]

  return (
    <div className="flex items-center gap-1">
      {indicators.map(({ key, label, onColor }) => (
        <span
          key={key}
          className="px-1 py-0 rounded text-[10px] font-mono font-bold leading-tight"
          style={{
            backgroundColor: state[key] ? `${onColor}22` : 'transparent',
            color: state[key] ? onColor : '#585b70',
            border: `1px solid ${state[key] ? onColor : '#3a3a4a'}`,
            opacity: state[key] ? 1 : 0.5
          }}
        >
          {label}
        </span>
      ))}
    </div>
  )
}

/** 终端状态栏 */
const TerminalStatusBar: React.FC<TerminalStatusBarProps> = ({ sessionId }) => {
  const { sessionStatus, sessionConfig } = useAppStore(
    useShallow((state) => {
      const s = state.sessions.find((s) => s.id === sessionId)
      return { sessionStatus: s?.status, sessionConfig: s?.config }
    })
  )
  const activeTaskCount = useAppStore((state) => {
    const tasks = state.scheduledTasks[sessionId] || []
    return tasks.filter((t) => t.enabled).length
  })

  const pluginItems = rendererPluginHost.collectStatusBarItems(sessionId)

  // 连接信息
  const connectionInfo = sessionConfig
    ? sessionConfig.type === 'serial'
      ? `${(sessionConfig as SerialConfig).path} ${(sessionConfig as SerialConfig).baudRate}bps`
      : sessionConfig.type === 'telnet'
        ? `${(sessionConfig as TelnetConfig).host}:${(sessionConfig as TelnetConfig).port}`
        : sessionConfig.type === 'bash'
          ? `${(sessionConfig as BashConfig).shell || 'auto'}${(sessionConfig as BashConfig).cwd ? ' - ' + (sessionConfig as BashConfig).cwd : ''}`
          : `${(sessionConfig as SSHConfig).username}@${(sessionConfig as SSHConfig).host}:${(sessionConfig as SSHConfig).port}`
    : ''

  // 连接类型标签
  const connectionLabel = sessionConfig
    ? sessionConfig.type === 'serial'
      ? 'SERIAL'
      : sessionConfig.type === 'telnet'
        ? 'TELNET'
        : sessionConfig.type === 'bash'
          ? 'BASH'
          : 'SSH'
    : ''

  return (
    <div
      className="absolute inset-x-0 bottom-0 h-6 flex items-center justify-between px-3 text-xs select-none"
      style={{ backgroundColor: '#1a1a2a', borderTop: '1px solid #3a3a4a' }}
    >
      {/* 左侧：连接类型 + 连接信息 + 会话状态 */}
      <div className="flex items-center gap-3 overflow-hidden">
        <span
          className="px-1 py-0 rounded text-[10px] font-mono font-bold shrink-0"
          style={{
            backgroundColor: sessionConfig?.type === 'ssh' ? '#2a4a6a' : sessionConfig?.type === 'telnet' ? '#4a4a6a' : sessionConfig?.type === 'bash' ? '#6a4a2a' : '#2a5a4a',
            color: sessionConfig?.type === 'ssh' ? '#89b4fa' : sessionConfig?.type === 'telnet' ? '#c5a0fa' : sessionConfig?.type === 'bash' ? '#fab387' : '#a6e3a1'
          }}
        >
          {connectionLabel}
        </span>
        <span className="text-gray-400 truncate max-w-[300px] shrink-0">{connectionInfo}</span>
        {sessionStatus && <StatusDot status={sessionStatus} />}
      </div>

      {/* 右侧：定时任务 + 插件状态栏项 + 键盘锁状态 */}
      <div className="flex items-center gap-1.5 shrink-0">
        {activeTaskCount > 0 && (
          <span
            className="px-1 py-0 rounded text-[10px] font-mono font-bold"
            style={{ backgroundColor: '#4a3a2a', color: '#fab387', border: '1px solid #6a5a4a' }}
          >
            ⏱ {activeTaskCount}
          </span>
        )}
        {pluginItems.map(item => (
          <span
            key={item.pluginId}
            className="px-1 py-0 rounded text-[10px] font-mono font-bold"
            style={item.style}
            title={item.tooltip}
          >
            {item.label}
          </span>
        ))}
        <KeyboardLockIndicators sessionId={sessionId} />
      </div>
    </div>
  )
}

export default TerminalStatusBar
