# dsh-energy-orb 设计（形状）

> Web3D 能量球：DSH Web GUI 的纯状态可视化装饰。会话静息时球收缩静默；会话激活（扫描杠亮起的同一事件）时球以心搏节律循环涨缩。
> 方向已拍板（smart-brainstorm 决策表）：Three.js + 自定义 shader、浮动角落球（可拖拽）、独立仓插件、**不做**养成/经济/气泡。
> 本文只定形状（组件/接口/数据/错误/接缝），不含步骤。工作名 `dsh-energy-orb`，改名不影响任何接口。

## 组件与边界

| 组件 | 职责（一句话） | 不许知道 |
| --- | --- | --- |
| **ActivityProjector**（Host） | 把 Harness 会话活动事件折叠成一份 `EnergyOrbState` | 渲染、DOM、Three.js、HTTP、客户端存在 |
| **StateRoute**（Host） | 在 `webServer` 上挂 `GET /api/energy-orb/state` 一条 JSON 路由，带 loopback-only 围栏 | 状态怎么折叠出来的、球长什么样 |
| **OrbClient**（Client，`shell.overlay` 条目） | 轮询状态路由、持有显示偏好、拖拽/点击交互、驱动渲染器 | 会话、事件名、Host 内部结构 |
| **OrbRenderer**（Client，纯渲染器） | 状态→shader 参数映射与插值、绘制、WebGL 降级 | HTTP、会话、插件生命周期、localStorage |
| **显示偏好**（client localStorage）+ **Config**（cordis Config） | localStorage 持有 visible/size/anchor/offset；Config 只持有 `enabled` 插件开关 | 互相不知道；都看不到会话 |

依赖方向（反向为零）：

```
Harness 事件 → ActivityProjector → StateRoute →（HTTP 轮询）→ OrbClient → OrbRenderer
```

**不放进本设计**：养成经济（亲密度/喂食/小鱼干）、气泡文案、多球/按会话分球、announcement、
Workshop 式资产注册表（dsh-pet 的契约一概不继承）。它们都不要求改下述任何接口——`intensity`
字段是为细粒度动效预留的唯一扩展点。

## 接口

### 跨接缝契约：EnergyOrbState（Host 产出，Client 消费）

```ts
type EnergyOrbState = {
  version: 1                 // 契约版本；不认识的 version 客户端按 idle 呈现
  active: boolean            // ≥1 个顶层会话在跑（扫描杠亮的同一事件源）
  intensity: number          // 0..1 活动强度；v1：active 时 1，否则 0（后续细粒度填充，语义不变）
  phase: 'idle' | 'active' | 'error'   // error：最近回合出错的着色态（v1 预留，暂按 active 呈现）
  updatedAt: number          // epoch ms，客户端据此判陈旧
}
```

### 路由（唯一一条）

| 路由 | 输入 | 输出 | 错误 |
| --- | --- | --- | --- |
| `GET /api/energy-orb/state` | — | `200 EnergyOrbState` | `403 forbidden: loopback-only`（围栏见「接缝」） |

显示偏好**没有**写路由：全部由客户端 localStorage 持有（见「数据与状态」）。

### Host 内部接缝

```ts
ActivityProjector.snapshot(): EnergyOrbState                       // 同步纯读
监听 'api-session/status'(sessionId: SessionId, running: boolean)   // v1 唯一活动输入
// 预留（不改接口即可加）：'tools/result'、'agent/assistant-stream'、'api-session/error' → intensity / phase
```

### Client 渲染器接缝

```ts
createOrb(canvas: HTMLCanvasElement, opts: { reducedMotion: boolean }): OrbHandle

interface OrbHandle {
  setState(state: EnergyOrbState): void   // 只设目标参数，插值由渲染器内部驱动
  setConfig(cfg: OrbDisplayConfig): void  // 显示偏好变化（大小/显隐）时调用
  dispose(): void                         // 停 rAF、释放 WebGL 资源；可重复调用（幂等）
}

type OrbDisplayConfig = {
  visible: boolean     // 默认 true
  size: number         // 静息直径 px，32..256，默认 96
  anchor: 'bottom-right' | 'bottom-left'   // 默认 bottom-right
  offset: { x: number; y: number }         // 拖拽偏移 px，clamp 在视口内
}
```

