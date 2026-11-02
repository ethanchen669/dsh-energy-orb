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
    // 真 cordis 客户端 context 也有 inject(deps, cb)（惰性拿 sessions 服务）；桩里服务不可用
    inject(deps, cb) { calls.push({ inject: deps }); return () => {}; },
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
  const slots = calls.filter((c) => c.slot);
  assert.equal(slots[0].slot, 'shell.overlay');
  assert.ok(calls.some((c) => Array.isArray(c.inject) && c.inject.includes('sessions')), '应惰性请求 sessions 服务');
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
  assert.deepEqual(T.loadPrefs(storage), { ...prefs, v: 2 }, 'savePrefs 要带上迁移版本号');

  mem.set('energy-orb.display', '{not json');
  // 视图等比放大 1.25×：默认 size 96 → 120（画布 240×240）；旧存档按 1.25 迁移一次并打版本号
  const loaded = T.loadPrefs(storage);
  assert.equal(loaded.v, 2);
  assert.equal(loaded.size, 120);
  assert.equal(loaded.visible, true);
  assert.equal(loaded.anchor, 'bottom-right');
  assert.deepEqual(loaded.offset, { x: 0, y: 0 });
  const legacy = { getItem: () => JSON.stringify({ visible: true, size: 96, anchor: 'bottom-right', offset: { x: 0, y: 0 } }), setItem: () => {} };
  assert.equal(T.loadPrefs(legacy).size, 120, '旧存档（无 v）应迁移 ×1.25');
  const migrated = { getItem: () => JSON.stringify({ v: 2, visible: true, size: 120, anchor: 'bottom-right', offset: { x: 0, y: 0 } }), setItem: () => {} };
  assert.equal(T.loadPrefs(migrated).size, 120, '已迁移过的存档不许再放大一次');

  // 垃圾输入：无 v ⇒ 当旧存档迁移（9999×1.25 远超上限）⇒ clamp 到 256
  mem.set('energy-orb.display', JSON.stringify({ size: 9999, anchor: 'nope', offset: { x: 'x' } }));
  assert.deepEqual(T.loadPrefs(storage), { v: 2, visible: true, size: 256, anchor: 'bottom-right', offset: { x: 0, y: 0 } });
});

test('转速 ramp 比其余参数更陡：静息↔运行切换时先起转，核大小仍按 420ms 过渡', () => {
  const idleOpts = T.idleOptions(false);
  const activeOpts = {
    ...idleOpts,
    heartbeatEnabled: true,
    coreScale: 1.08,
    coreBrightness: 0.975,
    energy: 1,
    rotationSpeed: 117.6,
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
  assert.equal(current.rotationSpeed, 117.6, '转速 ramp 到期（170ms）后必须精确落在目标值');
  const rotDone = (current.rotationSpeed - idleOpts.rotationSpeed) / (117.6 - idleOpts.rotationSpeed);
  const scaleDone = (current.coreScale - idleOpts.coreScale) / (activeOpts.coreScale - idleOpts.coreScale);
  assert.ok(rotDone >= 0.98, `198ms 时转速应基本到位，实到 ${(rotDone * 100).toFixed(1)}%`);
  // 通用 ramp（420ms/alpha 0.3）到 198ms 约 88%：仍明显在路上，但更关键的是"没到位"这件事
  assert.ok(scaleDone < 0.95, `198ms 时核大小应仍在过渡，实到 ${(scaleDone * 100).toFixed(1)}%`);
  assert.ok(rotDone > scaleDone, '转速必须比核大小先到位（"起转"手感）');
});

test('焦点会话绑定：切换左侧栏会话时球跟随那一个会话的 running 标志', () => {
  const T = mod.__testables;
  const row = (id, running, mainView) => ({
    id, running, retainedBy: { mainView }, blank: false, displayTitle: id,
  });
  const fakeSessions = (rows) => ({
    list: { getSnapshot: () => ({ ids: rows.map((r) => r.id), byId: Object.fromEntries(rows.map((r) => [r.id, r])) }) },
  });

  // A 在跑、B 空闲；主视图显示 B ⇒ 球应当静息（而不是"全局有回合在跑"就点亮）
  const showingB = T.pickFocusedSession(fakeSessions([row('A', true, 0), row('B', false, 1)]));
  assert.deepEqual(showingB, { id: 'B', running: false });
  const active = T.resolveOrbState({ version: 1, active: true, intensity: 1, phase: 'active', updatedAt: 1 }, showingB);
  assert.equal(active.active, false, '焦点会话空闲 ⇒ 静息');
  assert.equal(active.intensity, 0);
  assert.equal(active.phase, 'idle');

  // 切到 A（主视图显示 A、A 在跑）⇒ 激活
  const showingA = T.pickFocusedSession(fakeSessions([row('A', true, 1), row('B', false, 0)]));
  assert.deepEqual(showingA, { id: 'A', running: true });
  const hot = T.resolveOrbState({ version: 1, active: false, intensity: 0, phase: 'idle', updatedAt: 1 }, showingA);
  assert.equal(hot.active, true, '焦点会话在跑 ⇒ 激活（即使 HTTP 快照说全局空闲）');
  assert.equal(hot.intensity, 1);

  // 没有 sessions 服务（老宿主 / fixture）⇒ 原样用 HTTP 快照
  const fallback = T.resolveOrbState({ version: 1, active: true, intensity: 1, phase: 'active', updatedAt: 1 }, null);
  assert.equal(fallback.active, true);

  // 焦点会话 id 会带进轮询 URL
  assert.equal(T.stateUrl('s-a'), '/api/energy-orb/state?session=s-a');
  assert.equal(T.stateUrl(undefined), '/api/energy-orb/state');
});

test('宿主没有 ctx.inject（极简/老 runtime）时 apply 不炸，只是退回全局口径', () => {
  let OrbComponent = null;
  const ctx = {
    // 故意不给 inject
    slots: {
      inject(slot, cb) { return cb(); },
      register(opts, component) { OrbComponent = component; return () => {}; },
    },
  };
  assert.doesNotThrow(() => mod.apply(ctx));
  assert.equal(typeof OrbComponent, 'function');
});
