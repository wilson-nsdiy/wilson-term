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
 * 访问 xterm 内部 _core API（scrollToBottom/_renderService 等）无官方类型声明，
 * 故使用 any；渲染器 addon 通过构建期静态 import 加载（见下方 import 与
 * RendererManager 说明）。
 *
 * 注意：xterm 5.5.0 的 _core 上不存在 _scrollToBottom 私有方法（早期版本照搬
 * tabby 的实现误以为存在）。新输出自动滚底由 BufferService.scroll() 中的
 * isUserScrolling 标志控制，直接操作 buffer.ydisp，不经过 scrollToBottom；
 * 用户输入触发的滚底由 scrollOnUserInput 选项控制。故本模块改用官方选项
 * scrollOnUserInput=false 接管滚底决策，不再改写 _core.scrollToBottom。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Terminal } from '@xterm/xterm'
// 渲染器 addon 改为构建期静态 import。原本用 require('@xterm/addon-webgl') 动态加载，
// 但渲染进程是 Vite 打包的 ESM 且 nodeIntegration=false，运行时没有 require，
// 动态 require 会抛错被 catch 吞掉，导致 WebGL/Canvas 渲染器始终加载失败、静默
// 回退到 DOM。静态 import 由 Vite 预打包转换（addon 是 CJS，Vite 会处理），
// 让渲染器真正可用。代价是 addon 体积进入 bundle，但它们本就是项目依赖。
import { WebglAddon } from '@xterm/addon-webgl'
import { CanvasAddon } from '@xterm/addon-canvas'

/** 在本增强模块测试过的 xterm 版本 */
const TESTED_XTERM_VERSIONS = ['5.5.0']

/**
 * 获取 xterm 版本号。
 *
 * 版本在构建期由 electron.vite.config.ts 的 renderer.define 从
 * @xterm/xterm/package.json 静态注入为 __XTERM_VERSION__。渲染进程是 Vite 打包的
 * ESM 且 nodeIntegration=false，运行时既无 require，也无法靠
 * require('@xterm/xterm/package.json') 这种子路径导入读版本（Vite 默认不优化
 * 包的子路径导入，运行时会抛错）。故改用构建期注入，避免误报 'unknown'。
 */
function getXTermVersion(): string {
  return __XTERM_VERSION__
}

/** 检查 xterm 版本兼容性（非阻断，仅警告），全局只检查一次 */
let versionChecked = false
function checkXTermVersion(): void {
  if (versionChecked) return
  versionChecked = true

  const version = getXTermVersion()
  if (!TESTED_XTERM_VERSIONS.includes(version)) {
    console.warn(
      `[xtermEnhancements] 当前 xterm 版本 (${version}) 未经过测试，已测试版本: ${TESTED_XTERM_VERSIONS.join(', ')}`
    )
  }
}

/** 性能统计接口 */
export interface FlowControlStats {
  totalWrites: number
  /** 累计写入的字符数（UTF-16 码元数，非字节数） */
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
 *
 * 内部使用 resolver 队列而非单一 resolver，即使未来出现并发调用也不会因
 * 覆盖导致等待者永久阻塞——但仍建议外部串行化调用（如 PinnedScroll.writeChain）
 * 以保证写入顺序。
 */
export class FlowControl {
  private blocked = false
  /** 解除阻塞的 resolver 队列，支持多个并发等待者 */
  private resolveQueue: Array<() => void> = []
  private pendingCallbacks = 0
  private readonly lowWatermark = 5
  private readonly highWatermark = 10
  private bytesWritten = 0
  /** 自上次注册回调以来的写入次数，用于小包高频场景的兜底采样 */
  private writesSinceLastCallback = 0
  private readonly bytesThreshold = 1024 * 128
  /** 写入次数阈值：小包高频场景下，累计到此次数即使未达字节阈值也注册回调采样 pending，避免背压永不触发 */
  private readonly writeCountThreshold = 64
  /** 已提交给 xterm、等待 parser completion callback 的写入完成器 */
  private pendingWriteFinishers = new Set<() => void>()
  private disposed = false
  private stats = {
    totalWrites: 0,
    totalBytes: 0,
    blockedWrites: 0,
    maxPendingCallbacks: 0
  }

  constructor(private xterm: Terminal) {}