### 状态→动效映射（OrbRenderer 的契约表）

| 状态 | 缩放（× 静息尺寸） | 辉光 | 节律 |
| --- | --- | --- | --- |
| `idle` | 0.6 | 0.3 | 10s 极慢呼吸（±2%），防死画面 |
| `active` | 0.9 ↔ 1.1 | 0.8，随脉搏涨落 | **心搏**：快起（attack ≈ 120ms）慢落（decay ≈ 480ms）+ 间歇，基线 ≈ 60 BPM；`intensity` 升高则 BPM 线性上调（60→120） |
| `error`（预留） | 同 `active` | 红移 + 轻微抖动 | 同 `active` |

- 切换状态**不硬切**：目标参数改写后由渲染器指数平滑逼近（时间常数 ≈ 300ms）。
- `prefers-reduced-motion`：取消一切缩放动画，只留辉光/透明度的慢呼吸。
- 上表数值是渲染器常量（v1 不开放配置），调参不动接口。

### 材质结构（已拍板；对照图 = `docs/mockups/*.png`）

照参考图的层级 + 拍板的密度结构，`OrbRenderer` 的渲染层自内向外：

| 层 | 结构 | 密度规则 |
| --- | --- | --- |
| 球核 | 亮核点（≥18 粒）+ 极短连线，随球旋转 | **聚**：中心一坨亮核，视线锚点 |
| 球面 | 疏网（≈42 点近邻连线，压暗） | **少**：只给结构感，绝不铺满（防密集恐惧） |
| 边缘点带 | ≈72 粒贴剪影的点环，外密内疏，慢速漂移 | **密**：轮廓靠密度堆出来 |
| HUD 同心环 | 3 层异速旋转：实线弧段 + 虚线 + 刻度齿 + 切向数据块 | 环速随 `intensity` 提频 |
| 粒子 | 外飘光点 + 少量暖色火花（压低不抢戏） | 随脉搏增减 |
| 3D 化（全层适用） | 透视近大远小（系数 1+z·0.16）+ 连续深度渐变 + 定向光（左上前）+ 两条倾斜轨道环（前弧亮/后弧暗） | —— |

对照图（方向已判过，**后续一切视觉改动以它们为尺子**，不是「和上一次比」）：
[`orb-idle.png`](mockups/orb-idle.png) / [`orb-active.png`](mockups/orb-active.png) / [`orb-closeups.png`](mockups/orb-closeups.png)
（mockup 源文件：[`orb-mockup.html`](mockups/orb-mockup.html)，可重渲）。

## 数据与状态

| 数据 | 住哪 | 谁拥有 | 生命周期 |
| --- | --- | --- | --- |
| `EnergyOrbState` | Host 内存（ActivityProjector） | ActivityProjector | 插件 apply 时创建，事件到达即重算，插件卸载即销毁；**零持久化**。Host 重启后由 `agents` 服务的当前 running 状态重新播种，最坏错一个轮询周期 |
| `OrbDisplayConfig` | Client localStorage（键 `energy-orb.display`） | OrbClient | 浏览器侧持久，随 origin 走；换浏览器不同步——装饰品，接受 |
| `enabled` | cordis Config（插件配置面） | 用户 | 升级存活（patch 层）；关掉 = Client 半边不挂载 |
| 渲染器目标/当前参数 | OrbRenderer 内部 | OrbRenderer | 随 `dispose()` 销毁；掉电/刷新即无 |

谁创建谁销毁：`OrbHandle.dispose()` 是唯一出口，由 OrbClient 的插件 effect 清理调用；
多标签页各自持有一份渲染器，状态只读共享，无并发写。

