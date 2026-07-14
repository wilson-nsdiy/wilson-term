import { resolve } from 'path'
import { readFileSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json'

// 构建期从 @xterm/xterm 的 package.json 读取版本，注入渲染进程。
// 用 fs.readFileSync 而非 import ... from '@xterm/xterm/package.json'：
// 后者在 Node 原生 ESM 加载配置文件时会因缺少 `with { type: 'json' }`
// import attribute 报 ERR_IMPORT_ATTRIBUTE_MISSING。
let xtermVersion: string
try {
  const xtermPkg = JSON.parse(
    readFileSync(resolve('node_modules/@xterm/xterm/package.json'), 'utf-8')
  )
  if (typeof xtermPkg.version !== 'string') {
    throw new Error('package.json 中 version 字段类型异常')
  }
  xtermVersion = xtermPkg.version
} catch (err) {
  console.error('❌ 无法读取 @xterm/xterm 版本:', err)
  throw new Error(
    '构建失败：@xterm/xterm 未安装或 package.json 格式异常。' +
    '请确保已运行 npm install 且依赖完整安装。',
    { cause: err }
  )
}

export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      minify: true
    },
    plugins: [externalizeDepsPlugin({ exclude: ['electron-updater'] })],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      minify: true
    },
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    build: {
      outDir: 'dist/renderer'
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      // xterm 版本在构建期从其 package.json 静态读取并注入渲染进程。
      // 渲染进程是 Vite 打包的 ESM 且 nodeIntegration=false，运行时没有 require，
      // 也不应靠 require('@xterm/xterm/package.json') 这种子路径导入读版本
      // （Vite 默认不优化包的子路径导入，运行时会抛错回退到 'unknown' 触发误报）。
      __XTERM_VERSION__: JSON.stringify(xtermVersion)
    }
  }
})
