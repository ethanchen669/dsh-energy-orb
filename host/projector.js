/**
 * ActivityProjector：把 `'api-session/status'` 的 running 事实折叠成 EnergyOrbState。
 * 契约见 docs/design.md「接口」节：
 *   { version: 1, active, intensity, phase, updatedAt }，intensity ∈ [0,1]，v1 = active ? 1 : 0。
 * 纯内存、零持久化；时钟可注入（测试缝）。
 *
 * `updatedAt` 是**快照生成时刻**（liveness 心跳），每次 snapshot() 刷新：
 * 客户端据此判断「这份状态还有效吗」。若它只在事件发生时更新，长回合（>10s 没有新事件）
 * 会被客户端误判成陈旧 → 球在回合还在跑的时候缩回去（这个坑真踩过）。
 */
export function createProjector(now = () => Date.now()) {
  const running = new Set();

  return {
    /** @param {string} sessionId @param {boolean} isRunning */
    noteStatus(sessionId, isRunning) {
      if (isRunning) running.add(sessionId);
      else running.delete(sessionId);
    },
    /**
     * @param {string} [sessionId] 传入则只回答"这一个会话在不在跑"（客户端按主视图焦点会话查询）；
     *   不传 = 全局口径（任一回合在跑就算 active，兼容没有 sessions 服务的宿主）。
     * @returns {{version:1, active:boolean, intensity:number, phase:'idle'|'active', updatedAt:number}}
     */
    snapshot(sessionId) {
      const active = sessionId === undefined || sessionId === null
        ? running.size > 0
        : running.has(sessionId);
      return {
        version: 1,
        active,
        intensity: active ? 1 : 0,
        phase: active ? 'active' : 'idle',
        updatedAt: now(),
      };
    },
  };
}
