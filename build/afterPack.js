const fs = require('fs')
const path = require('path')

const KEEP_LOCALES = new Set(['zh-CN', 'en-US'])

function remove(p) {
  try {
    if (!fs.existsSync(p)) return
    fs.rmSync(p, { recursive: true, force: true })
    console.log(`  removed: ${path.relative(process.cwd(), p)}`)
  } catch { /* ignore */ }
}

module.exports = async function (context) {
  const appOutDir = context.appOutDir

  // 1. 只保留 zh-CN 和 en-US 语言包
  const localesDir = path.join(appOutDir, 'locales')
  if (fs.existsSync(localesDir)) {
    for (const file of fs.readdirSync(localesDir)) {
      if (!file.endsWith('.pak')) continue
      const locale = file.slice(0, -4)
      if (!KEEP_LOCALES.has(locale)) {
        remove(path.join(localesDir, file))
      }
    }
  }

  // 2. 删除不必要的 Chromium/Electron 二进制
  // vk_swiftshader.dll + icd: Vulkan 软件渲染，用默认 Angle/D3D 即可
  remove(path.join(appOutDir, 'vk_swiftshader.dll'))
  remove(path.join(appOutDir, 'vk_swiftshader_icd.json'))
  remove(path.join(appOutDir, 'vulkan-1.dll'))
  remove(path.join(appOutDir, 'LICENSES.chromium.html'))

  // 3. 删除原生模块的 build/Release 目录，确保运行时 fallback 到 prebuilds/（NAPI）
  //    npmRebuild: false 跳过了 @electron/rebuild，但 npm ci 阶段可能残留编译产物
  const unpackedModules = path.join(appOutDir, 'resources', 'app.asar.unpacked', 'node_modules')
  for (const mod of ['node-pty', '@serialport/bindings-cpp', 'serialport/@serialport/bindings-cpp']) {
    remove(path.join(unpackedModules, mod, 'build', 'Release'))
  }
}
