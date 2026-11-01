# dsh-energy-orb：energy-sphere 集成 验收契约

> 配套计划 [`2026-11-01-energy-sphere-integration.md`](2026-11-01-energy-sphere-integration.md)。
> 每条标准带「检查」与「预期」，检查必须能红。状态：✅ 已实测通过、⏸ 待重启/装载后补跑。
>
> **状态标注**（2026-11-01 第二轮）：S1–S9、S11–S12 ✅；S10 ⏸ 待 `dsh web` 重启后在真 GUI 里确认
> （`/api` 在浏览器鉴权后面，裸 curl 进不去；宿主接线改由 S11 的 `verify-host.mjs` 用真 cordis 验证）。

## 验收标准

- [x] **S1 渲染体是 demo 的副本，且可溯源** ✅（`test/vendor.test.mjs`：manifest 记录 sourceApp/three 0.180.0/15 个文件 sha256） —— 检查：`node --test test/vendor.test.mjs`；预期：manifest 的 `threeVersion === '0.180.0'`、每个文件 sha256 与磁盘一致、`generatedBy === 'scripts/vendor-sphere.mjs'`；改动任一 vendored 文件即红。

- [x] **S2 浏览器里没有裸说明符，且闭包可完整解析** ✅（同文件：无残留裸说明符 + 每个相对 import 都能在磁盘解析） —— 检查：同上；预期：`client/sphere|vendor/**` 下所有 `from '…'` 都是相对路径且指向存在的文件；漏 copy 一个 addon 即红。

- [x] **S3 资产路由白名单 = manifest，且不放行目录** ✅（`test/vendor.test.mjs` 交叉比对 + `test/state-route.test.mjs` 真 handler） —— 检查：`node --test test/state-route.test.mjs test/vendor.test.mjs`；预期：`ALLOWED_ASSETS` 与 manifest 的 `client/vendor/**` 完全相等；`vendor/manifest.json`、`../package.json`、`..%2F..%2Fetc%2Fpasswd` 全部 404；非 loopback 403；POST 405。

- [x] **S4 球体组件契约未被改动** ✅（`test/sphere.test.mjs`：22% 基准放大、三环同半径、正交、双拍心跳、参数范围、无 WebGL 时 onError 恰一次 + no-op 句柄） —— 检查：`node --test test/sphere.test.mjs`；预期：8 项全绿；把 `CORE_VISUAL_SCALE` 改成别的值立即红。

- [x] **S5 状态→参数映射符合设计表** ✅（`test/sphere-mapping.test.mjs`） —— 检查：`node --test test/sphere-mapping.test.mjs`；预期：静息 `heartbeatEnabled === false` 且 `coreScale 0.82`/`coreBrightness 0.5`；激活 `bpm === 112`（intensity=1）与 `64`（=0）；陈旧 11s → 静息且 warn 恰 1 次、9s 仍激活；畸形 → 静息 + warn 恰 1 次；error → 红移；reducedMotion → 心跳关、转速 0 但仍能看出激活；所有输出都能通过 `normalizeOptions`（越界即 RangeError）。

- [x] **S6 插值会收敛，且不被状态切换撕裂** ✅（`test/sphere-mapping.test.mjs` 收敛用例） —— 检查：同上；预期：按 `RAMP_MS=420`/`alpha=0.3` 排程在时限内补齐到目标（deepEqual），步数 4–20；`progress<0.5` 不切心跳、`>=0.5` 切。

- [x] **S7 降级与交互未退化** ✅（`test/degrade.test.mjs`） —— 检查：`node --test test/degrade.test.mjs`；预期：模块加载失败 → 可见 CSS 降级球（`radial-gradient` + `border-radius:50%`）+ warn 恰 1 次 + 无未捕获异常；成功路径 → 以静息参数建球、canvas `width/height:100%`、卸载 dispose 恰 1 次；激活状态到达后心跳打开且参数收敛（`coreScale≈1.08`、`bpm≈112`）；纯点击 `pulse(1.2)` 且拖拽不 pulse、offset 写回。

