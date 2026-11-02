// 把 classic-script 形态的 client.js 接进 node 测试的公共桩（window / localStorage / 迷你 React）。
// client.js 没有 export，所以路径是：造 window.__ModuleLoader__ → import → 拿 spec.factory(require)。
//
// 两个容易踩的坑（都踩过）：
//  ①迷你 React 必须「每次渲染把 hook 游标归零」，否则第二次渲染会分配**新的** state 槽位，
//    setState 写进旧槽位、界面永远不变（降级球测不出来的那种假红）。
//  ②window 必须是**同一个对象**（React 组件里的 localStorage/fetch 在渲染时才读）；
//    换 window 等于换掉组件看到的世界，先前写进 prefs 的数据就"消失"了。

export const reactDelegate = {
  createElement: (...a) => reactDelegate._impl.createElement(...a),
  useState: (...a) => reactDelegate._impl.useState(...a),
  useRef: (...a) => reactDelegate._impl.useRef(...a),
  useEffect: (...a) => reactDelegate._impl.useEffect(...a),
  _impl: {
    createElement: () => null,
    useState: (v) => [v, () => {}],
    useRef: (v) => ({ current: v }),
    useEffect: () => {},
  },
};

/** 造一个迷你 React：hooks 按调用序分配槽位，effect 同步执行并记录 cleanup。 */
export function makeReactStub() {
  const cleanups = [];
  let stateIdx = 0;
  let refIdx = 0;
  const states = [];
  const refs = [];
  let effectsRun = 0;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    useState: (init) => {
      const i = stateIdx++;
      if (!(i in states)) states[i] = typeof init === 'function' ? init() : init;
      return [states[i], (v) => { states[i] = typeof v === 'function' ? v(states[i]) : v; }];
    },
    useRef: (init) => {
      const i = refIdx++;
      if (!(i in refs)) refs[i] = { current: init };
      return refs[i];
    },
    // 与 React 的 deps=[] 同形：effect 只在**首次渲染**跑（否则重渲染会重复建球体）
    useEffect: (fn) => {
      if (effectsRun > 0) return;
      effectsRun += 1;
      const c = fn();
      if (typeof c === 'function') cleanups.push(c);
    },
  };
  return {
    React,
    cleanups,
    states,
    refs,
    /** 渲染一次（模拟 React 的 hook 顺序：每次渲染从 0 开始）。 */
    render(component) {
      stateIdx = 0;
      refIdx = 0;
      return component();
    },
    /** 卸载：跑所有 cleanup，并再跑一遍探幂等（二次调用不许抛）。 */
    unmount() {
      for (const c of cleanups.splice(0)) {
        try { c(); } catch (e) { throw new Error(`cleanup 首次调用抛错：${e.message}`); }
        try { c(); } catch { /* 幂等探针：二次调用应安全 */ }
      }
    },
  };
}

/** 装（或重配）window 全局桩。window 对象全程复用。 */
export function installWindowGlobals(options = {}) {
  if (!globalThis.window || !globalThis.window.__ModuleLoader__) {
    const mem = new Map();
    const captured = { spec: null };
    globalThis.window = {
      __ModuleLoader__: { load(spec) { captured.spec = spec; } },
      captured,
      mem,
      localStorage: {
        getItem: (k) => (mem.has(k) ? mem.get(k) : null),
        setItem: (k, v) => mem.set(k, String(v)),
        removeItem: (k) => mem.delete(k),
      },
      matchMedia: () => ({ matches: Boolean(globalThis.window.__reducedMotion) }),
      fetch: async () => ({
        ok: true,
        json: async () => ({ version: 1, active: false, intensity: 0, phase: 'idle', updatedAt: Date.now() }),
      }),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (t) => clearTimeout(t),
      addEventListener() {},
      removeEventListener() {},
      __reducedMotion: false,
    };
  }
  if (options.fetchImpl) globalThis.window.fetch = options.fetchImpl;
  if ('reducedMotion' in options) globalThis.window.__reducedMotion = Boolean(options.reducedMotion);
  return { mem: globalThis.window.mem, captured: globalThis.window.captured };
}

/** import client.js（可带 cache-busting 查询串）并返回 ModuleLoader 收到的 spec。 */
export async function loadClientSpec(url) {
  const target = url || new URL('../../client.js', import.meta.url).href;
  const before = globalThis.window.captured.spec;
  globalThis.window.captured.spec = null;
  await import(target);
  const spec = globalThis.window.captured.spec;
  if (!spec) throw new Error('client.js 没有调用 window.__ModuleLoader__.load（注册丢失）');
  globalThis.window.captured.spec = before;
  return spec;
}

const requireStub = (name) => {
  if (name === 'react') return reactDelegate;
  throw new Error(`unexpected require: ${name}`);
};

/** 求值 factory 并 apply 到 slots，返回 { mod, OrbComponent }。 */
export function mountComponent(spec) {
  const mod = spec.factory(requireStub);
  let OrbComponent = null;
  const injectCalls = [];
  mod.apply({
    // 真 cordis 的客户端 context 同时有 `inject(deps, cb)`（惰性拿服务）与 `slots`。
    // 桩里默认"服务不可用"（cb 不执行 ⇒ 退回 HTTP 全局口径），需要时用 injectCalls 手动喂服务。
    inject(deps, cb) { injectCalls.push({ deps, cb }); return () => {}; },
    slots: {
      inject(slot, cb) { return cb(); },
      register(opts, component) { OrbComponent = component; return () => {}; },
    },
  });
  spec.injectCalls = injectCalls;
  if (typeof OrbComponent !== 'function') throw new Error('apply 未捕获 shell.overlay 组件');
  return { mod, OrbComponent };
}

/** 新的一次挂载上下文（全新 hooks 与 cleanups）。 */
export function newRenderContext() {
  const stub = makeReactStub();
  reactDelegate._impl = stub.React;
  return stub;
}

/** 深度遍历渲染树（`h()` 产物）：children 可能是节点、数组或 null（条件渲染）。 */
export function walkTree(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return;
  visit(node);
  for (const child of Array.isArray(node.children) ? node.children : []) {
    if (Array.isArray(child)) for (const nested of child) walkTree(nested, visit);
    else walkTree(child, visit);
  }
}

/** 找所有带指定 data-* 属性的节点（折叠把手 / 隐藏按钮 / 舞台容器都靠它定位）。 */
export function findByData(node, attribute) {
  const found = [];
  walkTree(node, (candidate) => {
    if (candidate.props && Object.prototype.hasOwnProperty.call(candidate.props, attribute)) found.push(candidate);
  });
  return found;
}

/** 找第一个带指定 data-* 属性的节点（没有就 null）。 */
export function findOneByData(node, attribute) {
  return findByData(node, attribute)[0] ?? null;
}
