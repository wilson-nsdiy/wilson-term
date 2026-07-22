# Wilson Term

Wilson Term 是一个支持 SSH / Telnet / 串口 / 本地终端连接的模拟终端，Wilson 的个人项目。

## 仓库地址

- GitHub: https://github.com/wilson-nsdiy/wilson-term
- Gitee: https://gitee.com/zhouws-chn/wilson-term

## 功能特性

- **多协议连接** — SSH（密码/密钥/免密认证）、Telnet（IAC 协商）、串口通信、本地终端（CMD/PowerShell/WSL）
- **多标签页** — 同时管理多个终端会话，标签页显示连接类型图标和状态指示灯
- **会话管理** — 侧边栏保存连接模板，双击快速连接，支持拖拽排序
- **SFTP 文件管理** — 基于 SSH 通道的远程文件浏览、上传、下载、删除、重命名、新建目录
- **终端搜索** — 正则/纯文本搜索，大小写选项
- **按钮栏** — 自定义命令按钮分组，支持多命令批量发送
- **定时任务** — 按会话配置定时执行命令，支持启用/暂停/排序
- **配置档案** — Profile 管理器，按连接类型应用全局配置覆盖
- **日志记录** — 仅记录输出数据，ANSI 剥离、时间戳前缀、按大小/时间分割
- **插件系统** — 主进程/渲染进程双进程插件，ZIP 导入导出，权限声明，声明式 UI
- **多行粘贴确认** — 检测多行粘贴内容，弹窗确认或自动发送
- **键盘锁指示** — 实时显示 CapsLock/NumLock/ScrollLock 状态
- **自动更新** — 检查版本更新，支持忽略版本
- **Catppuccin Mocha** — 暗色主题，无边框窗口，自定义标题栏和菜单栏

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | Tauri 2 |
| 后端 | Rust（edition 2021） |
| 前端 | React 18 + TypeScript 5 |
| 终端引擎 | @xterm/xterm v6.1（beta 通道）+ addon-fit / addon-search / addon-web-links / addon-webgl / addon-unicode11 |
| SSH | russh 0.50 + russh-sftp 2.x |
| Telnet | 原生 Tokio TCP + IAC 协商 |
| 串口 | serialport 4 |
| 本地终端 | portable-pty 0.8 |
| 异步运行时 | Tokio 1 |
| 构建/打包 | Vite 6 + tauri-cli（NSIS/MSI） |
| 状态管理 | Zustand 5 |
| 样式 | Tailwind CSS 3 |

> **重构进行中**：本仓库正在把前端 xterm.js 渲染层替换为纯 Rust + wgpu 原生终端模拟器，新建 `terminal-core/` crate 承载 VT 解析、序列语义、终端状态机、渲染管线。届时新增依赖 swash / fontdb / cosmic-text / wgpu / winit / notify 等。完整方针见 [`docs/IMPLEMENTATION-GUIDELINE.md`](docs/IMPLEMENTATION-GUIDELINE.md)。当前进度：**阶段 1.2 序列语义层已完成**（CSI/OSC/DCS/APC 解析器就位，82 个单测通过）。

## 环境要求

- **Node.js >= 22**
- **Rust**（通过 [rustup](https://rustup.rs/) 安装 stable 工具链）
- **C++ 编译工具链**（Rust 链接器依赖）
  - **Windows**: 安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)，勾选 "C++ 桌面开发" 工作负载
  - **macOS**: `xcode-select --install`
  - **Linux**: `sudo apt install build-essential`（Ubuntu/Debian）

## 快速开始

```bash
# 安装前端依赖（含 postinstall: 自动给 xterm 打补丁）
npm install

# 开发模式（前端 vite + 后端 cargo run）
npm run dev

# 构建生产版本并打包
npm run build

# 代码检查
npm run lint
npm run typecheck
```

## 项目结构

