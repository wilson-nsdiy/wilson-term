import React, { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store'
import TerminalInstance from './TerminalInstance'
import TerminalStatusBar from './TerminalStatusBar'
import CommandInput from './CommandInput'
import ButtonBar from './ButtonBar'
import SearchBar from './SearchBar'
import { buildFontFamily } from '../utils/font'
import '@xterm/xterm/css/xterm.css'

/** 欢迎终端：无活跃会话时显示欢迎信息 */
const WelcomeTerminal: React.FC = () => {
  const terminalRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const settings = useAppStore((state) => state.settings)
  const commandInputVisible = useAppStore((state) => state.commandInputVisible && !!state.activeSessionId)
  const statusBarVisible = useAppStore((state) => state.statusBarVisible)
  const buttonBarVisible = useAppStore((state) => state.buttonBarVisible && !!state.activeSessionId)
  const sidebarOpen = useAppStore((state) => state.sidebarOpen)

  const [bgImageDataURL, setBgImageDataURL] = useState<string | null>(null)

  useEffect(() => {
    if (settings.backgroundImage) {
      window.api.dialog.readImageAsDataURL(settings.backgroundImage).then((url) => {
        setBgImageDataURL(url)
      }).catch(() => setBgImageDataURL(null))
    } else {
      setBgImageDataURL(null)
    }
  }, [settings.backgroundImage])

  useEffect(() => {
    if (!terminalRef.current) return

    const xterm = new XTerm({
      cursorBlink: false,
      cursorStyle: 'bar',
      allowTransparency: true,
      fontSize: settings.fontSize,
      fontFamily: buildFontFamily(settings.fontFamily),
      theme: {
        background: '#00000000',
        foreground: settings.foreground,
        cursor: '#00000000',
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
    xterm.loadAddon(fitAddon)

    xterm.open(terminalRef.current)
    fitAddon.fit()

    if (settings.backgroundImage) {
      xterm.element?.classList.add('xterm-bg-image')
    }

    xtermRef.current = xterm
    fitAddonRef.current = fitAddon

    // 显示欢迎信息
    xterm.writeln('██╗    ██╗██╗██╗     ███████╗ ██████╗ ███╗   ██╗    ████████╗███████╗██████╗ ███╗   ███╗')
    xterm.writeln('██║    ██║██║██║     ██╔════╝██╔═══██╗████╗  ██║    ╚══██╔══╝██╔════╝██╔══██╗████╗ ████║')
    xterm.writeln('██║ █╗ ██║██║██║     ███████╗██║   ██║██╔██╗ ██║       ██║   █████╗  ██████╔╝██╔████╔██║')
    xterm.writeln('██║███╗██║██║██║     ╚════██║██║   ██║██║╚██╗██║       ██║   ██╔══╝  ██╔══██╗██║╚██╔╝██║')
    xterm.writeln('╚███╔███╔╝██║███████╗███████║╚██████╔╝██║ ╚████║       ██║   ███████╗██║  ██║██║ ╚═╝ ██║')
    xterm.writeln(' ╚══╝╚══╝ ╚═╝╚══════╝╚══════╝ ╚═════╝ ╚═╝  ╚═══╝       ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝')
    xterm.writeln('')
    xterm.writeln(`\x1b[33m 欢迎使用 Wilson Term v${__APP_VERSION__}\x1b[0m`)
    xterm.writeln('\x1b[90m 请通过侧边栏创建新的 SSH、Telnet、串口或本地终端连接\x1b[0m')
    xterm.writeln('')

    const handleResize = () => {
      fitAddon.fit()
    }
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      xterm.dispose()
      xtermRef.current = null
      fitAddonRef.current = null
    }
  }, [])

  // commandInputVisible 变化时重新 fit 终端尺寸
  useEffect(() => {
    if (!terminalRef.current) return
    requestAnimationFrame(() => {
      fitAddonRef.current?.fit()
    })
  }, [commandInputVisible, statusBarVisible, buttonBarVisible, sidebarOpen])

  // 字体设置变化时更新 xterm
  useEffect(() => {
    const xterm = xtermRef.current
    if (!xterm) return
    xterm.options.fontSize = settings.fontSize
    xterm.options.fontFamily = buildFontFamily(settings.fontFamily)
    if (xterm.options.theme) {
      xterm.options.theme = { ...xterm.options.theme, background: settings.backgroundImage ? '#00000000' : settings.background, foreground: settings.foreground }
    }
    document.documentElement.style.setProperty('--term-bg', settings.background)
    if (settings.backgroundImage) {
      xterm.element?.classList.add('xterm-bg-image')
    } else {
      xterm.element?.classList.remove('xterm-bg-image')
    }
    fitAddonRef.current?.fit()
  }, [settings.fontSize, settings.fontFamily, settings.background, settings.foreground, settings.backgroundImage])

  let bottomOffset = 0
  if (commandInputVisible) bottomOffset += 28
  if (statusBarVisible) bottomOffset += 24
  if (buttonBarVisible) bottomOffset += 28

  return (
    <div className="absolute inset-0" style={{ bottom: `${bottomOffset}px` }}>
      {bgImageDataURL && (
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{
            backgroundImage: `url(${bgImageDataURL})`
          }}
        />
      )}
      <div
        className="absolute inset-0"
        style={{
          backgroundColor: settings.background,
          opacity: settings.backgroundOpacity
        }}
      />
      <div ref={terminalRef} className="absolute inset-0" />
    </div>
  )
}

/** 终端容器：为每个标签页渲染独立的终端实例 */
const Terminal: React.FC = () => {
  const sessions = useAppStore((state) => state.sessions)
  const activeSessionId = useAppStore((state) => state.activeSessionId)
  const { commandInputVisible, buttonBarVisible, statusBarVisible } = useAppStore(
    useShallow((state) => ({
      commandInputVisible: state.commandInputVisible,
      buttonBarVisible: state.buttonBarVisible,
      statusBarVisible: state.statusBarVisible
    }))
  )

  // 键盘锁轮询按需启停：有会话且状态栏可见时才启动
  useEffect(() => {
    const needPolling = sessions.length > 0 && statusBarVisible
    window.api.keyboard.setPollingEnabled(needPolling)
    return () => {
      window.api.keyboard.setPollingEnabled(false)
    }
  }, [sessions.length, statusBarVisible])

  // 定时任务管理器：每个会话独立管理定时器
  const allScheduledTasks = useAppStore((state) => state.scheduledTasks)
  const updateScheduledTask = useAppStore((state) => state.updateScheduledTask)
  const pauseSessionTasks = useAppStore((state) => state.pauseSessionTasks)
  /** { sessionId -> { taskId -> intervalId } } */
  const timerRef = useRef<Map<string, Map<string, ReturnType<typeof setInterval>>>>(new Map())

  /** 向指定会话写入命令 */
  const writeToSession = useCallback((sessionId: string, command: string, sendEnter: boolean): boolean => {
    const state = useAppStore.getState()
    const session = state.sessions.find((s) => s.id === sessionId)
    if (!session || session.status !== 'connected') return false

    const data = command + (sendEnter ? '\r' : '')
    window.api.connection.write(sessionId, data)
    return true
  }, [])

  // 监听各会话状态：断开时暂停该会话的定时任务
  useEffect(() => {
    for (const session of sessions) {
      if (session.status !== 'connected') {
        const sessionTimers = timerRef.current.get(session.id)
        if (sessionTimers && sessionTimers.size > 0) {
          for (const [, timerId] of sessionTimers) {
            clearInterval(timerId)
          }
          sessionTimers.clear()
        }
        // 暂停该会话的 enabled 任务
        const tasks = allScheduledTasks[session.id] || []
        if (tasks.some((t) => t.enabled)) {
          pauseSessionTasks(session.id)
        }
      }
    }
  }, [sessions, allScheduledTasks, pauseSessionTasks])

  // 同步所有会话的定时任务到定时器
  useEffect(() => {
    const allTimers = timerRef.current

    // 收集所有存在的 sessionId
    const existingSessionIds = new Set(allTimers.keys())
    const activeSessionIds = new Set<string>()

    for (const [sessionId, tasks] of Object.entries(allScheduledTasks)) {
      activeSessionIds.add(sessionId)

      if (!allTimers.has(sessionId)) {
        allTimers.set(sessionId, new Map())
      }
      const sessionTimers = allTimers.get(sessionId)!
      const activeTaskIds = new Set(sessionTimers.keys())
      const newTaskIds = new Set<string>()

      for (const task of tasks) {
        newTaskIds.add(task.id)
        if (task.enabled && (task.repeatCount === 0 || task.executedCount < task.repeatCount)) {
          // 检查该会话是否已连接
          const session = useAppStore.getState().sessions.find((s) => s.id === sessionId)
          if (!session || session.status !== 'connected') continue

          if (!sessionTimers.has(task.id)) {
            const timerId = setInterval(() => {
              const currentTasks = useAppStore.getState().scheduledTasks[sessionId] || []
              const currentTask = currentTasks.find((t) => t.id === task.id)
              if (!currentTask || !currentTask.enabled) {
                clearInterval(timerId)
                sessionTimers.delete(task.id)
                return
              }
              if (currentTask.repeatCount > 0 && currentTask.executedCount >= currentTask.repeatCount) {
                clearInterval(timerId)
                sessionTimers.delete(task.id)
                updateScheduledTask(sessionId, task.id, { enabled: false })
                return
              }
              const ok = writeToSession(sessionId, currentTask.command, currentTask.sendEnter)
              if (!ok) {
                clearInterval(timerId)
                sessionTimers.delete(task.id)
                pauseSessionTasks(sessionId)
                return
              }
              updateScheduledTask(sessionId, task.id, { executedCount: currentTask.executedCount + 1 })
            }, task.interval * 1000)
            sessionTimers.set(task.id, timerId)
          }
        } else {
          const existing = sessionTimers.get(task.id)
          if (existing) {
            clearInterval(existing)
            sessionTimers.delete(task.id)
          }
        }
      }

      // 清理已删除任务的定时器
      for (const taskId of activeTaskIds) {
        if (!newTaskIds.has(taskId)) {
          const existing = sessionTimers.get(taskId)
          if (existing) {
            clearInterval(existing)
            sessionTimers.delete(taskId)
          }
        }
      }
    }

    // 清理已移除会话的定时器
    for (const sessionId of existingSessionIds) {
      if (!activeSessionIds.has(sessionId)) {
        const sessionTimers = allTimers.get(sessionId)
        if (sessionTimers) {
          for (const [, timerId] of sessionTimers) {
            clearInterval(timerId)
          }
          sessionTimers.clear()
        }
        allTimers.delete(sessionId)
      }
    }
  }, [allScheduledTasks, writeToSession, updateScheduledTask, pauseSessionTasks])

  // 组件卸载时清理所有定时器
  useEffect(() => {
    return () => {
      for (const [, sessionTimers] of timerRef.current) {
        for (const [, timerId] of sessionTimers) {
          clearInterval(timerId)
        }
        sessionTimers.clear()
      }
      timerRef.current.clear()
    }
  }, [])

  // ButtonBar 位于 CommandInput 上方：底部 = StatusBar高度(24) + CommandInput高度(28) 或 0 + CommandInput高度(28)
  const buttonBarBottom = (statusBarVisible ? 24 : 0) + (commandInputVisible ? 28 : 0)
  // CommandInput 位于 StatusBar 上方：底部 = StatusBar高度(24) 或 0
  const commandInputBottom = statusBarVisible ? 24 : 0

  return (
    <div className="w-full h-full relative">
      {sessions.map((session) => (
        <TerminalInstance
          key={session.id}
          sessionId={session.id}
          visible={session.id === activeSessionId}
        />
      ))}
      {/* 无会话时显示欢迎终端 */}
      {sessions.length === 0 && (
        <>
          <WelcomeTerminal />
          {statusBarVisible && <TerminalStatusBar sessionId="" />}
        </>
      )}
      {/* 搜索栏：悬浮在终端右上角 */}
      <SearchBar />
      {/* 按钮栏：位于命令行栏顶部 */}
      {buttonBarVisible && activeSessionId && (
        <div className="absolute inset-x-0" style={{ bottom: `${buttonBarBottom}px`, zIndex: 10 }}>
          <ButtonBar />
        </div>
      )}
      {/* 命令行输入框 */}
      {commandInputVisible && activeSessionId && (
        <div className="absolute inset-x-0" style={{ bottom: `${commandInputBottom}px`, zIndex: 10 }}>
          <CommandInput />
        </div>
      )}
    </div>
  )
}

export default Terminal
