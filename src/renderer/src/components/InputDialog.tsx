import React, { useState, useEffect, useCallback, useRef } from 'react'

interface InputDialogProps {
  open: boolean
  title: string
  message?: string
  defaultValue?: string
  placeholder?: string
  onConfirm: (value: string) => void
  onCancel: () => void
}

const InputDialog: React.FC<InputDialogProps> = ({
  open,
  title,
  message,
  defaultValue = '',
  placeholder,
  onConfirm,
  onCancel
}) => {
  const [value, setValue] = useState(defaultValue)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setValue(defaultValue)
      // 自动聚焦并选中文本
      setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 100)
    }
  }, [open, defaultValue])

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      onCancel()
    } else if (e.key === 'Enter') {
      onConfirm(value)
    }
  }, [onCancel, onConfirm, value])

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
      onClick={onCancel}
    >
      <div
        className="bg-gray-800 rounded-lg shadow-xl w-[360px] border border-gray-600"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-700">
          <span className="text-blue-400 text-lg">📝</span>
          <h2 className="text-base font-medium text-gray-200">{title}</h2>
        </div>

        {/* 内容 */}
        <div className="px-5 py-4">
          {message && (
            <p className="text-sm text-gray-300 mb-3">{message}</p>
          )}
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
        </div>

        {/* 底部按钮 */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-gray-700">
          <button
            onClick={onCancel}
            className="px-4 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm text-gray-300 transition-colors"
          >
            取消
          </button>
          <button
            onClick={() => onConfirm(value)}
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 rounded text-sm text-gray-200 transition-colors"
          >
            确定
          </button>
        </div>
      </div>
    </div>
  )
}

export default InputDialog
