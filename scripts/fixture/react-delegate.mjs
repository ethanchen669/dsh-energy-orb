// 迷你 React 桩（供 lifecycle fixture 用）：createElement/useEffect/useRef/useState + vnode→DOM
export const holder = { current: null };

function freshHooks() {
  const states = [];
  const refs = [];
  const cleanups = [];
  let si = 0, ri = 0;
  return {
    states, cleanups,
    begin() { si = 0; ri = 0; },
    useState(init) {
      const i = si++;
      if (!(i in states)) states[i] = typeof init === 'function' ? init() : init;
      return [states[i], (v) => { states[i] = v; }];
    },
    useRef(init) {
      const i = ri++;
      if (!(i in refs)) refs[i] = { current: init };
      return refs[i];
    },
    useEffect(fn) {
      const c = fn();
      if (typeof c === 'function') cleanups.push(c);
    },
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat() };
    },
  };
}

let hooks = freshHooks();
holder.current = hooks;

export const delegate = {
  createElement: (...a) => hooks.createElement(...a),
  useState: (...a) => hooks.useState(...a),
  useRef: (...a) => hooks.useRef(...a),
  useEffect: (...a) => hooks.useEffect(...a),
};

export function beginRender() {
  hooks.begin();
}

export function runCleanups(idempotentProbe) {
  for (const c of hooks.cleanups.splice(0)) {
    c();
    if (idempotentProbe) c();       // 幂等探针：二次调用不抛
  }
}

export function toDom(v) {
  if (v == null || v === false || v === true) return null;
  if (typeof v === 'string' || typeof v === 'number') return document.createTextNode(String(v));
  const el = document.createElement(v.type);
  for (const [k, val] of Object.entries(v.props || {})) {
    if (k === 'style' && val && typeof val === 'object') Object.assign(el.style, val);
    else if (k === 'className') el.className = val;                    // 真 React 的 className 语义（setAttribute 不认它）
    else if (k === 'ref' && typeof val === 'function') val(el);         // 函数 ref（真 React 同形）
    else if (k === 'ref' && val && typeof val === 'object') val.current = el;
    else if (k.startsWith('on') && typeof val === 'function') el.addEventListener(k.slice(2).toLowerCase(), val);
    else el.setAttribute(k, val === '' ? '' : String(val));
  }
  for (const c of v.children) {
    const d = toDom(c);
    if (d) el.appendChild(d);
  }
  return el;
}
