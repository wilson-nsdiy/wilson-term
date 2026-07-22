# 阶段 5 实现交接 — 字体与光栅化

> 本文件面向下一次会话的 AI 编码助手（含上下文恢复）。
> 写于 2026-07-22,会话中断在阶段 5 任务 #3 半途。

## 一、整体进度地图

参考 `docs/IMPLEMENTATION-GUIDELINE.md` 分阶段:

| 阶段 | 内容 | 状态 |
|---|---|---|
| 0 | 脚手架 — crate + vtparse fork + actor 桥接 | ✅ |
| 1.1 | VT 状态机 — CollectingVTActor + VTAction | ✅ |
| 1.2 | 序列语义层 — CSI/OSC/DCS/APC 解析器 | ✅ |
| 1.3 | 终端状态机 — modes/state/performer + screen buffer | ✅ |
| 2 | GPU 渲染层 — Atlas/AtlasList/GlyphCache + Pipeline + Shader + Sync | ✅ |
| 3 | 键盘 + 鼠标输入 — Kitty keyboard + SGR/X10/UTF8/URXVT 鼠标 | ✅ |
| 4 | VT 集成 — Performer 接入真实 Screen,端到端写入 | ✅ |
| **5** | **字体与配置 — fontdb + swash + cosmic-text + notify** | **⏳ 进行中** |
| 6 | wgpu 集成 — 实际 Device/Queue/Surface + 着色器加载 | ⏳ |
| 7 | Tauri 集成 — 窗口/Surface/数据流 | ⏳ |
| 8 | xterm.js 替换 — 前端迁移到 wgpu Surface 嵌入 | ⏳ |
| 9 | 测试与稳定化 — 集成/性能/边界/fuzz | ⏳ |
| 10 | 文档与发布 | ⏳ |

## 二、阶段 5 任务清单与中断点

```
[x] 1. 诊断 GUIDELINE 阶段 5 要求 + GlyphCache render 回调占位 + Cargo.toml swash/fontdb/cosmic-text 版本
[x] 2. renderer/font.rs — FontRequest/FontConfiguration/FontMatcher（fontdb 查找 + swash shaping 封装）
[~] 3. renderer/raster.rs — swash 光栅化器（字形 → GlyphBuffer → RGBA 位图）  ← 中断点
[ ] 4. 接入 GlyphCache render 回调：调 raster → Sprite
[ ] 5. 注册新模块 + cargo check + cargo test 全量验证
```

**任务 #3 半途具体进度**:
- ✅ 已核对 swash 0.1.19 的 `scale` 模块 API: `ScaleContext` / `ScalerBuilder` / `Scaler` / `Render` / `Image` / `Content` / `Source`
- ✅ 已在 `terminal-core/Cargo.toml` 给 swash 加 `features = ["render"]`,给 fontdb 加 `features = ["fs"]`（尚未 cargo check 验证）
- ✅ 已确认 `Render::render(scaler, glyph_id) -> Option<Image>` 是核心入口（在 `#[cfg(feature = "render")]` 下）
- ✅ 已确认 `Image { source, content, placement: Placement, data: Vec<u8> }` 是光栅化输出
- ❌ **`renderer/raster.rs` 文件尚未写** — 这是下次的起点

## 三、未提交改动清单

工作区有未提交改动（下次会话开始时用 `git status` 复核）:

### 已跟踪（modified）
- `terminal-core/Cargo.toml` — swash 加 `render` feature,fontdb 加 `fs` feature
- `terminal-core/src/lib.rs` — 注册 `pub mod keyboard; pub mod mouse;`
- `terminal-core/src/screen/mod.rs` — `Screen`/`ScreenManager` 加 derive `PartialEq, Eq`
- `terminal-core/src/state/mod.rs` — `TerminalState` 加 `screens: ScreenManager` 字段 + default 初始化
- `terminal-core/src/state/performer.rs` — 占位 print 全部接入真实 Screen（flush_print/control/csi_dispatch/esc_dispatch）+ 13 个端到端单测

