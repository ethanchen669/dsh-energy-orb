/** Host half：ActivityProjector 折叠 + 状态路由 + 资产路由（能量球的 Host 接线）。 */
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createProjector } from './host/projector.js';
import { registerStateRoute } from './host/state-route.js';
import { registerAssetRoute } from './host/asset-route.js';

const packageDir = dirname(fileURLToPath(import.meta.url));

export function apply(ctx) {
  const projector = createProjector();
  const offStatus = ctx.on('api-session/status', (sessionId, running) => {
    projector.noteStatus(String(sessionId), !!running);
  });
  const disposeState = registerStateRoute(ctx, projector);
  const disposeAssets = registerAssetRoute(ctx, packageDir);
  ctx.effect(() => {
    disposeState();
    disposeAssets();
    offStatus();
  });
}