- [x] **S8 真实浏览器里：能渲染、在动、透明** ✅（`node scripts/verify-visual.mjs`，26 项断言） —— 检查：跑该脚本；预期：四态画布 `lit>500`；`active.coreMeanGreen > idle×1.2`；运行中两帧指纹不同而 paused 两帧相同；`pulse` 后核心变亮 >2%；paused 时 `update` 立即重绘；生命周期根元素/画布 1/0/1/0 且 `stageSrc === 'CANVAS'`；悬浮层 192×192 贴右下角、**四角 alpha ≤ 8**、静息→激活核心变亮 >15%、激活在动、回落 <0.95×；两个页面均无 `pageerror` 与 `console.error`。

- [x] **S9 没有旧渲染体残留** ✅（`grep -r "orb-renderer" .` → 无命中；`docs/mockups/` 已删） —— 检查：`grep -rn "orb-renderer\|docs/mockups" --include='*.js' --include='*.mjs' --include='*.md' --include='*.json' .`；预期：无输出（旧计划/旧验收里若是历史叙事，必须带 superseded 标记且不指向不存在的文件）。

- [x] **S11 宿主级集成：真 cordis + 真 webServer 起监听后全都通** ✅（`node scripts/verify-host.mjs`，12 项） —— 检查：跑该脚本（自动从 profile/npx 找 `@deepseek-ai/cordis` 与 `dsh-host-webserver`，找不到显式失败）；预期：15 个白名单资产全 200、球体模块含 `createEnergySphere` 与 `transparentPass`、`three.core` 可发、manifest 404、伪造 Host 403 且文案精确、状态路由 200 且字段齐全、`emit('api-session/status')` 能推动 active/idle、fiber dispose 后两条路由消失、重挂后恢复。

- [x] **S12 真 cordis 的 effect 语义（回归钉）** ✅（`test/host-wiring-cordis.test.mjs` + 同形桩 `test/host-wiring.test.mjs`） —— 检查：`node --test test/host-wiring*.test.mjs`；预期：`ctx.effect` 回调**立即执行**、其**返回值**作为 disposer；apply 之后两条路由必须仍活着、事件仍订阅；fiber dispose 后路由与监听清空。曾经写成 `ctx.effect(() => { disposeX() })` ⇒ 注册当场被撤销 ⇒ 真机资产 404（降级球）+ 状态永远 idle（球静止）。

- [ ] **S10 live：真 GUI 里看得见、动得起来** ⏸（待重启 `dsh web`） —— 检查：`node scripts/verify-live.mjs --self-test`（脚本自证）+ 重启后 `node scripts/verify-live.mjs http://127.0.0.1:<port>`；预期：self-test 9 项全绿；live 端 A2（状态 200 契约）、A2b（15 个白名单资产全 200、球体模块含 `createEnergySphere`、manifest 404、伪造 Host 403）、A3（三种伪造全 403 且不泄状态）全绿。

## A/B 红证明（每条断言都反向验证过）

| 断言 | 撤销什么 | 期望的红 |
| --- | --- | --- |
| S5「静息关心跳」 | 让 `idleOptions` 返回 `heartbeatEnabled: true` | 该用例红（静息不许有心跳） |
| S8「四角透明」 | 去掉补丁 pass（回到只有 OutputPass） | `cornerAlphaMax` 变 255，用例红 |
| S7「dispose 恰一次」 | 卸载时不调 `sphere.dispose()` | 计数 0，用例红 |
| S8「运行中的球在动」 | 把 `live` 用例改成 `paused: true` | 两帧指纹相同，用例红 |
| S12「apply 后路由仍活着」 | 把 `index.js` 改回 `ctx.effect(() => { disposeState(); disposeAssets(); })` | 真 cordis 测试红：0/2 路由存活 |
| S12「事件仍订阅」 | 同上（事件也被立即退订） | 「active 回合 → active:true」用例红 |
| S11「fiber dispose 后路由消失」 | 去掉 disposer 里的撤销调用 | 卸载后仍 200，用例红 |

## 未覆盖 / 已知限制

- 真机（用户屏幕、真实 GUI 背景、光/暗主题）的观感由用户判定；脚本只给「渲染出来了/在动/透明/尺寸正确」的可机器判定部分。
- `prefers-reduced-motion` 的浏览器开关在 probe 里未实机切换（映射层的行为有单测），属已知覆盖缺口。
- demo 上游若改版：重新 `node scripts/vendor-sphere.mjs` 并复跑 S1–S8；补丁失配会由脚本报错拦下。
