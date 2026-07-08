import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { registerIpcHandlers } from './ipc'
import { logManager } from './logger'
import { setupGlobalErrorHandling } from './app-logger'
import { getKeyboardLockState } from './keyboard'
import { mainPluginHost } from './plugin-host'
import { initAutoUpdater } from './updater'
import type { KeyboardLockState } from './keyboard'

// 消除 Windows 上 GPU 着色器缓存创建失败的日志噪音
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')

/** 当前键盘锁状态（主进程维护） */
let currentLockState: KeyboardLockState = { capsLock: false, numLock: false, scrollLock: false }

/** 需要检测的锁定键 code 列表 */
const LOCK_KEY_CODES = new Set(['CapsLock', 'NumLock', 'ScrollLock'])

/** 键盘锁状态轮询间隔（毫秒），仅作保底用 */
const POLL_INTERVAL_MS = 5000

/** 键盘锁状态轮询定时器 */
let pollTimer: ReturnType<typeof setInterval> | null = null

/** 是否有渲染进程需要键盘锁轮询 */
let pollingNeeded = false

/** 启动键盘锁轮询 */
function startPolling(): void {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    const newState = getKeyboardLockState()
    if (
      newState.capsLock !== currentLockState.capsLock ||
      newState.numLock !== currentLockState.numLock ||
      newState.scrollLock !== currentLockState.scrollLock
    ) {
      currentLockState = newState
      BrowserWindow.getAllWindows().forEach((win) => {
        pushKeyboardLockState(win, newState)
      })
    }
  }, POLL_INTERVAL_MS)
}

/** 停止键盘锁轮询 */
function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

/** 获取应用图标路径（兼容开发环境和打包后的生产环境） */
function getIconPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'icon.png')
  }
  return join(__dirname, '../../resources/icon.png')
}

/**
 * 推送键盘锁状态到指定窗口
 */
function pushKeyboardLockState(window: BrowserWindow, state: KeyboardLockState): void {
  try {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('keyboard:lock-state-changed', state)
    }
  } catch {
    // 窗口已销毁时忽略
  }
}

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    icon: getIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

app.whenReady().then(async () => {
  setupGlobalErrorHandling()
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.wilson.terminal')
  }

  // 加载并激活已安装插件
  await mainPluginHost.loadInstalledPlugins()
  for (const item of mainPluginHost.getPluginList()) {
    if (item.enabled) await mainPluginHost.activate(item.manifest.id)
  }

  app.on('browser-window-created', (_, window) => {
    const { webContents } = window

    // 点击链接在系统默认浏览器中打开，不在 Electron 窗口内导航
    webContents.setWindowOpenHandler(({ url }) => {
      if (typeof url === 'string' && (url.startsWith('http:') || url.startsWith('https:'))) {
        shell.openExternal(url)
      }
      return { action: 'deny' }
    })

    webContents.on('will-navigate', (event, url) => {
      if (typeof url === 'string' && (url.startsWith('http:') || url.startsWith('https:'))) {
        event.preventDefault()
        shell.openExternal(url)
      }
    })

    // 窗口创建时获取真实键盘锁状态
    currentLockState = getKeyboardLockState()
    pushKeyboardLockState(window, currentLockState)

    webContents.on('context-menu', (event) => {
      event.preventDefault()
    })

    webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.control && input.shift && input.code === 'KeyI') {
        _event.preventDefault()
      }

      // 检测键盘锁状态变化：keyUp 时系统已完成 toggle 切换，此时读取状态最准确
      if (input.type === 'keyUp' && LOCK_KEY_CODES.has(input.code)) {
        const newState = getKeyboardLockState()
        currentLockState = newState
        pushKeyboardLockState(window, newState)
      }
    })
  })

  // 键盘锁轮询按需启停：渲染进程根据是否有会话且状态栏可见来决定
  ipcMain.on('keyboard:set-polling-enabled', (_event, enabled: boolean) => {
    pollingNeeded = enabled
    if (pollingNeeded) {
      startPolling()
    } else {
      stopPolling()
    }
  })

  registerIpcHandlers()

  const mainWindow = createWindow()
  initAutoUpdater(mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', async () => {
  stopPolling()
  pollingNeeded = false
  await logManager.closeAll()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
