import { test } from 'node:test';
import assert from 'node:assert/strict';

// 造 window 桩捕获 ModuleLoader 注册，再加载 client.js（classic script 形态，无 import/export）
const captured = { spec: null };
globalThis.window = {
  __ModuleLoader__: { load(spec) { captured.spec = spec; } },
};
await import('../client.js');

const stubRequire = (name) => {
  if (name === 'react') return { createElement: () => null };
  throw new Error(`unexpected require: ${name}`);
};
const mod = captured.spec.factory(stubRequire);
const T = mod.__testables;

test('apply 后 register 收到 shell.overlay 与 id: dsh-fly-energy-orb', () => {
  assert.deepEqual(mod.inject, ['slots']);
  const calls = [];
  const ctx = {
    slots: {
      inject(slot, cb) { calls.push({ slot }); return cb(); },
      register(opts, component) {
        calls.push({ register: opts, component });
        return () => {};
      },
    },
  };
  mod.apply(ctx);
  const reg = calls.find((c) => c.register);
  assert.equal(calls[0].slot, 'shell.overlay');
  assert.equal(reg.register.name, 'shell.overlay');
  assert.equal(reg.register.id, 'dsh-fly-energy-orb');
  assert.equal(typeof reg.component, 'function');
});

test('pollOnce 成功 → 2s 且 onState 收到契约对象', async () => {
  const seen = [];
  const fetchImpl = async () => ({ ok: true, json: async () => ({ version: 1, active: true }) });
  const ms = await T.pollOnce(fetchImpl, (s) => seen.push(s));
  assert.equal(ms, 2000);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].version, 1);
});

test('pollOnce 失败退避 10s，成功恢复 2s（两次失败后恢复）', async () => {
  const fail = async () => { throw new Error('network down'); };
  const bad = async () => ({ ok: false, status: 502 });
  const good = async () => ({ ok: true, json: async () => ({ version: 1 }) });
  const noop = () => {};
  assert.equal(await T.pollOnce(fail, noop), 10000);
  assert.equal(await T.pollOnce(bad, noop), 10000);
  assert.equal(await T.pollOnce(good, noop), 2000);
});

test('loadPrefs/savePrefs round-trip + 垃圾输入回落默认 + clamp', () => {
  const mem = new Map();
  const storage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, v),
  };
  const prefs = { visible: false, size: 120, anchor: 'bottom-left', offset: { x: -40, y: 22 } };
  T.savePrefs(storage, prefs);
  assert.deepEqual(T.loadPrefs(storage), prefs);

  mem.set('energy-orb.display', '{not json');
  assert.deepEqual(T.loadPrefs(storage), { visible: true, size: 96, anchor: 'bottom-right', offset: { x: 0, y: 0 } });

  mem.set('energy-orb.display', JSON.stringify({ size: 9999, anchor: 'nope', offset: { x: 'x' } }));
  assert.deepEqual(T.loadPrefs(storage), { visible: true, size: 256, anchor: 'bottom-right', offset: { x: 0, y: 0 } });
});

test('转速 ramp 比其余参数更陡：静息↔运行切换时先起转，核大小仍按 420ms 过渡', () => {
  const idleOpts = T.idleOptions(false);
  const activeOpts = {
    ...idleOpts,
    heartbeatEnabled: true,
    coreScale: 1.08,
    coreBrightness: 1.3,
    energy: 1,
    rotationSpeed: 16,
  };
  // 模拟 RAMP_STEP_MS = 33ms 的一串 tick：到 198ms（6 tick）时，转速必须基本到位，
  // 而 coreScale 仍明显在路上（420ms 的通用 ramp 只走一半左右）。
  let current = idleOpts;
  let now = 0;
  for (let i = 0; i < 6; i += 1) {
    now += 33;
    const progress = Math.min(1, now / T.RAMP_MS);
    const rotProgress = Math.min(1, now / T.ROT_RAMP_MS);
    current = T.smoothOptions(current, activeOpts, T.RAMP_ALPHA, progress, {
      alpha: T.ROT_RAMP_ALPHA,
      progress: rotProgress,
    });
  }
  assert.equal(current.rotationSpeed, 16, '转速 ramp 到期（170ms）后必须精确落在目标值');
  const rotDone = (current.rotationSpeed - idleOpts.rotationSpeed) / (16 - idleOpts.rotationSpeed);
  const scaleDone = (current.coreScale - idleOpts.coreScale) / (activeOpts.coreScale - idleOpts.coreScale);
  assert.ok(rotDone >= 0.98, `198ms 时转速应基本到位，实到 ${(rotDone * 100).toFixed(1)}%`);
  // 通用 ramp（420ms/alpha 0.3）到 198ms 约 88%：仍明显在路上，但更关键的是"没到位"这件事
  assert.ok(scaleDone < 0.95, `198ms 时核大小应仍在过渡，实到 ${(scaleDone * 100).toFixed(1)}%`);
  assert.ok(rotDone > scaleDone, '转速必须比核大小先到位（"起转"手感）');
});
