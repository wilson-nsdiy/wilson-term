import React, { useState, useRef, useEffect } from 'react'
import type { ScheduledTask } from '@shared/types'

/** 生成唯一 ID */
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2)
}

interface ScheduledTaskEditorProps {
  tasks: ScheduledTask[]
  onChange: (tasks: ScheduledTask[]) => void
  disabled?: boolean
}

const ScheduledTaskEditor: React.FC<ScheduledTaskEditorProps> = ({ tasks, onChange, disabled }) => {
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
    if (!name.trim() || !command.trim()) return
    if (formTaskId === '') {
      const task: ScheduledTask = {
        id: generateId(),
        sessionId: '',
        name: name.trim(),
        command: command.trim(),
        interval: Math.max(1, interval),
        enabled: true,
        sendEnter,
        repeatCount: Math.max(0, repeatCount),
        executedCount: 0
      }
      onChange([...tasks, task])
    } else {
      onChange(tasks.map((t) =>
        t.id === formTaskId
          ? { ...t, name: name.trim(), command: command.trim(), interval: Math.max(1, interval), sendEnter, repeatCount: Math.max(0, repeatCount) }
          : t
      ))
    }
    resetForm()
  }

  useEffect(() => {
    if (isFormOpen) {
      requestAnimationFrame(() => nameInputRef.current?.focus())
    }
  }, [formTaskId])

  const inputClass = 'w-full px-2.5 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-gray-200 focus:outline-none focus:border-blue-500'
  const labelClass = 'block text-xs text-gray-400 mb-1'

  return (
    <div className="relative">
      <div className="space-y-2">
        {tasks.length === 0 && !isFormOpen && (
          <div className="text-center py-4 text-gray-500 text-xs">
            暂无定时任务
          </div>
        )}
        {tasks.map((task, index) => (
          <div
            key={task.id}
            className="bg-gray-700/50 rounded border border-gray-600 p-2"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-sm text-gray-200 font-medium truncate">{task.name}</div>
                <div className="text-xs text-gray-400 truncate font-mono">{task.command}</div>
                <div className="text-xs text-gray-500">
                  每 {task.interval}秒
                  {task.repeatCount > 0 ? ` · ${task.repeatCount}次` : ' · 无限'}
                  {!task.sendEnter && <span className="text-yellow-500"> · 无回车</span>}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => {
                    if (disabled) return
                    const updated = [...tasks]
                    if (index > 0) {
                      ;[updated[index - 1], updated[index]] = [updated[index], updated[index - 1]]
                      onChange(updated)
                    }
                  }}
                  disabled={disabled || index === 0}
                  className="w-5 h-5 flex items-center justify-center rounded hover:bg-gray-600 text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-xs"
                  title="上移"
                >
                  ↑
                </button>
                <button
                  onClick={() => {
                    if (disabled) return
                    const updated = [...tasks]
                    if (index < updated.length - 1) {
                      ;[updated[index], updated[index + 1]] = [updated[index + 1], updated[index]]
                      onChange(updated)
                    }
                  }}
                  disabled={disabled || index === tasks.length - 1}
                  className="w-5 h-5 flex items-center justify-center rounded hover:bg-gray-600 text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-xs"
                  title="下移"
                >
                  ↓
                </button>
                <button
                  onClick={() => !disabled && openEditForm(task)}
                  disabled={disabled}
                  className="w-5 h-5 flex items-center justify-center rounded hover:bg-gray-600 text-gray-400 hover:text-blue-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-xs"
                  title="编辑"
                >
                  ✎
                </button>
                <button
                  onClick={() => {
                    if (disabled) return
                    onChange(tasks.filter((t) => t.id !== task.id))
                  }}
                  disabled={disabled}
                  className="w-5 h-5 flex items-center justify-center rounded hover:bg-gray-600 text-gray-400 hover:text-red-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-xs"
                  title="删除"
                >
                  ✕
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {!isFormOpen && (
        <button
          onClick={openAddForm}
          disabled={disabled}
          className="mt-2 px-2.5 py-1 bg-gray-700 hover:bg-gray-600 rounded text-xs text-gray-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          + 添加任务
        </button>
      )}

      {/* 编辑/添加弹窗 */}
      {isFormOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50">
          <div
            className="bg-gray-800 rounded-lg shadow-xl w-[400px] border border-gray-600"
          >
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

export default ScheduledTaskEditor
