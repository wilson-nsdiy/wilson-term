import React, { useEffect, useRef } from 'react'

interface ContextMenuProps {
  /** 菜单显示位置 X（屏幕坐标） */
  x: number
  /** 菜单显示位置 Y（屏幕坐标） */
  y: number
  /** 是否有选中文本（控制复制按钮状态） */
  hasSelection: boolean
  /** 是否显示菜单 */
  visible: boolean
  /** 复制回调 */
  onCopy: () => void
  /** 粘贴回调 */
  onPaste: () => void
  /** 关闭菜单 */
  onClose: () => void
}

const TerminalContextMenu: React.FC<ContextMenuProps> = ({
  x,
  y,
  hasSelection,
  visible,
  onCopy,
  onPaste,
  onClose
}) => {
  const menuRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // 点击菜单外部时关闭
  useEffect(() => {
    if (!visible) return

    let cleanupFn: (() => void) | null = null

    // 使用 setTimeout 延迟绑定，避免右键点击时 mousedown 事件立即触发关闭
    const timer = setTimeout(() => {
      const handleClickOutside = (e: MouseEvent) => {
        if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
          onCloseRef.current()
        }
      }
      document.addEventListener('mousedown', handleClickOutside)
      cleanupFn = () => document.removeEventListener('mousedown', handleClickOutside)
    }, 0)

    return () => {
      clearTimeout(timer)
      cleanupFn?.()
    }
  }, [visible])

  // ESC 键关闭菜单
  useEffect(() => {
    if (!visible) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [visible])

  if (!visible) return null

  // 计算菜单位置，防止溢出视口
  const menuWidth = 160
  const menuHeight = 88
  const adjustedX = Math.min(x, window.innerWidth - menuWidth - 8)
  const adjustedY = Math.min(y, window.innerHeight - menuHeight - 8)

  return (
    <div
      ref={menuRef}
      className="fixed z-50 w-40 bg-[#2a2a3a] border border-[#4a4a5a] rounded-lg shadow-xl py-1 select-none"
      style={{ left: adjustedX, top: adjustedY }}
    >
      {/* 复制按钮 */}
      <button
        className={`w-full px-3 py-2 text-sm text-left flex items-center gap-2 transition-colors ${
          hasSelection
            ? 'text-gray-200 hover:bg-[#3a3a4a]'
            : 'text-gray-500 cursor-not-allowed'
        }`}
        onClick={() => {
          if (hasSelection) {
            onCopy()
            onClose()
          }
        }}
        disabled={!hasSelection}
      >
        {/* 复制图标 */}
        <svg
          className="w-4 h-4 flex-shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        <span>复制</span>
      </button>

      {/* 分隔线 */}
      <div className="h-px bg-[#4a4a5a] mx-2" />

      {/* 粘贴按钮 */}
      <button
        className="w-full px-3 py-2 text-sm text-left flex items-center gap-2 text-gray-200 hover:bg-[#3a3a4a] transition-colors"
        onClick={() => {
          onPaste()
          onClose()
        }}
      >
        {/* 粘贴图标 */}
        <svg
          className="w-4 h-4 flex-shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
          <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
        </svg>
        <span>粘贴</span>
      </button>
    </div>
  )
}

export default TerminalContextMenu
