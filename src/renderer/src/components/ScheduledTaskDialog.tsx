import React, { useState, useEffect, useRef } from 'react'
import { useAppStore } from '../store'
import type { ScheduledTask } from '@shared/types'

/** 生成唯一 ID */
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2)
}

interface ScheduledTaskDialogProps {
  open: boolean
  onClose: () => void
}

const ScheduledTaskDialog: React.FC<ScheduledTaskDialogProps> = ({ open, onClose }) => {
  const activeSessionId = useAppStore((state) => state.activeSessionId)
  const sessions = useAppStore((state) => state.sessions)
  const allScheduledTasks = useAppStore((state) => state.scheduledTasks)
  const addScheduledTask = useAppStore((state) => state.addScheduledTask)
  const removeScheduledTask = useAppStore((state) => state.removeScheduledTask)
  const updateScheduledTask = useAppStore((state) => state.updateScheduledTask)
  const moveScheduledTaskUp = useAppStore((state) => state.moveScheduledTaskUp)
  const moveScheduledTaskDown = useAppStore((state) => state.moveScheduledTaskDown)

  // 当前激活终端的任务列表
  const scheduledTasks = activeSessionId ? (allScheduledTasks[activeSessionId] || []) : []

  const activeSession = activeSessionId ? sessions.find((s) => s.id === activeSessionId) : null

  /** null=隐藏, ''=新增, 其他=编辑对应 ID */
  const [formTaskId, setFormTaskId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [interval, setInterval] = useState(60)
  const [repeatCount, setRepeatCount] = useState(0)
  const [sendEnter, setSendEnter] = useState(true)

  const nameInputRef = useRef<HTMLInputElement>(null)

  const isFormOpen = formTaskId !== null

  const resetForm = () => {
    setFormTaskId(null)
    setName('')
    setCommand('')
    setInterval(60)
    setRepeatCount(0)
    setSendEnter(true)
  }

  const openAddForm = () => {
    setFormTaskId('')
    setName('')
    setCommand('')
    setInterval(60)
    setRepeatCount(0)
    setSendEnter(true)
  }

  const openEditForm = (task: ScheduledTask) => {
    setFormTaskId(task.id)
    setName(task.name)
    setCommand(task.command)
    setInterval(task.interval)
    setRepeatCount(task.repeatCount)
    setSendEnter(task.sendEnter)
  }

  const handleSave = () => {
    if (!name.trim() || !command.trim() || !activeSessionId) return
    if (formTaskId === '') {
      const task: ScheduledTask = {
        id: generateId(),
        sessionId: activeSessionId,
        name: name.trim(),
        command: command.trim(),
        interval: Math.max(1, interval),
        enabled: true,
        sendEnter,
        repeatCount: Math.max(0, repeatCount),
        executedCount: 0
      }
      addScheduledTask(activeSessionId, task)
    } else {
      updateScheduledTask(activeSessionId, formTaskId, {
        name: name.trim(),
        command: command.trim(),
        interval: Math.max(1, interval),
        sendEnter,
        repeatCount: Math.max(0, repeatCount)
      })
    }
    resetForm()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (isFormOpen) {
        resetForm()
      } else {
        onClose()
      }
    }
  }

  useEffect(() => {
    if (isFormOpen) {
      requestAnimationFrame(() => nameInputRef.current?.focus())
    }
  }, [formTaskId])

  if (!open) return null

  const inputClass = 'w-full px-2.5 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-gray-200 focus:outline-none focus:border-blue-500'
  const labelClass = 'block text-xs text-gray-400 mb-1'

  /** 获取会话显示名称 */
  const getSessionLabel = () => {
    if (!activeSession) return '无终端'
    const c = activeSession.config
    if (c.type === 'ssh') return `${c.username}@${c.host}:${c.port}`
    if (c.type === 'telnet') return `Telnet ${c.host}:${c.port}`
    if (c.type === 'serial') return `${c.path} (${c.baudRate})`
    return '未知'
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={isFormOpen ? undefined : onClose}
      onKeyDown={handleKeyDown}
    >
      {/* 主对话框 */}
      <div
        className="bg-gray-800 rounded-lg shadow-xl w-[520px] max-h-[80vh] border border-gray-600 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700 shrink-0">
          <h2 className="text-base font-medium text-gray-200">定时任务</h2>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-600 text-gray-400 hover:text-white transition-colors"
          >
            ✕
          </button>
        </div>

        {/* 提示：当前激活终端 */}
        <div className="px-5 py-2 text-xs text-gray-500 border-b border-gray-700/50 bg-gray-750 shrink-0">
          当前终端: {activeSessionId ? (
            <span className="text-gray-400">{getSessionLabel()}</span>
          ) : (
            <span className="text-yellow-500">无激活终端</span>
          )}
        </div>

        {/* 任务列表 */}
        <div className="flex-1 overflow-y-auto px-5 py-3 min-h-0" style={{ maxHeight: '400px' }}>
          {!activeSessionId ? (
            <div className="text-center py-10 text-gray-500 text-sm">
              请先选择一个终端标签页
            </div>
          ) : scheduledTasks.length === 0 ? (
            <div className="text-center py-10 text-gray-500 text-sm">
              暂无定时任务
              <div className="mt-2">
                <button
                  onClick={openAddForm}
                  className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 rounded text-sm text-white transition-colors"
                >
                  添加任务
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {scheduledTasks.map((task, index) => (
                <div
                  key={task.id}
                  className="bg-gray-700/50 rounded border border-gray-600 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${task.enabled ? 'bg-green-500' : 'bg-gray-500'}`}
                        />
                        <span className="text-sm text-gray-200 font-medium truncate">{task.name}</span>
                      </div>
                      <div className="mt-1 text-xs text-gray-400 space-y-0.5">
                        <div className="truncate font-mono">{task.command}</div>
                        <div>
                          每 {task.interval}秒 执行一次
                          {task.repeatCount > 0 ? `（共 ${task.repeatCount} 次）` : '（无限循环）'}
                          {!task.sendEnter && <span className="text-yellow-500"> · 不发送回车</span>}
                          {task.executedCount > 0 && (
                            <span className="text-blue-400"> · 已执行 {task.executedCount} 次</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => moveScheduledTaskUp(activeSessionId, task.id)}
                        disabled={index === 0}
                        className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-600 text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        title="上移"
                      >
                        ↑
                      </button>
                      <button
                        onClick={() => moveScheduledTaskDown(activeSessionId, task.id)}
                        disabled={index === scheduledTasks.length - 1}
                        className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-600 text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        title="下移"
                      >
                        ↓
                      </button>
                      <button
                        onClick={() => openEditForm(task)}
                        className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-600 text-gray-400 hover:text-blue-400 transition-colors"
                        title="编辑"
                      >
                        ✎
                      </button>
                      <button
                        onClick={() => updateScheduledTask(activeSessionId, task.id, { enabled: !task.enabled })}
                        className={`w-6 h-6 flex items-center justify-center rounded hover:bg-gray-600 transition-colors ${
                          task.enabled ? 'text-green-400 hover:text-green-300' : 'text-gray-500 hover:text-gray-300'
                        }`}
                        title={task.enabled ? '暂停' : '启用'}
                      >
                        {task.enabled ? '▶' : '⏸'}
                      </button>
                      <button
                        onClick={() => {
                          if (confirm(`确定删除定时任务「${task.name}」？`)) {
                            removeScheduledTask(activeSessionId, task.id)
                          }
                        }}
                        className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-600 text-gray-400 hover:text-red-400 transition-colors"
                        title="删除"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-gray-700 shrink-0">
          <span className="text-xs text-gray-500">
            定时任务绑定到当前终端
            {!activeSessionId && <span className="text-yellow-500">（当前无激活终端）</span>}
          </span>
          <div className="flex gap-2">
            <button
              onClick={openAddForm}
              disabled={!activeSessionId}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 rounded text-sm text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              添加任务
            </button>
            <button
              onClick={onClose}
              className="px-4 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm text-gray-300 transition-colors"
            >
              关闭
            </button>
          </div>
        </div>
      </div>

      {/* 编辑/添加弹窗（独立遮罩层） */}
      {isFormOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
        >
          <div
            className="bg-gray-800 rounded-lg shadow-xl w-[440px] border border-gray-600"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 标题栏 */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700">
              <h3 className="text-sm font-medium text-gray-200">
                {formTaskId === '' ? '添加任务' : '编辑任务'}
              </h3>
              <button
                onClick={resetForm}
                className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-600 text-gray-400 hover:text-white transition-colors"
              >
                ✕
              </button>
            </div>

            {/* 表单内容 */}
            <div className="px-5 py-4 space-y-3">
              <div>
                <label className={labelClass}>任务名称</label>
                <input
                  ref={nameInputRef}
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={inputClass}
                  placeholder="例如: 发送心跳包"
                />
              </div>
              <div>
                <label className={labelClass}>发送命令</label>
                <input
                  type="text"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  className={inputClass + ' font-mono'}
                  placeholder="例如: ping 192.168.1.1 -n 1"
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSave() }}
                />
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className={labelClass}>间隔（秒）</label>
                  <input
                    type="number"
                    value={interval}
                    onChange={(e) => setInterval(Math.max(1, Number(e.target.value) || 60))}
                    className={inputClass}
                    min={1}
                  />
                </div>
                <div className="flex-1">
                  <label className={labelClass}>循环次数（0=无限）</label>
                  <input
                    type="number"
                    value={repeatCount}
                    onChange={(e) => setRepeatCount(Math.max(0, Number(e.target.value) || 0))}
                    className={inputClass}
                    min={0}
                  />
                </div>
              </div>
              <label className="flex items-center gap-2.5 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={sendEnter}
                  onChange={(e) => setSendEnter(e.target.checked)}
                  className="w-4 h-4 rounded border-gray-500 bg-gray-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-0 cursor-pointer"
                />
                <span className="text-sm text-gray-300 group-hover:text-gray-200 transition-colors select-none">
                  自动输入回车
                </span>
              </label>
            </div>

            {/* 底部按钮 */}
            <div className="flex gap-2 justify-end px-5 py-3 border-t border-gray-700">
              <button
                onClick={resetForm}
                className="px-4 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm text-gray-300 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleSave}
                disabled={!name.trim() || !command.trim()}
                className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 rounded text-sm text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {formTaskId === '' ? '添加' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ScheduledTaskDialog
