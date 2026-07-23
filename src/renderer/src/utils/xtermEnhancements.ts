/**
 * xterm.js 性能与体验增强模块。
 *
 * 包含三项从 tabby 借鉴并适配到本项目的增强：
 * 1. FlowControl —— 写入背压，防止快速输出压垮渲染进程导致 OOM/卡死。
 * 2. PinnedScroll —— 自定义"跟随底部"滚动状态，解决 xterm.js 在用户回看历史时
 *    被新输出拉回底部的体验痛点（xterm onScroll 只在内容驱动滚动时触发，无法
 *    反映用户滚轮/键盘滚动，见 xterm.js #3864/#3201）。
 * 3. WebGL 渲染器加载与 GPU 上下文丢失恢复（xterm 6.x 已废弃 Canvas addon，WebGL 不可用时回退 DOM）。
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

/**
 * 安全地执行 fitAddon.fit()。
 *
 * xterm 5.5.0 的 get dimensions() 读取 this._renderService.dimensions，
 * 当渲染器尚未附加（_renderService 为 undefined）、容器尺寸为 0
 * （隐藏标签页尚未布局）、或终端已 dispose 时，fit 会抛出
 * "Cannot read properties of undefined (reading 'dimensions')"。
 *
 * 本助手在调用前检查终端是否已 disposed、容器是否有真实尺寸、
 * _renderService 是否就绪，并在异常时静默吞掉，避免单次 fit 失败
 * 中断 UI 流程。
 */
export function safeFit(
  xterm: Terminal | null | undefined,
  fitAddon: { fit: () => void } | null | undefined
): void {
  if (!xterm || !fitAddon) return
  // 终端已 dispose 时 element 通常为 undefined
  // element 是 @xterm/xterm 公开类型属性（readonly element: HTMLElement | undefined）
  const el = xterm.element
  if (!el) return
  // 容器无尺寸时 fit 无意义且可能触发 dimensions 抛错
  if (el.clientWidth <= 0 || el.clientHeight <= 0) return
  // 渲染器尚未就绪时跳过（_renderService.dimensions getter 会抛错）。
  // 关键：不能读 renderService.dimensions 自身判空——getter 是 return this._renderer.value!.dimensions，
  // 当 MutableDisposable 已 dispose（xterm.dispose() 链触发后 _isDisposed=true，value 永远 undefined）
  // 时读 .dimensions 即抛 "Cannot read properties of undefined (reading 'dimensions')"。
  // 用 hasRenderer() 判 _renderer.value 是否就绪，绕开 getter。
  const core = (xterm as any)['_core']
  const renderService = core?.['_renderService']
  if (!renderService?.hasRenderer?.()) return
  try {
    fitAddon.fit()
  } catch (e) {
    // 渲染器竞态等偶发错误：记录日志以便诊断持久性失败
    console.warn('[safeFit] fit 失败:', e)
  }
}

/**
 * 全局拦截 xterm 内部 RenderService 的 dimensions getter，根治
 * "Cannot read properties of undefined (reading 'dimensions')" 崩溃。
 *
 * 根因（xterm 5.5.0 源码 src/browser/services/RenderService.ts:50）：
 *   public get dimensions(): IRenderDimensions { return this._renderer.value!.dimensions; }
 * `_renderer` 是 MutableDisposable（src/common/Lifecycle.ts:50-84），
 * 其 value getter 在 _isDisposed=true（即 xterm.dispose() 链触发后，
 * RenderService 所在的 _renderer 被 dispose）时永远返回 undefined；
 * 此外 addon 切换瞬间（WebGL/Canvas activate 失败、setRenderer 未调用）也会
 * 出现 _renderer.value 为 undefined。此时读 .dimensions 即抛错。
 *
 * xterm 内部有 7 处直接同步读 _renderService.dimensions（Viewport 构造期、
 * CompositionHelper、MouseService、SelectionService、AccessibilityManager、
 * BufferDecorationRenderer、Terminal._syncTextArea/_reportWindowsOptions），
 * 外部无法逐个守护——唯一彻底的解法是在 RenderService.prototype 上用
 * Object.defineProperty 替换 getter，当 _renderer.value 为 undefined 时
 * 返回全 0 安全默认值而非抛错。
 *
 * 该补丁幂等：仅 patch 一次，全局生效。对所有 xterm 实例共享的 prototype
 * 做替换，故每个 xterm 实例 open() 之后调用一次即可（多次调用安全）。
 */
