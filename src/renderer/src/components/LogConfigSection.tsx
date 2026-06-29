import React, { useEffect, useRef } from 'react'
import type { LogConfig } from '@shared/types'

interface LogConfigSectionProps {
  /** 当前日志配置 */
  value: LogConfig
  /** 配置变更回调 */
  onChange: (logConfig: LogConfig) => void
}

const LogConfigSection: React.FC<LogConfigSectionProps> = ({ value, onChange }) => {
  /** 默认日志目录缓存 */
  const defaultDirRef = useRef<string | null>(null)
  /** 获取默认日志目录 */
  const getDefaultDir = async (): Promise<string> => {
    if (!defaultDirRef.current) {
      defaultDirRef.current = await window.api.log.getDefaultLogDir()
    }
    return defaultDirRef.current
  }

  /** 挂载时若 logPath 为空，填充默认路径 */
  useEffect(() => {
    if (!value.logPath) {
      getDefaultDir().then((dir) => {
        if (dir) {
          onChange({ ...value, logPath: dir })
        }
      })
    }
  }, [])

  /** 更新单个字段，若 logPath 清空则回退为默认路径 */
  const updateField = async <K extends keyof LogConfig>(key: K, val: LogConfig[K]) => {
    if (key === 'logPath' && !val) {
      const defaultDir = await getDefaultDir()
      onChange({ ...value, logPath: defaultDir })
    } else {
      onChange({ ...value, [key]: val })
    }
  }

  /** 选择日志目录 */
  const handleSelectDir = async () => {
    const dir = await window.api.dialog.openDirectory()
    if (dir) {
      updateField('logPath', dir)
    }
  }

  return (
    <div className="space-y-4">
      {/* 启用日志 */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm text-gray-300">启用日志</label>
          <p className="text-xs text-gray-500 mt-0.5">记录终端会话的输入输出内容</p>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={value.logEnabled}
            onChange={(e) => updateField('logEnabled', e.target.checked)}
            className="sr-only peer"
          />
          <div className="w-10 h-5 bg-gray-600 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-500 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600" />
        </label>
      </div>

      {/* 日志存放路径 */}
      <div>
        <label className="block text-sm text-gray-400 mb-1.5">日志存放路径</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={value.logPath}
            onChange={(e) => updateField('logPath', e.target.value)}
            placeholder="文档目录/wilson-terminal/logs/"
            className="flex-1 px-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors"
          />
          <button
            onClick={handleSelectDir}
            className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm text-gray-300 transition-colors whitespace-nowrap"
          >
            选择文件夹
          </button>
        </div>
      </div>

      {/* 每行增加时间前缀 */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm text-gray-300">每行增加时间前缀</label>
          <p className="text-xs text-gray-500 mt-0.5">
            在每行日志前添加时间戳，如 <code className="text-gray-400">[2024-01-01 12:00:00]</code>
          </p>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={value.logWithTimestamp}
            onChange={(e) => updateField('logWithTimestamp', e.target.checked)}
            className="sr-only peer"
          />
          <div className="w-10 h-5 bg-gray-600 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-500 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600" />
        </label>
      </div>

      {/* 按大小分割日志 */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm text-gray-300">按大小分割日志</label>
          <p className="text-xs text-gray-500 mt-0.5">当日志文件超过指定大小时自动创建新文件</p>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={value.logSplitBySize}
            onChange={(e) => updateField('logSplitBySize', e.target.checked)}
            className="sr-only peer"
          />
          <div className="w-10 h-5 bg-gray-600 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-500 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600" />
        </label>
      </div>

      {/* 按时间分割日志 */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm text-gray-300">按时间分割日志</label>
          <p className="text-xs text-gray-500 mt-0.5">每天自动创建新的日志文件</p>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={value.logSplitByTime}
            onChange={(e) => updateField('logSplitByTime', e.target.checked)}
            className="sr-only peer"
          />
          <div className="w-10 h-5 bg-gray-600 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-500 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600" />
        </label>
      </div>

      {/* 日志文件最大大小 */}
      <div>
        <label className="block text-sm text-gray-400 mb-1.5">日志文件最大大小</label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={Math.round(value.logMaxSize / (1024 * 1024))}
            onChange={(e) => updateField('logMaxSize', Number(e.target.value) * 1024 * 1024)}
            min={1}
            className="w-24 px-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-gray-200 focus:outline-none focus:border-blue-500 transition-colors"
          />
          <span className="text-sm text-gray-400">MB</span>
        </div>
      </div>
    </div>
  )
}

export default LogConfigSection
