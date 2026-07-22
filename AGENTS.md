# Wilson Term

Wilson Term 是一个支持 SSH / Telnet / 串口 / 本地终端连接的模拟终端，Wilson 的个人项目。

> 本文件面向 AI 编码助手（项目导航 + 关键约定）。面向人类读者的介绍见 [README.md](README.md)。

## 仓库地址

- GitHub: https://github.com/wilson-nsdiy/wilson-term
- Gitee: https://gitee.com/zhouws-chn/wilson-term

## 架构概览

桌面框架已从 **Electron** 迁移到 **Tauri 2**（提交 `c096007 删除electron并增加tauri`）。后端由 Node.js 改为**纯 Rust**，前端保留 React + TypeScript。

```
渲染进程 (React + xterm.js)  <-->  Tauri IPC (invoke / listen)  <-->  Rust 后端 (src-tauri/)
       |                              |                                    |
   Zustand Store              api.ts 类型安全封装                      commands.rs 命令注册中心
   xterm 终端渲染            53 个 invoke + 6 个 listen 事件          connection/ ssh telnet serial bash
                                                                     logger / sftp / plugin_host / storage / updater / keyboard
```

- **invoke**（请求-响应）：连接、断开、SFTP、存储、插件、日志、窗口控制等，共 53 个命令
- **listen**（后端 → 前端推送）：`connection:data`、`connection:status`、`ssh:hostKeyVerify`、`ssh:passwordRequest`、`keyboard:lock-state-changed`、`update:status-changed`

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | Tauri 2 |
| 后端语言 | Rust（edition 2021，MSRV 1.77） |
| 前端 | React 18 + TypeScript 5 |
| 终端引擎 | @xterm/xterm v6.1（beta 通道）+ addon-fit / addon-search / addon-web-links / addon-webgl / addon-unicode11 |
| SSH | russh 0.50 + russh-keys 0.50 + russh-sftp 2.x |
| Telnet | 原生 Tokio TCP + IAC 协商（`connection/telnet.rs`） |
| 串口 | serialport 4 |
| 本地终端 | portable-pty 0.8（Windows: CMD/PowerShell/WSL） |
| 异步运行时 | Tokio 1（full feature） |
| 同步锁 | parking_lot 0.12（RwLock/Mutex） |
| 构建/打包 | Vite 6（前端）+ tauri-build + tauri-cli（NSIS/MSI） |
| 状态管理 | Zustand 5 |
| 样式 | Tailwind CSS 3 |
| Tauri 插件 | shell / dialog / fs / os / process / updater / store / clipboard-manager |
| **重构新增**（已声明在 workspace 根 `Cargo.toml`,尚未在 src-tauri 引入） | swash 0.1 / fontdb 0.20 / cosmic-text 0.12 / wgpu 24 / winit 0.30 / notify 7 / toml 0.8 / guillotiere 0.6 |

## 项目结构

