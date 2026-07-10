# Changelog

All notable changes to Wilson Term will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v0.10.0] - 2026-07-09

### Added

- SSH 连接支持快速重连：连接断开后重新打开同一连接时，无需再次输入密码或重新认证，恢复更迅速

### Changed

- 简化应用更新流程，更新时不再显示自动安装倒计时
- 改进数据保存方式，减少界面卡顿；连接断开或出错时处理更稳定
- 终端组件由 v6.0.0 降级至 v5.5.0，规避新版本中的输入法与显示问题，使用更稳定的版本

### Removed

- 移除插件菜单项功能：插件不再支持声明式菜单项，仅保留状态栏项（影响插件开发者）

### Fixed

- 修复 Windows 下将程序安装在 Program Files 等系统目录时日志无法写入的问题，日志改存到用户目录
- 提升操作日志记录的可靠性，连接断开或退出时不易丢失记录

## [v0.9.9] - 2026-07-03

### Added

- 侧边栏新增搜索功能，支持按名称、主机名、串口路径快速查找连接
- 侧边栏支持拖拽调整宽度（150px ~ 400px）
- 侧边栏新增会话分组，支持用目录管理连接
- 侧边栏新建按钮改为下拉菜单，支持新建目录和新建连接

### Changed

- 优化侧边栏头部布局，新建连接入口移至标题栏右侧
- 搜索结果中禁用拖拽排序，避免排序异常
- 自动更新检查频率调整为每 7 天一次，手动检查不受影响
- 统一侧边栏目录和连接的缩进与间距
- 优化侧边栏拖拽排序和分组管理体验

### Fixed

- 跳过无效的历史会话数据，避免应用异常
- 修复部分环境下新建或重命名时输入框不显示的问题
- 手动检查更新时不再弹出 toast 通知
- 修复拼音输入法 composition 在光标靠右时溢出导致页面左移
- 修复侧边栏一级分组连接数未包含子分组连接的问题

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
