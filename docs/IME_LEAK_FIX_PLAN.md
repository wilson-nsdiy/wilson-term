# IME 首字母漏出修复方案

> **状态：已回退（2026-07-21，commit `f100c86`）**
>
> 方案 C 已实现并合入，但实测发现严重副作用：`imeLeakFilter` 对**所有**单 ASCII
> 字母做 3 秒暂存等待 CJK，导致普通英文输入也被延迟——表现为当前字符不显示、
> 只显示上一个字符，连续打字体验崩溃。
>
> 根因在于方案 C 的设计缺陷：判定模式 `[a-zA-Z]` 覆盖面太广，无法区分"真英文
> 输入"与"IME 首字母漏出"，3s 暂存窗口对前者造成不可接受延迟。commit `f100c86`
> 删除 `src/renderer/src/utils/imeLeakFilter.ts` 与 `TerminalInstance.tsx` 中的
> 接入点，恢复直接 `window.api.connection.write`。
>
> **当前立场**：
>
> - 微软拼音 IME 首字母漏出 bug（输入 `tijiao` 远端收到 `t提交`）**重新出现**，
>   项目暂时接受此 bug 存在。
> - 不再考虑方案 C 的"onData 出口暂存"路线。
> - 待后续探索更精准的方案：方向是 **keydown 阶段同步判定**（参考 WezTerm macOS
>   的 `ImmeDisposition` 状态机，或在 `compositionstart` 后用 `isComposing` 反向
>   标记首字母），避免对正常英文路径产生任何副作用。
> - 若有人按本文档重新实现方案 C，**务必先阅读本回顾小节**，避免重复踩坑。

## 问题现象

在 Wilson Term 中使用微软拼音 IME 输入中文时，每次输入中文词组，发给远端的内容最前面会凭空多出一个 ASCII 字母。

**实测例子**（claude code 场景）：

| 项 | 内容 |
|---|---|
| 用户实际输入 | `提交修改`（拼音 `tijiao xiugai` + 选字） |
| 远端收到的内容 | `t提交修改` |
| 远端显示 | `t提交修改` |

被"凭空添加"的字母是 IME 拼音输入的**首字母**——输入 `tijiao` 得到 `提交`，首字母 `t` 漏出；输入 `xiugai` 得到 `修改`，首字母 `x` 漏出。

**复现特征**：

- 每次输入中文词组都会复现（非偶发）
- 漏出的字母是拼音首字母
- 在 claude code 这类 TUI 下肉眼可见（TUI 把输入内容回显到输入框）
- 普通英文输入不受影响
- 纯中文输入不受影响（只有"拼音首字母 → 中文"的过渡触发）

## 根因

### 事件时序

微软拼音输入 `tijiao` 得到 `提交`，浏览器侧的事件序列：

1. 按 `t`：浏览器触发 `keydown`（`keyCode=84`，`key='t'`，**`isComposing=false`**，无 keyCode 229）
2. `compositionstart` 触发（IME 启动组合）
3. 按 `i`/`j`/`a`/`o`：每键 `keydown`（`keyCode=229`）+ `compositionupdate`
4. 选字完成：`compositionend`（`data='提交'`）

### xterm.js 的固有 bug

xterm 的 `CompositionHelper.keydown()`（`node_modules/@xterm/xterm/src/browser/input/CompositionHelper.ts:115-139`）负责识别 IME 输入：

```typescript
public keydown(ev: KeyboardEvent): boolean {
  if (this._isComposing || this._isSendingComposition) {
    // ...组合中：吞掉 229/20/modifier，其他键立即 finalize
  }
  if (ev.keyCode === 229) {
    // IME 活动但非组合字符（数字/标点）：handle changes
    this._handleAnyTextareaChanges();
    return false;
  }
  return true;  // ← 关键：返回 true，让 xterm 继续把 keydown 当正常输入处理
}
```

**关键 bug 路径**：

1. 首字母 `t` 的 `keydown` 触发时，`compositionstart` 还没来（IME 需要一个字符启动组合），`_isComposing=false`
2. `ev.keyCode=84`（普通字母键），**不是 229**（IME composition 键码）
3. `CompositionHelper.keydown(ev)` 走到最后 `return true`
4. xterm 继续处理 keydown，把 `t` 当正常字符通过 `onData` 发出 → 远端收到 `t`
5. 紧接着 `compositionstart` 触发 → 用户继续输入 → `compositionend` 触发 → xterm 把 `提交` 通过 `onData` 发出
6. 远端总共收到：`t` + `提交` = `t提交`

