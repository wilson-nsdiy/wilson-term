/**
 * xterm.js 性能与体验增强模块。
 *
 * 包含三项从 tabby 借鉴并适配到本项目的增强：
 * 1. FlowControl —— 写入背压，防止快速输出压垮渲染进程导致 OOM/卡死。
 * 2. PinnedScroll —— 自定义"跟随底部"滚动状态，解决 xterm.js 在用户回看历史时
 *    被新输出拉回底部的体验痛点（xterm onScroll 只在内容驱动滚动时触发，无法
 *    反映用户滚轮/键盘滚动，见 xterm.js #3864/#3201）。
 * 3. WebGL/Canvas 渲染器加载与 GPU 上下文丢失恢复。
 *
 * 这三项都围绕 xterm 实例运作，封装在此以便 TerminalInstance 保持简洁。
 *
 * 访问 xterm 内部 _core API（_scrollToBottom/_renderService 等）无官方类型声明，
 * 故使用 any；渲染器 addon 在 Electron 渲染进程通过 require 同步加载。
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
import type { Terminal } from '@xterm/xterm'

/** xterm 内部 API 结构（无官方类型，仅用于运行时检测） */
interface XTermInternals {
  _core?: {
    scrollToBottom?: () => void
    _scrollToBottom?: () => void
    _renderService?: {
      _renderRows?: (start: number, end: number) => void
      clear?: () => void
      handleResize?: (cols: number, rows: number) => void
    }
  }
}

/** 检测 xterm 是否包含可用的 _core API */
function hasXTermCore(term: Terminal): term is Terminal & XTermInternals {
  return '_core' in term && typeof (term as any)._core === 'object'
}

/** 在本增强模块测试过的 xterm 版本 */
const TESTED_XTERM_VERSIONS = ['5.5.0']

/** 检查 xterm 版本兼容性（非阻断，仅警告） */
function checkXTermVersion(term: Terminal): void {
  const version = (term as any).version || (term as any)._core?.version || 'unknown'
  if (!TESTED_XTERM_VERSIONS.includes(version)) {
    console.warn(
      `[xtermEnhancements] 当前 xterm 版本 (${version}) 未经过测试，已测试版本: ${TESTED_XTERM_VERSIONS.join(', ')}`
    )
  }
}

/** 性能统计接口 */
export interface FlowControlStats {
  totalWrites: number
  totalBytes: number
  blockedWrites: number
  maxPendingCallbacks: number
  currentPendingCallbacks: number
}

/**
 * 写入背压控制器。
 *
 * xterm.write 是异步的（内部按帧渲染）。当远端输出速度持续高于渲染速度时，
 * 若无背压，数据会在 IPC 队列与 xterm 内部队列堆积，最终导致渲染进程内存膨胀
 * 甚至卡死。FlowControl 通过高低水位线控制：累计写入超过 bytesThreshold 后
 * 开始追踪回调；待完成回调超过 highWatermark 时阻塞后续写入，回落到
 * lowWatermark 以下时恢复。这与 tabby 的实现一致。
 */
export class FlowControl {
  private blocked = false
  private resolveBlocked: (() => void) | null = null
  private pendingCallbacks = 0
  private readonly lowWatermark = 5
  private readonly highWatermark = 10
  private bytesWritten = 0
  private readonly bytesThreshold = 1024 * 128
  private stats = {
    totalWrites: 0,
    totalBytes: 0,
    blockedWrites: 0,
    maxPendingCallbacks: 0
  }

  constructor(private xterm: Terminal) {}

  async write(data: string): Promise<void> {
    this.stats.totalWrites++
    this.stats.totalBytes += data.length

    // 若已被阻塞，等待解除信号
    if (this.blocked) {
      this.stats.blockedWrites++
      await new Promise<void>((resolve) => {
        this.resolveBlocked = resolve
      })
    }
    this.bytesWritten += data.length
    if (this.bytesWritten > this.bytesThreshold) {
      this.pendingCallbacks++
      this.stats.maxPendingCallbacks = Math.max(this.stats.maxPendingCallbacks, this.pendingCallbacks)
      this.bytesWritten = 0
      if (!this.blocked && this.pendingCallbacks > this.highWatermark) {
        this.blocked = true
      }
      this.xterm.write(data, () => {
        this.pendingCallbacks--
        if (this.blocked && this.pendingCallbacks < this.lowWatermark) {
          this.blocked = false
          const resolve = this.resolveBlocked
          this.resolveBlocked = null
          resolve?.()
        }
      })
    } else {
      this.xterm.write(data)
    }
  }

