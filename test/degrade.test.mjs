// Client 半边的降级与接线（真组件、真 effect，只有球体模块是桩）。
// 这里守的三件事都是实测踩过的「球看不见 / 不动 / 方向反」的形状：
//  ①球体模块加载失败 → 必须挂出**可见**的 CSS 降级球（不是空白）
//  ②装好的球体必须被 update（状态推得进去）与 dispose（卸载后不残留 WebGL 上下文）
//  ③拖拽方向与右锚点语义一致
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findByData,
  findOneByData,
  installWindowGlobals,
  loadClientSpec,
  mountComponent,
  newRenderContext,
} from './helper/client-harness.mjs';

const STUB_CALLS = [];
globalThis.__SPHERE_CALLS = STUB_CALLS;
const { mem } = installWindowGlobals();

const dataModule = (src) => `data:text/javascript,${encodeURIComponent(src)}`;

/** 成功的球体模块桩：记录 createEnergySphere 的入参与句柄调用。 */
const OK_SPHERE = dataModule(`
export function createEnergySphere(container, options) {
  __SPHERE_CALLS.push({ kind: 'create', container, options });
  const canvas = { style: {} };
  if (container && typeof container.appendChild === 'function') container.appendChild(canvas);
  return { update(patch) { __SPHERE_CALLS.push({ kind: 'update', patch }); },
           pulse(strength) { __SPHERE_CALLS.push({ kind: 'pulse', strength }); },
           dispose() { __SPHERE_CALLS.push({ kind: 'dispose' }); } };
}
`);

/** 用指定资产 URL 起一次真实挂载（返回 stub 与首帧树）。 */
async function mount({ assets, prefs, reducedMotion = false } = {}) {
  installWindowGlobals({ reducedMotion });
  if (prefs) mem.set('energy-orb.display', JSON.stringify(prefs));
  const previous = globalThis.__ENERGY_ORB_ASSETS__;
  globalThis.__ENERGY_ORB_ASSETS__ = assets;
  const fresh = await loadClientSpec(new URL(`../client.js?t=${Math.random()}`, import.meta.url).href);
  const { OrbComponent, mod } = mountComponent(fresh);
  const stub = newRenderContext();
  const tree = stub.render(OrbComponent);
  // 模拟 React 把 ref 绑到真实 DOM 节点（本测试没有真 DOM）
  const container = {
    nodeType: 1,
    style: {},
    children: [],
    clientWidth: 192,
    clientHeight: 192,
    querySelector(sel) { return sel === 'canvas' ? (this.children.find((c) => c.style) || null) : null; },
    appendChild(node) { this.children.push(node); return node; },
  };
  const stage = findOneByData(tree, 'data-dsh-energy-orb-stage');
  // 真 React 支持函数 ref（我们用它同时写 stageRef 与 containerRef）：桩里也要按同形调用
  const bindRef = (ref) => {
    if (typeof ref === 'function') ref(container);
    else if (ref && typeof ref === 'object') ref.current = container;
  };
  if (stage && stage.props && stage.props.ref) bindRef(stage.props.ref);
  await new Promise((r) => setTimeout(r, 40));   // 放行 import + create + 首次 update
  return {
    stub, OrbComponent, mod, tree, stage, container,
    restore: () => { globalThis.__ENERGY_ORB_ASSETS__ = previous; },
  };
}

test('球体模块加载失败 → 可见的 CSS 降级球；单根元素；warn 恰一次；不炸页', async () => {
  const warns = [];
  const origWarn = console.warn;
  console.warn = (m) => warns.push(m);
  const uncaught = [];
  const onUncaught = (e) => uncaught.push(e);
  process.on('uncaughtException', onUncaught);
  const m = await mount({ assets: { sphere: '/nonexistent/energy-sphere.js' } });
  try {
    assert.equal(m.tree.props['data-dsh-energy-orb-root'], '', '根元素应带 data-dsh-energy-orb-root');
    const tree2 = m.stub.render(m.OrbComponent);
    const fallbackNodes = findByData(tree2, 'data-dsh-energy-orb-fallback');
    assert.equal(fallbackNodes.length, 1, '降级态应恰一个降级球节点');
    const child = fallbackNodes[0];
    assert.equal(child.type, 'div');
    assert.match(String(child.props.style.background), /radial-gradient/, '降级球必须可见（带渐变背景）');
    assert.equal(child.props.style.borderRadius, '50%');
    assert.equal(warns.length, 1, `降级 warn 应恰一次，实际 ${warns.length}`);
    assert.deepEqual(uncaught, [], '降级路径不许抛未捕获异常');
  } finally {
    process.off('uncaughtException', onUncaught);
    m.stub.unmount();
    m.restore();
    console.warn = origWarn;
  }
});

