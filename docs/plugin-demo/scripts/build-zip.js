/**
 * 构建脚本 — 编译插件并打包为 ZIP
 *
 * 步骤：
 * 1. tsc 编译主进程插件 (src/main.ts → dist/main.js)
 * 2. esbuild 打包渲染进程插件 (src/renderer.ts → dist/renderer.js)
 * 3. adm-zip 将 manifest.json + dist/* → plugin-demo.zip
 *
 * 产物可直接通过 Wilson Term 插件管理器导入。
 */

const AdmZip = require('adm-zip')
const { execSync } = require('child_process')
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('fs')
const { join, basename } = require('path')

const ROOT = join(__dirname, '..')
const DIST = join(ROOT, 'dist')
const MANIFEST = join(ROOT, 'manifest.json')
const PKG = join(ROOT, 'package.json')
const ZIP_OUT = join(ROOT, `${basename(ROOT)}.zip`)

function step(label, fn) {
  console.log(`[build] ${label}...`)
  fn()
}

step('清理 dist', () => {
  if (existsSync(DIST)) {
    // 简单清理：删除旧文件
    const { rmSync } = require('fs')
    rmSync(DIST, { recursive: true, force: true })
  }
  mkdirSync(DIST, { recursive: true })
})

step('编译主进程插件', () => {
  execSync('npx tsc -p tsconfig.json', { cwd: ROOT, stdio: 'inherit' })
})

step('打包渲染进程插件', () => {
  execSync(
    'npx esbuild src/renderer.ts --bundle --platform=browser --format=cjs --outfile=dist/renderer.js',
    { cwd: ROOT, stdio: 'inherit' }
  )
})

step('创建 ZIP 包', () => {
  const zip = new AdmZip()

  // 读取 manifest
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf-8'))
  const pluginId = manifest.id

  // 添加 manifest.json
  zip.addFile('manifest.json', readFileSync(MANIFEST))

  // 添加 dist 目录下的所有文件
  const { readdirSync } = require('fs')
  for (const file of readdirSync(DIST)) {
    const filePath = join(DIST, file)
    zip.addFile(file, readFileSync(filePath))
  }

  // 写入 ZIP
  zip.writeZip(ZIP_OUT)
  console.log(`[build] ZIP 包已创建: ${ZIP_OUT}`)
})

step('验证产物', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf-8'))
  const zip = new AdmZip(ZIP_OUT)
  const entries = zip.getEntries().map((e) => e.entryName).join(', ')
  console.log(`[build] 插件: ${manifest.name} v${manifest.version}`)
  console.log(`[build] ZIP 包含: ${entries}`)
})
