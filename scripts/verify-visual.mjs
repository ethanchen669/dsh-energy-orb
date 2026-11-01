// 视觉 / 动效 / 生命周期 probe（真实浏览器 + **真实资产路由**）。
//
// 为什么不是静态文件服务器：插件交付的浏览器链路是 `/energy-orb/assets/**` 路由 →
// 球体模块 → 相对 import 的 vendored three + addons 闭包。只有把 `registerAssetRoute` 的
// 真 handler 接进 probe 的服务器，这条链才**真的被验证**（静态目录能过、路由白名单漏一个
// 文件就 404 的失败形状，是两种不同的绿）。
//
// 用法：node scripts/verify-visual.mjs      （devDependency playwright-core）
// 产物：docs/verify/{sphere-idle,sphere-active,sphere-live}.png + compare.png
import { createRequire } from 'node:module';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './lib/fixture-server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'docs', 'verify');
mkdirSync(OUT, { recursive: true });

// 真资产路由 + 真状态路由 + 静态 fixture，全走 host 里那两份 handler
const server = await startFixtureServer(ROOT);
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
  await page.goto(`${base}/scripts/fixture/visual.html`);
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
  await comparePage.goto(`${base}/scripts/fixture/visual.html`);
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
  await page.goto(`${base}/scripts/fixture/lifecycle.html`);
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
    await page.goto(`${base}/scripts/fixture/overlay.html`);
    if (prefs) {
      await page.evaluate((p) => localStorage.setItem('energy-orb.display', JSON.stringify(p)), prefs);
      await page.goto(`${base}/scripts/fixture/overlay.html`);
    }
    await page.waitForFunction(() => window.__overlayReady === true, { timeout: 20_000 });
    const ready = await page.evaluate(() => window.__canvasReady);
    check('悬浮层：client.js → 资产路由 → 球体 canvas 就位', ready === true);
    await page.waitForTimeout(500);   // 让首帧 + 一次 ramp 走完
  };

  // 默认偏好（size 96 → 192×192）
  await openOverlay(null);
  const box = await page.evaluate(() => window.__rootBox);
  check('默认尺寸 192×192 且贴在右下角', box && box.width === 192 && box.height === 192 && box.right < 40 && box.bottom < 40,
    JSON.stringify(box));
  const idleOverlay = await page.evaluate(() => window.__readOrbPixels());
  check('悬浮层静息态有像素', !idleOverlay.error && idleOverlay.lit > 2000, JSON.stringify(idleOverlay));
  // 透明背景回归钉：bloom 链会把整帧 alpha 写成 1（宿主里就是一整块不透明深色方块）
  check('画布四角透明（不是不透明方块）', idleOverlay.cornerAlphaMax <= 8,
    `cornerAlphaMax=${idleOverlay.cornerAlphaMax} sample=${JSON.stringify(idleOverlay.cornerSample)}`);
  await page.locator('[data-dsh-energy-orb-root]').screenshot({ path: join(OUT, 'overlay-idle.png') });
  await page.screenshot({ path: join(OUT, 'overlay-idle-full.png') });

  // 翻成激活 → 等下一轮轮询（2s）+ ramp（420ms）→ 心跳必须起来
  await page.evaluate(async () => { await fetch('/__fixture/state?active=1'); });
  await page.waitForTimeout(3200);
  const activeOverlay = await page.evaluate(() => window.__readOrbPixels());
  check('悬浮层静息→激活：核心变大变亮（真轮询 + ramp 生效）',
    activeOverlay.coreMeanGreen > idleOverlay.coreMeanGreen * 1.15,
    `idle=${idleOverlay.coreMeanGreen.toFixed(1)} active=${activeOverlay.coreMeanGreen.toFixed(1)}`);
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
  await openOverlay({ size: 128, anchor: 'bottom-right', offset: { x: 0, y: 0 } });
  const bigBox = await page.evaluate(() => window.__rootBox);
  check('自定义尺寸生效（size 128 → 256×256）', bigBox && bigBox.width === 256 && bigBox.height === 256,
    JSON.stringify(bigBox));
  await page.locator('[data-dsh-energy-orb-root]').screenshot({ path: join(OUT, 'overlay-idle-256.png') });

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
