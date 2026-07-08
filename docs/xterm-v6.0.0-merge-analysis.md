# xterm.js v6.0.0 缺陷合入分析

> 配套文档：[`xterm-v6.0.0-issues.md`](./xterm-v6.0.0-issues.md)（缺陷清单与热度排序）
>
> 本文基于 wilson-term 实际技术栈，评估各 issue 是否「既有良好方案、又与本项目相关、且改动小」，给出合入建议。
>
> 统计截止：2026-07-08 · 调研基于 xterm.js 6.0.0（上游最新版，无 6.0.1/6.1.0 发布）

## 结论速览

| Issue | 合入建议 | 方案 | 落地位置 |
|---|---|---|---|
| #5801 DEC 2026 ED2 滚动抖动 | ✅ 建议合入（ROI 最高） | `scrollOnEraseInDisplay: true` | `TerminalInstance.tsx:476` |
| #5881 DOM aria-hidden 可访问性 | ✅ 建议合入 | 运行时移除 `.xterm-rows` 的 `aria-hidden` | `TerminalInstance.tsx` |
| #5800 Vite 二次压缩崩溃 | ⚠️ 可选加固（当前未触发） | `build.target: 'es2021'` | `electron.vite.config.ts` |
| 其余 7 个 | ❌ 不建议 | 见下文 | — |

## 第一步：相关性筛选

基于 `package.json`、`TerminalInstance.tsx`、`electron.vite.config.ts` 及构建产物实证：

| Issue | 相关性 | 理由 |
|---|---|---|
| #5800 Vite 二次压缩 | **未触发** | 构建产物中 `\|\|=` 运算符保留完好，破损标记 `void 0\|\|(` 出现 0 次——electron-vite 默认 target 已够高，未做下行降级 |
| #5881 DOM aria-hidden | **相关** | 本项目用默认 DOM 渲染器（未安装 webgl addon） |
| #5801 DEC 2026 ED2 | **相关** | 用户经 SSH 运行 AI CLI（claude-code / opencode 等）会命中 |
| #5778 日文 IME | 相关但无方案 | 本项目已有 `utils/imePatch.ts`（覆盖 #6012/#5887），但 #5778 上游无修复 |
| #5823 Kitty 键盘 | 不相关 | 代码未启用 `kittyKeyboard` |
| #5816 / #5847 / #5860 / #6014 | 不相关 | 未安装 webgl / image addon |
| #6010 SU 滚动 | 无方案 | 0 评论、0 关联 PR |

上游 6.0.0 为最新版，尚无后续修复版本发布，故「升级版本」不可行，只能依靠配置 / workaround / 本地补丁。

## 第二步：值得合入的 issue（按 ROI 排序）

### 1. #5801 — 一行配置，ROI 最高 ✅

- **方案**：维护者 jerch 明确背书——设置 `scrollOnEraseInDisplay: true`，ED2 改为「下滚」而非「切屏」，行为对齐 iTerm2 / Terminal.app（AI CLI 正是在这些终端上测试的）。
- **已验证**：该选项存在于 6.0.0 构建产物中。
- **落地位置**：`src/renderer/src/components/TerminalInstance.tsx:476` 附近，与 `scrollback` 等选项并列：
  ```ts
  xterm.options.scrollback = r.scrollback
  xterm.options.scrollOnEraseInDisplay = true   // #5801: ED2 下滚，避免 AI CLI 流式重绘抖屏
  ```
- **代价 / 风险**：一行、零新依赖。唯一权衡是偏离 VT 规范（jerch 自己指出 iTerm2 的做法「spec 上不对」），但对终端应用而言，符合用户预期 > 规范纯洁。

### 2. #5881 — 运行时补丁，可访问性收益 ✅

- **方案**：PR [#5885](https://github.com/xtermjs/xterm.js/pull/5885) 已**关闭未合并**（仅 1 行删除：移除 `_rowContainer` 的 `aria-hidden`，选择层保留）。补丁理由充分、范围极小。
- **本项目无 `patch-package`**，故用更轻的运行时方式——`TerminalInstance.tsx` 已持有 `xtermElement`，终端打开后执行：
  ```ts
  // #5881: DOM 渲染器行容器被 aria-hidden 屏蔽，屏幕阅读器不可读
  xtermElement.querySelector('.xterm-rows')?.removeAttribute('aria-hidden')
  ```
- **代价 / 风险**：极低，一次性属性移除。收益是屏幕阅读器可读 DOM 文本。优先级低于 #5801。

### 3. #5800 — 有方案但本项目未触发，可选加固 ⚠️

- **社区验证最稳的方案**：renderer 配置加 `build.target: 'es2021'`，保留 esbuild 压缩、无新依赖（参考 [Pane PR #176](https://github.com/dcouple/Pane/pull/176)）。
- **但**：实测本项目构建产物**未出现破损**（`\|\|=` 保留、`void 0\|\|(` 为 0），当前无 bug 可修。
- **建议**：作为防御性加固可选加入 `electron.vite.config.ts` 的 `renderer.build`，防止后续有人调低 target：
  ```ts
  renderer: {
    build: { outDir: 'dist/renderer', target: 'es2021' },
    // ...
  }
  ```
- **非必须**，纯预防性。

## 不建议合入

- **#5778 / #6010**：上游无修复、无可靠 workaround。#5778 评论中的「状态机」方案来自个人仓库、不可信；本项目 `imePatch.ts` 已覆盖 #6012/#5887，#5778 机制不同，如确需应另行独立调研，不属于「有良好解决方案」。
- **#5823 / #5816 / #5847 / #5860 / #6014**：技术栈不匹配（未启用 Kitty 协议、未装 webgl / image addon），合入无意义。

## 验证证据

| 验证项 | 方法 | 结果 |
|---|---|---|
| #5800 是否触发 | 检查 `dist/renderer/assets/index-*.js` | `\|\|=` 保留、`void 0\|\|(` 计数 0 → 未降级，未触发 |
| `scrollOnEraseInDisplay` 选项存在 | grep 构建产物 | count: 2 → 可用 |
| 本项目渲染器类型 | `package.json` + `TerminalInstance.tsx` addon 加载 | 仅 fit + search + web-links，无 webgl/image → DOM 渲染器 |
| Kitty 协议是否启用 | grep `kittyKeyboard` | 无 → #5823 不相关 |
| 上游是否有 6.0.0 后版本 | `gh api .../releases` | 6.0.0 为最新，无修复版 |
| PR #5885 状态 | `gh api .../pulls/5885` | closed / merged: false → 未合入，需本地补丁 |
| 本项目 patch 机制 | 查 `patches/` 与 `package.json` | 无 patch-package → 用运行时补丁 |

## 一句话总结

真正「既有良好方案、又与本项目相关、且改动小」的是 **#5801（一行 option）** 与 **#5881（一行运行时补丁）**——这两个值得直接合入；#5800 可选作防御性加固；其余因无关或无方案不建议跟进。
