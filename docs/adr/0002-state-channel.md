# ADR-0002：状态通道 = HTTP 轮询（2s）+ 客户端插值

## Context

能量球需要「会话是否在跑」的实时感，但真正的视觉连续性（心搏、平滑过渡）在客户端做。
状态本身是**低频**的（running/idle 翻转以回合计），动效是**高频**的（60fps）。
挂载点是 `shell.overlay`（root 级 slot，无 session-scoped props selector）；
能量球语义是 host-global 聚合（任何顶层会话在跑 = active），不隶属某一个会话。

## Options

1. **HTTP 轮询 + 客户端插值**：Host 折叠状态、`GET /api/energy-orb/state` 每 2s 一次，
   客户端指数平滑。代价：≤2s 的状态感知延迟（被插值掩盖）；常量级轮询流量。
2. **wire.view 推送**：Host projection 声明 wire.view，客户端订阅即得。
   代价：wire.view 沿会话作用域走，与 host-global 聚合语义错位；`shell.overlay` 无 props selector 可挂；
   契约绑定 Harness 内部投影机制，升级风险高。
3. **SSE / WebSocket 推送**：事件级实时。代价：要给路由开升级通道、管重连与心跳，
   复杂度与「低频状态」不成比例。

## Decision & Why

选 **1**。状态低频、动效高频 ⇒ 通道不需要实时，插值负责体感；dsh-pet 的同款取舍已在线上长期运行。
选项 2 用错了作用域（会话级机制装全局语义），选项 3 为 2s 一次的翻转付出常连接的复杂度。

**错了代价**：2s 延迟若体感明显（比如用户盯着球对照扫描杠看），损失是「球慢半拍」的观感，
修法是把轮询降到 500ms（接口不变）；只有当「必须事件级实时」被证明时才回头重开本 ADR。

## Consequences

- 简单：一条 GET 路由就是全部通道；断连/重启的失败模式都收敛在「轮询失败」一条路径上。
- 变难：无（轮询 + 插值就是全部成本）。
- 被排除：wire.view 推送、SSE/WebSocket、任何常连接。

## Revisit trigger

- 500ms 轮询仍体感延迟明显；
- Harness 官方给 root 级 slot 提供全局 wire 通道；
- 能量球要变成按会话分球（那时 wire.view 的会话作用域反而变合适）。