  /** 获取性能统计数据 */
  getStats(): FlowControlStats {
    return {
      ...this.stats,
      currentPendingCallbacks: this.pendingCallbacks
    }
  }

  /** 重置统计数据 */
  resetStats(): void {
    this.stats = {
      totalWrites: 0,
      totalBytes: 0,
      blockedWrites: 0,
      maxPendingCallbacks: 0
    }
  }
}

/** 滚动管理器统计接口 */
export interface PinnedScrollStats {
  totalWrites: number
  totalBanners: number
  writeErrors: number
  bannerErrors: number
}

/**
 * 自定义"跟随底部"滚动状态管理器。
 *
 * xterm.js 的 onScroll 只在内容驱动滚动（新行产生）时触发，无法反映用户的
 * 滚轮/键盘滚动。因此 xterm 内置的"新输出自动滚到底"会在用户向上回看历史时
 * 把视图拉回底部。本管理器禁用 xterm 内置的自动滚底，改为：
 * - 滚轮向上 / 向上滚动快捷键 → 立即解除 pinned（在下一帧前生效，防止
 *   写入把视图拉回）
 * - write() 时：若 pinned 则滚到底，否则保持用户滚动位置（xterm 在快速输出
 *   时会扰动 viewportY，需手动恢复）
 *
 * 必须在 xterm.open() 之后、开始写入数据之前 attach。
 */
export class PinnedScroll {
  private pinnedToBottom = true
  private xtermCore: any
  private wheelHandler: (e: WheelEvent) => void
  /** 写入串行化锁：onData 回调同步触发多次时，保证 write 按序执行，避免背压与滚动位置错乱 */
  private writeChain: Promise<void> = Promise.resolve()
  /** 降级模式：_core API 不可用时回退到基础行为 */
  private degradedMode = false
  /** 已销毁标记 */
  private disposed = false
  /** 错误统计 */
  private stats = {
    totalWrites: 0,
    totalBanners: 0,
    writeErrors: 0,
    bannerErrors: 0
  }
  /** 连续错误计数器 */
  private consecutiveErrors = 0
  private static readonly MAX_CONSECUTIVE_ERRORS = 10

  constructor(private xterm: Terminal, private flowControl: FlowControl) {
    // 版本兼容性检查
    checkXTermVersion(xterm)

    // 保留 xterm 原生 scrollToBottom，将其替换为空操作，由本管理器接管
    if (!hasXTermCore(xterm)) {
      console.warn('[PinnedScroll] xterm._core 不可用，启用降级模式（基础滚动功能）')
      this.degradedMode = true
      this.xtermCore = null
    } else {
      this.xtermCore = (xterm as any)['_core']
      if (this.xtermCore) {
        this.xtermCore._scrollToBottom = this.xtermCore.scrollToBottom.bind(this.xtermCore)
        this.xtermCore.scrollToBottom = () => null
      }
    }

    this.wheelHandler = (e: WheelEvent) => {
      // 滚轮向上立即解除 pinned，确保在下一帧的写入前生效
      if (e.deltaY < 0) {
        this.pinnedToBottom = false
      }
      requestAnimationFrame(() => this.updatePinnedState())
    }
  }

  /** 在终端宿主元素上注册滚轮监听（capture 阶段，xterm 可能在内部元素 stopPropagation） */
  attach(host: HTMLElement): void {
    if (this.disposed) {
      console.warn('[PinnedScroll] 尝试 attach 已销毁的实例')
      return
    }
    host.addEventListener('wheel', this.wheelHandler, { capture: true, passive: true })
  }

  detach(host: HTMLElement): void {
    if (!host) return
    try {
      host.removeEventListener('wheel', this.wheelHandler, { capture: true })
    } catch (e) {
      console.warn('[PinnedScroll] detach 失败:', e)
    }
  }

  private isAtBottom(): boolean {
    const buffer = this.xterm.buffer.active
    return buffer.viewportY >= buffer.baseY - 1
  }

  private updatePinnedState(): void {
    this.pinnedToBottom = this.isAtBottom()
  }

