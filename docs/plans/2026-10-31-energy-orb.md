# dsh-energy-orb 实现计划

> **给执行者：** 按任务逐个实现本计划，步骤用复选框（`- [ ]`）跟踪；
> 执行方式见文末 Execution Handoff。

**Goal:** 造出 DSH Web GUI 的 Web3D 能量球插件（独立 cordis bundle）：会话静息时球收缩、激活时心搏涨缩，视觉以 `docs/mockups/*.png` 为对照物。

**Architecture:** Host 半边把 `'api-session/status'` 事件折叠成 `EnergyOrbState` 并经 loopback-only 路由 `GET /api/energy-orb/state` 暴露；Client 半边挂 `shell.overlay`，2s 轮询 + 客户端插值，Three.js 渲染五层（球核/球面疏网/边缘点带/HUD 环/粒子）+ 两条倾斜轨道环。

**Tech Stack:** 纯 ESM JavaScript（无构建步）、Three.js（vendored `three.module.min.js`，动态 import 懒加载）、node:test 单测、playwright-core 视觉验证（devDependency）。

**Spec:** [`docs/design.md`](../design.md)（形状五问）+ [`docs/adr/0001`](../adr/0001-render-stack.md)/[`0002`](../adr/0002-state-channel.md)/[`0003`](../adr/0003-display-prefs-storage.md)/[`0004`](../adr/0004-maintain-threejs.md)；验收契约 [`2026-10-31-energy-orb-acceptance.md`](2026-10-31-energy-orb-acceptance.md)。

## Global Constraints

- 不改上游（`deepseek-ai` 包）一行；产物是独立 bundle（`dsh-energy-orb`），走 `plugin_manager install_bundle` 装载。
- 状态契约逐字：`EnergyOrbState = { version: 1, active: boolean, intensity: number, phase: 'idle' | 'active' | 'error', updatedAt: number }`；`intensity ∈ [0,1]`，v1 恒为 `active ? 1 : 0`。
- 唯一业务路由 `GET /api/energy-orb/state`；loopback-only 围栏（loopback socket + Host 头 + same-origin markers），未配对请求在读到任何状态字节前一律 `403 forbidden: loopback-only`。
- 挂载点只有 `shell.overlay`（root 级）；**禁止** `document.body` 挂载、禁止读上游 DOM/样式（扫描杠与本球是 `'api-session/status'` 的两个平行消费者）。
- 显示偏好 `OrbDisplayConfig = { visible: boolean, size: number(32..256), anchor: 'bottom-right'|'bottom-left', offset: {x,y} }` 住 localStorage 键 `energy-orb.display`（单通道，禁止 host/client 双持久化）；cordis Config 只有 `enabled`（boolean，默认 `true`）。
- 轮询 2s；连续失败退避至 10s；状态 `updatedAt` 距今 > 10s 视为陈旧 → 按 `idle` 呈现。
- 动效常量（渲染器内部，不开放配置）：idle 缩放 0.6×/辉光 0.3/10s 慢呼吸；active 0.9↔1.1× 心搏（攻起 ≈120ms、舒张 ≈480ms、基线 ≈60 BPM，`intensity` 线性提频 60→120）；`error` 预留红移；状态切换指数平滑 τ≈300ms，禁止硬切。
- 密度规则（防密集恐惧，硬约束）：球面疏网 ≈42 点、球核 ≥18 点、边缘点带 ≈72 粒；3D 化 = 透视系数 `1+z·0.16` + 连续深度渐变 + 定向光（左上前）+ 2 条倾斜轨道环（前弧亮/后弧暗）。
- `prefers-reduced-motion`：取消缩放动画，只留辉光/透明度呼吸。
- 视觉对照物是 `docs/mockups/orb-idle.png` / `orb-active.png` / `orb-closeups.png`——判「对不对」用它们，不用「和上一次比」。
- 接口微调备案：`createOrb(canvas, opts)` 的 `opts` 增加 `THREE`（由 OrbClient 懒加载后注入，避免渲染器自持 vendor 依赖）；`OrbHandle { setState, setConfig, dispose }` 契约不变。
- 新仓提交：conventional + 中文主题；`git commit -F - <<'MSG'`（防反引号执行）；**push / 发版一律等用户点头**。

