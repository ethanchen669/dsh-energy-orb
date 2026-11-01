# dsh-energy-orb 验收契约

> ⚠️ **SUPERSEDED（2026-11-01）**：自研 `orb-renderer` 渲染体已被用户判定不可用并撤除，A4/A5/A8/A9 等条目引用的
> `test/orb-math.test.mjs`、`docs/mockups/*`、`docs/verify/orb-*.png` 均已删除。现行验收见
> [`2026-11-01-energy-sphere-integration-acceptance.md`](2026-11-01-energy-sphere-integration-acceptance.md)。


> 配套计划 [`2026-10-31-energy-orb.md`](2026-10-31-energy-orb.md)。验收先于实现；每条标准带「检查」与「预期」，检查必须能红。
> 通用前置：插件经 `plugin_manager install_bundle` 装载到**非 3080** 的 scratch 实例（临时端口 + 仓库外 scratch home）。
>
> **状态标注**（2026-10-31 收尾时逐条实测；未完成的不静默）：
> ✅ = 已按检查实测通过；⏸ = 卡在装载门（`FLY_ALLOW_PROFILE_WRITE`，见文末），单元级已绿但 live 检查未跑；△ = 核心断言已绿、个别可观察项未单独钉。

## 验收标准

- [ ] **A1 装载后行存在且默认启用** ⏸（卡装载门） —— 检查：`install_bundle` 返回后读 `application`/`warnings`，再 `cordis_inspect_query(host, Config, listConfigs, { name: 'dsh-energy-orb' })`；预期：`application: applied`、无 error 级 warnings、目录返回该 entry 且 `enabled` 默认 `true`。
- [ ] **A2 状态路由返回契约 JSON** ⏸（live 待装载；单元级已绿：`test/state-route.test.mjs` 断言 200 + 五字段形状） —— 检查：scratch 实例上 `curl -s http://127.0.0.1:<port>/api/energy-orb/state` + node 断言字段；预期：HTTP 200；`version === 1`、`typeof active === 'boolean'`、`intensity ∈ [0,1]`、`phase ∈ {idle,active,error}`、`typeof updatedAt === 'number'`，五字段缺一即红。
- [ ] **A3 未配对请求 403 且不泄状态** ⏸（live 待装载；单元级已绿 + A12 红证明） —— 检查：伪造非 loopback 请求（socket 远端 192.168.1.9，或 `Host: evil.example`，或 `Sec-Fetch-Site: cross-site`）打 A2 同一路由；预期：HTTP 403、body 精确 `forbidden: loopback-only`、body 不含 `active`/`intensity`/`updatedAt` 任一字段。
- [x] **A4 状态陈旧 ≤10s 降静息** ✅（`test/orb-math.test.mjs`；A11 红证明） —— 检查：`stateToTargets({ ..., updatedAt: now-11000 }, now)`；预期：输出等价 idle 目标（`scale === 0.6`、`glow === 0.3`）；`updatedAt: now-9000` 时仍是 active 目标——两个边界都要断言。
- [x] **A5 心搏包络（快起慢落）** ✅（`test/orb-math.test.mjs`） —— 检查：采样 `heartbeatScale(t, 0)`；预期：`t=120ms` 处 ≥ 1.05、`t=600ms` 处 ≤ 0.92、攻起段单调不降、舒张段单调不升；`heartbeatScale(·, 1)` 的周期比 `heartbeatScale(·, 0)` 短（提频）。
- [x] **A6 vendor/WebGL 失败降级不炸页** ✅（核心：`test/degrade.test.mjs` fallback 挂出 + warn 恰一次 + 清理幂等；lifecycle fixture 真实走过资产 404 路径并断言 `uncaught === 0`） —— 检查：fixture 页把 vendor URL 指向 404 后初始化；再用 fake canvas 让 `createOrb` 抛错；预期：`div.energyOrb-fallback` 挂出且跟踪状态、`window.onuncaughterror` 计数 0、console.error ≤ 1 条/类。
- [x] **A7 卸载/HMR 单例根** ✅（真 DOM：`scripts/verify-visual.mjs` A7 段，mount/unmount 两轮 1/0/1/0） —— 检查：同一页面 `apply → dispose → apply` 两轮后查 DOM；预期：`[data-dsh-energy-orb-root]` 计数恒为 1（两轮 apply 后）、dispose 后为 0、二次 `dispose()` 不抛。
- [x] **A8 视觉对照件齐备** ✅（`docs/verify/orb-{idle,active,decay}.png` + `compare.png` 已落盘；肉眼对照差异清单见收尾报告，待用户判） —— 检查：`node scripts/verify-visual.mjs`；预期：三张生成（与 mockup 同画布尺寸）且 `compare.png` 并排图落盘；与 `docs/mockups/*.png` 的肉眼对照结论记录进收尾报告（人工判，不由脚本判）。
- [x] **A9 密度规则（防密集恐惧）** ✅（`test/orb-math.test.mjs` 计数断言） —— 检查：`node --test test/orb-math.test.mjs` 中的计数断言；预期：球面点 = 42、边缘点带 = 72、球核 ≥ 18、edges 无重复无自环；任一计数越界即红。
- [x] **A10 畸形状态 clamp + 恰一次 warn** ✅（`test/orb-math.test.mjs`） —— 检查：喂 `{ version: 0, active: 'yes', intensity: 9, phase: '??', updatedAt: 'x' }`（stub `console.warn` 计数）；预期：输出为 idle 目标且各字段在契约范围内、`console.warn` 恰 1 次。

## A/B 证明（改坏必须红）✅ 均已做并还原

- [x] **A11 陈旧判据改坏会红** ✅（已实测：STALE_MS→Infinity 后红在「陈旧仍按 active」断言，还原后绿） —— 检查：把 `isStale` 阈值从 `10_000` 改成 `Infinity` 后跑 A4 的检查；预期：A4 必须红且红在「陈旧仍按 active」的断言上；还原后 A4 绿。
- [x] **A12 围栏改坏会红** ✅（已实测：围栏恒真后红在「非 loopback → 403」「Host 头 → 403」两条，还原后绿） —— 检查：把 fence 判定改成恒真后跑 A3 的检查；预期：A3 必须红且红在 403 断言上；还原后 A3 绿。

## 覆盖说明（没有自动化验收的，显式说）

- **拖拽手感 / 心搏体感**：真机人工核对（用户在真 GUI 拖一次、看一轮心搏），脚本只证明参数包络（A5）。
- **prefers-reduced-motion 的系统级切换**：代码路径 + 目标参数单测覆盖逻辑；真实辅助功能开关下的人工抽查留给用户。
- **GPU 占用 / 低端机性能**：无自动化；低配机人工观察，超标走 ADR-0001 的 Revisit trigger。
- **A1–A3 的 live 检查**：卡在装载门（`plugin_manager install_bundle` 被 fly-guard 拦截，需用户在自己终端设 `FLY_ALLOW_PROFILE_WRITE=1` 后重启宿主）；单元级断言已绿，装载放行后 5 分钟内可补跑。

## 装载门（需要用户执行，agent 无法自设环境变量）

```bash
# 在你自己的终端：
FLY_ALLOW_PROFILE_WRITE=1 <启动 dsh web / 宿主的命令>   # 设变量并重启宿主进程
# 然后告诉我「放行了」，我补跑 A1–A3 的 live 检查
```
