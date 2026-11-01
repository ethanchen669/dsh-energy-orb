# ADR-0004：材质改为网络球/HUD 后维持 Three.js（重开 ADR-0001 前提，人工裁定）

> ADR-0001 的 Revisit trigger 类情形出现（材质需求变化），按纪律写新 ADR，不改旧的。

## Context

用户参考图把材质从「噪声等离子 shader」改为「线框网络球 + HUD 同心环 + 粒子」。
该材质 Canvas2D 可 1:1 实现——效果图就是 Canvas2D 渲出来的，且 Canvas2D 对比 Three.js
可砍掉 600KB vendor 与 WebGL 失败模式。ADR-0001 当时以「需求本体是 shader 3D 感」为由
排除 Canvas2D，**该前提已变**。用户裁定：**维持 Three.js**，并要求效果图往 3D 效果上调整
（当时的对照物是 `docs/mockups/*.png`，该目录已于 2026-11-01 随自研渲染体一并删除，
见 [`ADR-0005`](0005-energy-sphere-integration.md)；现行对照物是 `docs/reference/energy-sphere-preview.png`）。

## Options

1. **Canvas2D**：效果图与实现同源（对照 = 像素级）、零依赖零 vendor、砍掉 WebGL 丢上下文
   与 vendor 加载失败两个失败模式。代价：不是真 3D 管线，未来体积光/折射/真透视特效要换栈。
2. **维持 Three.js**：真 3D 管线，3D 化的视觉要素（透视、光照、深度、轨道环）是原生表达
   （Line/Points/Ring + 相机），后续特效扩展空间打开。代价：600KB vendor 懒加载、
   WebGL 生命周期/上下文丢失恢复/CSS 降级整套照建（设计的错误模型已含）。

## Decision & Why

选 **2（维持 Three.js）**，人工裁定。用户要的是「Web3D 效果」的**实现实质**而不只是观感；
3D 化后的对照图要素在 Three.js 里是原生表达，Canvas2D 手写投影反而是绕路。

**错了代价**：多担 vendor 体积与 WebGL 生命周期的复杂度。若装饰物的性能/复杂度代价被证明
过高，回退 Canvas2D 只是 `createOrb` 内部替换——`OrbHandle` 接口不变，客户端其余部分不动。

## Consequences

- 简单：3D 特效扩展空间打开；效果图的 3D 要素（透视/深度/光照/轨道环）有原生对应物。
- 变难：vendor 懒加载（asset 路由 + script 注入）、上下文丢失恢复、CSS 降级球。
- 被排除：Canvas2D 渲染器（mockup 的 Canvas2D 仅保留为对照图生成工具）。

## Revisit trigger

- 视觉需求再缩回纯 2D 图形（此时 Canvas2D 全面占优）；
- vendor 体积 / GPU 占用出现实际投诉（ADR-0001 的原 trigger 同样适用）；
- `OrbHandle` 接口被证明需要暴露 3D 场景对象（说明「纯装饰」定位被突破，回到设计层重议）。
