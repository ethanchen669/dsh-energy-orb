# vendored 资产（`client/sphere/**` + `client/vendor/**`）

**全部由 `node scripts/vendor-sphere.mjs` 生成，不要手改。** 手改会被 `test/vendor.test.mjs`
的 sha256 核对当场红；`node scripts/vendor-sphere.mjs --check` 可在提交前自检。

## 来源

| 内容 | 上游 |
| --- | --- |
| `client/sphere/{energy-sphere,animation,options}.js` | `apps/energy-sphere-demo/src/*`（dsh-fly 仓） |
| `client/vendor/three.module.min.js`、`three.core.min.js` | `three@0.180.0`（MIT License, Copyright © 2010-2025 three.js authors） |
| `client/vendor/addons/**` | 同版本 `three/examples/jsm/**` 的**实际引用闭包**（EffectComposer / RenderPass / UnrealBloomPass / OutputPass / ShaderPass / MaskPass / Pass + 3 个 shader） |

`manifest.json` 记录每个文件的来源相对路径、字节数与 sha256，以及本地补丁清单。

## 为什么要 vendor 而不是 `import 'three'`

Client 半边由引擎以 **classic script** 形态下发，浏览器里既没有 import map 也没有 node_modules：
裸说明符 `three` / `three/addons/*` 在 `/energy-orb/assets/**` 下解析不了。所以生成时把
**所有** import 说明符改写成相对 URL，并由 Host 资产路由（`host/asset-route.js`，精确白名单）
逐个文件服务。闭包由脚本按 import 图遍历得出（不是手抄清单）——手抄清单漏一个文件，
生产环境就是 404。

## 本地补丁（唯一允许与上游分叉的地方）

| id | 文件 | 内容 |
| --- | --- | --- |
| `transparent-alpha-pass` | `sphere/energy-sphere.js` | 补 `ShaderPass` import |
| `transparent-alpha-pass-wire` | `sphere/energy-sphere.js` | 在 `OutputPass` 之后加末级 pass：**用亮度还原 alpha**，并把最外圈径向淡出 |

**为什么必须有这个补丁**：`UnrealBloomPass` 的辉光链会把整帧 alpha 写成 1。demo 的整页深色
背景看不出来，但在 DSH 里它就是一块**不透明深色方块**贴在右下角（对照
[`docs/verify/overlay-active-full.png`](../../docs/verify/overlay-active-full.png)）。
补丁后四角 alpha = 0（`scripts/verify-visual.mjs` 有一条专门的回归断言）。

机械环阵列约占半宽 0.82，淡出从 0.84 开始——所以**不会切到环**。

## 重新生成

```bash
# 默认源：../../dsh-fly/apps/energy-sphere-demo（需先在 demo 里 pnpm install --ignore-workspace）
node scripts/vendor-sphere.mjs
# 别处：
ENERGY_SPHERE_SRC=/abs/path/to/apps/energy-sphere-demo node scripts/vendor-sphere.mjs
node scripts/vendor-sphere.mjs --check     # 只校验，不写盘
```

上游 demo 改了视觉/参数时：先在 demo 里改、跑它的 `npm test` 与 `npm run verify:browser`，
再回来重跑本脚本；补丁的 `find` 文本若因上游改版失配，脚本会**报错退出**（不静默失效）。
