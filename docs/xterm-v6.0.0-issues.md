# xterm.js v6.0.0 待修缺陷分析

> 数据来源：GitHub `xtermjs/xterm.js` 仓库 issue（通过 `gh api` 查询）
> 版本：6.0.0（2025-12-22 发布）
> 统计截止：2026-07-08
> 筛选范围：6.0.0 发布后新建、状态为 open 的缺陷类 issue（排除 proposal / enhancement）

## 缺陷列表

按 `reactions + comments` 综合热度排序。

### 1. #5823 — Kitty 键盘协议下 Shift+数字键输出数字而非符号

- 链接：https://github.com/xtermjs/xterm.js/issues/5823
- 热度：👍9
- 标签：无（未分类）
- 现象：VS Code 集成终端中用 Neovim，`Shift+1` 期望得到 `!`，实际得到 `1`。Ghostty 等终端正常。
- 影响：所有 VS Code 终端 + Neovim 用户，日常输入符号受阻。
- 根因：Kitty keyboard protocol 对 Shift 修饰符的报告与 Neovim 期望不一致。

### 2. #5881 — DOM 渲染器 `aria-hidden` 导致屏幕阅读器无法读取输出

- 链接：https://github.com/xtermjs/xterm.js/issues/5881
- 热度：👍8
- 标签：无
- 现象：`DomRenderer.ts` 在 `_rowContainer` 上设 `aria-hidden="true"`，终端输出对屏幕阅读器完全不可见。
- 影响：v6.0 引入的可访问性回归，影响视障用户。
- 备注：根因明确（一行代码），修复成本低、性价比高。

### 3. #5816 — macOS 26.5 beta Safari 下 WebGL 渲染完全损坏

- 链接：https://github.com/xtermjs/xterm.js/issues/5816
- 热度：👍3 💬8
- 标签：无
- 现象：macOS 26.5 beta 的 Safari 中 webgl addon 渲染花屏/错乱，切换到 canvas addon 可绕过。
- 影响：Tauri / WKWebView 及 Safari 用户，系统升级潮到来后会大面积爆发，时效性强。

### 4. #5800 — 6.0.0 在 Vite 等二次压缩场景下崩溃

- 链接：https://github.com/xtermjs/xterm.js/issues/5800
- 热度：👍1 💬6
- 标签：无
- 现象：`@xterm/xterm@6.0.0` 交付预压缩 ESM（`lib/xterm.mjs`），Vite 默认用 esbuild 再次压缩时，`InputHandler.requestMode` 闭包引用被重命名的标识符，运行时抛 `ReferenceError: i is not defined`。
- 影响：**直接点名 6.0.0**，vim 等 TUI 一触发 DCS mode 请求即崩溃，影响所有 Vite 用户。
- 备注：属发包方式缺陷，建议调整产物或 sourcemap 策略。

### 5. #5860 — image addon：文本不再覆盖图像瓦片

- 链接：https://github.com/xtermjs/xterm.js/issues/5860
- 热度：👍1 💬8
- 标签：`type/bug` `type/debt` `area/addon/image`
- 现象：Kitty graphics 引入后，文本本应覆盖图像单元格，现图像始终在最上层，`###` 等被遮住。
- 影响：IIP / Sixel 图像与文本混排场景。

### 6. #5847 — WebGL 透明背景下行残留 / 重影

- 链接：https://github.com/xtermjs/xterm.js/issues/5847
- 热度：💬8
- 标签：`type/bug` `area/addon/webgl`
- 现象：Tauri(WKWebView) + `allowTransparency` + 半透明 `theme.background`，流式输出时带 ANSI 背景的行出现重影，resize 后暂时清除。
- 影响：Claude Code / git diff / tree 等高彩输出场景，与 #5816 相关但独立。

### 7. #5801 — DEC 2026 同步更新块内 ED2 重置视口

- 链接：https://github.com/xtermjs/xterm.js/issues/5801
- 热度：👍1 💬2
- 标签：无
- 现象：6.0 新增的 DEC 2026 同步更新（PR #5453）只做了"延迟渲染"一半；`ED2`(`\x1b[2J`) 在块内仍把 `viewportY` 拉到底，造成滚动跳变。
- 影响：直接影响 `claude-code`、`codex`、`copilot-cli` 等 AI CLI 的原子帧刷新体验——属 v6.0 新特性未完成部分。

### 8. #5778 — 日文 IME 用 eisuu 键结束合成时输入重复

- 链接：https://github.com/xtermjs/xterm.js/issues/5778
- 热度：👍2
- 标签：无
- 现象：macOS 日文输入法按 `英数` 键（Karabiner 常见映射）结束合成，文本被重复输入。
- 影响：日本 Mac 用户的高频配置，IME 老大难领域。

## 其他较低关注但值得修的

| Issue | 热度 | 摘要 |
|-------|------|------|
| [#6014](https://github.com/xtermjs/xterm.js/issues/6014) | 👍1 | 多 Terminal 共享 WebGL atlas 时 `clearTextureAtlas()` 破坏其他终端 |
| [#6010](https://github.com/xtermjs/xterm.js/issues/6010) | 👍1 | `CSI Ps S`(SU) 删除行而非移入 scrollback，与 LF 滚动行为不一致 |

## 建议优先级

1. **#5800** — Vite 崩溃，直接 6.0.0 阻断，发包层修复最快见效。
2. **#5881** — 一行代码的可访问性回归，性价比最高。
3. **#5801** — v6.0 新特性 DEC 2026 未完成，影响主流 AI CLI。
4. **#5816 / #5847** — macOS 26.5 + 透明 WebGL，时效性强，需等 Safari beta 稳定后定方案。
5. **#5823 / #5860 / #5778** — 协议 / IME 长期项。

## 查询命令参考

```bash
# 发布后新建的 issue，按 reactions 排序
gh api -X GET "search/issues" \
  -f q="repo:xtermjs/xterm.js is:issue is:open created:>=2025-12-22" \
  -f sort=reactions -f order=desc -f per_page=40 \
  --jq '.items[] | {number, title, comments, reactions: .reactions.total_count, labels: [.labels[].name]}'

# 发布后新建的 issue，按 comments 排序
gh api -X GET "search/issues" \
  -f q="repo:xtermjs/xterm.js is:issue is:open created:>=2025-12-22" \
  -f sort=comments -f order=desc -f per_page=40 \
  --jq '.items[] | {number, title, comments, reactions: .reactions.total_count, labels: [.labels[].name]}'
```