```
wilson-term/
├── src-tauri/                    # Rust 后端
│   ├── Cargo.toml                # 依赖与 release profile（lto/strip/panic=abort）
│   ├── tauri.conf.json           # Tauri 配置（无边框窗口、NSIS/MSI 打包、updater endpoint）
│   ├── rust-toolchain.toml       # pin stable 工具链
│   ├── .cargo/config.toml        # build.rustc 绝对路径,绕过 rustup shim 回退坑(见已知坑)
│   ├── build.rs
│   └── src/
│       ├── main.rs               # 二进制入口,调 lib::run()
│       ├── lib.rs                # Tauri Builder:插件注册 + setup 闭包 + commands::register_all
│       ├── commands.rs           # 命令注册中心:53 个 #[tauri::command] + register_all
│       ├── types.rs              # 共享类型(SshConfig/SerialConfig/LogConfig/SftpFileEntry 等)
│       ├── connection/
│       │   ├── mod.rs
│       │   ├── manager.rs         # 连接管理器:工厂 + 注册表 + 数据派发(ssh/telnet/serial/bash 四个 map)
│       │   ├── ssh.rs             # SSH:russh Handler/认证/PTY/known_hosts/SFTP channel
│       │   ├── telnet.rs          # Telnet:Tokio TCP + IAC 协商
│       │   ├── serial.rs         # 串口:serialport 读写循环
│       │   ├── bash.rs            # 本地终端:portable-pty spawn + 读取循环
│       │   ├── c1_convert.rs      # C1 控制字符转换
│       │   └── protocol_parser.rs
│       ├── sftp.rs                # SFTP:复用 SSH channel 的 SftpSession,流式上传
│       ├── logger.rs              # 日志:SessionLogger + LogManager,ANSI 剥离/按行缓冲/分割
│       ├── plugin_host.rs         # 插件宿主:ZIP 导入导出/注册表/渲染代码/IPC 命名空间
│       ├── storage.rs             # 本地存储:会话模板/按钮分组/定时任务/Profile 持久化到 JSON
│       ├── updater.rs             # 更新:check_update + download_and_install(7 命令待补,见已知坑)
│       └── keyboard.rs            # 键盘锁检测:Win32 GetKeyState,250ms 轮询 emit
├── terminal-core/                # 终端核心库（重构新增,workspace 成员）
│   ├── Cargo.toml                # 依赖声明:swash/fontdb/cosmic-text/vtparse/notify/toml...
│   └── src/
│       ├── lib.rs                # crate 入口,导出 parser + escape 模块
│       ├── parser/               # VT 序列解析层（fork wezterm vtparse/）
│       │   ├── vtparse/          # 低层状态机:enums + transitions 表驱动 + mod（1165 行）
│       │   └── actor.rs          # VTActor trait + CollectingVTActor + VTAction 枚举
│       └── escape/               # 序列语义层（阶段 1.2 已完成）
│           ├── csi.rs            # CSI:SGR/光标/ED/EL/DEC private modes/Kitty keyboard/modifyOtherKeys/DA/DSR
│           ├── osc.rs            # OSC:0/1/2/l/L 标题 + 4/10-19/104 颜色 + 8 超链接 + 52 剪贴板 + 7 cwd + 1337 iTerm2 + 133 FinalTerm + 777 Rxvt
│           ├── dcs.rs            # DCS:Sixel 入口 + DECRQSS + XTGETTCAP
│           └── apc.rs            # APC:Kitty 图形协议帧（t=d/f/t/s 传输 + do/dq/dc/dd 控制 + Placement）
├── src/
│   └── renderer/
│       ├── index.html
│       └── src/
│           ├── main.tsx
│           ├── App.tsx            # 根布局:TitleBar + Sidebar + TabBar + Terminal + SettingsDialog
│           ├── api.ts            # Tauri invoke/listen 封装(对应原 preload contextBridge)
│           ├── components/        # 29 个 UI 组件
│           ├── store/             # Zustand 状态
│           ├── hooks/
│           ├── utils/
│           └── styles/
├── scripts/
│   ├── patch-xterm.js            # postinstall 给 xterm 5.5.0 打补丁(见已知坑)
│   ├── generate-icons.js
│   ├── package-beta.js
│   └── set-prerelease-version.js
├── docs/                         # 插件开发文档与示例
├── resources/                     # 应用图标
├── vite.config.ts
├── tailwind.config.js            # ESM (export default)
├── postcss.config.js             # ESM (export default)
├── eslint.config.js              # ESLint flat config
└── package.json                  # type: module
```

## 关键约定（改 Rust 后端必读）

### 1. 锁:用 parking_lot,不要在 async 里 blocking

`connection/manager.rs` 的 `MANAGER_STATE` 和 `logger.rs` 的 `LOG_MANAGER` 用 `parking_lot::RwLock`（**同步锁**），不是 `tokio::sync::RwLock`。

- ✅ 在 async 命令里直接 `.read()` / `.write()`（短持克隆 Arc，微秒级，不触发 tokio 阻塞检测）
- ❌ 不要用 `tokio::sync::RwLock` 的 `blocking_read()` / `blocking_write()`——在 async 上下文会 panic `Cannot block the current thread from within a runtime`
- ❌ 不要在外层再包 `parking_lot::Mutex<ManagerState>`——内层字段已是 RwLock，外层 Mutex 多余

历史教训：迁移初版用 `parking_lot::Mutex<ManagerState>` 包 `tokio::sync::RwLock`，在 async 命令里 `blocking_read()`，导致连接/日志一交互就 panic。已修复为 `static MANAGER_STATE: Lazy<ManagerState>` + `parking_lot::RwLock`。

### 2. setup 闭包里 spawn 用 tauri::async_runtime

`lib.rs` 的 `setup` 闭包是**同步**的，此时主线程未进入 Tokio runtime 上下文。

- ✅ `tauri::async_runtime::spawn(async move { ... })`
- ❌ `tokio::spawn(...)`——会 panic `there is no reactor running`

`keyboard.rs` 的键盘锁轮询 task 必须用 `tauri::async_runtime::spawn`。

### 3. 全局 AppHandle 注入

`commands.rs` / `updater.rs` / `plugin_host.rs` 各自持 `static GLOBAL_APP: StdMutex<Option<AppHandle>>`。`lib.rs` setup 闭包必须显式调三个模块的 `set_global_app(handle.clone())`，否则 `dispatch_host_key_verify` / `dispatch_password_request` / `update:status-changed` 派发、插件 IPC 命名空间派发都会失效。

