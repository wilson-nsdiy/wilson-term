import React, { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store'
import type { SessionStatus, ConnectionConfig } from '@shared/types'
import { resolveLogConfig } from '../utils/logConfig'
import { resolveSettings } from '../utils/settingsResolver'
import { buildFontFamily } from '../utils/font'
import { filterPasteText, shouldWarnMultiLinePaste, countPasteLines, isVtMouseModeEnabled } from '../utils/pasteFilter'
import { rendererPluginHost } from '@renderer/plugin-host.ts'
import TerminalContextMenu from './TerminalContextMenu'
import TerminalStatusBar from './TerminalStatusBar'
import MultiLinePasteDialog from './MultiLinePasteDialog'
import '@xterm/xterm/css/xterm.css'

interface TerminalInstanceProps {
  /** 会话 ID */
  sessionId: string
  /** 是否当前可见 */
  visible: boolean
}

const TerminalInstance: React.FC<TerminalInstanceProps> = ({ sessionId, visible }) => {
  const terminalRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  /** 数据订阅的取消函数 */
  const unsubscribeRef = useRef<(() => void) | null>(null)
  /** xterm 输入监听的销毁函数 */
  const inputDisposableRef = useRef<{ dispose: () => void } | null>(null)
  /** 连接状态监听的取消函数 */
  const statusUnsubscribeRef = useRef<(() => void) | null>(null)
  /** 断开后重连输入监听的销毁函数 */
  const reconnectDisposableRef = useRef<{ dispose: () => void } | null>(null)

  /** 右键菜单状态 */
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    visible: boolean
  }>({ x: 0, y: 0, visible: false })

  /** 是否有选中文本 */
  const [hasSelection, setHasSelection] = useState(false)

  /** 多行粘贴确认弹窗 */
  const [multiLinePaste, setMultiLinePaste] = useState<{
    open: boolean
    lineCount: number
    preview: string
    pendingText: string
  }>({ open: false, lineCount: 0, preview: '', pendingText: '' })

  /** 右键粘贴模式开关（用 ref 同步以避免闭包陈旧值问题） */
  const rightClickPasteRef = useRef(useAppStore.getState().settings.rightClickPaste)

  const settings = useAppStore((state) => state.settings)
  const profiles = useAppStore((state) => state.profiles)
  const updateSessionStatus = useAppStore((state) => state.updateSessionStatus)
  const updateKeyboardLockState = useAppStore((state) => state.updateKeyboardLockState)
  const { commandInputVisible, buttonBarVisible, statusBarVisible, sidebarOpen } = useAppStore(
    useShallow((state) => ({
      commandInputVisible: state.commandInputVisible,
      buttonBarVisible: state.buttonBarVisible,
      statusBarVisible: state.statusBarVisible,
      sidebarOpen: state.sidebarOpen
    }))
  )
  const { sessionStatus, sessionErrorMessage, sessionConfig, sessionProfileId, sessionOverrides } = useAppStore(
    useShallow((state) => {
      const s = state.sessions.find((s) => s.id === sessionId)
      return {
        sessionStatus: s?.status,
        sessionErrorMessage: s?.errorMessage,
        sessionConfig: s?.config,
        sessionProfileId: s?.profileId,
        sessionOverrides: s?.overrides
      }
    })
  )

  const profile = useAppStore((state) =>
    sessionProfileId ? state.profiles.find((p) => p.id === sessionProfileId) : undefined
  )
  const resolved = resolveSettings(settings, profile, sessionOverrides)

  /** 绑定统一连接数据流到 xterm */
  const bindConnection = useCallback((sid: string, xterm: XTerm) => {
    // 订阅连接数据，写入 xterm
    const unsub = window.api.connection.onData((dataSid, data) => {
      if (dataSid === sid && xtermRef.current) {
        const { sessions } = useAppStore.getState()
        if (sessions.some((s) => s.id === dataSid)) {
          rendererPluginHost.feedOutput(sid, data)
          xtermRef.current.write(data)
        }
      }
    })
    unsubscribeRef.current = unsub

    // 监听 xterm 用户输入，发送到连接
    const inputDisposable = xterm.onData((data) => {
      rendererPluginHost.feedInput(sid, data)
      window.api.connection.write(sid, data)
    })
    inputDisposableRef.current = inputDisposable

    // 监听连接状态变化
    const statusUnsub = window.api.connection.onStatus((statusSid, status, errMsg) => {
      if (statusSid === sid) {
        updateSessionStatus(sid, status as SessionStatus)
        if (errMsg) {
          useAppStore.getState().writeSessionError(sid, errMsg)
        }
        if (status === 'disconnected' && xtermRef.current) {
          xtermRef.current.writeln('\r\n\x1b[31m连接已断开\x1b[0m')
          xtermRef.current.writeln('\x1b[33m按 R 键重新连接\x1b[0m')
        }
      }
    })
    statusUnsubscribeRef.current = statusUnsub

    // 监听 xterm 尺寸变化，通知 SSH/Telnet 调整 PTY（串口不需要）
    const config = useAppStore.getState().sessions.find((s) => s.id === sid)?.config
    if (config && config.type !== 'serial') {
      const resizeDisposable = xterm.onResize(({ cols, rows }) => {
        window.api.connection.resize(sid, cols, rows)
      })
      return resizeDisposable
    }
    return undefined
  }, [updateSessionStatus])

  /** 解绑数据流 */
  const unbindData = useCallback(() => {
    if (unsubscribeRef.current) {
      unsubscribeRef.current()
      unsubscribeRef.current = null
    }
    if (inputDisposableRef.current) {
      inputDisposableRef.current.dispose()
      inputDisposableRef.current = null
    }
    if (statusUnsubscribeRef.current) {
      statusUnsubscribeRef.current()
      statusUnsubscribeRef.current = null
    }
    if (reconnectDisposableRef.current) {
      reconnectDisposableRef.current.dispose()
      reconnectDisposableRef.current = null
    }
  }, [])

  // 创建 xterm 实例（仅在挂载时）
  useEffect(() => {
    if (!terminalRef.current) return

    const xterm = new XTerm({
      allowProposedApi: true,
      allowTransparency: true,
      cursorBlink: resolved.cursorBlink,
      cursorStyle: resolved.cursorStyle,
      fontSize: resolved.fontSize,
      fontFamily: buildFontFamily(resolved.fontFamily),
      fontWeight: resolved.fontWeight as any,
      fontWeightBold: resolved.fontWeightBold as any,
      lineHeight: resolved.lineHeight,
      letterSpacing: resolved.letterSpacing,
      scrollback: resolved.scrollback,
      drawBoldTextInBrightColors: true,
      theme: {
        background: '#00000000',
        foreground: resolved.foreground,
        cursor: '#f5e0dc',
        selectionBackground: '#585b70',
        black: '#45475a',
        red: '#f38ba8',
        green: '#a6e3a1',
        yellow: '#f9e2af',
        blue: '#89b4fa',
        magenta: '#f5c2e7',
        cyan: '#94e2d5',
        white: '#bac2de',
        brightBlack: '#585b70',
        brightRed: '#f38ba8',
        brightGreen: '#a6e3a1',
        brightYellow: '#f9e2af',
        brightBlue: '#89b4fa',
        brightMagenta: '#f5c2e7',
        brightCyan: '#94e2d5',
        brightWhite: '#a6adc8'
      }
    })

    const fitAddon = new FitAddon()
    const searchAddon = new SearchAddon()
    const unicode11Addon = new Unicode11Addon()

    xterm.loadAddon(fitAddon)
    xterm.loadAddon(searchAddon)
    xterm.loadAddon(unicode11Addon)
    xterm.unicode.activeVersion = '11'

    xterm.open(terminalRef.current)
    fitAddon.fit()

    // #5881: DOM 渲染器在 .xterm-rows 上设了 aria-hidden，终端输出对屏幕阅读器不可见。
    // 该缺陷在 v5.5.0 与 v6.0.0 均存在（上游 open 未修），运行时移除即可，无可见副作用。
    xterm.element?.querySelector('.xterm-rows')?.removeAttribute('aria-hidden')

    if (resolved.backgroundImage) {
      xterm.element?.classList.add('xterm-bg-image')
    }

    xtermRef.current = xterm
    fitAddonRef.current = fitAddon
    searchAddonRef.current = searchAddon

    // 注册 OSC 52 剪贴板协议处理（TUI 程序如 vim/tmux/opencode 通过此协议请求写入系统剪贴板）
    // 格式: ESC ] 52 ; c ; <base64> ST
    xterm.parser.registerOscHandler(52, (data: string) => {
      const semicolonIdx = data.indexOf(';')
      if (semicolonIdx === -1) return true
      const clipboard = data.slice(0, semicolonIdx)
      const payload = data.slice(semicolonIdx + 1)
      if (payload === '?' || !payload) return true
      // 仅处理系统剪贴板选择器 (c)，忽略 X11 主/次选择 (p/s)
      if (clipboard !== 'c') return true
      try {
        // atob 解码为 Latin1 字节串，再转 UTF-8 字节序列，最后解码为 UTF-16 字符串
        const latin1 = atob(payload)
        const bytes = new Uint8Array(latin1.length)
        for (let i = 0; i < latin1.length; i++) bytes[i] = latin1.charCodeAt(i)
        const decoded = new TextDecoder().decode(bytes)
        navigator.clipboard.writeText(decoded).catch((err) => {
          console.warn('OSC 52: 剪贴板写入失败', err)
        })
      } catch {
        // base64 解码失败，忽略
      }
      return true
    })

    // 监听搜索结果变化，通知搜索栏
    const searchResultDisposable = searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
      const resultEvent = new CustomEvent('terminal:searchResult', {
        detail: { resultIndex, resultCount }
      })
      window.dispatchEvent(resultEvent)
    })

    // 监听选中状态变化
    const selectionChangeDisposable = xterm.onSelectionChange(() => {
      setHasSelection(xterm.getSelection().length > 0)
    })

    // 监听右键菜单事件
    const handleContextMenu = (e: MouseEvent) => {
      // VT 鼠标模式下：右键事件交给远端程序处理，终端自己不做复制/粘贴
      // 按住 Shift 可强制使用终端自己的右键行为
      if (isVtMouseModeEnabled(xterm) && !e.shiftKey) {
        // 不 preventDefault，让 xterm.js 自己处理 VT 鼠标事件转发
        return
      }

      e.preventDefault()

      // 如果启用了右键粘贴模式：选中时复制，未选中时粘贴
      if (rightClickPasteRef.current) {
        const selection = xterm.getSelection()
        if (selection) {
          // 有选中文本 → 复制
          navigator.clipboard.writeText(selection)
          xterm.clearSelection()
        } else {
          // 未选中文本 → 粘贴（经过过滤管线 + 多行警告）
          navigator.clipboard.readText().then((rawText) => {
            if (!rawText) return
            if (shouldWarnMultiLinePaste(rawText, xterm)) {
              setMultiLinePaste({
                open: true,
                lineCount: countPasteLines(rawText),
                preview: rawText.replace(/\r\n/g, '\n'),
                pendingText: rawText
              })
            } else {
              xterm.paste(filterPasteText(rawText))
            }
          }).catch(console.error)
        }
        return
      }

      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        visible: true
      })
    }
    terminalRef.current.addEventListener('contextmenu', handleContextMenu)

    // 窗口大小变化时自适应
    const handleResize = () => {
      fitAddon.fit()
    }
    window.addEventListener('resize', handleResize)

    // composition 光标靠右溢出修复（对齐 xterm 7.0 官方 #5747）：overflow/direction:rtl 在 CSS，MO 补动态 maxWidth
    const xtermElement = xterm.element
    const compositionView = xtermElement?.querySelector<HTMLElement>('.composition-view')

    const constrainComposition = () => {
      if (!xtermElement || !compositionView) return
      const cs = getComputedStyle(xtermElement)
      const availWidth =
        xtermElement.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0)
      if (availWidth <= 0) return
      const currentLeft = parseFloat(compositionView.style.left) || 0
      const maxWidth = availWidth - currentLeft
      if (maxWidth > 0) {
        compositionView.style.maxWidth = `${maxWidth}px`
      }
    }

    // xterm 在 compositionupdate 时同步定位并 setTimeout 递归一次；MO 在每次重定位后（绘制前）补设 maxWidth
    const compositionMo = compositionView
      ? new MutationObserver(() => constrainComposition())
      : null
    compositionMo?.observe(compositionView, { attributes: true, attributeFilter: ['style'] })

    const handleCompositionEnd = () => fitAddon.fit()
    xtermElement?.addEventListener('compositionend', handleCompositionEnd)

    return () => {
      window.removeEventListener('resize', handleResize)
      xtermElement?.removeEventListener('compositionend', handleCompositionEnd)
      compositionMo?.disconnect()
      terminalRef.current?.removeEventListener('contextmenu', handleContextMenu)
      selectionChangeDisposable.dispose()
      searchResultDisposable.dispose()
      unbindData()
      xterm.dispose()
      xtermRef.current = null
      fitAddonRef.current = null
      searchAddonRef.current = null
    }
  }, []) // 仅在挂载时创建 xterm 实例

  // 绑定会话数据流（挂载时绑定，卸载时解绑）
  useEffect(() => {
    const xterm = xtermRef.current
    if (!xterm) return

    const currentSession = useAppStore.getState().sessions.find((s) => s.id === sessionId)
    if (!currentSession) return

    bindConnection(currentSession.id, xterm)

    return () => {
      unbindData()
    }
  }, [sessionId]) // 当 sessionId 变化时重新绑定（实际不会变，但确保安全）

  // 键盘锁状态订阅：仅在状态栏可见时订阅，避免不必要的 IPC 和状态更新
  useEffect(() => {
    if (!statusBarVisible) return

    window.api.keyboard.getLockState().then((state) => {
      updateKeyboardLockState(sessionId, state)
    })
    const unsubKeyboard = window.api.keyboard.onLockStateChanged((state) => {
      updateKeyboardLockState(sessionId, state)
    })

    return () => {
      unsubKeyboard()
    }
  }, [sessionId, statusBarVisible])

  // 监听 session 状态变化，在终端中显示连接/成功/错误/断开信息
  // 断开或错误时注册 R 键重连监听
  useEffect(() => {
    const xterm = xtermRef.current
    if (!xterm || !sessionStatus || !sessionConfig) return

    // 清除之前的重连监听
    if (reconnectDisposableRef.current) {
      reconnectDisposableRef.current.dispose()
      reconnectDisposableRef.current = null
    }

    if (sessionStatus === 'connecting') {
      if (sessionConfig.type === 'serial') {
        xterm.writeln(`\x1b[32m正在打开串口 ${sessionConfig.path} (${sessionConfig.baudRate}bps)...\x1b[0m`)
      } else if (sessionConfig.type === 'ssh') {
        xterm.writeln(`\x1b[34m正在连接 ${sessionConfig.username}@${sessionConfig.host}:${sessionConfig.port}...\x1b[0m`)
      } else if (sessionConfig.type === 'telnet') {
        xterm.writeln(`\x1b[35m正在连接 Telnet ${sessionConfig.host}:${sessionConfig.port}...\x1b[0m`)
      } else if (sessionConfig.type === 'bash') {
        xterm.writeln(`\x1b[33m正在启动本地终端...\x1b[0m`)
      }
    } else if (sessionStatus === 'connected') {
      // 连接成功后，主动同步终端真实尺寸到 PTY（串口不需要）
      if (sessionConfig.type !== 'serial') {
        window.api.connection.resize(sessionId, xterm.cols, xterm.rows)
      }
      if (sessionConfig.type === 'serial') {
        xterm.writeln(`\x1b[32m串口 ${sessionConfig.path} 已成功打开\x1b[0m`)
      } else if (sessionConfig.type === 'ssh') {
        xterm.writeln(`\x1b[32m已成功连接到 ${sessionConfig.username}@${sessionConfig.host}:${sessionConfig.port}\x1b[0m`)
      } else if (sessionConfig.type === 'telnet') {
        xterm.writeln(`\x1b[32m已成功连接到 Telnet ${sessionConfig.host}:${sessionConfig.port}\x1b[0m`)
      } else if (sessionConfig.type === 'bash') {
        xterm.writeln(`\x1b[32m本地终端已启动\x1b[0m`)
      }
    } else if (sessionStatus === 'error' && sessionErrorMessage) {
      xterm.writeln(`\r\n\x1b[31m连接失败: ${sessionErrorMessage}\x1b[0m`)
      xterm.writeln(`\x1b[33m按 R 键重新连接\x1b[0m`)
    }

    // 断开或错误状态时注册 R 键重连监听
    if (sessionStatus === 'disconnected' || sessionStatus === 'error') {
      const config = sessionConfig
      reconnectDisposableRef.current = xterm.onData((data) => {
        if (data === 'R' || data === 'r') {
          if (reconnectDisposableRef.current) {
            reconnectDisposableRef.current.dispose()
            reconnectDisposableRef.current = null
          }
          rendererPluginHost.notifySessionReconnect(sessionId)
          updateSessionStatus(sessionId, 'connecting')
          const resolvedLogConfig = resolveLogConfig(config.logConfig, useAppStore.getState().settings)
          const doConnect = async () => {
            // 先尝试在现有连接上重新打开（SSH 可复用底层连接，无需重新认证）
            try {
              await window.api.connection.reopen(sessionId)
              // reopen 成功后同步终端尺寸到新 shell
              if (config.type !== 'serial') {
                window.api.connection.resize(sessionId, xterm.cols, xterm.rows)
              }
              updateSessionStatus(sessionId, 'connected')
              return
            } catch {
              // reopen 失败（连接类型不支持或客户端已断开），回退到完整重连
            }
            try {
              await window.api.connection.disconnect(sessionId)
            } catch {
              // 旧会话可能已不存在，忽略
            }
            try {
              config.id = sessionId
              await window.api.connection.connect(config, resolvedLogConfig)
              updateSessionStatus(sessionId, 'connected')
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err)
              useAppStore.getState().writeSessionError(sessionId, message)
            }
          }
          doConnect()
        }
      })
    }
  }, [sessionStatus, sessionErrorMessage])

  // 当 visible 变为 true 或 commandInputVisible 变化时，重新适配终端尺寸
  useEffect(() => {
    if (visible) {
      // 延迟一帧确保 DOM 已显示
      requestAnimationFrame(() => {
        fitAddonRef.current?.fit()
        xtermRef.current?.focus()
      })
    }
  }, [visible, commandInputVisible, statusBarVisible, buttonBarVisible, sidebarOpen])

  // 字体/外观设置变化时更新 xterm
  useEffect(() => {
    const xterm = xtermRef.current
    if (!xterm) return
    const r = resolveSettings(settings, profile, sessionOverrides)
    xterm.options.fontSize = r.fontSize
    xterm.options.fontFamily = buildFontFamily(r.fontFamily)
    xterm.options.fontWeight = r.fontWeight as any
    xterm.options.fontWeightBold = r.fontWeightBold as any
    xterm.options.lineHeight = r.lineHeight
    xterm.options.letterSpacing = r.letterSpacing
    xterm.options.cursorStyle = r.cursorStyle
    xterm.options.cursorBlink = r.cursorBlink
    xterm.options.scrollback = r.scrollback
    if (xterm.options.theme) {
      xterm.options.theme = { ...xterm.options.theme, background: r.backgroundImage ? '#00000000' : r.background, foreground: r.foreground }
    }
    fitAddonRef.current?.fit()
  }, [settings.fontSize, settings.fontFamily, settings.fontWeight, settings.fontWeightBold, settings.lineHeight, settings.letterSpacing, settings.cursorStyle, settings.cursorBlink, settings.scrollback, settings.background, settings.foreground, sessionProfileId, sessionOverrides, profiles])

  /** 背景图片 data URL 缓存 */
  const [bgImageDataURL, setBgImageDataURL] = useState<string | null>(null)

  // 同步背景色 CSS 变量（供 .xterm-viewport 使用）
  useEffect(() => {
    document.documentElement.style.setProperty('--term-bg', resolved.background)
  }, [resolved.background])

  // 加载背景图片为 data URL
  useEffect(() => {
    if (resolved.backgroundImage) {
      window.api.dialog.readImageAsDataURL(resolved.backgroundImage).then((url) => {
        setBgImageDataURL(url)
      }).catch(() => setBgImageDataURL(null))
    } else {
      setBgImageDataURL(null)
    }
  }, [resolved.backgroundImage])

  // 背景图片变化时同步 xterm class
  useEffect(() => {
    const el = xtermRef.current?.element
    if (!el) return
    if (resolved.backgroundImage) {
      el.classList.add('xterm-bg-image')
    } else {
      el.classList.remove('xterm-bg-image')
    }
  }, [resolved.backgroundImage])

  // 同步右键粘贴模式到 ref（供 contextmenu 事件使用）
  useEffect(() => {
    rightClickPasteRef.current = resolved.rightClickPaste
  }, [resolved.rightClickPaste])

  // 监听搜索事件
  useEffect(() => {
    const handleSearch = (e: Event) => {
      const searchAddon = searchAddonRef.current
      if (!searchAddon) return
      const { sessionId: targetSessionId, action, searchText, matchCase, matchRegex } = (e as CustomEvent).detail
      if (targetSessionId !== sessionId) return

      if (action === 'clear') {
        searchAddon.clearDecorations()
        searchAddon.clearActiveDecoration()
        return
      }

      const options: { regex?: boolean; wholeWord?: boolean; caseSensitive?: boolean; incremental?: boolean; decorations?: { matchBackground: string; activeMatchBackground: string; matchOverviewRuler: string; activeMatchColorOverviewRuler: string } } = {}
      if (matchCase) options.caseSensitive = true
      if (matchRegex) options.regex = true
      if (action === 'init') options.incremental = true
      options.decorations = {
        matchBackground: '#585b70',
        activeMatchBackground: '#f9e2af',
        matchOverviewRuler: '#585b70',
        activeMatchColorOverviewRuler: '#f9e2af'
      }

      if (action === 'init' || action === 'next') {
        searchAddon.findNext(searchText, options)
      } else if (action === 'prev') {
        searchAddon.findPrevious(searchText, options)
      }
    }

    window.addEventListener('terminal:search', handleSearch)
    return () => window.removeEventListener('terminal:search', handleSearch)
  }, [sessionId])

  // 监听菜单栏粘贴事件
  useEffect(() => {
    const handleMenuPaste = (e: Event) => {
      const { sessionId: targetId, text: rawText } = (e as CustomEvent).detail
      if (targetId !== sessionId || !rawText) return
      const xterm = xtermRef.current
      if (shouldWarnMultiLinePaste(rawText, xterm)) {
        setMultiLinePaste({
          open: true,
          lineCount: countPasteLines(rawText),
          preview: rawText.replace(/\r\n/g, '\n'),
          pendingText: rawText
        })
      } else if (xterm) {
        xterm.paste(filterPasteText(rawText))
      }
    }

    window.addEventListener('terminal:paste', handleMenuPaste)
    return () => window.removeEventListener('terminal:paste', handleMenuPaste)
  }, [sessionId])

  /** 复制选中文本到剪贴板 */
  const handleCopy = useCallback(() => {
    const xterm = xtermRef.current
    if (!xterm) return
    const selection = xterm.getSelection()
    if (selection) {
      navigator.clipboard.writeText(selection)
    }
  }, [])

  /** 从剪贴板粘贴文本到终端（经过过滤管线 + 多行警告） */
  const handlePaste = useCallback(async () => {
    try {
      const rawText = await navigator.clipboard.readText()
      if (!rawText) return
      const xterm = xtermRef.current
      if (shouldWarnMultiLinePaste(rawText, xterm)) {
        setMultiLinePaste({
          open: true,
          lineCount: countPasteLines(rawText),
          preview: rawText.replace(/\r\n/g, '\n'),
          pendingText: rawText
        })
      } else if (xterm) {
        xterm.paste(filterPasteText(rawText))
      }
    } catch (err) {
      console.error('粘贴失败:', err)
    }
  }, [])

  // 弹窗打开时让 xterm 失焦，防止键盘事件穿透到终端
  // 只在弹窗打开前终端有焦点时才恢复焦点，避免抢夺用户已切换的焦点
  const hadFocusRef = useRef(false)
  useEffect(() => {
    if (multiLinePaste.open) {
      hadFocusRef.current = xtermRef.current?.element?.contains(document.activeElement) ?? false
      xtermRef.current?.blur()
    } else if (hadFocusRef.current) {
      xtermRef.current?.focus()
      hadFocusRef.current = false
    }
  }, [multiLinePaste.open])

  /** 多行粘贴确认 */
  const handleMultiLinePasteConfirm = useCallback(() => {
    const xterm = xtermRef.current
    if (xterm) xterm.paste(filterPasteText(multiLinePaste.pendingText))
    setMultiLinePaste({ open: false, lineCount: 0, preview: '', pendingText: '' })
  }, [multiLinePaste.pendingText])

  /** 多行粘贴取消 */
  const handleMultiLinePasteCancel = useCallback(() => {
    setMultiLinePaste({ open: false, lineCount: 0, preview: '', pendingText: '' })
  }, [])

  /** 关闭右键菜单 */
  const handleCloseContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false }))
  }, [])

  return (
    <div
      className="w-full h-full absolute inset-0"
      style={{ display: visible ? 'block' : 'none' }}
    >
      {bgImageDataURL && (
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{
            backgroundImage: `url(${bgImageDataURL})`,
            bottom: (commandInputVisible ? 28 : 0) + (buttonBarVisible ? 28 : 0) + (statusBarVisible ? 24 : 0) + 'px'
          }}
        />
      )}
      <div
        className="absolute inset-0"
        style={{
          backgroundColor: resolved.background,
          opacity: resolved.backgroundOpacity,
          bottom: (commandInputVisible ? 28 : 0) + (buttonBarVisible ? 28 : 0) + (statusBarVisible ? 24 : 0) + 'px'
        }}
      />
      <div
        ref={terminalRef}
        className="absolute inset-0 overflow-hidden"
        style={{
          bottom: (commandInputVisible ? 28 : 0) + (buttonBarVisible ? 28 : 0) + (statusBarVisible ? 24 : 0) + 'px'
        }}
      />
      {statusBarVisible && <TerminalStatusBar sessionId={sessionId} />}
      <TerminalContextMenu
        x={contextMenu.x}
        y={contextMenu.y}
        hasSelection={hasSelection}
        visible={contextMenu.visible}
        onCopy={handleCopy}
        onPaste={handlePaste}
        onClose={handleCloseContextMenu}
      />
      <MultiLinePasteDialog
        open={multiLinePaste.open}
        lineCount={multiLinePaste.lineCount}
        preview={multiLinePaste.preview}
        onConfirm={handleMultiLinePasteConfirm}
        onCancel={handleMultiLinePasteCancel}
      />
    </div>
  )
}

export default TerminalInstance
