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
