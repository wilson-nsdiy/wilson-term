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
import { computeSearchMatchInfo } from '../utils/searchMatch'
import { FlowControl, PinnedScroll, RendererManager, patchRenderServiceDimensions, safeFit } from '../utils/xtermEnhancements'
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
  /**
   * 自管理的搜索匹配高亮 decoration 销毁函数集合。
   *
   * 不依赖 xterm SearchAddon 的 _highlightAllMatches：该方法内部去重循环
   * `while (result && (prevResult?.row !== result.row || prevResult?.col !== result.col))`
   * 在匹配项位于行尾或跨 wrap 边界时会提前退出，导致只高亮第一个匹配。
   * 这里根据 computeSearchMatchInfo 返回的完整匹配列表，自行通过
   * registerDecoration 为每个匹配创建 matchBackground 高亮。
   */
  const searchHighlightDisposablesRef = useRef<Array<() => void>>([])
  /** 清理并重置自管理的搜索高亮 decoration（每项调用包 try/catch，避免单次失败跳过其余） */
  const disposeSearchHighlights = () => {
    for (const d of searchHighlightDisposablesRef.current) {
      try { d() } catch { /* 已随 xterm.dispose() 销毁 */ }
    }
    searchHighlightDisposablesRef.current = []
  }
  /** 自定义跟随底部滚动状态管理器 */
  const pinnedScrollRef = useRef<PinnedScroll | null>(null)
  /** 渲染器管理器（WebGL/Canvas 加速 + GPU 上下文恢复） */
  const rendererManagerRef = useRef<RendererManager | null>(null)
  /** 数据订阅的取消函数 */
  const unsubscribeRef = useRef<(() => void) | null>(null)
  /** xterm 输入监听的销毁函数 */
  const inputDisposableRef = useRef<{ dispose: () => void } | null>(null)
  /** 连接状态监听的取消函数 */
  const statusUnsubscribeRef = useRef<(() => void) | null>(null)
  /** 断开后重连输入监听的销毁函数 */
  const reconnectDisposableRef = useRef<{ dispose: () => void } | null>(null)
  /**
   * 持有最新的 bindConnection，使绑定 effect 只依赖 sessionId。
   * 这样即使 bindConnection 引用变化也不会触发解绑→重绑（避免重复订阅 onData/onStatus
   * 及中间窗口期数据丢失），与"实际不会变，但确保安全"的注释语义对齐。
   */
  const bindConnectionRef = useRef<(sid: string, xterm: XTerm) => void>(() => {})

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

  /** 写入状态提示横幅；pinnedScroll 不可用时兜底直接写入 xterm 并滚到底部，避免提示静默丢失 */
  const writeBanner = useCallback((text: string) => {
    if (pinnedScrollRef.current) {
      pinnedScrollRef.current.writeBanner(text)
    } else if (xtermRef.current) {
      // 兜底分支：PinnedScroll 未构造时（如挂载初期或降级场景）直接写入 xterm 并滚到底部，
      // 否则用户回看历史时横幅会落在视图之外而看不到。
      // PinnedScroll 不再置空公开 scrollToBottom，故此处可直接调用。
      const term = xtermRef.current
      term.write(text)
      term.scrollToBottom()
    }
  }, [])

  /** 绑定统一连接数据流到 xterm */
  const bindConnection = useCallback((sid: string, xterm: XTerm) => {
    // 订阅连接数据，写入 xterm（经 PinnedScroll 维护滚动位置 + FlowControl 背压）
    const unsub = window.api.connection.onData((dataSid, data) => {
      if (dataSid === sid && xtermRef.current) {
        const { sessions } = useAppStore.getState()
        if (sessions.some((s) => s.id === dataSid)) {
          rendererPluginHost.feedOutput(sid, data)
          pinnedScrollRef.current?.write(data)
        }
      }
    })
    unsubscribeRef.current = unsub

    // 监听 xterm 用户输入，发送到连接
    const inputDisposable = xterm.onData((data) => {
      // 用户输入意味着结束回看、准备查看新输出，立即跟随底部，
      // 后续远端回显与命令输出即可自动滚到底部。
      pinnedScrollRef.current?.onUserInput()
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
          // 通过 writeBanner 写入，保证与远端数据流的顺序一致并强制滚到底部
          writeBanner('\r\n\x1b[31m连接已断开\x1b[0m\r\n\x1b[33m按 R 键重新连接\x1b[0m\r\n')
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
  }, [updateSessionStatus, writeBanner])

  // 始终把最新的 bindConnection 同步到 ref，供绑定 effect 通过 ref 调用，
  // 避免 bindConnection 引用变化触发 effect 重绑
  bindConnectionRef.current = bindConnection

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
    // 在 open() 之后立即 patch RenderService.dimensions getter，根治
    // "Cannot read properties of undefined (reading 'dimensions')" 崩溃。
    // 必须在 open() 之后调用——_renderService 在 open() 内部才创建。
    patchRenderServiceDimensions(xterm)
    safeFit(xterm, fitAddon)

    // 初始化写入背压控制器，并交给 PinnedScroll 持有
    const flowControl = new FlowControl(xterm)

    // 初始化自定义跟随底部滚动管理器，并接管滚轮解 pin
    const pinnedScroll = new PinnedScroll(xterm, flowControl)
    pinnedScroll.attach(terminalRef.current)
    pinnedScrollRef.current = pinnedScroll

    // 加载加速渲染器：优先 WebGL，失败回退 Canvas，再回退 DOM
    const rendererManager = new RendererManager(xterm, terminalRef.current, resolved.renderer)
    rendererManager.attach()
    rendererManagerRef.current = rendererManager

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

    // 窗口大小变化时自适应（节流 + 保持滚动位置）
    const RESIZE_MIN_INTERVAL = 32
    let resizePending = false
    let lastResize = 0
    const runResize = () => {
      resizePending = false
      lastResize = Date.now()
      const fit = () => safeFit(xtermRef.current, fitAddon)
      if (pinnedScrollRef.current) {
        pinnedScrollRef.current.withScrollPreservation(fit, true)
      } else {
        fit()
      }
    }
    const handleResize = () => {
      if (resizePending) return
      resizePending = true
      const wait = Math.max(0, RESIZE_MIN_INTERVAL - (Date.now() - lastResize))
      if (wait > 0) {
        setTimeout(() => requestAnimationFrame(runResize), wait)
      } else {
        requestAnimationFrame(runResize)
      }
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

    const handleCompositionEnd = () => {
      // IME 组合结束后 fit，保持滚动位置与其他 fit 路径一致
      const fit = () => safeFit(xtermRef.current, fitAddon)
      if (pinnedScrollRef.current) {
        pinnedScrollRef.current.withScrollPreservation(fit, true)
      } else {
        fit()
      }
    }
    xtermElement?.addEventListener('compositionend', handleCompositionEnd)

    return () => {
      window.removeEventListener('resize', handleResize)
      xtermElement?.removeEventListener('compositionend', handleCompositionEnd)
      compositionMo?.disconnect()
      terminalRef.current?.removeEventListener('contextmenu', handleContextMenu)
      selectionChangeDisposable.dispose()
      unbindData()

      // 清理增强器（按依赖顺序：先 PinnedScroll 再 RendererManager，最后 xterm）
      try {
        if (pinnedScrollRef.current && terminalRef.current) {
          pinnedScrollRef.current.detach(terminalRef.current)
          pinnedScrollRef.current.dispose()
        }
      } catch (e) {
        console.error('[TerminalInstance] 清理 PinnedScroll 失败:', e)
      } finally {
        pinnedScrollRef.current = null
      }

      try {
        rendererManagerRef.current?.dispose()
      } catch (e) {
        console.error('[TerminalInstance] 清理 RendererManager 失败:', e)
      } finally {
        rendererManagerRef.current = null
      }

      xterm.dispose()
      xtermRef.current = null
      fitAddonRef.current = null
      searchAddonRef.current = null
      // 清理自管理的搜索高亮 decoration
      disposeSearchHighlights()
    }
  }, []) // 仅在挂载时创建 xterm 实例

  // 绑定会话数据流（挂载时绑定，卸载时解绑）
  useEffect(() => {
    const xterm = xtermRef.current
    if (!xterm) return

    const currentSession = useAppStore.getState().sessions.find((s) => s.id === sessionId)
    if (!currentSession) return

    bindConnectionRef.current(currentSession.id, xterm)

    return () => {
      unbindData()
    }
  }, [sessionId]) // 仅在 sessionId 变化时重新绑定；bindConnection 通过 ref 访问，引用变化不触发重绑

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
        writeBanner(`\x1b[32m正在打开串口 ${sessionConfig.path} (${sessionConfig.baudRate}bps)...\x1b[0m\r\n`)
      } else if (sessionConfig.type === 'ssh') {
        writeBanner(`\x1b[34m正在连接 ${sessionConfig.username}@${sessionConfig.host}:${sessionConfig.port}...\x1b[0m\r\n`)
      } else if (sessionConfig.type === 'telnet') {
        writeBanner(`\x1b[35m正在连接 Telnet ${sessionConfig.host}:${sessionConfig.port}...\x1b[0m\r\n`)
      } else if (sessionConfig.type === 'bash') {
        writeBanner(`\x1b[33m正在启动本地终端...\x1b[0m\r\n`)
      }
    } else if (sessionStatus === 'connected') {
      // 连接成功后，主动同步终端真实尺寸到 PTY（串口不需要）
      if (sessionConfig.type !== 'serial') {
        window.api.connection.resize(sessionId, xterm.cols, xterm.rows)
      }
      if (sessionConfig.type === 'serial') {
        writeBanner(`\x1b[32m串口 ${sessionConfig.path} 已成功打开\x1b[0m\r\n`)
      } else if (sessionConfig.type === 'ssh') {
        writeBanner(`\x1b[32m已成功连接到 ${sessionConfig.username}@${sessionConfig.host}:${sessionConfig.port}\x1b[0m\r\n`)
      } else if (sessionConfig.type === 'telnet') {
        writeBanner(`\x1b[32m已成功连接到 Telnet ${sessionConfig.host}:${sessionConfig.port}\x1b[0m\r\n`)
      } else if (sessionConfig.type === 'bash') {
        writeBanner(`\x1b[32m本地终端已启动\x1b[0m\r\n`)
      }
    } else if (sessionStatus === 'error' && sessionErrorMessage) {
      writeBanner(`\r\n\x1b[31m连接失败: ${sessionErrorMessage}\x1b[0m\r\n\x1b[33m按 R 键重新连接\x1b[0m\r\n`)
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
        // 标签页重新可见时恢复可能丢失的 GPU 渲染器上下文
        rendererManagerRef.current?.reactivate()
        // fit 并保持滚动位置（pinnedScroll 不可用时仍保证 fit 执行）
        const fit = () => safeFit(xtermRef.current, fitAddonRef.current)
        if (pinnedScrollRef.current) {
          pinnedScrollRef.current.withScrollPreservation(fit, true)
        } else {
          fit()
        }
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
    // 字体变化会改变单元尺寸，fit 时保持滚动位置（pinnedScroll 不可用时仍保证 fit 执行）
    const fit = () => safeFit(xtermRef.current, fitAddonRef.current)
    if (pinnedScrollRef.current) {
      pinnedScrollRef.current.withScrollPreservation(fit, true)
    } else {
      fit()
    }
  }, [settings.fontSize, settings.fontFamily, settings.fontWeight, settings.fontWeightBold, settings.lineHeight, settings.letterSpacing, settings.cursorStyle, settings.cursorBlink, settings.scrollback, settings.background, settings.foreground, sessionProfileId, sessionOverrides, profiles])

  // 性能监控：定期检查背压与渲染器状态（基于两次采样间的增量，避免累计值反复刷日志）
  useEffect(() => {
    const MONITOR_INTERVAL = 30000 // 30秒检查一次
    // 上一轮采样值，用于计算增量；首次采样不告警，仅建立基线
    let prevFlow: { totalWrites: number; blockedWrites: number } | null = null
    let prevContextLoss = 0
    let prevWriteErrors = 0
    const timer = setInterval(() => {
      try {
        const flowStats = pinnedScrollRef.current?.getFlowStats()
        const scrollStats = pinnedScrollRef.current?.getStats()
        const rendererStats = rendererManagerRef.current?.getStats()

        // 背压频繁触发预警：按本轮新增的 blockedWrites 占比判断，而非累计值
        if (flowStats) {
          if (prevFlow) {
            const newWrites = flowStats.totalWrites - prevFlow.totalWrites
            const newBlocked = flowStats.blockedWrites - prevFlow.blockedWrites
            // 仅在有新增写入且本轮阻塞占比超 30% 时告警，避免长期运行后累计值恒超阈值反复刷日志
            if (newWrites > 0 && newBlocked / newWrites > 0.3) {
              console.warn('[性能监控] 终端背压触发频繁', {
                本轮写入: newWrites,
                本轮阻塞: newBlocked,
                阻塞率: ((newBlocked / newWrites) * 100).toFixed(2) + '%',
                当前待回调: flowStats.currentPendingCallbacks,
                峰值待回调: flowStats.maxPendingCallbacks
              })
            }
          }
          prevFlow = { totalWrites: flowStats.totalWrites, blockedWrites: flowStats.blockedWrites }
        }

        // 写入错误监控：仅对本轮新增的错误告警
        if (scrollStats && scrollStats.writeErrors > prevWriteErrors) {
          console.warn('[性能监控] 终端写入发生错误', {
            本轮新增: scrollStats.writeErrors - prevWriteErrors,
            累计: scrollStats.writeErrors
          })
        }
        prevWriteErrors = scrollStats?.writeErrors ?? prevWriteErrors

        // GPU 上下文丢失监控：仅对本轮新增事件告警
        if (rendererStats && rendererStats.contextLossEvents > prevContextLoss) {
          console.warn('[性能监控] GPU 渲染器上下文丢失', {
            本轮新增: rendererStats.contextLossEvents - prevContextLoss,
            当前渲染器: rendererStats.activeRenderer,
            恢复尝试: rendererStats.recoveryAttempts
          })
        }
        prevContextLoss = rendererStats?.contextLossEvents ?? prevContextLoss
      } catch (e) {
        console.error('[性能监控] 统计收集失败:', e)
      }
    }, MONITOR_INTERVAL)

    return () => clearInterval(timer)
  }, [])

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
        disposeSearchHighlights()
        return
      }

      // 先清理上一轮自管理的高亮 decoration
      disposeSearchHighlights()

      const options: { regex?: boolean; wholeWord?: boolean; caseSensitive?: boolean; incremental?: boolean } = {}
      if (matchCase) options.caseSensitive = true
      if (matchRegex) options.regex = true
      if (action === 'init') options.incremental = true

      // 不传 decorations 给 SearchAddon：addon 的 _highlightAllMatches 在匹配项
      // 位于行尾或跨 wrap 边界时会提前退出循环，导致只高亮第一个匹配。
      // 这里只让 addon 负责"选中并滚动到当前匹配"，matchBackground 高亮
      // 由下面的自管理 decoration 完成。
      if (action === 'init' || action === 'next') {
        searchAddon.findNext(searchText, options)
      } else if (action === 'prev') {
        searchAddon.findPrevious(searchText, options)
      }

      const xterm = xtermRef.current
      if (xterm) {
        const info = computeSearchMatchInfo(xterm, searchText, matchCase, matchRegex)
        if (info) {
          // 为每个匹配分段创建 matchBackground 高亮 decoration
          // 当前选中的逻辑匹配对应的所有分段用 activeMatchBackground
          const activeLogical = info.resultIndex
          // activeLogical < 0 表示无选中匹配，此时 activeSegStart > activeSegEnd，
          // isActive 对所有分段为 false
          const activeSegStart = activeLogical >= 0 && activeLogical < info.logicalStarts.length
            ? info.logicalStarts[activeLogical]
            : Number.POSITIVE_INFINITY
          const activeSegEnd = activeLogical >= 0
            ? (activeLogical + 1 < info.logicalStarts.length
                ? info.logicalStarts[activeLogical + 1]
                : info.matches.length)
            : -1
          for (let i = 0; i < info.matches.length; i++) {
            const m = info.matches[i]
            const isActive = i >= activeSegStart && i < activeSegEnd
            // registerMarker(cursorYOffset) 中 cursorYOffset = -baseY - cursorY + row
            // 与 SearchAddon._selectResult 的算法一致
            const cursorYOffset = -xterm.buffer.active.baseY - xterm.buffer.active.cursorY + m.row
            const marker = xterm.registerMarker(cursorYOffset)
            if (!marker) continue
            const decoration = xterm.registerDecoration({
              marker,
              x: m.col,
              width: m.length,
              backgroundColor: isActive ? '#f9e2af55' : '#585b70aa',
              layer: 'top',
            })
            if (decoration) {
              const disposables: Array<() => void> = []
              disposables.push(() => marker.dispose())
              disposables.push(() => decoration.dispose())
              searchHighlightDisposablesRef.current.push(() => {
                for (const d of disposables) {
                  try { d() } catch { /* 已销毁 */ }
                }
              })
            } else {
              marker.dispose()
            }
          }
          window.dispatchEvent(new CustomEvent('terminal:searchResult', {
            detail: { sessionId, resultIndex: info.resultIndex, resultCount: info.resultCount }
          }))
        }
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
