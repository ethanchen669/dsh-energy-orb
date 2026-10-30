/**
 * 资产路由：只服务包内两个 JS 文件（白名单 + realpath 包含性检查），供 client 半边动态 import。
 * `GET /energy-orb/assets/<file>`；越界/未知 → 404；>20MB → 413；围栏同状态路由。
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { isLoopbackRequest, FORBIDDEN_BODY } from './state-route.js';

const MAX_BYTES = 20 * 1024 * 1024;

/** 白名单：URL 尾段 → 包内相对路径（只此两个，别的都 404）。 */
const ALLOWED = new Map([
  ['orb-renderer.js', join('client', 'orb-renderer.js')],
  ['three.module.min.js', join('client', 'vendor', 'three.module.min.js')],
]);

/** 挂 `GET /energy-orb/assets/<file>`；`packageDir` 为本包根目录绝对路径。返回 disposer。 */
export function registerAssetRoute(ctx, packageDir) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: '/energy-orb/assets',
    handler(req, res) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('method-not-allowed');
        return;
      }
      if (!isLoopbackRequest(req)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end(FORBIDDEN_BODY);
        return;
      }
      let name = '';
      try {
        name = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname.split('/').pop() ?? '');
      } catch {
        name = '';
      }
      const rel = ALLOWED.get(name);
      if (!rel) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not-found');
        return;
      }
      let root;
      let file;
      try {
        root = realpathSync(packageDir);
        file = realpathSync(join(root, rel));
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not-found');
        return;
      }
      if (file !== root && !file.startsWith(root + sep)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not-found');
        return;
      }
      const size = statSync(file).size;
      if (size > MAX_BYTES) {
        res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('payload-too-large');
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
    },
  });
}
