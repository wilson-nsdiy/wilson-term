# Changelog

All notable changes to Wilson Term will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [v0.9.9] - 2026-07-03

### Added

- 侧边栏新增搜索过滤功能，支持按名称、主机名、串口路径快速查找连接
- 侧边栏支持拖拽调整宽度（150px ~ 400px）
- 实现侧边栏会话分组功能，支持目录分组管理
- 侧边栏新建按钮改为下拉菜单，支持新建目录和新建连接

### Changed

- 侧边栏头部布局优化，新建连接按钮移至标题栏右侧
- 搜索过滤模式下禁用拖拽排序，避免索引错乱
- 限制自动更新检查频率为每7天一次，手动检查始终执行
- 使用自定义 InputDialog 替代 prompt()，修复 Electron 中 prompt 不显示的问题
- 统一同级分组和连接的左侧缩进宽度
- 减小顶级缩进，统一目录和连接的左侧间距
- 优化侧边栏拖拽排序和分组管理

### Fixed

- 过滤缺少 config 字段的无效保存会话，防止运行时异常
- 手动检查更新时不再弹出 toast 通知
- deduplicate updater status snapshot and only save check timestamp on success

## [v0.9.8] - 2026-07-02

### Changed

- Release workflow: pre-release 版本跳过 CHANGELOG 检查
- Release workflow: 使用环境变量替代重复的预发布检测逻辑
- Release workflow: 添加 tag 描述到版本更新内容
- Release workflow: 改进 tag message 处理

### Fixed

- 移除 tag/package.json 版本检查，让构建步骤从 tag 设置版本

## [v0.9.5] - 2026-07-01

### Changed

- 更新版本号至 0.9.5
- 优化 release 工作流，添加版本验证并简化 release notes
- 使用 tag 名称作为 GitHub Release 名称

### Fixed

- 统一状态栏标签内边距样式
- 修复 SSH 连接清理逻辑，确保资源正确释放
- 确保 SSH 客户端在服务器断开 shell 通道时正确关闭

## [v0.9.1] - 2026-06-30

### Added

- 添加 GitHub Actions CI 工作流
- 添加 deb 包构建目标和自定义 artifact 命名
- 添加 release body 包含功能概览和下载说明

### Changed

- 将更新系统迁移至 electron-updater，支持自动下载和安装
- 限制更新检查频率为每天一次，手动检查始终执行
- 添加仓库 URL 到 README 和 CLAUDE.md

### Fixed

- 修复 release 工作流中缺失 artifact 的问题
- 跳过 @electron/rebuild 以解决 Windows CI 上 node-pty 编译失败
- 修复构建配置问题并添加 Linux/Windows 构建支持
- 改进类型安全并移除未使用的导入
