import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProjector } from '../host/projector.js';

function make() {
  let t = 1000;
  const projector = createProjector(() => t);
  return { projector, tick: (d) => { t += d; return t; }, now: () => t };
}

test('单会话 running → active / intensity 1 / phase active', () => {
  const { projector } = make();
  projector.noteStatus('s1', true);
  const s = projector.snapshot();
  assert.deepEqual(
    { version: s.version, active: s.active, intensity: s.intensity, phase: s.phase },
    { version: 1, active: true, intensity: 1, phase: 'active' },
  );
});

test('两会话其一停止 → 仍 active', () => {
  const { projector } = make();
  projector.noteStatus('s1', true);
  projector.noteStatus('s2', true);
  projector.noteStatus('s1', false);
  assert.equal(projector.snapshot().active, true);
});

test('全停 → idle / intensity 0 / phase idle', () => {
  const { projector } = make();
  projector.noteStatus('s1', true);
  projector.noteStatus('s2', true);
  projector.noteStatus('s1', false);
  projector.noteStatus('s2', false);
  const s = projector.snapshot();
  assert.deepEqual(
    { active: s.active, intensity: s.intensity, phase: s.phase },
    { active: false, intensity: 0, phase: 'idle' },
  );
});

test('重复同值 noteStatus 幂等（active 不抖）', () => {
  const { projector } = make();
  projector.noteStatus('s1', true);
  projector.noteStatus('s1', true);
  assert.equal(projector.snapshot().active, true);
  projector.noteStatus('s1', false);
  projector.noteStatus('s1', false);
  assert.equal(projector.snapshot().active, false);
});

test('updatedAt 随 noteStatus 前进，snapshot 不改时钟', () => {
  const { projector, tick, now } = make();
  projector.noteStatus('s1', true);
  const first = projector.snapshot().updatedAt;
  tick(500);
  projector.noteStatus('s2', true);
  const second = projector.snapshot().updatedAt;
  assert.ok(second > first, `updatedAt 应前进：${first} → ${second}`);
  assert.equal(second, now());
});
