import React, { useEffect, useState, useCallback } from 'react'
import type { PluginListItem, PluginImportResult } from '@shared/types/plugin'
import { rendererPluginHost } from '@renderer/plugin-host.ts'

interface PluginManagerProps {
  open: boolean
  onClose: () => void
}

const PluginManager: React.FC<PluginManagerProps> = ({ open, onClose }) => {
  const [plugins, setPlugins] = useState<PluginListItem[]>([])
  const [importing, setImporting] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const refreshList = useCallback(async () => {
    const list = await window.api.plugin.list()
    setPlugins(list)
  }, [])

  useEffect(() => {
    if (open) refreshList()
  }, [open, refreshList])

  const handleImport = useCallback(async () => {
    setImporting(true)
    setMessage(null)
    try {
      const result: PluginImportResult = await window.api.plugin.importZip()
      if (result.success) {
        setMessage({ type: 'success', text: `插件 ${result.pluginId} 安装成功` })
        await refreshList()
      } else {
        setMessage({ type: 'error', text: result.error ?? '导入失败' })
      }
    } catch (err) {
      setMessage({ type: 'error', text: String(err) })
    } finally {
      setImporting(false)
    }
  }, [refreshList])

  const handleToggle = useCallback(async (id: string, enabled: boolean) => {
    await window.api.plugin.toggle(id, enabled)
    if (enabled) {
      await rendererPluginHost.loadFromMain()
      await rendererPluginHost.activate(id)
      const sessions = await window.api.plugin.getSessions()
      for (const sid of sessions) {
        rendererPluginHost.notifySessionCreated(sid)
      }
    } else {
      await rendererPluginHost.deactivate(id)
    }
    await refreshList()
  }, [refreshList])

  const handleExport = useCallback(async (id: string) => {
    await window.api.plugin.exportZip(id)
  }, [])

  const handleUninstall = useCallback(async (id: string) => {
    await rendererPluginHost.deactivate(id)
    await window.api.plugin.uninstall(id)
    await refreshList()
  }, [refreshList])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-[#1e1e2e] border border-[#4a4a5a] rounded-lg w-[520px] max-h-[70vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#4a4a5a]">
          <h2 className="text-sm font-semibold text-gray-200">插件管理</h2>
          <button
            className="text-gray-400 hover:text-white text-lg leading-none"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="px-4 py-2 border-b border-[#3a3a4a] flex items-center gap-2">
          <button
            className="px-3 py-1.5 text-xs rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50"
            onClick={handleImport}
            disabled={importing}
          >
            {importing ? '导入中...' : '导入 ZIP'}
          </button>
          {message && (
            <span className={`text-xs ${message.type === 'success' ? 'text-green-400' : 'text-red-400'}`}>
              {message.text}
            </span>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-2">
          {plugins.length === 0 ? (
            <div className="text-center text-gray-500 py-8 text-sm">
              暂无已安装插件，点击"导入 ZIP"安装
            </div>
          ) : (
            <div className="space-y-2">
              {plugins.map((item) => (
                <div
                  key={item.manifest.id}
                  className="flex items-center justify-between p-3 rounded bg-[#2a2a3a] border border-[#3a3a4a]"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-200 truncate">
                        {item.manifest.name}
                      </span>
                      <span className="text-[10px] text-gray-500 font-mono">
                        v{item.manifest.version}
                      </span>
                    </div>
                    <div className="text-xs text-gray-500 truncate mt-0.5">
                      {item.manifest.description}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 ml-3">
                    <button
                      className={`px-2 py-1 text-xs rounded ${
                        item.enabled
                          ? 'bg-green-700 text-green-200 hover:bg-green-600'
                          : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                      }`}
                      onClick={() => handleToggle(item.manifest.id, !item.enabled)}
                    >
                      {item.enabled ? '已启用' : '已禁用'}
                    </button>
                    <button
                      className={`px-2 py-1 text-xs rounded ${
                        item.enabled
                          ? 'bg-gray-700 text-gray-600 cursor-not-allowed'
                          : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                      }`}
                      onClick={() => handleExport(item.manifest.id)}
                      disabled={item.enabled}
                      title={item.enabled ? '请先禁用插件' : undefined}
                    >
                      导出
                    </button>
                    <button
                      className={`px-2 py-1 text-xs rounded ${
                        item.enabled
                          ? 'bg-gray-700 text-gray-600 cursor-not-allowed'
                          : 'bg-red-900 text-red-300 hover:bg-red-800'
                      }`}
                      onClick={() => handleUninstall(item.manifest.id)}
                      disabled={item.enabled}
                      title={item.enabled ? '请先禁用插件' : undefined}
                    >
                      卸载
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default PluginManager
