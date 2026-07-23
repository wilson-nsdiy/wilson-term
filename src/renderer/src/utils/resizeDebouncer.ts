/**
 * 终端 resize 防抖器。
 *
 * 对齐 VSCode TerminalResizeDebouncer（src/vs/workbench/contrib/terminal/browser/terminalResizeDebouncer.ts）。
 *
 * 核心思路：resize 的 reflow 成本随 buffer 内容增长而暴涨，故按 buffer 内容量分级处理：
 * 1. buffer 小（<StartDebouncingThreshold 行）→ 立即 resize（便宜）
 * 2. buffer 大 + 不可见 → requestIdleCallback 延迟到窗口空闲（不抢主线程）
 * 3. buffer 大 + 可见 → Y 立即（便宜），X debounce 100ms（reflow 贵）
 *
 * X/Y 独立处理的原因：垂直 resize 只改 rows 不触发 reflow，便宜；水平 resize 改 cols
 * 触发每行 reflow，贵。故 Y 立即执行，X 防抖，避免拖拽窗口宽度时连续 reflow 卡死。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

const enum Constants {
  /** buffer 行数阈值：超过此值后 resize 开始防抖 */
  StartDebouncingThreshold = 200,
  /** X resize 防抖延迟（ms）—— reflow 贵，故 debounce */
  DebounceResizeXDelay = 100,
}

export interface ResizeDebouncerCallbacks {
  /** 判断终端当前是否可见（标签页是否激活） */
  isVisible: () => boolean
  /** 获取 xterm 实例（可能已 dispose） */
  getXterm: () => any | undefined
  /** 同时 resize X+Y（buffer 小或 flush 时调用） */
  resizeBoth: (cols: number, rows: number) => void
  /** 仅 resize X（防抖后触发） */
  resizeX: (cols: number) => void
  /** 仅 resize Y（立即触发，便宜） */
  resizeY: (rows: number) => void
}

export class ResizeDebouncer {
  private latestX = 0
  private latestY = 0
  private disposed = false

  /** X debounce 定时器（reflow 贵，故 debounce 100ms） */
  private debounceXTimer: number | null = null
  /** 不可见时的 X idle job */
  private idleXJob: number | null = null
  /** 不可见时的 Y idle job */
  private idleYJob: number | null = null

  constructor(private callbacks: ResizeDebouncerCallbacks) {}

  /**
   * 提议一次 resize。
   * @param immediate 强制立即执行（用于 dispose 前 flush 或显式 force）
   */
  resize(cols: number, rows: number, immediate = false): void {
    if (this.disposed) return
    this.latestX = cols
    this.latestY = rows

    const xterm = this.callbacks.getXterm()
    if (!xterm) return

    // buffer 小或显式 immediate → 立即 resize（便宜）
    const bufferLength = xterm.buffer?.normal?.length ?? 0
    if (immediate || bufferLength < Constants.StartDebouncingThreshold) {
      this.cancelPending()
      this.callbacks.resizeBoth(cols, rows)
      return
    }

    // buffer 大 + 不可见 → requestIdleCallback 延迟到窗口空闲（不抢主线程）
    if (!this.callbacks.isVisible()) {
      if (this.idleXJob === null) {
        this.idleXJob = this.scheduleIdle(() => {
          this.idleXJob = null
          if (this.disposed) return
          this.callbacks.resizeX(this.latestX)
        })
      }
      if (this.idleYJob === null) {
        this.idleYJob = this.scheduleIdle(() => {
          this.idleYJob = null
          if (this.disposed) return
          this.callbacks.resizeY(this.latestY)
        })
      }
      return
    }

    // buffer 大 + 可见：Y 立即（便宜），X debounce 100ms（reflow 贵）
    this.callbacks.resizeY(rows)
    if (this.debounceXTimer === null) {
      this.debounceXTimer = window.setTimeout(() => {
        this.debounceXTimer = null
        if (this.disposed) return
        this.callbacks.resizeX(this.latestX)
      }, Constants.DebounceResizeXDelay)
    }
  }

  /** 立即执行所有 pending resize（用于 dispose 前确保最终尺寸生效） */
  flush(): void {
    if (this.disposed) return
    if (this.debounceXTimer !== null || this.idleXJob !== null || this.idleYJob !== null) {
      this.cancelPending()
      this.callbacks.resizeBoth(this.latestX, this.latestY)
    }
  }

  /** 销毁：取消所有 pending timer/job，避免回调在 xterm 销毁后访问 buffer */
  dispose(): void {
    this.disposed = true
    this.cancelPending()
  }

  private cancelPending(): void {
    if (this.debounceXTimer !== null) {
      clearTimeout(this.debounceXTimer)
      this.debounceXTimer = null
    }
    if (this.idleXJob !== null) {
      cancelIdle(this.idleXJob)
      this.idleXJob = null
    }
    if (this.idleYJob !== null) {
      cancelIdle(this.idleYJob)
      this.idleYJob = null
    }
  }

  /** requestIdleCallback 兜底：不支持时降级 setTimeout */
  private scheduleIdle(fn: () => void): number {
    const ric = (window as any).requestIdleCallback
    if (typeof ric === 'function') {
      return ric(fn)
    }
    return window.setTimeout(fn, 50) as unknown as number
  }
}

/** cancelIdleCallback 兜底 */
function cancelIdle(id: number): void {
  const cic = (window as any).cancelIdleCallback
  if (typeof cic === 'function') {
    cic(id)
  } else {
    clearTimeout(id)
  }
}
