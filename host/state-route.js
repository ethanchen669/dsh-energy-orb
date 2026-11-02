/**
 * 状态路由 + loopback-only 围栏（设计 docs/design.md「接缝」节，同 dsh-pet 的 security model）。
 * WebRoute 契约（@deepseek-ai/dsh-host-webserver lib/types/index.d.ts）：
 *   { kind: 'exact'|'prefix', path, handler(req: IncomingMessage, res: ServerResponse) }。
 * 围栏判定必须发生在任何状态字节写出之前。
 */

const FORBIDDEN_BODY = 'forbidden: loopback-only';

/** @param {{ socket?: { remoteAddress?: string }, headers?: Record<string, unknown> }} req */
export function isLoopbackRequest(req) {
  const remote = String(req.socket?.remoteAddress ?? '');
  const isLoopbackSocket =
    remote === '::1' ||
    remote === '::ffff:127.0.0.1' ||
    /^127\.\d+\.\d+\.\d+$/.test(remote);

  const hostHeader = String(req.headers?.host ?? '');
  let hostname = hostHeader;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname;
  } catch {
    return false;
  }
  hostname = hostname.replace(/^\[|\]$/g, '');
  const isLoopbackHost =
    hostname === 'localhost' ||
    hostname === '::1' ||
    /^127\.\d+\.\d+\.\d+$/.test(hostname);

  const site = req.headers?.['sec-fetch-site'];
  const siteOk = site === undefined || site === 'same-origin';

  return isLoopbackSocket && isLoopbackHost && siteOk;
}

/**
 * 从 `?session=<id>` 取焦点会话（客户端切换会话时带上）。校验很紧：
 * 只允许 id 合法字符与长度 ≤128，任何不合法的值一律当"没传"（退回全局口径），
 * 不让任意字符串进到 Set 查找与错误信息里。
 */
export function readSessionQuery(url) {
  const raw = String(url ?? '');
  const index = raw.indexOf('?');
  if (index === -1) return undefined;
  let params;
  try {
    params = new URLSearchParams(raw.slice(index + 1));
  } catch {
    return undefined;
  }
  const value = params.get('session');
  if (typeof value !== 'string' || value === '') return undefined;
  return /^[A-Za-z0-9_:.-]{1,128}$/.test(value) ? value : undefined;
}

function deny(res) {
  res.writeHead(403, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(FORBIDDEN_BODY);
}

/** 挂 `GET /api/energy-orb/state`；返回 disposer。 */
export function registerStateRoute(ctx, projector) {
  return ctx.webServer.register({
    kind: 'exact',
    path: '/api/energy-orb/state',
    handler(req, res) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('method-not-allowed');
        return;
      }
      if (!isLoopbackRequest(req)) {
        deny(res);
        return;
      }
      const body = JSON.stringify(projector.snapshot(readSessionQuery(req.url)));
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    },
  });
}

export { FORBIDDEN_BODY };
