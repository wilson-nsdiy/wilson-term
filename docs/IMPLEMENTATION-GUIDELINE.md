# Wilson Term 重构实施方针

> 本方针基于 Tauri 2 + xterm.js 现有架构，重构为纯 Rust + wgpu 原生终端模拟器。
> 高风险模块的代码路径与实现细节均来自本地参考源码 `/home/ubuntu/github_projects/wezterm`。

---

## 一、技术栈

### 1.1 核心选型

| 层 | 选型 | 版本要求 | 说明 |
|---|---|---|---|
| 桌面框架 | **Tauri 2**（保留） | — | 仍承载窗口生命周期、托盘、IPC 通道、自动更新 |
| GPU 渲染 | **wgpu 24+** | Surface 模式 | 多窗口共享 `Instance` + `Adapter`，每窗口独立 `Surface` + `Device` + `Queue` |
| 窗口系统 | **winit 0.30+** | `WindowAttributes` | 主窗口由 Tauri 提供；Tear-off 子窗口用 winit 独立创建（共享 wgpu `Instance`） |
| PTY | **portable-pty 0.9+** | — | 每窗口独立 PTY，保留现有 bash/telnet/serial 后端调用模式 |
| 字体 Shaping + 光栅化 | **swash 0.1+** | 仅此一个 | 一体化完成 shaping + 光栅化，删除原方案里的 `fontdue`（避免双光栅化冲突） |
| 字体数据库 | **fontdb 0.20+** | — | 系统字体枚举 + 自定义字体路径 |
| 文本布局 | **cosmic-text 0.12+** | 跟随 glyphon 选定版本 | 段落换行、双向文本、行高计算 |
| Glyph 缓存 | **自研 GPU Atlas**（不使用 glyphon 的固定 atlas） | — | 借鉴 wezterm 三层结构：`Atlas` → `AtlasList` → `GlyphCache` |
| 序列解析 | **自研状态机** + fork `vtparse` | vtparse 0.7 | 直接 fork wezterm `vtparse/`（1165 行），无需改动 |
| 序列语义 | 自研 | — | 参考 wezterm `wezterm-escape-parser/`（6111 行）的分层架构 |
| 终端状态机 | 自研 | — | 参考 wezterm `term/src/terminalstate/`（3875 行）的 `TermMode` bitflags 设计 |
| 图形协议 | **自研 Kitty 解码** + Sixel | — | 每窗口独立纹理池；参考 wezterm `terminalstate/kitty.rs`（979 行） |
| 配置 | **toml** + **notify 7+** | — | 热重载：字体、主题、间距、大小 |
| 输入解析 | **winit WindowEvent**（主路径）+ crossterm（仅 fallback） | — | 明确分工：crossterm 不做 VT 序列解析 |
| 日志 | **tracing** + **tracing-subscriber** | — | 结构化日志，替代现有 `log` |
| 异步运行时 | **tokio 1**（保留） | — | PTY 读取、SFTP、连接管理 |

### 1.2 删除的依赖

| 依赖 | 删除原因 |
|---|---|
| `@xterm/xterm` 及所有 addon | 整个前端终端引擎被 Rust + wgpu 替换 |
| `fontdue` | 与 swash 光栅化功能重叠 |
| `glyphon`（原方案） | 不支持「全局共享 atlas + 动态扩容」语义 |
| React 渲染层中的 xterm 集成代码 | `utils/xtermEnhancements.ts`、`components/Terminal.tsx` 中的 xterm 实例化逻辑 |

### 1.3 保留的依赖

| 依赖 | 保留原因 |
|---|---|
| React 18 + TypeScript 5 | 渲染 UI 外壳：标题栏、侧边栏、标签栏、设置对话框、SFTP 管理器 |
| Zustand 5 | 全局状态管理（会话列表、设置、当前活动标签） |
| Tailwind CSS 3 | UI 样式 |
| russh 0.50 + russh-sftp 2.x | SSH 后端 |
| serialport 4 | 串口后端 |

---

## 二、功能点清单

### 2.1 终端协议层（TUI 兼容核心）

| 功能 | 协议 | 优先级 | 实现路径 |
|---|---|---|---|
| VT100/ANSI 转义序列 | C0/C1、SGR、光标移动、清屏 | P0 | vtparse fork + terminalstate/performer |
| CSI 序列 | 光标定位、插入/删除行列、滚动区域（DECSTBM） | P0 | wezterm-escape-parser/csi.rs 架构 |
| DCS/OSC 序列 | 标题设置（OSC 0/2）、特性查询、自定义协议 | P0 | wezterm-escape-parser/osc.rs 架构 |
| 256 色支持 | 216 色立方 + 24 灰度 + 16 标准色 | P0 | swash 渲染时自动处理 |
| True Color (24-bit) | RGB 直接指定 | P0 | wgpu 纹理格式用 `Rgba8UnormSrgb` |
| 鼠标协议 - X10 | 基本点击 | P0 | terminalstate/mouse.rs:8 `encode_coord` |
| 鼠标协议 - UTF8 扩展 | 大屏幕坐标 | P0 | 同上 |
| 鼠标协议 - SGR | press=M / release=m 区分 | P0 | mouse.rs:148,196,272 分支 |
| 鼠标协议 - URXVT | 1015 模式 | P1 | mouse.rs 兼容分支 |
| Bracketed Paste | DEC 2004 | P0 | terminalstate/mod.rs:823-841 `send_paste` |
| Focus Event | DEC 1004 | P0 | mod.rs:313,787,1806 |
| 备用屏幕缓冲区 | DEC 47 / 1047 / 1049 | P0 | mod.rs:1673-1677 |
| 回滚缓冲区 | 可配置历史行数 | P0 | 自研 ring buffer，默认 10000 行 |
| 终端能力查询 | DA1/DA2/DA3、XTVERSION、XTGETTCAP | P0 | 必须照搬 DA 响应格式 |
| 颜色查询/设置 | OSC 4/10/11/12 | P0 | osc.rs 架构 |

### 2.2 键盘增强协议（Claude Code / opencode 关键）

