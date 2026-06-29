import koffi from 'koffi'

/** 键盘锁状态 */
export interface KeyboardLockState {
  capsLock: boolean
  numLock: boolean
  scrollLock: boolean
}

// 只在 Windows 平台加载 koffi 并声明调用
let user32: koffi.IKoffiLib | null = null
let GetKeyState: ((nVirtKey: number) => number) | null = null

if (process.platform === 'win32') {
  user32 = koffi.load('user32.dll')
  GetKeyState = user32.func('GetKeyState', 'short', ['int'])
}

// Virtual-Key Codes
const VK_CAPITAL = 0x14
const VK_NUMLOCK = 0x90
const VK_SCROLL = 0x91

/**
 * 通过 koffi 调用 Windows GetKeyState API 获取键盘锁真实状态。
 * GetKeyState 返回的 short 中，最低位表示 toggle 状态（0=off, 1=on）。
 */
export function getKeyboardLockState(): KeyboardLockState {
  const defaultState: KeyboardLockState = {
    capsLock: false,
    numLock: false,
    scrollLock: false
  }

  if (process.platform !== 'win32' || !GetKeyState) {
    return defaultState
  }

  try {
    const caps = GetKeyState(VK_CAPITAL) & 1
    const num = GetKeyState(VK_NUMLOCK) & 1
    const scroll = GetKeyState(VK_SCROLL) & 1

    return {
      capsLock: caps === 1,
      numLock: num === 1,
      scrollLock: scroll === 1
    }
  } catch (err) {
    console.error('[Keyboard] GetKeyState 调用失败:', err)
    return defaultState
  }
}
