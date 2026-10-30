# ADR-0001：渲染栈 = Three.js + 自定义 shader

## Context

能量球是「Web3D 效果」：噪声能量核心 + 辉光 + 粒子，且要求连续参数动画（心搏节律、状态间平滑过渡）。
运行环境是 DSH Web GUI 的 client 插件（浏览器 bundle，`window.__ModuleLoader__` 契约，React 可外置）。
约束：插件是装饰物，不许拖垮页面性能；静息时必须降频；`prefers-reduced-motion` 必须尊重。

## Options

1. **Three.js + 自定义 shader**：现成的场景/相机/后处理辉光管线，vendor ≈ 600KB 可懒加载。
   代价：体积；多一个 WebGL 上下文的常驻成本。
2. **裸 WebGL2 手写**：单 quad 片元 shader + 自写粒子，代码 ≈ 10–20KB，零依赖。
   代价：相机、辉光后处理、上下文管理全部手写；后续任何视觉扩展都是深水区。
3. **Canvas 2D / CSS-only**：径向渐变 + 混合模式模拟发光，最轻。
   代价：做不出「Web3D」的体积感与折射/噪声流动；需求本体就是 3D 感。

## Decision & Why

选 **1（Three.js + 自定义 shader）**。需求点名 Web3D，选项 3 砍掉的是需求本体；
选项 2 省的 600KB 不值得用「辉光/后处理/相机全手写」去换——那是把装饰物做成引擎项目。
dsh-pet 的 Live2D 路线已证明 vendor bundle 懒加载在 DSH 插件里可行。

**错了代价**：如果 600KB vendor 或常驻 WebGL 上下文在低端机上真成为负担，
损失是「装饰物吃性能」的用户投诉，回退路径是降级渲染器（接口不变，只换 `createOrb` 实现）。

## Consequences

- 简单：视觉效果的表达力天花板高，粒子/噪声/辉光都是现成管线。
- 变难：bundle 体积管理（必须 vendor 分包 + 懒加载）；WebGL 上下文生命周期要自己管（丢失恢复、dispose）。
- 被排除：裸 WebGL 的零依赖路线；CSS-only 的轻量路线。

## Revisit trigger

- 低端机/远程桌面上 GPU 占用成为实际投诉；
- Three.js 大版本升级带来破坏性体积增长；
- 需求缩回「只要一个呼吸圆点」（那时 CSS-only 就够，整条 ADR 作废）。
