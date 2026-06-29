#!/usr/bin/env node

/**
 * Beta 打包脚本
 *
 * 用法：
 *   node scripts/package-beta.js
 *
 * 版本号规则：
 *   基于 package.json 中的基础版本 + git 短 commit hash
 *   例如 package.json 版本 0.5.11，commit a341ed2 → 0.5.11-beta.a341ed2
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');

function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: ROOT });
}

function runQuiet(cmd) {
  return execSync(cmd, { encoding: 'utf-8', cwd: ROOT }).trim();
}

function readPkg() {
  return JSON.parse(fs.readFileSync(PKG_PATH, 'utf-8'));
}

function writePkg(pkg) {
  fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
}

// 1. 读取基础版本
const pkg = readPkg();
const baseVersion = pkg.version.replace(/-beta\.\w+$/, '');
console.log(`基础版本: ${baseVersion}`);

// 2. 从 git 获取短 commit hash
let shortHash;
try {
  shortHash = runQuiet('git rev-parse --short HEAD');
} catch {
  console.error('无法获取 git commit hash，请确保在 git 仓库中运行');
  process.exit(1);
}

const betaVersion = `${baseVersion}-beta.${shortHash}`;
console.log(`Beta 版本: ${betaVersion} (commit ${shortHash})`);

// 3. 更新 package.json
pkg.version = betaVersion;
writePkg(pkg);

// 4. 构建 & 打包
try {
  run('electron-vite build');
  run(`electron-builder --config.extraMetadata.version=${betaVersion}`);
  console.log(`\n✓ Beta 打包完成: v${betaVersion}`);
} catch (e) {
  // 打包失败时恢复版本号
  pkg.version = baseVersion;
  writePkg(pkg);
  console.error(`\n✗ 打包失败，已恢复版本号为 ${baseVersion}`);
  process.exit(1);
}

// 5. 打包成功后恢复 package.json，避免提交 beta 版本号
pkg.version = baseVersion;
writePkg(pkg);
console.log(`已恢复 package.json 版本号为 ${baseVersion}`);
