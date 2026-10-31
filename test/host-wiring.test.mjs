import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// fakeCtx 只按**真实接缝**造：webServer 经 ctx.inject(['webServer'], cb) 注入
// （dsh-market/lib/index.js:166 的实测姿势；直接 ctx.webServer 会 fiber failed）
function fakeCtx() {
  const routes = [];
  const listeners = [];
  const effects = [];
  const injections = [];
  const hostCtx = {
    webServer: {
      register(route) { routes.push(route); return () => { route.disposed = true; }; },
    },
  };
  return {
    routes, listeners, effects, injections,
    inject(names, cb) { injections.push([...names]); return cb(hostCtx); },
    on(name, fn) { listeners.push({ name, fn }); return () => {}; },
    effect(fn) { effects.push(fn); },
  };
}

test('apply() 经 ctx.inject([webServer]) 挂上状态路由 + 资产路由，并订阅 api-session/status', async () => {
  const mod = await import(join(ROOT, 'index.js'));
  assert.equal(typeof mod.apply, 'function');
  const ctx = fakeCtx();
  mod.apply(ctx);

  assert.deepEqual(ctx.injections, [['webServer']], '服务必须经 ctx.inject 获取（裸 ctx.webServer 会 fiber failed）');
  const paths = ctx.routes.map((r) => `${r.kind} ${r.path}`).sort();
  assert.deepEqual(paths, [
    'exact /api/energy-orb/state',
    'prefix /energy-orb/assets',
  ], `路由挂载不符：${JSON.stringify(paths)}`);

  const ev = ctx.listeners.find((l) => l.name === 'api-session/status');
  assert.ok(ev, '应订阅 api-session/status');
  ev.fn('s1', true);
  ev.fn('s1', false);

  assert.ok(ctx.effects.length >= 1, '注册应进 ctx.effect 托管');
});

test('apply() 注册的路由 handlers 行为正确（200 契约 / 403 围栏）', async () => {
  const mod = await import(join(ROOT, 'index.js'));
  const ctx = fakeCtx();
  mod.apply(ctx);
  const state = ctx.routes.find((r) => r.path === '/api/energy-orb/state');

  const mkRes = () => {
    const out = { status: 0, body: '' };
    return { out, writeHead(s) { out.status = s; }, end(b) { out.body = b ?? ''; } };
  };
  const loopback = { method: 'GET', headers: { host: '127.0.0.1:3081', 'sec-fetch-site': 'same-origin' }, socket: { remoteAddress: '127.0.0.1' } };

  const ok = mkRes();
  state.handler(loopback, ok);
  assert.equal(ok.out.status, 200);
  const j = JSON.parse(ok.out.body);
  assert.equal(j.version, 1);
  assert.ok(typeof j.updatedAt === 'number');

  const denied = mkRes();
  state.handler({ ...loopback, socket: { remoteAddress: '192.168.1.9' } }, denied);
  assert.equal(denied.out.status, 403);
  assert.equal(denied.out.body, 'forbidden: loopback-only');
});
