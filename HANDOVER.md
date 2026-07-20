# Wilson Term 迁移交接文档

> **生成时间**:2026-07-20
> **当前分支**:`dev`(HEAD `a00aac9 Merge branch 'dev'`)
> **工作状态**:全部修复任务完成,`cargo check` 0 errors / 6 warnings,`npm run typecheck` 通过
> **未提交**:`src-tauri/`、`vite.config.ts`、`src/renderer/src/api.ts`、`HANDOVER.md` 为 untracked;多个 Electron 文件已 D(eleted);package.json/tsconfig.web.json/.gitignore/src/renderer/src/main.tsx 为 modified

---

## 1. 项目目标

将 Wilson Term(Electron + Node.js 后端 + React/xterm.js 前端)迁移为 **Tauri + 纯 Rust 后端**,前端 React + xterm.js 保持不变,仅替换 IPC 适配层。

约束(用户明确选定):
- 后端为**纯 Rust 重写**(非 Node sidecar),SSH/Telnet/Serial/PTY/SFTP/插件/日志/存储/键盘锁/更新器全部 Rust 实现
- 完全替换 Electron(非双轨并行)
- 前端 React + xterm.js 原样保留,组件零改动,通过 `src/renderer/src/api.ts` 适配 `window.api` 接口

---

## 2. 仓库现状(已核实)

### 2.1 工作树改动(vs HEAD)
- **删除**:`src/main/*`(Electron 主进程全部)、`src/preload/index.ts`、`electron-builder.yml`、`electron.vite.config.ts`、`tsconfig.node.json`
- **新增**(untracked):
  - `src-tauri/` — 整个 Rust 后端(未纳入版本控制,见 §5 重要)
  - `src/renderer/src/api.ts` — Tauri invoke/listen 适配层(替代 preload window.api)
  - `vite.config.ts` — Vite + Tauri 构建集成
  - `HANDOVER.md` — 本文档
- **修改**:`package.json`(Electron deps 换 @tauri-apps)、`tsconfig.web.json`、`tsconfig.json`、`.gitignore`、`src/renderer/src/main.tsx`(挂载 api 到 window)

### 2.2 验证状态
- `cd src-tauri && cargo check` — **0 errors**,6 warnings(均为非阻断的 unused import / dead code)
- `npm run typecheck`(tsc --noEmit) — **通过**
- `npm run dev` / `npm run build` / `npm run package` — **未测**(需 GUI 环境,下一步见 §4)

---

## 3. 架构与关键文件

### 3.1 Rust 后端 `src-tauri/`
```
src-tauri/
├── Cargo.toml              # russh 0.50 / serialport 4.9 / portable-pty 0.8 / windows 0.58 / tauri 2
├── tauri.conf.json         # frameless window + updater endpoints + app metadata
├── capabilities/default.json  # Tauri 2 ACL
├── build.rs
└── src/
    ├── main.rs             # 入口
    ├── lib.rs              # Tauri Builder + plugin 注册 + setup(注入 GLOBAL_APP)
    ├── types.rs            # serde 类型,对应 src/shared/types/index.ts
    ├── commands.rs         # 所有 #[tauri::command](window/connection/storage/fonts/domain/devtools)
    ├── keyboard.rs         # Win32 GetKeyState + tokio interval 轮询派发
    ├── updater.rs          # tauri-plugin-updater 2.10
    ├── storage.rs          # JSON 持久化(原子写 + 损坏备份)
    ├── logger.rs           # SessionLogger + LogManager
    ├── sftp.rs             # russh-sftp 2.3,流式分块
    ├── plugin_host.rs      # ZIP 导入/导出 + 注册表 + Zip Slip 防御
    └:每个命令独立 → 已修为懒初始化复用 Arc<SftpSession>
    └:** 现为 untracked,未在版本控制内 **
    └:重要程度因仓库而异,多数需手动 git add
```

### 3.2 前端改动
- `src/renderer/src/api.ts` — 用 `invoke`/`listen` 重实现原 `window.api` 全部方法;含 `safeListen` 工具消除事件 cleanup 异步竞态
- `src/renderer/src/main.tsx` — `(window as any).api = api` 挂载
- 组件层**零改动**,仍通过 `window.api.xxx()` 调用

### 3.3 IPC 命名空间
- invoke/handle:连接、存储、SFTP、插件、更新、字体、对话框
- on/send 推送:`connection:data` / `connection:status` / `ssh:hostKeyVerify` / `ssh:passwordRequest` / `keyboard:lock-state-changed` / `update:status-changed`

---

## 4. 下次会话首要任务(按优先级)

### 4.1 【必做】把 `src-tauri/` 纳入版本控制并提交
```bash
cd /g/work/wilson-term
git add src-tauri/ vite.config.ts src/renderer/src/api.ts HANDOVER.md
git add -u   # 把 deleted Electron 文件和 modified 的纳入
git status   # 确认
git commit   # 建议分两步:先 commit 删除 Electron,再 commit 新增 Tauri,便于 review
```
**风险**:当前 `src-tauri/` untracked,若误 `git clean -fd` 会全删,不可恢复。