let dimensionsPatchApplied = false
export function patchRenderServiceDimensions(xterm: Terminal): void {
  if (dimensionsPatchApplied) return
  const core = (xterm as any)['_core']
  const renderService = core?.['_renderService']
  // _renderService 是 prototype 上的实例，取其构造器原型做一次性 patch
  const proto = renderService?.constructor?.prototype
  if (!proto) return

  try {
    Object.defineProperty(proto, 'dimensions', {
      configurable: true,
      enumerable: true,
      get(this: any): any {
        // renderer 已就绪时走原生路径，返回真实 dimensions
        const renderer = this?._renderer?.value
        if (renderer) return renderer.dimensions
        // renderer 未就绪（MutableDisposable 已 dispose 或 addon 切换瞬间）：
        // 返回全 0 安全默认值，避免任何调用方拿到 undefined.dimensions
        return DIMENSIONS_FALLBACK
      },
    })
    dimensionsPatchApplied = true
  } catch (e) {
    console.warn('[xtermEnhancements] patch RenderService.dimensions getter 失败:', e)
  }
}

/** dimensions getter 的全 0 安全兜底值（结构与 IRenderDimensions 一致） */
const DIMENSIONS_FALLBACK = {
  css: { canvas: { width: 0, height: 0 }, cell: { width: 0, height: 0 } },
  device: {
    canvas: { width: 0, height: 0 },
    cell: { width: 0, height: 0 },
    char: { width: 0, height: 0, left: 0, top: 0 },
  },
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
 * 写入包装器：await xterm parser completion。
 *
 * PinnedScroll.doWrite 在写入前捕获 savedViewportY，写入后用它恢复位置。
 * 这要求"写入后"必须是 xterm parser 完成该 chunk 的时刻——此时 buffer.viewportY
 * /baseY 已稳定。xterm.write(data, cb) 的 cb 正是 parser completion callback。
 *
 * 删除项（对比原 121 行实现）：
 * - 高低水位 / resolver 队列 / 字节阈值 / 次数阈值：
 *   这些背压逻辑在 IPC 架构下无法真正反压到 SSH stream——阻塞渲染进程的 write
 *   只会延缓 xterm 内部队列增长，IPC 缓冲区仍持续涌入数据。xterm 自己的
 *   WriteBuffer + parser 已有排队能力，重复实现这层无收益且有性能损耗
 *   （每次 write 都 await 一个 microtask）。
 * - pendingWriteFinishers / dispose 释放：
 *   简化后 write 只持有一个 cb，不再需要 finisher 集合；dispose 只需标记，
 *   pending Promise 在 disposed 检查后自然 resolve。
 */
export class FlowControl {
  private disposed = false
  private stats = {
    totalWrites: 0,
    totalBytes: 0,
    blockedWrites: 0,
    maxPendingCallbacks: 0
  }

  constructor(private xterm: Terminal) {}

  async write(data: string): Promise<void> {
    if (this.disposed) return
    this.stats.totalWrites++
    this.stats.totalBytes += data.length

    await new Promise<void>((resolve, reject) => {
      try {
        this.xterm.write(data, () => resolve())
      } catch (e) {
        reject(e)
      }
    })

    // await 期间可能已 dispose，调用方应检查 disposed
    if (this.disposed) return
  }

  /** 获取性能统计数据 */
  getStats(): FlowControlStats {
    return {
      ...this.stats,
      currentPendingCallbacks: 0
    }
  }

  /** 销毁：标记 disposed，pending write 的调用方在 await 后会自行退出 */
  dispose(): void {
    this.disposed = true
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
  /** 滚轮状态同步 RAF id，dispose 时取消 */
  private rafId: number | null = null
  private scrollDisposable: { dispose: () => void } | null = null
  private static readonly BOTTOM_TOLERANCE = 1
  private disposed = false
  private stats = {
    totalWrites: 0,
    totalBanners: 0,
    writeErrors: 0,
    bannerErrors: 0
  }

  constructor(private xterm: Terminal, private flowControl: FlowControl) {
    // 接管滚底决策：阻止用户输入把历史视图强制拉到底部。
    xterm.options.scrollOnUserInput = false

    this.wheelHandler = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        // 滚轮向上：立即解除 pinned，确保下一帧写入不会把视图拉回底部
        this.pinnedToBottom = false
      } else if (this.rafId === null) {
        // 滚轮向下：安排 RAF 同步，若已到底则恢复 pinned
        this.rafId = requestAnimationFrame(() => {
          this.rafId = null
          if (this.isAtBottom()) this.pinnedToBottom = true
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

  /**
   * 当前是否处于 alternate buffer（TUI 全屏模式，如 opencode / claude code / vim）。
   *
   * Alt buffer 是单屏无 scrollback 的固定视口，TUI 通过 CUP（光标绝对定位）+ SU/SD
   * （滚动区域）自行绘制整屏布局。此时任何 scrollToBottom / scrollToLine 都会破坏
   * TUI 的光标坐标系，导致界面错乱。故所有滚动操作在 alt buffer 下都必须跳过。
   */
  private isAltBufferActive(): boolean {
    return this.xterm.buffer.active.type === 'alternate'
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
   * 写入数据并维护滚动位置。
   * - 写入前 pinned → 写入后滚到底部
   * - 写入前在回看 → 写入后恢复 savedViewportY（抵消 xterm 快速输出时的扰动）
   * - alt buffer → 跳过滚动操作
   */
  write(data: string): Promise<void> {
    return this.doWrite(data).catch((e) => {
      this.stats.writeErrors++
      console.error('[PinnedScroll] 终端写入失败:', e)
    })
  }

  private async doWrite(data: string): Promise<void> {
    if (this.disposed) return
    this.stats.totalWrites++

    const wasPinned = this.pinnedToBottom
    const savedViewportY = this.xterm.buffer.active.viewportY

    await this.flowControl.write(data)
    if (this.disposed) return

    // alt buffer 由 TUI 自行管理光标和滚动，跳过
    if (this.isAltBufferActive()) return

    if (wasPinned) {
      // 写入前已跟随底部：新输出无条件滚到底部
      this.pinnedToBottom = true
      this.xterm.scrollToBottom()
      return
    }

    // 写入前在回看历史：恢复到写入前的回看位置，
    // 抵消 xterm 在快速输出时对 viewportY 的扰动
    const maxScroll = this.xterm.buffer.active.baseY
    const targetY = Math.min(savedViewportY, maxScroll)
    if (this.xterm.buffer.active.viewportY !== targetY) {
      this.xterm.scrollToLine(targetY)
    }
    this.pinnedToBottom = false
  }

  /** 用户主动滚到底部（如点击状态栏或快捷键） */
  scrollToBottom(): void {
    this.pinnedToBottom = true
    this.xterm.scrollToBottom()
  }

  /**
   * 用户主动输入（按键、粘贴、回车等）时调用。
   * 用户输入意味着"结束回看、准备查看新输出"，故退出回看状态并滚到底部，
   * 后续远端回显与命令输出即可自动跟随底部，无需手动滚动。
   * scrollOnUserInput=false 已接管此决策，xterm 默认行为不再介入。
   */
  onUserInput(): void {
    if (this.disposed) return
    this.pinnedToBottom = true
    // alternate buffer（TUI 全屏模式）下用户输入由 TUI 处理，
    // 滚到底部会破坏 TUI 光标定位，故跳过。
    if (this.isAltBufferActive()) return
    this.xterm.scrollToBottom()
  }

  /**
   * 写入应用生成的状态提示（连接中/成功/断开等）并强制滚到底部。
   * 强制 pin 到底部，确保用户始终能看到这些提示。
   */
  writeBanner(data: string): Promise<void> {
    return this.doWriteBanner(data).catch((e) => {
      this.stats.bannerErrors++
      console.error('[PinnedScroll] 终端状态提示写入失败:', e)
    })
  }

  private async doWriteBanner(data: string): Promise<void> {
    if (this.disposed) return
    this.stats.totalBanners++
    this.pinnedToBottom = true
    await this.flowControl.write(data)
    if (this.disposed) return
    // alt buffer 下不滚动，避免破坏 TUI 布局
    if (this.isAltBufferActive()) return
    this.xterm.scrollToBottom()
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
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    this.scrollDisposable?.dispose()
    this.scrollDisposable = null
    this.flowControl.dispose()
  }
}

/** 渲染器类型 */
export type RendererType = 'webgl' | 'dom'

/** 渲染器管理器统计接口 */
export interface RendererStats {
  activeRenderer: 'webgl' | 'dom' | 'none'
  contextLossEvents: number
}

/**
 * 渲染器管理器：优先 WebGL，失败回退 DOM；context loss → dispose + 标记重载。
 *
 * 对齐 VSCode xtermTerminal.ts：context loss 时直接 dispose addon，不重试、不监听
 * focus、不手动重建 DOM renderer。下次 reactivate（标签页切回）或外部触发 resize
 * 时由 attachWebGL 重新加载。xterm open() 自带 DOM renderer 兜底，无需手动恢复。
 *
 * context loss 后通过 onContextLoss callback 通知外部刷新 dimensions——
 * WebGL renderer 和 DOM renderer 的 cell dimensions 不同，回退后 cols/rows 计算会变，
 * 必须重新 fit（对齐 VSCode _disposeOfWebglRenderer 内 _onDidRequestRefreshDimensions.fire()）。
 */
export class RendererManager {
  private webglAddon: any = null
  /** context loss 后置 true，reactivate 时据此重载 */
  private needReload = false
  private disposed = false
  private stats = {
    activeRenderer: 'none' as 'webgl' | 'dom' | 'none',
    contextLossEvents: 0
  }

  constructor(
    private xterm: Terminal,
    private host: HTMLElement,
    private preferred: RendererType,
    /**
     * renderer 切换后调用的 callback，外部据此刷新 dimensions + 滚动位置。
     * 对齐 VSCode _onDidRequestRefreshDimensions.fire()：WebGL 加载成功和 dispose
     * 两个时机都触发，因为 WebGL renderer 与 DOM renderer 的 cell dimensions 不同。
     */
    private onDimensionsRefresh?: () => void
  ) {}

  /** 加载渲染器。返回是否使用了 WebGL。 */
  attach(): boolean {
    if (this.disposed) return false
    if (this.preferred === 'webgl') {
      return this.attachWebGL()
    }
    this.stats.activeRenderer = 'dom'
    return false
  }

  private attachWebGL(): boolean {
    try {
      const addon = new WebglAddon()
      addon.onContextLoss(() => this.onContextLoss())
      this.xterm.loadAddon(addon)
      this.webglAddon = addon
      this.needReload = false
      this.stats.activeRenderer = 'webgl'
      // 加载成功后触发 dimensions 刷新：WebGL renderer 的 cell dimensions 与 DOM 不同，
      // 必须重新 fit（对齐 VSCode _enableWebglRenderer 内 _onDidRequestRefreshDimensions.fire()）
      this.fireDimensionsRefresh()
      return true
    } catch (e) {
      console.warn('[RendererManager] WebGL 渲染器加载失败，回退到 DOM 渲染器:', e)
      this.stats.activeRenderer = 'dom'
      return false
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
    this.needReload = true
    this.stats.activeRenderer = 'dom'
    // dispose 后触发 dimensions 刷新：回退到 DOM renderer，cell dimensions 又变，
    // 必须重新 fit（对齐 VSCode _disposeOfWebglRenderer 内 _onDidRequestRefreshDimensions.fire()）
    this.fireDimensionsRefresh()
  }

  /** 触发外部 dimensions 刷新，对齐 VSCode _onDidRequestRefreshDimensions.fire() */
  private fireDimensionsRefresh(): void {
    try {
      this.onDimensionsRefresh?.()
    } catch (e) {
      console.warn('[RendererManager] onDimensionsRefresh callback 失败:', e)
    }
  }

  /**
   * 标签页重新可见时调用：若 context loss 后待重载则重新加载 WebGL。
   * 应用/窗口级 GPU 重置可能不触发 xterm 的 contextlost 事件，故 addon 丢失时也重载。
   */
  reactivate(): void {
    if (this.disposed) return
    if (this.needReload && this.preferred === 'webgl' && this.host.offsetParent !== null) {
      this.attachWebGL()
    }
  }

  /** 获取性能统计数据 */
  getStats(): RendererStats {
    return { ...this.stats }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    try {
      this.webglAddon?.dispose?.()
    } catch (e) {
      console.warn('[RendererManager] 清理 WebGL addon 失败:', e)
    }
    this.webglAddon = null
    this.stats.activeRenderer = 'none'
  }
}
