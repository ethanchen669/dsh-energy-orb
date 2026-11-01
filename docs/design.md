# dsh-energy-orb 设计（形状）

> Web3D 能量球：DSH Web GUI 的纯状态可视化装饰。会话静息时球收缩静默；会话激活（扫描杠亮起的同一事件）时球以双拍心跳循环涨缩。
>
> **2026-11-01 换渲染体**：自研 `client/orb-renderer.js`（Canvas 风格的线框球）被用户判定「UI 与动效都不符合基本要求」，已删除；
> 渲染体改为**已定稿的 [`apps/energy-sphere-demo`](../../dsh-fly/apps/energy-sphere-demo)（AETHER // Energy Core）**，
> 以 vendored 副本形式进插件（见 [`adr/0005`](adr/0005-energy-sphere-integration.md)）。
> 对照物：[`docs/reference/energy-sphere-preview.png`](reference/energy-sphere-preview.png)（demo 定稿预览）+ [`docs/verify/`](verify/)（真机渲染）。
>
> 本文只定形状（组件/接口/数据/错误/接缝），不含步骤；实现计划见 [`plans/2026-11-01-energy-sphere-integration.md`](plans/2026-11-01-energy-sphere-integration.md)。

## 组件与边界

| 组件 | 职责（一句话） | 不许知道 |
| --- | --- | --- |
| **ActivityProjector**（Host） | 把 Harness 会话活动事件折叠成一份 `EnergyOrbState` | 渲染、DOM、Three.js、HTTP、客户端存在 |
| **StateRoute**（Host） | 在 `webServer` 上挂 `GET /api/energy-orb/state`，带 loopback-only 围栏 | 状态怎么折叠、球长什么样 |
| **AssetRoute**（Host） | 只服务**精确白名单**里的 vendored 资产（球体模块 + three 闭包），供 client 动态 import | 状态、动效参数、客户端代码 |
| **OrbClient**（Client，`shell.overlay` 条目） | 轮询状态、状态→球体参数映射与插值、显示偏好与拖拽、创建/销毁球体、降级 | 会话、事件名、Host 内部结构 |
| **SphereRenderer**（`client/sphere/`，vendored） | Three.js 场景（粒子核心 + 前向机械环 + Bloom）、双拍心跳、DPR/可见性/尺寸自适应、资源释放 | DSH、React、插件生命周期、localStorage、HTTP |
| **显示偏好**（localStorage）+ **Config**（cordis Config） | localStorage 持有 visible/size/anchor/offset；Config 只有 `enabled` | 互相不知道；都看不到会话 |

依赖方向（反向为零）：

```
Harness 事件 → ActivityProjector → StateRoute →（HTTP 轮询）→ OrbClient → SphereRenderer
                                                              └→ AssetRoute（拉模块）
```

**不放进本设计**：养成经济、气泡文案、多球/按会话分球、Workshop 式资产注册表。它们都不要求改下述接口。

## 接口

### 状态契约（唯一业务路由）

| 路由 | 输入 | 输出 | 错误 |
| --- | --- | --- | --- |
| `GET /api/energy-orb/state` | — | `200 EnergyOrbState` | `403 forbidden: loopback-only` |

```ts
type EnergyOrbState = {
  version: 1,
  active: boolean,
  intensity: number,          // 0..1，v1 = active ? 1 : 0
  phase: 'idle' | 'active' | 'error',
  updatedAt: number           // **快照生成时刻**（liveness 心跳，每次读刷新）；客户端按 >10s 判陈旧
}
```

### 资产路由（浏览器加载渲染体的唯一通道）

| 路由 | 白名单 | 错误 |
| --- | --- | --- |
| `GET /energy-orb/assets/<相对 client/ 的路径>` | `ALLOWED_ASSETS`（15 项，见 `host/asset-route.js`；与 `client/vendor/manifest.json` 交叉核对） | 白名单外 `404`；`>20MB` `413`；非 loopback `403` |

URL 结构必须与 vendored 闭包的相对 import 一一对应（`vendor/three.module.min.js` 自己 import
`./three.core.min.js`；addons 之间 import `../shaders/*`）。白名单只是**精确集合**，不做目录放行。

### 渲染器接缝（`createEnergySphere`，vendored 契约）

```ts
createEnergySphere(container: HTMLElement, options?: EnergySphereOptions): EnergySphereHandle

interface EnergySphereHandle {
  update(patch: Partial<EnergySphereOptions>): void   // 立即重绘一次；paused 时也重绘
  pulse(strength?: number): void                      // 单次能量脉冲（0..3，默认 1）
  dispose(): void                                     // 幂等；释放 WebGL/几何/材质/监听
}
```

参数范围（越界抛 `RangeError`；容器非法抛 `TypeError`）：

| 参数 | 范围 / 默认 | 含义 |
| --- | --- | --- |
| `coreScale` | `0.75–1.5`，1 | 与内部心跳缩放相乘，只改中间能量球大小 |
| `coreBrightness` | `0–2`，1 | 与心跳辉光相乘，控制核心/线路/表面/雾光与 Bloom |
| `heartbeatEnabled` | bool，`true` | `false` 冻结核心心跳（外环继续转）⇒ **静息态用它** |
| `energy` | `0–2`，1 | 整体辉光 |
| `rotationSpeed` | `0–4`，1 | 三组机械环转速 |
| `bpm` | `30–200`，64 | 双拍心跳频率 |
| `paused` | bool，`false` | 冻结整个场景（本插件不用它做状态切换；参数更新仍会重绘） |
| `color` | 颜色字符串，`#42dcff` | 主题色（`update({ color })` 生效） |