### 4.2 【必做】跑 `npm run dev` 端到端冒烟测试
当前仅静态验证(cargo check / tsc)通过,**运行时未测**。需在 GUI 环境测:
1. 窗口能否启动(自定义标题栏、菜单栏)
2. 各连接类型能否建立:SSH(密钥/密码/agent)、Telnet、串口、本地终端(CMD/PowerShell/WSL)
3. 终端输出能否显示(D1/D2 修复的核心通路)
4. 多标签页、会话管理侧边栏
5. SFTP 文件管理(浏览/上传/下载 — H7 流式分块)
6. 日志记录、搜索、按钮栏、定时任务
7. 键盘锁指示灯(H4 轮询派发)
8. 自动更新检查(H5 进度条)

### 4.3 【建议】补单元测试
- `protocol_parser.rs`:缺 WILL/WONT/SB IAC IAC 透传/异常终止测试
- `c1_convert.rs`:缺 C1 多字节、Latin-1 回退、不完整 UTF-8 测试

### 4.4 【可延后】剩余代码质量问题
6 个 cargo warnings:
- `ssh.rs:272` impl trait in impl method signature does not match trait method signature(russh 0.50 Handler trait 签名差异,运行无碍)
- `commands.rs:292` deprecated `tauri_plugin_shell::Shell::open`,建议换 `tauri-plugin-opener`
- `ssh.rs:429`/`:690` variable does not need to be mutable(删 `mut` 即可)
- `bash.rs:260` unused import `portable_pty::ChildKiller`(删后牵连 trait 解析报错,**保留**)
- `logger.rs:242` method `close` is never used(死代码,可删)

其他可延后项:
- SSH 超时常量硬编码 30s(原 Electron 15s)
- `app_get_system_fonts` 返回硬编码字体列表(未读真实系统字体)
- `app_get_domain` 用 hostname 而非 DNS 域名(与原 `domain.ts` 语义不符)
- `ConnectionConfig` untagged enum 脆弱性(已加注释说明权衡,改 tagged 需动前端协议)
- `logger::write_output` 同步 IO(已加注释,彻底改需 SessionLogger 全面 async 化)

---

## 5. 关键技术决策与坑(russh 0.50 / russh-sftp 2.3 / portable-pty 0.8 / serialport 4.9 / tauri-plugin-updater 2.10)

### 5.1 russh 0.50
- `Channel` **不可 Clone**,`wait()` 需 `&mut self` 与 `data()` 的 `&self` 冲突
- 解决:单 task 持 owned channel,`tokio::select!` 同时 `rx.recv()`(用户输入→`channel.data()`)和 `channel.wait()`(服务器输出→派发);resize 通过 `mpsc` 送进同 task 调 `window_change(cols, rows, 0, 0)` — **4 参,非 6 参**
- Handler trait:`check_server_key` 用 `impl Future` 非 `async_trait`;返回 `Pin<Box<dyn Future + Send + 'static>>`,所有数据 clone 出来再 `Box::pin(async move)`
- agent 支持:`get_available_agent()` 检测了但**未真正用上**(russh 0.50 agent 集成待确认),仅默认私钥 + 密码回退

### 5.2 russh-sftp 2.3
- `SftpSession` **不 Clone**,用 `Arc<SftpSession>` 共享;`SshConnection` 持 `Arc<Mutex<Option<Arc<SftpSession>>>>` 懒初始化复用
- `File` 实现 `AsyncRead + AsyncWrite`,用 `tokio::io::copy` 流式分块(8KB 缓冲)替代 `sftp.write/read` 整载
- `DirEntry::file_name()` / `metadata()`;`Metadata = FileAttributes`,字段 `size`/`permissions`/`uid`/`gid`/`atime`/`mtime`(非 `user_id`/`access_time`)

### 5.3 portable-pty 0.8
- `PtyPair { slave, master }`;`slave.spawn_command(cmd)`;`master.take_writer()` / `try_clone_reader()`
- `Child` + `ChildKiller` trait;`clone_killer()` 需 `use portable_pty::ChildKiller`(删 import 会牵连 trait 解析报错,保留)
- disconnect 必须 `child.wait()` 回收,否则僵尸进程

### 5.4 serialport 4.9
- `UsbPortInfo` 字段:`vid`/`pid`/`serial_number`/`manufacturer`/`product`/`interface`(非 `pnp_id`/`location_id`)
- `Parity` 枚举仅 `None`/`Even`/`Odd`,无 `Mark`/`Space` — 用 `SerialParity` 枚举显式降级并标注
- 读写:用 `spawn_blocking` 线程同步 `read`,数据通过 `mpsc` 送回 async task 派发(避免单线程 runtime 饿死)

### 5.5 tauri-plugin-updater 2.10
- `Updater::check()` 返回 `Option<Update>`,无 `fetch()`
- `Update::download_and_install(progress_callback, completion_callback)`
- 进度回调参数 `chunk_len` 是**本块大小非累计**,需 `Arc<AtomicU64>` 累加