### 4. 命令注册

新增 `#[tauri::command]` 后，必须在 `commands.rs` 的 `register_all()` 的 `generate_handler!` 列表里登记，否则前端 invoke 报「command not found」。当前共 53 个命令。

### 5. ESM 配置文件

`package.json` 是 `"type": "module"`，故 `tailwind.config.js` / `postcss.config.js` 必须用 `export default {}`，不能用 `module.exports`。

### 6. xterm 补丁机制

`scripts/patch-xterm.js` 在 `npm install`（postinstall）时给 `@xterm/xterm` 5.5.0 打补丁，修复 Viewport 裸 `setTimeout` 导致 dispose 后访问 dimensions 抛 Uncaught 的缺陷。改 xterm 相关代码前先看这个脚本。详见 [[xterm-patch-mechanism]]。

## 已知坑 / 待办

- **rustup shim 工具链回退**：`cargo` 子进程环境下 rustup shim 可能回退到旧工具链（1.56），致 `ff`/`dashmap` 报 `Unrecognized option: 'check-cfg'`。持久修复：`src-tauri/.cargo/config.toml` 设 `[build] rustc = "<stable 绝对路径>"`。详见 [[rust-toolchain-fallback-bug]]。
- **7 个更新器命令未补**：前端 `window.api.updater.*`（`app_check_update`/`download_update`/`cancel_download_update`/`install_update`/`get_update_status`/`get_ignored_versions`/`save_ignored_versions`）后端只实现了 `check_update` + `download_and_install`，缺 cancel/install 分离、ignored versions 持久化、7 天间隔、changelog 提取。需对照原 `src/main/updater.ts`（`c096007^` 可看）重写状态机。详见 [[tauri-migration-handover]]。
- **shell.open 已废弃**：`commands.rs` 的 `shell_open_external` 用 `tauri_plugin_shell::open`（已 deprecated），前端 `api.ts` 也用 `@tauri-apps/plugin-shell` 的 `open` 打开日志文件/目录。两处都加了 `#[allow(deprecated)]` / 待统一迁移到 `tauri-plugin-opener`。
- **重构进度（wgpu 终端引擎）**：依 `docs/IMPLEMENTATION-GUIDELINE.md` 分阶段把前端 xterm.js 渲染层替换为纯 Rust + wgpu 原生终端模拟器，新建 `terminal-core/` workspace 成员承载核心逻辑。`terminal-core/Cargo.toml` 已声明 swash/fontdb/cosmic-text/wgpu/winit/notify/toml/guillotiere（尚未在 src-tauri 引入）。当前进度：
  - ✅ **阶段 0 脚手架**：crate 创建 + fork wezterm `vtparse/`（enums/transitions/mod 1165 行）+ `parser/actor.rs` VTActor 桥接
  - ✅ **阶段 1.1 VT 状态机**：`CollectingVTActor` + `VTAction` 枚举，端到端验证输入字节流 → Vec<Action>
  - ✅ **阶段 1.2 序列语义层**：`escape/csi.rs`（SGR/光标/ED/EL/DEC private modes/Kitty keyboard/modifyOtherKeys/DA/DSR）+ `escape/osc.rs`（0/1/2/l/L 标题 + 4/10-19/104 颜色 + 8 超链接 + 52 剪贴板 + 7 cwd + 1337 iTerm2 + 133 FinalTerm + 777 Rxvt）+ `escape/dcs.rs`（Sixel 入口 + DECRQSS + XTGETTCAP）+ `escape/apc.rs`（Kitty 图形协议帧）。全部 fork 自 wezterm `wezterm-escape-parser/` 架构。**82 个单测通过**（vtparse 原有 31 + actor 3 + csi 19 + osc 16 + dcs 6 + apc 11）。期间顺手修复 `csi.rs` 两个既有 bug：`param_i64`/`param_u32` 无法跳过 vtparse 内联的 `;` 分隔符；Kitty keyboard push/pop 分支按真实参数个数区分（命令 ID 始终为 1）。
  - ⏳ **阶段 1.3 终端状态机**（待办）：`state/`（TerminalState + TermMode bitflags）+ `screen/`（主屏/备屏 + 回滚 ring buffer）+ `performer.rs`（impl VTActor，把 Action 应用到 TerminalState）

## 开发

```bash
npm install          # 含 postinstall: patch-xterm.js
npm run dev          # tauri dev(前端 vite + 后端 cargo run)
npm run build        # tauri build(生产打包)
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
```

环境要求：Node.js >= 22、Rust stable（rustup）、Windows 需 Visual Studio Build Tools（C++ 桌面开发）。