  async write(data: string): Promise<void> {
    // dispose 后不再写入，避免向已销毁的 xterm 实例写入。
    if (this.disposed) return
    this.stats.totalWrites++
    this.stats.totalBytes += data.length

    // 若已被阻塞，等待解除信号
    if (this.blocked) {
      this.stats.blockedWrites++
      await new Promise<void>((resolve) => {
        this.resolveQueue.push(resolve)
      })
      // await 期间可能已 dispose，停止后续对 xterm 的访问
      if (this.disposed) return
    }

    this.bytesWritten += data.length
    this.writesSinceLastCallback++
    // 每次写入都等待 xterm parser completion callback，保证调用方读取到更新后的
    // buffer 状态；只有命中采样阈值的 callback 才参与高低水位背压统计。
    const trackedForBackpressure =
      this.bytesWritten > this.bytesThreshold || this.writesSinceLastCallback >= this.writeCountThreshold
    if (trackedForBackpressure) {
      this.pendingCallbacks++
      this.stats.maxPendingCallbacks = Math.max(this.stats.maxPendingCallbacks, this.pendingCallbacks)
      this.bytesWritten = 0
      this.writesSinceLastCallback = 0
      if (!this.blocked && this.pendingCallbacks > this.highWatermark) {
        this.blocked = true
      }
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (): void => settle()
      const settle = (error?: unknown): void => {
        if (settled) return
        settled = true
        this.pendingWriteFinishers.delete(finish)

        if (trackedForBackpressure && this.pendingCallbacks > 0) {
          this.pendingCallbacks--
          if (this.blocked && this.pendingCallbacks < this.lowWatermark) {
            this.blocked = false
            // 逐个释放等待者；resolveQueue 在阻塞解除后应清空
            while (this.resolveQueue.length > 0) {
              this.resolveQueue.shift()?.()
            }
          }
        }
        if (error === undefined) {
          resolve()
        } else {
          reject(error)
        }
      }

      this.pendingWriteFinishers.add(finish)
      try {
        this.xterm.write(data, finish)
      } catch (e) {
        settle(e)
      }
    })
  }

  /** 获取性能统计数据 */
  getStats(): FlowControlStats {
    return {
      ...this.stats,
      currentPendingCallbacks: this.pendingCallbacks
    }
  }

  /**
   * 销毁并清理资源：解除高水位阻塞等待者和等待 xterm callback 的写入，避免
   * callback 在 xterm 销毁后不再触发而令 writeChain 永久挂起。完成器是幂等的，
   * callback 若在 dispose 后到达也不会重复结算。
   */
  dispose(): void {
    this.disposed = true
    this.blocked = false

    const blockedWaiters = this.resolveQueue.splice(0)
    for (const resolve of blockedWaiters) {
      resolve()
    }

    const writeFinishers = Array.from(this.pendingWriteFinishers)
    for (const finish of writeFinishers) {
      finish()
    }
    this.pendingWriteFinishers.clear()
    this.pendingCallbacks = 0
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
  private wheelHandler: (e: WheelEvent) => void
  /** 滚轮状态同步 RAF id，dispose 时取消，避免回调在销毁后访问 xterm.buffer */
  private rafId: number | null = null
  /** 明确的用户滚动意图版本；异步写入不得应用更早版本捕获的视口快照 */
  private scrollGeneration = 0
  private scrollDisposable: { dispose: () => void } | null = null
  private static readonly BOTTOM_TOLERANCE = 1
  /** 写入串行化锁：onData 回调同步触发多次时，保证 write 按序执行，避免背压与滚动位置错乱 */
  private writeChain: Promise<void> = Promise.resolve()
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
    // 版本兼容性检查（全局只检查一次）
    checkXTermVersion()

    // 接管滚底决策：阻止用户输入把历史视图强制拉到底部。主动滚底统一使用
    // Terminal.scrollToBottom() 公开 API，避免依赖 _core.scrollToBottom。
    xterm.options.scrollOnUserInput = false

    this.wheelHandler = (e: WheelEvent) => {
      this.scrollGeneration++
      // 滚轮向上立即解除 pinned，确保在 xterm 实际移动 viewport 前也能阻止写入拉底
      if (e.deltaY < 0) {
        this.pinnedToBottom = false
      }
      // 每帧最多同步一次，不能在连续 wheel 时反复取消并把校正推迟到滚动停止后。
      if (this.rafId === null) {
        this.rafId = requestAnimationFrame(() => {
          this.rafId = null
          this.updatePinnedState()
        })
      }
    }
  }

  /** 在终端宿主元素上注册滚轮监听，并用公开 onScroll 补充同步实际 buffer 状态 */
  attach(host: HTMLElement): void {
    if (this.disposed) {
      console.warn('[PinnedScroll] 尝试 attach 已销毁的实例')
      return
    }
    host.addEventListener('wheel', this.wheelHandler, { capture: true, passive: true })
    if (!this.scrollDisposable) {
      this.scrollDisposable = this.xterm.onScroll(() => this.updatePinnedState())
    }
  }

