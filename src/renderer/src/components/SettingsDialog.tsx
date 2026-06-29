import React, { useState, useEffect } from 'react'
import { useAppStore } from '../store'
import LogConfigSection from './LogConfigSection'
import type { LogConfig } from '@shared/types'
import { createLogConfigFromSettings } from '../utils/logConfig'

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
}

const SettingsDialog: React.FC<SettingsDialogProps> = ({ open, onClose }) => {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)

  const [logConfig, setLogConfig] = useState<LogConfig>(createLogConfigFromSettings(settings))

  useEffect(() => {
    if (open) {
      setLogConfig(createLogConfigFromSettings(settings))
    }
  }, [open, settings])

  const handleSave = () => {
    updateSettings({
      logEnabled: logConfig.logEnabled,
      logPath: logConfig.logPath,
      logWithTimestamp: logConfig.logWithTimestamp,
      logSplitBySize: logConfig.logSplitBySize,
      logSplitByTime: logConfig.logSplitByTime,
      logMaxSize: logConfig.logMaxSize
    })
    onClose()
  }

  const handleClose = () => {
    setLogConfig(createLogConfigFromSettings(settings))
    onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      handleClose()
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={handleClose}
      onKeyDown={handleKeyDown}
    >
      <div
        className="bg-gray-800 rounded-lg shadow-xl w-[520px] border border-gray-600"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700">
          <h2 className="text-base font-medium text-gray-200">⚙️ 设置</h2>
          <button
            onClick={handleClose}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-600 text-gray-400 hover:text-white transition-colors"
          >
            ✕
          </button>
        </div>

        {/* 表单内容 */}
        <div className="px-5 py-4 space-y-6">
          {/* 日志设置分组 */}
          <div>
            <h3 className="text-sm font-medium text-gray-300 mb-3">📝 日志设置</h3>
            <LogConfigSection value={logConfig} onChange={setLogConfig} />
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="flex justify-end gap-3 px-5 py-3 border-t border-gray-700">
          <button
            onClick={handleClose}
            className="px-4 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm text-gray-300 transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 rounded text-sm text-white transition-colors"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

export default SettingsDialog
