# Wilson Term

Wilson Term 是一个支持 SSH / Telnet / 串口 / 本地终端连接的模拟终端，Wilson 的个人项目。

## 仓库地址

- GitHub: https://github.com/wilson-nsdiy/wilson-term
- Gitee: https://gitee.com/zhouws-chn/wilson-term

## 核心功能

- **SSH 连接**：支持密码认证、密钥认证、免密认证（ssh-agent + 默认密钥文件），主机密钥验证（known_hosts 管理），SSH 密钥对生成
- **Telnet 连接**：基于 Node.js net 模块实现，处理 IAC 协商（DO/DONT/WILL/WONT），支持标准 Telnet 选项（echo、suppress go-ahead 等）
- **串口通信**：支持配置波特率、数据位、停止位、校验位、流控（硬件/软件）等参数，自动列出可用串口，同一串口互斥访问
- **本地终端**：基于 node-pty 实现本地 Shell（Windows 支持 CMD / PowerShell / WSL），支持启动目录配置
- **多标签页管理**：支持同时打开多个终端会话，标签页显示连接类型图标和状态指示灯
- **会话管理**：侧边栏保存连接模板，支持双击连接、右键菜单（连接/编辑/删除），自动去重保存
- **日志记录**：仅记录输出数据，支持 ANSI 剥离、时间戳前缀、按大小/时间分割日志文件
- **插件系统**：支持主进程/渲染进程双进程插件，ZIP 导入导出，权限声明，声明式 UI（状态栏项）
- **SFTP 文件管理**：基于 SSH 通道的远程文件浏览、上传、下载、删除、重命名、新建目录
- **搜索功能**：终端内容搜索，支持正则和大小写选项
- **按钮栏**：自定义命令按钮分组，支持多命令发送
- **定时任务**：按会话配置定时执行命令，支持启用/暂停/排序
- **配置档案**：Profile 管理器，按连接类型应用全局配置覆盖
- **多行粘贴确认**：检测多行粘贴内容，弹窗确认或自动发送
- **键盘锁状态**：实时检测并显示 CapsLock/NumLock/ScrollLock 状态（Windows 通过 PowerShell/.NET 实现）
- **自动更新**：检查版本更新，支持本版本忽略提示，启动时自动检查
- **自定义窗口**：无边框窗口，自定义标题栏和菜单栏，Catppuccin Mocha 暗色主题

## 技术栈

- 桌面框架：Electron v33
- 前端框架：React 18 + TypeScript 5
- **终端引擎**：@xterm/xterm v6.1（beta 通道）+ addon-fit / addon-search / addon-web-links / addon-webgl / addon-unicode11
- **SSH 客户端**：ssh2
- **Telnet 连接**：原生 Node.js net 模块实现 IAC 协商
- 串口通信：serialport v12
- 本地终端：node-pty
- **原生调用**：koffi（FFI 绑定，用于键盘锁检测等）
- 构建工具：electron-vite v5 + Vite 6
- 状态管理：Zustand 5
- 样式方案：Tailwind CSS 3
- 打包工具：electron-builder
- **代码检查**：ESLint 10（flat config）
- **日志**：electron-log
- **本地存储**：electron-store
- **自动更新**：electron-updater
- **插件包**：adm-zip（ZIP 导入导出）
- **字体列表**：font-list（系统字体获取）

## 项目结构

