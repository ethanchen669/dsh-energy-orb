import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stateToTargets,
  heartbeatScale,
  buildSphere,
  buildCore,
  buildRim,
  normalizePrefs,
  STALE_MS,
} from '../client/orb-renderer.js';

const VALID_ACTIVE = { version: 1, active: true, intensity: 1, phase: 'active', updatedAt: 1_000 };

test('陈旧状态（11s）→ idle 目标；9s 仍是 active 目标（A4 两边界）', () => {
  const now = 100_000;
  const stale = stateToTargets({ ...VALID_ACTIVE, updatedAt: now - 11_000 }, now);
  assert.equal(stale.scale, 0.6);
  assert.equal(stale.glow, 0.3);
  assert.equal(stale.phase, 'idle');
  const fresh = stateToTargets({ ...VALID_ACTIVE, updatedAt: now - 9_000 }, now);
  assert.equal(fresh.scale, 1.0);
  assert.equal(fresh.phase, 'active');
  assert.equal(STALE_MS, 10_000);
});

test('畸形状态 → idle 目标且恰一次 warn（A10）', () => {
  const warns = [];
  const out = stateToTargets(
    { version: 0, active: 'yes', intensity: 9, phase: '??', updatedAt: 'x' },
    100_000,
    (m) => warns.push(m),
  );
  assert.equal(out.scale, 0.6);
  assert.equal(out.phase, 'idle');
  assert.ok(out.glow >= 0 && out.glow <= 1);
  assert.equal(warns.length, 1);
});

test('intensity 越界 clamp 到 [0,1]（合法 version）', () => {
  const out = stateToTargets({ ...VALID_ACTIVE, intensity: 9, updatedAt: 100_000 }, 100_000, () => {});
  assert.equal(out.scale, 1.0);
  const out2 = stateToTargets({ ...VALID_ACTIVE, active: false, intensity: -3, updatedAt: 100_000 }, 100_000, () => {});
  assert.equal(out2.phase, 'idle');
});

test('心搏包络：快起慢落 + 提频（A5）', () => {
  assert.ok(heartbeatScale(120, 0) >= 1.05, `120ms 应达峰值: ${heartbeatScale(120, 0)}`);
  assert.ok(heartbeatScale(600, 0) <= 0.92, `600ms 应回落: ${heartbeatScale(600, 0)}`);
  // 攻起段单调不降
  let prev = 0;
  for (let t = 0; t <= 120; t += 10) {
    const v = heartbeatScale(t, 0);
    assert.ok(v >= prev - 1e-9, `攻起段应单调不降 t=${t}`);
    prev = v;
  }
  // 舒张段单调不升
  prev = 2;
  for (let t = 130; t <= 600; t += 30) {
    const v = heartbeatScale(t, 0);
    assert.ok(v <= prev + 1e-9, `舒张段应单调不升 t=${t}`);
    prev = v;
  }
  // intensity=1 提频：第二个波峰比 intensity=0 更早出现
  const peakTime = (i) => {
    for (let t = 0; t < 2000; t += 5) if (heartbeatScale(t, i) >= 1.099) return t;
    return Infinity;
  };
  assert.ok(peakTime(1) < peakTime(0), 'intensity=1 峰应更早');
});

test('buildSphere：42 点单位球面、边唯一无自环（A9）', () => {
  const { points, edges } = buildSphere();
  assert.equal(points.length, 42);
  for (const p of points) {
    assert.ok(Math.abs(Math.hypot(...p) - 1) < 1e-9, `点应为单位向量: ${p}`);
  }
  const seen = new Set();
  for (const [i, j] of edges) {
    assert.notEqual(i, j, '无自环');
    assert.ok(i < j, 'i<j 保证唯一');
    const key = `${i}-${j}`;
    assert.ok(!seen.has(key), `重复边 ${key}`);
    seen.add(key);
  }
  assert.ok(edges.length > 0);
});

test('buildCore ≥18 点且在球内；buildRim 72 粒半径带（A9）', () => {
  const core = buildCore();
  assert.ok(core.length >= 18);
  for (const p of core) {
    const r = Math.hypot(...p);
    assert.ok(r >= 0.08 - 1e-9 && r <= 0.46 + 1e-9, `球核半径越界: ${r}`);
  }
  const rim = buildRim();
  assert.equal(rim.length, 72);
  for (const d of rim) {
    assert.ok(d.radius >= 0.77 - 1e-9 && d.radius <= 1.05 + 1e-9, `rim 半径越界: ${d.radius}`);
    assert.ok(d.alpha > 0 && d.alpha < 1);
  }
});

test('normalizePrefs：clamp 与默认（size/anchor/offset）', () => {
  assert.deepEqual(normalizePrefs(undefined), { visible: true, size: 96, anchor: 'bottom-right', offset: { x: 0, y: 0 } });
  assert.equal(normalizePrefs({ size: 9999 }).size, 256);
  assert.equal(normalizePrefs({ size: 1 }).size, 32);
  assert.equal(normalizePrefs({ anchor: 'middle-of-nowhere' }).anchor, 'bottom-right');
  assert.deepEqual(normalizePrefs({ offset: { x: 'x', y: 1e9 } }).offset, { x: 0, y: 4096 });
  const round = normalizePrefs({ visible: false, size: 120, anchor: 'bottom-left', offset: { x: -40, y: 22 } });
  assert.deepEqual(round, { visible: false, size: 120, anchor: 'bottom-left', offset: { x: -40, y: 22 } });
});