**这是 xterm.js 上游的固有 bug**，不是 Wilson Term 改动引入的。上游靠浏览器的 `keyCode=229`（IME composition 键码）识别 IME 输入，但**Chromium 的中文拼音 IME 在首字母 keydown 上不返回 229**，而是返回真实字母 keyCode（如 84），`compositionstart` 在 keydown 之后才触发——这是浏览器 IME 抽象的固有局限，xterm.js 无法在首字母 keydown 同步知道"此键将启动 IME 组合"。

## 对照 WezTerm 的方案

WezTerm 不存在此问题，因为它的 IME 处理**完全绕开浏览器键盘事件链**，各平台直接对接原生 IME API：

| 平台 | IME API | 输入路径 |
|------|---------|---------|
| Linux/X11 | `xcb_imdkit`（XIM 协议） | 原生 XIM 事件 → `dispatch_ime_text` |
| macOS | NSTextInputClient（`interpretKeyEvents`） | NSResponder → `insertText` / `setMarkedText` |
| Windows | IMM32（`ImmGetCompositionStringW`） | `WM_IME_*` 消息 → `ime_composition` |

这些原生 IME API 都有"**先组合后输出**"的语义，不存在"首字母当正常 keydown 漏出、再组合"的浏览器路径。WezTerm 从源头绕开了 xterm.js 那个 bug。

**WezTerm macOS 侧的核心机制**（最贴近本问题本质的范本）：

`window/src/os/macos/window.rs:2640+` 有一套 `ImeDisposition` 状态机：

```rust
enum ImeDisposition {
    None,        // 什么都没发生
    Acted,       // IME 触发了某个动作（生成组合或预编辑）
    Continue,    // 我们决定继续走正常按键分发
}
```

按 `t` 时，WezTerm 把 NSEvent 传给 `[this interpretKeyEvents: array]`——**苹果的 IME 同步处理这个事件**：要么调用 WezTerm 注册的 `insertText`/`setMarkedText` 回调（→ `Acted`），要么什么也不调用（→ `Continue`）。WezTerm 根据状态分叉：

- `Acted` → 不发任何 `KeyEvent` 给下游，让 IME 绕自管组合流
- `Continue` → 走正常按键路径，发 `KeyEvent`
- `None` + 是 repeat → replay 上次的 `ime_last_event`

**核心洞察**：`interpretKeyEvents` 是**同步**的——返回后 IME 是否已经接管此键的状态是明确的。**不存在"keydown 先到、compositionstart 后到"的时序竞争**，因为整个判定在一个同步调用内完成。

**WezTerm 的方案对 Wilson Term 不直接适用**，因为：

1. Electron 渲染进程就是浏览器环境，输入事件链是浏览器 KeyboardEvent，**没有 WezTerm 那种直接对接原生 IME API 的路径**（除非走 native addon，工程量巨大）。
2. xterm.js 的 `CompositionHelper` 依赖浏览器 keyCode 229 来识别 IME，但**微软拼音在首字母 keydown 上不返回 229**——这是 Chromium IME 实现的固有行为。
3. 浏览器 KeyboardEvent **没有等价 `interpretKeyEvents` 的同步 API**，`KeyboardEvent.isComposing` 是当前态不是预测态，无法在首字母 keydown 同步知道"此键将启动 IME 组合"。

但 WezTerm 的**设计哲学**对方案选择有指导意义：**在输入流出口处做一次性合并，不发碎片**。WezTerm 是在 IME 完成后通过 `dispatch_ime_text` 把完整字符串发到下游，不在过程中发碎片。本方案与此精神一致。

## 方案评审

针对 Wilson Term 的架构约束（Electron + xterm.js + 浏览器事件链），评估三个候选方案：

### 方案 A：捕获阶段拦截 keydown + 一帧延迟判定

**逻辑**：textarea 上加 `capture: true` 的 keydown 监听，对"可能启动 IME"的键 `preventDefault()`，`setTimeout(0)` 后检查 `compositionHelper.isComposing`，true 则放弃，false 则手动 replay。

**优点**：从源头阻止漏发，数据流干净，对远端透明。

**缺点**：

