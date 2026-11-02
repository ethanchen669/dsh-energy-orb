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

test('updatedAt 是快照生成时刻（liveness 心跳）：每次读都刷新', () => {
  const { projector, tick, now } = make();
  projector.noteStatus('s1', true);
  const first = projector.snapshot().updatedAt;
  assert.equal(first, now(), '第一次快照应是当前时钟');
  tick(500);
  const second = projector.snapshot().updatedAt;
  assert.equal(second, now(), '没有新事件也要刷新（否则长回合会被判陈旧）');
  assert.ok(second > first);
});

test('长回合不会被自己的时间戳判死：持续 30s 每 2s 快照，active 与新鲜度都在', () => {
  const { projector, tick, now } = make();
  projector.noteStatus('s1', true);          // 回合开始，此后 30s 没有新事件
  for (let elapsed = 0; elapsed <= 30_000; elapsed += 2_000) {
    if (elapsed > 0) tick(2_000);
    const s = projector.snapshot();
    assert.equal(s.active, true, `第 ${elapsed / 1000}s 仍应是 active`);
    assert.equal(s.updatedAt, now(), '每次快照都必须新鲜（客户端按 >10s 判陈旧）');
    assert.ok(now() - s.updatedAt <= 10_000);
  }
});

test('按会话过滤：只有传入的那个会话在跑才 active（切换左侧栏会话的绑定基础）', () => {
  const p = createProjector(() => 1000);
  p.noteStatus('s-a', true);
  assert.equal(p.snapshot('s-a').active, true);
  assert.equal(p.snapshot('s-b').active, false, '另一个在跑的会话不该把焦点会话点亮');
  assert.equal(p.snapshot().active, true, '不传 session = 全局口径');
  p.noteStatus('s-a', false);
  p.noteStatus('s-b', true);
  assert.equal(p.snapshot('s-a').active, false);
  assert.equal(p.snapshot('s-b').active, true);
  assert.equal(p.snapshot().active, true);
  assert.equal(p.snapshot('s-c').intensity, 0);
  assert.equal(p.snapshot('s-c').phase, 'idle');
});