  /** 是否当前跟随底部 */
  get isPinned(): boolean {
    return this.pinnedToBottom
  }

  /**
   * 写入数据并维护滚动位置。所有终端输出都应通过此方法写入。
   * 在写入前捕获 pinned 状态与 viewportY（异步写入期间 RAF 回调可能改变状态）。
   * 通过写入锁串行化，保证 onData 同步多次回调时背压与滚动位置不被并发破坏。
   * 单次写入失败时记录错误并累计计数，连续错误达到阈值后向用户显示警告。
   */
  write(data: string): Promise<void> {
    this.writeChain = this.writeChain
      .then(() => this.doWrite(data))
      .catch((e) => {
        this.stats.writeErrors++
        this.consecutiveErrors++
        console.error('[PinnedScroll] 终端写入失败:', e)

        if (this.consecutiveErrors >= PinnedScroll.MAX_CONSECUTIVE_ERRORS) {
          // 达到错误阈值，向终端写入警告（不再通过 flowControl，避免递归）
          try {
            this.xterm.write('\r\n\x1b[31m[终端写入异常，部分输出可能丢失]\x1b[0m\r\n')
            this.consecutiveErrors = 0 // 重置计数器
          } catch (warnError) {
            console.error('[PinnedScroll] 写入错误警告失败:', warnError)
          }
        }
      })
    return this.writeChain
  }

  private async doWrite(data: string): Promise<void> {
    if (this.disposed) return

    this.stats.totalWrites++

    // 降级模式：直接写入，不做滚动位置控制
    if (this.degradedMode) {
      await this.flowControl.write(data)
      this.consecutiveErrors = 0
      return
    }

    const wasPinned = this.pinnedToBottom
    const savedViewportY = this.xterm.buffer.active.viewportY
    await this.flowControl.write(data)
    this.consecutiveErrors = 0 // 写入成功，重置错误计数

    if (wasPinned) {
      this.xtermCore?._scrollToBottom?.()
    } else {
      // 恢复用户滚动位置 —— xterm 在快速输出时会扰动 viewportY，
      // 且被替换为空操作的 scrollToBottom 无法纠正它。
      const maxScroll = this.xterm.buffer.active.baseY
      const targetY = Math.min(savedViewportY, maxScroll)
      if (this.xterm.buffer.active.viewportY !== targetY) {
        this.xterm.scrollToLine(targetY)
      }
    }
  }

  /** 用户主动滚到底部（如点击状态栏或快捷键） */
  scrollToBottom(): void {
    this.pinnedToBottom = true
    if (!this.degradedMode) {
      this.xtermCore?._scrollToBottom?.()
    } else {
      this.xterm.scrollToBottom()
    }
  }

  /**
   * 写入应用生成的状态提示（连接中/成功/断开等）并强制滚到底部。
   * 通过 writeChain 串行化，保证与远端数据流的相对顺序（不会插到尚未渲染的远端数据之前），
   * 同时强制 pin 到底部，确保用户始终能看到这些提示。
   */
  writeBanner(data: string): Promise<void> {
    this.writeChain = this.writeChain
      .then(() => this.doWriteBanner(data))
      .catch((e) => {
        this.stats.bannerErrors++
        console.error('[PinnedScroll] 终端状态提示写入失败:', e)
      })
    return this.writeChain
  }

  private async doWriteBanner(data: string): Promise<void> {
    if (this.disposed) return

    this.stats.totalBanners++
    this.pinnedToBottom = true
    await this.flowControl.write(data)

    if (!this.degradedMode) {
      this.xtermCore?._scrollToBottom?.()
    } else {
      this.xterm.scrollToBottom()
    }
  }

  /**
   * 在执行会改变终端尺寸的操作（如 fitAddon.fit()）前后保持滚动位置。
   * pinned 则跟到底，否则维持用户滚动位置。fit 会重置渲染缓冲并清空画面，
   * xterm 仅在下一帧重绘，会留一帧空白闪烁，可选地强制立即重绘消除闪烁。
   */
  withScrollPreservation(fn: () => void, forceRepaint = false): void {
    if (this.disposed) return

    if (this.degradedMode) {
      fn()
      return
    }

    const wasPinned = this.pinnedToBottom
    const savedViewportY = this.xterm.buffer.active.viewportY
    fn()
    if (wasPinned) {
      this.xtermCore?._scrollToBottom?.()
    } else {
      const maxScroll = this.xterm.buffer.active.baseY
      const targetY = Math.min(savedViewportY, maxScroll)
      if (this.xterm.buffer.active.viewportY !== targetY) {
        this.xterm.scrollToLine(targetY)
      }
    }
    if (forceRepaint) {
      this.xtermCore?._renderService?._renderRows?.(0, this.xterm.rows - 1)
    }
  }