### 5.6 Tauri 2
- `devtools` 等方法在 `WebviewWindow` 非 `Window`
- `app.emit()` 需 `use tauri::Emitter`
- 三个模块各自 `static GLOBAL_APP: Lazy<StdMutex<Option<AppHandle>>>`,**setup 必须显式调各模块 `set_global_app`**,否则事件派发全断

---

## 6. 已完成修复清单(20 项)

### 致命级(2 项 — 阻断核心功能)
- **D1** `ssh.rs` — 重写 connect 读写循环:`tokio::select!` 同时用户输入和服务器输出,修复原"读取循环被注释掉、前端收不到 SSH 输出"黑屏
- **D2** `serial.rs`/`bash.rs` — spawn_blocking 内不再 `tokio::spawn` 派发(单线程 runtime 饿死),改 `mpsc` 送回 async task

### 高级(13 项 — 阻断或安全/数据完整性)
- **H1** `lib.rs` — setup 注入三模块 `set_global_app`,修复 SSH 主机密钥/密码/更新/插件事件派发全断
- **H2** `telnet.rs` — 读取循环内写回 IAC 协商 responses,修复原"responses 丢弃致协商失败"
- **H3** `ssh.rs` — 新增 `resize_sender` mpsc,resize 通过同 channel task 调 `window_change`
- **H4** `keyboard.rs` — init 启动 tokio interval 轮询,变化时 `emit("keyboard:lock-state-changed")`
- **H5** `updater.rs` — `Arc<AtomicU64>` 累加 transferred,修复进度条永远 0%
- **H6** `ssh.rs`/`sftp.rs` — `SshConnection.sftp` 懒初始化复用 `Arc<SftpSession>`,修复每次操作新开 channel
- **H7** `sftp.rs` — upload/download 改 `tokio::io::copy` 流式分块,修复 GB 级 OOM
- **H8** `plugin_host.rs` — unzip_to 加 Zip Slip 防御(剔 `..` + canonicalize starts_with)
- **H9** `api.ts` — `safeListen` 工具消除 listen 异步注册与 cleanup 同步调用竞态,6 个 On* 监听器全改用
- **H10** `vite.config.ts` — xterm 版本读取改函数,依赖未装时友好 Error 而非顶层 panic
- **H11** `vite.config.ts` — dev server host 默认 `localhost` 而非 `0.0.0.0`
- **H12** `tsconfig.web.json` — types 加 `vite/client`
- **H13** `package.json`/`types.rs`/`serial.rs` — 加 `@types/node`;`SerialParity` 枚举显式映射 mark/space

### 中级(7 项 — 鲁棒性/性能)
- **M1/M2** `serial.rs`/`bash.rs` — write 改 `spawn_blocking` 包;disconnect 加 `child.wait()` 回收僵尸
- **M3** `logger.rs` — write_output 加注释明确同步 IO 权衡
- **M4** `logger.rs` — `unsafe unwrap_unchecked` 改安全 `Arc::try_unwrap` + 失败回退
- **M5** `c1_convert.rs` — 加注释明确跨包不完整 UTF-8 权衡(Latin-1 回退不丢字节)
- **M10** `telnet.rs` — read 错误不再静默吞,改 match 派发 Disconnected+错误信息
- **M11/M12** `storage.rs`/`plugin_host.rs` — JSON 损坏备份而非清空;write 改 tempfile+rename 原子写
- **M17-M22** 多文件 — 批量清理 unused imports

---

## 7. 未完成 / 待办

### 阻断性(必做)
1. `src-tauri/` 纳入版本控制(见 §4.1)
2. `npm run dev` 冒烟测试(见 §4.2)

### 非阻断(可延后)
3. 补单元测试(protocol_parser、c1_convert)
4. 6 个 cargo warnings 清理(见 §4.4)
5. SSH 超时常量、`app_get_system_fonts`、`app_get_domain` 语义对齐
6. `ConnectionConfig` 改 tagged enum(需动前端协议,权衡后保留 untagged + 注释)
7. `logger::write_output` 彻底 async 化(需 SessionLogger 重构)
8. russh agent 真实集成(当前仅检测未用)
9. `tauri_plugin_shell::open` 换 `tauri-plugin-opener`

---

## 8. 重新进入会话的快速指令

```bash
cd /g/work/wilson-term
git status              # 确认 src-tauri/ 等 untracked 还在
cd src-tauri && cargo check   # 应 0 errors
cd .. && npm run typecheck    # 应通过
npm run dev             # 冒烟测试(GUI 环境)
```

关键文件先读:
- `HANDOVER.md`(本文档)
- `AGENTS.md`(项目说明)
- `src-tauri/src/lib.rs`(入口 + setup)
- `src-tauri/src/commands.rs`(命令注册)
- `src/renderer/src/api.ts`(前端适配层)

---

**最后提醒**:`src-tauri/` 是 untracked,**不要跑 `git clean -fd`**,会全删不可恢复。第一时间 `git add` 落版本控制。