### 状态 → 参数（OrbClient 的契约表，`stateToSphereOptions`）

| 状态 | `heartbeatEnabled` | `coreScale` | `coreBrightness` | `energy` | `rotationSpeed` | `bpm` |
| --- | --- | --- | --- | --- | --- | --- |
| 静息（`active:false` / 陈旧 >10s / 畸形） | `false` | 0.82 | 0.5 | 0.55 | 0.55 | 56 |
| 激活（`active:true`） | `true` | 1.08 | 1.3 | 1 | 1 | `64 + 48·intensity` → 64..112 |
| `error`（预留） | `false` | 0.95 | 0.9 | 0.9 | 0.8 | 72 |
| `prefers-reduced-motion` | 强制 `false` | 激活 1.05 / 静息 0.82 | 激活 1.15 / 静息 0.5 | 同左 | `0` | 同左 |

- 每个目标都经过球体自己的 `normalizeOptions` 范围校验（测试里直接调它，越界即红）。
- 状态切换做 **420ms 指数插值**（`alpha=0.3`，进度 ≥0.5 时切 `heartbeatEnabled`/`color`，到时限补齐目标），
  所以「静息→激活」是长大+变亮+起搏，不是跳变。
- 纯点击（无位移）触发 `pulse(1.2)`；拖拽不算充能。

## 数据与状态

- Host 侧零持久化：`running` 集合只在内存；`updatedAt` 是**快照时刻**，每次 `snapshot()` 刷新——
  否则长回合（>10s 没有新事件）会被客户端误判成陈旧，球在回合还在跑时缩回去（踩过）。
- 客户端显示偏好住 localStorage 键 `energy-orb.display`：`{ visible, size(32..256), anchor, offset }`（单通道，禁止 host/client 双持久化）。
- cordis Config 只有 `enabled`（boolean，默认 `true`）。
- 球体内部状态（`active/paused/hidden/context-lost/disposed`）只在实例内；时间按帧间隔累计，不依赖 `setInterval`；`ResizeObserver` 管尺寸，DPR 上限 2，页面隐藏停帧。

## 错误与失败模式

| 失败 | 表现 | 兜底 |
| --- | --- | --- |
| 球体模块 404 / 语法错 / three 闭包缺失 | `import()` reject | `console.warn` **恰一次** → 渲染 CSS 降级球（渐变 + 圆 + 呼吸），不空白、不炸页 |
| WebGL 不可用 | `createEnergySphere` 内部 `onError` | 同上（同一条 warn 通道），球体句柄退化为 no-op |
| WebGL 上下文丢失 | `onError` | 同上 |
| 状态畸形（version/active/updatedAt 不合法） | 按静息渲染 | `warn` 恰一次 |
| 状态陈旧 >10s | 按静息渲染 | `warn` 恰一次（仅当它声称 active） |
| 非 loopback 请求打路由 | `403 forbidden: loopback-only` | 不读、不回任何状态字节 |
| 卸载/重挂 | 释放 rAF、WebGL、canvas、监听 | 根元素计数 1/0/1/0；`dispose()` 幂等 |

**透明画布修复**（已回灌上游 `apps/energy-sphere-demo`；本仓库 vendored 副本里的补丁逻辑保留为兜底）：`UnrealBloomPass` 的辉光链会把整帧 alpha 写成 1，
在 demo 的整页深色背景看不出来，但在 DSH 里就是一块**不透明深色方块**。末级 pass 用亮度还原
alpha 并做径向收边（0.84→1.0，机械环约占半宽 0.82，不会切到环）。四角 alpha = 0 有浏览器断言。

## 接缝与取舍

- **修复归属上游**：透明画布这个缺陷是 demo 自己的（组件承诺透明背景但 bloom 链写 alpha=1），
  已回灌到 `apps/energy-sphere-demo/src/energy-sphere.js` 并在 demo 的浏览器验收里加断言；
  插件的游标补丁只在上游回退时兜底（`alreadyFixedMarker`）。
- **vendor 而非依赖**：client 半边是 classic script，浏览器无 import map / node_modules ⇒ 裸说明符必须
  改成相对 URL。闭包由 `scripts/vendor-sphere.mjs` 按 import 图遍历生成（不是手抄清单），
  `manifest.json` 记 sha256 + 补丁，`test/vendor.test.mjs` 守完整性，资产路由白名单与 manifest 交叉校验。
- **渲染体来源有唯一真相**：视觉改动先在 `apps/energy-sphere-demo` 改、跑它的 `npm test` 与
  `npm run verify:browser`，再 `node scripts/vendor-sphere.mjs` 重新生成；补丁的 `find` 失配会让脚本报错退出。
- **性能**：单个 WebGL 上下文、384×384（192 CSS px × DPR2）、Bloom 后处理常驻；页面隐藏时组件自己停帧。
  低端机失败模式是「装饰物吃性能」，兜底是降级球（接口不变，换渲染体即可）。
- **与旧渲染体的关系**：`client/orb-renderer.js`、`docs/mockups/*`、旧的三态 mockup 生成器已删除；
  新旧之间**没有**兼容层（用户判定旧视觉不可用，保留只会让「达标」无从判断）。