```
wilson-term/
├── src/
│   ├── main/                  # Electron 主进程
│   │   ├── index.ts           # 主进程入口：创建无边框窗口、注册 IPC、键盘锁检测
│   │   ├── ipc.ts             # IPC 通信注册中心：窗口控制、存储、日志、SFTP、插件
│   │   ├── keyboard.ts        # 键盘锁状态检测（CapsLock/NumLock/ScrollLock）
│   │   ├── sftp.ts            # SFTP 文件管理：列表/上传/下载/删除/重命名/新建目录
│   │   ├── plugin-host.ts     # 插件宿主：加载/激活/卸载/IPC 命名空间/ZIP 安全校验
│   │   ├── domain.ts          # 域名检测：获取计算机 DNS 域名
│   │   ├── updater.ts         # 更新管理：检查版本更新、读取 CHANGELOG
│   │   ├── logger.ts          # 日志管理：SessionLogger + LogManager，ANSI 剥离、按行缓冲、分割
│   │   ├── app-logger.ts      # 应用级日志：非会话日志输出
│   │   ├── storage.ts         # 本地存储：会话模板/按钮分组/定时任务/Profile 等持久化到 JSON 文件
│   │   └── connection/        # 连接管理（各协议统一框架）
│   │       ├── types.ts             # 连接类型定义
│   │       ├── base-connection.ts   # 基础连接抽象类
│   │       ├── manager.ts           # 连接管理器：生命周期/事件分发
│   │       ├── ipc.ts               # 连接相关 IPC 处理器
│   │       ├── ssh-connection.ts    # SSH 连接：认证/PTY/主机密钥验证/密钥生成
│   │       ├── telnet-connection.ts # Telnet 连接：基于 net 模块
│   │       ├── telnet-protocol.ts   # Telnet IAC 协议协商实现
│   │       ├── serial-connection.ts # 串口连接：打开/关闭/读写/串口列表
│   │       ├── bash-connection.ts   # 本地终端连接：node-pty 启动/关闭/读写
│   │       ├── protocol-parser.ts   # 协议解析器
│   │       └── c1-convert.ts        # C1 控制字符转换
│   ├── preload/
│   │   └── index.ts           # contextBridge 暴露 window.api（dialog/window/connection/ssh/sftp/serial/bash/storage/keyboard/log/app/plugin/shell）
│   ├── renderer/
│   │   ├── index.html
│   │   └── src/
│   │       ├── main.tsx
│   │       ├── App.tsx        # 根布局：TitleBar + Sidebar + TabBar + Terminal + SettingsDialog
│   │       ├── components/
│   │       │   ├── TitleBar.tsx           # 自定义标题栏（拖拽、窗口控制按钮）
│   │       │   ├── MenuBar.tsx            # 下拉菜单栏（文件/编辑/选项/工具/帮助）
│   │       │   ├── Sidebar.tsx            # 会话管理侧边栏（连接模板列表、右键菜单）
│   │       │   ├── TabBar.tsx             # 标签栏（类型图标、状态指示灯、关闭按钮）
│   │       │   ├── Terminal.tsx           # 终端容器（WelcomeTerminal + TerminalInstance）
│   │       │   ├── TerminalInstance.tsx    # 终端实例核心（xterm.js 管理、数据流绑定、FlowControl/PinnedScroll/RendererManager/ResizeDebouncer 集成、OSC 52 剪贴板、IME leak filter、搜索高亮、多行粘贴、性能监控、右键菜单）
│   │       │   ├── TerminalStatusBar.tsx  # 终端状态栏（连接信息、插件状态栏项、键盘锁指示器）
│   │       │   ├── TerminalContextMenu.tsx # 终端右键菜单（复制/粘贴）
│   │       │   ├── NewConnectDialog.tsx   # 新建/编辑连接对话框（SSH/Telnet/串口/本地终端表单）
│   │       │   ├── SettingsDialog.tsx     # 全局设置对话框（外观/日志/操作设置）
│   │       │   ├── InputDialog.tsx        # 通用输入对话框（替代 prompt()）
│   │       │   ├── LogConfigSection.tsx   # 日志配置组件（可复用）
│   │       │   ├── HostKeyDialog.tsx       # 主机密钥验证对话框
│   │       │   ├── PasswordDialog.tsx     # SSH 密码输入对话框
│   │       │   ├── UpdateDialog.tsx       # 更新日志与检查更新对话框
│   │       │   ├── UpdateToast.tsx        # 更新通知 Toast 组件
│   │       │   ├── ChangelogDialog.tsx    # 更新日志对话框
│   │       │   ├── AboutDialog.tsx        # 关于对话框
│   │       │   ├── ErrorDialog.tsx        # 错误提示弹窗
│   │       │   ├── PluginManager.tsx      # 插件管理对话框（列表/导入/导出/卸载/启禁用）
│   │       │   ├── SftpFileManager.tsx     # SFTP 文件管理对话框（远程文件浏览/上传/下载）
│   │       │   ├── SearchBar.tsx          # 终端搜索栏
│   │       │   ├── CommandInput.tsx       # 命令行输入栏
│   │       │   ├── ButtonBar.tsx          # 命令按钮栏
│   │       │   ├── ButtonBarManager.tsx   # 按钮栏管理对话框
│   │       │   ├── MultiLinePasteDialog.tsx # 多行粘贴确认对话框
│   │       │   ├── ScheduledTaskDialog.tsx  # 定时任务管理对话框
│   │       │   ├── ScheduledTaskEditor.tsx  # 定时任务编辑器
│   │       │   ├── GlobalOptionsDialog.tsx  # 全局选项对话框
│   │       │   └── ProfileManager.tsx      # 配置档案管理对话框
│   │       ├── store/
│   │       │   └── index.ts    # Zustand 状态：sessions/savedSessions/settings/commandButtonGroups/scheduledTasks/profiles/keyboardLockStates/skipVersions/viewState
│   │       ├── utils/
│   │       │   ├── logConfig.ts        # 日志配置工具（创建/合并连接级与全局配置）
│   │       │   ├── settingsResolver.ts # 设置解析工具（Profile 覆盖合并）
│   │       │   ├── pasteFilter.ts      # 粘贴过滤工具（多行检测/安全过滤）
│   │       │   ├── font.ts            # 字体工具（系统字体列表获取）
│   │       │   ├── imeLeakFilter.ts   # IME 首字漏出过滤器（修复微软拼音等 IME compositionstart 滞后 bug）
│   │       │   ├── searchMatch.ts     # 搜索匹配信息工具（computeSearchMatchInfo）
│   │       │   ├── xtermEnhancements.ts  # xterm 性能与体验增强（FlowControl/PinnedScroll/RendererManager/safeFit/patchRenderServiceDimensions）
│   │       │   └── resizeDebouncer.ts    # 终端 resize 防抖（对齐 VSCode TerminalResizeDebouncer，区分 X/Y + buffer 内容量分级）
│   │       └── styles/
│   │           └── globals.css
│   │   └── plugin-host.ts    # 渲染进程插件宿主：沙箱加载/生命周期/数据流分发
│   └── shared/
│       ├── constants.ts     # 共享常量
│       └── types/
│           ├── index.ts       # 共享类型：SSHConfig/TelnetConfig/SerialConfig/LogConfig/AppSettings/KeyboardLockState/UpdateCheckResult/ChangelogEntry/ExposedAPI 等
│           ├── plugin.ts      # 插件类型：PluginManifest/PluginContext/MainPlugin/RendererPlugin/PluginAPI 等
│           └── profile.ts     # Profile 类型：Profile/ProfileOverrides
├── build/                    # 打包后处理脚本
├── scripts/                   # 构建辅助脚本
├── docs/                      # 插件开发文档与示例
├── resources/                 # 应用图标
├── electron-builder.yml       # 打包配置（NSIS/DMG/AppImage，asarUnpack 原生模块）
├── electron.vite.config.ts    # 构建配置（@shared/@renderer 别名，__APP_VERSION__ 注入）
├── tailwind.config.js         # Tailwind 配置（Catppuccin Mocha 色值、等宽字体栈）
├── package.json
└── tsconfig*.json
```

