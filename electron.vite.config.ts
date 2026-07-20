import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json'

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
      __APP_VERSION__: JSON.stringify(pkg.version)
    }
  }
})
