import React, { useEffect, useRef, useState } from 'react'
import type { UpdateStatusSnapshot } from '@shared/types'
import { useAppStore } from '../store'

const AUTO_DISMISS_MS = 4000

const UpdateToast: React.FC = () => {
  const [snapshot, setSnapshot] = useState<UpdateStatusSnapshot | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const updateDialogOpen = useAppStore((s) => s.updateDialogOpen)
  const setHasNewVersion = useAppStore((s) => s.setHasNewVersion)
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const unsub = window.api.app.onUpdateStatusChanged((s) => {
      setSnapshot(s)
      setDismissed(false)
      setHasNewVersion(s.status === 'available' || s.status === 'downloading' || s.status === 'downloaded')

      if (s.status === 'not-available' || s.status === 'error') {
        if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
        dismissTimerRef.current = setTimeout(() => setDismissed(true), AUTO_DISMISS_MS)
      } else {
        if (dismissTimerRef.current) {
          clearTimeout(dismissTimerRef.current)
          dismissTimerRef.current = null
        }
      }
    })
    return () => {
      unsub()
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
    }
  }, [setHasNewVersion])

  if (!snapshot || dismissed) return null
  if (updateDialogOpen) return null

  const status = snapshot.status
  if (status !== 'available' && status !== 'downloading' && status !== 'downloaded' && status !== 'not-available' && status !== 'error') {
    return null
  }

  const handleDownload = () => window.api.app.downloadUpdate()
  const handleInstall = () => window.api.app.installUpdate()
  const handleCancelAutoInstall = () => window.api.app.cancelAutoInstall()
  const handleDismiss = () => setDismissed(true)
  const handleSkipVersion = () => {
    if (snapshot.info?.version) {
      window.api.app.getIgnoredVersions().then((ignored) => {
        if (!ignored.includes(snapshot.info!.version)) {
          window.api.app.saveIgnoredVersions([...ignored, snapshot.info!.version])
        }
      })
    }
    setDismissed(true)
  }

  const accentColor =
    status === 'available' ? 'border-blue-500/40'
    : status === 'downloading' ? 'border-blue-500/40'
    : status === 'downloaded' ? 'border-green-500/40'
    : status === 'error' ? 'border-red-500/40'
    : 'border-gray-600'

  return (
    <div className="fixed bottom-4 right-4 z-[60] w-80 pointer-events-auto">
      <div className={`bg-gray-800 rounded-lg shadow-2xl border ${accentColor} overflow-hidden`}>
        {/* 顶部状态行 */}
        <div className="px-4 py-3 flex items-start gap-3">
          <div className="text-2xl leading-none mt-0.5">
            {status === 'available' && '\u{1F389}'}
            {status === 'downloading' && '\u{1F4E4}'}
            {status === 'downloaded' && '\u{1F680}'}
            {status === 'not-available' && '✅'}
            {status === 'error' && '❌'}
          </div>
          <div className="flex-1 min-w-0">
            {status === 'available' && (
              <>
                <p className="text-sm text-gray-100 font-medium">发现新版本 V{snapshot.info?.version}</p>
                {snapshot.info?.releaseDate && (
                  <p className="text-xs text-gray-500 mt-0.5">{snapshot.info.releaseDate.split('T')[0]}</p>
                )}
              </>
            )}
            {status === 'downloading' && (
              <p className="text-sm text-gray-100 font-medium">正在下载 V{snapshot.info?.version}</p>
            )}
            {status === 'downloaded' && (
              <p className="text-sm text-green-400 font-medium">V{snapshot.info?.version} 已就绪</p>
            )}
            {status === 'not-available' && (
              <p className="text-sm text-gray-300">当前已是最新版本</p>
            )}
            {status === 'error' && (
              <>
                <p className="text-sm text-red-400 font-medium">检查更新失败</p>
                {snapshot.error && <p className="text-xs text-gray-500 mt-0.5 truncate">{snapshot.error}</p>}
              </>
            )}
          </div>
          {(status === 'available' || status === 'not-available' || status === 'error') && (
            <button
              onClick={handleDismiss}
              className="text-gray-500 hover:text-gray-300 transition-colors -mt-1 -mr-1 p-1"
              aria-label="关闭"
            >
              ✕
            </button>
          )}
        </div>

        {/* 下载进度条 */}
        {status === 'downloading' && snapshot.progress && (
          <div className="px-4 pb-3">
            <div className="w-full bg-gray-700 rounded-full h-1.5">
              <div
                className="bg-blue-500 h-1.5 rounded-full transition-all duration-300"
                style={{ width: `${snapshot.progress.percent || 0}%` }}
              />
            </div>
            <p className="text-xs text-gray-500 mt-1.5">
              {snapshot.progress.percent.toFixed(1)}% — {Math.round((snapshot.progress.bytesPerSecond || 0) / 1024 / 1024)} MB/s
            </p>
          </div>
        )}

        {/* 下载完成倒计时 */}
        {status === 'downloaded' && snapshot.autoInstallCountdown != null && snapshot.autoInstallCountdown > 0 && (
          <div className="px-4 pb-3">
            <p className="text-xs text-yellow-400">{snapshot.autoInstallCountdown} 秒后自动安装重启</p>
          </div>
        )}

        {/* 操作按钮 */}
        <div className="flex justify-end gap-2 px-4 py-2.5 bg-gray-900/40 border-t border-gray-700/50">
          {status === 'available' && (
            <>
              <button
                onClick={handleSkipVersion}
                className="px-3 py-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
              >
                跳过此版本
              </button>
              <button
                onClick={handleDismiss}
                className="px-3 py-1 text-xs text-gray-400 hover:text-gray-200 transition-colors"
              >
                稍后
              </button>
              <button
                onClick={handleDownload}
                className="px-3 py-1 bg-blue-600 hover:bg-blue-700 rounded text-xs text-white transition-colors"
              >
                下载更新
              </button>
            </>
          )}
          {status === 'downloaded' && (
            <>
              {snapshot.autoInstallCountdown != null && snapshot.autoInstallCountdown > 0 && (
                <button
                  onClick={handleCancelAutoInstall}
                  className="px-3 py-1 text-xs text-gray-400 hover:text-gray-200 transition-colors"
                >
                  稍后安装
                </button>
              )}
              <button
                onClick={handleInstall}
                className="px-3 py-1 bg-green-600 hover:bg-green-700 rounded text-xs text-white transition-colors"
              >
                立即安装并重启
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export default UpdateToast
