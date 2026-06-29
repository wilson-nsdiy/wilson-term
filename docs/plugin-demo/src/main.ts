import type { MainPlugin, PluginContext } from './plugin-types'

/**
 * 主进程插件
 *
 * 运行在 Electron 主进程（Node.js 环境），可注册 IPC handler、发起网络请求。
 * 通过 `export default` 导出对象字面量。
 */
export default <MainPlugin>{
  registerHandlers(ctx: PluginContext): void {
    // 注册 IPC handler，自动添加 plugin:plugin-demo: 前缀
    // 渲染进程可通过 window.api.plugin.invoke('plugin:plugin-demo:get-time') 调用
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
