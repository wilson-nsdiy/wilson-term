import React, { useState, useEffect, useCallback } from 'react'
import { useAppStore } from '../store'
import type { SFTPFileEntry } from '@shared/types'

/** 格式化文件大小 */
function formatSize(size: number): string {
  if (size === 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let s = size
  while (s >= 1024 && i < units.length - 1) {
    s /= 1024
    i++
  }
  return `${s.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/** 格式化时间 */
function formatTime(mtime: number): string {
  const d = new Date(mtime * 1000)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hours = String(d.getHours()).padStart(2, '0')
  const minutes = String(d.getMinutes()).padStart(2, '0')
  return `${month}-${day} ${hours}:${minutes}`
}

/** 获取文件图标标识 */
function getFileTypeClass(entry: SFTPFileEntry): string {
  if (entry.attrs.isDirectory) return 'text-yellow-400'
  if (entry.attrs.isSymbolicLink) return 'text-cyan-400'
  return 'text-gray-400'
}

function getFileTypeIcon(entry: SFTPFileEntry): string {
  if (entry.attrs.isDirectory) return '📁'
  if (entry.attrs.isSymbolicLink) return '🔗'
  return '📄'
}

const SftpFileManager: React.FC = () => {
  const sftpDialogOpen = useAppStore((state) => state.sftpDialogOpen)
  const setSftpDialogOpen = useAppStore((state) => state.setSftpDialogOpen)
  const activeSessionId = useAppStore((state) => state.activeSessionId)

  const [currentPath, setCurrentPath] = useState<string>('.')
  const [entries, setEntries] = useState<SFTPFileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedEntries, setSelectedEntries] = useState<Set<string>>(new Set())
  const [uploading, setUploading] = useState(false)
  const [downloadPath, setDownloadPath] = useState<string>('.')
  const [showNewFolderInput, setShowNewFolderInput] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ filename: string; isDir: boolean } | null>(null)

  const loadDirectory = useCallback(async (path: string) => {
    if (!activeSessionId) return
    setLoading(true)
    setError(null)
    setSelectedEntries(new Set())
    try {
      const list = await window.api.sftp.list(activeSessionId, path)
      // 过滤掉 . 和 ..
      const filtered = list.filter((e) => e.filename !== '.' && e.filename !== '..')
      // 目录排在前面
      filtered.sort((a, b) => {
        if (a.attrs.isDirectory && !b.attrs.isDirectory) return -1
        if (!a.attrs.isDirectory && b.attrs.isDirectory) return 1
        return a.filename.localeCompare(b.filename)
      })
      setEntries(filtered)
      setCurrentPath(path)
    } catch (err) {
      setError((err as Error).message)
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [activeSessionId])

  useEffect(() => {
    if (sftpDialogOpen && activeSessionId) {
      loadDirectory('.')
      setDownloadPath('.')
    }
  }, [sftpDialogOpen, activeSessionId, loadDirectory])

  /** 进入目录 */
  const handleEnterDir = useCallback((entry: SFTPFileEntry) => {
    if (!entry.attrs.isDirectory) return
    const newPath = currentPath === '.'
      ? entry.filename
      : `${currentPath}/${entry.filename}`
    loadDirectory(newPath)
  }, [currentPath, loadDirectory])

  /** 返回上级目录 */
  const handleGoUp = useCallback(() => {
    if (currentPath === '.' || currentPath === '/') {
      loadDirectory('.')
      return
    }
    const parts = currentPath.split('/')
    parts.pop()
    const parent = parts.join('/') || '.'
    loadDirectory(parent)
  }, [currentPath, loadDirectory])

  /** 跳转到路径 */
  const handleGoTo = useCallback(() => {
    loadDirectory(downloadPath)
  }, [downloadPath, loadDirectory])

  /** 切换选中 */
  const toggleSelect = useCallback((filename: string) => {
    setSelectedEntries((prev) => {
      const next = new Set(prev)
      if (next.has(filename)) {
        next.delete(filename)
      } else {
        next.add(filename)
      }
      return next
    })
  }, [])

  /** 显示状态消息 */
  const showStatus = useCallback((msg: string) => {
    setStatusMessage(msg)
    setTimeout(() => setStatusMessage(null), 3000)
  }, [])

  /** 通过对话框选择文件上传 */
  const handleUploadDialog = useCallback(async () => {
    if (!activeSessionId) return
    try {
      const filePaths = await window.api.sftp.selectUploadFiles()
      if (!Array.isArray(filePaths) || filePaths.length === 0) return

      setUploading(true)
      for (const localPath of filePaths) {
        const filename = localPath.split(/[\\/]/).pop() || ''
        const remotePath = currentPath === '.' ? filename : `${currentPath}/${filename}`
        const result = await window.api.sftp.upload(activeSessionId, localPath, remotePath)
        if (result.success) {
          showStatus(`上传完成: ${filename}`)
        } else {
          showStatus(`上传失败: ${filename} - ${result.error}`)
        }
      }
      await loadDirectory(currentPath)
    } catch (err) {
      setError(`上传失败: ${(err as Error).message}`)
    } finally {
      setUploading(false)
    }
  }, [activeSessionId, currentPath, loadDirectory, showStatus])

  /** 下载选中的文件 */
  const handleDownloadSelected = useCallback(async () => {
    if (!activeSessionId || selectedEntries.size === 0) return

    for (const filename of selectedEntries) {
      const entry = entries.find((e) => e.filename === filename)
      if (!entry || entry.attrs.isDirectory) continue

      const remotePath = currentPath === '.' ? filename : `${currentPath}/${filename}`
      try {
        const localPath = await window.api.sftp.selectDownloadPath(filename)
        if (!localPath) continue
        const result = await window.api.sftp.download(activeSessionId, remotePath, localPath)
        if (result.success) {
          showStatus(`下载完成: ${filename}`)
        } else {
          showStatus(`下载失败: ${filename}`)
        }
      } catch (err) {
        setError(`下载失败: ${filename} - ${(err as Error).message}`)
      }
    }
  }, [activeSessionId, currentPath, entries, selectedEntries, showStatus])

  /** 删除选中的文件/目录 */
  const handleDelete = useCallback(async () => {
    if (!activeSessionId || !deleteConfirm) return
    const { filename } = deleteConfirm
    const entry = entries.find((e) => e.filename === filename)
    if (!entry) return

    const remotePath = currentPath === '.' ? filename : `${currentPath}/${filename}`
    try {
      const result = await window.api.sftp.delete(activeSessionId, remotePath, entry.attrs.isDirectory)
      if (result.success) {
        showStatus(`删除完成: ${filename}`)
        await loadDirectory(currentPath)
      } else {
        setError(`删除失败: ${result.error}`)
      }
    } catch (err) {
      setError(`删除失败: ${(err as Error).message}`)
    } finally {
      setDeleteConfirm(null)
    }
  }, [activeSessionId, currentPath, entries, deleteConfirm, loadDirectory, showStatus])

  /** 创建新目录 */
  const handleCreateFolder = useCallback(async () => {
    if (!activeSessionId || !newFolderName.trim()) return
    const remotePath = currentPath === '.' ? newFolderName.trim() : `${currentPath}/${newFolderName.trim()}`
    try {
      const result = await window.api.sftp.mkdir(activeSessionId, remotePath)
      if (result.success) {
        showStatus(`目录创建完成: ${newFolderName.trim()}`)
        setNewFolderName('')
        setShowNewFolderInput(false)
        await loadDirectory(currentPath)
      } else {
        setError(`创建目录失败: ${result.error}`)
      }
    } catch (err) {
      setError(`创建目录失败: ${(err as Error).message}`)
    }
  }, [activeSessionId, currentPath, newFolderName, loadDirectory, showStatus])

  /** 获取面包屑路径 */
  const breadcrumbs = currentPath === '.'
    ? [{ label: '/', path: '.' }]
    : [{ label: '/', path: '.' }, ...currentPath.split('/').map((part, i, arr) => ({
        label: part,
        path: arr.slice(0, i + 1).join('/')
      }))]

  /** 双击文件下载 */
  const handleDoubleClickEntry = useCallback((entry: SFTPFileEntry) => {
    if (entry.attrs.isDirectory) {
      handleEnterDir(entry)
    } else if (entry.attrs.isFile) {
      // 双击文件 -> 下载
      const filename = entry.filename
      const remotePath = currentPath === '.' ? filename : `${currentPath}/${filename}`
      if (!activeSessionId) return

      ;(async () => {
        try {
          const localPath = await window.api.sftp.selectDownloadPath(filename)
          if (!localPath) return
          const result = await window.api.sftp.download(activeSessionId, remotePath, localPath)
          if (result.success) {
            showStatus(`下载完成: ${filename}`)
          }
        } catch (err) {
          setError(`下载失败: ${(err as Error).message}`)
        }
      })()
    }
  }, [activeSessionId, currentPath, handleEnterDir, showStatus])

  if (!sftpDialogOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={() => setSftpDialogOpen(false)}
    >
      <div
        className="bg-gray-800 rounded-lg shadow-xl w-[800px] h-[600px] border border-gray-600 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700 shrink-0">
          <h2 className="text-base font-medium text-gray-200">SFTP 文件管理</h2>
          <button
            onClick={() => setSftpDialogOpen(false)}
            className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-white transition-colors"
          >
            ✕
          </button>
        </div>

        {/* 工具栏 */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-700 shrink-0 flex-wrap">
          <button
            onClick={handleGoUp}
            disabled={currentPath === '.'}
            className="px-3 py-1 text-sm bg-gray-700 hover:bg-gray-600 rounded text-gray-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title="返回上级目录"
          >
            ⬆ 上级
          </button>
          <button
            onClick={() => loadDirectory('.')}
            className="px-3 py-1 text-sm bg-gray-700 hover:bg-gray-600 rounded text-gray-200 transition-colors"
            title="刷新"
          >
            ↻ 刷新
          </button>
          <div className="w-px h-5 bg-gray-600 mx-1" />
          <button
            onClick={handleUploadDialog}
            disabled={uploading}
            className="px-3 py-1 text-sm bg-blue-600 hover:bg-blue-700 rounded text-white transition-colors disabled:opacity-40"
            title="上传文件到当前目录"
          >
            ⬆ 上传
          </button>
          <button
            onClick={handleDownloadSelected}
            disabled={selectedEntries.size === 0}
            className="px-3 py-1 text-sm bg-green-600 hover:bg-green-700 rounded text-white transition-colors disabled:opacity-40"
            title="下载选中的文件"
          >
            ⬇ 下载
          </button>
          <div className="w-px h-5 bg-gray-600 mx-1" />
          {showNewFolderInput ? (
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateFolder()
                  if (e.key === 'Escape') { setShowNewFolderInput(false); setNewFolderName('') }
                }}
                placeholder="目录名"
                className="w-32 px-2 py-1 text-sm bg-gray-700 border border-gray-500 rounded text-gray-200 placeholder-gray-500 outline-none focus:border-blue-500"
                autoFocus
              />
              <button
                onClick={handleCreateFolder}
                className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-700 rounded text-white"
              >
                确定
              </button>
              <button
                onClick={() => { setShowNewFolderInput(false); setNewFolderName('') }}
                className="px-2 py-1 text-xs bg-gray-600 hover:bg-gray-500 rounded text-gray-200"
              >
                取消
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowNewFolderInput(true)}
              className="px-3 py-1 text-sm bg-gray-700 hover:bg-gray-600 rounded text-gray-200 transition-colors"
              title="创建新目录"
            >
              + 新建目录
            </button>
          )}
        </div>

        {/* 路径导航 / 快速跳转 */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-700 shrink-0">
          <div className="flex items-center gap-1 text-sm text-gray-300 flex-1 overflow-x-auto">
            {breadcrumbs.map((bc, i) => (
              <React.Fragment key={bc.path}>
                {i > 0 && <span className="text-gray-500">/</span>}
                <button
                  onClick={() => loadDirectory(bc.path)}
                  className={`hover:text-white transition-colors whitespace-nowrap ${
                    i === breadcrumbs.length - 1 ? 'text-blue-400' : 'text-gray-400'
                  }`}
                >
                  {bc.label}
                </button>
              </React.Fragment>
            ))}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <input
              type="text"
              value={downloadPath}
              onChange={(e) => setDownloadPath(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleGoTo() }}
              placeholder="输入路径..."
              className="w-40 px-2 py-1 text-xs bg-gray-700 border border-gray-600 rounded text-gray-200 placeholder-gray-500 outline-none focus:border-blue-500"
            />
            <button
              onClick={handleGoTo}
              className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded text-gray-200 transition-colors"
            >
              跳转
            </button>
          </div>
        </div>

        {/* 状态/错误消息 */}
        {statusMessage && (
          <div className="px-4 py-1.5 text-sm text-green-400 bg-green-900/30 border-b border-green-800/30 shrink-0">
            {statusMessage}
          </div>
        )}
        {error && (
          <div className="px-4 py-1.5 text-sm text-red-400 bg-red-900/30 border-b border-red-800/30 shrink-0">
            {error}
            <button onClick={() => setError(null)} className="ml-2 text-red-300 hover:text-white">✕</button>
          </div>
        )}

        {/* 文件列表 */}
        <div className="flex-1 overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-900/50 sticky top-0">
              <tr className="text-gray-400 text-xs uppercase tracking-wider">
                <th className="w-8 px-3 py-2 text-left">
                  {entries.length > 0 && (
                    <input
                      type="checkbox"
                      checked={selectedEntries.size === entries.length}
                      onChange={() => {
                        if (selectedEntries.size === entries.length) {
                          setSelectedEntries(new Set())
                        } else {
                          setSelectedEntries(new Set(entries.map((e) => e.filename)))
                        }
                      }}
                      className="accent-blue-500"
                    />
                  )}
                </th>
                <th className="px-2 py-2 text-left font-medium">名称</th>
                <th className="w-20 px-2 py-2 text-right font-medium">大小</th>
                <th className="w-32 px-2 py-2 text-left font-medium">修改时间</th>
                <th className="w-24 px-2 py-2 text-center font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-3 py-12 text-center text-gray-500">
                    加载中...
                  </td>
                </tr>
              ) : entries.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-12 text-center text-gray-500">
                    空目录
                  </td>
                </tr>
              ) : (
                entries.map((entry) => {
                  const isSelected = selectedEntries.has(entry.filename)
                  return (
                    <tr
                      key={entry.filename}
                      className={`border-b border-gray-700/50 hover:bg-gray-700/30 cursor-pointer transition-colors ${
                        isSelected ? 'bg-blue-900/20' : ''
                      }`}
                      onClick={() => toggleSelect(entry.filename)}
                      onDoubleClick={() => handleDoubleClickEntry(entry)}
                    >
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(entry.filename)}
                          className="accent-blue-500"
                          onClick={(e) => e.stopPropagation()}
                        />
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex items-center gap-2">
                          <span className={getFileTypeClass(entry)}>
                            {getFileTypeIcon(entry)}
                          </span>
                          <span className={`truncate max-w-[400px] ${
                            entry.attrs.isDirectory ? 'text-blue-300' : 'text-gray-200'
                          }`}>
                            {entry.filename}
                          </span>
                          {entry.attrs.isSymbolicLink && (
                            <span className="text-xs text-cyan-500">-&gt;</span>
                          )}
                        </div>
                      </td>
                      <td className="px-2 py-2 text-right text-gray-400 font-mono text-xs">
                        {entry.attrs.isDirectory ? '-' : formatSize(entry.attrs.size)}
                      </td>
                      <td className="px-2 py-2 text-gray-400 text-xs">
                        {formatTime(entry.attrs.mtime)}
                      </td>
                      <td className="px-2 py-2 text-center">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            setDeleteConfirm({ filename: entry.filename, isDir: entry.attrs.isDirectory })
                          }}
                          className="px-2 py-0.5 text-xs bg-red-700/50 hover:bg-red-600 rounded text-red-300 hover:text-white transition-colors"
                        >
                          删除
                        </button>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {/* 底部状态栏 */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-gray-700 text-xs text-gray-500 shrink-0">
          <span>
            {loading ? '加载中...' : `${entries.length} 个项目`}
            {selectedEntries.size > 0 && ` (已选 ${selectedEntries.size})`}
          </span>
          <span className="text-gray-600">
            {currentPath === '.' ? '/' : currentPath}
          </span>
        </div>
      </div>

      {/* 删除确认弹窗 */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50">
          <div
            className="bg-gray-800 rounded-lg shadow-xl w-[400px] border border-gray-600"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-700">
              <span className="text-red-400 text-lg">⚠</span>
              <h2 className="text-base font-medium text-gray-200">确认删除</h2>
            </div>
            <div className="px-5 py-4">
              <p className="text-sm text-gray-300 leading-relaxed">
                确定要删除 <span className="text-white font-medium">{deleteConfirm.filename}</span> 吗？
              </p>
              {deleteConfirm.isDir && (
                <p className="text-sm text-yellow-400 mt-2">
                  注意：目录必须为空才能删除。
                </p>
              )}
            </div>
            <div className="flex justify-end gap-3 px-5 py-3 border-t border-gray-700">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="px-4 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm text-gray-300 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleDelete}
                className="px-4 py-1.5 bg-red-600 hover:bg-red-700 rounded text-sm text-white transition-colors"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default SftpFileManager