test('挂载成功 → 以静息参数建球、canvas 被拉伸到容器、轮询把状态 update 进去', async () => {
  STUB_CALLS.length = 0;
  const m = await mount({ assets: { sphere: OK_SPHERE } });
  try {
    assert.equal(m.stage.props['data-dsh-energy-orb-stage'], '', '成功路径应渲染球体舞台容器');
    assert.equal(m.stage.props.style.width, '100%', '舞台应铺满根元素');
    const create = STUB_CALLS.find((c) => c.kind === 'create');
    assert.ok(create, '应调用 createEnergySphere');
    assert.equal(create.options.heartbeatEnabled, false, '首帧静息参数应关心跳');
    assert.equal(create.options.coreScale, m.mod.__testables.idleOptions(false).coreScale);
    assert.equal(typeof create.options.onError, 'function', '必须给球体 onError（WebGL 失败要走降级）');
    const canvas = m.container.children.find((c) => c.style);
    assert.ok(canvas, '球体应把 canvas 挂进容器');
    assert.equal(canvas.style.width, '100%', 'canvas 必须 CSS 拉伸（setSize(...,false) 不写 style）');
    assert.equal(canvas.style.height, '100%');

    const updates = STUB_CALLS.filter((c) => c.kind === 'update');
    assert.ok(updates.length >= 1, '至少推一次参数（ramp 第一步）');
    for (const u of updates) {
      assert.ok(m.mod.__testables.OPTION_KEYS.every((k) => k in u.patch), `update 补丁字段不全：${Object.keys(u.patch)}`);
      assert.equal(typeof u.patch.heartbeatEnabled, 'boolean');
    }
  } finally {
    m.stub.unmount();
    m.restore();
  }
  const disposes = STUB_CALLS.filter((c) => c.kind === 'dispose');
  assert.equal(disposes.length, 1, `卸载应恰一次 dispose，实际 ${disposes.length}`);
});

test('激活状态到达后 → 心跳打开、参数收敛到激活目标', async () => {
  STUB_CALLS.length = 0;
  installWindowGlobals({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ version: 1, active: true, intensity: 1, phase: 'active', updatedAt: Date.now() }),
    }),
  });
  const m = await mount({ assets: { sphere: OK_SPHERE } });
  try {
    await new Promise((r) => setTimeout(r, 700));   // 让 ramp 走完 RAMP_MS
    const patches = STUB_CALLS.filter((c) => c.kind === 'update').map((c) => c.patch);
    assert.ok(patches.some((p) => p.heartbeatEnabled === true), '激活后必须打开心跳');
    const last = patches.at(-1);
    assert.ok(Math.abs(last.coreScale - 1.08) < 0.02, `核心大小应收敛到 1.08：${last.coreScale}`);
    assert.ok(Math.abs(last.bpm - 112) < 1, `心率应收敛到 112：${last.bpm}`);
    assert.ok(Math.abs(last.coreBrightness - 0.975) < 1e-9, `辉光应收敛到 0.975（上一版与暗版的中间值）：${last.coreBrightness}`);
  } finally {
    m.stub.unmount();
    m.restore();
  }
});