  /** 用户主动滚到顶部 */
  scrollToTop(): void {
    this.pinnedToBottom = false
    this.xterm.scrollToTop()
  }

  /** 滚动若干行后更新 pinned 状态 */
  scrollLines(amount: number): void {
    this.xterm.scrollLines(amount)
    this.updatePinnedState()
  }

  /** 滚动若干页后更新 pinned 状态 */
  scrollPages(pages: number): void {
    this.xterm.scrollPages(pages)
    this.updatePinnedState()
  }

  /** 获取性能统计数据 */
  getStats(): PinnedScrollStats {
    return { ...this.stats }
  }

  /** 重置统计数据 */
  resetStats(): void {
    this.stats = {
      totalWrites: 0,
      totalBanners: 0,
      writeErrors: 0,
      bannerErrors: 0
    }
    this.consecutiveErrors = 0
  }

  /** 销毁并清理资源 */
  dispose(): void {
    this.disposed = true
    this.xtermCore = null
  }
}

/** 渲染器类型 */
export type RendererType = 'webgl' | 'canvas' | 'dom'

/** GPU 上下文丢失后最多重建 WebGL 渲染器的次数，超限后回退到 DOM 渲染器 */
const MAX_WEBGL_RECOVERY_ATTEMPTS = 3

/** 渲染器管理器统计接口 */
export interface RendererStats {
  activeRenderer: 'webgl' | 'canvas' | 'dom' | 'none'
  contextLossEvents: number
  recoveryAttempts: number
  reactivations: number
}

/**
 * 渲染器管理器：优先 WebGL，失败回退 Canvas，再回退 DOM；带 GPU 上下文丢失恢复。
 *
 * WebGL context loss 在驱动重置、应用切到后台、活跃 WebGL 上下文过多时会发生。
 * 恢复需要可见且聚焦的 canvas，因此切到后台时延迟到重新可见/聚焦时重试。
 */
export class RendererManager {
  private webglAddon: any = null
  private canvasAddon: any = null
  private xtermCore: any
  private pendingRecovery = false
  private recoveryAttempts = 0
  private focusHandler: (() => void) | null = null
  private disposed = false
  private stats = {
    activeRenderer: 'none' as 'webgl' | 'canvas' | 'dom' | 'none',
    contextLossEvents: 0,
    recoveryAttempts: 0,
    reactivations: 0
  }

  constructor(
    private xterm: Terminal,
    private host: HTMLElement,
    private preferred: RendererType
  ) {
    checkXTermVersion(xterm)
    this.xtermCore = (xterm as any)['_core']
  }

  /** 加载渲染器。返回是否使用了 WebGL。 */
  attach(): boolean {
    if (this.disposed) {
      console.warn('[RendererManager] 尝试 attach 已销毁的实例')
      return false
    }

    if (this.preferred === 'webgl') {
      return this.attachWebGL()
    }
    if (this.preferred === 'canvas') {
      this.attachCanvas()
      return false
    }
    this.stats.activeRenderer = 'dom'
    return false // DOM 渲染器，xterm 默认
  }

  private attachWebGL(): boolean {
    try {
      // 动态导入避免在不需要 WebGL 时加载该 addon 体积
      const WebglAddon = require('@xterm/addon-webgl').WebglAddon
      const addon = new WebglAddon()
      addon.onContextLoss(() => this.onContextLoss())
      this.xterm.loadAddon(addon)
      this.webglAddon = addon
      this.stats.activeRenderer = 'webgl'
      // 监听窗口 focus，在 GPU 上下文丢失后切回前台时尝试恢复。
      // 仅在首次加载时注册一次，避免 context loss 恢复时重复 attachWebGL 导致监听器泄漏。
      if (!this.focusHandler) {
        this.focusHandler = () => this.recoverRenderer()
        window.addEventListener('focus', this.focusHandler)
      }
      return true
    } catch (e) {
      console.warn('[RendererManager] WebGL 渲染器加载失败，回退到 Canvas:', e)
      this.stats.activeRenderer = 'none'
      this.attachCanvas()
      return false
    }
  }

