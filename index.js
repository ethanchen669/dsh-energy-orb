/** Host half：ActivityProjector 折叠 + 状态路由 + 资产路由（能量球的 Host 接线）。 */
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createProjector } from './host/projector.js';
import { registerStateRoute } from './host/state-route.js';
import { registerAssetRoute } from './host/asset-route.js';

const packageDir = dirname(fileURLToPath(import.meta.url));

export function apply(ctx, config) {
  const projector = createProjector();
  // ⚠️ cordis 的 `ctx.effect(execute)` 会**立即执行** execute，并把它的**返回值**当作 disposer。
  // 写成 `ctx.effect(() => { disposeX() })` 就等于「注册完当场把自己撤销」——真机上表现为：
  // 资产路由 404（client 落到 CSS 降级球）+ 状态永远 idle（球永远不动）。
  // 正确形状：在 execute 里**注册**，`return` 一个撤销函数。
  ctx.effect(() => {
    // 事件是 Context 核心面（fly-llm-recover 同款直订）；服务必须经 ctx.inject 获取——
    // 裸 ctx.webServer 是 undefined ⇒ apply 抛 ⇒ fiber failed（list_plugins 实测过）。
    const offStatus = ctx.on('api-session/status', (sessionId, running) => {
      projector.noteStatus(String(sessionId), !!running);
    });
    return () => offStatus();
  });

  ctx.inject(['webServer'], (hostCtx) => {
    ctx.effect(() => {
      const disposeState = registerStateRoute(hostCtx, projector);
      const disposeAssets = registerAssetRoute(hostCtx, packageDir);
      return () => {
        disposeState();
        disposeAssets();
      };
    });
  });
}
