/**
 * ActivityProjector：把 `'api-session/status'` 的 running 事实折叠成 EnergyOrbState。
 * 契约见 docs/design.md「接口」节：
 *   { version: 1, active, intensity, phase, updatedAt }，intensity ∈ [0,1]，v1 = active ? 1 : 0。
 * 纯内存、零持久化；时钟可注入（测试缝）。
 */
export function createProjector(now = () => Date.now()) {
  const running = new Set();
  let updatedAt = now();

  return {
    /** @param {string} sessionId @param {boolean} isRunning */
    noteStatus(sessionId, isRunning) {
      if (isRunning) running.add(sessionId);
      else running.delete(sessionId);
      updatedAt = now();
    },
    /** @returns {{version:1, active:boolean, intensity:number, phase:'idle'|'active', updatedAt:number}} */
    snapshot() {
      const active = running.size > 0;
      return {
        version: 1,
        active,
        intensity: active ? 1 : 0,
        phase: active ? 'active' : 'idle',
        updatedAt,
      };
    },
  };
}