test('纯点击 → 一次 pulse；拖拽 → 不 pulse 且写回 offset', async () => {
  STUB_CALLS.length = 0;
  const listeners = new Map();
  const origAdd = globalThis.window.addEventListener;
  const origRemove = globalThis.window.removeEventListener;
  globalThis.window.addEventListener = (n, fn) => listeners.set(n, fn);
  globalThis.window.removeEventListener = (n) => listeners.delete(n);
  const m = await mount({ assets: { sphere: OK_SPHERE }, prefs: { size: 96, anchor: 'bottom-right', offset: { x: 0, y: 0 } } });
  try {
    // 拖拽/点击挂在**舞台**上（根元素只负责定位与折叠状态，折叠后舞台不渲染）
    const down = m.stage.props.onPointerDown;
    down({ clientX: 100, clientY: 100 });
    listeners.get('pointerup')();
    const pulses = STUB_CALLS.filter((c) => c.kind === 'pulse');
    assert.equal(pulses.length, 1, '纯点击应 pulse 一次');
    assert.equal(pulses[0].strength, 1.2);

    STUB_CALLS.length = 0;
    down({ clientX: 100, clientY: 100 });
    listeners.get('pointermove')({ clientX: 140, clientY: 130 });
    m.stub.render(m.OrbComponent);   // React 会在 pointerup 前重渲染（ref 才能跟上）
    listeners.get('pointerup')();
    assert.equal(STUB_CALLS.filter((c) => c.kind === 'pulse').length, 0, '拖拽不算充能');
    const saved = JSON.parse(mem.get('energy-orb.display'));
    assert.deepEqual(saved.offset, { x: 40, y: 30 }, '拖拽位移应写回 localStorage');
  } finally {
    globalThis.window.addEventListener = origAdd;
    globalThis.window.removeEventListener = origRemove;
    m.stub.unmount();
    m.restore();
  }
});

test('拖拽偏移方向：右拖球向右（right 减小）、下拖球向下（bottom 减小），calc 语法合法', async () => {
  const run = async (offset, anchor = 'bottom-right') => {
    const m = await mount({ assets: { sphere: OK_SPHERE }, prefs: { size: 96, anchor, offset } });
    try {
      return m.tree.props.style;
    } finally {
      m.stub.unmount();
      m.restore();
      mem.delete('energy-orb.display');
    }
  };
  const s1 = await run({ x: 40, y: 10 });
  assert.equal(s1.right, 'calc(26px - 40px)', '右拖（offset.x+）球应向右：right 减小');
  assert.equal(s1.bottom, 'calc(22px - 10px)', '下拖（offset.y+）球应向下：bottom 减小');
  const s2 = await run({ x: -30, y: -5 });
  assert.equal(s2.right, 'calc(26px + 30px)', '左拖（offset.x-）球应向左：right 增大');
  assert.equal(s2.bottom, 'calc(22px + 5px)', '上拖（offset.y-）球应向上：bottom 增大');
  const s3 = await run({ x: 40, y: 10 }, 'bottom-left');
  assert.equal(s3.left, 'calc(26px + 40px)', '左锚点：右拖 left 增大');
  assert.equal(s3.right, 'auto');
});

test('球体 onError（WebGL 失败）→ 降级球接管，且 warn 恰一次', async () => {
  const warns = [];
  const origWarn = console.warn;
  console.warn = (m) => warns.push(m);
  const ERROR_SPHERE = dataModule(`
export function createEnergySphere(container, options) {
  options.onError(new Error('EnergySphere could not initialize WebGL'));
  return { update() {}, pulse() {}, dispose() { __SPHERE_CALLS.push({ kind: 'dispose' }); } };
}
`);
  const m = await mount({ assets: { sphere: ERROR_SPHERE } });
  try {
    const tree2 = m.stub.render(m.OrbComponent);
    assert.ok(findOneByData(tree2, 'data-dsh-energy-orb-fallback'), 'onError 后应切降级球');
    assert.equal(warns.length, 1, `webgl 降级 warn 应恰一次，实际 ${warns.length}`);
  } finally {
    m.stub.unmount();
    m.restore();
    console.warn = origWarn;
  }
});

