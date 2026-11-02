// 视觉 / 动效 / 生命周期 probe（真实浏览器 + **真实资产路由**）。
//
// 为什么不是静态文件服务器：插件交付的浏览器链路是 `/energy-orb/assets/**` 路由 →
// 球体模块 → 相对 import 的 vendored three + addons 闭包。只有把 `registerAssetRoute` 的
// 真 handler 接进 probe 的服务器，这条链才**真的被验证**（静态目录能过、路由白名单漏一个
// 文件就 404 的失败形状，是两种不同的绿）。
//
// 用法：node scripts/verify-visual.mjs          （默认产物写到 .tmp/verify/，不脏工作树）
//      node scripts/verify-visual.mjs --save     （写回 docs/verify/，用于更新对照图）
// 产物：{sphere-idle,sphere-active,sphere-live,sphere-pulse}.png + compare.png + overlay-*.png
import { createRequire } from 'node:module';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './lib/fixture-server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
// 默认落到 .tmp/（gitignored）：门禁会在任何仓里跑这个脚本，跑完不该把工作树弄脏。
// 需要更新对照图时显式 `--save`，写回 docs/verify/。
const SAVE = process.argv.includes('--save');
const OUT = SAVE ? join(ROOT, 'docs', 'verify') : join(ROOT, '.tmp', 'verify');
mkdirSync(OUT, { recursive: true });

// 真资产路由 + 真状态路由 + 静态 fixture，全走 host 里那两份 handler
const server = await startFixtureServer(ROOT);
// 本地夹具要在浏览器里解析 three.js + 初始化 WebGL：重载机器（实测 load ≈18）下 30s 默认超时不够，
// 统一放宽到 90s。这是尺子的韧性，不是把断言放松。
const NAV_TIMEOUT_MS = 90_000;
void NAV_TIMEOUT_MS;
const base = server.origin;

const browser = await chromium.launch({
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1620, height: 1100 }, deviceScaleFactor: 2 });
let pageErrors = [];
let consoleErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

function check(name, ok, detail = '') {
  console.log(`${ok ? '✓' : '✖'} ${name}${detail ? ` —— ${detail}` : ''}`);
  if (!ok) throw new Error(`${name}${detail ? `（${detail}）` : ''}`);
}