## Review Focus

1. **Host 重启 / 状态陈旧**：球必须 ≤10s 内降为静息，stale 的 active 不许永远跳 —— Task 4 的 `isStale`/`stateToTargets` 测试 + 验收 A4。
2. **未配对 LAN 客户端直连状态路由**：403 且响应体不含任何状态字段 —— Task 3 的 fence 测试 + 验收 A3。
3. **Three.js vendor 加载失败 / WebGL 丢上下文**：换 CSS 降级球，页面不白屏、不冒未捕获异常 —— Task 7 的降级测试 + 验收 A6。
4. **插件卸载 / HMR 重注入**：任意时刻恰好一个 `[data-dsh-energy-orb-root]`，rAF 停、WebGL 资源释放、`dispose()` 幂等 —— Task 7 的生命周期测试 + 验收 A7。
5. **状态快速翻转与畸形输入**：工具连发时插值平滑不硬切；畸形/越界 state 一律 clamp + 恰一次 warn —— Task 4 的 clamp/平滑测试 + 验收 A5/A10。

---

### Task 1: 仓库骨架 + bundle manifest + 空 apply + 显示资源

**Files:**
- Create: `package.json`、`cordis.patch.yml`、`index.js`、`locale/en.json`、`locale/zh.json`、`icon.svg`
- Test: `test/manifest.test.mjs`

**Interfaces:**
- Consumes: cordis decoration 模板（`package.json` 的 `dsh.bundle.patch`/`dsh.client` 结构、`index.js` 的 `export function apply() {}` 形状）。
- Produces: `apply()` 空实现（后续任务填充）；bundle 行 `id: dsh-energy-orb`、`name: dsh-energy-orb`；`dsh.client = { platform: 'web', immediately: true, inject: [] }`。

- [ ] **Step 1: 写失败测试** `test/manifest.test.mjs`：读 `package.json` 断言 `name === 'dsh-energy-orb'`、`dsh.bundle.patch === './cordis.patch.yml'`、`dsh.client.platform === 'web'`、exports 含 `.`/`./client`/`./icon`；读 `cordis.patch.yml` 断言含 `id: dsh-energy-orb`。
- [ ] **Step 2: 跑测试、确认失败** Run: `node --test test/manifest.test.mjs` Expected: FAIL（文件不存在）。
- [ ] **Step 3: 按模板写六个文件**：`index.js` 仅 `export function apply() {}`；locale 写有意义的中英标题/描述（能量球 / Energy Orb，一句话职责）；`icon.svg` 自绘（同心环 + 球核的原创图形，不抄第三方素材）。
- [ ] **Step 4: 跑测试、确认通过 + 语法检查** Run: `node --test test/manifest.test.mjs && node --check index.js` Expected: 全 PASS。
- [ ] **Step 5: 装载冒烟** `plugin_manager install_bundle`（target = 本包绝对目录）→ 读结果的 `application` 与 `warnings`；Expected: `application: applied`、无 error 级 warning。
- [ ] **Step 6: 提交** `git commit -F - <<'MSG'`（feat: 能量球插件骨架）。

### Task 2: ActivityProjector（Host 折叠逻辑）

**Files:**
- Create: `host/projector.js`
- Test: `test/projector.test.mjs`

**Interfaces:**
- Consumes: 事件签名 `'api-session/status'(sessionId: SessionId, running: boolean)`。
- Produces: `createProjector() → { noteStatus(sessionId: string, running: boolean): void, snapshot(): EnergyOrbState }`——`snapshot()` 同步纯读，每次返回新对象；`active` = running 会话数 > 0；`intensity = active ? 1 : 0`；`phase = active ? 'active' : 'idle'`（`'error'` v1 预留，不产出）；`updatedAt` = 最近一次 `noteStatus` 的 epoch ms。