test('隐藏/展开：默认展开；点隐藏按钮折叠成 40px 把手并落盘；点把手展开并恢复球体', async () => {
  STUB_CALLS.length = 0;
  mem.delete('energy-orb.display');
  const m = await mount({ assets: { sphere: OK_SPHERE } });
  try {
    const root = () => m.stub.render(m.OrbComponent);
    // ① 默认展开：有舞台、有隐藏按钮，没有把手
    assert.ok(findOneByData(root(), 'data-dsh-energy-orb-stage'), '默认应渲染球体舞台');
    const expandedStage = findOneByData(root(), 'data-dsh-energy-orb-stage');
    const hideButton = findOneByData(root(), 'data-dsh-energy-orb-hide');
    assert.ok(hideButton, '默认应有隐藏按钮');
    assert.equal(hideButton.props['aria-label'], '隐藏能量球');
    assert.equal(hideButton.props.title, undefined, '不许再设原生 title：它会和自绘气泡叠成两个 tooltip');
    // hover 提示：× 按钮里带一个"隐藏 / hide"标签（纯 CSS 显隐），读屏器走 aria-label
    const hideLabel = findByData(root(), 'data-dsh-energy-orb-hide-label')[0];
    assert.ok(hideLabel, '× 按钮里应有悬浮提示节点');
    assert.equal(hideLabel.children.join(''), '隐藏 / hide');
    assert.equal(hideLabel.props['aria-hidden'], 'true', '提示文字不该被读屏器重复朗读');

    // ② 点隐藏 → 折叠：舞台 display:none、把手显形、根节点尺寸缩到 40px、prefs 落盘
    hideButton.props.onClick({ stopPropagation() {} });
    const collapsedTree = root();
    assert.equal(collapsedTree.props['data-dsh-energy-orb-collapsed'], 'true');
    const collapsedStage = findOneByData(collapsedTree, 'data-dsh-energy-orb-stage');
    assert.equal(collapsedStage.props.style.opacity, 0, '折叠后舞台必须淡出（不是一刀切 display:none）');
    assert.ok(String(collapsedStage.props.style.transform).includes('scale(0.32'), '折叠后舞台要缩进角落');
    assert.equal(collapsedStage.props.style.pointerEvents, 'none', '折叠后舞台不接指针');
    assert.equal(collapsedStage.props.style.transition, expandedStage.props.style.transition, '两个方向必须是同一组过渡（逆过程）');
    const handle = findOneByData(collapsedTree, 'data-dsh-energy-orb-handle');
    assert.ok(handle, '折叠后应有把手');
    assert.equal(handle.props.style.opacity, 1, '折叠后把手要显形（淡入）');
    assert.equal(handle.props.style.pointerEvents, 'auto', '折叠后把手接指针');
    assert.equal(handle.props.tabIndex, 0, '折叠后把手可被 Tab 到');
    assert.equal(handle.props['aria-label'], '展开能量球');
    assert.equal(findOneByData(collapsedTree, 'data-dsh-energy-orb-hide').props.style.display, 'none', '折叠后隐藏按钮让位给把手');
    assert.equal(collapsedTree.props.style.width, '40px');
    assert.equal(collapsedTree.props.style.height, '40px');
    assert.equal(JSON.parse(mem.get('energy-orb.display')).collapsed, true, '折叠状态要落盘');
    assert.ok(STUB_CALLS.some((c) => c.kind === 'update' && c.patch.paused === true), '折叠后应把球体暂停');

    // ③ 点把手 → 展开：舞台恢复、折叠标记复位、球体恢复
    handle.props.onClick({ stopPropagation() {} });
    const expandedTree = root();
    assert.equal(expandedTree.props['data-dsh-energy-orb-collapsed'], 'false');
    const backStage = findOneByData(expandedTree, 'data-dsh-energy-orb-stage');
    assert.equal(backStage.props.style.opacity, 1, '展开后舞台淡入');
    assert.ok(String(backStage.props.style.transform).includes('scale(1'), '展开后舞台回到 1:1');
    assert.equal(backStage.props.style.transition, expandedStage.props.style.transition);
    assert.equal(findOneByData(expandedTree, 'data-dsh-energy-orb-handle').props.style.opacity, 0, '展开后把手淡出');
    assert.equal(JSON.parse(mem.get('energy-orb.display')).collapsed, false);
    assert.ok(STUB_CALLS.some((c) => c.kind === 'update' && c.patch.paused === false), '展开后应恢复球体');

    // ④ 键盘可达：把手是 button（原生支持 Enter/Space），类型必须是 button（别在表单里提交）
    assert.equal(handle.type, 'button');
    assert.equal(handle.props.type, 'button');
  } finally {
    m.stub.unmount();
    m.restore();
    mem.delete('energy-orb.display');
  }
});

