#!/usr/bin/env node

/**
 * CI 预发布版本号注入
 *
 * 当 git tag 为预发布版本（含 -alpha / -beta 等后缀）时，
 * 将 package.json 的 version 改为 tag 对应的完整版本号，
 * 使 electron-builder 产物名、app.getVersion() 与 release 说明三者一致。
 *
 * 用法（在 CI 中）：TAG=v0.9.9-alpha.1 node scripts/set-prerelease-version.js
 */

const fs = require('fs');
const path = require('path');

const TAG = process.env.TAG;
if (!TAG) {
  console.error('::error::Missing TAG env var');
  process.exit(1);
}

const version = TAG.replace(/^v/, ''); // 0.9.9-alpha.1
const base = version.split('-')[0]; // 0.9.9
const isPrerelease = version !== base; // 含预发布后缀

const PKG_PATH = path.resolve(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf-8'));

if (!isPrerelease) {
  console.log(`Stable tag '${TAG}', keep package.json version: ${pkg.version}`);
  process.exit(0);
}

console.log(`Set package.json version: ${pkg.version} -> ${version}`);
pkg.version = version;
fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
console.log(`Done. Prerelease version injected: ${version}`);