- [ ] **Step 1: 写失败测试**：单会话 running→active；两会话其一停→仍 active；全停→idle/intensity 0；重复 `noteStatus` 同值幂等（active 不变）；`updatedAt` 随每次 noteStatus 前进（用注入时钟）。
- [ ] **Step 2: 跑测试、确认失败** Run: `node --test test/projector.test.mjs` Expected: FAIL（模块不存在）。
- [ ] **Step 3: 实现 `createProjector(now = () => Date.now())`**（时钟可注入是测试缝）。
- [ ] **Step 4: 跑测试、确认通过。**
- [ ] **Step 5: 提交。**

### Task 3: 状态路由 + loopback 围栏 + 资产路由

**Files:**
- Create: `host/state-route.js`、`host/asset-route.js`
- Test: `test/state-route.test.mjs`

**Interfaces:**
- Consumes: `createProjector()`（Task 2）；host Service `webServer.register(route: WebRoute)`——**Step 0 先 `cordis_inspect_query(host, Service, webServer)` 取 `WebRoute`/handler 的精确形状再写**。
- Produces:
  - `registerStateRoute(ctx, projector): () => void`——挂 `GET /api/energy-orb/state`；通过围栏 → `200` + `projector.snapshot()` 的 JSON；未通过 → `403`、body 精确为 `forbidden: loopback-only`。
  - `registerAssetRoute(ctx): () => void`——挂 `GET /energy-orb/assets/<file>`，只服务包内 `client/orb-renderer.js` 与 `client/vendor/three.module.min.js`（白名单 + realpath 包含性检查，越界 404；超 20MB 413）。
  - `isLoopbackRequest(req): boolean`——socket 远端 ∈ {127.0.0.1, ::1} 且 Host 头为 loopback 主机 且（`Sec-Fetch-Site` 缺失或 `same-origin`）。

- [ ] **Step 0: 查 `WebRoute` 契约** Run: `cordis_inspect_query`（host/Service/webServer）；Expected: 拿到 `register` 与 handler 的精确签名，据此实现。
- [ ] **Step 1: 写失败测试**：loopback + 同源 → 200 且 body 含 `version:1` 与 `updatedAt`；远端 192.168.1.9 → 403 且 body === `forbidden: loopback-only` 且不含 `active` 字段；Host 头为外部主机名 → 403；`Sec-Fetch-Site: cross-site` → 403；资产路由白名单外文件 → 404；`../../etc/passwd` 形态路径 → 404。
- [ ] **Step 2: 跑测试、确认失败。**
- [ ] **Step 3: 实现两个模块**（fence 判定在任何状态读取之前；错误文案逐字）。
- [ ] **Step 4: 跑测试、确认通过。**
- [ ] **Step 5: 提交。**

### Task 4: 渲染器纯逻辑（数学缝：状态→目标参数 / 心搏 / 点阵 / clamp）

**Files:**
- Create: `client/orb-renderer.js`（本任务只写纯函数导出，Three.js 绘制留 Task 6）
- Test: `test/orb-math.test.mjs`

**Interfaces:**
- Consumes: `EnergyOrbState`（Global Constraints 的逐字形状）。
- Produces（`client/orb-renderer.js` 的 ESM 导出，Task 6/7 追加绘制与 `createOrb`）:
  - `stateToTargets(state: EnergyOrbState, nowMs: number): { scale: number, glow: number, particles: number, ringSpeed: number, phase: 'idle'|'active'|'error' }`——陈旧（`nowMs - updatedAt > 10_000`）或畸形输入时输出 idle 目标 `{ scale: 0.6, glow: 0.3, particles: 0.18, ringSpeed: 0.35 }`；active 目标基线 `{ scale: 1.0, glow: 0.8, particles: 1.0, ringSpeed: 1.2 }`（心搏在绘制层叠加）。
  - `heartbeatScale(tMs: number, intensity: number): number`——周期 `60_000 / (60 + 60*intensity)`；攻起 ≈120ms 内 0.9→1.1，随后 ≈480ms 指数回落至 0.9，间歇期保持 0.9。
  - `buildSphere(): { points: [number,number,number][], edges: [number,number,number][] }`——Fibonacci 42 点（单位球面）、近邻边（唯一、无自环）；`buildCore(): points` 18 点（半径 0.08–0.46 球内）；`buildRim(): { angle, radius, alpha }[]` 72 粒（半径 0.77–1.05R，外密内疏）。
  - `normalizePrefs(raw: unknown): OrbDisplayConfig`——缺失/越界补默认并 clamp（size 32..256，offset 视口内，anchor 枚举外回落 `bottom-right`）。