### 未跟踪（new）
- `terminal-core/src/keyboard/` — mod.rs + kitty.rs（阶段 3,Kitty keyboard 编码器,443 行）
- `terminal-core/src/mouse/` — mod.rs + sgr.rs（阶段 3,SGR/X10/UTF8/URXVT 鼠标编码,321 行）
- `terminal-core/src/renderer/font.rs` — 阶段 5 任务 2,FontRequest/FontConfiguration/FontMatcher/TextShaper/OwnedFont,526 行

> 注:阶段 3 + 阶段 4 的改动也未提交。下次可考虑分两个 commit:一个阶段 3+4,一个阶段 5。

## 四、下次续接的具体步骤

### 步骤 1: 写 `renderer/raster.rs`

借鉴 wezterm `wezterm-font/src/rasterizer/mod.rs` 的光栅化流程,但用 swash 替代 fontdue。

核心流程:
1. `ScaleContext::new()` → `ctx.builder(font).size(ppem).hint(true).build()` 得到 `Scaler`
2. `Render::new(&[Source::Outline, Source::ColorOutline(0)])` 配置渲染源
3. `render.render(&mut scaler, glyph_id)` → `Option<Image>`
4. 把 `Image` 转 `RenderedGlyph`（`renderer/glyph.rs` 已定义,字段:data/width/height/bearing_x/bearing_y/advance）

**关键 API 已核对清单**（swash 0.1.19 源码路径 `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/swash-0.1.19/`）:
- `swash::scale::{ScaleContext, ScalerBuilder, Scaler, Render, Image, Content, Source}` — `src/scale/mod.rs`
- `Scaler::scale_outline(glyph_id) -> Option<Outline>` — 可选,若只走 Render 路径则不需要
- `Render::new(&[Source::Outline, Source::ColorOutline(0)])` — 多源优先级,先 outline 后 color outline
- `Render::render(scaler, glyph_id) -> Option<Image>` — `src/scale/mod.rs:963`
- `Image::placement` 是 `zeno::Placement`（left/top/width/height,i32 + u32）
- `Image::content` 是 `Content` 枚举（Mask/SubpixelMask/Color）,决定 data 是单字节 alpha 还是 RGBA
- `Image::data: Vec<u8>` — 像素数据

**建议的 raster.rs 数据结构**:
```rust
pub struct Rasterizer {
    ctx: ScaleContext,  // 可复用的 scale 缓存
}

pub struct RasterRequest<'a> {
    pub font: &'a FontRef<'a>,  // 来自 OwnedFont::font_ref()
    pub glyph_id: u16,           // 来自 ShapedGlyph::glyph_id
    pub ppem: f32,               // 来自 FontRequest::ppem()
    pub is_color: bool,          // emoji 彩色字形
}

impl Rasterizer {
    pub fn rasterize(&mut self, req: &RasterRequest) -> Option<RenderedGlyph> {
        // 1. ScalerBuilder → Scaler
        // 2. Render::new + render → Image
        // 3. Image → RenderedGlyph（注意 Mask 需扩为 RGBA,Color 已是 RGBA）
    }
}
```

**注意**: `RenderedGlyph` 在 `renderer/glyph.rs` 已定义,字段 data/width/height/bearing_x/bearing_y/advance。rasterize 输出的 `Image::data` 对于 `Content::Mask` 是单字节 alpha,需扩为 RGBA（R=G=B=255,A=alpha）或按 GlyphCache 需求处理。对于 `Content::Color` 已是 RGBA,直接用。

### 步骤 2: 接入 GlyphCache render 回调（任务 #4）

`renderer/glyph.rs` 的 `GlyphCache::get_or_load(key, render_fn)` 接收一个 `FnOnce(&GlyphKey) -> Option<RenderedGlyph>` 回调。下次需写一个适配函数把 `GlyphKey` 转 `RasterRequest`（需先把 GlyphKey.font_family 通过 FontMatcher 查成 FontRef,这要求 GlyphCache 或 render_fn 闭包持有 FontMatcher + OwnedFont 的引用）。

