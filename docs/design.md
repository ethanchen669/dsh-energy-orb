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
| `GET /api/energy-orb/state?session=<id>` | 可选：焦点会话 id（`[A-Za-z0-9_:.-]{1,128}`） | `200 EnergyOrbState` | `403 forbidden: loopback-only`；非法/超长 `session` 一律**退回全局口径**（不 4xx） |

**绑定范围（v0.1.2 起）**：客户端把「主视图正在显示的那一个会话」作为焦点会话 ——
从 `api-session-controller` 的 `sessions` 服务里挑 `retainedBy.mainView > 0` 的那行，
用它的 `running` 标志决定球的静息/运行，并把 id 带进轮询 URL。切换左侧栏会话时
订阅 `sessions.list` 立刻重算（不等 2s 轮询）。宿主侧 `snapshot(sessionId)` 按 id 过滤；
拿不到 `sessions` 服务的宿主（老宿主 / fixture / 极简 profile）退回**全局口径**（任一回合在跑即 active）。

```ts
type EnergyOrbState = {
  version: 1,
  active: boolean,
  intensity: number,          // 0..1，v1 = active ? 1 : 0
  phase: 'idle' | 'active' | 'error',
  updatedAt: number           // **快照生成时刻**（liveness 心跳，每次读刷新）；客户端按 >10s 判陈旧
}
```

### 本地偏好（localStorage `energy-orb.display`，`v: 2`）

| 字段 | 语义 |
| --- | --- |
| `visible` | 整层显隐（缺省 `true`） |
| `collapsed` | **折叠 = 收成 40px 小把手**（缺省 `false`；老存档没有这个字段一律按展开处理） |
| `size` | 半径语义，画布 = `size × 2`；缺省 120（→240px），`v:2` 迁移时旧值 ×1.25 一次 |
| `anchor` / `offset` | 贴哪一角 / 拖拽偏移（px，clamp ±4096） |

**隐藏 / 展开的接缝**：展开态右上角一个 `data-dsh-energy-orb-hide` 的 ×（hover/focus 才显形，`aria-label="隐藏能量球"`，
旁边带一个 `data-dsh-energy-orb-hide-label` 的「隐藏 / hide」气泡）；折叠态缩成 40px 的
`data-dsh-energy-orb-handle` 把手（`<button>`，`aria-label="展开能量球"`，箭头 ↘/↙ 朝向展开方向）。

**拖拽手势（舞台与把手共用）**：`beginGesture()` 以 3px 为阈值区分"轻点"与"拖拽"——移动超过阈值就改
`offset` 并在 `pointerup` 时落盘，否则算轻点（舞台=充能脉冲、把手=展开）。偏移在拖拽期间**本地累计**，
落盘用 `commitPrefs()`（同时更新 state 与 `prefsRef`）：fixture/极简渲染器不重渲染时，只靠 `setPrefs`
会让 `prefsRef` 停在挂载时的旧值（实测把 `collapsed:true` 写回 `false`）。拖拽尾部的 click 由
`draggedRef` 吞掉，所以"拖完松开"不会顺手把球展开（注意：把手会跟着光标走，所以那次尾巴 click 通常就落在把手上）。

**拖拽要 1:1 跟手**（2026-11-02 实测修正）：根节点的 `width/height/bottom/left` 有 220ms 过渡（折叠动效用），
拖拽期间每次 `pointermove` 都写 `bottom/left`，就会被这层过渡「拖着追」——实测滞后峰值 **43.5px**。
所以拖拽一开始就把根节点 `transition` 置 `none`、松手再恢复；并且用 rAF 合并提交（每帧最多一次
`setPrefs`）。修完滞后峰值降到 **9.4px**（残余是 rAF 采样本身的相位差）。门禁里钉了这两条：拖拽期间
盒子位移 vs 光标位移偏差 < 20px；折叠态拖拽后盒子**真的**位移。

**动效是同一组属性的逆过程**（`COLLAPSE_MS = 220`）：根节点宽度/高度/定位边一起过渡，舞台
`opacity 1↔0` + `scale 1↔0.32`，把手 `opacity 0↔1` + `scale 0.85↔1`，两侧 duration 相同——所以展开就是
把收起的曲线倒着走，不会出现"收起顺滑、展开硬切"。

**收起方向 = × 所在的上右角**：`frameStyle()` 是定位唯一真源，收起时保持**上边与右边不动**、
只把 `bottom`（左锚点则 `left`）增加 `size×2 − 40`，配合舞台 `transform-origin: top right`，
视觉上的消失点就是 × 的位置。门禁在真浏览器里量这条不变量（收起/展开途中上边与右边的偏移必须 ≈0，
宽度单调收缩/变大），而不是只看最终态。

切换同时做三件事：①`setPrefs` + 落盘；②**直接改 DOM**（`data-dsh-energy-orb-collapsed`、四条定位边、
舞台/把手的 opacity/scale/pointerEvents）——fixture 与极简渲染器不会因 `setState` 重渲染，光靠框架会
"点了没反应"；③球体 `update({paused})`，折叠期间 rAF 不空转。真 React 里下一次渲染会按 prefs 复现同样形状。

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