- [ ] **Step 1: 写失败测试**：陈旧状态 → idle 目标；`intensity: 9`/`active: 'yes'`/`version: 0` → 输出 clamp 且恰好一次 `console.warn`（stub 计数）；`heartbeatScale(120, 0) ≥ 1.05`、`heartbeatScale(600, 0) ≤ 0.92`、攻起段单调升/舒张段单调降（采样断言）；`buildSphere()` 点数 42、每点模长 ≈1、边唯一无自环；`buildRim()` 恰 72 粒且半径 ∈ [0.77, 1.05]。
- [ ] **Step 2: 跑测试、确认失败。**
- [ ] **Step 3: 实现四个纯函数**（无 DOM、无 THREE 引用，模块导入即安全）。
- [ ] **Step 4: 跑测试、确认通过。**
- [ ] **Step 5: 提交。**

### Task 5: OrbClient 装配（shell.overlay + 轮询 + 偏好 + 拖拽）

**Files:**
- Create: `client.js`
- Test: `test/client-wiring.test.mjs`

**Interfaces:**
- Consumes: `client/orb-renderer.js`（Task 4 的纯函数 + Task 6 的 `createOrb`，经 `import('/energy-orb/assets/orb-renderer.js')` 动态加载）；host 路由 `GET /api/energy-orb/state`（Task 3）。
- Produces: `window.__ModuleLoader__.load({ id: 'dsh-energy-orb', factory(require) })` → `{ inject: ['slots'], apply(ctx), __testables: { pollOnce, loadPrefs, savePrefs } }`；`apply(ctx)` 中 `ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-energy-orb', order: 10 }, Component))`；轮询 2s、失败退避 10s、陈旧降级走 `stateToTargets`；拖拽改 `offset` 存 localStorage `energy-orb.display`；点击「充能」只触发本地视觉脉冲。

- [ ] **Step 1: 写失败测试**（fake ctx + fake fetch + fake renderer）：`apply` 后 `register` 收到 `shell.overlay` 与 `id: 'dsh-energy-orb'`；连续两次 fetch 失败后轮询间隔从 2s 退避到 10s；成功恢复回 2s；`savePrefs→loadPrefs` round-trip 相等；越界 size 被 clamp。
- [ ] **Step 2: 跑测试、确认失败。**
- [ ] **Step 3: 实现 `client.js`**（组件渲染一个 `[data-dsh-energy-orb-root]` 容器 + canvas；样式类名全部带 `energyOrb` 前缀；文案走 `ctx.locale`）。
- [ ] **Step 4: 跑测试、确认通过。**
- [ ] **Step 5: 提交。**

### Task 6: OrbRenderer（Three.js 五层 + 3D 化，向对照图对齐）

**Files:**
- Modify: `client/orb-renderer.js`（追加 `createOrb`）
- Create: `client/vendor/three.module.min.js`（从 pinned `three` 包的 `build/` 拷入，`vendor/README` 记版本与许可）、`scripts/verify-visual.mjs`、`scripts/fixture/visual.html`
- Test: 视觉件 `scripts/verify-visual.mjs`（probe）+ `test/orb-math.test.mjs` 追加渲染层参数断言

**Interfaces:**
- Consumes: `buildSphere/buildCore/buildRim/stateToTargets/heartbeatScale`（Task 4）。
- Produces: `createOrb(canvas: HTMLCanvasElement, opts: { reducedMotion: boolean, THREE: object }): OrbHandle`；OrbHandle 按设计契约；五层绘制顺序 = 核心辉光 → 球核 → 球面疏网 → 边缘点带 → 倾斜轨道环 → HUD 同心环 → 粒子；透视相机（系数与 mockup 一致）。