| 功能 | 协议 | 优先级 | 实现路径 |
|---|---|---|---|
| Kitty keyboard protocol | `CSI > 1 u` pop/push/query | P0 | wezterm-input-types/lib.rs:1711 `encode_kitty` |
| Kitty keyboard flags | DISAMBIGUATE / REPORT_EVENT / REPORT_ALTERNATE / REPORT_ALL_KEYS / REPORT_ASSOCIATED | P0 | lib.rs:2034 `KittyKeyboardFlags` bitflags |
| `modifyOtherKeys` (xterm) | `CSI > 4 ; n M` | P0 | mod.rs:291,1954 `modify_other_keys: Option<i64>` |
| ESC 特殊处理 | 开启 DISAMBIGUATE 时 ESC 走 `CSI 27;1 u` 而非原始 `\x1b` | P0 | lib.rs:1726-1731（这是 Ink/Bubble Tea 快捷键体验的关键细节） |
| 区分 Ctrl+I / Tab | 依赖 Kitty keyboard | P0 | 同上 |
| 区分 Ctrl+[ / Esc | 依赖 Kitty keyboard | P0 | 同上 |
| 区分 Shift+Enter / Enter | 依赖 Kitty keyboard | P1 | 同上 |

### 2.3 同步更新（Bubble Tea / ratatui 重度依赖）

| 功能 | 协议 | 优先级 | 实现路径 |
|---|---|---|---|
| BSU（Begin Synchronized Update） | `CSI ? 2026 h` | P0 | 终端状态机加 `synced_update: bool`，set 时置 true |
| ESU（End Synchronized Update） | `CSI ? 2026 l` | P0 | 同上，reset 时置 false |
| 渲染延迟 | BSU 期间渲染器不提交帧，ESU 后统一 flush | P0 | **必须从渲染架构设计阶段就纳入**，事后补会重构整个渲染层 |
| ESU 超时兜底 | BSU 后超过 200ms 仍未收到 ESU，强制 flush 一次 | P0 | 防止 TUI 程序崩溃时终端永久卡帧 |

> **重要提示**：wezterm 在 `terminalstate/mod.rs:1573-1589` 把 2026 的处理委托给了 mux 层（`// This is handled in wezterm's mux`），term 本身只做状态记录。我们的架构没有 mux 层，必须在渲染管线层实现「延迟一帧渲染」逻辑。这是**必须主动补齐**而非「借鉴」的缺口，约 80-120 行代码。

### 2.4 图形协议

| 功能 | 协议 | 优先级 | 实现路径 |
|---|---|---|---|
| Kitty 图形协议 | APC G… | P1 | wezterm `terminalstate/kitty.rs`（979 行）状态机框架 |
| Kitty 传输 | `t=d` 直接传输、`t=i` 间接传输 | P1 | 同上，注意 zlib 压缩帧需 `flate2` |
| Kitty 分片重组 | `m=1` 续帧标记 | P1 | 同上 |
| Kitty Placement | `p=N` 多图叠加 | P2 | 同上 |
| Sixel 协议 | DSC q…ST | P1 | wezterm `terminalstate/sixel.rs`（156 行，最简单，建议先读） |
| iTerm2 图像协议 | OSC 1337 | P2 | wezterm `terminalstate/iterm.rs` |
| 每窗口独立纹理池 | 图像数据与窗口生命周期绑定 | P1 | 渲染层管理，窗口关闭时清理纹理 |

### 2.5 渲染层

| 功能 | 说明 | 优先级 | 实现路径 |
|---|---|---|---|
| wgpu Surface 配置 | HiDPI、`SurfaceConfiguration`、`desired_maximum_frame_latency` | P0 | wezterm `termwindow/webgpu.rs`（561 行） |
| 主着色器 | WGSL，glyph atlas 采样 + 颜色混合 | P0 | wezterm `shader.wgsl` + `glyph-frag.glsl` |
| 渲染管线抽象 | `RenderContext` 枚举：wgpu 主路径 + 未来可选 fallback | P0 | wezterm `renderstate.rs:22-26` 模式 |
| Vertex/Index Buffer 管理 | 每帧动态分配，复用缓冲区 | P0 | wezterm `renderstate.rs` `allocate_vertex_buffer` |
| Glyph Atlas 三层结构 | `Atlas`（单纹理 + guillotiere 分配器）→ `AtlasList`（多纹理按需创建）→ `GlyphCache`（字形 → sprite 业务层） | P0 | wezterm `window/src/bitmaps/atlas.rs`（172 行）+ `glyphcache.rs`（1376 行） |
| Atlas 动态扩容 | `allocate()` 失败返回 `OutOfTextureSpace { size: 下一档尺寸 }`，上层据此创建新 atlas | P0 | atlas.rs:58-122 |
| 同步更新渲染逻辑 | BSU 期间不提交帧，ESU 后 flush | P0 | 渲染器加 `synced_update` 状态字段 |
| ESU 超时兜底 | BSU 后 200ms 强制 flush | P0 | 渲染器定时器 |

### 2.6 字体处理

| 功能 | 说明 | 优先级 | 实现路径 |
|---|---|---|---|
| 字体加载/匹配 | 主字体 + 回退字体链 + 各样式（Regular/Bold/Italic） | P0 | wezterm `wezterm-font/lib.rs` 的 `FontConfiguration` 设计 |
| Shaping | 复杂脚本、连字、RTL | P0 | swash |
| 光栅化 | 字形位图生成，支持 subpixel | P0 | swash（**删除 fontdue，避免双光栅化冲突**） |
| 彩色字形（emoji） | COLR/CPAL 表支持 | P1 | swash 原生支持 |
| 字号 → 像素换算 | DPI 感知 | P0 | wezterm `wezterm-font/units.rs` |

### 2.7 配置与热重载

| 功能 | 说明 | 优先级 |
|---|---|---|
| TOML 配置文件 | 替代现有 JSON 持久化，更人类可读 | P0 |
| 热重载 - 字体 | 修改 fontFamily/fontSize 后实时生效 | P0 |
| 热重载 - 主题 | 修改 colorScheme 后实时生效 | P0 |
| 热重载 - 间距 | 修改 letterSpacing/lineHeight 后实时生效 | P1 |
| 热重载 - 大小 | 修改窗口大小、padding 后实时生效 | P1 |

### 2.8 保留的现有功能

| 功能 | 状态 | 说明 |
|---|---|---|
| SSH / Telnet / 串口 / 本地终端连接 | ✅ 保留 | 后端逻辑不变，仅前端 xterm 替换为 Rust 渲染 |
| SFTP 文件管理 | ✅ 保留 | 复用 russh-sftp |
| 会话日志 | ✅ 保留 | 复用现有 logger.rs，剥离 ANSI 改为渲染层提供 |
| 插件系统 | ✅ 保留 | 复用 plugin_host.rs |
| 多标签页 | ✅ 保留 | 每个 tab 对应一个独立 PTY + 渲染实例 |
| 自动更新 | ✅ 保留 | 复用 Tauri updater |

---

## 三、架构分层

```
┌─────────────────────────────────────────────────────────────────┐
│  Tauri 2 (窗口生命周期、托盘、IPC、自动更新)                       │
├─────────────────────────────────────────────────────────────────┤
│  React 18 + TypeScript 5 (UI 外壳)                               │
│  ├── TitleBar / Sidebar / TabBar                                 │
│  ├── SettingsDialog / SftpFileManager                            │
│  └── Zustand Store (会话/设置/活动标签)                           │
├─────────────────────────────────────────────────────────────────┤
│  Rust 后端                                                       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  连接层 (connection/)                                     │   │
│  │  ├── ssh.rs (russh)  ├── telnet.rs  ├── serial.rs         │   │
│  │  └── bash.rs (portable-pty) — 每窗口独立 PTY              │   │
│  ├─────────────────────────────────────────────────────────┤   │
│  │  终端核心 (terminal-core/)                                │   │
│  │  ├── parser/       — fork vtparse，VT 状态机             │   │
│  │  ├── escape/       — CSI/OSC/DCS 语义层                  │   │
│  │  ├── state/        — TerminalState + TermMode bitflags   │   │
│  │  ├── screen/       — 主屏/备屏 + 回滚 ring buffer        │   │
│  │  ├── keyboard/     — Kitty keyboard protocol 编码器      │   │
│  │  ├── mouse/        — X10/UTF8/SGR/URXVT 编码            │   │
│  │  ├── image/        — Kitty/Sixel/iTerm2 图形协议         │   │
│  │  └── sync/         — BSU/ESU 同步更新状态                 │   │
│  ├─────────────────────────────────────────────────────────┤   │
│  │  渲染层 (renderer/)                                       │   │
│  │  ├── wgpu.rs       — wgpu Instance/Adapter/Device        │   │
│  │  ├── atlas.rs      — GPU Glyph Atlas 三层结构             │   │
│  │  ├── glyph.rs      — 字形 → sprite 业务层                │   │
│  │  ├── shader/       — WGSL 主着色器                       │   │
│  │  ├── sync.rs       — BSU/ESU 渲染延迟逻辑                 │   │
│  │  └── pipeline.rs   — 渲染管线抽象 (RenderContext)        │   │
│  ├─────────────────────────────────────────────────────────┤   │
│  │  字体层 (font/)                                           │   │
│  │  ├── fontdb.rs     — 系统字体枚举                         │   │
│  │  ├── swash.rs      — Shaping + 光栅化                    │   │
│  │  ├── config.rs     — FontConfiguration (主+回退链)        │   │
│  │  └── units.rs      — 字号 → 像素换算                     │   │
│  ├─────────────────────────────────────────────────────────┤   │
│  │  配置层 (config/)                                         │   │
│  │  ├── toml.rs       — TOML 配置文件读写                    │   │
│  │  └── watcher.rs    — notify 热重载                       │   │
│  └─────────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────┤
│  wgpu 24+ (GPU 渲染) + winit 0.30+ (子窗口) + tokio 1 (异步)     │
└─────────────────────────────────────────────────────────────────┘
```

---

## 四、实施阶段与里程碑

### 阶段 0：准备与脚手架（1 周）

**目标**：建立新的 crate 结构，不破坏现有功能。

**任务**：
1. 在 `src-tauri/Cargo.toml` 中添加 wgpu、winit、swash、fontdb、guillotiere、notify 依赖
2. 创建 `terminal-core/` workspace 成员，初始结构：
   ```
   terminal-core/
   ├── Cargo.toml
   └── src/
       ├── lib.rs
       ├── parser/      # 占位
       ├── escape/      # 占位
       ├── state/       # 占位
       └── screen/      # 占位
   ```
3. Fork wezterm `vtparse/` 到 `terminal-core/src/parser/vtparse/`，验证 `cargo check` 通过
4. 在现有 `commands.rs` 中添加 `terminal_init` 占位命令，注册到 `register_all()`

**验收标准**：
- `cargo check` 通过
- `npm run dev` 启动后现有功能全部正常（xterm.js 仍在运行）
- Fork 的 vtparse 通过其原有单元测试

---

### 阶段 1：终端核心层（4 周）

**目标**：完成 VT 解析、序列语义、终端状态机，能脱离 UI 独立测试。

#### 1.1 VT 状态机（1 周）

**借鉴**：`vtparse/src/lib.rs`（1165 行）+ `vtparse/src/transitions.rs`（372 行表驱动）

**实现**：
- `parser/vtparse/` —— 已 fork，无需改动
- `parser/actor.rs` —— 实现 `VTActor` trait，把状态机输出转成 `Action` 枚举

**关键设计**：
```rust
// 借鉴 wezterm-escape-parser/src/lib.rs:42-62
pub enum Action {
    Print(char),
    PrintString(String),
    Control(ControlCode),
    DeviceControl(DeviceControlMode),
    OperatingSystemCommand(Box<OperatingSystemCommand>),
    CSI(CSI),
    Esc(Esc),
    Sixel(Box<Sixel>),
    KittyImage(Box<KittyImage>),
}
```

**验收标准**：
- 输入 `\x1b[31mhello\x1b[0m` 输出 `[CSI(SGR red), Print('h'), ..., CSI(SGR reset)]`
- 通过 vtparse 自带的 200+ 个序列解析测试

#### 1.2 序列语义层（1.5 周）

**借鉴**：
- `wezterm-escape-parser/src/csi.rs`（3395 行）—— CSI 参数解析
- `wezterm-escape-parser/src/osc.rs`（2000 行）—— OSC 命令解析
- `wezterm-escape-parser/src/apc.rs`（1269 行）—— APC / Kitty 图形

**实现**：
- `escape/csi.rs` —— CSI 序列解析，参考 wezterm 的 `CSI::parse` 设计
- `escape/osc.rs` —— OSC 序列解析，覆盖 OSC 0/2/4/10/11/12/52/1337
- `escape/dcs.rs` —— DCS 序列解析（Sixel 入口）
- `escape/apc.rs` —— APC 序列解析（Kitty 图形入口）

**验收标准**：
- `OSC 0 ; "title" ST` 解析为 `SetTitle("title")`
- `CSI 2 J` 解析为 `EraseDisplay(All)`
- `CSI ? 2026 h` 解析为 `SetDecPrivateMode(SynchronizedOutput)`

#### 1.3 终端状态机（1.5 周）

**借鉴**：`term/src/terminalstate/mod.rs`（2766 行）

**实现**：
- `state/mod.rs` —— `TerminalState` 主结构
- `state/modes.rs` —— `TermMode` bitflags（借鉴 wezterm 的 bitflags 集中管理设计）
- `state/performer.rs` —— `impl VTActor for Performer`，把 `Action` 应用到 `TerminalState`
- `screen/mod.rs` —— 主屏/备屏切换 + 回滚 ring buffer
- `screen/buffer.rs` —— 行缓冲区，支持宽字符、组合字符

**关键字段**（借鉴 wezterm `terminalstate/mod.rs:288-542`）：
```rust
pub struct TerminalState {
    pub screen: Screen,                    // 主屏 + 备屏
    pub cursor: Cursor,                   // 位置、样式、颜色
    pub mode: TermMode,                   // 所有 DEC private modes 集中管理
    pub bracketed_paste: bool,            // mod.rs:309
    pub focus_tracking: bool,             // mod.rs:313
    pub modify_other_keys: Option<i64>,   // mod.rs:291
    pub mouse_encoding: MouseEncoding,    // X10/UTF8/SGR/URXVT
    pub mouse_tracking: bool,             // button-event tracking
    pub any_event_mouse: bool,            // any-event tracking
    pub synced_update: bool,              // BSU/ESU 状态，本架构新增
    pub alt_screen_active: bool,          // 备屏激活标志
    pub scrollback: ScrollbackBuffer,     // 回滚缓冲区
}
```

**验收标准**：
- 运行 `vim` 启动 → 备屏激活 → 退出 → 备屏恢复主屏内容
- 运行 `tmux` → mouse SGR 编码正确（`CSI < button ; col ; row M/m`）
- `CSI ? 2026 h` 后 `synced_update == true`

---

### 阶段 2：渲染层（5 周）

**目标**：wgpu 渲染管线跑通，能显示终端内容，BSU/ESU 同步更新生效。

#### 2.1 wgpu 基础设施（1 周）

**借鉴**：`wezterm-gui/src/termwindow/webgpu.rs`（561 行）

**实现**：
- `renderer/wgpu.rs` —— wgpu `Instance`/`Adapter`/`Device`/`Queue` 创建
- `renderer/surface.rs` —— `Surface` 配置，HiDPI 处理
- `renderer/pipeline.rs` —— `RenderContext` 枚举抽象（借鉴 `renderstate.rs:22-26`）

**关键设计**：
```rust
// 借鉴 wezterm renderstate.rs:22-26
pub enum RenderContext {
    Wgpu(Rc<WgpuState>),
    // 未来可加其他后端
}
```

**验收标准**：
- 创建 wgpu Surface，清屏为指定背景色
- HiDPI 显示器上字体不模糊

#### 2.2 Glyph Atlas 三层结构（2 周）—— **最高风险点**

**借鉴**：
- `window/src/bitmaps/atlas.rs`（172 行）—— `Atlas` 单纹理 + guillotiere 分配器
- `window/src/bitmaps/mod.rs`（468 行）—— `AtlasList` 多纹理管理
- `wezterm-gui/src/glyphcache.rs`（1376 行）—— `GlyphCache` 字形 → sprite 业务层

**实现**：
- `renderer/atlas.rs` —— `Atlas` 结构
  ```rust
  // 借鉴 atlas.rs:21-28
  pub struct Atlas {
      texture: Rc<dyn Texture2d>,
      allocator: SimpleAtlasAllocator,  // guillotiere
      side: usize,                       // 2 的幂
  }
  ```
- `renderer/atlas_list.rs` —— `AtlasList` 多纹理管理，`allocate()` 失败时按 `OutOfTextureSpace.size` 创建新 atlas（借鉴 `atlas.rs:58-122`）
- `renderer/glyph.rs` —— `GlyphCache` 字形 → sprite 业务层
  - 输入：`GlyphRequest { font, codepoint, style, size }`
  - 输出：`Sprite { atlas_id, rect, uv_coords }`
  - 缓存：LRU 缓存最近使用的字形

**验收标准**：
- 渲染 1000 个不同字形不崩溃
- 重复渲染相同字形时 atlas 命中（不重新光栅化）
- Atlas 满时自动创建新 atlas（动态扩容）

#### 2.3 着色器与渲染循环（1 周）

**借鉴**：
- `wezterm-gui/src/shader.wgsl` —— 主着色器
- `wezterm-gui/src/glyph-frag.glsl` —— glyph 片段着色器
- `wezterm-gui/src/termwindow/render/paint.rs`（282 行）—— 主绘制循环

**实现**：
- `renderer/shader/main.wgsl` —— WGSL 主着色器
- `renderer/render_loop.rs` —— 每帧渲染循环
  1. 从 `TerminalState` 提取可见行
  2. 对每个 cell 查询 `GlyphCache`，得到 sprite
  3. 构建 vertex buffer（每个 cell 6 个顶点，2 个三角形）
  4. 提交 wgpu render pass

**验收标准**：
- 终端能显示 ASCII 字符
- 光标位置正确
- 滚动时无撕裂

#### 2.4 BSU/ESU 同步更新渲染逻辑（1 周）—— **架构补齐缺口**

**借鉴**：wezterm 在 `terminalstate/mod.rs:1573-1589` 把 2026 委托给 mux 层，本架构需在渲染层实现。

**实现**：
- `renderer/sync.rs` —— 同步更新渲染逻辑
  ```rust
  pub struct SyncUpdateState {
      synced: bool,
      bsu_time: Option<Instant>,
  }

  impl SyncUpdateState {
      pub fn begin(&mut self) {
          self.synced = true;
          self.bsu_time = Some(Instant::now());
      }

      pub fn end(&mut self) {
          self.synced = false;
          self.bsu_time = None;
      }

      pub fn should_flush(&self) -> bool {
          // ESU 后立即 flush
          // 或 BSU 后 200ms 超时强制 flush（防止 TUI 崩溃时永久卡帧）
          !self.synced || self.bsu_time.map_or(false, |t| t.elapsed() > Duration::from_millis(200))
      }
  }
  ```
- 渲染循环中 `should_flush() == false` 时跳过 `queue.submit()`，但保留 `SurfaceTexture` 不丢弃
- ESU 收到后立即触发一次 flush

**验收标准**：
- 运行 `lazygit`（重绘频繁的 TUI），观察无闪烁
- 强制 kill 一个 BSU 中但未 ESU 的 TUI 程序，终端在 200ms 后恢复渲染（不永久卡帧）

---

### 阶段 3：键盘与鼠标输入（2 周）

**目标**：Claude Code / opencode 等 TUI 程序的快捷键和鼠标交互正确。

#### 3.1 Kitty keyboard protocol 编码器（1 周）—— **Claude Code/opencode 关键**

**借鉴**：`wezterm-input-types/src/lib.rs:1711` 的 `encode_kitty(flags)`（3275 行文件中的核心函数）

**实现**：
- `keyboard/kitty.rs` —— Kitty keyboard 编码器
  ```rust
  // 借鉴 lib.rs:2034-2042
  bitflags! {
      pub struct KittyKeyboardFlags: u16 {
          const DISAMBIGUATE_ESCAPE_CODES = 1;
          const REPORT_EVENT_TYPES = 2;
          const REPORT_ALTERNATE_KEYS = 4;
          const REPORT_ALL_KEYS_AS_ESCAPE_CODES = 8;
          const REPORT_ASSOCIATED_TEXT = 16;
      }
  }

  pub fn encode_kitty(event: &KeyEvent, flags: KittyKeyboardFlags) -> String {
      // 借鉴 lib.rs:1711-2030 完整实现
      // 关键：lib.rs:1726-1731 的 ESC 特殊处理
      // 开启 DISAMBIGUATE_ESCAPE_CODES 时，ESC 不能作为原始 \x1b 发送，
      // 必须走 CSI 27;1 u 路径（这是 Ink/Bubble Tea 快捷键体验的关键细节）
  }
  ```
- `keyboard/flags.rs` —— Kitty keyboard flags 状态管理
  - `CSI > 1 u` pop（恢复默认）
  - `CSI > 1 ; flags u` push（设置 flags）
  - `CSI ? 1 u` query（查询当前 flags）
  - 响应格式：`CSI > 1 ; flags u`

**验收标准**：
- 在 Claude Code 中按 Ctrl+I，终端发送 `CSI 9 u`（Kitty keyboard 编码），而非 Tab 字符
- 在 opencode 中按 Ctrl+[，终端发送 `CSI 27 u`，而非 Esc 字符
- 按普通字母键，终端发送原始字符（flags 未开启 REPORT_ALL_KEYS 时）

#### 3.2 `modifyOtherKeys` 实现（0.5 周）

**借鉴**：`terminalstate/mod.rs:291,1954` 的 `modify_other_keys: Option<i64>`

**实现**：
- 终端状态机加 `modify_other_keys: Option<i64>` 字段
- `CSI > 4 ; n M` 设置 modify_other_keys 为 n
- `CSI > 4 M` 重置 modify_other_keys 为 None
- 键盘编码时，若 `modify_other_keys == Some(1)` 或 `Some(2)`，对带修饰键的组合使用 `CSI <key>;<mods>u` 编码

**验收标准**：
- 在 vim 中按 Ctrl+Shift+V，正确触发 vim 的粘贴功能（而非终端拦截）

#### 3.3 鼠标 SGR 编码（0.5 周）

**借鉴**：`term/src/terminalstate/mouse.rs`（364 行）

**实现**：
- `mouse/sgr.rs` —— SGR 编码
  - Press: `CSI < button ; col ; row M`（大写 M）
  - Release: `CSI < button ; col ; row m`（小写 m）
  - **关键细节**：M/m 不能写反，否则 fzf / lazygit 的点击交互失效
- `mouse/encoding.rs` —— 四种编码统一抽象（X10/UTF8/SGR/URXVT）

**验收标准**：
- 在 fzf 中鼠标点击某项，正确选中
- 在 lazygit 中鼠标拖拽，正确滚动

---

### 阶段 4：图形协议（2 周）

**目标**：支持 Kitty 图形协议和 Sixel，能在终端显示图像。

#### 4.1 Sixel 协议（0.5 周）—— **最简单，先做**

**借鉴**：`term/src/terminalstate/sixel.rs`（156 行）

**实现**：
- `image/sixel.rs` —— Sixel 解码器
  - DSC q…ST 序列解析
  - 六角字节流 → 像素数据
  - 颜色寄存器管理（16 色调色板）

**验收标准**：
- 运行 `img2sixel image.png | cat` 能在终端显示图像

#### 4.2 Kitty 图形协议（1.5 周）

**借鉴**：`term/src/terminalstate/kitty.rs`（979 行）+ `wezterm-escape-parser/src/apc.rs`（1269 行）

**实现**：
- `image/kitty.rs` —— Kitty 图形状态机
  - APC G…ST 序列解析
  - 传输模式：`t=d` 直接传输、`t=i` 间接传输
  - 压缩：zlib 压缩帧的解压（用 `flate2`）
  - 分片重组：`m=1` 续帧标记
  - Placement：`p=N` 多图叠加
- `image/texture_pool.rs` —— 每窗口独立纹理池
  - 图像数据上传到 wgpu 纹理
  - 窗口关闭时清理纹理
  - 图像删除时回收纹理（`a=d` 删除命令）

**验收标准**：
- 运行 `kitten icat image.png` 能在终端显示图像
- 关闭窗口后无 wgpu 纹理泄漏（用 `wgpu::Device::on_uncaptured_error` 监控）

---

### 阶段 5：字体与配置（1.5 周）

**目标**：字体加载、Shaping、光栅化跑通；配置文件热重载生效。

#### 5.1 字体处理（1 周）

**借鉴**：
- `wezterm-font/src/lib.rs` —— `FontConfiguration` 设计
- `wezterm-font/src/units.rs` —— 字号 → 像素换算

**实现**：
- `font/fontdb.rs` —— 系统字体枚举（fontdb）
- `font/swash.rs` —— Shaping + 光栅化（swash）
  - 输入：`FontRequest { family, style, weight, size, dpi }`
  - 输出：`GlyphBitmap { data, width, height, bearing_x, bearing_y }`
- `font/config.rs` —— `FontConfiguration`（主字体 + 回退字体链）
  - 借鉴 wezterm 的「主字体 + emoji 字体 + CJK 字体」回退链设计
- `font/units.rs` —— 字号 → 像素换算（DPI 感知）

**验收标准**：
- 显示中文、日文、emoji 字符不出现方框（□）
- 不同字号下字符宽度一致（monospace 对齐）

#### 5.2 配置与热重载（0.5 周）

**借鉴**：notify crate 标准用法

**实现**：
- `config/toml.rs` —— TOML 配置文件读写
  ```toml
  [font]
  family = "Cascadia Code"
  size = 14
  weight = "normal"

  [theme]
  scheme = "Catppuccin Mocha"

  [scrollback]
  lines = 10000
  ```
- `config/watcher.rs` —— notify 热重载
  - 监听配置文件变化
  - 变化时通过 Tauri event 通知前端
  - 前端调用 `terminal_reload_config` 命令触发后端重新加载

**验收标准**：
- 修改配置文件后 1 秒内生效，无需重启应用
- 字体、主题、间距、大小的修改都能热重载

---

### 阶段 6：集成与迁移（2.5 周）

**目标**：替换前端 xterm.js 集成，完成端到端测试。

#### 6.1 Tauri 集成（1 周）

**实现**：
- 在 `lib.rs` 的 `setup` 闭包中初始化 wgpu `Instance`（全局共享）
- 新增命令：
  - `terminal_create` —— 创建终端实例（PTY + 渲染上下文）
  - `terminal_write` —— 向 PTY 写入数据
  - `terminal_resize` —— 调整 PTY 和渲染 Surface 大小
  - `terminal_close` —— 关闭终端实例，清理资源
  - `terminal_reload_config` —— 热重载配置
- 新增事件：
  - `terminal:data` —— PTY 读取到数据，传给前端处理（或直接在后端处理）
  - `terminal:render` —— 渲染完成通知

**验收标准**：
- 通过 Tauri 命令能创建、写入、关闭终端实例
- 多窗口场景下 wgpu `Instance` 共享，无重复初始化

#### 6.2 前端迁移（1 周）

**实现**：
- 修改 `components/Terminal.tsx`：
  - 删除 xterm.js 初始化代码
  - 改为创建一个 `<canvas>` 元素，传递给后端 wgpu Surface
  - 监听 winit 事件，转发给后端处理
- 修改 `utils/xtermEnhancements.ts`：
  - 删除 FlowControl、PinnedScroll、WebGL 加载逻辑
  - 这些功能在后端用 Rust 重写
- 修改 `store/index.ts`：
  - 删除 xterm 相关的设置项（fontSize、fontFamily 等保留，但传给 Rust 后端）
  - scrollback 设置项保留，传给 Rust 后端

**验收标准**：
- 前端无 xterm.js 依赖
- 终端渲染由 Rust + wgpu 完成，前端只负责 UI 外壳

#### 6.3 端到端测试（0.5 周）

**测试矩阵**：

| TUI 程序 | 测试场景 | 预期结果 |
|---|---|---|
| Claude Code | 启动、对话、快捷键 | 正常对话，Ctrl+C/Ctrl+I/Esc 正确响应 |
| opencode | 启动、对话、快捷键 | 正常对话，Ctrl+[/Esc 正确响应 |
| vim | 启动、编辑、退出 | 备屏切换正确，退出后恢复主屏 |
| tmux | 启动、分屏、鼠标点击 | 鼠标 SGR 编码正确，分屏交互正常 |
| fzf | 鼠标点击选择 | 正确选中项 |
| lazygit | 启动、鼠标拖拽滚动 | 无闪烁（BSU/ESU 生效），滚动流畅 |
| htop | 启动、持续刷新 | 无闪烁，CPU 占用合理 |
| tig | 启动、键盘导航 | 键盘事件正确 |
| kitten icat | 显示图像 | Kitty 图形协议生效 |
| img2sixel | 显示图像 | Sixel 协议生效 |

**验收标准**：
- 上述 10 个 TUI 程序全部通过测试
- 无渲染闪烁、无键盘事件丢失、无鼠标事件错位

---

## 五、风险与缓解

### 5.1 高风险项

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| **Glyph Atlas 动态扩容** | 渲染崩溃或性能下降 | 借鉴 wezterm `atlas.rs:58-122` 的 `OutOfTextureSpace` 错误传播机制，满时创建新 atlas 而非扩容旧 atlas |
| **wgpu 多窗口在 macOS** | CAMetalLayer pool 管理问题 | 若暂不支持 macOS，可降低优先级；若支持，参考 wezterm `window/src/os/macos/` 的 layer hosting |
| **Kitty keyboard ESC 特殊处理** | Ink/Bubble Tea 快捷键失效 | 严格借鉴 wezterm `lib.rs:1726-1731` 的实现，开启 DISAMBIGUATE 时 ESC 必须走 `CSI 27;1 u` |
| **BSU/ESU 渲染延迟** | TUI 程序闪烁或卡帧 | ESU 后立即 flush；BSU 后 200ms 超时强制 flush；渲染管线设计阶段就纳入 |
| **swash + fontdue 双光栅化冲突** | 编译失败或运行时 panic | **删除 fontdue，仅用 swash 完成光栅化** |
| **自研 VT 状态机复杂度被低估** | 开发周期延长 | **直接 fork wezterm `vtparse/`，省去 1000+ 行状态机自研** |

### 5.2 中等风险项

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| `cosmic-text` 版本耦合 | 与 swash/fontdb 版本冲突 | 让 cosmic-text 拉它的依赖版本，我们只指定 cosmic-text 版本 |
| `glyphon` API 不稳定 | breaking change 导致升级困难 | **不使用 glyphon，改用自研 atlas**（借鉴 wezterm） |
| Kitty 图形协议分片重组 | 大图像显示失败 | 借鉴 wezterm `kitty.rs` 的分片缓冲区管理 |
| wgpu Surface 在窗口缩放时的同步 | 缩放时渲染卡顿 | 借鉴 wezterm `webgpu.rs` 的 `SurfaceConfiguration` 重新配置逻辑 |

### 5.3 低风险项

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| 配置热重载竞争条件 | 配置文件写入时被读取 | notify 事件去抖（debounce 100ms） |
| PTY 读取背压 | 快速输出压垮渲染 | 借鉴 wezterm 的 PTY 读取循环 + 限流机制 |
| 多窗口资源泄漏 | 长时间运行内存增长 | 窗口关闭时显式清理 wgpu 资源、GlyphCache、PTY |

---

## 六、验收标准汇总

### 6.1 功能验收

- [ ] 10 个 TUI 程序端到端测试全部通过（见 4.3）
- [ ] Kitty keyboard protocol 5 个 flags 全部支持
- [ ] 鼠标 4 种编码（X10/UTF8/SGR/URXVT）全部支持
- [ ] BSU/ESU 同步更新生效，`lazygit`/`htop` 无闪烁
- [ ] Kitty 图形协议 + Sixel 协议支持
- [ ] 字体回退链支持中文、日文、emoji
- [ ] 配置热重载生效（字体、主题、间距、大小）

### 6.2 性能验收

- [ ] 渲染 60 FPS（在 1080p 屏幕上）
- [ ] Glyph Atlas 缓存命中率 > 95%（正常运行时）
- [ ] 内存占用 < 200 MB（单窗口，空载）
- [ ] 启动时间 < 500ms（从点击到终端可输入）

### 6.3 兼容性验收

- [ ] Windows 10/11 通过
- [ ] Linux（X11 + Wayland）通过
- [ ] macOS（Intel + Apple Silicon）通过（若支持）

---

## 七、时间估算

| 阶段 | 内容 | 工时 |
|---|---|---|
| 0 | 准备与脚手架 | 1 周 |
| 1 | 终端核心层 | 4 周 |
| 2 | 渲染层 | 5 周 |
| 3 | 键盘与鼠标输入 | 2 周 |
| 4 | 图形协议 | 2 周 |
| 5 | 字体与配置 | 1.5 周 |
| 6 | 集成与迁移 | 2.5 周 |
| **合计** | | **18 周（约 4.5 个月）** |

> 估算基于单人全职开发。若 2 人并行（1 人负责终端核心层 + 渲染层，1 人负责键盘/鼠标 + 图形协议 + 字体），可压缩至 12 周。
> 若直接复用 wezterm `vtparse/` 和 `encode_kitty`，可节省约 2 周。

---

## 八、参考源码索引

所有路径相对于 `/home/ubuntu/github_projects/wezterm`。

### 8.1 高风险模块（必须参考）

| 模块 | 文件 | 行数 | 用途 |
|---|---|---|---|
| VT 状态机 | `vtparse/src/lib.rs` | 1165 | 直接 fork，无需改动 |
| VT 状态转移表 | `vtparse/src/transitions.rs` | 372 | 表驱动，核心性能路径 |
| CSI 语义解析 | `wezterm-escape-parser/src/csi.rs` | 3395 | CSI 参数解析架构 |
| OSC 语义解析 | `wezterm-escape-parser/src/osc.rs` | 2000 | OSC 命令解析 |
| APC / Kitty 图形入口 | `wezterm-escape-parser/src/apc.rs` | 1269 | Kitty 图形数据帧提取 |
| 终端状态机 | `term/src/terminalstate/mod.rs` | 2766 | `TerminalState` 主结构 + `TermMode` bitflags |
| 终端状态机 performer | `term/src/terminalstate/performer.rs` | 1109 | `impl VTActor for Performer` |
| Kitty 图形协议 | `term/src/terminalstate/kitty.rs` | 979 | Kitty 图形状态机 |
| Sixel 协议 | `term/src/terminalstate/sixel.rs` | 156 | 最简单的图形协议，建议先读 |
| 鼠标 SGR 编码 | `term/src/terminalstate/mouse.rs` | 364 | 四种鼠标编码实现 |
| Kitty keyboard 编码 | `wezterm-input-types/src/lib.rs` | 3275 | `encode_kitty(flags)` 在 1711 行 |
| Kitty keyboard flags | `wezterm-input-types/src/lib.rs` | — | `KittyKeyboardFlags` bitflags 在 2034 行 |
| Glyph Atlas 三层结构 | `window/src/bitmaps/atlas.rs` + `mod.rs` | 172 + 468 | `Atlas` + `AtlasList` |
| Glyph 业务层 | `wezterm-gui/src/glyphcache.rs` | 1376 | `GlyphCache` 字形 → sprite |
| wgpu 基础设施 | `wezterm-gui/src/termwindow/webgpu.rs` | 561 | wgpu Instance/Adapter/Device |
| 渲染状态抽象 | `wezterm-gui/src/renderstate.rs` | 779 | `RenderContext` 枚举模式 |
| 主着色器 | `wezterm-gui/src/shader.wgsl` | — | WGSL 主着色器 |
| 渲染循环 | `wezterm-gui/src/termwindow/render/paint.rs` | 282 | 主绘制循环 |

### 8.2 中等风险模块（建议参考）

| 模块 | 文件 | 用途 |
|---|---|---|
| 字体配置 | `wezterm-font/src/lib.rs` | `FontConfiguration` 主字体 + 回退链设计 |
| 字号 → 像素换算 | `wezterm-font/src/units.rs` | DPI 感知的字号换算 |
| FreeType 封装 | `wezterm-font/src/ftwrap.rs` | 若不用 swash 时的替代方案 |
| HarfBuzz 封装 | `wezterm-font/src/hbwrap.rs` | 若不用 swash 时的替代方案 |
| 彩色字形（COLR） | `wezterm-font/src/rasterizer/colr.rs` | emoji 彩色字形支持 |
| iTerm2 图像协议 | `term/src/terminalstate/iterm.rs` | OSC 1337 图像传输 |

### 8.3 低风险模块（按需参考）

| 模块 | 文件 | 用途 |
|---|---|---|
| 终端能力查询 | `wezterm-escape-parser/src/csi.rs:926+` | `FocusTracking = 1004` 等 DEC private mode 枚举 |
| Bracketed Paste | `term/src/terminalstate/mod.rs:823-841` | `send_paste` 实现 |
| Focus Event | `term/src/terminalstate/mod.rs:313,787,1806` | `focus_tracking` 字段 + set/reset/query |
| 备用屏幕 | `term/src/terminalstate/mod.rs:1673-1677` | `OptEnableAlternateScreen` / `EnableAlternateScreen` 切换 |
| `modifyOtherKeys` | `term/src/terminalstate/mod.rs:291,1954` | `modify_other_keys: Option<i64>` 字段 + set/reset 逻辑 |
| BSU/ESU 状态记录 | `term/src/terminalstate/mod.rs:1573-1589` | wezterm 把 2026 委托给 mux，本架构需在渲染层实现 |

---

## 九、迁移策略

### 9.1 不破坏现有功能的渐进迁移

**原则**：重构期间 `npm run dev` 始终可用，用户无感知。

**步骤**：
1. **阶段 0-1**：新建 `terminal-core/` crate，与现有 xterm.js 并行开发。现有功能不受影响。
2. **阶段 2-5**：在 `terminal-core/` 中完成所有新功能。通过单元测试验证，不接入 UI。
3. **阶段 6.1**：在 Tauri 后端添加新命令（`terminal_create` 等），与现有命令并行。前端仍使用 xterm.js。
4. **阶段 6.2**：切换前端 `Terminal.tsx`，从 xterm.js 切换到 Rust + wgpu 渲染。此步骤有一次性切换点，需充分测试。
5. **阶段 6.3**：端到端测试通过后，删除 xterm.js 相关代码和依赖。

### 9.2 回滚方案

若阶段 6.2 切换后发现严重问题，可快速回滚：
- 保留 `components/Terminal.tsx` 的 xterm.js 版本为 `Terminal.legacy.tsx`
- 通过环境变量 `TERMINAL_ENGINE=xterm|wgpu` 切换
- 确认稳定后再删除 legacy 版本

### 9.3 数据迁移

- 现有 JSON 配置文件 → TOML 配置文件
- 迁移脚本：`scripts/migrate-config.ts`，在应用启动时检测旧配置并自动迁移
- 用户设置（fontSize、fontFamily、theme、scrollback 等）字段名保持一致，仅格式变化

---

## 十、附录：关键代码片段参考

### 10.1 VTActor trait（fork vtparse 后的实现起点）

借鉴 `vtparse/src/lib.rs:80+`：

```rust
pub trait VTActor {
    fn action(&mut self, action: Action);
    fn csi_dispatch(&mut self, params: &[i64], intermediates: &[u8], ignore: bool, byte: u8);
    fn print(&mut self, c: char);
    fn execute(&mut self, byte: u8);
    // ... 其他 action 方法
}
```

### 10.2 KittyKeyboardFlags bitflags

借鉴 `wezterm-input-types/src/lib.rs:2034-2042`：

```rust
bitflags::bitflags! {
    pub struct KittyKeyboardFlags: u16 {
        const NONE = 0;
        const DISAMBIGUATE_ESCAPE_CODES = 1;
        const REPORT_EVENT_TYPES = 2;
        const REPORT_ALTERNATE_KEYS = 4;
        const REPORT_ALL_KEYS_AS_ESCAPE_CODES = 8;
        const REPORT_ASSOCIATED_TEXT = 16;
    }
}
```

### 10.3 Atlas 动态扩容错误传播

借鉴 `window/src/bitmaps/atlas.rs:58-122`：

```rust
pub fn allocate(&mut self, im: &dyn BitmapImage) -> Result<Sprite, OutOfTextureSpace> {
    // 尝试分配
    match self.allocator.allocate(size) {
        Some(allocation) => { /* 成功，返回 sprite */ }
        None => {
            // 失败，返回下一档尺寸，上层据此创建新 atlas
            Err(OutOfTextureSpace {
                size: Some((self.side * 2).max(needed_size)),
                current_size: self.side,
            })
        }
    }
}
```

### 10.4 BSU/ESU 同步更新渲染逻辑

本架构新增，wezterm 委托给 mux 层：

```rust
pub struct SyncUpdateState {
    synced: bool,
    bsu_time: Option<Instant>,
}

impl SyncUpdateState {
    pub fn begin(&mut self) {
        self.synced = true;
        self.bsu_time = Some(Instant::now());
    }

    pub fn end(&mut self) {
        self.synced = false;
        self.bsu_time = None;
    }

    pub fn should_flush(&self) -> bool {
        // ESU 后立即 flush
        // 或 BSU 后 200ms 超时强制 flush（防止 TUI 崩溃时永久卡帧）
        !self.synced || self.bsu_time.map_or(false, |t| t.elapsed() > Duration::from_millis(200))
    }
}
```

### 10.5 Kitty keyboard ESC 特殊处理

借鉴 `wezterm-input-types/src/lib.rs:1726-1731`：

```rust
// 开启 DISAMBIGUATE_ESCAPE_CODES 时，ESC 不能作为原始 \x1b 发送，
// 必须走 CSI 27;1 u 路径（这是 Ink/Bubble Tea 快捷键体验的关键细节）
// https://sw.kovidgoyal.net/kitty/keyboard-protocol/#disambiguate
Char('\x1b') if flags.contains(KittyKeyboardFlags::DISAMBIGUATE_ESCAPE_CODES) => {
    // 落入下方的 CSI-u 编码路径
}
```

---

**文档版本**：1.0
**创建日期**：2026-07-22
**参考源码**：wezterm（本地路径 `/home/ubuntu/github_projects/wezterm`）