  private attachCanvas(): void {
    try {
      const CanvasAddon = require('@xterm/addon-canvas').CanvasAddon
      const addon = new CanvasAddon()
      this.xterm.loadAddon(addon)
      this.canvasAddon = addon
      this.stats.activeRenderer = 'canvas'
    } catch (e) {
      console.warn('[RendererManager] Canvas 渲染器加载失败，使用默认 DOM 渲染器:', e)
      this.stats.activeRenderer = 'dom'
    }
  }

  private onContextLoss(): void {
    this.stats.contextLossEvents++
    console.warn(`[RendererManager] WebGL 上下文丢失 (事件 #${this.stats.contextLossEvents})`)

    try {
      this.webglAddon?.dispose()
    } catch (e) {
      console.warn('[RendererManager] 清理丢失的 WebGL addon 失败:', e)
    }

    this.webglAddon = null
    this.stats.activeRenderer = 'none'
    this.pendingRecovery = true
    this.recoverRenderer()
  }

  private canRecover(): boolean {
    return this.host.offsetParent !== null && document.hasFocus()
  }

  private recoverRenderer(): void {
    if (this.disposed || !this.pendingRecovery || !this.canRecover()) return

    this.pendingRecovery = false
    this.stats.recoveryAttempts++

    if (this.recoveryAttempts < MAX_WEBGL_RECOVERY_ATTEMPTS) {
      this.recoveryAttempts++
      console.log(`[RendererManager] 尝试恢复 WebGL 渲染器 (${this.recoveryAttempts}/${MAX_WEBGL_RECOVERY_ATTEMPTS})`)
      this.attachWebGL()
    } else {
      console.warn('[RendererManager] WebGL 恢复达到最大尝试次数，回退到 DOM 渲染器')
      this.stats.activeRenderer = 'dom'
    }
    this.redraw()
  }

  /**
   * 标签页重新可见时调用：若有待恢复的渲染器则恢复，否则重置重试计数并重绘。
   * 应用/窗口级 GPU 重置可能不触发 xterm 的 contextlost 事件，因此 WebGL 渲染器
   * 丢失 addon 时也视为需要恢复。
   */
  reactivate(): void {
    if (this.disposed) return

    this.stats.reactivations++

    if (this.pendingRecovery || (this.preferred === 'webgl' && !this.webglAddon)) {
      this.pendingRecovery = true
      this.recoverRenderer()
    } else {
      this.recoveryAttempts = 0
      this.redraw()
    }
  }

  private redraw(): void {
    if (this.disposed) return

    try {
      const renderService = this.xtermCore?._renderService
      renderService?.clear?.()
      renderService?.handleResize?.(this.xterm.cols, this.xterm.rows)
    } catch (e) {
      console.warn('[RendererManager] 重绘失败:', e)
    }
  }

  /** 显示器 DPI/分辨率变化时清理纹理图集 */
  clearTextureAtlas(): void {
    if (this.disposed) return

    try {
      this.webglAddon?.clearTextureAtlas?.()
      this.canvasAddon?.clearTextureAtlas?.()
    } catch (e) {
      console.warn('[RendererManager] 清理纹理图集失败:', e)
    }
  }

  /** 获取性能统计数据 */
  getStats(): RendererStats {
    return { ...this.stats }
  }

  /** 重置统计数据 */
  resetStats(): void {
    this.stats = {
      activeRenderer: this.stats.activeRenderer,
      contextLossEvents: 0,
      recoveryAttempts: 0,
      reactivations: 0
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    if (this.focusHandler) {
      try {
        window.removeEventListener('focus', this.focusHandler)
      } catch (e) {
        console.warn('[RendererManager] 移除 focus 监听器失败:', e)
      }
      this.focusHandler = null
    }

    try {
      this.webglAddon?.dispose?.()
    } catch (e) {
      console.warn('[RendererManager] 清理 WebGL addon 失败:', e)
    }

    try {
      this.canvasAddon?.dispose?.()
    } catch (e) {
      console.warn('[RendererManager] 清理 Canvas addon 失败:', e)
    }

    this.webglAddon = null
    this.canvasAddon = null
    this.xtermCore = null
    this.stats.activeRenderer = 'none'
  }
}
