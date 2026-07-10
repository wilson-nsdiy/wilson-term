# Wilson Term 插件示例

一个简单的插件示例，展示主进程 IPC 通信和渲染进程状态栏功能。

## 目录结构

```
plugin-demo/
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

## 插件功能

- 状态栏显示一个示例指示器
- 监听终端输入，检测到 `hello` 时自动回复
- 主进程提供 IPC 服务端时间查询

## 开发

```bash
# 安装依赖
npm install

# 构建
npm run build

# 产物: plugin-demo.zip，可通过 Wilson Term 插件管理器导入
```

## 类型同步

`plugin-types.ts` 需与 `wilson-term/src/shared/types/plugin.ts` 保持同步。
