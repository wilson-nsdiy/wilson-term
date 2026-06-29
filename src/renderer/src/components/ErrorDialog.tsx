import React, { useEffect, useCallback } from 'react'

interface ErrorDialogProps {
  open: boolean
  message: string
  onClose: () => void
}

const ErrorDialog: React.FC<ErrorDialogProps> = ({ open, message, onClose }) => {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'Enter') {
      onClose()
    }
  }, [onClose])

  useEffect(() => {
    if (open) {
      document.addEventListener('keydown', handleKeyDown)
      return () => document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, handleKeyDown])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-gray-800 rounded-lg shadow-xl w-[360px] border border-gray-600"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-700">
          <span className="text-red-400 text-lg">⚠</span>
          <h2 className="text-base font-medium text-gray-200">错误</h2>
        </div>

        {/* 内容 */}
        <div className="px-5 py-4">
          <p className="text-sm text-gray-300 leading-relaxed">{message}</p>
        </div>

        {/* 底部按钮 */}
        <div className="flex justify-end px-5 py-3 border-t border-gray-700">
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm text-gray-300 transition-colors"
          >
            确定
          </button>
        </div>
      </div>
    </div>
  )
}

export default ErrorDialog
