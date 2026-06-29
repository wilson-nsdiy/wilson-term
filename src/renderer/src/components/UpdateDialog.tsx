import React, { useState, useEffect, useCallback } from 'react'
import type { UpdateCheckResult, ChangelogEntry } from '@shared/types'
import { useAppStore } from '../store'

interface UpdateDialogProps {
  open: boolean
  onClose: () => void
  /** 启动时自动检查模式：直接检查并弹结果，不显示主面板 */
  autoCheck?: boolean
}

/** 检查结果弹窗内容（autoCheck 和手动模式共享） */
const ResultPopup: React.FC<{
  result: UpdateCheckResult
  autoCheck?: boolean
  skipChecked: boolean
  onSkipChange: (checked: boolean) => void
  onClose: () => void
}> = ({ result, autoCheck, skipChecked, onSkipChange, onClose }) => {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30" onClick={onClose}>
      <div className="bg-gray-800 rounded-lg shadow-xl w-[520px] border border-gray-600" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-6 text-center space-y-3">
          {result.hasUpdate ? (
            <>
              <div className="text-3xl">&#127881;</div>
              <p className="text-sm text-green-400 font-medium">发现新版本 V{result.versions?.[0]?.version}</p>
              {result.downloadUrl && (
                <a
                  href={result.downloadUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-blue-400 hover:text-blue-300 underline"
                >
                  下载安装包
                </a>
              )}
              {result.versions && result.versions.length > 0 && (
                <div className="mt-2 max-h-48 overflow-y-auto space-y-3 text-left">
                  {result.versions.map((v) => (
                    <div key={v.version} className="bg-gray-900 rounded p-2.5">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-semibold text-blue-400">V{v.version}</span>
                        {v.date && <span className="text-xs text-gray-500">{v.date}</span>}
                      </div>
                      {v.changes.length > 0 && (
                        <ul className="space-y-0.5">
                          {v.changes.map((c, i) => (
                            <li key={i} className="text-xs text-gray-300 flex items-start gap-1.5">
                              <span className="text-gray-500 shrink-0">•</span>
                              <span>{c}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="text-3xl">&#9989;</div>
              <p className="text-sm text-gray-300">当前已是最新版本 V{result.currentVersion}</p>
            </>
          )}
        </div>
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-700">
          {autoCheck && result.hasUpdate ? (
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" checked={skipChecked} onChange={(e) => onSkipChange(e.target.checked)} className="w-3.5 h-3.5 accent-blue-500" />
              <span className="text-xs text-gray-500">本版本不再提示</span>
            </label>
          ) : (
            <div />
          )}
          <button onClick={onClose} className="px-6 py-1.5 bg-blue-600 hover:bg-blue-700 rounded text-sm text-white transition-colors">
            确定
          </button>
        </div>
      </div>
    </div>
  )
}

const UpdateDialog: React.FC<UpdateDialogProps> = ({ open, onClose, autoCheck }) => {
  const [checking, setChecking] = useState(false)
  const [changelog, setChangelog] = useState<ChangelogEntry[]>([])
  const [logLoading, setLogLoading] = useState(false)
  const [resultPopup, setResultPopup] = useState<UpdateCheckResult | null>(null)
  const [skipChecked, setSkipChecked] = useState(false)
  const setHasNewVersion = useAppStore((state) => state.setHasNewVersion)

  const handleCheck = useCallback(async (manual = false) => {
    setChecking(true)
    try {
      const res = await window.api.app.checkUpdate()
      if (manual) {
        // 手动模式：始终显示结果，同步更新 NEW 标记状态
        setResultPopup(res)
        setSkipChecked(false)
        setHasNewVersion(res.hasUpdate)
      } else if (res.hasUpdate && res.versions && res.versions.length > 0) {
        // 自动模式：检查是否被忽略
        const ignoredVersions = await window.api.app.getIgnoredVersions()
        const latestVersion = res.versions[0].version
        if (!ignoredVersions.includes(latestVersion)) {
          setResultPopup(res)
          setSkipChecked(false)
        }
      }
    } catch {
      // 静默失败
    }
    setChecking(false)
  }, [])

  const handleResultClose = useCallback(() => {
    if (autoCheck && skipChecked && resultPopup?.hasUpdate && resultPopup.versions?.length) {
      const latestVersion = resultPopup.versions[0].version
      window.api.app.getIgnoredVersions().then((ignored) => {
        if (!ignored.includes(latestVersion)) {
          window.api.app.saveIgnoredVersions([...ignored, latestVersion])
        }
      })
    }
    setResultPopup(null)
    if (autoCheck) {
      onClose()
    }
  }, [autoCheck, skipChecked, resultPopup, onClose])

  useEffect(() => {
    if (open) {
      if (autoCheck) {
        handleCheck()
      } else {
        setLogLoading(true)
        window.api.app.getChangelog().then((data) => {
          setChangelog(data)
          setLogLoading(false)
        }).catch(() => {
          setChangelog([])
          setLogLoading(false)
        })
      }
    } else {
      setChangelog([])
      setResultPopup(null)
    }
  }, [open, autoCheck, handleCheck])

  // 自动检查模式：不渲染主面板
  if (autoCheck) {
    if (!resultPopup) return null
    return (
      <ResultPopup
        result={resultPopup}
        autoCheck
        skipChecked={skipChecked}
        onSkipChange={setSkipChecked}
        onClose={handleResultClose}
      />
    )
  }

  if (!open) return null

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose} onKeyDown={handleKeyDown}>
      <div className="bg-gray-800 rounded-lg shadow-xl w-[500px] max-h-[75vh] border border-gray-600 flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700 shrink-0">
          <h2 className="text-base font-medium text-gray-200">检查更新</h2>
          <button onClick={onClose} className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-600 text-gray-400 hover:text-white transition-colors">✕</button>
        </div>

        <div className="overflow-y-auto flex-1">
          <div className="px-5 py-4">
            {logLoading ? (
              <div className="flex items-center justify-center gap-2 py-6">
                <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                <span className="text-sm text-gray-400">加载中...</span>
              </div>
            ) : changelog.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-6">暂无更新日志</p>
            ) : (
              <div className="space-y-4">
                {changelog.map((entry) => (
                  <div key={entry.version} className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-blue-400">V{entry.version}</span>
                      <span className="text-xs text-gray-500">{entry.date}</span>
                    </div>
                    <ul className="space-y-0.5 ml-4">
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
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-gray-700 shrink-0">
          <button onClick={() => handleCheck(true)} disabled={checking} className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded text-sm text-white transition-colors">
            {checking ? '检查中...' : '检查更新'}
          </button>
          <button onClick={onClose} className="px-4 py-1.5 bg-gray-600 hover:bg-gray-500 rounded text-sm text-white transition-colors">关闭</button>
        </div>
      </div>

      {/* 手动模式的检查结果弹窗 */}
      {resultPopup && (
        <ResultPopup
          result={resultPopup}
          onClose={() => setResultPopup(null)}
        />
      )}
    </div>
  )
}

export default UpdateDialog
