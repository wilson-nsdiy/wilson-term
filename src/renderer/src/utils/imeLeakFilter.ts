/**
 * IME 首字母漏出过滤器
 *
 * 修复 xterm.js 的固有 bug：微软拼音等 IME 在首字母 keydown 时不返回 keyCode 229，
 * compositionstart 在 keydown 之后才触发，导致 xterm 的 CompositionHelper.keydown
 * 走到 `return true` 分支，把首字母当正常字符通过 onData 发出。紧接 compositionend
 * 触发时 xterm 又把完整组合字符通过 onData 发出，远端总共收到"漏出字母 + 组合字符"
 * （如输入"提交"远端收到"t提交")。
 *
 * 对照 WezTerm 的设计哲学：在输入流出口处做一次性合并，不发碎片。本过滤器在
 * onData 出口拦截，识别"单 ASCII 字母 + 紧接 CJK 组合字符"的 IME 漏出模式，
 * drop 掉漏出的字母，只发完整的组合字符。
 *
 * 工作机制：
 * 1. 收到单 ASCII 字母（[a-zA-Z]）→ 暂存到 pendingLetter，记录时间戳，暂不发远端
 * 2. 在时序窗口内紧接收到含 CJK 字符的 data → 判定为 IME 漏出，drop 掉 pendingLetter，
 *    只发 CJK 部分
 * 3. 收到其他 data（回车、控制序列、多字符、非 CJK 单字符等）→ 先 flush pendingLetter
 *    再发新 data
 * 4. 超时（窗口结束无 CJK）→ flush pendingLetter（说明是真英文输入）
 *
 * 误判权衡：用户真输入"t"后 3 秒内输入"提交"会被误 drop。这种混杂输入模式在
 * TUI 输入框中极罕见；即便误判，代价是丢一个字母，远比当前"凭空多字母"症状轻。
 */

/** 时序窗口：从暂存字母到收到 CJK 组合字符的最大间隔（毫秒） */
const IME_LEAK_WINDOW_MS = 3000

/**
 * xterm 重复触发去重阈值（毫秒）。
 *
 * xterm.js 对同一按键会走两条分发路径：
 *   1. `_keyDown`（CoreBrowserTerminal.ts:921）在 keydown 事件中 triggerDataEvent
 *   2. `_inputEvent`（CoreBrowserTerminal.ts:1042）在 textarea 的 input 事件中 triggerDataEvent
 * 两次 onData 触发位于同一事件循环微任务，间隔 < 1ms。
 *
 * 而人类最快连击间隔约 30ms。取 5ms 作为阈值：
 *   - xterm 重复触发（< 1ms）远小于 5ms → 判定为重复，丢弃第二个
 *   - 人类连击（> 30ms）远大于 5ms → 判定为真连续输入，正常处理
 *
 * 不做此去重时，单字母按键会触发两次 feed(letter)：
 *   - 第一次 stash
 *   - 第二次走 stashLetter 的 if 分支 flush 旧的 + stash 新的
 *   后续非字母 feed 再 flush 一次 → 远端收到两个字母（"d " → "dd "）。
 */
const XTERM_DUPLICATE_THRESHOLD_MS = 5

/**
 * CJK 表意文字范围判定。
 *
 * 覆盖微软拼音可能输出的所有 CJK 范围：
 * - U+4E00-U+9FFF  CJK 统一表意文字（常用汉字）
 * - U+3400-U+4DBF  CJK 扩展 A
 * - U+F900-U+FAFF  CJK 兼容表意文字
 * - U+20000-U+2A6DF  CJK 扩展 B
 * - U+2A700-U+2EBEF  CJK 扩展 C/D/E
 *
 * ES2024 支持 \u{...} 码点转义，TypeScript 5 + target ES2020 可用。
 */
// 分段独立 char class，避免范围段串联（\ufaff → \u{20000} 跨越非 CJK 区且后段起
// 始码点小于前段结尾，会触发 "Range out of order"）。
// 用多个独立正则 OR 组合，既覆盖 CJK 扩展 B/C/D 区又不触发乱序。
const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/u
const CJK_EXT_REGEX = /[\u{20000}-\u{2a6df}\u{2a700}-\u{2ebef}]/u

