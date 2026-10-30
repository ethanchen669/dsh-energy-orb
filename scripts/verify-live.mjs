#!/usr/bin/env node
// A2/A3 的 live 检查（装载放行后对真实宿主跑；`--self-test` 用真路由处理器起桩服务器自证脚本本身）。
// 用法：
//   node scripts/verify-live.mjs http://127.0.0.1:<port>   # 对指定实例跑 A2 + A3
//   node scripts/verify-live.mjs --self-test               # 桩服务器自检（不依赖装载门）
// 退出码：全绿 0，任一红 1。
import http from 'node:http';
import { createProjector } from '../host/projector.js';
import { registerStateRoute, FORBIDDEN_BODY } from '../host/state-route.js';

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
}

async function selfTest() {
  const projector = createProjector();
  projector.noteStatus('self-test', true);
  const route = {};
  const fakeCtx = { webServer: { register(r) { Object.assign(route, r); return () => {}; } } };
  registerStateRoute(fakeCtx, projector);
  const server = http.createServer((req, res) => route.handler(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`# self-test 桩服务器 ${base}（真 route handler）`);
  await runChecks(base);
  server.close();
}

const arg = process.argv[2];
if (arg === '--self-test') {
  await selfTest();
} else {
  const base = arg || 'http://127.0.0.1:3081';
  console.log(`# live 检查目标 ${base}`);
  await runChecks(base);
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0
  ? `✓ verify-live 全绿（${results.length} 项）`
  : `✖ verify-live ${failed.length}/${results.length} 项红`);
process.exit(failed.length === 0 ? 0 : 1);
