# Wilson Term 插件开发指南

本文档介绍如何为 Wilson Term 开发插件。插件系统允许你扩展终端功能，而无需修改宿主应用代码。

## 目录

- [架构概览](#架构概览)
- [快速开始](#快速开始)
- [插件清单 manifest.json](#插件清单-manifestjson)
- [权限系统](#权限系统)
- [主进程插件](#主进程插件)
- [渲染进程插件](#渲染进程插件)
- [插件上下文 PluginContext](#插件上下文-plugincontext)
- [生命周期](#生命周期)
- [终端数据流](#终端数据流)
- [声明式 UI](#声明式-ui)
- [存储 API](#存储-api)
- [网络请求 API](#网络请求-api)
- [IPC 通信](#ipc-通信)
- [宿主环境信息](#宿主环境信息)
- [日志 API](#日志-api)
- [构建与打包](#构建与打包)
- [安装与分发](#安装与分发)
- [安全模型](#安全模型)
- [完整示例：plugin-demo 插件](#完整示例plugin-demo-插件)
- [常见问题](#常见问题)

---

## 架构概览

Wilson Term 基于 Electron，插件代码分布在两个进程中：

```
┌─────────────────────────────────────────────────────┐
│  主进程 (Node.js)                                    │
│  ┌───────────────┐  ┌──────────────────────────────┐ │
│  │ MainPluginHost│  │ 主进程插件 (main.js)         │ │
│  │  - 生命周期    │  │  - 注册 IPC handler          │ │
│  │  - 资源管理    │  │  - 发起网络请求              │ │
│  │  - 安全校验    │  │  - 访问文件存储              │ │
│  └───────────────┘  └──────────────────────────────┘ │
│         │                                           │
│    IPC (plugin:{id}:*)                              │
│         │                                           │
│  ┌───────────────┐  ┌──────────────────────────────┐ │
│  │ 预加载脚本    │  │ window.api.plugin             │ │
│  │ contextBridge │  │  - invoke / on / write        │ │
│  └───────────────┘  └──────────────────────────────┘ │
│         │                                           │
├─────────│───────────────────────────────────────────┤
│  渲染进程 (Browser)                                  │
│  ┌───────────────┐  ┌──────────────────────────────┐ │
│  │RendererHost   │  │ 渲染进程插件 (renderer.js)   │ │
│  │  - 沙箱加载    │  │  - 监听终端输入/输出         │ │
│  │  - 回调分发    │  │  - 声明式 UI（状态栏/菜单）  │ │
│  │  - 生命周期    │  │  - 会话生命周期响应          │ │
│  └───────────────┘  └──────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

**关键设计决策：**

- 渲染进程插件运行在 `new Function()` 沙箱中，**无法访问 Node.js API**（无 `require`、`process` 等）
- 渲染进程插件必须由 esbuild 打包成单文件 CJS，消除所有 `require` 调用
- 主进程插件由 `tsc` 编译为 CJS，可直接使用 Node.js API
- 插件 UI 采用**声明式**设计：插件返回数据结构，宿主负责渲染，避免 React 依赖
- IPC 通道自动添加 `plugin:{id}:` 前缀，防止跨插件冲突

---

## 快速开始

### 1. 创建插件目录

在项目根目录 `plugins/` 下创建你的插件目录：

```
plugins/my-plugin/
├── package.json
├── tsconfig.json
├── manifest.json
├── src/
│   ├── plugin-types.ts   # 从 src/shared/types/plugin.ts 复制
│   ├── main.ts           # 主进程插件（可选）
│   └── renderer.ts       # 渲染进程插件（可选）
└── scripts/
    └── build-zip.js       # 构建脚本
```

### 2. 编写 manifest.json

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "description": "插件功能描述",
  "main": "main.js",
  "renderer": "renderer.js",
  "permissions": ["ipc:register", "storage:read-write", "terminal:input", "terminal:output", "terminal:write"]
}
```

### 3. 编写插件代码

**主进程插件** (`src/main.ts`)：

```typescript
import type { MainPlugin, PluginContext } from './plugin-types'

export default <MainPlugin>{
  registerHandlers(ctx: PluginContext): void {
    ctx.ipc!.handle('my-action', async (_event, arg: string) => {
      return { result: `处理: ${arg}` }
    })
  },

  async activate(ctx: PluginContext): Promise<void> {
    ctx.logger.info('插件已激活')
  },

  async deactivate(): Promise<void> {
    // handler 由宿主自动清理
  },
}
```

**渲染进程插件** (`src/renderer.ts`)：

```typescript
import type { RendererPlugin, PluginContext } from './plugin-types'

export default class MyRendererPlugin implements RendererPlugin {
  private ctx!: PluginContext
  private enabled = true

  async activate(ctx: PluginContext): Promise<void> {
    this.ctx = ctx
    this.enabled = (await ctx.storage.get<boolean>('enabled')) ?? true

    // 绑定已有会话
    const sessions = await (window as any).api.plugin.getSessions()
    for (const sid of sessions) {
      this.bindSession(sid)
    }
  }

  onSessionCreated(sessionId: string): void {
    this.bindSession(sessionId)
  }

  onSessionDestroyed(sessionId: string): void {
    // 清理该会话的资源
  }

  private bindSession(sessionId: string): void {
    this.ctx.terminal!.onInput(sessionId, (data) => {
      if (this.enabled) {
        // 处理输入数据
      }
    })
    this.ctx.terminal!.onOutput(sessionId, (data) => {
      if (this.enabled) {
        // 处理输出数据
      }
    })
  }

  statusBarItem(sessionId: string) {
    if (!this.enabled) return null
    return {
      label: 'MY',
      style: { backgroundColor: '#2a4a7a', color: '#89d4fa' },
      tooltip: '我的插件已启用',
    }
  }

  menuItems() {
    return [{
      label: '我的插件',
      checked: this.enabled,
      onClick: () => {
        this.enabled = !this.enabled
        this.ctx.storage.set('enabled', this.enabled)
      },
    }]
  }

  async deactivate(): Promise<void> {
    // 清理所有资源
  }
}
```

### 4. 构建与测试

```bash
cd plugins/my-plugin
npm install
npm run build
```

构建产物为 `{plugin-id}.zip`，可通过应用内的插件管理器导入测试。

---

## 插件清单 manifest.json

`manifest.json` 是插件的入口描述文件，位于插件 ZIP 包的根目录。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | `string` | 是 | 插件唯一标识，仅允许小写字母、数字和短横线 (`^[a-z0-9-]+$`) |
| `name` | `string` | 是 | 插件显示名称 |
| `version` | `string` | 是 | 语义化版本号 |
| `description` | `string` | 是 | 插件功能描述 |
| `main` | `string` | 否 | 主进程入口文件，默认 `main.js`。不允许包含路径分隔符 |
| `renderer` | `string` | 否 | 渲染进程入口文件，默认 `renderer.js`。不允许包含路径分隔符 |
| `permissions` | `string[]` | 是 | 所需权限列表 |

---

## 权限系统

插件必须在 `manifest.json` 中声明所需权限，宿主仅注入与声明权限匹配的上下文 API。

| 权限 | 上下文注入 | 说明 |
|------|-----------|------|
| `ipc:register` | `ctx.ipc` | 注册 IPC handler，供渲染进程调用 |
| `storage:read-write` | `ctx.storage` | 读写插件专属键值存储 |
| `network:fetch` | `ctx.network` | 发起 HTTP/HTTPS 网络请求 |
| `terminal:input` | `ctx.terminal.onInput` | 监听终端用户输入 |
| `terminal:output` | `ctx.terminal.onOutput` | 监听终端输出数据 |
| `terminal:write` | `ctx.terminal.write` | 向终端会话写入数据 |

**始终可用的 API（无需声明权限）：**

- `ctx.storage` — 键值存储
- `ctx.host` — 宿主环境信息
- `ctx.logger` — 日志输出

> 注意：只要声明了任意 `terminal:*` 权限，`ctx.terminal` 对象整体可用（包含 `onInput`、`onOutput`、`write`）。

---

## 主进程插件

主进程插件运行在 Electron 主进程（Node.js 环境），负责：

- 注册 IPC handler 供渲染进程调用
- 发起网络请求
- 访问文件系统（通过 `ctx.storage`）

### 接口定义

```typescript
interface MainPlugin extends PluginLifecycle {
  registerHandlers?(ctx: PluginContext): void
}
```

### 导出约定

使用 `export default` 导出对象字面量：

```typescript
import type { MainPlugin, PluginContext } from './plugin-types'

export default <MainPlugin>{
  registerHandlers(ctx: PluginContext): void {
    // 注册 IPC handler
  },
  async activate(ctx: PluginContext): Promise<void> {
    // 初始化
  },
  async deactivate(): Promise<void> {
    // 清理（IPC handler 由宿主自动清理）
  },
}
```

### registerHandlers 调用时机

`registerHandlers` 在 `activate` 之前调用，用于注册 IPC handler。注册的 handler 通道会自动添加 `plugin:{id}:` 前缀。例如：

```typescript
ctx.ipc!.handle('fetch-key', handler)
// 实际注册的通道: plugin:my-plugin:fetch-key
```

渲染进程调用时使用完整通道名：

```typescript
const result = await window.api.plugin.invoke('plugin:my-plugin:fetch-key', arg)
```

---

## 渲染进程插件

渲染进程插件运行在 Electron 渲染进程的沙箱环境中，负责：

- 监听终端输入/输出数据流
- 响应会话生命周期事件
- 声明式 UI（状态栏项、菜单项）

### 接口定义

```typescript
interface RendererPlugin extends PluginLifecycle {
  statusBarItem?(sessionId: string): PluginStatusBarItem | null
  menuItems?(): PluginMenuItem[]
}
```

### 导出约定

支持两种导出方式：

**类导出（宿主自动实例化）：**

```typescript
export default class MyPlugin implements RendererPlugin {
  async activate(ctx: PluginContext): Promise<void> { ... }
  // ...
}
```

**对象字面量导出：**

```typescript
export default <RendererPlugin>{
  async activate(ctx: PluginContext): Promise<void> { ... },
  // ...
}
```

### 沙箱限制

渲染进程插件通过 `new Function('exports', 'module', code)` 加载，**无法访问：**

- `require` — Node.js 模块系统
- `process` — Node.js 全局对象
- `__dirname` / `__filename` — 文件系统路径
- 任何 Node.js 内置模块

**可以访问：**

- 浏览器全局对象（`window`、`document`、`console` 等）
- `window.api.plugin.*` — 预加载脚本暴露的插件 API
- `ctx` 中注入的所有 API

> 因此，渲染进程插件的代码必须由 esbuild 打包成单文件，消除所有 `require` 调用。

---

## 插件上下文 PluginContext

`PluginContext` 是宿主注入给插件的运行时环境，根据声明的权限提供不同的 API。

### storage — 键值存储

始终可用。每个插件的存储空间完全隔离。

```typescript
ctx.storage.get<T>(key: string): Promise<T | null>
ctx.storage.set(key: string, value: unknown): Promise<void>
```

- 存储路径：`{userData}/plugins/{plugin-id}/storage/{key}.json`
- Key 不允许包含 `/` 或 `\`
- 值以 JSON 格式序列化

### ipc — IPC 通信

需声明 `ipc:register` 权限。仅主进程可用。

```typescript
ctx.ipc.handle(channel: string, handler: (...args: any[]) => any): void
```

- 通道自动添加 `plugin:{id}:` 前缀
- 渲染进程通过 `window.api.plugin.invoke('plugin:{id}:{channel}', ...args)` 调用

### network — 网络请求

需声明 `network:fetch` 权限。仅主进程可用。

```typescript
ctx.network.fetch(url: string, options?: {
  method?: string
  headers?: Record<string, string>
  body?: string
}): Promise<{ ok: boolean; status: number; text: string }>
```

- 仅允许 `http:` 和 `https:` 协议
- 底层使用 Electron 的 `net.fetch`

### terminal — 终端数据流

需声明任意 `terminal:*` 权限。渲染进程和主进程均可使用。

```typescript
ctx.terminal.onInput(sessionId: string, callback: (data: string) => void): () => void
ctx.terminal.onOutput(sessionId: string, callback: (data: string) => void): () => void
ctx.terminal.write(sessionId: string, data: string): void
```

- `onInput` / `onOutput` 返回取消订阅函数
- `write` 在渲染进程中通过 IPC 转发到主进程统一写入

### host — 宿主环境信息

始终可用。

```typescript
ctx.host.getDomain(): Promise<string>
```

- 返回当前计算机的域名（如 `company.com.cn`），可用于判断运行环境

### logger — 日志输出

始终可用。

```typescript
ctx.logger.info(msg: string): void
ctx.logger.error(msg: string): void
```

- 输出格式：`[Plugin:{id}] {msg}`
- 在开发者工具的控制台中可见

---

## 生命周期

插件生命周期方法均为可选，宿主会在合适的时机调用。

### 通用生命周期

| 方法 | 调用时机 | 说明 |
|------|---------|------|
| `activate(ctx)` | 插件启用时 | 初始化插件逻辑，5 秒超时 |
| `deactivate()` | 插件禁用时 | 清理资源，5 秒超时。IPC handler 由宿主自动清理 |
| `dispose()` | 插件卸载时 | 最终清理，5 秒超时 |
| `onSessionCreated(sessionId)` | 新终端会话建立 | 绑定该会话的输入/输出监听 |
| `onSessionDestroyed(sessionId)` | 终端会话关闭 | 清理该会话相关资源 |
| `onSessionReconnect(sessionId)` | 终端会话重连 | 重置该会话的状态 |

### 主进程特有

| 方法 | 调用时机 | 说明 |
|------|---------|------|
| `registerHandlers(ctx)` | `activate` 之前 | 注册 IPC handler |

### 渲染进程特有

| 方法 | 调用时机 | 说明 |
|------|---------|------|
| `statusBarItem(sessionId)` | 状态栏渲染时 | 返回声明式状态栏项或 `null` |
| `menuItems()` | 菜单渲染时 | 返回声明式菜单项数组 |

### 生命周期流程

```
导入 ZIP → loadPluginFromDisk → [registerHandlers → activate]
                                          ↓
                                    onSessionCreated (每个新会话)
                                          ↓
                                    onSessionDestroyed (会话关闭)
                                          ↓
用户禁用 → deactivate → 自动清理 IPC handler 和 unsubscribes
                                          ↓
用户卸载 → dispose → 清理所有资源（含 storage handler）→ 删除文件
```

---

## 终端数据流

```
用户按键 → xterm.onData → TerminalInstance
  ├─ connection.write(sessionId, data)    → 发送到远端
  └─ rendererPluginHost.feedInput(sid, data) → 分发给插件

远端输出 → connection.onData → TerminalInstance
  ├─ xterm.write(data)                   → 渲染到屏幕
  └─ rendererPluginHost.feedOutput(sid, data) → 分发给插件

插件写入 → ctx.terminal.write(sessionId, data)
  └─ window.api.plugin.write(sid, data) → IPC → connection.write(data) → 发送到远端
```

> 注意：`feedInput` 和 `feedOutput` 是宿主主动推送给插件的，插件需要通过 `onInput` / `onOutput` 注册回调来接收。

---

## 声明式 UI

插件不直接渲染 React 组件，而是返回数据结构由宿主渲染。

### 状态栏项

```typescript
interface PluginStatusBarItem {
  label: string
  style?: {
    backgroundColor?: string
    color?: string
    border?: string
  }
  tooltip?: string
}
```

示例：

```typescript
statusBarItem(sessionId: string) {
  if (!this.enabled) return null
  return {
    label: 'DEMO',
    style: { backgroundColor: '#2a4a7a', color: '#89d4fa' },
    tooltip: '插件示例已启用',
  }
}
```

### 菜单项

```typescript
interface PluginMenuItem {
  label: string
  checked?: boolean
  disabled?: boolean
  onClick: () => void
}
```

示例：

```typescript
menuItems() {
  return [{
    label: '插件示例',
    checked: this.enabled,
    onClick: () => {
      this.enabled = !this.enabled
      this.ctx.storage.set('enabled', this.enabled)
    },
  }]
}
```

---

## 存储 API

插件的存储空间完全隔离，以键值对形式存储在文件系统中。

### 主进程

直接通过 `ctx.storage` 读写：

```typescript
// 读取
const value = await ctx.storage.get<string>('my-key')

// 写入
await ctx.storage.set('my-key', { foo: 'bar' })
```

### 渲染进程

渲染进程通过 IPC 间接访问存储（通道：`plugin:{id}:storage:get` / `plugin:{id}:storage:set`），API 签名相同：

```typescript
const value = await ctx.storage.get<boolean>('enabled')
await ctx.storage.set('enabled', true)
```

### 限制

- Key 不允许包含 `/` 或 `\`
- 值以 JSON 序列化，必须可 JSON 化
- 存储路径：`{userData}/plugins/{plugin-id}/storage/{key}.json`
- Storage IPC handler 在 `deactivate` 时**不会**被清理，仅在 `uninstall` 时清理，确保禁用状态下渲染进程仍可读取配置

---

## 网络请求 API

需声明 `network:fetch` 权限，仅主进程可用。

```typescript
const response = await ctx.network.fetch('https://api.example.com/data', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ key: 'value' }),
})

if (response.ok) {
  const data = JSON.parse(response.text)
} else {
  ctx.logger.error(`请求失败: HTTP ${response.status}`)
}
```

### 限制

- 仅允许 `http:` 和 `https:` 协议
- 返回 `{ ok, status, text }`，不提供流式读取

---

## IPC 通信

主进程和渲染进程之间通过 IPC 通信，通道自动命名空间化。

### 主进程注册

```typescript
// 主进程插件
ctx.ipc!.handle('my-action', async (_event, arg: string) => {
  return { result: `处理: ${arg}` }
})
// 实际通道: plugin:my-plugin:my-action
```

### 渲染进程调用

```typescript
// 渲染进程插件
const result = await (window as any).api.plugin.invoke(
  'plugin:my-plugin:my-action',
  'hello'
)
```

### 监听主进程推送

```typescript
// 渲染进程
const unsub = (window as any).api.plugin.on(
  'plugin:my-plugin:some-event',
  (data) => { /* 处理事件 */ }
)
// 取消监听
unsub()
```

### 限制

- 预加载脚本仅允许 `plugin:` 前缀的通道，防止插件访问宿主或其他插件的 IPC
- 主进程注册的 handler 在 `deactivate` 时自动清理

---

## 宿主环境信息

```typescript
const domain = await ctx.host.getDomain()
// 例如: "company.com.cn" 或 ""（非域环境）
```

可用于根据运行环境启用/禁用功能。

---

## 日志 API

```typescript
ctx.logger.info('操作成功')
ctx.logger.error('操作失败: 原因')
```

- 输出到控制台，格式为 `[Plugin:{id}] {msg}`
- 在开发者工具中可见（`Ctrl+Shift+I` → Console）

---

## 构建与打包

### 目录结构

```
plugins/my-plugin/
├── package.json          # 独立的 npm 包配置
├── tsconfig.json         # 独立的 TypeScript 配置
├── manifest.json         # 插件清单
├── src/
│   ├── plugin-types.ts   # 类型定义（从 src/shared/types/plugin.ts 复制）
│   ├── main.ts           # 主进程插件
│   ├── renderer.ts       # 渲染进程插件
│   └── ...               # 其他工具模块
├── scripts/
│   └── build-zip.js      # 构建脚本
└── dist/                 # 构建输出（gitignore）
```

### package.json

```json
{
  "name": "wilson-term-plugin-my-plugin",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "build": "tsc && node scripts/build-zip.js",
    "clean": "rimraf dist *.zip"
  },
  "devDependencies": {
    "adm-zip": "^0.5.10",
    "esbuild": "^0.28.1",
    "rimraf": "^5.0.5",
    "typescript": "^5.7.2"
  }
}
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "CommonJS",
    "moduleResolution": "node",
    "lib": ["ES2020", "DOM"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": false
  },
  "include": ["src/main.ts", "src/plugin-types.ts"]
}
```

> 注意：`include` 中**不要**包含 `src/renderer.ts`，它由 esbuild 单独处理。

### 构建脚本 (scripts/build-zip.js)

构建分两步：

1. **tsc** 编译主进程代码（`main.ts` 及其依赖）为 CJS
2. **esbuild** 打包渲染进程代码（`renderer.ts`）为单文件 CJS bundle（消除 `require`）
3. **AdmZip** 将 `manifest.json`、`main.js`、`renderer.js` 打包为 ZIP

```javascript
const AdmZip = require('adm-zip')
const { copyFileSync, existsSync, mkdirSync, rmSync } = require('fs')
const { join } = require('path')
const esbuild = require('esbuild')

const root = __dirname + '/..'
const distDir = join(root, 'dist')
const zipPath = join(root, 'my-plugin.zip')

if (existsSync(zipPath)) rmSync(zipPath)
if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true })

// esbuild 打包 renderer.ts
esbuild.buildSync({
  entryPoints: [join(root, 'src/renderer.ts')],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  outfile: join(distDir, 'renderer.js'),
  target: 'es2020',
  minify: false,
})

// 复制 manifest.json
copyFileSync(join(root, 'manifest.json'), join(distDir, 'manifest.json'))

// 打包 ZIP
const zip = new AdmZip()
zip.addLocalFile(join(distDir, 'main.js'))
zip.addLocalFile(join(distDir, 'renderer.js'))
zip.addLocalFile(join(distDir, 'manifest.json'))
zip.writeZip(zipPath)

console.log(`zip created: ${zipPath}`)
```

### esbuild 关键配置

| 选项 | 值 | 原因 |
|------|---|------|
| `platform` | `'browser'` | 渲染进程运行在浏览器环境 |
| `format` | `'cjs'` | 沙箱通过 `module.exports` 加载 |
| `bundle` | `true` | 内联所有依赖，消除 `require` |
| `target` | `'es2020'` | 匹配 Electron Chromium 版本 |

### 一键构建所有插件

在项目根目录执行：

```bash
npm run plugins:build
```

该命令遍历 `plugins/` 下所有包含 `package.json` 的子目录并执行 `npm run build`。

---

## 安装与分发

### 安装

1. 打开 Wilson Term
2. 菜单栏 → 工具 → 插件管理
3. 点击"导入 ZIP"，选择 `.zip` 文件
4. 导入后插件默认为禁用状态，点击"已禁用"按钮启用

### 分发

将构建生成的 `{plugin-id}.zip` 文件分享给其他用户，他们通过插件管理器导入即可。

### 更新

导入同 ID 的插件 ZIP 会自动覆盖旧版本，保留注册表记录（更新 `updatedAt` 时间戳）。

---

## 安全模型

> **重要：插件系统并非沙箱隔离。** 主进程插件拥有完整的 Node.js 访问权限，渲染进程插件可访问浏览器全局对象和 `window.api`。插件的安全级别等价于"仅导入信任作者的插件"，与 VSCode 扩展模型类似。

| 安全风险 | 防护措施 | 实际边界 |
|---------|---------|---------|
| IPC 通道劫持 | 自动添加 `plugin:{id}:` 前缀；预加载脚本仅允许 `plugin:` 前缀通道 | 防止跨插件干扰，不防止插件访问宿主 API |
| ZIP 路径穿越 | 拒绝包含 `..` 或以 `/` 开头的条目 | — |
| 恶意文件类型 | 白名单：json, js, css, png, jpg, jpeg, gif, svg, woff, woff2, ttf, eot | — |
| 超大插件包 | 最多 100 条目，单文件 10MB，总计 50MB | — |
| 符号链接攻击 | 解压后递归扫描，发现符号链接则拒绝加载 | — |
| 主进程访问 Node.js | **无防护** — 主进程插件通过 `require()` 加载，可访问 `fs`、`child_process` 等所有 Node.js API | 仅导入信任的插件 |
| 渲染进程访问浏览器 API | **无防护** — `new Function()` 沙箱不传 `require`/`process`，但 `window`、`document`、`fetch`、`localStorage` 及 `window.api.*` 全部可见 | 仅导入信任的插件 |
| 协议限制 | `network.fetch` 仅允许 http/https | — |
| 存储键路径穿越 | Key 不允许包含 `/` 或 `\` | — |
| 生命周期卡死 | `activate`/`deactivate`/`dispose` 5 秒超时 | — |
| 重复激活 | `activating` 布尔守卫防止重入 | — |
| 跨插件干扰 | 回调错误按插件捕获；IPC handler 在 deactivate 时清理 | — |

---

## 完整示例：plugin-demo 插件

Wilson Term 在 `docs/plugin-demo/` 提供了一个完整的参考插件示例，位于项目仓库中：

```
docs/plugin-demo/
├── package.json          # 依赖和构建脚本
├── tsconfig.json         # TypeScript 配置
├── manifest.json         # 插件清单
├── src/
│   ├── plugin-types.ts   # 从 wilson-term 同步的类型定义
│   ├── main.ts           # 主进程插件
│   └── renderer.ts       # 渲染进程插件
└── scripts/
    └── build-zip.js      # ZIP 打包脚本
```

### 功能说明

- **状态栏指示器** — 在状态栏显示 `DEMO` 标签，提示插件已启用
- **菜单项** — 通过菜单切换插件启用/禁用状态
- **终端交互** — 检测终端输入 `hello` 时自动回复
- **IPC 通信** — 演示渲染进程通过 IPC 调用主进程功能

### manifest.json

```json
{
  "id": "plugin-demo",
  "name": "插件示例",
  "version": "1.0.0",
  "description": "Wilson Term 插件开发示例，展示主进程 IPC 和渲染进程状态栏/菜单功能",
  "main": "main.js",
  "renderer": "renderer.js",
  "permissions": [
    "ipc:register",
    "storage:read-write",
    "network:fetch",
    "terminal:input",
    "terminal:output",
    "terminal:write"
  ]
}
```

### 主进程插件 (src/main.ts)

```typescript
import type { MainPlugin, PluginContext } from './plugin-types'

export default <MainPlugin>{
  registerHandlers(ctx: PluginContext): void {
    ctx.ipc!.handle('get-time', async () => {
      const now = new Date()
      return {
        iso: now.toISOString(),
        locale: now.toLocaleString('zh-CN'),
        timestamp: now.getTime()
      }
    })

    ctx.ipc!.handle('echo', async (_event, message: string) => {
      ctx.logger.info(`收到 echo 请求: ${message}`)
      return `服务端回显: ${message}`
    })
  },

  async activate(ctx: PluginContext): Promise<void> {
    ctx.logger.info('[plugin-demo] 主进程插件已激活')
  },

  async deactivate(): Promise<void> {
    // IPC handler 由宿主自动清理，无需手动注销
  }
}
```

### 渲染进程插件 (src/renderer.ts)

```typescript
import type { RendererPlugin, PluginContext, PluginStatusBarItem, PluginMenuItem } from './plugin-types'

export default class DemoRendererPlugin implements RendererPlugin {
  private ctx!: PluginContext
  private enabled = true
  private inputCount = 0

  async activate(ctx: PluginContext): Promise<void> {
    this.ctx = ctx
    this.enabled = (await ctx.storage.get<boolean>('enabled')) ?? true
    ctx.logger.info('[plugin-demo] 渲染进程插件已激活')
  }

  onSessionCreated(sessionId: string): void {
    if (!this.ctx.terminal) return

    this.ctx.terminal.onInput(sessionId, (data: string) => {
      if (!this.enabled) return
      const trimmed = data.trim().toLowerCase()
      if (trimmed === 'hello' || trimmed === 'hello\r') {
        this.ctx.terminal!.write(sessionId, `你好！欢迎使用 Wilson Term 插件示例 :)\r\n`)
        this.ctx.terminal!.write(sessionId, `当前时间: ${new Date().toLocaleString('zh-CN')}\r\n`)
      }
    })

    this.ctx.terminal.onOutput(sessionId, (_data: string) => {
      if (!this.enabled) return
      this.inputCount++
    })
  }

  onSessionDestroyed(_sessionId: string): void {
    // 监听器由宿主自动清理
  }

  statusBarItem(_sessionId: string): PluginStatusBarItem | null {
    if (!this.enabled) return null
    return {
      label: 'DEMO',
      style: { backgroundColor: '#2a4a7a', color: '#89d4fa' },
      tooltip: `插件示例已启用 | 检测到 ${this.inputCount} 次输出`
    }
  }

  menuItems(): PluginMenuItem[] {
    return [
      {
        label: '插件示例',
        checked: this.enabled,
        onClick: () => {
          this.enabled = !this.enabled
          this.ctx.storage.set('enabled', this.enabled)
        }
      },
      {
        label: '获取服务端时间',
        disabled: false,
        onClick: async () => {
          try {
            const result = await (window as any).api.plugin.invoke(
              'plugin:plugin-demo:get-time'
            ) as { iso: string; locale: string; timestamp: number }
            alert(`服务端时间:\n${result.locale}`)
          } catch (err) {
            alert(`获取时间失败: ${err}`)
          }
        }
      },
      {
        label: '测试 Echo',
        disabled: false,
        onClick: async () => {
          try {
            const result = await (window as any).api.plugin.invoke(
              'plugin:plugin-demo:echo',
              '你好'
            ) as string
            alert(result)
          } catch (err) {
            alert(`Echo 失败: ${err}`)
          }
        }
      }
    ]
  }

  async deactivate(): Promise<void> {
    // 清理资源
  }
}
```

### 构建与打包

```bash
cd docs/plugin-demo
npm install
npm run build
```

产物为 `docs/plugin-demo/plugin-demo.zip`，可通过 Wilson Term 插件管理器导入。

完整源码位于 `docs/plugin-demo/` 目录，可直接作为新插件开发的模板使用。

---

## 常见问题

### 渲染进程插件中可以使用 npm 包吗？

可以，但必须由 esbuild 打包。esbuild 会将依赖内联到输出文件中。注意不要使用 Node.js 原生模块（如 `fs`、`child_process`），因为渲染进程沙箱无法访问 Node.js API。

### 如何在渲染进程中调用主进程插件的功能？

1. 主进程插件在 `registerHandlers` 中注册 IPC handler
2. 渲染进程通过 `window.api.plugin.invoke('plugin:{id}:{channel}', ...args)` 调用

### 插件禁用后存储数据会丢失吗？

不会。Storage IPC handler 在 `deactivate` 时不会被清理，仅在 `uninstall` 时清理。禁用状态下渲染进程仍可读写存储。

### 如何调试插件？

1. 打开开发者工具（`Ctrl+Shift+I`）
2. 在 Console 中查看 `[Plugin:{id}]` 前缀的日志
3. 主进程日志在终端启动的命令行窗口中可见

### 插件 ID 有什么限制？

仅允许小写字母、数字和短横线，正则为 `^[a-z0-9-]+$`。建议使用简短有意义的标识符，如 `plugin-demo`、`auto-login`。

### 一个插件可以只有主进程或只有渲染进程吗？

可以。`main` 和 `renderer` 字段都是可选的。如果不需要某一侧的功能，可以省略对应字段和源文件。

### 类型定义如何同步？

插件目录下的 `src/plugin-types.ts` 是 `src/shared/types/plugin.ts` 的手动副本。两个文件头部都有同步提醒注释。修改类型时需同时更新两处。

### 如何处理多个终端会话？

每个终端会话有唯一的 `sessionId`。插件应按 `sessionId` 维护独立状态（如 plugin-demo 插件为每个会话维护独立的检测器实例）。通过 `onSessionCreated` / `onSessionDestroyed` 管理会话生命周期。
