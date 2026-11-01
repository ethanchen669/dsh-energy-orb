# dsh-energy-orb

DSH Web GUI 的 **Web3D 能量球**插件：跟随会话状态的浮动装饰——静息时收缩静默，回合运行时以双拍心跳涨缩。

渲染体是已定稿的 [`apps/energy-sphere-demo`](../../dsh-fly/apps/energy-sphere-demo)（AETHER // Energy Core）：
粒子能量核心 + 三组前向机械环（刻度/节点/弧光）+ UnrealBloom，基于 `three@0.180.0`（MIT）。

> 对照物：[`docs/reference/energy-sphere-preview.png`](docs/reference/energy-sphere-preview.png)（demo 定稿预览）
> 与 [`docs/verify/`](docs/verify/)（本插件真机渲染：悬浮层真尺寸、三态、生命周期）。

## 状态 → 动效

| 会话状态 | 能量球 |
| --- | --- |
| 静息（无活动回合 / 状态陈旧 >10s） | 心跳关闭 · 核心 0.82× · 辉光 0.5 · 外环缓转 |
| 激活（扫描杠亮起的同一事件） | 双拍心跳 · 核心 1.08× · 辉光 1.3 · 外环全速 · 心率 64→112 BPM 随 intensity 提频 |
| `error`（预留） | 红移 · 心跳关闭 |
| `prefers-reduced-motion` | 停环关心跳，仅保留大小/亮度差 |

状态切换做 420ms 指数插值（长大 + 变亮 + 起搏，不是跳变）；纯点击触发一次脉冲，拖拽移动位置。

## 架构

```
Harness 'api-session/status' → ActivityProjector（Host 折叠）
      → GET /api/energy-orb/state（loopback-only 围栏）
      →（2s 轮询 + 10s 退避）OrbClient（shell.overlay 挂载；状态→球体参数 + 420ms 插值）
      → import('/energy-orb/assets/sphere/energy-sphere.js')（懒加载，失败降 CSS 球）
            └→ /energy-orb/assets/vendor/**（vendored three@0.180.0 闭包，精确白名单）
```

- 状态契约：`EnergyOrbState = { version: 1, active, intensity, phase, updatedAt }`。
- 显示偏好（位置/大小/显隐）住 localStorage；配置面只有 `enabled`。
- 详细设计：[`docs/design.md`](docs/design.md)；决策记录：[`docs/adr/`](docs/adr/)（0005 = 换渲染体）；
  实现计划与验收：[`docs/plans/`](docs/plans/)。

## vendored 资产（`client/sphere/**` + `client/vendor/**`）

**只由 `node scripts/vendor-sphere.mjs` 生成，不要手改**（sha256 测试会红）。它会：
按 import 图遍历闭包 → 把所有裸说明符改写成相对 URL → 落盘 + 记 `client/vendor/manifest.json`（含 sha256 与补丁）。
详见 [`client/vendor/README.md`](client/vendor/README.md)。

视觉改动**先在 demo 仓改**、跑 demo 自己的 `npm test` / `npm run verify:browser`，再回来重跑生成脚本。

## 安装（开发期，link 方式）

```bash
dsh plugin add link:/Users/ethan/ai-workspace/dsh-plugins/dsh-energy-orb   # cwd = DSH_HOME
# 装完重启 dsh web（引擎把客户端包缓存在进程内，刷新页面不够）
```

## 开发与验证

```bash
node --test                                # 单测（52 项：契约/围栏/映射/几何/心跳/降级/生命周期/vendor 完整性）
node scripts/verify-visual.mjs             # 浏览器 probe：真资产路由 + 真 WebGL 像素（三态/动效/透明/生命周期/悬浮层）
node scripts/verify-host.mjs               # 宿主级集成：**真 cordis + 真 webServer** 起监听，验证 15 个资产 / 状态契约 / 围栏 / 卸载重挂
node scripts/verify-live.mjs --self-test   # live 检查脚本自证（真 route handler 桩）
node scripts/verify-live.mjs http://127.0.0.1:<port>   # 装载后对真实实例跑 A2/A2b/A3
node scripts/vendor-sphere.mjs --check     # vendored 资产与上游是否一致
```

> `docs/verify/` 里带 `live` 的图（`compare.png` 的 live 格、`overlay-*-full.png`）含动画帧，
> 重跑 probe 会因相位不同而字节变化——这是**预期**的，别拿它们的 diff 当回归信号；
> `sphere-idle/active/pulse.png` 是定格态，字节稳定。

## 验收状态（2026-11-01）

S1–S9 ✅、S11–S12 ✅（含 6 组 A/B 红证明；S11 用宿主同一份 cordis + webServer 真起监听验证），
S10 ⏸ 待重启 `dsh web` 后在真 GUI 里确认（`/api` 在浏览器鉴权后面，裸 curl 进不去）。
逐条记录见 [`docs/plans/2026-11-01-energy-sphere-integration-acceptance.md`](docs/plans/2026-11-01-energy-sphere-integration-acceptance.md)。

## License

本插件：待定（首次 npm 发布前需定）。vendored 的 `three@0.180.0` 为 **MIT**（`three.module.min.js` 内嵌
license 头，Copyright © 2010-2025 three.js authors）；`apps/energy-sphere-demo` 的代码随本项目同授权，
其 vendored 副本的出处与补丁见 [`client/vendor/README.md`](client/vendor/README.md)。
