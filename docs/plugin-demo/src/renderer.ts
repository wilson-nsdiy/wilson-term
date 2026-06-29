import type { RendererPlugin, PluginContext, PluginStatusBarItem, PluginMenuItem } from './plugin-types'

/**
 * 渲染进程插件
 *
 * 运行在渲染进程沙箱中（new Function），无法访问 Node.js API。
 * 通过 `export default` 导出 class。
 */
export default class DemoRendererPlugin implements RendererPlugin {
  private ctx!: PluginContext
  private enabled = true
  private inputCount = 0

  async activate(ctx: PluginContext): Promise<void> {
    this.ctx = ctx

    // 从存储恢复状态
    this.enabled = (await ctx.storage.get<boolean>('enabled')) ?? true

    ctx.logger.info('[plugin-demo] 渲染进程插件已激活')

    // 绑定已有会话
    // 注意: 实际运行时通过宿主传入的 sessions 绑定
  }

  onSessionCreated(sessionId: string): void {
    if (!this.ctx.terminal) return

    // 监听终端输入，检测 "hello" 命令
    this.ctx.terminal.onInput(sessionId, (data: string) => {
      if (!this.enabled) return

      const trimmed = data.trim().toLowerCase()

      if (trimmed === 'hello' || trimmed === 'hello\r') {
        this.ctx.terminal!.write(sessionId, `你好！欢迎使用 Wilson Term 插件示例 :)\r\n`)
        this.ctx.terminal!.write(sessionId, `当前时间: ${new Date().toLocaleString('zh-CN')}\r\n`)
      }
    })

    // 统计输出数据量
    this.ctx.terminal.onOutput(sessionId, (_data: string) => {
      if (!this.enabled) return
      this.inputCount++
    })
  }

  onSessionDestroyed(_sessionId: string): void {
    // 清理资源（监听器由宿主自动清理）
  }

  /**
   * 声明状态栏项
   * 返回非 null 时，宿主会在状态栏显示对应标签
   */
  statusBarItem(_sessionId: string): PluginStatusBarItem | null {
    if (!this.enabled) return null

    return {
      label: 'DEMO',
      style: {
        backgroundColor: '#2a4a7a',
        color: '#89d4fa'
      },
      tooltip: `插件示例已启用 | 检测到 ${this.inputCount} 次输出`
    }
  }

  /**
   * 声明菜单项
   * 返回的菜单项会出现在插件专属菜单中
   */
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