## 架构设计

### 进程间通信

```
渲染进程 (React)  <-->  预加载脚本 (contextBridge)  <-->  主进程 (Electron)
     |                          |                              |
  Zustand Store          window.api 封装              IPC 处理器注册
  UI 组件渲染          类型安全的 API 桥梁           SSH/串口/日志/存储管理
```

- **invoke/handle**（请求-响应）：连接、断开、查询状态、文件对话框、存储操作、SFTP 操作、插件管理、更新检查、更新日志、版本忽略
- **on/send**（单向推送）：数据写入、窗口控制、密钥验证回应、密码回应
- **事件监听**（主→渲染推送）：数据接收（connection:data）、状态变更（connection:status）、密钥验证请求（ssh:hostKeyVerify）、密码请求（ssh:passwordRequest）、键盘锁状态变化（keyboard:lock-state-changed）

### 状态管理

Zustand 管理所有 UI 状态和会话状态。持久化数据通过 IPC 存储到主进程的 JSON 文件（`%LOCALAPPDATA%/wilson-term/`）。

### 插件系统

- 插件以 ZIP 包导入，解压到 `{userData}/plugins/{id}/`
- 主进程插件通过 `require()` 加载，可注册 IPC handler、发起网络请求、访问存储
- 渲染进程插件通过 `new Function()` 沙箱加载，可监听终端数据流、声明状态栏项
- 权限声明控制上下文 API 注入，IPC 通道自动命名空间化（`plugin:{id}:*`）
- 插件开发示例位于 `docs/plugin-demo/`，包含主进程 IPC、渲染进程状态栏、终端输入监听等完整功能