**设计决策点**: GlyphKey 当前持 `font_family: String`,但 swash FontRef 需要字节切片。两个方案:
- A. GlyphCache 持有 `FontMatcher` + `HashMap<String, OwnedFont>` 缓存,render_fn 内查找
- B. GlyphKey 字段改为 `font_id: ID`（fontdb 的 ID）,render_fn 接收时直接 font_ref(id)

方案 B 更干净（借鉴 wezterm）,但会改 GlyphKey 的 derive 和现有测试。下次实现时再决策。

### 步骤 3: 注册模块 + 验证（任务 #5）

- `renderer/mod.rs` 加 `pub mod font; pub mod raster;`
- `cargo check` 验证编译（swash render feature 已加,应能通过）
- `cargo test` 验证全量通过

### 步骤 4: 阶段 5.2 配置与热重载（GUIDELINE 原计划但未列入本次任务）

GUIDELINE 阶段 5 还含 `notify` 热重载 + `toml` 配置。本次任务清单未包含（聚焦 5.1 字体）。下次可补 5.2 或直接跳到阶段 6。

## 五、关键设计决策（已落地,勿推翻）

1. **swash 仅作光栅化,不用 fontdue** — GUIDELINE §5.1 明确删除 fontdue 避免双光栅化冲突
2. **fontdb 用 fs feature** — 需 `Source::File` 分支加载系统字体文件
3. **swash 用 render feature** — `Render::render` 在 `#[cfg(feature = "render")]` 下,默认 swash 不启用
4. **OwnedFont 模式** — fontdb 的 `Source::Binary` 是 `Arc<dyn AsRef<[u8]>>`,swash `FontRef` 需 `&[u8]`。OwnedFont clone 出 `Vec<u8>` 持所有权,生成 `FontRef<'_>` 借用 self.data。生产可优化为 Arc 共享避免 clone
5. **TextShaper 不直接接 cosmic-text** — 本次只用 swash `ShapeContext` 做基础 shaping。cosmic-text 的段落排版（双向/行高）推迟到需要时再接,本次避免版本耦合风险

## 六、依赖版本（已声明在 Cargo.toml,部分已 fetch 到本地 registry）

```toml
swash = { version = "0.1", features = ["render"] }  # 实际拉到 0.1.19
fontdb = { version = "0.20", features = ["fs"] }     # 实际拉到 0.20.0
cosmic-text = "0.12"                                  # 0.12.1,本次未用
notify = "7"                                          # 本次未用
toml = "0.8"                                          # 本次未用
```

本地 registry 路径（方便下次读源码核对 API）:
- `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/swash-0.1.19/`
- `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/fontdb-0.20.0/`
- `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cosmic-text-0.12.1/`

## 七、测试基线

上次完整跑通的状态（阶段 4 结束时）:
- `cargo check` ✅ 无错误（3 个既有 warning 非新增）
- `cargo test` ✅ **218 passed / 0 failed**

阶段 5 新增的 `renderer/font.rs` 已写 13 个单测,但因 `raster.rs` 未写、模块未注册,尚未跑通验证。下次完成步骤 1-3 后应恢复到全绿。

## 八、Git 提交约定（用户偏好,勿违反）

- 创建 git commit 时**禁止添加任何署名 trailer**（包括 "Co-Authored-By: ..." 和 "Generated with ..." 等）
- 提交信息只包含对变更的描述,不追加任何 AtomCode/模型署名行
- 仅在用户明确要求时才提交

## 九、下次开场建议

1. 先 `git status` + `cargo check` 确认工作区状态与上次一致
2. 读本交接文档的「四、下次续接的具体步骤」
3. 从步骤 1（写 `renderer/raster.rs`）直接开始 —— 所有 API 已核对,无需重新调研
4. 完成后跑 `cargo test` 恢复全绿
5. 问用户是否要提交（阶段 3+4+5 可分 commit 或合一个）
