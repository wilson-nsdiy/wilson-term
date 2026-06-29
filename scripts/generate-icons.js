/**
 * 图标生成脚本
 * 从 resources/icon.png 生成各平台及 UI 所需的图标文件
 */
const sharp = require('sharp');
const pngToIco = require('png-to-ico');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'resources/icon.png');
const RESOURCES = path.join(ROOT, 'resources');
const ASSETS = path.join(ROOT, 'src/renderer/src/assets');

async function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error('源图标不存在: resources/icon.png');
    process.exit(1);
  }
  console.log('正在从 resources/icon.png 生成图标文件...');

  // 缓存源图像，避免后续 resize 覆盖源文件
  const sourceBuf = fs.readFileSync(SOURCE);
  const sourceSharp = () => sharp(sourceBuf);

  // 确保输出目录存在
  if (!fs.existsSync(RESOURCES)) {
    fs.mkdirSync(RESOURCES, { recursive: true });
  }

  // 1. 生成 icon-256.png (256x256, 用于 Linux AppImage)
  console.log('生成 icon-256.png (256x256)...');
  const icon256 = path.join(RESOURCES, 'icon-256.png');
  await sourceSharp()
    .resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(icon256);
  console.log('  ✓ icon-256.png 已生成');

  // 2. 生成 icon.ico (Windows, 包含 16/32/48/64/128/256 尺寸)
  console.log('生成 icon.ico (多尺寸)...');
  const sizes = [16, 32, 48, 64, 128, 256];
  const pngBuffers = [];
  for (const size of sizes) {
    const buf = await sourceSharp()
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    pngBuffers.push(buf);
  }
  const icoBuffer = await pngToIco.default(pngBuffers);
  fs.writeFileSync(path.join(RESOURCES, 'icon.ico'), icoBuffer);
  console.log('  ✓ icon.ico 已生成');

  // 3. 生成 icon.icns (macOS)
  console.log('生成 icon.icns (macOS)...');
  await generateIcns(sourceSharp);
  console.log('  ✓ icon.icns 已生成');

  // 4. 生成 assets 目录下的图标 (用于渲染进程 UI)
  if (!fs.existsSync(ASSETS)) {
    fs.mkdirSync(ASSETS, { recursive: true });
  }

  // 4a. 生成 icon-16.png (16x16, 用于 TitleBar 1x)
  console.log('生成 assets/icon-16.png (16x16)...');
  await sourceSharp()
    .resize(16, 16, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(path.join(ASSETS, 'icon-16.png'));
  console.log('  ✓ icon-16.png 已生成');

  // 4b. 生成 icon-32.png (32x32, 用于 TitleBar 2x)
  console.log('生成 assets/icon-32.png (32x32)...');
  await sourceSharp()
    .resize(32, 32, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(path.join(ASSETS, 'icon-32.png'));
  console.log('  ✓ icon-32.png 已生成');

  // 4c. 复制源图标到 assets 作为 logo (用于 AboutDialog)
  console.log('复制 logo.png 到 assets/...');
  fs.copyFileSync(SOURCE, path.join(ASSETS, 'logo.png'));
  console.log('  ✓ logo.png 已复制');

  console.log('\n所有图标文件已生成完毕！');
}

/**
 * 生成 macOS .icns 文件
 * icns 格式由多个图标类型组成，每个类型包含不同尺寸的图像数据
 */
async function generateIcns(sourceSharp) {
  const icnsPath = path.join(RESOURCES, 'icon.icns');

  // icns 文件格式:
  // Magic: 'icns' (4 bytes)
  // File size: uint32 BE (4 bytes)
  // 然后是多个图标类型条目

  // 图标类型映射: type -> size
  const iconTypes = [
    { type: 'icp4', size: 16 },   // 16x16
    { type: 'icp5', size: 32 },   // 32x32
    { type: 'icp6', size: 64 },   // 64x64 (实际是 32x32@2x)
    { type: 'ic07', size: 128 },  // 128x128
    { type: 'ic08', size: 256 },  // 256x256
    { type: 'ic09', size: 512 },  // 512x512
    { type: 'ic10', size: 1024 }, // 1024x1024 (512x512@2x)
  ];

  const entries = [];

  for (const { type, size } of iconTypes) {
    const pngBuffer = await sourceSharp()
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    // 每个条目: type (4 bytes) + size (4 bytes, 包含 type 和 size 本身) + data
    const entrySize = 4 + 4 + pngBuffer.length;
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, 'ascii');
    header.writeUInt32BE(entrySize, 4);
    entries.push(Buffer.concat([header, pngBuffer]));
  }

  // 计算总文件大小: magic(4) + fileSize(4) + entries
  const totalSize = 4 + 4 + entries.reduce((sum, e) => sum + e.length, 0);
  const fileHeader = Buffer.alloc(8);
  fileHeader.write('icns', 0, 4, 'ascii');
  fileHeader.writeUInt32BE(totalSize, 4);

  const icnsBuffer = Buffer.concat([fileHeader, ...entries]);
  fs.writeFileSync(icnsPath, icnsBuffer);
}

main().catch(err => {
  console.error('生成图标失败:', err);
  process.exit(1);
});
