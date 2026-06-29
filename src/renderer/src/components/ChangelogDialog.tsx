import React, { useState, useEffect } from 'react'
import type { ChangelogEntry } from '@shared/types'

interface ChangelogDialogProps {
  open: boolean
  onClose: () => void
}

const ChangelogDialog: React.FC<ChangelogDialogProps> = ({ open, onClose }) => {
  const [entries, setEntries] = useState<ChangelogEntry[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (open) {
      setLoading(true)
      window.api.app.getChangelog().then((data) => {
        setEntries(data)
        setLoading(false)
      }).catch(() => {
        setEntries([])
        setLoading(false)
      })
    }
  }, [open])

  if (!open) return null

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div
        className="bg-gray-800 rounded-lg shadow-xl w-[520px] max-h-[70vh] border border-gray-600 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700 shrink-0">
          <h2 className="text-base font-medium text-gray-200">版本更新日志</h2>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-600 text-gray-400 hover:text-white transition-colors"
          >
            ✕
          </button>
        </div>

        {/* 内容 */}
        <div className="px-5 py-4 overflow-y-auto flex-1">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
              <span className="ml-2 text-sm text-gray-400">加载中...</span>
            </div>
          ) : entries.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-8">暂无更新日志</p>
          ) : (
            <div className="space-y-5">
              {entries.map((entry) => (
                <div key={entry.version} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-blue-400">V{entry.version}</span>
                    <span className="text-xs text-gray-500">{entry.date}</span>
                  </div>
                  <ul className="space-y-1 ml-4">
                    {entry.changes.map((change, i) => (
                      <li key={i} className="text-sm text-gray-300 flex items-start gap-2">
                        <span className="text-gray-500 mt-0.5 shrink-0">•</span>
                        <span>{change}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="flex justify-center px-5 py-3 border-t border-gray-700 shrink-0">
          <button
            onClick={onClose}
            className="px-6 py-1.5 bg-blue-600 hover:bg-blue-700 rounded text-sm text-white transition-colors"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}

export default ChangelogDialog
