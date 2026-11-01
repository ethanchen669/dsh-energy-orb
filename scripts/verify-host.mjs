#!/usr/bin/env node
// 宿主级集成验证：用**宿主同一份 cordis + 同一份 dsh-host-webserver** 起一个真 HTTP 监听，
// 挂上本插件的 apply()，再从网络层验证「路由真的活着、资产真的发得出去、围栏真的拦得住」。
//
// 为什么需要它：真 GUI 实例在浏览器鉴权后面（`?token=` / 签名 cookie），裸 curl 拿不到；
// 而 `ctx.effect` / `ctx.inject` 这类接缝错误**只有在真 cordis 里才暴露**（桩会一路绿）。
// 这个脚本把「真 cordis + 真 webServer」留在本机可重复跑，不需要 GUI token、不占 3081。
//
// 用法：node scripts/verify-host.mjs
// 依赖：~/.dsh/profiles/node_modules 里的 @deepseek-ai/{cordis,dsh-host-webserver}
//      （或 npx 闭包里的同款；都找不到则显式失败，不静默跳过）
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';
import { ALLOWED_ASSETS, ASSET_PREFIX } from '../host/asset-route.js';
import { apply as applyHost } from '../index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✖'} ${name}${detail ? ` —— ${detail}` : ''}`);
}

/** 在 profile / npx 闭包里找引擎包；先试**调用方工作目录**（dsh-fly 门禁里 cwd 就是主仓根）。 */
function findPackage(relPath) {
  const candidates = [];
  try {
    candidates.push(createRequire(join(process.cwd(), 'package.json')).resolve(relPath));
  } catch { /* cwd 里没有就继续找 */ }
  if (process.env.DSH_PROFILE_DIR) candidates.push(join(process.env.DSH_PROFILE_DIR, 'node_modules', relPath));
  candidates.push(join(homedir(), '.dsh/profiles/node_modules', relPath));
  const npxRoot = join(homedir(), '.npm/_npx');
  if (existsSync(npxRoot)) {
    for (const dir of readdirSync(npxRoot)) candidates.push(join(npxRoot, dir, 'node_modules', relPath));
  }
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error(`找不到引擎包 ${relPath}（找了 ${candidates.length} 个位置）`);
  return hit;
}

const CORDIS = findPackage('@deepseek-ai/cordis/lib/index.js');
const WEBSERVER = findPackage('@deepseek-ai/dsh-host-webserver/lib/index.js');
console.log(`# cordis: ${CORDIS}`);
console.log(`# webServer: ${WEBSERVER}`);

const { Context } = await import(pathToFileURL(CORDIS).href);
const { default: webServerPlugin } = await import(pathToFileURL(WEBSERVER).href);

const ctx = new Context();
ctx.plugin(webServerPlugin, { host: '127.0.0.1', port: 0 });
const fiber = ctx.plugin({ name: 'dsh-energy-orb', apply: applyHost });

// 等 webServer 起来 + 注入回调跑完
let origin;
for (let i = 0; i < 100; i += 1) {
  await new Promise((r) => setTimeout(r, 40));
  origin = ctx.get('webServer')?.getOrigin?.();
  if (origin) break;
}
if (!origin) throw new Error('webServer 没有起来（挂载失败）');
console.log(`# 监听：${origin}`);

/** 裸 http 请求（可伪造 Host，fetch 做不到）。 */
function rawGet(path, { host } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, origin);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'GET',
      headers: host ? { host } : { host: u.host, 'sec-fetch-site': 'same-origin' },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