```
src-tauri/                # Rust 后端
├── Cargo.toml            # 依赖与 release profile
├── tauri.conf.json       # Tauri 配置（无边框窗口、NSIS/MSI 打包、updater）
└── src/
    ├── lib.rs            # Tauri Builder:插件注册 + setup + 命令注册
    ├── commands.rs       # 命令注册中心（53 个 #[tauri::command]）
    ├── types.rs          # 共享类型定义
    ├── connection/       # 连接管理（ssh / telnet / serial / bash + manager）
    ├── sftp.rs           # SFTP 文件管理（复用 SSH channel）
    ├── logger.rs         # 会话日志（ANSI 剥离、按行缓冲、分割）
    ├── plugin_host.rs    # 插件宿主（ZIP 导入导出、注册表、IPC 命名空间）
    ├── storage.rs        # 本地持久化（会话模板/按钮/定时任务/Profile → JSON）
    ├── updater.rs        # 自动更新
    └── keyboard.rs       # 键盘锁状态检测（Win32 GetKeyState 轮询）

terminal-core/            # 终端核心库（重构新增,workspace 成员）
└── src/
    ├── lib.rs            # crate 入口
    ├── parser/           # VT 序列解析层（fork wezterm vtparse）
    │   ├── vtparse/      # 低层状态机,产生 Action
    │   └── actor.rs      # VTActor trait 桥接,把 VTAction 转为高层 Action
    └── escape/           # 序列语义层（fork wezterm wezterm-escape-parser 架构）
    ├── csi.rs        # CSI 解析（SGR/光标/DEC private modes/Kitty keyboard/modifyOtherKeys）
    ├── osc.rs        # OSC 解析（标题/颜色/超链接/剪贴板/iTerm2/FinalTerm/Rxvt）
    ├── dcs.rs        # DCS 入口（Sixel/DECRQSS/XTGETTCAP）
    └── apc.rs        # APC 入口（Kitty 图形协议帧:传输/控制/Placement 字段）

src/renderer/             # 前端（React）
└── src/
    ├── App.tsx           # 根布局
    ├── api.ts            # Tauri invoke/listen 封装
    ├── components/        # UI 组件
    ├── store/            # Zustand 状态管理
    ├── hooks/
    ├── utils/
    └── styles/

scripts/                  # 构建辅助（patch-xterm / generate-icons / package-beta）
docs/                     # 插件开发文档与示例
resources/                # 应用图标
```

## 架构设计

### 进程间通信

```
渲染进程 (React + xterm.js)  <-->  Tauri IPC  <-->  Rust 后端
       |                              |                |
   Zustand Store              invoke / listen     commands.rs 注册中心
```

- **invoke**（请求-响应）：连接、断开、SFTP、存储、插件、日志、窗口控制等
- **listen**（后端 → 前端推送）：数据接收（`connection:data`）、状态变更（`connection:status`）、主机密钥验证（`ssh:hostKeyVerify`）、密码请求（`ssh:passwordRequest`）、键盘锁状态（`keyboard:lock-state-changed`）、更新状态（`update:status-changed`）

### 状态管理

Zustand 管理所有 UI 状态和会话状态。持久化数据通过 IPC 存储到后端的 JSON 文件。

### 插件系统

- 插件以 ZIP 包导入，解压到 `{userData}/plugins/{id}/`
- 主进程插件（Rust 侧）注册 IPC handler，IPC 通道自动命名空间化（`plugin:{id}:*`）
- 渲染进程插件通过沙箱加载，可监听终端数据流、声明状态栏项
- 权限声明控制上下文 API 注入
- 插件开发示例位于 `docs/plugin-demo/`

### 日志系统

- 仅记录输出方向数据（不记录用户输入）
- 剥离 ANSI 转义序列后按行缓冲写入
- 支持时间戳前缀、按大小（默认 10MB）和按时间（每天）分割
- 默认存储路径：`{文档目录}/wilson-term/logs/`

### SSH 认证流程

1. **密码认证**：有密码时直接使用；密码为空时自动切换免密认证
2. **免密认证**：同时尝试 ssh-agent 和默认密钥文件
3. **密钥认证**：支持指定密钥文件路径和 passphrase
4. **主机密钥验证**：应用专属 known_hosts 管理，首次连接弹窗确认，密钥变更红色警告

## 插件开发

Wilson Term 支持通过插件扩展终端功能。插件以 ZIP 包形式导入，代码运行在主进程和渲染进程两个环境中。

详细开发指南请参阅 [docs/PLUGIN_DEV_GUIDE.md](docs/PLUGIN_DEV_GUIDE.md)。

## 注意事项

- 串口功能需要硬件权限（Linux 需加入 `dialout` 组）
- SSH/Telnet 连接时请确保目标主机可访问且防火墙允许连接
- 自动更新功能需网络路径可达

## 许可证

私有项目
