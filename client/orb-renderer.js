/**
 * OrbRenderer 的纯逻辑层（无 DOM、无 THREE 引用，导入即安全；node --test 直接测）。
 * 契约见 docs/design.md「接口」节 + 计划 Task 4；绘制层（createOrb）在 Task 6 追加于本文件。
 */

export const STALE_MS = 10_000;

const IDLE = Object.freeze({ scale: 0.6, glow: 0.3, particles: 0.18, ringSpeed: 0.35 });
const ACTIVE = Object.freeze({ scale: 1.0, glow: 0.8, particles: 1.0, ringSpeed: 1.2 });

/** 0.9 → 1.1 快起慢落心搏；攻起 12% 周期、舒张 48% 周期、其余间歇。intensity ∈ [0,1] 提频 60→120 BPM。 */
export function heartbeatScale(tMs, intensity = 0) {
  const i = Math.min(1, Math.max(0, Number(intensity) || 0));
  const period = 60_000 / (60 + 60 * i);
  const t = ((tMs % period) + period) % period;
  const attack = 0.12 * period;   // 60 BPM 时 = 120ms
  const decay = 0.48 * period;    // 60 BPM 时 = 480ms
  if (t < attack) return 0.9 + 0.2 * (t / attack);
  if (t < attack + decay) {
    const k = (t - attack) / decay;
    return 0.9 + 0.2 * Math.exp(-4 * k);
  }
  return 0.9;
}

function idleTargets() {
  return { ...IDLE, phase: 'idle' };
}

/**
 * 状态 → 渲染目标参数。陈旧（updatedAt 距今 > 10s）或畸形 → idle 目标；
 * version 不认识 / 结构坏 → 恰一次 warn（由调用方注入 warn 桩计数）。
 */
export function stateToTargets(state, nowMs, warn = console.warn) {
  if (state === null || typeof state !== 'object') {
    warn('[energy-orb] malformed state: not an object');
    return idleTargets();
  }
  if (state.version !== 1) {
    warn(`[energy-orb] unknown state version: ${String(state.version)}`);
    return idleTargets();
  }
  const active = !!state.active;
  const intensity = Math.min(1, Math.max(0, Number(state.intensity) || 0));
  const updatedAt = Number(state.updatedAt);
  const stale = !Number.isFinite(updatedAt) || nowMs - updatedAt > STALE_MS;
  if (stale) return idleTargets();
  const phase = state.phase === 'error' ? 'error' : active ? 'active' : 'idle';
  return active
    ? { ...ACTIVE, phase }
    : { ...IDLE, phase: 'idle' };
}

/** Fibonacci 均匀 42 点（单位球面）+ 近邻边（i<j、无自环、无重复）。 */
export function buildSphere() {
  const n = 42;
  const points = [];
  const gr = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = gr * i;
    points.push([Math.cos(th) * r, y, Math.sin(th) * r]);
  }
  const edges = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = points[i], b = points[j];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (d < 0.55) edges.push([i, j]);
    }
  }
  return { points, edges };
}

/** 球核 18 点（半径 0.08–0.46，单位球内），确定性哈希布点。 */
export function buildCore() {
  const hash = (i) => {
    const x = Math.sin(i * 127.1) * 43758.5453;
    return x - Math.floor(x);
  };
  const points = [];
  for (let i = 0; i < 18; i++) {
    const th = hash(i * 9.2) * Math.PI * 2;
    const ph = Math.acos(2 * hash(i * 3.7) - 1);
    const rr = 0.08 + hash(i * 5.9) * 0.38;
    points.push([Math.sin(ph) * Math.cos(th) * rr, Math.sin(ph) * Math.sin(th) * rr, Math.cos(ph) * rr]);
  }
  return points;
}

/** 边缘点带 72 粒：angle 均布 + 抖动，radius ∈ [0.77, 1.05]（外密内疏：u² 反向），alpha ∈ (0,1)。 */
export function buildRim() {
  const hash = (i) => {
    const x = Math.sin(i * 127.1) * 43758.5453;
    return x - Math.floor(x);
  };
  const dots = [];
  for (let i = 0; i < 72; i++) {
    const angle = (i / 72) * Math.PI * 2 + hash(i * 2.7) * 0.09;
    const u = hash(i * 4.1);
    const radius = 1.05 - u * u * 0.28;
    const alpha = 0.22 + 0.5 * hash(i * 6.3);
    dots.push({ angle, radius, alpha });
  }
  return dots;
}

/** 显示偏好 clamp：缺失/越界回落默认；size 32..256；anchor 枚举外回落 bottom-right。 */
export function normalizePrefs(raw) {
  const defaults = { visible: true, size: 96, anchor: 'bottom-right', offset: { x: 0, y: 0 } };
  const src = raw && typeof raw === 'object' ? raw : {};
  const size = Math.min(256, Math.max(32, Number(src.size) || defaults.size));
  const anchor = src.anchor === 'bottom-left' ? 'bottom-left' : 'bottom-right';
  const clampOff = (v) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.min(4096, Math.max(-4096, x)) : 0;
  };
  const off = src.offset && typeof src.offset === 'object' ? src.offset : {};
  return {
    visible: src.visible === undefined ? defaults.visible : !!src.visible,
    size,
    anchor,
    offset: { x: clampOff(off.x), y: clampOff(off.y) },
  };
}
