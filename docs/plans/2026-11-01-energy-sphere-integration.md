# dsh-energy-orb：渲染体换成 energy-sphere-demo（实现计划）

**Goal:** 把用户已定稿的 `apps/energy-sphere-demo`（AETHER // Energy Core）作为插件**唯一渲染体**，
撤掉被判不可用的自研 `orb-renderer`，并保留既有 Host 状态链与降级/显示偏好能力。

**Architecture:** demo 的三个 ES module 与 `three@0.180.0` 闭包由 `scripts/vendor-sphere.mjs`
遍历 import 图 vendored 进 `client/`，说明符全量改写为相对 URL；Host 用**精确白名单**资产路由
服务它们；`OrbClient` 负责「状态契约 → 球体参数（含 420ms 插值）」并保留 CSS 降级球。

**Tech Stack:** 纯 ESM（无构建步）、`three@0.180.0`（vendored + 1 个本地补丁）、node:test、playwright-core 浏览器验证。

**Spec:** [`docs/design.md`](../design.md)（形状）、[`docs/adr/0005`](../adr/0005-energy-sphere-integration.md)（决策）、
验收 [`2026-11-01-energy-sphere-integration-acceptance.md`](2026-11-01-energy-sphere-integration-acceptance.md)。

## Global Constraints

- 不改上游（`deepseek-ai`）一行；不改 demo 源码——视觉真相在 `apps/energy-sphere-demo`，插件的副本由其生成。
- `client/sphere/**` 与 `client/vendor/**` **只由** `scripts/vendor-sphere.mjs` 产出；手改由 sha256 测试拦下。
- 状态契约逐字：`EnergyOrbState = { version: 1, active, intensity, phase, updatedAt }`；路由 `GET /api/energy-orb/state` 只此一条。
- 资产路由只放行**精确白名单**（15 项），白名单必须与 `client/vendor/manifest.json` 一致；
  越界/未知名 → 404；非 loopback → `403 forbidden: loopback-only`。
- 降级不变：渲染体加载失败或 WebGL 不可用 → CSS 降级球（可见、跟踪状态）、`warn` 恰一次、不炸页。
- 显示偏好只住 localStorage `energy-orb.display`；cordis Config 只有 `enabled`。
- 旧渲染体产物（`client/orb-renderer.js`、`docs/mockups/*`、旧三态截图）**删除**，不留兼容层。

## Tasks

### T1 vendor 生成器（闭包遍历 + 补丁 + manifest）

**Interfaces:**
- Consumes: `apps/energy-sphere-demo/src/*.js`、`node_modules/three/build/*`、`three/examples/jsm/**`
- Produces: `client/sphere/{energy-sphere,animation,options}.js`、`client/vendor/**`、`client/vendor/manifest.json`（含 sha256 与 patches）、`--check` 自检模式

- [x] 按 import 图 BFS 遍历（不手抄清单）；不改写则不落盘
- [x] 裸说明符全量改写为相对 URL；残留裸说明符 → 报错退出
- [x] 两条补丁（`transparent-alpha-pass` / `-wire`），`find` 必须恰好命中一次
- [x] `manifest.json` 记录来源、版本、字节数、sha256、补丁清单

### T2 资产路由精确白名单

**Interfaces:**
- Consumes: `client/**` 下的 vendored 文件、`isLoopbackRequest/FORBIDDEN_BODY`
- Produces: `ALLOWED_ASSETS`（15 项）、`assetKeyFromUrl()`、`registerAssetRoute(ctx, packageDir)`

- [x] 精确集合（非目录放行）+ realpath 包含性 + 20MB 上限 + 405/HEAD
- [x] 与 manifest 交叉校验（测试里两侧比对，任一漂移即红）

### T3 Client 换装

**Interfaces:**
- Consumes: `GET /api/energy-orb/state`、`import('/energy-orb/assets/sphere/energy-sphere.js')`
- Produces: `stateToSphereOptions(state, now, {reducedMotion,warn})`、`smoothOptions(current, target, alpha, progress)`、
  `OrbComponent`（`shell.overlay`，`data-dsh-energy-orb-root` / `-stage` / `-fallback`）

