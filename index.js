/** Host half：ActivityProjector 折叠 + 状态路由 + 资产路由（能量球的 Host 接线）。 */
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createProjector } from './host/projector.js';
import { registerStateRoute } from './host/state-route.js';
import { registerAssetRoute } from './host/asset-route.js';

const packageDir = dirname(fileURLToPath(import.meta.url));

export function apply(ctx, config) {
  const projector = createProjector();
  // 事件是 Context 核心面（fly-llm-recover 同款直订）；**服务必须经 ctx.inject 获取**——
  // 裸 ctx.webServer 是 undefined ⇒ apply 抛 ⇒ fiber failed（list_plugins 实测过）。
  const offStatus = ctx.on('api-session/status', (sessionId, running) => {
    projector.noteStatus(String(sessionId), !!running);
  });
  ctx.effect(() => offStatus());
  ctx.inject(['webServer'], (hostCtx) => {
    const disposeState = registerStateRoute(hostCtx, projector);
    const disposeAssets = registerAssetRoute(hostCtx, packageDir);
    ctx.effect(() => {
      disposeState();
      disposeAssets();
    });
  });
}