- **副作用面大**：所有可能启动 IME 的键（字母、数字、标点）都延迟一帧（~16ms），正常英文输入也卡顿；高频输入（按住删除、快速打字）会累积。
- **判定"可能启动 IME"很难精准**：要么对所有字母键都延迟（误伤英文），要么只对 IME 活动时延迟（怎么判 IME 活动？`compositionstart` 还没触发，没有可靠信号）。微软拼音在系统级有"中/英模式"切换，但浏览器 API 拿不到这个状态。
- **replay 路径复杂**：要正确处理 Ctrl+C / Ctrl+V / Alt+Tab / 方向键 / 数字键 / 功能键这些**不能延迟**的组合键。漏一个就会破坏快捷键体验。
- **xterm 内部状态同步**：`preventDefault` 阻止了 xterm 的 keydown handler，但 xterm 内部 `_keyDownSeen` / `_keyDownHandled` 等标志位会被错位，可能引发其他输入 bug。

**结论**：理论上最干净，但实现复杂度高、副作用面大、边缘情况多。**不推荐作为 first fix**。

### 方案 B：compositionend 时补发 backspace 擦除漏出字母

**逻辑**：监听 `compositionend`，若检测到 compositionstart 之前有字母被 `onData` 漏发，先向远端补发 `\x08`（backspace）擦除它，再让 xterm 正常发出组合字符。

**优点**：实现简单，改动面小，不污染正常英文输入路径。

**缺点**：

- **backspace 在 TUI 下的行为不可控**：claude code 这类 Ink TUI 在 alternate buffer 下，`\x08` 可能被当正常字符显示（`^H` 或 `BS`）而非擦除——因为 TUI 自己接管了光标和擦除逻辑。一旦不擦除，就会留下 `tBS提交` 这种垃圾。
- **远端光标位置错乱**：补 backspace 时远端光标可能不在 `t` 之后（TUI 可能已重绘布局），擦错位置。
- **依赖远端回显**：本地终端（node-pty）默认 echo 关闭，backspace 由远端 shell 处理；但 SSH/远端 TUI 处理 backspace 的方式各异。

**结论**：实现简单但**行为不可预测**，在 TUI 场景下尤其危险。**不推荐**。

### 方案 C：拦截 onData，识别"漏出字母 + 紧接 IME 组合字符"模式并 drop（推荐）

**逻辑**：在 `xterm.onData` 回调里，若收到单个 ASCII 字母，且在极短时间窗口内紧接收到 IME 组合的中文字符（含 CJK 范围），则把那个字母 drop 掉。

**优点**：

- **副作用面最小**：只在"单 ASCII 字母 + 紧接 CJK 组合字符"的极窄模式触发，正常英文、纯中文、组合键、粘贴都不受影响。
- **对远端完全透明**：远端只收到干净的组合字符，没有 backspace 垃圾。
- **不介入 xterm 内部状态**：只在 `onData` 出口拦截，不 `preventDefault`、不延迟 keydown、不碰 `_compositionHelper`。
- **可快速验证**：实现量小，能立即验证根因诊断是否正确。
- **误判风险可控**：通过缩窄判定模式（单字母 + 紧接 CJK + 时序窗口）把误判降到极低。即使偶发误判，代价是丢一个字母——比当前"凭空多字母"症状轻得多。

**缺点**：

- **误判风险**：用户真输入 `t` 后紧接输入 `提交`（半角字母 + 中文）会被误 drop。但这种输入模式在实际中极少——尤其 claude code 这类 TUI 输入框里，用户要么纯英文要么纯中文，混杂前缀字母罕见。
- **时序窗口需调参**：窗口太长误判多，太短漏判（慢 IME 选字）。微软拼音从首字母 keydown 到 compositionend 通常 100-500ms（用户输入剩余拼音 + 选字），窗口设 3000ms 较稳。
- **CJK 范围判定**：需正确识别 UTF-8 中文字符（`\u4e00-\u9fff` 等），不能误识 ASCII。

**结论**：实现中等复杂度，**副作用最小、对远端透明、不介入 xterm 内部**。误判风险通过缩窄模式（单 ASCII 字母 + 紧接 CJK + 短窗口）可降到很低。**推荐采用**。

## 实施方案（方案 C）

### 核心设计

在 `TerminalInstance.tsx` 的 `xterm.onData` 回调里加一层 `imeLeakFilter`。维护一个"最近单字母漏出"状态：

1. 收到 data 长度=1 且是 ASCII 字母（`[a-zA-Z]`）→ 暂存到 `pendingLetter`，记录时间戳，**暂不发给远端**
2. 紧接收到 data 含 CJK 字符（含 `\u4e00-\u9fff` 范围）且距 `pendingLetter` 不足 **3000ms** → 说明是 IME 漏出，drop 掉 `pendingLetter`，只发 CJK 部分
3. 收到其他 data（回车、控制序列、多字符、非 CJK 单字符等）→ 把 `pendingLetter` 补发出去，再发新 data
4. 超时（3000ms 后无 CJK）→ 把 `pendingLetter` 补发出去（说明是真英文输入）