- [x] 静息 = 核心 0.82× / 辉光 0.5 / **心跳关闭**；激活 = 1.08× / 1.3 / `bpm 64+48·intensity`
- [x] 420ms 指数插值（进度过半切心跳与颜色，到时限补齐）
- [x] canvas CSS 拉伸（`setSize(...,false)` 不写 style，DPR2 会溢出）
- [x] 纯点击 `pulse(1.2)`；拖拽写回 offset；`reducedMotion` 归零运动量
- [x] 失败路径：模块加载失败 / `onError` → CSS 降级球 + warn 恰一次

### T4 测试收口

**Interfaces:**
- Consumes: T1–T3 产物
- Produces: `test/{sphere,sphere-mapping,vendor,degrade,state-route,client-wiring,host-wiring,projector,manifest}.test.mjs`

- [x] 删 `test/orb-math.test.mjs`；移植 demo 的几何/心跳/参数契约测试（`test/sphere.test.mjs`）
- [x] 映射表测试：静息/激活/陈旧/畸形/error/reducedMotion + 每个目标都过 `normalizeOptions`
- [x] vendor 完整性：sha256、无游离文件、无裸说明符、白名单一致、补丁落地
- [x] 降级/拖拽/生命周期测试改用真组件 + 模块桩（含 `dispose` 恰一次）

### T5 浏览器验证（真资产路由）

**Interfaces:**
- Consumes: `registerAssetRoute` + `registerStateRoute`（真 handler 起 loopback 服务器）
- Produces: `scripts/fixture/{visual,lifecycle,overlay}.html`、`scripts/verify-visual.mjs`、`docs/verify/*.png`

- [x] 四态渲染（静息/激活定格/运行中/脉冲基线）+ 真 WebGL 像素判据（非 toDataURL）
- [x] 动效断言：运行中两帧不同、paused 两帧相同、脉冲后核心变亮、paused 时 update 立即重绘
- [x] 生命周期 1/0/1/0 + 真 canvas（不是降级球）
- [x] 悬浮层真尺寸：192×192 贴右下角、静息→激活（真轮询+ramp）、四角 alpha=0

### T6 文档与对照物

**Interfaces:**
- Consumes: T1–T5
- Produces: `docs/design.md`、`docs/adr/0005-*.md`、`docs/reference/energy-sphere-preview.png`、README、locale

- [x] 设计文档换渲染体（组件表/接口/状态→参数表/错误模型/接缝与取舍）
- [x] ADR-0005（含「错了的代价」）；旧计划与旧验收标注 superseded
- [x] README 架构、验证命令、License（vendored three MIT）更新
- [x] locale 中英文案与新视觉一致

### T7 装载与实机核对

**Interfaces:**
- Consumes: 已装（link 方式）到 fly profile 的插件目录、运行中的 `dsh web`
- Produces: `plugin_manager` 行状态、`verify-live` 输出、用户实机截图

- [ ] 重启 `dsh web`（引擎把 client 包缓存在进程内；刷新页面不够）
- [ ] `plugin_manager list_plugins` 中本插件 `fiberPhase: active`
- [ ] `node scripts/verify-live.mjs http://127.0.0.1:<port>`：A2/A2b/A3 全绿（状态路由 + 15 个资产 + 围栏）
- [ ] 用户在真机确认：球=网络球+HUD 环、静息缩小心跳关闭、激活心跳、不挡视线、无方块底

## Review Focus

- **透明画布补丁是否被误删/误改**：`test/vendor.test.mjs` 钉 manifest.patches 与 shader 文本；浏览器再钉四角 alpha=0。
- **白名单漂移**：加 vendor 文件忘改路由 → 测试红（两份列表比对）。
- **映射表越界**：任何新参数若超 `normalizeOptions` 范围，`test/sphere-mapping.test.mjs` 立即 RangeError。
- **降级路径**：`degrade.test.mjs` 用真组件 + 模块桩，覆盖「加载失败」「onError」「拖拽方向」「dispose 恰一次」。
- **不许留旧渲染体引用**：`grep -r orb-renderer` 必须为空（README/测试/脚本全查）。
