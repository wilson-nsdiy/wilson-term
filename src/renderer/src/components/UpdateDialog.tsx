import React, { useState, useEffect, useCallback, useRef } from 'react'
import type { UpdateStatusSnapshot } from '@shared/types'
import { useAppStore } from '../store'

interface UpdateDialogProps {
  open: boolean
  onClose: () => void
}

const UpdateDialog: React.FC<UpdateDialogProps> = ({ open, onClose }) => {
  const [snapshot, setSnapshot] = useState<UpdateStatusSnapshot | null>(null)
  const setHasNewVersion = useAppStore((state) => state.setHasNewVersion)
  const unsubRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (open) {
      unsubRef.current = window.api.app.onUpdateStatusChanged((s) => {
        setSnapshot(s)
        setHasNewVersion(s.status === 'available' || s.status === 'downloading' || s.status === 'downloaded')
      })

      window.api.app.getUpdateStatus().then((s) => {
        setSnapshot(s)
        if (s.status === 'idle') {
          window.api.app.checkUpdate(true)
        }
      })
    } else {
      if (unsubRef.current) {
        unsubRef.current()
        unsubRef.current = null
      }
      setSnapshot(null)
    }

    return () => {
      if (unsubRef.current) {
        unsubRef.current()
        unsubRef.current = null
      }
    }
  }, [open, setHasNewVersion])

  const handleCheck = useCallback(() => {
    window.api.app.checkUpdate(true)
  }, [])

  // 关闭对话框：若正在下载，先终止下载流程再关闭
  const handleClose = useCallback(() => {
    if (snapshot?.status === 'downloading') {
      window.api.app.cancelDownloadUpdate()
    }
    onClose()
  }, [snapshot?.status, onClose])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') handleClose()
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={handleClose} onKeyDown={handleKeyDown}>
      <div className="bg-gray-800 rounded-lg shadow-xl w-[500px] max-h-[75vh] border border-gray-600 flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700 shrink-0">
          <h2 className="text-base font-medium text-gray-200">检查更新</h2>
          <button onClick={handleClose} className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-600 text-gray-400 hover:text-white transition-colors">✕</button>
        </div>

        <div className="overflow-y-auto flex-1">
          <div className="px-5 py-4">
            {snapshot?.info && (snapshot.status === 'available' || snapshot.status === 'downloading' || snapshot.status === 'downloaded') && (
              <div className="space-y-3 mb-4">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-blue-400">V{snapshot.info.version}</span>
                  {snapshot.info.releaseDate && (
                    <span className="text-xs text-gray-500">{snapshot.info.releaseDate.split('T')[0]}</span>
                  )}
                </div>
                {snapshot.status === 'downloading' && snapshot.progress && (
                  <div>
                    <div className="w-full bg-gray-700 rounded-full h-2">
                      <div
                        className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                        style={{ width: `${snapshot.progress.percent}%` }}
                      />
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      {snapshot.progress.percent.toFixed(1)}% — {Math.round(snapshot.progress.bytesPerSecond / 1024 / 1024)} MB/s
                    </p>
                  </div>
                )}
                {snapshot.info.releaseNotes && (
                  <div className="bg-gray-900 rounded p-2.5">
                    <p className="text-xs font-medium text-gray-400 mb-1">更新内容</p>
                    <div className="max-h-60 overflow-y-auto">
                      <p className="text-xs text-gray-300 whitespace-pre-wrap">{snapshot.info.releaseNotes}</p>
                    </div>
                  </div>
                )}
                {snapshot.status === 'downloaded' && (
                  <div className="flex items-center gap-2 text-sm text-green-400">
                    <span>✓</span>
                    <span>更新已下载完成，可立即安装</span>
                  </div>
                )}
              </div>
            )}
            {snapshot?.status === 'not-available' && (
              <p className="text-sm text-gray-400 text-center py-4">当前已是最新版本</p>
            )}
            {snapshot?.status === 'error' && (
              <div className="text-center py-4">
                <p className="text-sm text-red-400">检查更新失败</p>
                {snapshot.error && <p className="text-xs text-gray-500 mt-1">{snapshot.error}</p>}
              </div>
            )}
            {!snapshot && (
              <p className="text-sm text-gray-500 text-center py-4">点击"检查更新"获取最新版本信息</p>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-gray-700 shrink-0">
          {snapshot?.status === 'available' && (
            <button onClick={() => window.api.app.downloadUpdate()} className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 rounded text-sm text-white transition-colors">
              下载更新
            </button>
          )}
          {snapshot?.status === 'downloaded' && (
            <button onClick={() => window.api.app.installUpdate()} className="px-4 py-1.5 bg-green-600 hover:bg-green-700 rounded text-sm text-white transition-colors">
              安装并重启
            </button>
          )}
          {snapshot?.status === 'downloading' && (
            <button onClick={() => window.api.app.cancelDownloadUpdate()} className="px-4 py-1.5 bg-gray-600 hover:bg-gray-500 rounded text-sm text-white transition-colors">
              取消下载
            </button>
          )}
          {(!snapshot || !['available', 'downloading', 'downloaded'].includes(snapshot.status)) && (
            <button onClick={handleCheck} disabled={snapshot?.status === 'checking'} className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded text-sm text-white transition-colors">
              {snapshot?.status === 'checking' ? '检查中...' : '检查更新'}
            </button>
          )}
          <button onClick={handleClose} className="px-4 py-1.5 bg-gray-600 hover:bg-gray-500 rounded text-sm text-white transition-colors">关闭</button>
        </div>
      </div>
    </div>
  )
}

export default UpdateDialog
