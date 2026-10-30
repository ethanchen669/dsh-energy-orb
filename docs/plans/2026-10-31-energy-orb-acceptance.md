# dsh-energy-orb 验收契约

> 配套计划 [`2026-10-31-energy-orb.md`](2026-10-31-energy-orb.md)。验收先于实现；每条标准带「检查」与「预期」，检查必须能红。
> 通用前置：插件经 `plugin_manager install_bundle` 装载到**非 3080** 的 scratch 实例（临时端口 + 仓库外 scratch home）。

## 验收标准

- [ ] **A1 装载后行存在且默认启用** —— 检查：`install_bundle` 返回后读 `application`/`warnings`，再 `cordis_inspect_query(host, Config, listConfigs, { name: 'dsh-energy-orb' })`；预期：`application: applied`、无 error 级 warnings、目录返回该 entry 且 `enabled` 默认 `true`。
- [ ] **A2 状态路由返回契约 JSON** —— 检查：scratch 实例上 `curl -s http://127.0.0.1:<port>/api/energy-orb/state` + node 断言字段；预期：HTTP 200；`version === 1`、`typeof active === 'boolean'`、`intensity ∈ [0,1]`、`phase ∈ {idle,active,error}`、`typeof updatedAt === 'number'`，五字段缺一即红。
- [ ] **A3 未配对请求 403 且不泄状态** —— 检查：伪造非 loopback 请求（socket 远端 192.168.1.9，或 `Host: evil.example`，或 `Sec-Fetch-Site: cross-site`）打 A2 同一路由；预期：HTTP 403、body 精确 `forbidden: loopback-only`、body 不含 `active`/`intensity`/`updatedAt` 任一字段。
- [ ] **A4 状态陈旧 ≤10s 降静息** —— 检查：`stateToTargets({ version:1, active:true, intensity:1, phase:'active', updatedAt: now-11000 }, now)`；预期：输出等价 idle 目标（`scale === 0.6`、`glow === 0.3`）；`updatedAt: now-9000` 时仍是 active 目标——两个边界都要断言。
- [ ] **A5 心搏包络（快起慢落）** —— 检查：采样 `heartbeatScale(t, 0)`；预期：`t=120ms` 处 ≥ 1.05、`t=600ms` 处 ≤ 0.92、攻起段（0–120ms）单调不降、舒张段（120–600ms）单调不升；`heartbeatScale(·, 1)` 的周期比 `heartbeatScale(·, 0)` 短（提频）。
- [ ] **A6 vendor/WebGL 失败降级不炸页** —— 检查：fixture 页把 vendor URL 指向 404 后初始化；再用 fake canvas 让 `createOrb` 抛错；预期：`div.energyOrb-fallback` 挂出且跟踪状态（idle/active 尺寸有差）、`window.onuncaughterror` 计数 0、console.error ≤ 1 条/类。
- [ ] **A7 卸载/HMR 单例根** —— 检查：同一页面 `apply → dispose → apply` 两轮后查 DOM；预期：`[data-dsh-energy-orb-root]` 计数恒为 1（两轮 apply 后）、dispose 后为 0、二次 `dispose()` 不抛。
- [ ] **A8 视觉对照件齐备** —— 检查：`node scripts/verify-visual.mjs`；预期：`docs/verify/orb-{idle,active,decay}.png` 三张生成（与 mockup 同画布尺寸）且 `docs/verify/compare.png` 并排图落盘；与 `docs/mockups/*.png` 的肉眼对照结论记录进收尾报告（人工判，不由脚本判）。
- [ ] **A9 密度规则（防密集恐惧）** —— 检查：`node --test test/orb-math.test.mjs` 中的计数断言；预期：球面点 = 42、边缘点带 = 72、球核 ≥ 18、edges 无重复无自环；任一计数越界即红。
- [ ] **A10 畸形状态 clamp + 恰一次 warn** —— 检查：喂 `{ version: 0, active: 'yes', intensity: 9, phase: '??', updatedAt: 'x' }`（stub `console.warn` 计数）；预期：输出为 idle 目标且各字段在契约范围内、`console.warn` 恰 1 次。

## A/B 证明（改坏必须红）

- [ ] **A11 陈旧判据改坏会红** —— 检查：把 `isStale` 阈值从 `10_000` 改成 `Infinity` 后跑 A4 的检查；预期：A4 必须红且红在「陈旧仍按 active」的断言上；还原后 A4 绿。
- [ ] **A12 围栏改坏会红** —— 检查：把 fence 判定改成恒真后跑 A3 的检查；预期：A3 必须红且红在 403 断言上；还原后 A3 绿。

## 覆盖说明（没有自动化验收的，显式说）

- **拖拽手感 / 心搏体感**：真机人工核对（用户在真 GUI 拖一次、看一轮心搏），脚本只证明参数包络（A5）。
- **prefers-reduced-motion 的系统级切换**：代码路径 + 目标参数单测覆盖逻辑；真实辅助功能开关下的人工抽查留给用户。
- **GPU 占用 / 低端机性能**：无自动化；低配机人工观察，超标走 ADR-0001 的 Revisit trigger。
