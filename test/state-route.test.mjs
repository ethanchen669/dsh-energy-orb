import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjector } from '../host/projector.js';
import { registerStateRoute, isLoopbackRequest, FORBIDDEN_BODY } from '../host/state-route.js';
import { registerAssetRoute } from '../host/asset-route.js';

function fakeRes() {
  const out = { status: 0, headers: {}, body: '' };
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers; },
    end(body) { out.body = body ?? ''; },
  };
}

function fakeReq({ remoteAddress = '127.0.0.1', host = '127.0.0.1:3081', secFetchSite = 'same-origin', url = '/api/energy-orb/state', method = 'GET' } = {}) {
  const headers = { host };
  if (secFetchSite !== undefined) headers['sec-fetch-site'] = secFetchSite;
  return { method, url, headers, socket: { remoteAddress } };
}

function captureRoute(register) {
  let route;
  const ctx = { webServer: { register(r) { route = r; return () => {}; } } };
  register(ctx);
  return route;
}

test('loopback + same-origin → 200 契约 JSON', () => {
  const projector = createProjector();
  projector.noteStatus('s1', true);
  const route = captureRoute(ctx => registerStateRoute(ctx, projector));
  const res = fakeRes();
  route.handler(fakeReq(), res);
  assert.equal(res.out.status, 200);
  const body = JSON.parse(res.out.body);
  assert.equal(body.version, 1);
  assert.equal(typeof body.updatedAt, 'number');
  assert.equal(body.active, true);
  assert.ok(body.intensity >= 0 && body.intensity <= 1);
  assert.ok(['idle', 'active', 'error'].includes(body.phase));
});

test('非 loopback 远端 → 403 且不泄状态', () => {
  const projector = createProjector();
  projector.noteStatus('s1', true);
  const route = captureRoute(ctx => registerStateRoute(ctx, projector));
  const res = fakeRes();
  route.handler(fakeReq({ remoteAddress: '192.168.1.9' }), res);
  assert.equal(res.out.status, 403);
  assert.equal(res.out.body, FORBIDDEN_BODY);
  for (const key of ['active', 'intensity', 'updatedAt']) {
    assert.ok(!res.out.body.includes(key), `403 body 不应含 ${key}`);
  }
});

test('Host 头非 loopback → 403', () => {
  const route = captureRoute(ctx => registerStateRoute(ctx, createProjector()));
  const res = fakeRes();
  route.handler(fakeReq({ host: 'evil.example' }), res);
  assert.equal(res.out.status, 403);
  assert.equal(res.out.body, FORBIDDEN_BODY);
});

test('Sec-Fetch-Site: cross-site → 403', () => {
  const route = captureRoute(ctx => registerStateRoute(ctx, createProjector()));
  const res = fakeRes();
  route.handler(fakeReq({ secFetchSite: 'cross-site' }), res);
  assert.equal(res.out.status, 403);
});

test('isLoopbackRequest 边界：::1 / localhost / ::ffff:127.0.0.1 通过，缺 Host 拒绝', () => {
  assert.equal(isLoopbackRequest(fakeReq({ remoteAddress: '::1', host: '[::1]:3081' })), true);
  assert.equal(isLoopbackRequest(fakeReq({ remoteAddress: '::ffff:127.0.0.1', host: 'localhost:3081' })), true);
  assert.equal(isLoopbackRequest(fakeReq({ host: '' })), false);
});

test('资产路由：白名单内服务、白名单外 404、越界路径 404', () => {
  const pkg = mkdtempSync(join(tmpdir(), 'orb-assets-'));
  try {
    mkdirSync(join(pkg, 'client', 'vendor'), { recursive: true });
    writeFileSync(join(pkg, 'client', 'orb-renderer.js'), 'export const marker = 42;\n');
    writeFileSync(join(pkg, 'client', 'vendor', 'three.module.min.js'), 'export const THREE = "stub";\n');
    const route = captureRoute(ctx => registerAssetRoute(ctx, pkg));

    const ok = fakeRes();
    route.handler(fakeReq({ url: '/energy-orb/assets/orb-renderer.js' }), ok);
    assert.equal(ok.out.status, 200);
    assert.match(String(ok.out.body), /marker = 42/);

    const unknown = fakeRes();
    route.handler(fakeReq({ url: '/energy-orb/assets/secrets.txt' }), unknown);
    assert.equal(unknown.out.status, 404);

    const escape = fakeRes();
    route.handler(fakeReq({ url: '/energy-orb/assets/..%2F..%2Fetc%2Fpasswd' }), escape);
    assert.equal(escape.out.status, 404);

    const denied = fakeRes();
    route.handler(fakeReq({ url: '/energy-orb/assets/orb-renderer.js', remoteAddress: '10.0.0.5' }), denied);
    assert.equal(denied.out.status, 403);
  } finally {
    rmSync(pkg, { recursive: true, force: true });
  }
});
