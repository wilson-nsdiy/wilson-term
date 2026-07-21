/**
 * IME 首字母漏出过滤器单元测试（零依赖 .mjs 版）
 *
 * 覆盖 docs/IME_LEAK_FIX_PLAN.md 中规划的 12 个场景。
 * 运行：node src/renderer/src/utils/imeLeakFilter.test.mjs
 *
 * 逻辑复制自 imeLeakFilter.ts；保持同步即可。
 *   项目无现成测试框架（package.json 无 test script，devDeps 无 vitest/jest），
 *   引入框架对小工具过重。用纯 node ESM 零依赖验证。
 */

// === 复制自 imeLeakFilter.ts（去除类型注解）===
const IME_LEAK_WINDOW_MS = 3000

const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/u
const CJK_EXT_REGEX = /[\u{20000}-\u{2a6df}\u{2a700}-\u{2ebef}]/u

function containsCJK(s) {
  return CJK_REGEX.test(s) || CJK_EXT_REGEX.test(s)
}

function isSingleAsciiLetter(s) {
  return s.length === 1 && /^[a-zA-Z]$/.test(s)
}

function createImeLeakFilter(onFlush) {
  let pendingLetter = null
  let flushTimer = null
  let disposed = false

  const clearTimer = () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
  }

  const flushPending = () => {
    clearTimer()
    if (pendingLetter !== null) {
      onFlush(pendingLetter)
      pendingLetter = null
    }
  }

  const stashLetter = (letter) => {
    if (pendingLetter !== null) {
      onFlush(pendingLetter)
      clearTimer()
    }
    pendingLetter = letter
    flushTimer = setTimeout(() => {
      flushTimer = null
      if (pendingLetter !== null) {
        onFlush(pendingLetter)
        pendingLetter = null
      }
    }, IME_LEAK_WINDOW_MS)
  }

  return {
    feed(data) {
      if (disposed) return
      if (isSingleAsciiLetter(data)) {
        stashLetter(data)
        return
      }
      if (pendingLetter !== null && containsCJK(data)) {
        clearTimer()
        pendingLetter = null
        onFlush(data)
        return
      }
      flushPending()
      onFlush(data)
    },
    flush() { flushPending() },
    dispose() {
      disposed = true
      clearTimer()
      if (pendingLetter !== null) {
        onFlush(pendingLetter)
        pendingLetter = null
      }
    }
  }
}

// === 测试框架 ===
const results = []
let passCount = 0
let failCount = 0

function makeFilter() {
  const flushed = []
  const filter = createImeLeakFilter((data) => { flushed.push(data) })
  return { filter, flushed }
}

function tick(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function check(name, actual, expected) {
  const pass = actual.length === expected.length && actual.every((v, i) => v === expected[i])
  results.push({ name, pass, detail: pass ? undefined : `期望 [${expected.map(JSON.stringify).join(', ')}] 实际 [${actual.map(JSON.stringify).join(', ')}]` })
  if (pass) passCount++
  else failCount++
}

// === 12 个场景 ===
{
  const { filter, flushed } = makeFilter()
  filter.feed('t')
  filter.feed('提交')
  check('1. IME 漏出 drop 字母', flushed, ['提交'])
}

{
  const { filter, flushed } = makeFilter()
  filter.feed('t')
  await tick(2500)
  filter.feed('提交')
  check('2. 窗口内超长选字 drop', flushed, ['提交'])
}

{
  const { filter, flushed } = makeFilter()
  filter.feed('t')
  await tick(3100)
  filter.feed('提交')
  check('3. 超时后字母已 flush，CJK 紧接透传', flushed, ['t', '提交'])
}

{
  const { filter, flushed } = makeFilter()
  filter.feed('t')
  filter.feed('e')
  filter.feed('s')
  filter.feed('t')
  filter.flush() // 最后字母 stash 后无后续 feed 触发 flush，显式 flush 验证透传
  check('4. 多字母连续视为真英文立即 flush', flushed, ['t', 'e', 's', 't'])
}

{
  const { filter, flushed } = makeFilter()
  filter.feed('t')
  filter.feed('1')
  check('5. 单字母后接数字先 flush 再透传', flushed, ['t', '1'])
}

{
  const { filter, flushed } = makeFilter()
  filter.feed('t')
  filter.feed('\r')
  check('6. 单字母后接回车先 flush 再透传', flushed, ['t', '\r'])
}

{
  const { filter, flushed } = makeFilter()
  filter.feed('t')
  filter.feed('\x1b[A')
  check('7. 单字母后接 ESC 序列先 flush 再透传', flushed, ['t', '\x1b[A'])
}

{
  const { filter, flushed } = makeFilter()
  filter.feed('test')
  check('8. 多字符首帧直接透传', flushed, ['test'])
}

{
  const { filter, flushed } = makeFilter()
  filter.feed('line1\nline2')
  check('9. 多行粘贴直接透传', flushed, ['line1\nline2'])
}

{
  const { filter, flushed } = makeFilter()
  filter.feed('t')
  filter.dispose()
  check('10. dispose 暂存字母 flush 出去', flushed, ['t'])
}

{
  const { filter, flushed } = makeFilter()
  filter.feed('t')
  filter.feed('提交')
  filter.feed('x')
  filter.feed('修改')
  check('11. 连续中文输入每词首字母 drop', flushed, ['提交', '修改'])
}

{
  const { filter, flushed } = makeFilter()
  filter.feed('t')
  filter.feed(String.fromCodePoint(0x20000))
  check('12. CJK 扩展 B 区 drop 字母', flushed, [String.fromCodePoint(0x20000)])
}

// === 报告 ===
console.log('=== IME 漏出过滤器单元测试 ===')
for (const r of results) {
  console.log(`${r.pass ? '✓' : '✗'} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`)
}
console.log(`\n总计: ${passCount} 通过, ${failCount} 失败`)
if (failCount > 0) process.exit(1)
