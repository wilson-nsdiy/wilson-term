/**
 * Apply xterm.js patches for bugs not yet in v5.5.0.
 *
 * PR #6004: UTF-8 0x80 continuation byte silently dropped in Utf8ToUtf32 decoder.
 * PR #6019: Mouse listeners bound to stale document when terminal moves to another window.
 * PR #5994: addon-search highlight-all scan skips/duplicates wide character matches.
 * PR #5992: clear() early return at cursor home skips clearAllMarkers and scrollback cleanup.
 * PR #5971: parseInt calls missing explicit radix parameter.
 * PR #5984: addon-search startCol boundary check + addon-web-links duplicate global flag.
 *
 * Run via: node scripts/patch-xterm.js
 * Or automatically via postinstall.
 */
const fs = require('fs');
const path = require('path');

const XTERM_DIR = path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm');

if (!fs.existsSync(XTERM_DIR)) {
  console.error('Error: @xterm/xterm not found. Run npm install first.');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(XTERM_DIR, 'package.json'), 'utf8'));
if (pkg.version !== '5.5.0') {
  console.warn(`Warning: Expected @xterm/xterm@5.5.0, found v${pkg.version}. Patches may not apply.`);
}

let patched = 0;

function patchFile(relPath, replacements) {
  const filePath = path.join(XTERM_DIR, relPath);
  if (!fs.existsSync(filePath)) return;
  let content = fs.readFileSync(filePath, 'utf8');
  let changed = false;
  for (const [search, replace] of replacements) {
    if (content.includes(search)) {
      content = content.replace(search, replace);
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(filePath, content);
    patched++;
    console.log(`  Patched: ${relPath}`);
  }
}

// === PR #6004: Fix UTF-8 0x80 continuation byte bug ===
patchFile('src/common/input/TextDecoder.ts', [
  [
    'while ((tmp = this.interim[++pos] & 0x3F) && pos < 4) {\n        cp <<= 6;\n        cp |= tmp;\n      }',
    'while ((tmp = this.interim[++pos]) && pos < 4) {\n        cp <<= 6;\n        cp |= tmp & 0x3F;\n      }'
  ]
]);

patchFile('lib/xterm.js', [
  ['for(;(n=63&this.interim[++o])&&o<4;)r<<=6,r|=n;', 'for(;(n=this.interim[++o])&&o<4;)r<<=6,r|=63&n;']
]);

// === PR #6019: Fix mouse listeners bound to stale document ===
patchFile('lib/xterm.js', [
  ['e.buttons||(this._document.removeEventListener("mouseup",s.mouseup),s.mousedrag&&this._document.removeEventListener("mousemove",s.mousedrag))',
   'e.buttons||((this.element?.ownerDocument||this._document).removeEventListener("mouseup",s.mouseup),s.mousedrag&&(this.element?.ownerDocument||this._document).removeEventListener("mousemove",s.mousedrag))'],
  ['(this._document.removeEventListener("mouseup",s.mouseup),s.mouseup=null)',
   '((this.element?.ownerDocument||this._document).removeEventListener("mouseup",s.mouseup),s.mouseup=null)'],
  ['(this._document.removeEventListener("mousemove",s.mousedrag),s.mousedrag=null)',
   '((this.element?.ownerDocument||this._document).removeEventListener("mousemove",s.mousedrag),s.mousedrag=null)'],
  ['s.mouseup&&this._document.addEventListener("mouseup",s.mouseup)',
   's.mouseup&&(this.element?.ownerDocument||this._document).addEventListener("mouseup",s.mouseup)'],
  ['s.mousedrag&&this._document.addEventListener("mousemove",s.mousedrag)',
   's.mousedrag&&(this.element?.ownerDocument||this._document).addEventListener("mousemove",s.mousedrag)']
]);

// === PR #5994: Fix addon-search highlight-all scan using size instead of term.length ===
patchFile('../addon-search/lib/addon-search.js', [
  ['r=this._find(e,s.col+s.term.length>=this._terminal.cols?s.row+1:s.row,s.col+s.term.length>=this._terminal.cols?0:s.col+1,t)',
   '(()=>{const c=this._terminal.cols;let n=s.col+s.size,r=s.row;if(n>=c){r+=Math.floor(n/c);n%=c}return r=this._find(e,r,n,t)})()']
]);

// === PR #5992: Remove clear() early return at cursor home ===
patchFile('lib/xterm.js', [
  ['clear(){if(0!==this.buffer.ybase||0!==this.buffer.y){this.buffer.clearAllMarkers()',
   'clear(){this.buffer.clearAllMarkers()'],
  ['this.refresh(0,this.rows-1)}}reset()', 'this.refresh(0,this.rows-1)}reset()']
]);

// === PR #5971: Add explicit radix to parseInt calls ===
// addon-fit
patchFile('../addon-fit/lib/addon-fit.js', [
  ['parseInt(i.getPropertyValue("height"))', 'parseInt(i.getPropertyValue("height"),10)||0'],
  ['parseInt(i.getPropertyValue("width"))', 'Math.max(0,parseInt(i.getPropertyValue("width"),10)||0)'],
  ['parseInt(n.getPropertyValue("padding-top"))', 'parseInt(n.getPropertyValue("padding-top"),10)||0'],
  ['parseInt(n.getPropertyValue("padding-bottom"))', 'parseInt(n.getPropertyValue("padding-bottom"),10)||0'],
  ['parseInt(n.getPropertyValue("padding-right"))', 'parseInt(n.getPropertyValue("padding-right"),10)||0'],
  ['parseInt(n.getPropertyValue("padding-left"))', 'parseInt(n.getPropertyValue("padding-left"),10)||0']
]);

// core xterm.js
patchFile('lib/xterm.js', [
  ['parseInt(r.getPropertyValue("padding-left"))', 'parseInt(r.getPropertyValue("padding-left"),10)'],
  ['parseInt(r.getPropertyValue("padding-top"))', 'parseInt(r.getPropertyValue("padding-top"),10)'],
  ['parseInt(majorVersion[1])', 'parseInt(majorVersion[1],10)'],
  ['parseInt(rgbaMatch[1])', 'parseInt(rgbaMatch[1],10)'],
  ['parseInt(rgbaMatch[2])', 'parseInt(rgbaMatch[2],10)'],
  ['parseInt(rgbaMatch[3])', 'parseInt(rgbaMatch[3],10)'],
  ['parseInt(chromeVersionMatch[1])', 'parseInt(chromeVersionMatch[1],10)'],
  ['parseInt(e.slice(1))', 'parseInt(e.slice(1),10)'],
  ['parseInt(h[1])', 'parseInt(h[1],10)'],
  ['parseInt(h[2])', 'parseInt(h[2],10)'],
  ['parseInt(h[3])', 'parseInt(h[3],10)'],
  ['parseInt(e)', 'parseInt(e,10)'],
  ['parseInt(i[e])', 'parseInt(i[e],10)'],
  ['parseInt(e[1])', 'parseInt(e[1],10)']
]);

// === PR #5984: Fix addon-search bounds + addon-web-links regex ===
// addon-search: startCol >= cols
patchFile('../addon-search/lib/addon-search.js', [
  ['i>this._terminal.cols)throw new Error', 'i>=this._terminal.cols)throw new Error']
]);

// addon-web-links: prevent duplicate global flag
patchFile('../addon-web-links/lib/addon-web-links.js', [
  ['new RegExp(t.source,(t.flags||"")+"g")',
   '(()=>{const f=t.flags.includes("g")?t.flags:t.flags+"g";return new RegExp(t.source,f)})()']
]);

// === Dispose 时序缺陷: RenderService.dimensions getter 在 renderer 已 dispose 后抛错 ===
// xterm 5.5.0 的 Viewport 构造时排了一个裸 setTimeout(() => this.syncScrollArea())（Viewport.ts:84），
// 该 setTimeout 未注册到 disposable，dispose 时不会清理。而 Terminal.dispose() 按注册逆序
// 先 dispose viewport、后 dispose _renderService（清空 _renderer.value）。若该 setTimeout 在
// _renderService 被 dispose 之后才触发，syncScrollArea → this._renderService.dimensions →
// getter `return this._renderer.value!.dimensions` 会因 _renderer.value 为 undefined 抛
// `Cannot read properties of undefined (reading 'dimensions')`，且无 try/catch → Uncaught。
// 触发场景：标签页快速切换/关闭导致 TerminalInstance 卸载、xterm.open 后不久即 dispose。
// 修复：getter 在 renderer 为空时返回零值 dimensions 对象，让所有消费者（Viewport /
// AccessibilityManager / BufferDecorationRenderer / CompositionHelper）在 dispose 后拿到 0
// 尺寸安全短路，而非抛 Uncaught。零值结构与 createRenderDimensions() 一致。
// 同时打 src 与 lib，保持源码可读与运行时生效一致（与 PR #6004 的双打模式相同）。
patchFile('src/browser/services/RenderService.ts', [
  ['public get dimensions(): IRenderDimensions { return this._renderer.value!.dimensions; }',
   'public get dimensions(): IRenderDimensions { return this._renderer.value ? this._renderer.value.dimensions : { css: { canvas: { width: 0, height: 0 }, cell: { width: 0, height: 0 } }, device: { canvas: { width: 0, height: 0 }, cell: { width: 0, height: 0 }, char: { width: 0, height: 0, left: 0, top: 0 } } }; }']
]);
patchFile('lib/xterm.js', [
  ['get dimensions(){return this._renderer.value.dimensions}',
   'get dimensions(){return this._renderer.value?this._renderer.value.dimensions:{css:{canvas:{width:0,height:0},cell:{width:0,height:0}},device:{canvas:{width:0,height:0},cell:{width:0,height:0},char:{width:0,height:0,left:0,top:0}}}}']
]);

if (patched === 0) {
  console.log('No patches applied (already patched or files changed).');
} else {
  console.log(`Done. ${patched} file(s) patched.`);
}
