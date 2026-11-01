import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// fakeCtx 必须与**真 cordis 的接缝同形**（这条纪律是血的教训）：
// 真 cordis 4.0.5 的 `ctx.effect(execute)` **立即执行** execute，并把它的**返回值**当 disposer。
// 早期这里的桩只把 fn 存起来不执行，于是「注册完立刻被自己撤销」这种 bug 一路绿着进了真机
// （表现：资产路由 404 → CSS 降级球、状态永远 idle → 球永远静止）。
function fakeCtx() {
  const routes = [];
  const listeners = [];
  const disposers = [];
  const injections = [];
  const hostCtx = {
    webServer: {
      register(route) {
        routes.push(route);
        return () => { route.disposed = true; };
      },
    },
  };
  return {
    routes, listeners, disposers, injections,
    inject(names, cb) { injections.push([...names]); return cb(hostCtx); },
    on(name, fn) {
      listeners.push({ name, fn });
      return () => {
        const at = listeners.findIndex((l) => l.fn === fn);
        if (at >= 0) listeners.splice(at, 1);
      };
    },
    effect(execute) {
      const result = execute();                       // 真 cordis：立即执行
      if (typeof result === 'function') disposers.push(result);
      return result;
    },
    disposeAll() {
      for (const d of disposers.splice(0).reverse()) d();
    },
  };
}

test('apply() 经 ctx.inject([webServer]) 挂上状态路由 + 资产路由，并订阅 api-session/status', async () => {
  const mod = await import(join(ROOT, 'index.js'));
  assert.equal(typeof mod.apply, 'function');
  const ctx = fakeCtx();
  mod.apply(ctx);

  assert.deepEqual(ctx.injections, [['webServer']], '服务必须经 ctx.inject 获取（裸 ctx.webServer 会 fiber failed）');

  assert.equal(ctx.routes.length, 2, `应注册两条路由，实际 ${ctx.routes.length}`);
  const live = ctx.routes.filter((r) => !r.disposed);
  assert.equal(live.length, 2, 'apply 返回后两条路由都必须**还在**（effect 回调不能当场撤销自己）');
  const paths = live.map((r) => `${r.kind} ${r.path}`).sort();
  assert.deepEqual(paths, [
    'exact /api/energy-orb/state',
    'prefix /energy-orb/assets',
  ], `路由挂载不符：${JSON.stringify(paths)}`);

  const ev = ctx.listeners.find((l) => l.name === 'api-session/status');
  assert.ok(ev, 'apply 返回后必须仍订阅 api-session/status（否则状态永远 idle、球永远不动）');
  ev.fn('s1', true);
  ev.fn('s1', false);
});

test('卸载时把路由与事件订阅一起撤掉（disposer 真的被托管）', async () => {
  const mod = await import(join(ROOT, 'index.js'));
  const ctx = fakeCtx();
  mod.apply(ctx);
  assert.ok(ctx.disposers.length >= 1, 'apply 必须向 ctx.effect 交托管 disposer');
  ctx.disposeAll();
  assert.equal(ctx.routes.filter((r) => !r.disposed).length, 0, '卸载后两条路由都应撤销');
  assert.equal(ctx.listeners.length, 0, '卸载后不应残留事件监听');
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

test('事件真的能推动状态（active 回合 → 200 里 active:true）', async () => {
  const mod = await import(join(ROOT, 'index.js'));
  const ctx = fakeCtx();
  mod.apply(ctx);
  const ev = ctx.listeners.find((l) => l.name === 'api-session/status');
  ev.fn('sess-1', true);
  const state = ctx.routes.find((r) => r.path === '/api/energy-orb/state');
  const res = { out: { status: 0, body: '' }, writeHead(s) { this.out.status = s; }, end(b) { this.out.body = b ?? ''; } };
  state.handler({ method: 'GET', headers: { host: '127.0.0.1:3081', 'sec-fetch-site': 'same-origin' }, socket: { remoteAddress: '127.0.0.1' } }, res);
  const body = JSON.parse(res.out.body);
  assert.equal(body.active, true, '收到 running 事件后状态必须是 active');
  assert.equal(body.phase, 'active');
});
