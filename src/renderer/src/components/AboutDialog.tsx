import React from 'react'
import logo from '../assets/logo.png'

interface AboutDialogProps {
  open: boolean
  onClose: () => void
}

const AboutDialog: React.FC<AboutDialogProps> = ({ open, onClose }) => {
  if (!open) return null

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose()
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div
        className="bg-[#1e1e2e] rounded-xl shadow-2xl w-[400px] border border-[#313244] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶部装饰区域 */}
        <div className="relative bg-gradient-to-br from-[#313244] to-[#1e1e2e] px-6 pt-8 pb-6 text-center">
          <div className="mx-auto w-16 h-16 rounded-2xl overflow-hidden shadow-lg ring-1 ring-white/10 mb-4">
            <img src={logo} alt="Logo" className="w-full h-full object-cover" />
          </div>
          <h3 className="text-xl font-semibold text-[#cdd6f4]">Wilson Term</h3>
          <p className="text-sm text-[#a6adc8] mt-1">v{__APP_VERSION__}</p>
        </div>

        {/* 信息区域 */}
        <div className="px-6 py-5 space-y-3">
          <p className="text-sm text-[#bac2de] text-center leading-relaxed">
            支持 SSH / Telnet / 串口连接的模拟终端
          </p>

          <div className="flex items-center justify-center gap-6 text-xs text-[#6c7086]">
            <span>作者：Wilson.Zhou</span>
            <span className="w-px h-3 bg-[#313244]" />
            <span>个人项目</span>
          </div>

          <div className="flex justify-center pt-1">
            <button
              onClick={() => window.api.window.toggleDevtools()}
              className="text-xs text-[#585b70] hover:text-[#a6adc8] transition-colors cursor-pointer"
            >
              开发者工具
            </button>
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="flex justify-center px-6 py-4 border-t border-[#313244]">
          <button
            onClick={onClose}
            className="px-8 py-1.5 bg-[#45475a] hover:bg-[#585b70] rounded-lg text-sm text-[#cdd6f4] transition-colors"
          >
            确定
          </button>
        </div>
      </div>
    </div>
  )
}

export default AboutDialog