  detach(host: HTMLElement): void {
    if (!host) return
    try {
      host.removeEventListener('wheel', this.wheelHandler, { capture: true })
      this.scrollDisposable?.dispose()
      this.scrollDisposable = null
    } catch (e) {
      console.warn('[PinnedScroll] detach 失败:', e)
    }
  }

  private isAtBottom(): boolean {
    const buffer = this.xterm.buffer.active
    return buffer.baseY - buffer.viewportY <= PinnedScroll.BOTTOM_TOLERANCE
  }

  private updatePinnedState(): void {
    if (this.disposed) return
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
    // 在捕获快照前读取实际 buffer，避免依赖尚未执行的 RAF/onScroll。
    this.updatePinnedState()
    const writeGeneration = this.scrollGeneration
    const wasPinned = this.pinnedToBottom
    const savedViewportY = this.xterm.buffer.active.viewportY

    // FlowControl.write 在对应 xterm parser callback 后才完成。
    await this.flowControl.write(data)
    if (this.disposed) return
    this.consecutiveErrors = 0

    if (writeGeneration !== this.scrollGeneration) {
      // 等待期间出现了新的用户滚动意图，旧快照已经过期，绝不能覆盖当前视口。
      if (this.isAtBottom()) {
        this.pinnedToBottom = true
        this.xterm.scrollToBottom()
      } else {
        this.pinnedToBottom = false
      }
      return
    }

    if (wasPinned) {
      this.pinnedToBottom = true
      this.xterm.scrollToBottom()
    } else {
      const maxScroll = this.xterm.buffer.active.baseY
      const targetY = Math.min(savedViewportY, maxScroll)
      if (this.xterm.buffer.active.viewportY !== targetY) {
        this.xterm.scrollToLine(targetY)
      }
      this.pinnedToBottom = false
    }
  }

  /** 用户主动滚到底部（如点击状态栏或快捷键） */
  scrollToBottom(): void {
    this.pinnedToBottom = true
    this.xterm.scrollToBottom()
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
    // await 期间组件可能卸载并销毁 xterm，停止后续访问
    if (this.disposed) return

    this.xterm.scrollToBottom()
  }

  /**
   * 在执行会改变终端尺寸的操作（如 fitAddon.fit()）前后保持滚动位置。
   * pinned 则跟到底，否则维持用户滚动位置。fit 会重置渲染缓冲并清空画面，
   * xterm 仅在下一帧重绘，会留一帧空白闪烁，可选地强制立即重绘消除闪烁。
   *
   * forceRepaint 使用公开 API xterm.refresh，所有渲染器（DOM/Canvas/WebGL）均可用，
   * 避免依赖内部 _renderService._renderRows（在 WebGL/Canvas 下可能不存在）。
   */
  withScrollPreservation(fn: () => void, forceRepaint = false): void {
    if (this.disposed) return

    this.updatePinnedState()
    const generation = this.scrollGeneration
    const wasPinned = this.pinnedToBottom
    const savedViewportY = this.xterm.buffer.active.viewportY
    fn()

    // fn 当前均为同步 fit；generation 检查防止未来同步重入引入过期快照恢复。
    if (generation === this.scrollGeneration) {
      if (wasPinned) {
        this.pinnedToBottom = true
        this.xterm.scrollToBottom()
      } else {
        const maxScroll = this.xterm.buffer.active.baseY
        const targetY = Math.min(savedViewportY, maxScroll)
        if (this.xterm.buffer.active.viewportY !== targetY) {
          this.xterm.scrollToLine(targetY)
        }
        this.pinnedToBottom = false
      }
    } else {
      this.updatePinnedState()
      if (this.pinnedToBottom) this.xterm.scrollToBottom()
    }
    if (forceRepaint) {
      // 公开 API：所有渲染器（DOM/Canvas/WebGL）均支持，立即触发全屏重绘
      try {
        this.xterm.refresh(0, this.xterm.rows - 1)
      } catch (e) {
        console.warn('[PinnedScroll] refresh 失败:', e)
      }
    }
  }

  /** 获取性能统计数据 */
  getStats(): PinnedScrollStats {
    return { ...this.stats }
  }

  /** 获取背压控制器的统计数据 */
  getFlowStats(): FlowControlStats {
    return this.flowControl.getStats()
  }

