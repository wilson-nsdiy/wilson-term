/**
 * IME 首字母漏出修复：keydown 阶段同步判定 + onData 出口延迟确认方案。
 *
 * ## 根因（xterm.js 上游 bug）
 *
 * 微软拼音等中文 IME，首字母 keydown 在 compositionstart 之前触发，且 keyCode
 * 为真实字母码（如 84）而非 IME composition 键码 229。xterm.js 的
 * CompositionHelper.keydown()（node_modules/@xterm/xterm/src/browser/input/CompositionHelper.ts:115-139）
 * 此时返回 true，xterm 把首字母通过 onData 发出；紧接着 compositionstart 触发，
 * IME 组合完成后把中文词组通过 onData 发出。远端总共收到："t" + "提交" = "t提交"。
 *
 * ## 对照 VS Code 终端
 *
 * VS Code 终端层零 composition 代码，完全委托 xterm.js（见
 * /home/ubuntu/github_projects/vscode/src/vs/workbench/contrib/terminal/browser/terminalInstance.ts
 * 第875行 xterm.raw.onData）。VS Code 同样受此 xterm.js 上游 bug 影响，但其终端
 * 默认关闭 echo，且用户对编辑器内 IME 容忍度不同，问题被掩盖。
 *
 * ## 本方案
 *
 * 在 onData 出口拦截"可能启动 IME"的单 ASCII 字母，延迟一个宏任务
 * （setTimeout(0)）判定：
 *   - 若在该窗口内 compositionstart 触发（isComposing === true）→ 说明是 IME
 *     首字母漏出，丢弃该字母，等待 compositionend 后由 IME 正常发出中文词组。
 *   - 若 compositionstart 未触发（isComposing === false）→ 是真英文输入，立即
 *     写出，延迟仅为一个宏任务周期（≤1ms，肉眼不可察）。
 *
 * ## 与已回退的方案 C 的关键区别
 *
 * - 方案 C 用 3000ms 窗口对所有 ASCII 字母做暂存等待 CJK，导致连续英文输入
 *   也被延迟 3s——当前字符不显示、只显示上一个字符，体验崩溃。
 * - 本方案延迟窗口为单个宏任务（~1ms），正常英文输入无感；仅当 IME 真正启动
 *   （compositionstart 触发）时才丢弃首字母。
 *
 * ## 参考实现
 *
 * - xterm.js CompositionHelper.keydown()：
 *   node_modules/@xterm/xterm/src/browser/input/CompositionHelper.ts:115-139
 * - WezTerm macOS ImmeDisposition 状态机（同步判定 + 不发碎片）：
 *   window/src/os/macos/window.rs:2640+
 */

export interface ImeLeakFilterOptions {
  /** 判定 IME 是否正在组合的函数（xterm 内部 compositionHelper.isComposing） */
  isComposing: () => boolean
  /** 实际写入远端的回调 */
  onFlush: (data: string) => void
}

export interface ImeLeakFilter {
  /** 喂入 onData 收到的 data。符合 IME 漏出模式的内容会被合并/drop，其余按原样透传给 onFlush。 */
  feed(data: string): void
  /** 强制 flush 暂存的 pendingLetter（用于 dispose/标签页隐藏/重连等场景）。 */
  flush(): void
  /** 销毁：清理超时定时器，flush 暂存内容。 */
  dispose(): void
}

/**
 * 判断字符是否为 ASCII 字母（IME 拼音输入的候选首字母范围）。
 * 仅 [a-zA-Z] 触发延迟判定；数字、标点、控制符不触发（它们在 IME 模式下通常
 * 产生 keyCode 229，xterm 会正确处理）。
 */
function isPossibleImeStarter(data: string): boolean {
  if (data.length !== 1) return false
  const code = data.charCodeAt(0)
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

export function createImeLeakFilter(options: ImeLeakFilterOptions): ImeLeakFilter {
  const { isComposing, onFlush } = options

  // 暂存的"可能 IME 首字母漏出"字母；等待一个宏任务确认 compositionstart 是否触发
  let pendingLetter: string | null = null
  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const flushPending = (): void => {
    if (disposed) return
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer)
      pendingTimer = null
    }
    if (pendingLetter !== null) {
      const letter = pendingLetter
      pendingLetter = null
      onFlush(letter)
    }
  }

  const scheduleDeferredCheck = (letter: string): void => {
    pendingLetter = letter
    // 单个宏任务延迟：让 compositionstart 有机会触发
    pendingTimer = setTimeout(() => {
      pendingTimer = null
      if (disposed) return
      // 检查 IME 是否在此窗口内启动了组合
      if (isComposing()) {
        // IME 正在组合 → 这是首字母漏出，丢弃该字母
        // composition 结束后，IME 会通过 onData 正常发出中文词组
        pendingLetter = null
      } else {
        // compositionstart 未触发 → 真英文输入，立即写出
        flushPending()
      }
    }, 0)
  }

  const feed = (data: string): void => {
    if (disposed) return

    if (isPossibleImeStarter(data)) {
      // 可能是 IME 首字母漏出：先 flush 已暂存的（多字母连续 = 真英文），再暂存新的
      flushPending()
      scheduleDeferredCheck(data)
      return
    }

    // 非候选首字母：先 flush 暂存的字母，再透传当前 data
    flushPending()
    onFlush(data)
  }

  const flush = (): void => {
    flushPending()
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer)
      pendingTimer = null
    }
    // dispose 时 flush 暂存的字母（避免丢失真英文输入）
    if (pendingLetter !== null) {
      const letter = pendingLetter
      pendingLetter = null
      try {
        onFlush(letter)
      } catch {
        // 忽略 dispose 期间 onFlush 的异常
      }
    }
  }

  return { feed, flush, dispose }
}
