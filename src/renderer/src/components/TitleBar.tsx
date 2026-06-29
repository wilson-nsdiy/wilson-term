import React from 'react'
import { useAppStore } from '../store'
import MenuBar from './MenuBar'
import icon16 from '../assets/icon-16.png'
import icon32 from '../assets/icon-32.png'

const TitleBar: React.FC = () => {
  const toggleSidebar = useAppStore((state) => state.toggleSidebar)

  const handleMinimize = () => {
    window.api.window.minimize()
  }

  const handleMaximize = () => {
    window.api.window.maximize()
  }

  const handleClose = () => {
    window.api.window.close()
  }

  return (
    <div className="flex items-center justify-between h-9 bg-gray-800 border-b border-gray-700 select-none drag">
      <div className="flex items-center h-full no-drag">
        {/* 应用图标 */}
        <img
          src={icon32}
          srcSet={`${icon16} 1x, ${icon32} 2x`}
          alt="Wilson-Term"
          className="w-4 h-4 ml-2 mr-1 select-none pointer-events-none"
          draggable={false}
        />

        {/* 侧边栏切换按钮 */}
        <button
          onClick={toggleSidebar}
          className="w-8 h-full flex items-center justify-center hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
          title="切换侧边栏"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <rect x="1" y="2" width="12" height="10" rx="1" stroke="currentColor" strokeWidth="1.2" />
            <line x1="5" y1="2" x2="5" y2="12" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>

        {/* 菜单栏 */}
        <MenuBar />
      </div>

      {/* 标题 */}
      <div className="absolute left-1/2 -translate-x-1/2 text-sm font-medium text-gray-300 pointer-events-none">
        Wilson Term V{__APP_VERSION__}
      </div>

      {/* 窗口控制按钮 */}
      <div className="flex items-center gap-1 no-drag pr-1">
        <button
          onClick={handleMinimize}
          className="w-8 h-7 flex items-center justify-center rounded hover:bg-gray-600 text-gray-400 hover:text-white transition-colors"
          title="最小化"
        >
          <svg width="10" height="1" viewBox="0 0 10 1">
            <path fill="currentColor" d="M0 0h10v1H0z" />
          </svg>
        </button>
        <button
          onClick={handleMaximize}
          className="w-8 h-7 flex items-center justify-center rounded hover:bg-gray-600 text-gray-400 hover:text-white transition-colors"
          title="最大化"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path fill="currentColor" d="M0 0h10v10H0V0zm1 1v8h8V1H1z" />
          </svg>
        </button>
        <button
          onClick={handleClose}
          className="w-8 h-7 flex items-center justify-center rounded hover:bg-red-600 text-gray-400 hover:text-white transition-colors"
          title="关闭"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path fill="currentColor" d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
      </div>
    </div>
  )
}

export default TitleBar