### 关键参数

| 参数 | 值 | 说明 |
|------|------|------|
| 时序窗口 | 3000ms | 微软拼音从首字母 keydown 到 compositionend 的耗时上限。慢用户输入剩余拼音 + 选字可达 2s+；窗口太短会漏判，太长会延迟英文输入。 |
| 暂存上限 | 最后 1 个 ASCII 字母 | 多字母连续输入（如 `test`）视为真英文，立即 flush，无延迟。 |
| 字母判定 | `[a-zA-Z]` | 只对 ASCII 字母触发暂存；数字、标点、控制符不触发。 |
| CJK 判定 | `\u4e00-\u9fff` 等范围 | 含中日韩统一表意文字、扩展 A 区等。需覆盖微软拼音可能输出的所有 CJK 范围。 |

### 文件改动

#### 新增 `src/renderer/src/utils/imeLeakFilter.ts`

独立工具，便于单元测试。导出一个工厂函数 `createImeLeakFilter(onFlush: (data: string) => void)`，返回一个 `feed(data: string): void` 方法。

**接口设计**：

```typescript
export interface ImeLeakFilter {
  /** 喂入 onData 收到的 data。符合 IME 漏出模式的内容会被合并/drop，其余按原样透传给 onFlush。 */
  feed(data: string): void
  /** 强制 flush 暂存的 pendingLetter（用于 dispose/标签页隐藏/重连等场景）。 */
  flush(): void
  /** 销毁：清理超时定时器，flush 暂存内容。 */
  dispose(): void
}

export function createImeLeakFilter(onFlush: (data: string) => void): ImeLeakFilter
```

**核心实现要点**：

- 内部状态：`pendingLetter: string | null`、`pendingAt: number`（时间戳）、`flushTimer: ReturnType<typeof setTimeout> | null`
- `feed(data)` 分叉：
  - `data.length === 1 && /^[a-zA-Z]$/.test(data)`：
    - 若已有 `pendingLetter` → 先 flush 旧的（多字母连续 = 真英文），再暂存新的
    - 否则暂存新的，安排 3000ms 超时定时器
  - `containsCJK(data)` 且 `pendingLetter !== null` 且在窗口内 → drop `pendingLetter`，透传 `data`
  - 其他 → 先 flush `pendingLetter`，再透传 `data`
- `flush()`：若有 `pendingLetter`，调 `onFlush(pendingLetter)` 并清空；取消超时定时器
- `dispose()`：flush + 取消定时器 + 标记 disposed 防止后续 feed
- `containsCJK(s)`：用正则 `[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u{20000}-\u{2a6df}\u{2a700}-\u{2ebef}]` 判定

#### 修改 `src/renderer/src/components/TerminalInstance.tsx`

在 `bindConnection`（L135）的 `xterm.onData` 回调（L149）套用 filter：

```typescript
const inputDisposable = xterm.onData((data) => {
  pinnedScrollRef.current?.onUserInput()
  rendererPluginHost.feedInput(sid, data)
  imeLeakFilterRef.current?.feed(data)  // ← 替代直接 window.api.connection.write
})
```

其中 `imeLeakFilterRef` 持有 `createImeLeakFilter((data) => window.api.connection.write(sid, data))`。

**生命周期管理**：

- 创建：在 xterm 实例创建 effect（L209）中，紧接 xterm初始化后
- dispose：在同一个 effect 的 cleanup 中，调用 `imeLeakFilterRef.current?.dispose()`
- 标签页隐藏：xterm 实例不销毁，filter 保持；但在 React strict mode 下 effect 会重复挂载/清理，需确保 dispose 正确清理

### 验证计划

#### 单元测试 `src/renderer/src/utils/imeLeakFilter.test.ts`

覆盖以下场景：