### 日志系统

- 仅记录输出方向数据（不记录用户输入）
- 剥离 ANSI 转义序列后按行缓冲写入
- 支持时间戳前缀、按大小（默认 10MB）和按时间（每天）分割
- 日志文件命名：`ssh_{host}_{port}_{timestamp}.log` / `telnet_{host}_{port}_{timestamp}.log` / `serial_{port}_{baudRate}_{timestamp}.log`
- 默认存储路径：`{文档目录}/wilson-term/logs/`

### SSH 认证流程

1. **密码认证**：有密码时直接使用；密码为空时自动切换免密认证
2. **免密认证**：同时尝试 ssh-agent（Windows: Pageant/OpenSSH Agent）和默认密钥文件（优先应用目录 `%LOCALAPPDATA%/wilson-term/.ssh`，回退 `~/.ssh`）
3. **密钥认证**：支持指定密钥文件路径和 passphrase（UI 暂标记"暂不支持"）
4. **主机密钥验证**：应用专属 known_hosts 管理，首次连接弹窗确认，密钥变更红色警告

## 开发环境要求

- Node.js >= 22
- npm >= 9
- Git
- Python 3.x（用于编译原生模块）
- C++ 编译工具链（Windows: Visual Studio Build Tools, macOS: Xcode Command Line Tools）

## 开发约定

- **对齐成熟实现**：当涉及终端渲染、resize 防抖、滚动跟随、渲染器上下文恢复等已被成熟软件解决的问题时，优先参考 VSCode（`/home/ubuntu/github_projects/vscode/src/vs/workbench/contrib/terminal/`）的实现方式——它经过长期生产验证，机制设计（事件触发时机、X/Y 拆维处理、idle callback 兜底等）有很大参考价值。对齐其机制而非自创方案，避免重复踩坑；仅在本地场景差异（如远程 SSH 的 IPC 无背压、中文 IME leak）确实需要时才做最小封装补充。

## 快速开始

```bash
npm install
npm run dev        # 开发模式
npm run build      # 构建生产版本
npm run package    # 打包应用
npm run typecheck  # TypeScript 类型检查
npm run lint       # ESLint 代码检查
```

## 注意事项

- 串口功能需要相应的硬件权限（Linux 下可能需要将用户加入 dialout 组）
- SSH/Telnet 连接时请确保目标主机可访问且防火墙允许连接
- 首次运行可能需要安装系统依赖（如 Windows 下的 Visual C++ Redistributable）
- 插件运行需相应权限和网络环境
- 自动更新功能需网络路径可达
- 原生模块（serialport、ssh2）通过 asarUnpack 排除在 asar 包外
