import { resolve } from 'path'
import { readFileSync } from 'fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json'

// 构建期从 @xterm/xterm 的 package.json 读取版本，注入渲染进程
// 用 config 工厂包 try/catch，依赖未装时给清晰错误而非顶层 panic 中断 Vite 启动
function readXtermVersion(): string {
  try {
    const xtermPkg = JSON.parse(
      readFileSync(resolve('node_modules/@xterm/xterm/package.json'), 'utf-8')
    )
    if (typeof xtermPkg.version !== 'string') {
      throw new Error('package.json 中 version 字段类型异常')
    }
    return xtermPkg.version
  } catch (err) {
    const msg =
      '构建失败：@xterm/xterm 未安装或 package.json 格式异常。' +
      '请确保已运行 npm install 且依赖完整安装。'
    console.error('❌ ' + msg, err)
    // 顶层 panic 会让 Vite CLI 输出难读的 stack；改抛友好 Error，Vite 会优雅退出
    throw new Error(msg, { cause: err })
  }
}

// Tauri 推荐配置：固定端口、clearScreen false、Tauri 配置
// host 默认 localhost 而非 0.0.0.0，避免开发服务器暴露到局域网(同网段可访问拿源码)
const host = process.env.TAURI_DEV_HOST || 'localhost'
const port = 5173
const xtermVersion = readXtermVersion()

export default defineConfig({
  // Tauri 期望构建产物在固定相对路径，使用 dist 作为输出目录
  plugins: [react()],
  // Tauri 通过 ViteDevServer 提供前端资源
  clearScreen: false,
  server: {
    host,
    port,
    strictPort: true,
    // Tauri 自动连接此 dev server
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: port + 1
        }
      : undefined,
    watch: {
      // Tauri 监听 src-tauri，Vite 不需要重复监听
      ignored: ['**/src-tauri/**']
    }
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    // Tauri 默认构建产物放在 dist/，与 tauri.conf.json 的 frontendDist 对齐
    target: 'es2021',
    minify: 'esbuild',
    sourcemap: false,
    // Tauri 推荐关闭 chunk 大小警告
    chunkSizeWarningLimit: 1500
  },
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer'),
      '@shared': resolve('src/shared')
    }
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __XTERM_VERSION__: JSON.stringify(xtermVersion)
  },
  // 入口：原 Electron 的 renderer 入口位于 src/renderer/index.html
  root: resolve('src/renderer'),
  // 公共资源目录
  publicDir: resolve('src/renderer/public')
})
