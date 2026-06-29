import React, { useEffect, useCallback } from 'react'

interface MultiLinePasteDialogProps {
  open: boolean
  lineCount: number
  preview: string
  onConfirm: () => void
  onCancel: () => void
}

const MAX_PREVIEW_LINES = 5
const MAX_PREVIEW_CHARS = 200

const MultiLinePasteDialog: React.FC<MultiLinePasteDialogProps> = ({
  open,
  lineCount,
  preview,
  onConfirm,
  onCancel
}) => {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel()
      } else if (e.key === 'Enter') {
        onConfirm()
      }
    },
    [onConfirm, onCancel]
  )

  useEffect(() => {
    if (open) {
      document.addEventListener('keydown', handleKeyDown)
      return () => document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, handleKeyDown])

  if (!open) return null

  const truncated =
    preview.length > MAX_PREVIEW_CHARS ? preview.slice(0, MAX_PREVIEW_CHARS) + '...' : preview
  const previewLines = truncated.split('\n')
  const showEllipsis = previewLines.length > MAX_PREVIEW_LINES

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
      onClick={onCancel}
    >
      <div
        className="bg-gray-800 rounded-lg shadow-xl w-[420px] border border-gray-600"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-700">
          <span className="text-yellow-400 text-lg">⚠</span>
          <h2 className="text-base font-medium text-gray-200">多行粘贴确认</h2>
        </div>

        <div className="px-5 py-4">
          <p className="text-sm text-gray-300 leading-relaxed">
            即将粘贴 <span className="text-yellow-300 font-medium">{lineCount}</span> 行内容到终端，这可能执行多条命令。
          </p>
          <div className="mt-3 bg-gray-900 rounded px-3 py-2 max-h-32 overflow-auto">
            {previewLines.slice(0, MAX_PREVIEW_LINES).map((line, i) => (
              <div key={i} className="text-xs text-gray-400 font-mono whitespace-pre-wrap break-all">
                {line || ' '}
              </div>
            ))}
            {showEllipsis && (
              <div className="text-xs text-gray-500 font-mono">...</div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-gray-700">
          <button
            onClick={onCancel}
            className="px-4 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm text-gray-300 transition-colors"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white transition-colors"
          >
            粘贴
          </button>
        </div>
      </div>
    </div>
  )
}

export default MultiLinePasteDialog