| # | 场景 | 输入序列 | 期望 onFlush 收到 |
|---|------|---------|-------------------|
| 1 | IME 漏出（单字母 + 紧接 CJK） | `'t'`, `'提交'` | `'提交'` |
| 2 | IME 漏出 + 超长选字（窗口内） | `'t'`, [等待 2500ms], `'提交'` | `'提交'` |
| 3 | IME 滑出超时（窗口外） | `'t'`, [等待 3100ms], `'提交'` | `'t'`, `'提交'` |
| 4 | 真英文连续输入 | `'t'`, `'e'`, `'s'`, `'t'` | `'t'`, `'e'`, `'s'`, `'t'` |
| 5 | 单字母后接非 CJK | `'t'`, `'1'` | `'t'`, `'1'` |
| 6 | 单字母后接回车 | `'t'`, `'\r'` | `'t'`, `'\r'` |
| 7 | 单字母后接控制序列 | `'t'`, `'\x1b[A'` | `'t'`, `'\x1b[A'` |
| 8 | 多字符首帧 | `'test'` | `'test'` |
| 9 | 粘贴多行 | `'line1\nline2'` | `'line1\nline2'` |
| 10 | dispose 时 flush | `'t'`, dispose | `'t'` |
| 11 | 紧接 CJK 后再接 ASCII | `'t'`, `'提交'`, `'x'`, `'修改'` | `'提交'`, `'修改'` |
| 12 | CJK 范围扩展（B/C/D 区） | `'t'`, `'𠀀'`（罕用 CJK） | `'𠀀'` |

#### 端到端验证

1. `npm run typecheck` 通过
2. `npm run lint` 不引入新问题
3. 手动测试：启动 `npm run dev`，本地终端（bash）启动 claude code，用微软拼音输入"提交修改"，确认远端收到的是 `提交修改` 而非 `t提交修改`
4. 对照测试：用微软拼音输入英文（IME 英文模式），确认每个字母正常透传，无延迟、无丢失
5. 对照测试：纯中文输入（IME 直接出字模式），确认无影响

### 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| 误判：用户真输入 `t` 后 3 秒内输入 `提交` → 误 drop `t` | 这种输入模式在 claude code 输入框里极罕见；即便误判，代价是丢一个字母（比当前"凭空多字母"症状轻得多） |
| 微软拼音选字慢（>3s）导致漏判 | 窗口设 3000ms 已覆盖绝大多数选字场景；若仍有报告，可调大到 5000ms |
| 用户切换 IME（搜狗/谷歌拼音）行为不同 | 本方案对 IME 类型不敏感——只要"首字母漏出 + 紧接 CJK"模式成立就生效；窗口值可在设置中暴露为可调参数 |
| React strict mode 下 effect 重复挂载导致 filter 状态错乱 | filter 实例用 ref 持有，dispose 正确清理定时器；测试覆盖 dispose 后 feed 的 safety |
| 标签页隐藏时 filter 暂存字母丢失 | 标签页隐藏不销毁 xterm，filter 保持；但可在 visibilitychange 时 flush 暂存内容（保守策略） |

### 后续可选优化（不在本次范围）

1. **设置面板暴露时序窗口参数**：让慢用户可调大窗口值
2. **多 IME 支持**：搜狗/谷歌拼音的时序行为可能不同，需测试调整
3. **replay safeguard**：若 drop 了字母但紧接的 compositionend 给出的是非 CJK 字符（比如选了英文候选），则 replay 那个字母（借鉴 WezTerm macOS 的 `ime_last_event` replay 机制）
4. **上报 native addon 接入原生 IME API**：根治该问题（工程量大，当前架构约束下不优先）

## 实施步骤

> **以下步骤对应已回退的方案 C 实现，仅作为历史记录保留。**
> **不要照此重新实现——详见文档顶部"状态：已回退"小节。**

1. **新建 `src/renderer/src/utils/imeLeakFilter.ts`**：实现 `createImeLeakFilter` 工厂函数与 `ImeLeakFilter` 接口
2. **新建 `src/renderer/src/utils/imeLeakFilter.test.ts`**：覆盖上表 12 个单元测试场景
3. **修改 `src/renderer/src/components/TerminalInstance.tsx`**：在 `bindConnection` 的 `xterm.onData` 回调套用 filter；管理 filter 生命周期（创建/dispose）
4. **验证**：typecheck + lint + 单元测试 + 端到端手动测试
5. **提交**：commit 信息描述根因、方案、与 WezTerm 对照分析

## 参考资料

- xterm.js `CompositionHelper` 源码：`node_modules/@xterm/xterm/src/browser/input/CompositionHelper.ts:115-139`
- xterm.js `CoreBrowserTerminal._keyDown` 源码：`node_modules/@xterm/xterm/src/browser/CoreBrowserTerminal.ts:845`
- WezTerm macOS IME 处理：`window/src/os/macos/window.rs:2640+`（`ImeDisposition` 状态机）
- WezTerm Windows IME 处理：`window/src/os/windows/window.rs:2945`（`WM_IME_*` 消息分流）
- WezTerm X11 IME 处理：`window/src/os/x11/connection.rs:794+`（`xcb_imdkit` 回调）
- WHATWG UTF-8 decoder spec：用于 CJK 范围判定参考
