import React, { useRef, useEffect } from 'react'
import { useAppStore } from '../store'

/** 命令行输入框：位于终端与状态栏之间，回车将文本发送到当前活跃终端 */
const CommandInput: React.FC = () => {
  const visible = useAppStore((state) => state.commandInputVisible && state.activeSessionId)
  const text = useAppStore((state) => state.commandInputText)
  const setCommandInputText = useAppStore((state) => state.setCommandInputText)
  const setCommandInputVisible = useAppStore((state) => state.setCommandInputVisible)
  const activeSessionId = useAppStore((state) => state.activeSessionId)
  const inputRef = useRef<HTMLInputElement>(null)

  // 显示时自动聚焦
  useEffect(() => {
    if (visible) {
      inputRef.current?.focus()
    }
  }, [visible])

  // ESC 关闭
  useEffect(() => {
    if (!visible) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setCommandInputVisible(false)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [visible, setCommandInputVisible])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const value = text.trim()
      if (value && activeSessionId) {
        window.api.connection.write(activeSessionId, value + '\r')
      }
      setCommandInputText('')
      e.preventDefault()
    }
  }

  if (!visible) return null

  return (
    <div
      className="flex items-center gap-0 select-none"
      style={{
        height: '24px',
        backgroundColor: '#1a1a2a',
        borderTop: '1px solid #3a3a4a',
        borderBottom: '1px solid #3a3a4a'
      }}
    >
      <span
        className="px-1.5 text-xs font-mono font-bold shrink-0"
        style={{ color: '#89b4fa' }}
      >
        CMD
      </span>
      <input
        ref={inputRef}
        type="text"
        value={text}
        onChange={(e) => setCommandInputText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="输入命令，按回车发送..."
        spellCheck={false}
        className="w-full h-full bg-transparent text-xs text-gray-200 outline-none px-1.5 placeholder-gray-500 font-mono"
        style={{ fontFamily: 'inherit' }}
      />
    </div>
  )
}

export default CommandInput
