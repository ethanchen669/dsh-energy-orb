# ADR-0005：渲染体改为 vendored `apps/energy-sphere-demo`（AETHER // Energy Core）

> 重开 ADR-0001/0004 的「材质/实现」前提：用户判定自研渲染体的 **UI 与动效都不符合基本要求**，
> 并要求改用已定稿的 demo。按纪律写新 ADR，旧 ADR 不改。

## Context

- 自研 `client/orb-renderer.js`（线框球 + HUD 环 + 粒子，按旧效果图实现）经三轮真机验证后仍被
  用户判为**不可用**：「从 UI 设计和动效上都不符合基本要求，需要撤掉」。
- `apps/energy-sphere-demo`（AETHER // Energy Core）是**已定稿**的视觉与动效：粒子能量核心 +
  三组前向机械环（刻度、节点、弧光）+ UnrealBloom，双拍心跳 64 BPM、`coreScale`/`coreBrightness`
  精细控制、`pulse()` 单次脉冲、`dispose()` 幂等；自带 9 组浏览器验收（真 WebGL 像素/暂停/恢复/脉冲/resize/降级）。
- 交付约束没变：Client 半边以 **classic script** 下发，浏览器里没有 import map、也没有 node_modules；
  demo 用 `import * as THREE from 'three'` 与 `three/addons/**`，直接搬会 404。

## Options

1. **保留自研渲染体继续调**：代码在自己手里、无 vendor。代价：用户已判不可用，方向未定（调多好算够？），
   继续迭代仍是「和上一版比变了没有」，没有对照物。
2. **依赖 `three` npm 包 + 打包步骤**：pnpm 依赖 + vite/esbuild 出单文件。代价：插件是纯 ESM 无构建步
   （现有测试/装配路径都假定无构建），为一个渲染体引入构建链，失败面变大；且 demo UI 用 vite，搬到插件要裁剪。
3. **vendored demo（闭包遍历 + 相对 URL 改写 + 精确白名单路由）**：一个生成脚本产出 `client/sphere/**` + `client/vendor/**`，
   sha256 记录、可 `--check`、可重生成。代价：仓库多 ~800KB 与一个生成步骤；上游漂移要重跑脚本。
4. **iframe 嵌 demo 页面**：视觉零改动。代价：跨文档通信/样式隔离/心跳同步全是新契约；overlay 里放 iframe 还要处理透明与指针事件——**复杂度换不来任何东西**。

## Decision & Why

选 **3（vendored demo）**。

- 用户已定稿 demo 的视觉与动效：**对照物唯一**，不再由我们猜「够不够好」。
- 选项 1 已被证伪（三轮真机仍被判不可用）；选项 4 的每一条代价都是新的失败面。
- 选项 2 的构建链与「插件=纯 ESM」的既有约束冲突；而闭包遍历脚本能在**生成期**把
  「浏览器没有裸说明符」这件事变成硬校验（漏一个文件脚本直接报错，不会等到生产 404）。

**两处必须的工程化决定**（不是顺手改的）：

1. **闭包遍历 + 相对改写**：手抄清单的失败方式是「少了三个文件、生产 404」；遍历的失败方式是脚本当场报错。
2. **一个透明画布补丁**（`transparent-alpha-pass`）：bloom 链把整帧 alpha 写成 1，
   在 demo 的整页深色背景上看不出来，在 DSH 里就是不透明方块。补丁在 `OutputPass` 之后
   用亮度还原 alpha 并径向收边（0.84→1.0；机械环约占半宽 0.82，不会切到环）。
   四角 alpha = 0 由浏览器断言守着，防止下次 vendor 时被静默丢掉。

**错了的代价**：若上游 demo 改版导致补丁 `find` 失配，生成脚本会**失败退出**（不会静默产出错视觉）；
若未来判定 vendored 体积/维护成本不可接受，回退路径是「换渲染体、接口不变」——
`OrbClient` 只依赖 `createEnergySphere(container, options) → { update, pulse, dispose }` 这一个形状。
