import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchContext } from '../client/orb-renderer.js';

// ---------- watchContext：上下文丢失三路径 ----------
function fakeCanvas() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
    fire(name, e) { listeners.get(name)?.(e); },
  };
}

test('watchContext：首次丢失限时尝试恢复，恢复成功则不降级', () => {
  const cv = fakeCanvas();
  let finals = 0;
  let timerFn = null;
  const w = watchContext(cv, () => finals++, {
    restoreTimeoutMs: 50,
    setTimer: (fn) => { timerFn = fn; return 1; },
    clearTimer: () => { timerFn = null; },
  });
  let prevented = false;
  cv.fire('webglcontextlost', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, '丢失时应 preventDefault 争取恢复');
  assert.equal(finals, 0, '恢复尝试期内不降级');
  cv.fire('webglcontextrestored');
  assert.equal(timerFn, null, '恢复后计时器应清除');
  assert.equal(finals, 0);
  w.dispose();
});

test('watchContext：恢复超时 → 降级一次', () => {
  const cv = fakeCanvas();
  let finals = 0;
  let timerFn = null;
  const w = watchContext(cv, () => finals++, {
    restoreTimeoutMs: 50,
    setTimer: (fn) => { timerFn = fn; return 1; },
    clearTimer: () => { timerFn = null; },
  });
  cv.fire('webglcontextlost', { preventDefault() {} });
  assert.ok(typeof timerFn === 'function');
  timerFn();                       // 模拟超时
  assert.equal(finals, 1);
  assert.equal(cv.listeners.size, 0, '降级后监听应拆除');
  w.dispose();                     // 二次 dispose 不抛
});

test('watchContext：二次丢失（未恢复）→ 立即降级一次', () => {
  const cv = fakeCanvas();
  let finals = 0;
  const w = watchContext(cv, () => finals++, {
    restoreTimeoutMs: 50,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  cv.fire('webglcontextlost', { preventDefault() {} });
  cv.fire('webglcontextlost', { preventDefault() {} });
  assert.equal(finals, 1);
  assert.equal(cv.listeners.size, 0);
  w.dispose();
});

// ---------- client.js：vendor 加载失败 → CSS 降级球；单例根 ----------
const captured = { spec: null };
const mem = new Map();
globalThis.window = {
  __ModuleLoader__: { load(spec) { captured.spec = spec; } },
  localStorage: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, v),
  },
  matchMedia: () => ({ matches: false }),
  fetch: async () => ({ ok: true, json: async () => ({ version: 1, active: false, intensity: 0, phase: 'idle', updatedAt: Date.now() }) }),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
  addEventListener() {},
  removeEventListener() {},
};
globalThis.__ENERGY_ORB_ASSETS__ = { renderer: '/nonexistent/orb-renderer.js', three: '/nonexistent/three.js' };
await import('../client.js');

function makeReactStub() {
  const cleanups = [];
  let stateIdx = 0, refIdx = 0;
  const states = [], refs = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => {
      const i = stateIdx++;
      if (!(i in states)) states[i] = typeof init === 'function' ? init() : init;
      return [states[i], (v) => { states[i] = v; }];
    },
    useRef: (init) => {
      const i = refIdx++;
      if (!(i in refs)) refs[i] = { current: init };
      return refs[i];
    },
    useEffect: (fn) => {
      const c = fn();
      if (typeof c === 'function') cleanups.push(c);
    },
  };
  return {
    React, cleanups, states,
    render: () => { stateIdx = 0; refIdx = 0; return OrbComponent(); },
  };
}

const stubRequire = (name) => {
  if (name === 'react') return reactDelegate;
  throw new Error(`unexpected require: ${name}`);
};
// React 经委托器注入：工厂闭包拿到的是稳定的 delegate，测试里热换 stub
const stubReactHolder = { current: null };
const reactDelegate = {
  createElement: (...a) => stubReactHolder.current.createElement(...a),
  useState: (...a) => stubReactHolder.current.useState(...a),
  useRef: (...a) => stubReactHolder.current.useRef(...a),
  useEffect: (...a) => stubReactHolder.current.useEffect(...a),
};
stubReactHolder.current = makeReactStub().React;   // 工厂求值 h = React.createElement 时需非空
const factory = captured.spec.factory(stubRequire);
// 经 apply 捕获 shell.overlay 注册的组件
let OrbComponent = null;
factory.apply({
  slots: {
    inject(slot, cb) { return cb(); },
    register(opts, component) { OrbComponent = component; return () => {}; },
  },
});
assert.equal(typeof OrbComponent, 'function', '应捕获 shell.overlay 组件');

test('vendor 加载失败 → CSS 降级球挂出；单次挂载恰一个根元素', async () => {
  const stub = makeReactStub();
  stubReactHolder.current = stub.React;
  const tree = stub.render();
  assert.equal(tree.props['data-dsh-energy-orb-root'], '', '根元素应带 data-dsh-energy-orb-root');
  assert.equal(tree.children.length, 1, '恰一个子节点');
  // effect 已跑（stub 的 useEffect 同步执行），import 失败 → setFallback(true)
  await new Promise((r) => setTimeout(r, 30));     // 放行 import rejection 的微任务
  const tree2 = stub.render();
  const child = tree2.children[0];
  assert.equal(child.props['data-dsh-energy-orb-fallback'], '', '失败后应渲染 CSS 降级球');
  assert.equal(child.type, 'div');
  // 清理：effect cleanup 停轮询 + 释放（二次调用不抛）
  for (const c of stub.cleanups) { c(); c(); }
});