try {
  // ---------- ①三态渲染 + 动效 ----------
  await page.goto(`${base}/scripts/fixture/visual.html`, { timeout: 90_000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 20_000 });
  await page.waitForTimeout(400);

  const ids = await page.evaluate(() => window.__ids);
  check('fixture 产出四态', Array.isArray(ids) && ids.length === 4, JSON.stringify(ids));

  const stats = {};
  for (const id of ids) {
    stats[id] = await page.evaluate((v) => window.__readPixels(v), id);
    check(`${id} 画布真有像素（没渲染 = 全 0）`, !stats[id].error && stats[id].lit > 500,
      JSON.stringify(stats[id]));
  }
  check('激活比静息更大更亮（核心区绿通道均值）',
    stats.active.coreMeanGreen > stats.idle.coreMeanGreen * 1.2,
    `idle=${stats.idle.coreMeanGreen.toFixed(1)} active=${stats.active.coreMeanGreen.toFixed(1)}`);

  // 动效：运行中的球两帧必须不同；paused 的球两帧必须相同
  const liveA = await page.evaluate(() => window.__readPixels('live'));
  const pausedA = await page.evaluate(() => window.__readPixels('active'));
  await page.waitForTimeout(320);
  const liveB = await page.evaluate(() => window.__readPixels('live'));
  const pausedB = await page.evaluate(() => window.__readPixels('active'));
  check('运行中的球在动（两帧指纹不同 —— 这条就是「没有动效」的回归钉）',
    liveA.fingerprint !== liveB.fingerprint, `${liveA.fingerprint} vs ${liveB.fingerprint}`);
  check('paused 的球静止（两帧指纹相同）', pausedA.fingerprint === pausedB.fingerprint);

  // 手动脉冲：在**静止基线**上量（paused + 关心跳，唯一变量就是 pulse 本身）
  const beforePulse = await page.evaluate(() => window.__readPixels('pulse'));
  await page.evaluate(() => window.__pulse('pulse', 2));
  await page.waitForTimeout(140);
  const afterPulse = await page.evaluate(() => window.__readPixels('pulse'));
  check('pulse 后核心变亮（可见的充能反馈）',
    afterPulse.coreMeanGreen > beforePulse.coreMeanGreen * 1.02,
    `${beforePulse.coreMeanGreen.toFixed(1)} → ${afterPulse.coreMeanGreen.toFixed(1)}`);
  await page.waitForTimeout(900);   // 等脉冲衰减完，别污染后面的静止基线量

  // 静止态也能被 update 重绘（paused 不等于「参数改了不画」）
  const stillA = await page.evaluate(() => window.__readPixels('active'));
  await page.evaluate(() => window.__update('active', { coreBrightness: 0.2 }));
  await page.waitForTimeout(120);
  const stillB = await page.evaluate(() => window.__readPixels('active'));
  check('paused 时 update() 立即重绘（参数更新不被冻结）',
    stillB.coreMeanGreen < stillA.coreMeanGreen * 0.8,
    `${stillA.coreMeanGreen.toFixed(1)} → ${stillB.coreMeanGreen.toFixed(1)}`);

  for (const id of ids) {
    const file = join(OUT, `sphere-${id}.png`);
    await page.locator(`[data-stage-id="${id}"]`).screenshot({ path: file });
    const size = statSync(file).size;
    check(`${file} 非空（>1KB）`, size > 1000, `${size}B`);
  }
  // 对照页单独用 DPR1 拍：只为存档，不需要 2 倍分辨率（否则一张图 2.8MB 进仓库）
  const comparePage = await browser.newPage({ viewport: { width: 1620, height: 1100 }, deviceScaleFactor: 1 });
  await comparePage.goto(`${base}/scripts/fixture/visual.html`, { timeout: 90_000 });
  await comparePage.waitForFunction(() => window.__ready === true, { timeout: 20_000 });
  await comparePage.waitForTimeout(400);
  await comparePage.locator('body').screenshot({ path: join(OUT, 'compare.png') });
  await comparePage.close();
  check('对照图 compare.png 已落盘（下排 = demo 定稿预览）', existsSync(join(OUT, 'compare.png')));

  check('视觉页无未捕获异常', pageErrors.length === 0, pageErrors.join('; '));
  check('视觉页无 console.error', consoleErrors.length === 0, consoleErrors.join('; '));

  // ---------- ②生命周期（真组件 + 真球体 + 真资产路由） ----------
  pageErrors = [];
  consoleErrors = [];
  await page.goto(`${base}/scripts/fixture/lifecycle.html`, { timeout: 90_000 });
  await page.waitForFunction(() => window.__lifecycleReady === true, { timeout: 30_000 });
  const lc = await page.evaluate(() => window.__results);
  const expected = {
    afterMount1: 1, afterUnmount1: 0, afterMount2: 1, afterUnmount2: 0,
    canvasAfterMount1: 1, canvasAfterUnmount1: 0,
    canvasAfterMount2: 1, canvasAfterUnmount2: 0,
    fallbackAfterMount1: 0,
    uncaught: 0,
  };
  for (const [k, v] of Object.entries(expected)) {
    check(`A7 生命周期 ${k}`, lc[k] === v, `期望 ${v}，实际 ${lc[k]}（${JSON.stringify(lc)}）`);
  }
  check('挂载出的是真 WebGL 画布（不是降级球）', lc.stageSrc === 'CANVAS', String(lc.stageSrc));
  check('生命周期页无未捕获异常', pageErrors.length === 0, pageErrors.join('; '));
  check('生命周期页无 console.error', consoleErrors.length === 0, consoleErrors.join('; '));

  // ---------- ③悬浮层真尺寸（用户真正看到的那个右下角小球） ----------
  pageErrors = [];
  consoleErrors = [];
  await page.setViewportSize({ width: 1280, height: 800 });

  const openOverlay = async (prefs) => {
    await page.goto(`${base}/scripts/fixture/overlay.html`, { timeout: 90_000 });
    if (prefs) {
      await page.evaluate((p) => localStorage.setItem('energy-orb.display', JSON.stringify(p)), prefs);
      await page.goto(`${base}/scripts/fixture/overlay.html`, { timeout: 90_000 });
    }
    await page.waitForFunction(() => window.__overlayReady === true, { timeout: 20_000 });
    const ready = await page.evaluate(() => window.__canvasReady);
    check('悬浮层：client.js → 资产路由 → 球体 canvas 就位', ready === true);
    await page.waitForTimeout(500);   // 让首帧 + 一次 ramp 走完
  };

  // 默认偏好（size 120 → 240×240；视图整体等比放大 1.25× 之后的口径）
  await openOverlay(null);
  const box = await page.evaluate(() => window.__rootBox);
  check('默认尺寸 240×240 且贴在右下角', box && box.width === 240 && box.height === 240 && box.right < 40 && box.bottom < 40,
    JSON.stringify(box));
  const idleOverlay = await page.evaluate(() => window.__readOrbPixels());
  check('悬浮层静息态有像素', !idleOverlay.error && idleOverlay.lit > 2000, JSON.stringify(idleOverlay));
  // **合成可见性**（真机事故的回归钉）：`readPixels` 读的是绘图缓冲，CSS 把画布裁掉它也照样"有像素"。
  // 两个不变量：①画布必须完整落在根盒子内（不许被 overflow 裁掉）；②元素截图里真的看得见东西。
  const boxGeometry = await page.evaluate(() => {
    const root = document.querySelector('[data-dsh-energy-orb-root]').getBoundingClientRect();
    const canvas = document.querySelector('[data-dsh-energy-orb-root] canvas').getBoundingClientRect();
    return {
      root: { x: root.x, y: root.y, w: root.width, h: root.height },
      canvas: { x: canvas.x, y: canvas.y, w: canvas.width, h: canvas.height },
    };
  });
  check('画布完整落在悬浮层盒子里（没被 overflow 裁到盒外）',
    boxGeometry.canvas.x >= boxGeometry.root.x - 1 && boxGeometry.canvas.y >= boxGeometry.root.y - 1
      && boxGeometry.canvas.x + boxGeometry.canvas.w <= boxGeometry.root.x + boxGeometry.root.w + 1
      && boxGeometry.canvas.y + boxGeometry.canvas.h <= boxGeometry.root.y + boxGeometry.root.h + 1,
    JSON.stringify(boxGeometry));
  const overlayShot = await page.locator('[data-dsh-energy-orb-root]').screenshot({ omitBackground: true });
  const visiblePixels = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let opaque = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 24) opaque += 1;
    return { opaque, total: canvas.width * canvas.height };
  }, overlayShot.toString('base64'));
  check('合成图里球真的可见（元素截图不透明像素 > 2000）', visiblePixels.opaque > 2000, JSON.stringify(visiblePixels));
  // 透明背景回归钉：bloom 链会把整帧 alpha 写成 1（宿主里就是一整块不透明深色方块）
  check('画布四角透明（不是不透明方块）', idleOverlay.cornerAlphaMax <= 8,
    `cornerAlphaMax=${idleOverlay.cornerAlphaMax} sample=${JSON.stringify(idleOverlay.cornerSample)}`);
  await page.locator('[data-dsh-energy-orb-root]').screenshot({ path: join(OUT, 'overlay-idle.png') });
  await page.screenshot({ path: join(OUT, 'overlay-idle-full.png') });

  // 翻成激活 → 等下一轮轮询（2s）+ ramp（420ms）→ 心跳必须起来
  await page.evaluate(async () => { await fetch('/__fixture/state?active=1'); });
  await page.waitForTimeout(3200);
  const activeOverlay = await page.evaluate(() => window.__readOrbPixels());
  // 口径变化（2026-11-02）：运行态亮度按用户要求降到原来的一半 ⇒ "变亮"不再是状态信号，
  // 状态信号改成"足迹变大 + 不比静息暗"；亮度数值本身由 sphere-mapping 的单测钉着（0.5 / 0.65 / 0.8）。
  check('悬浮层静息→激活：核心足迹变大、且不比静息暗（真轮询 + ramp 生效）',
    activeOverlay.lit > idleOverlay.lit * 1.05 && activeOverlay.coreMeanGreen >= idleOverlay.coreMeanGreen * 0.98,
    `lit idle=${idleOverlay.lit} active=${activeOverlay.lit} | coreMeanGreen idle=${idleOverlay.coreMeanGreen.toFixed(1)} active=${activeOverlay.coreMeanGreen.toFixed(1)}`);
  await page.locator('[data-dsh-energy-orb-root]').screenshot({ path: join(OUT, 'overlay-active.png') });
  await page.screenshot({ path: join(OUT, 'overlay-active-full.png') });

  // 激活前后两帧必须不同（心跳在跑），静息两帧必须相同（心跳关掉）
  const actA = await page.evaluate(() => window.__readOrbPixels());
  await page.waitForTimeout(260);
  const actB = await page.evaluate(() => window.__readOrbPixels());
  check('悬浮层激活态在动（心跳）', actA.coreMeanGreen !== actB.coreMeanGreen || actA.lit !== actB.lit,
    `${actA.coreMeanGreen.toFixed(1)} vs ${actB.coreMeanGreen.toFixed(1)}`);

  await page.evaluate(async () => { await fetch('/__fixture/state?active=0'); });
  await page.waitForTimeout(3200);
  const backIdle = await page.evaluate(() => window.__readOrbPixels());
  check('激活→静息：核心缩回、辉光回落',
    backIdle.coreMeanGreen < activeOverlay.coreMeanGreen * 0.95,
    `active=${activeOverlay.coreMeanGreen.toFixed(1)} idle=${backIdle.coreMeanGreen.toFixed(1)}`);
  const idleA = await page.evaluate(() => window.__readOrbPixels());
  await page.waitForTimeout(260);
  const idleB = await page.evaluate(() => window.__readOrbPixels());
  check('静息态核心不涨缩（心跳已关）',
    Math.abs(idleA.coreMeanGreen - idleB.coreMeanGreen) < 0.5,
    `${idleA.coreMeanGreen.toFixed(2)} vs ${idleB.coreMeanGreen.toFixed(2)}`);

  // 更大尺寸（size 128 → 256×256）再拍一张，供用户判断"够不够看得清"
  // 传 v:2（当前存档版本）：否则会走一次旧存档迁移 ×1.25，128 会变成 160
  await openOverlay({ v: 2, size: 128, anchor: 'bottom-right', offset: { x: 0, y: 0 } });
  const bigBox = await page.evaluate(() => window.__rootBox);
  check('自定义尺寸生效（size 128 → 256×256）', bigBox && bigBox.width === 256 && bigBox.height === 256,
    JSON.stringify(bigBox));
  await page.locator('[data-dsh-energy-orb-root]').screenshot({ path: join(OUT, 'overlay-idle-256.png') });

  // ---------- ③ 隐藏 / 展开（真实的点击路径，不是读 state） ----------
  await openOverlay(null);                       // 干净的默认偏好
  const expanded = await page.evaluate(() => {
    const root = document.querySelector('[data-dsh-energy-orb-root]');
    const stage = root.querySelector('[data-dsh-energy-orb-stage]');
    const handle = root.querySelector('[data-dsh-energy-orb-handle]');
    const hide = root.querySelector('[data-dsh-energy-orb-hide]');
    return {
      collapsed: root.getAttribute('data-dsh-energy-orb-collapsed'),
      stageOpacity: stage ? Number(getComputedStyle(stage).opacity) : -1,
      stageTransformOrigin: stage ? getComputedStyle(stage).transformOrigin : '(缺)',
      handleOpacity: handle ? Number(getComputedStyle(handle).opacity) : -1,
      hideDisplay: hide ? getComputedStyle(hide).display : '(缺)',
      hideAria: hide ? hide.getAttribute('aria-label') : '(缺)',
    };
  });
  check('默认展开：舞台 1:1 不透明、隐藏按钮在、把手透明',
    expanded.collapsed === 'false' && expanded.stageOpacity === 1 && expanded.handleOpacity === 0
      && expanded.hideDisplay !== 'none' && expanded.hideAria === '隐藏能量球',
    JSON.stringify(expanded));
  // 收起方向：缩放原点必须落在 × 所在的角（盒子右上角），否则"缩进角落"缩错了地方
  // 计算值形如 "240px 0px"（x 在右边、y 在顶部）；收起方向必须朝 × 的那个角
  check('舞台缩放原点是 × 所在的右上角（收起朝那里缩）',
    (() => {
      const [ox, oy] = String(expanded.stageTransformOrigin).split(' ').map(parseFloat);
      const width = parseFloat(expanded.stageTransformOrigin.split(' ')[0]) || 0;
      const rootWidth = 240;
      return Math.abs(ox - width) < 0.01 && Math.abs(oy) < 2 && Math.abs(ox - rootWidth) < 40;
    })(),
    expanded.stageTransformOrigin);

  // × 的悬浮提示：hover 之前 opacity 0，hover 之后可见且文字是「隐藏 / hide」
  const tipIdle = await page.evaluate(() => {
    const label = document.querySelector('[data-dsh-energy-orb-hide-label]');
    return label ? { text: label.textContent, opacity: getComputedStyle(label).opacity } : null;
  });
  check('× 按钮带悬浮提示节点，默认不可见',
    tipIdle && tipIdle.text === '隐藏 / hide' && Number(tipIdle.opacity) === 0, JSON.stringify(tipIdle));
  const hideBox = await page.locator('[data-dsh-energy-orb-hide]').boundingBox();
  await page.mouse.move(hideBox.x + hideBox.width / 2, hideBox.y + hideBox.height / 2);
  // 等**状态**而不是等时间：负载高时 140ms 的 opacity 过渡可能还没跑完就读到 0.12
  await page.waitForFunction(() => {
    const label = document.querySelector('[data-dsh-energy-orb-hide-label]');
    return Boolean(label) && Number(getComputedStyle(label).opacity) > 0.9;
  }, { timeout: 5_000 });
  const tipHover = await page.evaluate(() => {
    const label = document.querySelector('[data-dsh-energy-orb-hide-label]');
    const button = document.querySelector('[data-dsh-energy-orb-hide]');
    const rect = label.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    return {
      opacity: Number(getComputedStyle(label).opacity),
      text: label.textContent,
      inside: rect.width > 0 && rect.height > 0,
      leftOfButton: rect.right <= buttonRect.left + 1,      // 提示在 × 的左侧，不压住球
      buttonHovered: button.matches(':hover'),
      rootHovered: document.querySelector('[data-dsh-energy-orb-root]').matches(':hover'),
      // 原生 title 会再弹一个系统 tooltip（截图里一灰一青两个框）——这里显式钉住"没有 title"
      nativeTitle: button.getAttribute('title'),
    };
  });
  check('hover 到 × 上 → 只出现「隐藏 / hide」自绘提示（无原生 title 叠影）',
    tipHover.opacity > 0.9 && tipHover.text === '隐藏 / hide' && tipHover.inside && tipHover.leftOfButton
      && tipHover.nativeTitle === null,
    JSON.stringify(tipHover));

  // hover 才显形是"视觉"里的细节，这里只断言按钮存在且可点（真点击）
  // 收起途中采样必须在**页面内**按帧记录：host 侧轮询在慢机器上等第一帧时过渡已经结束，
  // 会读到"全是 40"的假轨迹（门禁里就这样误红过一次）。rAF 记录器在点击前挂上，点击后再取。
  const startRecorder = () => page.evaluate(() => {
    window.__collapseTrail = [];
    const t0 = performance.now();
    const tick = () => {
      const root = document.querySelector('[data-dsh-energy-orb-root]');
      if (root) {
        const r = root.getBoundingClientRect();
        window.__collapseTrail.push({ t: performance.now() - t0, top: r.top, right: r.right, width: r.width });
      }
      if (performance.now() - t0 < 700) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const stopRecorder = () => page.evaluate(() => window.__collapseTrail ?? []);
  await startRecorder();
  await page.locator('[data-dsh-energy-orb-hide]').click({ force: true });
  // 尺寸是 220ms 的 CSS 过渡：负载高时固定 sleep 会在过渡中途读到旧宽度，
  // 所以这里等"真的到 40px"（等状态，不猜时间）
  await page.waitForFunction(() => {
    const root = document.querySelector('[data-dsh-energy-orb-root]');
    return Boolean(root) && Math.round(root.getBoundingClientRect().width) === 40;
  }, { timeout: 5_000 });
  const collapsedState = await page.evaluate(() => {
    const root = document.querySelector('[data-dsh-energy-orb-root]');
    const stage = root.querySelector('[data-dsh-energy-orb-stage]');
    const handle = root.querySelector('[data-dsh-energy-orb-handle]');
    const box = root.getBoundingClientRect();
    return {
      collapsed: root.getAttribute('data-dsh-energy-orb-collapsed'),
      stageOpacity: stage ? Number(getComputedStyle(stage).opacity) : -1,
      stageTransform: stage ? getComputedStyle(stage).transform : '(缺)',
      stageTransition: stage ? getComputedStyle(stage).transitionDuration : '(缺)',
      handleOpacity: handle ? Number(getComputedStyle(handle).opacity) : -1,
      handlePointer: handle ? getComputedStyle(handle).pointerEvents : '(缺)',
      width: Math.round(box.width),
      height: Math.round(box.height),
      saved: JSON.parse(localStorage.getItem('energy-orb.display') ?? 'null'),
    };
  });
  // 过渡末帧可能停在 0.999 之类：断言用"已基本到位"的阈值，不用浮点严格相等
  check('点隐藏 → 折叠成 40px 把手、舞台缩小淡出、状态落盘',
    collapsedState.collapsed === 'true' && collapsedState.stageOpacity < 0.02
      && collapsedState.stageTransform !== 'none' && collapsedState.handleOpacity > 0.98
      && collapsedState.width === 40 && collapsedState.height === 40 && collapsedState.saved?.collapsed === true,
    JSON.stringify(collapsedState));

  const collapseTrail = await stopRecorder();
  const collapseTopDelta = Math.max(...collapseTrail.map((r) => Math.abs(r.top - collapseTrail[0].top)));
  const collapseRightDelta = Math.max(...collapseTrail.map((r) => Math.abs(r.right - collapseTrail[0].right)));
  const collapseWidths = collapseTrail.map((r) => r.width);
  const collapseFull = collapseWidths[0];
  const midCollapse = collapseWidths.filter((w) => w > 40.5 && w < collapseFull - 0.5);
  // 兜底：极重负载下 rAF 可能一帧都没落在过渡中间；那时用"根节点确实声明了 width 过渡"作为证据，
  // 并把这条如实写进 detail —— 不能因为没有中间帧就当成"没动画"（也不能反过来假绿）。
  const collapseTransitionDeclared = await page.evaluate(() => {
    const root = document.querySelector('[data-dsh-energy-orb-root]');
    return getComputedStyle(root).transitionProperty.includes('width');
  });
  check('收起朝 × 所在的右上角：上边/右边全程钉住、宽度单调收缩',
    collapseTopDelta <= 1.5 && collapseRightDelta <= 1.5
      && collapseWidths.every((w, i) => i === 0 || w <= collapseWidths[i - 1] + 0.5)
      && collapseWidths[collapseWidths.length - 1] < collapseFull - 100
      && (midCollapse.length > 0 || collapseTransitionDeclared),
    `topΔ=${collapseTopDelta.toFixed(1)} rightΔ=${collapseRightDelta.toFixed(1)} 宽度 ${collapseWidths.map((w) => Math.round(w)).join('→')}`
      + `（中间帧 ${midCollapse.length}${midCollapse.length === 0 ? '，退化为"过渡已声明"判据' : ''}）`);


  const expectedExpandedWidth = await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('energy-orb.display') ?? 'null');
    return (saved?.size ?? 120) * 2;
  });
  await startRecorder();                       // 记录器挂在**真正会展开的那一次**点击之前
  await page.locator('[data-dsh-energy-orb-handle]').click();
  await page.waitForFunction((expected) => {
    const root = document.querySelector('[data-dsh-energy-orb-root]');
    return Boolean(root) && Math.round(root.getBoundingClientRect().width) === expected;
  }, expectedExpandedWidth, { timeout: 5_000 });
  const reExpanded = await page.evaluate(() => {
    const root = document.querySelector('[data-dsh-energy-orb-root]');
    const stage = root.querySelector('[data-dsh-energy-orb-stage]');
    const handle = root.querySelector('[data-dsh-energy-orb-handle]');
    const box = root.getBoundingClientRect();
    return {
      collapsed: root.getAttribute('data-dsh-energy-orb-collapsed'),
      hasCanvas: Boolean(stage && stage.querySelector('canvas')),
      stageOpacity: stage ? Number(getComputedStyle(stage).opacity) : -1,
      stageTransition: stage ? getComputedStyle(stage).transitionDuration : '(缺)',
      handleOpacity: handle ? Number(getComputedStyle(handle).opacity) : -1,
      width: Math.round(box.width),
      saved: JSON.parse(localStorage.getItem('energy-orb.display') ?? 'null'),
    };
  });
  check('点把手 → 展开回原尺寸、舞台放大淡入、球体恢复渲染、状态落盘',
    reExpanded.collapsed === 'false' && reExpanded.hasCanvas && reExpanded.stageOpacity > 0.98
      && reExpanded.handleOpacity < 0.02 && reExpanded.width === reExpanded.saved.size * 2
      && reExpanded.saved?.collapsed === false,
    JSON.stringify(reExpanded));

  const expandTrail = await stopRecorder();
  const expandTopDelta = Math.max(...expandTrail.map((r) => Math.abs(r.top - expandTrail[0].top)));
  const expandRightDelta = Math.max(...expandTrail.map((r) => Math.abs(r.right - expandTrail[0].right)));
  const expandWidths = expandTrail.map((r) => r.width);
  const expandFull = expandWidths[expandWidths.length - 1];
  const midExpand = expandWidths.filter((w) => w > 40.5 && w < expandFull - 0.5);
  const expandTransitionDeclared = await page.evaluate(() => {
    const root = document.querySelector('[data-dsh-energy-orb-root]');
    return getComputedStyle(root).transitionProperty.includes('width');
  });
  check('展开是收起的逆过程：上边/右边一样钉住、宽度单调变大',
    expandTopDelta <= 1.5 && expandRightDelta <= 1.5
      && expandWidths.every((w, i) => i === 0 || w >= expandWidths[i - 1] - 0.5)
      && expandFull > expandWidths[0] + 100
      && (midExpand.length > 0 || expandTransitionDeclared),
    `topΔ=${expandTopDelta.toFixed(1)} rightΔ=${expandRightDelta.toFixed(1)} 宽度 ${expandWidths.map((w) => Math.round(w)).join('→')}`
      + `（中间帧 ${midExpand.length}${midExpand.length === 0 ? '，退化为"过渡已声明"判据' : ''}）`);

  check('折叠/展开是同一组过渡（正向与逆向的 transition-duration 相同）',
    collapsedState.stageTransition === reExpanded.stageTransition && collapsedState.stageTransition !== '0s',
    `collapsed=${collapsedState.stageTransition} expanded=${reExpanded.stageTransition}`);

  // ---- 折叠态拖拽（放在动效断言之后：拖拽会改 offset，先做会干扰"上边/右边钉住"的判定）----
  await page.locator('[data-dsh-energy-orb-hide]').click({ force: true });
  await page.waitForFunction(() => Math.round(document.querySelector('[data-dsh-energy-orb-root]').getBoundingClientRect().width) === 40, { timeout: 5_000 });
  await page.waitForTimeout(250);
  // 折叠态也要能拖：按住把手移动 60×40 → 位置变、仍是折叠态、不展开
  const beforeDrag = await page.evaluate(() => JSON.parse(localStorage.getItem('energy-orb.display') ?? 'null'));
  const beforeDragRect = await page.evaluate(() => {
    const box = document.querySelector('[data-dsh-energy-orb-root]').getBoundingClientRect();
    return { x: Math.round(box.x), y: Math.round(box.y) };
  });
  const handleBox = await page.locator('[data-dsh-energy-orb-handle]').boundingBox();
  await page.evaluate(() => {
    window.__dragLag = null;
    const samples = [];
    let cursor = null;
    const t0 = performance.now();
    window.addEventListener('pointermove', (e) => { cursor = { x: e.clientX, y: e.clientY }; }, true);
    const tick = () => {
      const box = document.querySelector('[data-dsh-energy-orb-root]').getBoundingClientRect();
      if (cursor) samples.push({ cx: cursor.x, cy: cursor.y, x: box.x, y: box.y });
      if (performance.now() - t0 < 1500) requestAnimationFrame(tick);
      else if (samples.length > 3) {
        const s0 = samples[0];
        const devs = samples.map((r) => Math.hypot((r.cx - s0.cx) - (r.x - s0.x), (r.cy - s0.cy) - (r.y - s0.y)));
        window.__dragLag = { maxLagPx: Math.max(...devs), samples: samples.length };
      }
    };
    requestAnimationFrame(tick);
  });
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 - 60, handleBox.y + handleBox.height / 2 - 40, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(1500);        // 等跟手性采样窗口跑完（1.5s）
  const afterDrag = await page.evaluate(() => {
    const root = document.querySelector('[data-dsh-energy-orb-root]');
    const box = root.getBoundingClientRect();
    return {
      prefs: JSON.parse(localStorage.getItem('energy-orb.display') ?? 'null'),
      collapsedAttr: root.getAttribute('data-dsh-energy-orb-collapsed'),
      width: Math.round(box.width),
      // 盒子**真的挪了**才算拖成功（只改 localStorage 不算：fixture 不重渲染时曾经"拖了没反应"）
      x: Math.round(box.x), y: Math.round(box.y),
    };
  });
  check('折叠态按住把手拖拽 → 盒子真的移动、仍是折叠态（没被误触展开）',
    afterDrag.prefs && (afterDrag.prefs.offset.x !== beforeDrag?.offset.x || afterDrag.prefs.offset.y !== beforeDrag?.offset.y)
      && afterDrag.collapsedAttr === 'true' && afterDrag.width === 40
      && (afterDrag.x !== beforeDragRect?.x || afterDrag.y !== beforeDragRect?.y),
    `offset ${JSON.stringify(beforeDrag?.offset)} → ${JSON.stringify(afterDrag.prefs?.offset)}, 位置 (${beforeDragRect?.x},${beforeDragRect?.y}) → (${afterDrag.x},${afterDrag.y}), collapsed=${afterDrag.collapsedAttr}`);

  // 说明：拖拽期间把手跟着光标走，所以拖拽自身会补一个 click（已被 swallowed），
  // 这里再点一次就是"用户真的想展开" —— 该展开。"拖拽尾巴不展开"的语义由 node 单测覆盖。
  await page.locator('[data-dsh-energy-orb-handle]').click();
  await page.waitForTimeout(350);
  // 跟手性：拖拽期间"盒子位移"与"光标位移"的偏差峰值必须很小（>30px 就说明被定位过渡拖住了）
  const followLag = await page.evaluate(() => window.__dragLag ?? null);
  check('拖拽跟手（盒子位移 vs 光标位移 偏差 < 20px）',
    followLag !== null && followLag.maxLagPx < 20,
    followLag ? `maxLag=${followLag.maxLagPx.toFixed(1)}px samples=${followLag.samples}` : '(没采到)');



  check('悬浮层无未捕获异常', pageErrors.length === 0, pageErrors.join('; '));
  check('悬浮层无 console.error', consoleErrors.length === 0, consoleErrors.join('; '));

  console.log(JSON.stringify({
    ok: true, stats, lifecycle: lc,
    overlay: { box, idle: idleOverlay, active: activeOverlay, backIdle, bigBox },
    out: OUT,
  }, null, 2));
} finally {
  await browser.close();
  await server.close();
}