## 错误与失败模式

| 失败 | 会怎样 |
| --- | --- |
| `GET state` 失败（网络断 / Host 重启 / 403） | 客户端保留上次状态继续渲染；**>10s 无成功响应则按 `idle` 呈现**（stale 的 active 不许永远跳）；连续失败退避到 10s 轮询，恢复后回 2s。任何错误不冒泡进页面，不写控制台刷屏 |
| 状态 JSON 损坏 / 字段越界 | clamp 到契约范围（`intensity`→[0,1]、`active`→布尔化）；`version` 不认识 → 按 `idle` 呈现 + `console.warn` 一次 |
| WebGL 上下文丢失 | `webglcontextlost` → 尝试 `restoreContext()` 一次；2s 未恢复或再次丢失 → 换 CSS 降级球（div + CSS 呼吸动画，仍跟踪状态），warn 一次。页面永不白屏 |
| Three.js vendor 懒加载失败 | 同上：CSS 降级球；状态照常跟踪（CSS 过渡表达缩放/透明度） |
| 插件卸载 / HMR 重注入 | effect 清理停轮询、`dispose()` 渲染器、移除节点；重注入接管，页面任意时刻恰好一个 `[data-dsh-energy-orb-root]` |
| 多标签页并发 | 各自渲染各自读，无协调需求；不存在跨页写 |
| `dispose()` 后 setState | 幂等忽略，不抛错（HMR 竞态的兜底） |

「失败」与「空」的区分：`GET` 的 403/网络错是失败（走退避与陈旧降级）；`idle` 是合法的空状态（正常渲染缩小球）。
两者客户端表现不同：失败降级有 10s 宽限期，空状态立即生效。

## 接缝与取舍

### 对接点（改谁、不改谁）

- **Harness 事件面**：只读订阅 `'api-session/status'`。**不改上游一行、不读上游 DOM**——
  扫描杠与能量球是同一事件的两个平行消费者，上游改样式弄不断本球。
- **挂载点**：`shell.overlay`（root 级浮动层，`replaceRisk: none`，全程常驻）。
  不 `document.body` 挂载（`ui-plugin.md` 明令禁止 append 第二个应用）；不占
  `conversation.*` slot（那些是 session 作用域，新会话页会消失——dsh-pet 的 README 点名过这个坑）。
- **HTTP**：`webServer.register` 自带路由 + loopback-only 围栏（loopback socket + Host header +
  same-origin markers；未配对的 LAN 客户端在读到任何状态前就 403）——同 dsh-pet 的 security model。
- **外观**：容器/交互控件跟宿主主题走 `--dsw-alias-*` token；球本体是 artwork，允许自有配色。
  可见文字走 `ctx.locale`。

### 排除了什么、为什么（详情见 ADR）

1. **渲染栈**：Three.js + 自定义 shader/几何层，排除裸 WebGL 与 CSS-only；
   材质改为网络球/HUD 后前提重开，人工裁定**维持 Three.js**（要真 3D 管线的扩展空间）—— [`adr/0001-render-stack.md`](adr/0001-render-stack.md) + [`adr/0004-maintain-threejs.md`](adr/0004-maintain-threejs.md)
2. **状态通道**：HTTP 轮询（2s）+ 客户端插值，排除 wire.view 推送与 SSE —— [`adr/0002-state-channel.md`](adr/0002-state-channel.md)
3. **显示偏好住 localStorage**（单通道），排除 host/client 双持久化 —— [`adr/0003-display-prefs-storage.md`](adr/0003-display-prefs-storage.md)
4. **v1 不做**：养成经济、气泡、多球、announcement、点击以外的交互。理由：定位是状态可视化装饰；
   点击只做本地「充能」小反馈（纯视觉，不产生任何状态）。`intensity` 已为后续细粒度动效留好语义，加值不动接口。
