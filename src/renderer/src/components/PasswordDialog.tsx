import React, { useState, useEffect, useCallback, useRef } from 'react'
import type { PasswordRequest } from '@shared/types'

interface PasswordDialogProps {
  request: PasswordRequest | null
  onRespond: (sessionId: string, password: string) => void
}

const PasswordDialog: React.FC<PasswordDialogProps> = ({ request, onRespond }) => {
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (request) {
      setPassword('')
      setShowPassword(false)
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [request])

  const handleSubmit = useCallback(() => {
    if (request) {
      onRespond(request.sessionId, password)
    }
  }, [request, password, onRespond])

  const handleCancel = useCallback(() => {
    if (request) {
      onRespond(request.sessionId, '')
    }
  }, [request, onRespond])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleSubmit()
      } else if (e.key === 'Escape') {
        handleCancel()
      }
    },
    [handleSubmit, handleCancel]
  )

  if (!request) return null

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50">
      <div
        className="bg-gray-800 rounded-lg shadow-xl w-[420px] border border-gray-600"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-700">
          <span className="text-blue-400 text-lg">🔑</span>
          <h2 className="text-base font-medium text-gray-200">SSH 密码认证</h2>
        </div>

        <div className="px-5 py-4 space-y-3">
          <p className="text-sm text-gray-300 leading-relaxed">
            连接 <span className="text-white font-medium">{request.username}@{request.host}:{request.port}</span> 需要密码认证。
          </p>
          {request.prompt && (
            <div className="bg-gray-900 rounded px-3 py-2">
              <p className="text-sm text-gray-400">{request.prompt}</p>
            </div>
          )}
          {request.retry && (
            <p className="text-sm text-red-400">密码不正确，请重新输入</p>
          )}
          <div>
            <label className="block text-sm text-gray-400 mb-1">密码</label>
            <div className="relative">
              <input
                ref={inputRef}
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="请输入密码"
                className="w-full px-3 py-1.5 pr-9 bg-gray-700 border border-gray-600 rounded text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors"
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowPassword((p) => !p)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-200 transition-colors p-0.5"
                tabIndex={-1}
              >
                {showPassword ? (
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" /></svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                )}
              </button>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3 px-5 py-3 border-t border-gray-700">
          <button
            onClick={handleCancel}
            className="px-4 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm text-gray-300 transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 rounded text-sm text-white transition-colors"
          >
            确认
          </button>
        </div>
      </div>
    </div>
  )
}

export default PasswordDialog
