# dsh-energy-orb

DSH Web GUI 的 **Web3D 能量球**插件：跟随会话状态的浮动装饰——静息时收缩沉默，回合运行时以心搏节律涨缩（快起 120ms / 慢落 480ms，≈60 BPM，活动强度提频）。

> 视觉对照物：[`docs/mockups/`](docs/mockups/)（已拍板的目标效果图）与 [`docs/verify/compare.png`](docs/verify/compare.png)（真渲染器 vs 对照物）。

## 状态 → 动效

| 会话状态 | 能量球 |
| --- | --- |
| 静息（无活动回合） | 0.6× 收缩，辉光 0.3，10s 慢呼吸 |
| 激活（扫描杠亮起的同一事件） | 0.9↔1.1× 心搏循环，辉光随脉搏涨落，环速与粒子提频 |
| `error`（预留） | 红移 + 抖动 |

材质五层（防密集恐惧的密度结构）：**边缘点带（密）· 球核（聚）· 球面疏网（少）** + HUD 同心环（异速旋转）+ 粒子；3D 化 = 透视近大远小 + 深度渐变 + 定向光 + 倾斜轨道环。

## 架构

```
Harness 'api-session/status' → ActivityProjector（Host 折叠）
      → GET /api/energy-orb/state（loopback-only 围栏）
      →（2s 轮询 + 10s 退避）OrbClient（shell.overlay 挂载）
      → OrbRenderer（Three.js 五层；vendor 懒加载；失败降 CSS 球）
```

- 状态契约：`EnergyOrbState = { version: 1, active, intensity, phase, updatedAt }`；状态 >10s 陈旧按静息呈现。
- 显示偏好（位置/大小/显隐）住 localStorage；配置面只有 `enabled`。
- 详细设计：[`docs/design.md`](docs/design.md)（形状五问 + 密度规则）；决策记录：[`docs/adr/`](docs/adr/)；实现计划与验收：[`docs/plans/`](docs/plans/)。

## 安装（开发期，link 方式）

```bash
dsh plugin add link:/Users/ethan/ai-workspace/dsh-plugins/dsh-energy-orb   # cwd = DSH_HOME
# 装完重启 dsh web（引擎把客户端包缓存在进程内）
```

## 开发与验证

```bash
node --test                        # 单测（30 项：契约/围栏/心搏/密度/降级/生命周期）
node scripts/verify-visual.mjs     # 视觉 probe：三态截图 + 对照图 + A7 真 DOM 生命周期
node scripts/verify-live.mjs --self-test   # A2/A3 live 检查脚本自证（真 route handler 桩）
node scripts/verify-live.mjs http://127.0.0.1:<port>   # 装载后对真实实例跑 A2/A3
node docs/mockups/shoot-mockups.mjs        # 重渲目标效果图（对照物生成器）
```

## 验收状态（2026-10-31）

9/12 ✅（A4–A12，含两组 A/B 证明）；A1–A3 的 live 检查待插件装载放行后用 `verify-live` 补跑。逐条记录见 [`docs/plans/2026-10-31-energy-orb-acceptance.md`](docs/plans/2026-10-31-energy-orb-acceptance.md)。

## License

待定（首次 npm 发布前需定；vendored `three@0.170.0` 为 MIT，见 [`client/vendor/README.md`](client/vendor/README.md)）。
