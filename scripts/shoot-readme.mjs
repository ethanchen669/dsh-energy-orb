// 生成 README 用的效果图（GitHub / npm 页共用一套，走绝对 raw URL）。
// 为什么单独一个脚本：README 图是**发布物的一部分**，要能一条命令重出，而不是"某次手工截的图"。
//
// 用法：node scripts/shoot-readme.mjs
// 产物：docs/images/{hero,states,overlay}.png
// 说明：DPR=1 出图（1200×630 / 1000×420 / 580×420）——README 只需屏幕级清晰度，
// 2× 渲染会让 PNG 大 4 倍（1.5MB），而 npm 页/README 都会被拖慢。
import { createRequire } from 'node:module';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './lib/fixture-server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'docs', 'images');
mkdirSync(OUT, { recursive: true });

const server = await startFixtureServer(ROOT);
const browser = await chromium.launch({
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors = [];

async function shootHero() {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => errors.push(`hero: ${e.message}`));
  await page.goto(`${server.origin}/scripts/fixture/readme-hero.html`);
  await page.waitForFunction(() => window.__ready === true, { timeout: 20_000 });
  await page.waitForTimeout(900);          // 让心跳跑到一个好看的相位
  const file = join(OUT, 'hero.png');
  await page.locator('body').screenshot({ path: file });
  await page.close();
  return file;
}

async function shootStates() {
  const page = await browser.newPage({ viewport: { width: 1000, height: 420 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => errors.push(`states: ${e.message}`));
  await page.goto(`${server.origin}/scripts/fixture/readme-states.html`);
  await page.waitForFunction(() => window.__ready === true, { timeout: 20_000 });
  await page.waitForTimeout(700);
  const file = join(OUT, 'states.png');
  await page.locator('#strip').screenshot({ path: file });
  await page.close();
  return file;
}

async function shootOverlay() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => errors.push(`overlay: ${e.message}`));
  await page.goto(`${server.origin}/scripts/fixture/overlay.html`);
  await page.waitForFunction(() => window.__overlayReady === true, { timeout: 20_000 });
  await page.evaluate(async () => { await fetch('/__fixture/state?active=1'); });
  await page.waitForTimeout(3200);         // 一轮轮询 + ramp
  const file = join(OUT, 'overlay.png');
  // 整页（模拟作战室）：让人一眼看清它贴在右下角、占多大、不挡内容
  await page.screenshot({ path: file });
  await page.close();
  return file;
}

try {
  const files = [await shootHero(), await shootStates(), await shootOverlay()];
  if (errors.length > 0) throw new Error(`页面报错：${errors.join('; ')}`);
  for (const file of files) {
    const bytes = statSync(file).size;
    if (bytes < 5000) throw new Error(`${file} 太小（${bytes}B），疑似没渲染`);
    console.log(`✓ ${file.replace(`${ROOT}/`, '')} —— ${(bytes / 1024).toFixed(0)}KB`);
  }
  console.log('✓ README 效果图全部产出');
} finally {
  await browser.close();
  await server.close();
}
