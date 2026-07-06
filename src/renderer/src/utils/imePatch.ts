/**
 * IME monkey-patches for @xterm/xterm 6.x — 修复上游未解决的 IME bug。
 * 待升级到 xterm 7.0 后可整体移除。
 *
 * 修复:
 *   #6012 — compositionend 后 textarea 残留已提交文本
 *   #5887 — keyCode=229 误判导致快速输入丢字（豆包输入法等）
 *   #5778 — eisuu 键结束组合时文本重复发送（日语 IME）
 */

type AnyTerminal = any

interface PatchState {
  compositionendListener: ((ev: Event) => void) | null
  originalInputEvent: ((ev: InputEvent) => boolean) | null
  originalFinalizeComposition: ((waitForPropagation: boolean) => void) | null
  finalizeDedup: { active: boolean; timer: ReturnType<typeof setTimeout> | null }
}

const patchStates = new WeakMap<AnyTerminal, PatchState>()

// 每条原因只告警一次，避免多终端实例刷屏
const warned = new Set<string>()
function warnPatchSkipped(patch: string, reason: string): void {
  const key = `${patch}:${reason}`
  if (warned.has(key)) return
  warned.add(key)
  console.warn(
    `[imePatch] ${patch} 已跳过 — ${reason}。xterm 内部结构可能已变更，对应 IME bug 可能复发，请核对 xterm 版本。`
  )
}

export function applyImePatches(xterm: AnyTerminal): void {
  const core = xterm?._core
  if (!core) {
    warnPatchSkipped('all', 'xterm._core 不可用')
    return
  }

  const state: PatchState = {
    compositionendListener: null,
    originalInputEvent: null,
    originalFinalizeComposition: null,
    finalizeDedup: { active: false, timer: null }
  }
  patchStates.set(xterm, state)

  patchTextareaResidue(core, state)
  patchInputEventKeyCode229(core, state)
  patchFinalizeCompositionDedup(core, state)
}

export function removeImePatches(xterm: AnyTerminal): void {
  const state = patchStates.get(xterm)
  if (!state) return

  const core = xterm?._core
  if (core && state.compositionendListener) {
    core.textarea?.removeEventListener('compositionend', state.compositionendListener)
  }
  if (core && state.originalInputEvent) {
    core._inputEvent = state.originalInputEvent
  }
  const helper = core?._compositionHelper
  if (helper && state.originalFinalizeComposition) {
    helper._finalizeComposition = state.originalFinalizeComposition
  }
  if (state.finalizeDedup.timer) {
    clearTimeout(state.finalizeDedup.timer)
  }
  patchStates.delete(xterm)
}

/**
 * #6012: compositionend 后清空 textarea，防止外部工具（语音输入法等）
 * 看到残留文本后发送错误的退格/替换序列。
 */
function patchTextareaResidue(core: AnyTerminal, state: PatchState): void {
  const textarea = core.textarea as HTMLTextAreaElement | undefined
  if (!textarea) {
    warnPatchSkipped('#6012', 'core.textarea 不可用')
    return
  }

  state.compositionendListener = () => {
    const opts = core.optionsService?.rawOptions
    if (opts?.screenReaderMode) return

    setTimeout(() => {
      const helper = core._compositionHelper
      if (helper && !helper._isComposing && !helper._isSendingComposition) {
        textarea.value = ''
      }
    }, 0)
  }

  textarea.addEventListener('compositionend', state.compositionendListener)
}

/**
 * #5887: 当 IME 对所有按键报告 keyCode=229 但不触发 compositionstart/end 时
 * （如豆包输入法英文模式），_inputEvent 中的 _keyDownSeen 门控会丢弃第二个字符。
 *
 * 修复: 当不在真正的 composition 中时，绕过 _keyDownSeen 门控直接发送 insertText。
 */
function patchInputEventKeyCode229(core: AnyTerminal, state: PatchState): void {
  const original = core._inputEvent?.bind(core)
  if (!original || typeof core.coreService?.triggerDataEvent !== 'function') {
    warnPatchSkipped('#5887', 'core._inputEvent 或 coreService.triggerDataEvent 不可用')
    return
  }
  state.originalInputEvent = core._inputEvent

  core._inputEvent = function (ev: InputEvent): boolean {
    const helper = core._compositionHelper
    const isActuallyComposing = helper?._isComposing || helper?._isSendingComposition

    if (
      ev.data &&
      ev.inputType === 'insertText' &&
      !isActuallyComposing &&
      !core.optionsService?.rawOptions?.screenReaderMode
    ) {
      if (core._keyPressHandled) return false
      core._unprocessedDeadKey = false
      core.coreService.triggerDataEvent(ev.data, true)
      core.cancel?.(ev)
      return true
    }

    return original(ev)
  }
}

/**
 * #5778: 日语 IME 用 eisuu 键结束组合时，keydown 中非 229 keyCode 触发
 * _finalizeComposition(false) 立即发送文本，随后浏览器 compositionend 又触发
 * _finalizeComposition(true) 再次发送，导致重复。
 *
 * 修复: _finalizeComposition(false) 发送后设去重标志，短时间内
 * _finalizeComposition(true) 被调用则跳过。
 */
function patchFinalizeCompositionDedup(core: AnyTerminal, state: PatchState): void {
  const helper = core._compositionHelper
  if (!helper || typeof helper._finalizeComposition !== 'function' || !helper._compositionView) {
    warnPatchSkipped('#5778', '_compositionHelper/_finalizeComposition/_compositionView 不可用')
    return
  }

  const original = helper._finalizeComposition.bind(helper)
  state.originalFinalizeComposition = helper._finalizeComposition

  helper._finalizeComposition = function (waitForPropagation: boolean): void {
    if (!waitForPropagation) {
      state.finalizeDedup.active = true
      if (state.finalizeDedup.timer) {
        clearTimeout(state.finalizeDedup.timer)
      }
      // 100ms：需覆盖 keydown 同步触发的 false 调用到浏览器 compositionend 异步派发 true 调用之间的 task 调度延迟；compositionend 是独立 task 故需小缓冲，取 100ms 留调度抖动余量且短到不会误吞下一次新组合
      state.finalizeDedup.timer = setTimeout(() => {
        state.finalizeDedup.active = false
        state.finalizeDedup.timer = null
      }, 100)
    } else if (state.finalizeDedup.active) {
      state.finalizeDedup.active = false
      if (state.finalizeDedup.timer) {
        clearTimeout(state.finalizeDedup.timer)
        state.finalizeDedup.timer = null
      }
      helper._compositionView.classList.remove('active')
      helper._isComposing = false
      helper._isSendingComposition = false
      return
    }

    original(waitForPropagation)
  }
}