test('老存档没有 collapsed 字段 → 按展开处理（迁移不许把球自动藏起来）', async () => {
  mem.set('energy-orb.display', JSON.stringify({ visible: true, size: 96, anchor: 'bottom-right', offset: { x: 0, y: 0 } }));
  const m = await mount({ assets: { sphere: OK_SPHERE } });
  try {
    const tree = m.stub.render(m.OrbComponent);
    assert.equal(tree.props['data-dsh-energy-orb-collapsed'], 'false');
    assert.equal(findOneByData(tree, 'data-dsh-energy-orb-stage').props.style.opacity, 1);
  } finally {
    m.stub.unmount();
    m.restore();
    mem.delete('energy-orb.display');
  }
});

test('折叠态的把手也能拖：按住移动改位置、不触发展开；轻点仍展开', async () => {
  STUB_CALLS.length = 0;
  mem.delete('energy-orb.display');
  const listeners = new Map();
  const origAdd = globalThis.window.addEventListener;
  const origRemove = globalThis.window.removeEventListener;
  globalThis.window.addEventListener = (n, fn) => listeners.set(n, fn);
  globalThis.window.removeEventListener = (n) => listeners.delete(n);
  const m = await mount({ assets: { sphere: OK_SPHERE } });
  try {
    let tree = m.stub.render(m.OrbComponent);
    findOneByData(tree, 'data-dsh-energy-orb-hide').props.onClick({ stopPropagation() {} });
    tree = m.stub.render(m.OrbComponent);
    const handle = findOneByData(tree, 'data-dsh-energy-orb-handle');

    // ① 按住拖动 40px → offset 写回，仍是折叠态（没被误触展开）
    handle.props.onPointerDown({ button: 0, clientX: 100, clientY: 100, stopPropagation() {} });
    listeners.get('pointermove')({ clientX: 140, clientY: 130 });
    m.stub.render(m.OrbComponent);         // React 会在 pointerup 前重渲染
    listeners.get('pointerup')();
    const saved = JSON.parse(mem.get('energy-orb.display'));
    assert.deepEqual(saved.offset, { x: 40, y: 30 }, '折叠态拖拽也要写回 offset');
    assert.equal(saved.collapsed, true, '拖拽不许把折叠态改掉');
    // 拖完浏览器补的 click 必须被吞掉（否则"拖一下就展开"了）
    const handleAfterDrag = findOneByData(m.stub.render(m.OrbComponent), 'data-dsh-energy-orb-handle');
    handleAfterDrag.props.onClick({ stopPropagation() {} });
    assert.equal(JSON.parse(mem.get('energy-orb.display')).collapsed, true, '拖拽尾巴的 click 不该展开');

    // ② 轻点（不移动）→ 走 click 展开
    const fresh = (await mount({ assets: { sphere: OK_SPHERE } }));
    try {
      let t = fresh.stub.render(fresh.OrbComponent);
      findOneByData(t, 'data-dsh-energy-orb-hide').props.onClick({ stopPropagation() {} });
      t = fresh.stub.render(fresh.OrbComponent);
      const h2 = findOneByData(t, 'data-dsh-energy-orb-handle');
      h2.props.onPointerDown({ button: 0, clientX: 10, clientY: 10, stopPropagation() {} });
      listeners.get('pointerup')();                     // 没移动
      h2.props.onClick({ stopPropagation() {} });        // 浏览器随后补的 click
      assert.equal(JSON.parse(mem.get('energy-orb.display')).collapsed, false, '轻点应展开');
    } finally {
      fresh.stub.unmount();
      fresh.restore();
    }
  } finally {
    globalThis.window.addEventListener = origAdd;
    globalThis.window.removeEventListener = origRemove;
    m.stub.unmount();
    m.restore();
    mem.delete('energy-orb.display');
  }
});
