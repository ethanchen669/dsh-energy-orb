// 真 cordis 接线测试：用**宿主同一份 cordis**（4.x）跑我们的 apply()，而不是自造桩。
//
// 为什么必须有这一条：`ctx.effect(fn)` 的真语义是「立即执行 fn、把**返回值**当 disposer」。
// 我们曾经写成 `ctx.effect(() => { disposeX() })` —— 注册完当场把自己撤销，桩（只存不执行）
// 一路绿，真机却是：资产 404 → CSS 降级球、状态永远 idle → 球永远不动。
// 桩与真接缝不同形的失败方式就是这样静默的，所以这里直接上真货。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 找一份宿主用的 cordis：优先本仓 devDependency（CI 用），其次 profile，最后 npx 闭包。找不到就显式 skip（不静默）。 */
function findCordis() {
  const candidates = [];
  // CI：package.json 里的 devDependency（@deepseek-ai/cordis）
  try {
    candidates.push(fileURLToPath(import.meta.resolve('@deepseek-ai/cordis')));
  } catch { /* 没装就往后找 */ }
  if (process.env.DSH_PROFILE_DIR) {
    candidates.push(join(process.env.DSH_PROFILE_DIR, 'node_modules/@deepseek-ai/cordis/lib/index.js'));
  }
  candidates.push(join(homedir(), '.dsh/profiles/node_modules/@deepseek-ai/cordis/lib/index.js'));
  const npxRoot = join(homedir(), '.npm/_npx');
  if (existsSync(npxRoot)) {
    for (const dir of readdirSync(npxRoot)) {
      candidates.push(join(npxRoot, dir, 'node_modules/@deepseek-ai/cordis/lib/index.js'));
    }
  }
  return candidates.find((p) => existsSync(p));
}

const CORDIS = findCordis();
const SKIP = CORDIS ? false : '未找到 @deepseek-ai/cordis（profile 与 npx 闭包都没有）';

function trackWebServer() {
  const routes = [];
  const webServer = {
    register(route) {
      routes.push(route);
      return () => { route.disposed = true; };
    },
  };
  return { routes, webServer };
}

const loopbackReq = () => ({
  method: 'GET',
  headers: { host: '127.0.0.1:3081', 'sec-fetch-site': 'same-origin' },
  socket: { remoteAddress: '127.0.0.1' },
});
const mkRes = () => {
  const out = { status: 0, body: '' };
  return { out, writeHead(s) { out.status = s; }, end(b) { out.body = b ?? ''; } };
};

test('真 cordis：apply 后两条路由仍注册、事件仍订阅（不是注册完当场撤销）', { skip: SKIP }, async () => {
  const { Context } = await import(pathToFileURL(CORDIS).href);
  const mod = await import(join(ROOT, 'index.js'));
  const { routes, webServer } = trackWebServer();
  const ctx = new Context();
  ctx.provide('webServer', webServer);
  const fiber = ctx.plugin({ name: 'dsh-energy-orb', apply: mod.apply });
  await new Promise((r) => setTimeout(r, 80));

  assert.equal(routes.length, 2, `应注册两条路由，实际 ${routes.length}`);
  assert.equal(routes.filter((r) => !r.disposed).length, 2,
    'apply 之后路由必须仍然活着（effect 语义：回调立即执行、返回值才是 disposer）');

  // 事件 → 状态：真 ctx.emit 走一遍
  ctx.emit('api-session/status', 'real-1', true);
  const state = routes.find((r) => r.path === '/api/energy-orb/state');
  const res = mkRes();
  state.handler(loopbackReq(), res);
  assert.equal(res.out.status, 200);
  const body = JSON.parse(res.out.body);
  assert.equal(body.active, true, 'emit 了 running 事件后状态必须 active（订阅真的在）');

  ctx.emit('api-session/status', 'real-1', false);
  const idleRes = mkRes();
  state.handler(loopbackReq(), idleRes);
  assert.equal(JSON.parse(idleRes.out.body).active, false);

  // 资产路由：真 handler 能发出 vendored 文件
  const asset = routes.find((r) => r.path === '/energy-orb/assets');
  const assetRes = mkRes();
  await asset.handler({ ...loopbackReq(), url: '/energy-orb/assets/sphere/energy-sphere.js' }, assetRes);
  assert.equal(assetRes.out.status, 200, '资产路由应能取到球体模块');
  assert.match(String(assetRes.out.body), /createEnergySphere/);

  await fiber.dispose();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(routes.filter((r) => !r.disposed).length, 0, 'fiber dispose 后两条路由都应撤销');
});
