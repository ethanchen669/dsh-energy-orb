// probe 用的 loopback 服务器：**真资产路由 + 真状态路由** + 静态文件（fixture/图片）。
// verify-visual.mjs 与 shoot-readme.mjs 共用，避免两份「看起来一样、实际漏一条」的服务器。
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { registerAssetRoute } from '../../host/asset-route.js';
import { registerStateRoute } from '../../host/state-route.js';
import { createProjector } from '../../host/projector.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

/**
 * 起一个 loopback 服务器并返回 { origin, close, projector }。
 * `packageDir` 一般是插件仓库根目录（资产路由按它找 client/**）。
 */
export async function startFixtureServer(packageDir) {
  const assetRoute = {};
  registerAssetRoute({ webServer: { register(r) { Object.assign(assetRoute, r); return () => {}; } } }, packageDir);

  const projector = createProjector();
  projector.noteStatus('fixture', false);
  const stateRoute = {};
  registerStateRoute({ webServer: { register(r) { Object.assign(stateRoute, r); return () => {}; } } }, projector);
  const stateKey = '/api/energy-orb/state';

  const server = createServer((req, res) => {
    if (req.url.startsWith('/energy-orb/assets')) {
      assetRoute.handler(req, res);
      return;
    }
    if (req.url === stateKey || req.url.startsWith(`${stateKey}?`)) {
      stateRoute.handler(req, res);
      return;
    }
    // probe 控制面：翻投影器状态（驱动「静息→激活」的真实轮询链）
    if (req.url.startsWith('/__fixture/state')) {
      const params = new URL(req.url, 'http://127.0.0.1').searchParams;
      projector.noteStatus('fixture', params.get('active') === '1');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(projector.snapshot()));
      return;
    }
    const rel = normalize(decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname));
    const file = join(packageDir, rel);
    if (!file.startsWith(packageDir) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404);
      res.end('not-found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    projector,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