try {
  // ---- 1. 资产路由：15 个白名单资产全部 200 ----
  let bad = 0;
  for (const key of ALLOWED_ASSETS) {
    const r = await rawGet(`${ASSET_PREFIX}/${key}`);
    if (r.status !== 200 || r.body.length === 0) {
      bad += 1;
      check(`资产 ${key}`, false, `status=${r.status} bytes=${r.body.length}`);
    }
  }
  check(`资产路由：${ALLOWED_ASSETS.length} 个白名单资产全部 200`, bad === 0, `失败 ${bad} 个`);

  const sphere = await rawGet(`${ASSET_PREFIX}/sphere/energy-sphere.js`);
  check('球体模块内容正确（含 createEnergySphere + 透明画布补丁）',
    sphere.body.includes('createEnergySphere') && sphere.body.includes('transparentPass'),
    `${sphere.body.length}B`);
  const threeCore = await rawGet(`${ASSET_PREFIX}/vendor/three.core.min.js`);
  check('vendored three.core 可发（闭包的二级依赖也通）',
    threeCore.status === 200 && threeCore.body.includes('Three.js Authors') && threeCore.body.length > 300_000,
    `${threeCore.body.length}B`);
  check('资产响应带 JS content-type',
    String(sphere.headers['content-type']).includes('javascript'), String(sphere.headers['content-type']));

  const manifest = await rawGet(`${ASSET_PREFIX}/vendor/manifest.json`);
  check('白名单外 404（manifest 不对外）', manifest.status === 404 && manifest.body === 'not-found');

  const forged = await rawGet(`${ASSET_PREFIX}/sphere/energy-sphere.js`, { host: 'evil.example' });
  check('伪造 Host → 403 且不泄源码',
    forged.status === 403 && forged.body === 'forbidden: loopback-only',
    `status=${forged.status} body=${JSON.stringify(forged.body.slice(0, 30))}`);

  // ---- 2. 状态路由：契约 + 事件驱动 ----
  const idle = await rawGet('/api/energy-orb/state');
  const idleBody = JSON.parse(idle.body || '{}');
  check('状态路由 200 且字段齐全 (=/api 前缀不会抢走精确路由)',
    idle.status === 200
      && idleBody.version === 1
      && idleBody.active === false
      && idleBody.intensity === 0
      && idleBody.phase === 'idle'
      && typeof idleBody.updatedAt === 'number'
      && Date.now() - idleBody.updatedAt < 5_000,
    `${idle.status} ${JSON.stringify(idleBody)}`);

  ctx.emit('api-session/status', 'host-verify-1', true);
  const active = JSON.parse((await rawGet('/api/energy-orb/state')).body || '{}');
  check('running 事件 → active:true / phase active', active.active === true && active.phase === 'active',
    JSON.stringify(active));

  ctx.emit('api-session/status', 'host-verify-1', false);
  const back = JSON.parse((await rawGet('/api/energy-orb/state')).body || '{}');
  check('停止事件 → 回到 idle', back.active === false && back.phase === 'idle', JSON.stringify(back));

  // ---- 3. 卸载/重挂：路由随 fiber 撤销、再挂能回来（HMR 形状） ----
  await fiber.dispose();
  await new Promise((r) => setTimeout(r, 120));
  const afterDispose = await rawGet(`${ASSET_PREFIX}/sphere/energy-sphere.js`);
  const stateAfterDispose = await rawGet('/api/energy-orb/state');
  check('fiber dispose 后资产路由消失（注册真的被 effect 托管）',
    afterDispose.status === 404, `status=${afterDispose.status}`);
  check('fiber dispose 后状态路由消失', stateAfterDispose.status === 404, `status=${stateAfterDispose.status}`);

  const fiber2 = ctx.plugin({ name: 'dsh-energy-orb', apply: applyHost });
  await new Promise((r) => setTimeout(r, 200));
  const remounted = await rawGet(`${ASSET_PREFIX}/sphere/energy-sphere.js`);
  check('重新挂载后资产路由恢复（重复 apply 幂等）',
    remounted.status === 200 && remounted.body.includes('createEnergySphere'), `status=${remounted.status}`);
  await fiber2.dispose();
} finally {
  await new Promise((r) => setTimeout(r, 100));
  await ctx.stop?.();
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0
  ? `✓ verify-host 全绿（${results.length} 项，真 cordis + 真 webServer）`
  : `✖ verify-host ${failed.length}/${results.length} 项红`);
process.exit(failed.length === 0 ? 0 : 1);
