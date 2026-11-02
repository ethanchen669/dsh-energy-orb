// vendored 球体组件的契约测试（apps/energy-sphere-demo 的副本）。
// 两件事同时守：①副本没被改坏（几何/心跳/参数默认值都是定稿值）；
// ②组件在**没有 WebGL 的宿主里**仍然安全（onError 一次 + no-op 句柄），插件据此降级。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../client/vendor/three.module.min.js';
import {
  CORE_SPIN_RATIO,
  CORE_VISUAL_SCALE,
  OUTER_RING_DEFINITIONS,
  RING_ARC_TUBE,
  RING_NODE_RADIUS,
  RING_TUBE_RADIUS,
  createEnergySphere,
  orientRing,
  ringNormal,
  updateRingPose,
} from '../client/sphere/energy-sphere.js';
import { heartbeatAt } from '../client/sphere/animation.js';
import { assertContainer, normalizeOptions, validatePulseStrength } from '../client/sphere/options.js';

const CAMERA_POSITION = new THREE.Vector3(4.4, 2.8, 8);

test('核心基准放大 22%（定稿视觉，不许顺手改）', () => {
  assert.equal(CORE_VISUAL_SCALE, 1.22);
});

test('三条外环共用半径 3（切线投影的前提）', () => {
  assert.deepEqual(OUTER_RING_DEFINITIONS.map(({ radius }) => radius), [3, 3, 3]);
});

test('水平环与垂直环保持正交；第三环正对相机成平面圆', () => {
  const horizontal = ringNormal(OUTER_RING_DEFINITIONS[1].rotation);
  const vertical = ringNormal(OUTER_RING_DEFINITIONS[2].rotation);
  assert.ok(Math.abs(horizontal.dot(vertical)) < 1e-10, '两环不正交');

  const group = new THREE.Group();
  orientRing(group, OUTER_RING_DEFINITIONS[0], CAMERA_POSITION);
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(group.quaternion);
  assert.ok(Math.abs(normal.dot(CAMERA_POSITION.clone().normalize()) - 1) < 1e-9, 'viewPlane 环未正对相机');
});

test('环自转随 delta 与 rotationSpeed 增量推进；速度为 0 时静止', () => {
  const make = () => {
    const ring = { spin: new THREE.Group() };
    return ring;
  };
  const a = make();
  const b = make();
  updateRingPose(a, OUTER_RING_DEFINITIONS[0], 10, 1);
  updateRingPose(b, OUTER_RING_DEFINITIONS[0], 10, 0);
  assert.ok(Math.abs(a.spin.rotation.z) > 0.5, `环应自转：${a.spin.rotation.z}`);
  assert.equal(b.spin.rotation.z, OUTER_RING_DEFINITIONS[0].rotation[2], '速度为 0 时不许转');
});

test('速度乘子只影响未来角：累计角永不因乘子变化重算（时移回归钉）', () => {
  const ring = { spin: new THREE.Group() };
  const def = OUTER_RING_DEFINITIONS[0];
  for (let i = 0; i < 100; i += 1) updateRingPose(ring, def, 1, 1);   // 累计 100s @ 1×
  const before = ring.spin.rotation.z;
  updateRingPose(ring, def, 1, 3);                                    // 再来 1s @ 3×
  const delta = ring.spin.rotation.z - before;
  assert.ok(Math.abs(delta - 3 * def.speed) < 1e-9,
    `乘子变 3 后 1s 只该推进 ${3 * def.speed}，实得 ${delta}（旧公式会把 100s 历史角整体重算）`);
});

test('双拍心跳：主峰强、次峰小、静息接近 0；相位恒在 [0,1)', () => {
  const primary = heartbeatAt(0.08, 60);
  const secondary = heartbeatAt(0.28, 60);
  const rest = heartbeatAt(0.55, 60);
  assert.ok(primary.beat > 0.95, `主峰 beat=${primary.beat}`);
  assert.ok(secondary.beat > 0.45 && secondary.beat < 0.7, `次峰 beat=${secondary.beat}`);
  assert.ok(rest.beat < 0.01, `静息 beat=${rest.beat}`);
  assert.ok(primary.scale > secondary.scale && secondary.scale > rest.scale, 'scale 排序不符');
  assert.ok(primary.glow > secondary.glow && secondary.glow > rest.glow, 'glow 排序不符');
  for (const seconds of [123456.789, -0.1, 0, 1]) {
    const { phase } = heartbeatAt(seconds, 64);
    assert.ok(phase >= 0 && phase < 1, `phase ${phase} @ ${seconds}`);
  }
});

