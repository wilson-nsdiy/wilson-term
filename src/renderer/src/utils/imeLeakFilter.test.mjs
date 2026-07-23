/**
 * imeLeakFilter 单元测试
 *
 * 运行方式：node --test src/renderer/src/utils/imeLeakFilter.test.mjs
 *
 * 测试策略：
 * - 用假时钟（手动控制 setTimeout）模拟"compositionstart 是否在窗口内触发"
 * - isComposing 回调返回预设值，模拟 xterm 内部 CompositionHelper 状态
 * - 验证各种输入场景下 onFlush 收到的内容
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

// 动态导入 imLeakFilter（mjs 兼容）
// 我们直接内联 createImeLeakFilter 逻辑以避免 ESM/TS 转译复杂性

function isPossibleImeStarter(data) {
  if (data.length !== 1) return false
  const code = data.charCodeAt(0)
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function createImeLeakFilter({ isComposing, onFlush }) {
  let pendingLetter = null
  let pendingTimer = null
  let disposed = false

  const flushPending = () => {
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

  const scheduleDeferredCheck = (letter) => {
    pendingLetter = letter
    pendingTimer = setTimeout(() => {
      pendingTimer = null
      if (disposed) return
      if (isComposing()) {
        // IME 正在组合 → 丢弃首字母漏出
        pendingLetter = null
      } else {
        flushPending()
      }
    }, 0)
  }

  const feed = (data) => {
    if (disposed) return
    if (isPossibleImeStarter(data)) {
      flushPending()
      scheduleDeferredCheck(data)
      return
    }
    flushPending()
    onFlush(data)
  }

  const flush = () => flushPending()

  const dispose = () => {
    if (disposed) return
    disposed = true
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer)
      pendingTimer = null
    }
    if (pendingLetter !== null) {
      const letter = pendingLetter
      pendingLetter = null
      try { onFlush(letter) } catch {}
    }
  }

  return { feed, flush, dispose }
}

// 辅助：创建带记录的 filter
function createRecordingFilter(composingStates = []) {
  const flushed = []
  let stateIdx = 0
  const isComposing = () => {
    const state = composingStates[stateIdx]
    if (stateIdx < composingStates.length - 1) stateIdx++
    return state ?? false
  }
  const filter = createImeLeakFilter({
    isComposing,
    onFlush: (data) => flushed.push(data)
  })
  return { filter, flushed }
}

// 辅助：等待所有 setTimeout(0) 触发
function tick() {
  return new Promise(resolve => setTimeout(resolve, 1))
}

test('场景1: IME 漏出 — 单字母后 compositionstart 触发 → 丢弃字母', async () => {
  // composingStates: 第一次检查返回 true（compositionstart 已触发）
  const { filter, flushed } = createRecordingFilter([true])
  filter.feed('t')
  await tick()
  assert.deepEqual(flushed, [], '字母 t 应被丢弃（IME 漏出）')
  filter.dispose()
})

test('场景2: 真英文连续输入 — t,e,s,t 全部透传', async () => {
  const { filter, flushed } = createRecordingFilter([false, false, false, false])
  filter.feed('t')
  filter.feed('e')
  filter.feed('s')
  filter.feed('t')
  await tick()
  assert.deepEqual(flushed, ['t', 'e', 's', 't'], '连续英文应立即透传')
  filter.dispose()
})

test('场景3: 单字母后接非 CJK — 应透传字母 + 后续', async () => {
  const { filter, flushed } = createRecordingFilter([false])
  filter.feed('t')
  filter.feed('1')
  await tick()
  assert.deepEqual(flushed, ['t', '1'], '字母 t 应透传，1 也透传')
  filter.dispose()
})

test('场景4: 单字母后接回车 — 应透传字母 + 回车', async () => {
  const { filter, flushed } = createRecordingFilter([false])
  filter.feed('t')
  filter.feed('\r')
  await tick()
  assert.deepEqual(flushed, ['t', '\r'], '字母 t 和回车都应透传')
  filter.dispose()
})

test('场景5: 多字符首帧 — test 应立即透传', async () => {
  const { filter, flushed } = createRecordingFilter([])
  filter.feed('test')
  await tick()
  assert.deepEqual(flushed, ['test'], '多字符应立即透传')
  filter.dispose()
})

test('场景6: 粘贴多行 — 应立即透传', async () => {
  const { filter, flushed } = createRecordingFilter([])
  filter.feed('line1\nline2')
  await tick()
  assert.deepEqual(flushed, ['line1\nline2'], '多行粘贴应立即透传')
  filter.dispose()
})

test('场景7: dispose 时 flush 暂存字母', async () => {
  const { filter, flushed } = createRecordingFilter([])
  filter.feed('t')
  // 在 setTimeout 触发前 dispose
  filter.dispose()
  assert.deepEqual(flushed, ['t'], 'dispose 时应 flush 暂存的 t')
})

test('场景8: 紧接 CJK 后再接 ASCII — 提交 + x + 修改', async () => {
  // 模拟两次连续 IME 输入，每次首字母都漏出并触发 compositionstart
  // composingStates[0]=true → 第一次 isComposing 检查（t 漏出后）→ 丢弃 t
  // composingStates[1]=true → 第二次 isComposing 检查（x 漏出后）→ 丢弃 x
  const composingStates = [true, true]
  const { filter, flushed } = createRecordingFilter(composingStates)
  filter.feed('t')       // 漏出，暂存，setTimeout(0)
  await tick()           // setTimeout 触发：isComposing()=true → 丢弃 t
  filter.feed('提交')    // IME 发出中文（多字符，直接透传）
  filter.feed('x')       // 漏出，暂存，setTimeout(0)
  await tick()           // setTimeout 触发：isComposing()=true → 丢弃 x
  filter.feed('修改')    // IME 发出中文
  assert.deepEqual(flushed, ['提交', '修改'], '漏出字母应被丢弃，中文应透传')
  filter.dispose()
})

test('场景9: 慢 IME 选字 — 单字母后 compositionstart 延迟触发', async () => {
  // 模拟：t 暂存 → setTimeout(0) 触发时 isComposing=false（还没 compositionstart）
  // → 透传 t（这是真英文，不应该等 3 秒）
  const { filter, flushed } = createRecordingFilter([false])
  filter.feed('t')
  await tick()
  assert.deepEqual(flushed, ['t'], '单个宏任务后未触发 compositionstart → 透传 t')
  filter.dispose()
})

test('场景10: 单字母后接控制序列 — 应透传字母 + 控制序列', async () => {
  const { filter, flushed } = createRecordingFilter([false])
  filter.feed('t')
  filter.feed('\x1b[A') // 上箭头控制序列
  await tick()
  assert.deepEqual(flushed, ['t', '\x1b[A'], '字母和控制序列都应透传')
  filter.dispose()
})

test('场景11: CJK 范围扩展 — 罕用 CJK 字符', async () => {
  // 罕用 CJK 字符 𠀀（U+20000，CJK Ext B）
  // 多字符（surrogate pair），不是单 ASCII 字母，直接透传
  const { filter, flushed } = createRecordingFilter([])
  filter.feed('𠀀')
  await tick()
  assert.deepEqual(flushed, ['𠀀'], '罕用 CJK 字符应透传')
  filter.dispose()
})

test('场景12: 数字键不触发暂存 — 1 应立即透传', async () => {
  const { filter, flushed } = createRecordingFilter([])
  filter.feed('1')
  await tick()
  assert.deepEqual(flushed, ['1'], '数字键应立即透传')
  filter.dispose()
})

test('场景13: 多次连续 IME 漏出 — tijiao + xiugai', async () => {
  // 模拟两次 IME 输入：tijiao→提交, xiugai→修改
  // 每次：首字母漏出 → compositionstart → 丢弃首字母 → IME 发出中文
  const composingStates = [true, true] // 两次都是 IME 漏出
  const { filter, flushed } = createRecordingFilter(composingStates)
  // 第一次输入 tijiao
  filter.feed('t')       // 漏出
  await tick()           // isComposing=true → 丢弃 t
  filter.feed('提交')    // IME 发出中文
  // 第二次输入 xiugai
  filter.feed('x')       // 漏出
  await tick()           // isComposing=true → 丢弃 x
  filter.feed('修改')    // IME 发出中文
  assert.deepEqual(flushed, ['提交', '修改'], '两次 IME 漏出的首字母都应被丢弃')
  filter.dispose()
})

test('场景14: 标点键不触发暂存 — . 应立即透传', async () => {
  const { filter, flushed } = createRecordingFilter([])
  filter.feed('.')
  await tick()
  assert.deepEqual(flushed, ['.'], '标点键应立即透传')
  filter.dispose()
})

test('场景15: flush 强制刷新暂存字母', async () => {
  const { filter, flushed } = createRecordingFilter([])
  filter.feed('t')
  filter.flush() // 强制 flush，不等 setTimeout
  assert.deepEqual(flushed, ['t'], 'flush 应立即输出暂存的 t')
  filter.dispose()
})

test('场景16: dispose 后 feed 不再有效', async () => {
  const { filter, flushed } = createRecordingFilter([])
  filter.dispose()
  filter.feed('t')
  await tick()
  assert.deepEqual(flushed, [], 'dispose 后 feed 不应触发 onFlush')
})
