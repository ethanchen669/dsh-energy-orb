// 生成 README 里的「官方 UI 实拍」两张图：`vanilla-ui.png`（整窗）+ `vanilla-ui-close.png`（近景）。
//
// 为什么要真机实例而不是夹具：README 声称这两张是「纯净 DSH Web GUI，未加载任何皮肤」——
// 那就必须是一份**真 GUI** 的截图。做法是**一次性的 scratch home**（仓库外 mkdtemp）：
// 从 npm 装当前版本 → `dsh web --port 0` 起一个临时实例 → Playwright 截图 → 关掉、删干净。
// 不碰用户既有的 `~/.dsh`（配置安全纪律：绝不写用户的 profile）。
//
// 用法：
//   DSH_BIN=/path/to/dsh node scripts/shoot-vanilla-ui.mjs [版本]
//   —— DSH_BIN 缺省取 PATH 里的 `dsh`；版本缺省取 package.json 的 version。
// 产物：docs/images/{vanilla-ui,vanilla-ui-close}.png（DPR2，1440×900）
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'images');
const VERSION = process.argv[2] ?? JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const DSH = process.env.DSH_BIN ?? 'dsh';
mkdirSync(OUT, { recursive: true });

const home = mkdtempSync(join(tmpdir(), 'energy-orb-vanilla-'));
const env = { ...process.env, DSH_HOME: home };
let server = null;

function fail(message) {
  console.error(`✖ ${message}`);
  process.exitCode = 1;
}

try {
  // ① 装这一版（registry 上是带 provenance 的正式包；这里只为了"照着用户装法装"）
  const install = spawnSync(DSH, ['plugin', '--profile', 'web', 'add', `@dsh-fly/dsh-energy-orb@${VERSION}`,
    '--registry=https://registry.npmjs.org/'], { env, encoding: 'utf8' });
  if (install.status !== 0) throw new Error(`装包失败：${(install.stderr || install.stdout).slice(-800)}`);

  // ② 起临时 web 实例（--port 0 让 OS 选端口；机器上正式实例的端口不许占）
  server = spawn(DSH, ['web', '--port', '0', '--no-open'], { env, encoding: 'utf8' });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dsh web 15s 内没打印 URL')), 15_000);
    let buffer = '';
    server.stdout.on('data', (chunk) => {
      buffer += chunk;
      const match = buffer.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    server.on('exit', (code) => { clearTimeout(timer); reject(new Error(`dsh web 退出（${code}）：${buffer.slice(-500)}`)); });
  });

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
    await page.waitForSelector('[data-dsh-energy-orb-root] canvas', { timeout: 60_000 });
    await page.waitForTimeout(800);
    // 预览期公告：点 Continue 关掉（不点会留一层压暗，看不清悬浮层）
    const notice = page.locator('button:has-text("Continue")');
    if (await notice.count()) { await notice.first().click(); await page.waitForTimeout(1200); }
    await page.waitForTimeout(1500);       // 让首帧 + 一次 ramp 走完
    await page.screenshot({ path: join(OUT, 'vanilla-ui.png') });

    const box = await page.evaluate(() => {
      const r = document.querySelector('[data-dsh-energy-orb-root]').getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    if (box.width !== 240) fail(`悬浮层宽度应为 240（视图 1.25× 之后），实测 ${box.width}`);
    const padX = 120, padTop = 210, padBottom = 90;
    const x = Math.max(0, box.x - padX);
    const y = Math.max(0, box.y - padTop);
    await page.screenshot({
      path: join(OUT, 'vanilla-ui-close.png'),
      clip: {
        x, y,
        width: Math.min(1440 - x, box.width + padX * 2),
        height: Math.min(900 - y, box.height + padTop + padBottom),
      },
    });
    if (errors.length > 0) fail(`页面报错：${errors.join('; ')}`);
  } finally {
    await browser.close();
  }

  for (const name of ['vanilla-ui.png', 'vanilla-ui-close.png']) {
    const bytes = statSync(join(OUT, name)).size;
    if (bytes < 20_000) throw new Error(`${name} 太小（${bytes}B），疑似没渲染`);
    console.log(`✓ docs/images/${name} —— ${(bytes / 1024).toFixed(0)}KB`);
  }
  console.log(`✓ 官方 UI 实拍产出（版本 ${VERSION}，scratch home 已隔离）`);
} catch (error) {
  fail(error.message);
} finally {
  if (server) server.kill('SIGTERM');
  rmSync(home, { recursive: true, force: true });
}