test('参数默认值即定稿视觉；越界抛 RangeError', () => {
  const d = normalizeOptions({});
  assert.deepEqual(
    { color: d.color, bpm: d.bpm, rotationSpeed: d.rotationSpeed, energy: d.energy, coreScale: d.coreScale, coreBrightness: d.coreBrightness, heartbeatEnabled: d.heartbeatEnabled, paused: d.paused },
    { color: '#42dcff', bpm: 64, rotationSpeed: 1, energy: 1, coreScale: 1, coreBrightness: 1, heartbeatEnabled: true, paused: false },
  );
  assert.doesNotThrow(() => normalizeOptions({}, { bpm: 30, rotationSpeed: 0, energy: 0, coreScale: 0.75, coreBrightness: 0 }));
  assert.doesNotThrow(() => normalizeOptions({}, { bpm: 200, rotationSpeed: 4, energy: 2, coreScale: 1.5, coreBrightness: 2 }));
  // 运行态最高约 134×：上界 200 必须放行（上界太小会把高速判成越界，症状是"转速没变"）
  assert.equal(normalizeOptions({}, { rotationSpeed: 200 }).rotationSpeed, 200);
  for (const patch of [{ bpm: 29 }, { rotationSpeed: 200.0001 }, { energy: -0.1 }, { coreScale: 0.7 }, { coreBrightness: 2.1 }]) {
    assert.throws(() => normalizeOptions({}, patch), RangeError, `应抛 RangeError：${JSON.stringify(patch)}`);
  }
  assert.throws(() => normalizeOptions({}, { bpm: NaN }), RangeError);
});

test('pulse 强度 0..3 合法；容器必须是元素', () => {
  assert.equal(validatePulseStrength(undefined), 1);
  assert.doesNotThrow(() => validatePulseStrength(3));
  assert.throws(() => validatePulseStrength(3.1), RangeError);
  assert.throws(() => assertContainer(null), TypeError);
  assert.throws(() => assertContainer({ nodeType: 3 }), TypeError);
  assert.equal(assertContainer({ nodeType: 1, appendChild() {} }).nodeType, 1);
});

test('无 WebGL 环境：onError 恰一次 + 返回 no-op 句柄（update/pulse/dispose 不抛）', () => {
  const errors = [];
  const handle = createEnergySphere(
    { nodeType: 1, appendChild() {} },
    { onError: (e) => errors.push(e) },
  );
  assert.equal(errors.length, 1, `onError 应恰一次，实际 ${errors.length}`);
  assert.match(errors[0].message, /WebGL/);
  // 宿主降级路径：这些调用一个都不许炸
  assert.doesNotThrow(() => handle.update({ coreScale: 1.2 }));
  assert.doesNotThrow(() => handle.pulse(1.4));
  assert.doesNotThrow(() => handle.dispose());
  assert.doesNotThrow(() => handle.dispose());
});

test('定稿视觉：三个外环管径 0.025', () => {
  assert.equal(RING_TUBE_RADIUS, 0.025);
  assert.ok(RING_ARC_TUBE[0] >= RING_TUBE_RADIUS * 0.9, '短弧要跟上主管径');
  assert.ok(RING_ARC_TUBE[1] <= RING_TUBE_RADIUS * 1.4, '短弧也不该无限粗');
});

test('环上亮点直径明显大于环厚（半径 = 2 × 管径 ⇒ 直径 4×）', () => {
  assert.ok(Math.abs(RING_NODE_RADIUS - RING_TUBE_RADIUS * 2) < 1e-12);
  assert.ok(RING_NODE_RADIUS * 2 >= RING_TUBE_RADIUS * 3, '亮点要"一眼看得见"，不是仅比环厚一点点');
});

test('核心自转 = 0.6 × 最快环（静息与运行同一比例，结构性而非按状态给常量）', () => {
  assert.equal(CORE_SPIN_RATIO, 0.6);
  const ring1 = OUTER_RING_DEFINITIONS[0].speed;          // rad/s @1×
  assert.ok(Math.abs(ring1 * CORE_SPIN_RATIO - 0.066) < 1e-9,
    `核心基准角速度应为 0.066（= 0.11 × 0.6），实得 ${ring1 * CORE_SPIN_RATIO}`);
  // 两态都不许改这个关系：静息 0.825× 与运行 134.4× 下，核心/环1 的角速度比仍是 0.6
  for (const mult of [0.825, 134.4]) {
    const core = ring1 * CORE_SPIN_RATIO * mult;
    const ring = ring1 * mult;
    assert.ok(Math.abs(core / ring - 0.6) < 1e-12, `乘子 ${mult} 下比例跑偏：${core / ring}`);
  }
});
