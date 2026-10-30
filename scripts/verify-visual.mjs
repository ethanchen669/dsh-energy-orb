// 视觉 probe（验收 A8）：真 OrbRenderer + vendored three 渲三态，落 docs/verify/，
// 并拼对照页 compare.png（上排渲染、下排 mockup 对照物）。
// file:// 下 ES module 受 CORS 限制，故起一个临时 loopback 静态服务器再加载。
// 用法：node scripts/verify-visual.mjs   （devDependency playwright-core）
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'docs', 'verify');
mkdirSync(OUT, { recursive: true });

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

const server = createServer((req, res) => {
  const rel = normalize(decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname));
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404);
    res.end('not-found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1620, height: 1000 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('[console]', m.text());
});

try {
  await page.goto(`http://127.0.0.1:${port}/scripts/fixture/visual.html`);
  await page.waitForFunction(() => window.__ready === true, { timeout: 15_000 });

  const ids = await page.evaluate(() => window.__ids);
  if (!Array.isArray(ids) || ids.length !== 3) {
    throw new Error(`fixture 应产出 3 个 id，实际 ${JSON.stringify(ids)}`);
  }
  // 合成器截图而非 toDataURL：additive 混合下 WebGL 画布的预乘 alpha
  // 在 toDataURL 反预乘时会把低 alpha 区域拉成白色（假象），页面上真实观感以合成器为准
  for (const id of ids) {
    const file = join(OUT, `orb-${id}.png`);
    await page.locator(`canvas[data-orb-id="${id}"]`).screenshot({ path: file });
    const size = statSync(file).size;
    if (size < 1000) throw new Error(`orb-${id}.png 过小（${size}B），疑似空画布`);
    console.log('✓', file, `${size}B`);
  }

  await page.locator('body').screenshot({ path: join(OUT, 'compare.png') });
  console.log('✓', join(OUT, 'compare.png'), '（上排=真渲染器三态，下排=mockup 对照物）');

  // A7：生命周期（真 DOM 数 [data-dsh-energy-orb-root]，apply→dispose→apply 两轮）
  await page.goto(`http://127.0.0.1:${port}/scripts/fixture/lifecycle.html`);
  await page.waitForFunction(() => window.__lifecycleReady === true, { timeout: 15_000 });
  const lc = await page.evaluate(() => window.__results);
  const expected = { afterMount1: 1, afterUnmount1: 0, afterMount2: 1, afterUnmount2: 0, uncaught: 0 };
  for (const [k, v] of Object.entries(expected)) {
    if (lc[k] !== v) throw new Error(`A7 生命周期 ${k}: 期望 ${v}，实际 ${lc[k]}（${JSON.stringify(lc)}）`);
  }
  console.log('✓ A7 生命周期：mount/unmount 两轮根元素计数 1/0/1/0', JSON.stringify(lc));
} finally {
  await browser.close();
  server.close();
}