  /** 销毁并清理资源 */
  dispose(): void {
    this.disposed = true
    // 取消可能挂起的 RAF，避免回调在销毁后访问 xterm.buffer
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    this.scrollDisposable?.dispose()
    this.scrollDisposable = null
    // 级联销毁背压控制器，释放阻塞与等待 callback 的写入
    this.flowControl.dispose()
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
  /** WebGL 加载失败或恢复超限后置 true，后续恢复直接走 Canvas，避免反复重建 */
  private webglUnavailable = false
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
    checkXTermVersion()
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
      const addon = new WebglAddon()
      addon.onContextLoss(() => this.onContextLoss())
      this.xterm.loadAddon(addon)
      this.webglAddon = addon
      this.stats.activeRenderer = 'webgl'
      // 恢复成功，重置计数——recoveryAttempts 应统计"连续失败次数"，
      // 而非生命周期总恢复次数，否则多次偶发 context loss 后即使每次都恢复成功
      // 也会被误判为达到上限并强制回退 Canvas。
      this.recoveryAttempts = 0
      // 监听窗口 focus，在 GPU 上下文丢失后切回前台时尝试恢复。
      // 仅在首次加载时注册一次，避免 context loss 恢复时重复 attachWebGL 导致监听器泄漏。
      if (!this.focusHandler) {
        this.focusHandler = () => this.recoverRenderer()
        window.addEventListener('focus', this.focusHandler)
      }
      return true
    } catch (e) {
      console.warn('[RendererManager] WebGL 渲染器加载失败，回退到 Canvas:', e)
      this.webglUnavailable = true
      this.stats.activeRenderer = 'none'
      this.attachCanvas()
      return false
    }
  }

  private attachCanvas(): void {
    try {
      const addon = new CanvasAddon()
      // Canvas 渲染器也会丢失 2D 上下文，注册恢复回调
      if (addon.onContextLoss) {
        addon.onContextLoss(() => this.onCanvasContextLoss())
      }
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

  private onCanvasContextLoss(): void {
    this.stats.contextLossEvents++
    console.warn(`[RendererManager] Canvas 上下文丢失 (事件 #${this.stats.contextLossEvents})`)

    try {
      this.canvasAddon?.dispose()
    } catch (e) {
      console.warn('[RendererManager] 清理丢失的 Canvas addon 失败:', e)
    }

    this.canvasAddon = null
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
    this.recoveryAttempts++
    this.stats.recoveryAttempts = this.recoveryAttempts

    // preferred=webgl 且 WebGL 仍可用时尝试 WebGL 恢复；超限后标记不可用并回退 Canvas，
    // 后续恢复直接走 Canvas 分支，避免每次 reactivate 都反复重建失败的 WebGL。
    if (this.preferred === 'webgl' && !this.webglUnavailable) {
      if (this.recoveryAttempts < MAX_WEBGL_RECOVERY_ATTEMPTS) {
        console.log(`[RendererManager] 尝试恢复 WebGL 渲染器 (${this.recoveryAttempts}/${MAX_WEBGL_RECOVERY_ATTEMPTS})`)
        this.attachWebGL()
      } else {
        console.warn('[RendererManager] WebGL 恢复达到最大尝试次数，回退到 Canvas 渲染器')
        this.webglUnavailable = true
        this.attachCanvas()
      }
    } else if (this.preferred === 'canvas' || this.webglUnavailable) {
      console.log('[RendererManager] 尝试恢复 Canvas 渲染器')
      this.attachCanvas()
    }
    this.redraw()
  }

  /**
   * 标签页重新可见时调用：若有待恢复的渲染器则恢复，否则仅重置重试计数。
   * 应用/窗口级 GPU 重置可能不触发 xterm 的 contextlost 事件，因此 WebGL/Canvas 渲染器
   * 丢失 addon 时也视为需要恢复。
   */
  reactivate(): void {
    if (this.disposed) return

    this.stats.reactivations++

    // 期望渲染器：WebGL 不可用时以 Canvas 为准，避免 !webglAddon 恒真导致每次切回都重建
    const expectWebgl = this.preferred === 'webgl' && !this.webglUnavailable
    const expectCanvas = this.preferred === 'canvas' || (this.preferred === 'webgl' && this.webglUnavailable)
    const addonMissing = (expectWebgl && !this.webglAddon) || (expectCanvas && !this.canvasAddon)

    if (this.pendingRecovery || addonMissing) {
      this.pendingRecovery = true
      this.recoverRenderer()
    } else {
      // 无 context loss，仅重置重试计数，跳过不必要的 redraw
      this.recoveryAttempts = 0
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

  /** 获取性能统计数据 */
  getStats(): RendererStats {
    return {
      ...this.stats,
      recoveryAttempts: this.recoveryAttempts
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
