# Wilson Term

Wilson Term 是一个支持 SSH / Telnet / 串口 / 本地终端连接的模拟终端。

## 仓库地址

- GitHub: https://github.com/wilson-nsdiy/wilson-term
- Gitee: https://gitee.com/zhouws-chn/wilson-term

## 功能特性

- **多协议连接** — SSH（密码/密钥/免密认证）、Telnet（IAC 协商）、串口通信、本地终端（CMD/PowerShell/WSL）
- **多标签页** — 同时管理多个终端会话，标签页显示连接类型图标和状态指示灯
- **会话管理** — 侧边栏保存连接模板，双击快速连接，支持拖拽排序
- **SFTP 文件管理** — 基于 SSH 通道的远程文件浏览、上传、下载、删除、重命名
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
| 桌面框架 | Electron v33 |
| 前端 | React 18 + TypeScript 5 |
| 终端引擎 | @xterm/xterm v6.1（beta 通道）+ addon-fit / addon-search / addon-web-links / addon-webgl / addon-unicode11 |
| SSH | ssh2 |
| Telnet | Node.js net 模块（原生 IAC 协商） |
| 串口 | serialport v12 |
| 本地终端 | node-pty |
| 构建打包 | electron-vite v5 + Vite 6 + electron-builder |
| 状态管理 | Zustand 5 |
| 样式 | Tailwind CSS 3 |

## 环境要求

在运行 `npm install` 之前，必须先安装以下依赖：

- **Node.js >= 22**
- **npm >= 9**
- **Python 3.x** — 用于编译原生模块（node-gyp 依赖）
- **C++ 编译工具链** — 用于编译 serialport、ssh2、node-pty、koffi、sharp 等原生模块
  - **Windows**: 安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)，勾选 "C++ 桌面开发" 工作负载
  - **macOS**: 安装 Xcode Command Line Tools：`xcode-select --install`
  - **Linux**: 安装 build-essential：`sudo apt install build-essential`（Ubuntu/Debian）或 `sudo yum groupinstall "Development Tools"`（CentOS/RHEL）

## 快速开始

**前置条件：** 必须先安装 Python 3.x 和 C++ 编译工具链（见[环境要求](#环境要求)），否则 `npm install` 会因原生模块编译失败。

```bash
# 安装项目依赖（需要 Python + C++ 编译工具链）
npm install

# 开发模式
npm run dev

# 构建生产版本
npm run build

# 打包应用
npm run package

# 代码检查
npm run lint
npm run typecheck
```

## 插件开发

Wilson Term 支持通过插件扩展终端功能。插件以 ZIP 包形式导入，代码运行在主进程（Node.js）和渲染进程（浏览器沙箱）两个环境中。

详细开发指南请参阅 [PLUGIN_DEV_GUIDE.md](PLUGIN_DEV_GUIDE.md)。

```bash
# 构建插件示例
cd docs/plugin-demo && npm run build
```

## 项目结构

```
src/
├── main/                  # Electron 主进程
│   ├── index.ts           # 入口：窗口创建、IPC 注册
│   ├── ipc.ts             # IPC 注册中心
│   ├── ssh.ts             # SSH 连接管理
│   ├── telnet.ts          # Telnet 连接管理
│   ├── serial.ts          # 串口连接管理
│   ├── bash-connection.ts # 本地终端管理
│   ├── sftp.ts            # SFTP 文件管理
│   ├── plugin-host.ts     # 插件宿主
│   ├── domain.ts          # 域名检测
│   ├── updater.ts         # 更新管理
│   ├── logger.ts          # 会话日志
│   ├── app-logger.ts      # 应用日志
│   └── storage.ts         # 本地持久化
├── preload/
│   └── index.ts           # contextBridge API
├── renderer/
│   ├── plugin-host.ts     # 渲染进程插件宿主
│   └── src/
│       ├── components/    # UI 组件（28 个）
│       ├── store/         # Zustand 状态管理
│       ├── utils/         # 工具函数
│       └── styles/        # 全局样式
└── shared/
    └── types/             # 共享类型定义
        ├── index.ts
        ├── plugin.ts
        └── profile.ts

docs/
└── plugin-demo/           # 插件开发参考示例
```

## 注意事项

- 串口功能需要硬件权限（Linux 需加入 `dialout` 组）
- 自动更新需网络路径可达
- 原生模块（serialport、ssh2、node-pty）通过 asarUnpack 排除在 asar 外

## AI 编码助手配置

### Skills

| Skill | 来源 | 用途 |
|-------|------|------|
| **electron-development** | mindrally/skills（社区） | Electron 开发最佳实践 |
| **vercel-react-best-practices** | vercel-labs/agent-skills（社区） | React 18 编码规范 |
| **typescript-advanced-types** | wshobson/agents（社区） | TypeScript 高级类型指导 |
| **tailwind-css-patterns** | giuseppe-trisciuoglio/developer-kit（社区） | Tailwind CSS 模式库 |
| **new-component** | 项目自定义 | 生成新 React 组件模板 → `/new-component 组件名` |
| **project-conventions** | 项目自定义 | 自动加载项目编码规范 |

### Subagents（自动审查）

| Subagent | 用途 | 触发方式 |
|----------|------|----------|
| **security-reviewer** | SSH 认证、密钥管理、密码处理安全审查 | 自动运行 |
| **ui-reviewer** | Catppuccin Mocha 主题一致性、暗色可访问性审查 | 自动运行 |
| **test-writer** | 连接模块/工具函数测试生成 | `/test-writer 模块路径` |

### MCP Servers

配置在 `.mcp.json` 中：

| Server | 用途 | 配置要求 |
|--------|------|----------|
| **context7** | 实时文档查询（xterm.js、ssh2、serialport、electron 等） | 无需额外配置 |
| **GitLab** | Gitee 仓库集成（Issue/MR/CI Pipeline） | 需填入 `GITLAB_PERSONAL_ACCESS_TOKEN` |

### Hooks（自动触发器）


| Hook | 触发时机 | 行为 |
|------|----------|------|
| **ESLint 自动修复** | 每次 Edit/Write 操作后 | 自动执行 `eslint --fix` |
| **TypeScript 类型检查** | 每次 Edit/Write 操作后 | 自动执行 `tsc --noEmit` |
| **阻止编辑 package-lock.json** | 尝试编辑 lock 文件时 | 禁止直接修改，提示使用 `npm install` |

## 许可证

私有项目
