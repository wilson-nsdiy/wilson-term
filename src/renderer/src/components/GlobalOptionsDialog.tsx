import React, { useState, useEffect, useRef } from 'react'
import { useAppStore } from '../store'
import type { AppSettings } from '@shared/types'
import ProfileManager from './ProfileManager'

interface GlobalOptionsDialogProps {
  open: boolean
  onClose: () => void
}

const FONT_WEIGHT_OPTIONS = [
  { value: '100', label: '100 - Thin' },
  { value: '200', label: '200 - Extra Light' },
  { value: '300', label: '300 - Light' },
  { value: 'normal', label: '400 - Normal' },
  { value: '500', label: '500 - Medium' },
  { value: '600', label: '600 - Semi Bold' },
  { value: 'bold', label: '700 - Bold' },
  { value: '800', label: '800 - Extra Bold' },
  { value: '900', label: '900 - Black' }
]

const CURSOR_STYLE_OPTIONS = [
  { value: 'block', label: '方块' },
  { value: 'underline', label: '下划线' },
  { value: 'bar', label: '竖线' }
]

type TabKey = 'appearance' | 'cursor' | 'scroll' | 'mouse' | 'profiles'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'appearance', label: '外观' },
  { key: 'cursor', label: '光标' },
  { key: 'scroll', label: '滚动' },
  { key: 'mouse', label: '鼠标/粘贴' },
  { key: 'profiles', label: '配置模板' }
]

const DEFAULT_FORM = {
  rightClickPaste: true,
  trimPaste: true,
  multiLinePasteWarning: 'auto' as AppSettings['multiLinePasteWarning'],
  fontSize: 14,
  fontFamily: 'Cascadia Code',
  fontWeight: 'normal',
  fontWeightBold: 'bold',
  lineHeight: 1.0,
  letterSpacing: 0,
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  backgroundImage: '',
  backgroundOpacity: 1,
  cursorStyle: 'block' as AppSettings['cursorStyle'],
  cursorBlink: true,
  scrollback: 1000
}

