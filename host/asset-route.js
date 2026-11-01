/**
 * 资产路由：只服务**白名单内**的包内文件（精确相对路径集合 + realpath 包含性检查），
 * 供 client 半边动态 import 球体模块与 vendored three。
 * `GET /energy-orb/assets/<相对 client/ 的路径>`；越界/未知 → 404；>20MB → 413；围栏同状态路由。
 *
 * 为什么是精确集合而不是「目录 + 后缀」：目录放行会把 `client/**` 里将来任何东西（测试夹具、
 * 临时脚本）自动变成对外资产；精确集合的代价是 vendor 新文件时要同步这里——这条漂移由
 * `test/vendor.test.mjs` 交叉核对 `client/vendor/manifest.json` 兜住（两处不一致就红）。
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { isLoopbackRequest, FORBIDDEN_BODY } from './state-route.js';

const MAX_BYTES = 20 * 1024 * 1024;

/** URL 前缀（与 client.js 的 ASSETS 常量同源）。 */
export const ASSET_PREFIX = '/energy-orb/assets';

/** 白名单：相对 `client/` 的精确路径。 */
export const ALLOWED_ASSETS = [
  // 球体组件（apps/energy-sphere-demo 的 vendored 副本）
  'sphere/energy-sphere.js',
  'sphere/animation.js',
  'sphere/options.js',
  // vendored three@0.180（three.module.min.js 自身 import ./three.core.min.js）
  'vendor/three.module.min.js',
  'vendor/three.core.min.js',
  // 实际用到的 addons 闭包（EffectComposer / RenderPass / UnrealBloomPass / OutputPass）
  'vendor/addons/postprocessing/EffectComposer.js',
  'vendor/addons/postprocessing/MaskPass.js',
  'vendor/addons/postprocessing/OutputPass.js',
  'vendor/addons/postprocessing/Pass.js',
  'vendor/addons/postprocessing/RenderPass.js',
  'vendor/addons/postprocessing/ShaderPass.js',
  'vendor/addons/postprocessing/UnrealBloomPass.js',
  'vendor/addons/shaders/CopyShader.js',
  'vendor/addons/shaders/LuminosityHighPassShader.js',
  'vendor/addons/shaders/OutputShader.js',
];

const ALLOWED = new Set(ALLOWED_ASSETS);

/** 从请求 URL 里取出白名单键（相对 client/ 的路径）；不在白名单返回 null。 */
export function assetKeyFromUrl(rawUrl) {
  let pathname;
  try {
    pathname = new URL(rawUrl, 'http://127.0.0.1').pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith(`${ASSET_PREFIX}/`)) return null;
  let key;
  try {
    key = decodeURIComponent(pathname.slice(ASSET_PREFIX.length + 1));
  } catch {
    return null;
  }
  if (key.includes('\0') || key.includes('\\')) return null;
  return ALLOWED.has(key) ? key : null;
}

/** 挂 `GET /energy-orb/assets/**`；`packageDir` 为本包根目录绝对路径。返回 disposer。 */
export function registerAssetRoute(ctx, packageDir) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: ASSET_PREFIX,
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
      const key = assetKeyFromUrl(req.url);
      if (!key) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not-found');
        return;
      }
      const rel = join('client', key);
      let root;
      let file;
      try {
        root = realpathSync(packageDir);
        file = realpathSync(join(root, rel));
        if (!statSync(file).isFile()) throw new Error('not-a-file');
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not-found');
        return;
      }
      // 白名单已挡住穿越；realpath 包含性再挡一次软链逃逸（双保险，成本一次 syscall）
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
