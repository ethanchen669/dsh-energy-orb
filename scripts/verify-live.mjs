#!/usr/bin/env node
// A2/A3 的 live 检查（装载放行后对真实宿主跑；`--self-test` 用真路由处理器起桩服务器自证脚本本身）。
//
// 注意：真 GUI 的 `/api/**` 在浏览器鉴权后面（`?token=` / 签名 cookie），裸 curl 会先被拦成 401；
// 因此「宿主接线是否正确」的常规尺子是 `scripts/verify-host.mjs`（真 cordis + 真 webServer，不需要 token）；
// 本脚本的 live 模式用于把 token 提供给它的场景（或把实例放在不鉴权的反代后面时）。
// 用法：
//   node scripts/verify-live.mjs http://127.0.0.1:<port>   # 对指定实例跑 A2 + A3
//   node scripts/verify-live.mjs --self-test               # 桩服务器自检（不依赖装载门）
// 退出码：全绿 0，任一红 1。
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProjector } from '../host/projector.js';
import { registerStateRoute, FORBIDDEN_BODY } from '../host/state-route.js';
import { registerAssetRoute, ALLOWED_ASSETS, ASSET_PREFIX } from '../host/asset-route.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✖'} ${name}${detail ? ` —— ${detail}` : ''}`);
}

function get(base, pathname, headers = {}, { omitHost = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathname, base);
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname,
      method: 'GET',
      setHost: !omitHost,
      headers: { ...(omitHost ? {} : { host: u.host }), 'sec-fetch-site': 'same-origin', ...headers },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function runChecks(base) {
  // ---- A2：loopback + same-origin → 200 契约 JSON ----
  let a2;
  try {
    a2 = await get(base, '/api/energy-orb/state');
  } catch (e) {
    check('A2 状态路由 200 契约', false, `连接失败：${e.message}`);
    return;
  }
  const fieldsOk = (() => {
    try {
      const j = JSON.parse(a2.body);
      return j.version === 1
        && typeof j.active === 'boolean'
        && typeof j.intensity === 'number' && j.intensity >= 0 && j.intensity <= 1
        && ['idle', 'active', 'error'].includes(j.phase)
        && typeof j.updatedAt === 'number';
    } catch {
      return false;
    }
  })();
  check('A2 状态路由 200 契约', a2.status === 200 && fieldsOk,
    `status=${a2.status} body=${a2.body.slice(0, 120)}`);

  // ---- A3：伪造请求 → 403 + 精确文案 + 不含状态字段 ----
  const forgeries = [
    ['Host: evil.example', { headers: { host: 'evil.example' }, opts: {} }],
    ['Sec-Fetch-Site: cross-site', { headers: { 'sec-fetch-site': 'cross-site' }, opts: {} }],
    ['Host 缺失', { headers: {}, opts: { omitHost: true } }],
  ];
  for (const [label, spec] of forgeries) {
    const r = await get(base, '/api/energy-orb/state', spec.headers, spec.opts);
    const noLeak = !/active|intensity|updatedAt/.test(r.body);
    // Host 缺失时 node http 服务器在协议层就 400（请求根本没进 handler）——同样是围栏生效；
    // 其余伪造必须 403 + 精确文案。
    const statusOk = spec.opts.omitHost
      ? (r.status === 403 || r.status === 400)
      : r.status === 403;
    const bodyOk = spec.opts.omitHost
      ? (r.body === '' || r.body === FORBIDDEN_BODY)
      : r.body === FORBIDDEN_BODY;
    check(`A3 伪造「${label}」→ 不泄状态（${spec.opts.omitHost ? '400/403' : '403'}）`,
      statusOk && bodyOk && noLeak,
      `status=${r.status} body=${JSON.stringify(r.body.slice(0, 60))}`);
  }

  // ---- A2b：资产路由真的把 vendored 闭包发出去（浏览器能不能加载就看这条） ----
  const sphere = await get(base, `${ASSET_PREFIX}/sphere/energy-sphere.js`);
  check('A2b 球体模块 200 且内容正确',
    sphere.status === 200 && sphere.body.includes('createEnergySphere'),
    `status=${sphere.status} bytes=${sphere.body.length}`);

  const addon = await get(base, `${ASSET_PREFIX}/vendor/addons/postprocessing/Pass.js`);
  check('A2b addons 子路径 200（闭包里的相对 import 靠它）',
    addon.status === 200 && addon.body.includes('FullScreenQuad'),
    `status=${addon.status} bytes=${addon.body.length}`);

  let missing = 0;
  for (const key of ALLOWED_ASSETS) {
    const r = await get(base, `${ASSET_PREFIX}/${key}`);
    if (r.status !== 200) {
      missing += 1;
      check(`A2b 白名单项 ${key} 200`, false, `status=${r.status}`);
    }
  }
  check(`A2b 全部 ${ALLOWED_ASSETS.length} 个白名单资产都可取`, missing === 0, `缺失 ${missing} 个`);

  const notAllowed = await get(base, `${ASSET_PREFIX}/vendor/manifest.json`);
  check('A2b 白名单外 404（manifest 不对外）', notAllowed.status === 404, `status=${notAllowed.status}`);

  const assetForged = await get(base, `${ASSET_PREFIX}/sphere/energy-sphere.js`, { host: 'evil.example' });
  check('A2b 非 loopback Host → 403 且不泄源码',
    assetForged.status === 403 && assetForged.body === FORBIDDEN_BODY,
    `status=${assetForged.status} body=${JSON.stringify(assetForged.body.slice(0, 40))}`);
}

async function selfTest() {
  const projector = createProjector();
  projector.noteStatus('self-test', true);
  const stateRoute = {};
  const assetRoute = {};
  const fakeCtx = { webServer: { register(r) { return () => {}; } } };
  registerStateRoute({ webServer: { register(r) { Object.assign(stateRoute, r); return () => {}; } } }, projector);
  registerAssetRoute({ webServer: { register(r) { Object.assign(assetRoute, r); return () => {}; } } }, ROOT);
  const server = http.createServer((req, res) => {
    if (req.url.startsWith(ASSET_PREFIX)) assetRoute.handler(req, res);
    else stateRoute.handler(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`# self-test 桩服务器 ${base}（真 route handler）`);
  await runChecks(base);
  server.close();
}

const arg = process.argv[2];
if (arg === '--self-test' || arg === undefined) {
  // 无参数时必须**不**去碰任何真实实例：门禁/CI 里没有 3081，打过去只会误伤别人的进程。
  // 要检查真实实例就显式给 URL。
  if (arg === undefined) console.log('# 未给 URL：只跑自检（真 route handler 桩），不触碰任何真实实例');
  await selfTest();
} else {
  const base = arg;
  console.log(`# live 检查目标 ${base}`);
  await runChecks(base);
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0
  ? `✓ verify-live 全绿（${results.length} 项）`
  : `✖ verify-live ${failed.length}/${results.length} 项红`);
process.exit(failed.length === 0 ? 0 : 1);