const GlobalOptionsDialog: React.FC<GlobalOptionsDialogProps> = ({ open, onClose }) => {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)

  const [form, setForm] = useState({
    rightClickPaste: settings.rightClickPaste,
    trimPaste: settings.trimPaste,
    multiLinePasteWarning: settings.multiLinePasteWarning,
    fontSize: settings.fontSize,
    fontFamily: settings.fontFamily,
    fontWeight: settings.fontWeight,
    fontWeightBold: settings.fontWeightBold,
    lineHeight: settings.lineHeight,
    letterSpacing: settings.letterSpacing,
    background: settings.background,
    foreground: settings.foreground,
    backgroundImage: settings.backgroundImage,
    backgroundOpacity: settings.backgroundOpacity,
    cursorStyle: settings.cursorStyle,
    cursorBlink: settings.cursorBlink,
    scrollback: settings.scrollback
  })

  const [activeTab, setActiveTab] = useState<TabKey>('appearance')
  const [systemFonts, setSystemFonts] = useState<string[] | null>(null)
  const [fontFilter, setFontFilter] = useState('')
  const [fontDropdownOpen, setFontDropdownOpen] = useState(false)
  const fontDropdownRef = useRef<HTMLDivElement>(null)

  const syncForm = () => ({
    rightClickPaste: settings.rightClickPaste,
    trimPaste: settings.trimPaste,
    multiLinePasteWarning: settings.multiLinePasteWarning,
    fontSize: settings.fontSize,
    fontFamily: settings.fontFamily,
    fontWeight: settings.fontWeight,
    fontWeightBold: settings.fontWeightBold,
    lineHeight: settings.lineHeight,
    letterSpacing: settings.letterSpacing,
    background: settings.background,
    foreground: settings.foreground,
    backgroundImage: settings.backgroundImage,
    backgroundOpacity: settings.backgroundOpacity,
    cursorStyle: settings.cursorStyle,
    cursorBlink: settings.cursorBlink,
    scrollback: settings.scrollback
  })

  useEffect(() => {
    if (!fontDropdownOpen) return
    const handler = (e: MouseEvent) => {
      if (fontDropdownRef.current && !fontDropdownRef.current.contains(e.target as Node)) {
        setFontDropdownOpen(false)
        setFontFilter('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [fontDropdownOpen])

  useEffect(() => {
    if (open) {
      setForm(syncForm())
      setFontFilter('')
      setActiveTab('appearance')
    }
  }, [open, settings])

  const updateForm = <K extends keyof typeof form>(key: K, value: typeof form[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const handleSave = () => {
    updateSettings({
      rightClickPaste: form.rightClickPaste,
      trimPaste: form.trimPaste,
      multiLinePasteWarning: form.multiLinePasteWarning,
      fontSize: form.fontSize,
      fontFamily: form.fontFamily,
      fontWeight: form.fontWeight,
      fontWeightBold: form.fontWeightBold,
      lineHeight: form.lineHeight,
      letterSpacing: form.letterSpacing,
      background: form.background,
      foreground: form.foreground,
      backgroundImage: form.backgroundImage,
      backgroundOpacity: form.backgroundOpacity,
      cursorStyle: form.cursorStyle,
      cursorBlink: form.cursorBlink,
      scrollback: form.scrollback
    })
    onClose()
  }

  const handleClose = () => {
    setForm(syncForm())
    onClose()
  }

  const handleResetDefaults = () => {
    setForm(DEFAULT_FORM)
    setFontFilter('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      handleClose()
    }
  }

  const handleSelectImage = async () => {
    const path = await window.api.dialog.openImage()
    if (path) {
      updateForm('backgroundImage', path)
    }
  }

  if (!open) return null

  const inputClass = 'w-full px-2.5 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-gray-200 focus:outline-none focus:border-blue-500'
  const selectClass = 'w-full px-2.5 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-gray-200 focus:outline-none focus:border-blue-500'
  const labelClass = 'block text-xs text-gray-400 mb-1.5'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={handleClose}
      onKeyDown={handleKeyDown}
    >
      <div
        className="bg-gray-800 rounded-lg shadow-xl w-[640px] max-h-[80vh] border border-gray-600 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700 shrink-0">
          <h2 className="text-base font-medium text-gray-200">全局选项</h2>
          <button
            onClick={handleClose}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-600 text-gray-400 hover:text-white transition-colors"
          >
            ✕
          </button>
        </div>

        {/* 主体：左侧导航 + 右侧内容 */}
        <div className="flex flex-1 min-h-0">
          {/* 左侧导航 */}
          <div className="w-32 shrink-0 border-r border-gray-700 py-3 px-2 space-y-0.5">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`w-full text-left px-3 py-1.5 rounded text-sm transition-colors ${
                  activeTab === tab.key
                    ? 'bg-blue-600/20 text-blue-400'
                    : 'text-gray-400 hover:bg-gray-700/50 hover:text-gray-300'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* 右侧内容 */}
          <div className="flex-1 px-6 py-5 overflow-y-auto">
            {/* 外观 */}
            {activeTab === 'appearance' && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-sm font-medium text-gray-200 mb-4">字体</h3>
                  <div className="space-y-4">
                    <div ref={fontDropdownRef}>
                      <label className={labelClass}>字体</label>
                      <div className="relative">
                        <input
                          type="text"
                          value={fontDropdownOpen ? fontFilter : form.fontFamily.split(',')[0].replace(/^['"]|['"]$/g, '').trim()}
                          onChange={(e) => {
                            if (!fontDropdownOpen) setFontDropdownOpen(true)
                            setFontFilter(e.target.value)
                          }}
                          onFocus={() => {
                            setFontDropdownOpen(true)
                            if (systemFonts === null) {
                              window.api.app.getSystemFonts().then((fonts) => setSystemFonts(fonts)).catch(() => setSystemFonts([]))
                            }
                          }}
                          placeholder="输入过滤字体..."
                          className={inputClass}
                        />
                        {fontDropdownOpen && (
                          <div className="absolute z-10 left-0 right-0 top-full mt-1 bg-gray-700 border border-gray-600 rounded shadow-lg max-h-48 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                            {systemFonts ? (
                              systemFonts
                                .filter((f) => !fontFilter || f.toLowerCase().includes(fontFilter.toLowerCase()))
                                .map((f) => (
                                  <div
                                    key={f}
                                    className={`px-2.5 py-1 text-sm cursor-pointer truncate ${f === form.fontFamily ? 'bg-blue-600 text-white' : 'text-gray-200 hover:bg-gray-600'}`}
                                    title={f}
                                    onClick={() => {
                                      updateForm('fontFamily', f)
                                      setFontDropdownOpen(false)
                                      setFontFilter('')
                                    }}
                                  >
                                    {f}
                                  </div>
                                ))
                            ) : (
                              <div className="px-2.5 py-1 text-sm text-gray-400">加载字体列表中...</div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-4">
                      <div>
                        <label className={labelClass}>字号</label>
                        <input
                          type="number"
                          value={form.fontSize}
                          onChange={(e) => updateForm('fontSize', Math.max(6, Math.min(72, Number(e.target.value) || 14)))}
                          className={inputClass}
                          min={6}
                          max={72}
                        />
                      </div>
                      <div>
                        <label className={labelClass}>行高</label>
                        <input
                          type="number"
                          value={form.lineHeight}
                          onChange={(e) => updateForm('lineHeight', Math.max(0.5, Math.min(3, Number(e.target.value) || 1)))}
                          className={inputClass}
                          min={0.5}
                          max={3}
                          step={0.1}
                        />
                      </div>
                      <div>
                        <label className={labelClass}>字间距</label>
                        <input
                          type="number"
                          value={form.letterSpacing}
                          onChange={(e) => updateForm('letterSpacing', Math.max(-10, Math.min(20, Number(e.target.value) || 0)))}
                          className={inputClass}
                          min={-10}
                          max={20}
                          step={1}
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className={labelClass}>粗细</label>
                        <select
                          value={form.fontWeight}
                          onChange={(e) => updateForm('fontWeight', e.target.value)}
                          className={selectClass}
                        >
                          {FONT_WEIGHT_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className={labelClass}>粗体</label>
                        <select
                          value={form.fontWeightBold}
                          onChange={(e) => updateForm('fontWeightBold', e.target.value)}
                          className={selectClass}
                        >
                          {FONT_WEIGHT_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>
                </div>
                <div>
                  <h3 className="text-sm font-medium text-gray-200 mb-4">颜色</h3>
                  <div className="space-y-4">
                    <div>
                      <label className={labelClass}>背景色</label>
                      <div className="flex items-center gap-3">
                        <input
                          type="color"
                          value={form.background}
                          onChange={(e) => updateForm('background', e.target.value)}
                          className="w-8 h-8 rounded border border-gray-600 bg-transparent cursor-pointer p-0"
                        />
                        <input
                          type="text"
                          value={form.background}
                          onChange={(e) => updateForm('background', e.target.value)}
                          className={inputClass + ' flex-1'}
                          spellCheck={false}
                        />
                      </div>
                    </div>
                    <div>
                      <label className={labelClass}>字体颜色</label>
                      <div className="flex items-center gap-3">
                        <input
                          type="color"
                          value={form.foreground}
                          onChange={(e) => updateForm('foreground', e.target.value)}
                          className="w-8 h-8 rounded border border-gray-600 bg-transparent cursor-pointer p-0"
                        />
                        <input
                          type="text"
                          value={form.foreground}
                          onChange={(e) => updateForm('foreground', e.target.value)}
                          className={inputClass + ' flex-1'}
                          spellCheck={false}
                        />
                      </div>
                    </div>
                  </div>
                </div>
                <div>
                  <h3 className="text-sm font-medium text-gray-200 mb-4">背景图片</h3>
                  <div className="space-y-4">
                    <div>
                      <label className={labelClass}>图片路径</label>
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={form.backgroundImage}
                          onChange={(e) => updateForm('backgroundImage', e.target.value)}
                          className={inputClass + ' flex-1'}
                          spellCheck={false}
                          placeholder="选择或输入图片路径"
                        />
                        <button
                          onClick={handleSelectImage}
                          className="shrink-0 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm text-gray-300 transition-colors"
                        >
                          浏览
                        </button>
                        {form.backgroundImage && (
                          <button
                            onClick={() => updateForm('backgroundImage', '')}
                            className="shrink-0 px-2 py-1.5 text-sm text-gray-500 hover:text-gray-300 transition-colors"
                          >
                            清除
                          </button>
                        )}
                      </div>
                    </div>
                    <div>
                      <label className={labelClass}>不透明度 {Math.round(form.backgroundOpacity * 100)}%</label>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={form.backgroundOpacity}
                        onChange={(e) => updateForm('backgroundOpacity', Number(e.target.value))}
                        className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* 光标 */}
            {activeTab === 'cursor' && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-sm font-medium text-gray-200 mb-4">光标样式</h3>
                  <div className="space-y-4">
                    <div>
                      <label className={labelClass}>样式</label>
                      <div className="flex gap-2">
                        {CURSOR_STYLE_OPTIONS.map((opt) => (
                          <button
                            key={opt.value}
                            onClick={() => updateForm('cursorStyle', opt.value as AppSettings['cursorStyle'])}
                            className={`px-4 py-1.5 rounded text-sm transition-colors ${
                              form.cursorStyle === opt.value
                                ? 'bg-blue-600 text-white'
                                : 'bg-gray-700 text-gray-400 hover:bg-gray-600 hover:text-gray-300'
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <label className="flex items-center gap-2.5 cursor-pointer group">
                      <input
                        type="checkbox"
                        checked={form.cursorBlink}
                        onChange={(e) => updateForm('cursorBlink', e.target.checked)}
                        className="w-4 h-4 rounded border-gray-500 bg-gray-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-0 cursor-pointer"
                      />
                      <span className="text-sm text-gray-300 group-hover:text-gray-200 transition-colors select-none">
                        光标闪烁
                      </span>
                    </label>
                  </div>
                </div>
              </div>
            )}

            {/* 滚动 */}
            {activeTab === 'scroll' && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-sm font-medium text-gray-200 mb-4">滚动设置</h3>
                  <div className="space-y-4">
                    <div>
                      <label className={labelClass}>回滚行数</label>
                      <input
                        type="number"
                        value={form.scrollback}
                        onChange={(e) => updateForm('scrollback', Math.max(0, Math.min(100000, Number(e.target.value) || 1000)))}
                        className={inputClass}
                        min={0}
                        max={100000}
                        step={100}
                      />
                      <p className="mt-1.5 text-xs text-gray-500">0 = 无回滚</p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* 鼠标/粘贴 */}
            {activeTab === 'mouse' && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-sm font-medium text-gray-200 mb-4">鼠标行为</h3>
                  <div className="space-y-4">
                    <label className="flex items-center gap-2.5 cursor-pointer group">
                      <input
                        type="checkbox"
                        checked={form.rightClickPaste}
                        onChange={(e) => updateForm('rightClickPaste', e.target.checked)}
                        className="w-4 h-4 rounded border-gray-500 bg-gray-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-0 cursor-pointer"
                      />
                      <span className="text-sm text-gray-300 group-hover:text-gray-200 transition-colors select-none">
                        鼠标右键支持复制/粘贴
                      </span>
                    </label>
                    <p className="ml-6 text-xs text-gray-500">
                      勾选后，鼠标右键不再显示菜单。选中文本时右键复制，未选中文本时右键粘贴
                    </p>
                  </div>
                </div>
                <div className="border-t border-gray-700 pt-5">
                  <h3 className="text-sm font-medium text-gray-200 mb-4">粘贴行为</h3>
                  <div className="space-y-4">
                    <label className="flex items-center gap-2.5 cursor-pointer group">
                      <input
                        type="checkbox"
                        checked={form.trimPaste}
                        onChange={(e) => updateForm('trimPaste', e.target.checked)}
                        className="w-4 h-4 rounded border-gray-500 bg-gray-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-0 cursor-pointer"
                      />
                      <span className="text-sm text-gray-300 group-hover:text-gray-200 transition-colors select-none">
                        单行粘贴去除尾部空白
                      </span>
                    </label>
                    <p className="ml-6 text-xs text-gray-500">
                      从编辑器复制单行命令粘贴到终端时，去除末尾的换行符和空格，防止命令意外执行
                    </p>
                    <div>
                      <span className="text-sm text-gray-300 block mb-2">多行粘贴警告</span>
                      <div className="flex gap-2">
                        {([
                          { value: 'always', label: '总是' },
                          { value: 'auto', label: '自动' },
                          { value: 'never', label: '从不' }
                        ] as const).map((opt) => (
                          <button
                            key={opt.value}
                            onClick={() => updateForm('multiLinePasteWarning', opt.value)}
                            className={`px-3 py-1.5 text-sm rounded transition-colors ${
                              form.multiLinePasteWarning === opt.value
                                ? 'bg-blue-600 text-white'
                                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                      <p className="mt-2 text-xs text-gray-500">
                        粘贴多行内容时是否弹出确认。"自动"仅在远端不支持括号粘贴模式时警告
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* 配置模板 */}
            {activeTab === 'profiles' && (
              <ProfileManager open={open} onClose={onClose} embedded />
            )}
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-gray-700 shrink-0">
          <button
            onClick={handleResetDefaults}
            className="px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors"
          >
            恢复默认
          </button>
          <div className="flex gap-3">
            <button
              onClick={handleClose}
              className="px-4 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm text-gray-300 transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 rounded text-sm text-white transition-colors"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default GlobalOptionsDialog