- [ ] **Step 1: 写视觉 probe** `scripts/verify-visual.mjs`：playwright 起 fixture 页（本地文件 import 渲染器 + vendor），渲 idle/active/decay 三态到 `docs/verify/orb-{idle,active,decay}.png`，并拼 `docs/verify/compare.png` 与 mockup 并排；Expected（跑前）: FAIL（`createOrb` 不存在）。
- [ ] **Step 2: 跑 probe、确认失败。**
- [ ] **Step 3: 实现 `createOrb`**：五层几何/材质逐层建，视觉常量抄 `docs/mockups/orb-mockup.html` 的对应值（颜色/透明度/密度）；`dispose()` 释放 geometry/material/renderer。
- [ ] **Step 4: 跑 probe、确认三张截图生成且并排图落盘**；肉眼对照对照物（用户判方向的那组图）记录差异清单，超阈值的回改常量。
- [ ] **Step 5: 提交。**

### Task 7: 降级与生命周期（CSS 球 / 丢上下文 / 单例根 / dispose 幂等）

**Files:**
- Modify: `client.js`、`client/orb-renderer.js`
- Test: `test/degrade.test.mjs`

**Interfaces:**
- Consumes: `createOrb`（Task 6）；`apply(ctx)` effect 清理（Task 5）。
- Produces: `createOrb` 抛错或 vendor 加载失败 → OrbClient 挂 CSS 降级球（`div.energyOrb-fallback`，CSS 呼吸动画，仍按 `stateToTargets` 切换大小/透明度）；`webglcontextlost` → 尝试恢复一次，2s 未恢复或再丢 → 降级球；`dispose()` 二次调用无抛错；`apply→dispose→apply` 后 DOM 中 `[data-dsh-energy-orb-root]` 计数恒为 1，dispose 后为 0。

- [ ] **Step 1: 写失败测试**：fake canvas 让 `createOrb` 抛错 → 断言 fallback 元素被挂上且原 canvas 被移除；`dispose()` 两次不抛；重复 apply 后根元素计数 1（happy-dom 或手写 DOM stub）。
- [ ] **Step 2: 跑测试、确认失败。**
- [ ] **Step 3: 实现降级与生命周期收口**（`ctx.effect` 返回清理函数；warn 每类恰好一次）。
- [ ] **Step 4: 跑测试、确认通过；再跑一遍全套 `node --test`。**
- [ ] **Step 5: 提交。**

### Task 8: 装载 + 验收清单收尾

**Files:**
- Modify: 无（执行与记录）
- Test: 验收契约 `2026-10-31-energy-orb-acceptance.md` 的 A1–A10

**Interfaces:**
- Consumes: 全部前序任务产物。
- Produces: 装载后的 live 插件；`docs/verify/` 视觉件；验收逐条勾选的记录（不通过的条目留在报告里，不静默消失）。

- [ ] **Step 1: 跑全套单测 + 视觉 probe** Run: `node --test && node scripts/verify-visual.mjs` Expected: 全 PASS、`docs/verify/compare.png` 更新。
- [ ] **Step 2: 逐条跑验收 A1–A10**（按验收文档的检查命令），逐条记录预期对照结果。
- [ ] **Step 3: A/B 证明**：把 `isStale` 阈值改成 `Infinity`（真实失败模式）→ A4 必须红在正确断言 → 还原 → 绿。
- [ ] **Step 4: 收尾报告**（smart-verify-claim 口径：证据先于断言，覆盖说明里的三类人工项点名交给用户）。
- [ ] **Step 5: 等用户点头后才 push**（此前只本地提交）。

---

## Execution Handoff

用户已指定执行方式（「开工」= 本会话自己执行）。执行纪律按 `smart-execute`：进度落台账、能定的当场裁定、卡住才停、收尾独立终审。