/** 判定字符串是否含 CJK 字符 */
function containsCJK(s: string): boolean {
  return CJK_REGEX.test(s) || CJK_EXT_REGEX.test(s)
}

/** 判定是否为单 ASCII 字母（[a-zA-Z]） */
function isSingleAsciiLetter(s: string): boolean {
  return s.length === 1 && /^[a-zA-Z]$/.test(s)
}

/** IME 漏出过滤器接口 */
export interface ImeLeakFilter {
  /**
   * 喂入 onData 收到的 data。
   * 符合 IME 漏出模式的内容会被合并/drop，其余按原样透传给 onFlush。
   */
  feed(data: string): void
  /** 强制 flush 暂存的 pendingLetter（用于 dispose / 标签页隐藏 / 重连等场景） */
  flush(): void
  /** 销毁：取消超时定时器，flush 暂存内容，阻止后续 feed */
  dispose(): void
}

/**
 * 创建 IME 漏出过滤器实例。
 *
 * @param onFlush 透传回调。经过过滤器合并/drop 后的内容通过此回调发出，
 *   调用方应将其发到远端（如 window.api.connection.write）。
 *   onFlush 在 feed 同步路径内调用，调用方无需异步处理。
 */
export function createImeLeakFilter(onFlush: (data: string) => void): ImeLeakFilter {
  let pendingLetter: string | null = null
  /** 暂存字母的时间戳，用于 xterm 重复触发去重判定 */
  let pendingAt = 0
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  /** 取消超时定时器（若存在） */
  const clearTimer = (): void => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
  }

  /** 把暂存的字母透传出去并清空状态 */
  const flushPending = (): void => {
    clearTimer()
    if (pendingLetter !== null) {
      onFlush(pendingLetter)
      pendingLetter = null
    }
  }

  /**
   * 暂存单 ASCII 字母并安排超时。
   *
   * 若已有暂存字母：
   *   - 新字母与旧的相同且间隔 < XTERM_DUPLICATE_THRESHOLD_MS → 判定为 xterm 对
   *     同一按键的 keydown/input 双路径重复触发，丢弃新的、保持旧的暂存不变
   *   - 否则（多字母连续 = 真英文输入）→ 先 flush 旧的再暂存新的
   */
  const stashLetter = (letter: string): void => {
    if (pendingLetter !== null) {
      // xterm 对同一按键触发两次 onData（keydown + textarea input），
      // 间隔 < 1ms；人类连击 > 30ms。5ms 阈值区分两者。
      if (letter === pendingLetter && Date.now() - pendingAt < XTERM_DUPLICATE_THRESHOLD_MS) {
        // 重复触发：丢弃新的，保持旧的暂存与超时不变
        return
      }
      // 多字母连续 = 真英文输入，立即 flush 旧的避免累积延迟
      clearTimer()
      onFlush(pendingLetter)
      pendingLetter = null
    }
    pendingLetter = letter
    pendingAt = Date.now()
    flushTimer = setTimeout(() => {
      flushTimer = null
      // 超时未收到 CJK 组合字符，视为真英文输入，flush 暂存字母
      if (pendingLetter !== null) {
        onFlush(pendingLetter)
        pendingLetter = null
      }
    }, IME_LEAK_WINDOW_MS)
  }

  return {
    feed(data: string): void {
      if (disposed) return

      // 分叉 1：单 ASCII 字母 → 暂存（可能为 IME 首字母漏出）
      if (isSingleAsciiLetter(data)) {
        stashLetter(data)
        return
      }

      // 分叉 2：含 CJK 字符且窗口内有暂存字母 → 判定为 IME 漏出，drop 字母，透传 CJK
      if (pendingLetter !== null && containsCJK(data)) {
        // drop pendingLetter（IME 漏出的首字母），只发完整组合字符
        clearTimer()
        pendingLetter = null
        onFlush(data)
        return
      }

      // 分叉 3：其他内容 → 先 flush 暂存字母（若是真英文不应被吞），再透传新 data
      flushPending()
      onFlush(data)
    },

    flush(): void {
      flushPending()
    },

    dispose(): void {
      disposed = true
      clearTimer()
      // dispose 时 flush 暂存字母，避免标签页销毁/重连场景丢失用户输入
      if (pendingLetter !== null) {
        onFlush(pendingLetter)
        pendingLetter = null
      }
    }
  }
}
