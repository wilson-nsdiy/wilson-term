import React, { useState } from 'react'
import { useAppStore } from '../store'
import type { Profile, ProfileOverrides, ConnectionType } from '@shared/types'

interface ProfileManagerProps {
  open: boolean
  onClose: () => void
  /** 嵌入模式：不渲染外层模态框，只渲染内容 */
  embedded?: boolean
}

const inputClass = 'w-full px-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors'

const overrideFields: { key: keyof ProfileOverrides; label: string; type: 'number' | 'text' | 'select' | 'checkbox'; options?: string[] }[] = [
  { key: 'fontSize', label: '字体大小', type: 'number' },
  { key: 'fontFamily', label: '字体', type: 'text' },
  { key: 'background', label: '背景色', type: 'text' },
  { key: 'foreground', label: '前景色', type: 'text' },
  { key: 'cursorStyle', label: '光标样式', type: 'select', options: ['block', 'underline', 'bar'] },
  { key: 'cursorBlink', label: '光标闪烁', type: 'checkbox' },
  { key: 'scrollback', label: '滚动缓冲', type: 'number' },
  { key: 'logEnabled', label: '启用日志', type: 'checkbox' },
  { key: 'logPath', label: '日志路径', type: 'text' },
  { key: 'logWithTimestamp', label: '时间戳', type: 'checkbox' },
  { key: 'logSplitBySize', label: '按大小分割', type: 'checkbox' },
  { key: 'logSplitByTime', label: '按时间分割', type: 'checkbox' },
  { key: 'logMaxSize', label: '分割大小', type: 'number' },
  { key: 'rightClickPaste', label: '右键粘贴', type: 'checkbox' },
  { key: 'trimPaste', label: '粘贴去尾空白', type: 'checkbox' },
  { key: 'multiLinePasteWarning', label: '多行粘贴警告', type: 'select', options: ['always', 'auto', 'never'] },
]

const ProfileManager: React.FC<ProfileManagerProps> = ({ open, onClose, embedded }) => {
  const profiles = useAppStore((s) => s.profiles)
  const addProfile = useAppStore((s) => s.addProfile)
  const updateProfile = useAppStore((s) => s.updateProfile)
  const removeProfile = useAppStore((s) => s.removeProfile)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editAppliesTo, setEditAppliesTo] = useState<ConnectionType[]>([])
  const [editOverrides, setEditOverrides] = useState<Partial<ProfileOverrides>>({})

  if (!open) return null

  const startCreate = () => {
    setEditingId('__new__')
    setEditName('')
    setEditAppliesTo([])
    setEditOverrides({})
  }

  const startEdit = (p: Profile) => {
    setEditingId(p.id)
    setEditName(p.name)
    setEditAppliesTo([...p.appliesTo])
    setEditOverrides({ ...p.overrides })
  }

  const toggleAppliesTo = (t: ConnectionType) => {
    setEditAppliesTo((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]
    )
  }

  const save = () => {
    if (!editName.trim()) return
    if (editingId === '__new__') {
      addProfile(editName, editAppliesTo, editOverrides)
    } else if (editingId) {
      updateProfile(editingId, { name: editName, appliesTo: editAppliesTo, overrides: editOverrides })
    }
    setEditingId(null)
  }

  const renderOverrideField = (key: keyof ProfileOverrides, label: string, type: string, options?: string[]) => {
    const value = editOverrides[key]
    if (type === 'checkbox') {
      return (
        <label key={key} className="flex items-center gap-2 text-sm text-gray-300">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(e) => setEditOverrides((prev) => ({ ...prev, [key]: e.target.checked }))}
            className="rounded bg-gray-700 border-gray-600"
          />
          {label}
        </label>
      )
    }
    if (type === 'select' && options) {
      return (
        <div key={key} className="flex items-center gap-2">
          <span className="text-sm text-gray-400 w-24">{label}</span>
          <select
            value={(value as string) ?? ''}
            onChange={(e) => setEditOverrides((prev) => ({ ...prev, [key]: e.target.value || undefined }))}
            className={inputClass}
          >
            <option value="">默认</option>
            {options.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
      )
    }
    return (
      <div key={key} className="flex items-center gap-2">
        <span className="text-sm text-gray-400 w-24">{label}</span>
        <input
          type={type}
          value={(value as any) ?? ''}
          onChange={(e) => setEditOverrides((prev) => ({ ...prev, [key]: type === 'number' ? (e.target.value ? Number(e.target.value) : undefined) : (e.target.value || undefined) }))}
          className={inputClass}
          placeholder="默认"
        />
      </div>
    )
  }

  const content = (
    <div className="space-y-3">
      {profiles.map((p) => (
        <div key={p.id} className="bg-gray-750 rounded-lg p-3 border border-gray-700">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-gray-100 font-medium">{p.name}</span>
              <span className="ml-2 text-xs text-gray-500">
                {p.appliesTo.length === 0 ? '所有类型' : p.appliesTo.join('/')}
              </span>
            </div>
            <div className="flex gap-2">
              <button onClick={() => startEdit(p)} className="text-xs text-blue-400 hover:text-blue-300">编辑</button>
              <button onClick={() => removeProfile(p.id)} className="text-xs text-red-400 hover:text-red-300">删除</button>
            </div>
          </div>
          {Object.keys(p.overrides).length > 0 && (
            <div className="mt-1 text-xs text-gray-500">
              覆盖: {Object.keys(p.overrides).join(', ')}
            </div>
          )}
        </div>
      ))}

      {editingId && (
        <div className="bg-gray-900 rounded-lg p-4 border border-blue-500/30 space-y-3">
          <input
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            placeholder="模板名称"
            className={inputClass}
          />
          <div className="flex gap-4 text-sm text-gray-300">
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={editAppliesTo.length === 0} onChange={() => setEditAppliesTo([])} /> 所有
            </label>
            {(['ssh', 'telnet', 'serial', 'bash'] as ConnectionType[]).map((t) => (
              <label key={t} className="flex items-center gap-1">
                <input type="checkbox" checked={editAppliesTo.includes(t)} onChange={() => toggleAppliesTo(t)} /> {t.toUpperCase()}
              </label>
            ))}
          </div>
          <div className="space-y-2">
            {overrideFields.map((f) => renderOverrideField(f.key, f.label, f.type, f.options))}
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setEditingId(null)} className="px-3 py-1 text-sm text-gray-400 hover:text-gray-200">取消</button>
            <button onClick={save} className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-500">保存</button>
          </div>
        </div>
      )}

      {!editingId && (
        <button onClick={startCreate} className="w-full py-2 text-sm text-blue-400 hover:text-blue-300 border border-dashed border-gray-600 rounded-lg">
          + 新建模板
        </button>
      )}
    </div>
  )

  if (embedded) return content

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-gray-800 rounded-lg shadow-xl w-[560px] max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <h2 className="text-lg font-semibold text-gray-100">配置模板</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-200 text-xl">&times;</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {content}
        </div>
      </div>
    </div>
  )
}

export default ProfileManager
