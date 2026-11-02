import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installWindowGlobals, loadClientSpec, mountComponent } from './helper/client-harness.mjs';
import { normalizeOptions } from '../client/sphere/options.js';

installWindowGlobals();
const spec = await loadClientSpec();
const { mod } = mountComponent(spec);
const T = mod.__testables;

const NOW = 1_700_000_000_000;
const active = (patch = {}) => ({ version: 1, active: true, intensity: 1, phase: 'active', updatedAt: NOW, ...patch });
const idle = (patch = {}) => ({ version: 1, active: false, intensity: 0, phase: 'idle', updatedAt: NOW, ...patch });

/** 映射出来的参数必须能被球体组件自己的 normalizeOptions 接受（否则运行期 RangeError）。 */
function assertAccepted(options, label) {
  assert.doesNotThrow(() => normalizeOptions({}, stripColor(options)), `${label} 的参数超出资方范围`);
}

function stripColor(options) {
  const { color, ...numericAndFlags } = options;
  return numericAndFlags;
}

test('静息（无活动回合）→ 核心缩小 + 关心跳（静态就是静态）', () => {
  const out = T.stateToSphereOptions(idle(), NOW);
  assert.equal(out.heartbeatEnabled, false, '静息不许有心跳');
  assert.ok(out.coreScale < 1, `静息核心应小于满尺寸：${out.coreScale}`);
  assert.ok(out.coreBrightness <= 0.6, `静息辉光应压暗：${out.coreBrightness}`);
  assertAccepted(out, '静息');
});

test('激活 → 心跳 + 放大 + 提亮；intensity 提频 64→112 BPM', () => {
  const hot = T.stateToSphereOptions(active({ intensity: 1 }), NOW);
  assert.equal(hot.heartbeatEnabled, true);
  assert.ok(hot.coreScale > 1, `激活核心应放大：${hot.coreScale}`);
  assert.ok(hot.coreBrightness > 0.6, `激活辉光应高于静息：${hot.coreBrightness}`);
  assert.equal(hot.bpm, 112);

  const cold = T.stateToSphereOptions(active({ intensity: 0 }), NOW);
  assert.equal(cold.bpm, 64);
  assertAccepted(hot, '激活');
  assertAccepted(cold, '激活低速');
});

test('激活比静息更大更亮（同一组尺子上的单调性）', () => {
  const i = T.stateToSphereOptions(idle(), NOW);
  const a = T.stateToSphereOptions(active(), NOW);
  assert.ok(a.coreScale > i.coreScale);
  assert.ok(a.coreBrightness > i.coreBrightness);
  assert.ok(a.energy > i.energy, `运行态 energy ${a.energy} 必须高于静息 ${i.energy}（否则运行比静息还暗）`);
  assert.ok(a.rotationSpeed > i.rotationSpeed);
});

test('运行态环速跟着心跳走：环1 rev/min ≈ 1.1 × bpm（乘子 1.05×bpm），静息 0.825×（旧静息的 1.5 倍）', () => {
  const hot = T.stateToSphereOptions(active({ intensity: 1 }), NOW);
  const cold = T.stateToSphereOptions(active({ intensity: 0 }), NOW);
  const idleState = T.stateToSphereOptions(idle(), NOW);
  assert.equal(idleState.rotationSpeed, 0.825, '静息环速（= 旧 0.55 × 1.5）');
  // 运行态 = 1.05 × bpm：强度 0 → 67.2；强度 1 → 117.6
  assert.ok(Math.abs(cold.rotationSpeed - 67.2) < 1e-9, `运行态（强度 0）环速 ${cold.rotationSpeed}`);
  assert.ok(Math.abs(hot.rotationSpeed - 117.6) < 1e-9, `运行态（强度 1）环速 ${hot.rotationSpeed}`);
  assert.equal(cold.bpm, 64);
  assert.equal(hot.bpm, 112);
  assert.ok(hot.rotationSpeed > cold.rotationSpeed, '强度越高转得越快');
  assert.ok(cold.rotationSpeed > idleState.rotationSpeed, '运行态任何强度都快于静息');
});

test('陈旧状态（>10s）→ 按静息呈现且恰一次 warn；9s 仍是激活（两边界）', () => {
  const warns = [];
  const stale = T.stateToSphereOptions(active({ updatedAt: NOW - 11_000 }), NOW, { warn: (m) => warns.push(m) });
  assert.equal(stale.heartbeatEnabled, false);
  assert.equal(warns.length, 1, `陈旧应恰一次 warn，实际 ${warns.length}`);
  const fresh = T.stateToSphereOptions(active({ updatedAt: NOW - 9_000 }), NOW, { warn: (m) => warns.push(m) });
  assert.equal(fresh.heartbeatEnabled, true);
  assert.equal(warns.length, 1, '未陈旧不许 warn');
  assert.equal(T.STALE_MS, 10_000);
});

test('畸形状态（version/active/updatedAt 任一不合法）→ 静息 + 恰一次 warn', () => {
  for (const bad of [
    null,
    undefined,
    { version: 0, active: true, intensity: 1, phase: 'active', updatedAt: NOW },
    { version: 1, active: 'yes', intensity: 1, phase: 'active', updatedAt: NOW },
    { version: 1, active: true, intensity: 1, phase: 'active', updatedAt: 'x' },
  ]) {
    const warns = [];
    const out = T.stateToSphereOptions(bad, NOW, { warn: (m) => warns.push(m) });
    assert.equal(out.heartbeatEnabled, false, `畸形输入应静息：${JSON.stringify(bad)}`);
    const expected = bad === null || bad === undefined ? 0 : 1;   // 首帧 null 不算畸形
    assert.equal(warns.length, expected, `${JSON.stringify(bad)} warn 次数`);
  }
});

test('未知 phase 回落 active/idle，intensity 越界 clamp 到 [0,1]', () => {
  const out = T.stateToSphereOptions(active({ phase: '???', intensity: 99 }), NOW);
  assert.equal(out.bpm, 112);
  const neg = T.stateToSphereOptions(active({ intensity: -5 }), NOW);
  assert.equal(neg.bpm, 64);
});

test('error 相位（预留）：红移 + 关心跳 + 仍在合法参数范围', () => {
  const out = T.stateToSphereOptions(active({ phase: 'error' }), NOW);
  assert.equal(out.heartbeatEnabled, false);
  assert.equal(out.color, '#ff6a84');
  assertAccepted(out, 'error');
});

test('reducedMotion：状态仍可读（大小/亮度有别），但运动量归零', () => {
  const i = T.stateToSphereOptions(idle(), NOW, { reducedMotion: true });
  const a = T.stateToSphereOptions(active(), NOW, { reducedMotion: true });
  assert.equal(a.heartbeatEnabled, false, 'reduced motion 关心跳');
  assert.equal(a.rotationSpeed, 0, 'reduced motion 停环');
  assert.equal(i.rotationSpeed, 0);
  assert.ok(a.coreScale > i.coreScale, '没有运动也要能看出激活');
  assert.ok(a.coreBrightness > i.coreBrightness);
});

test('smoothOptions：alpha=0 保持原值、alpha=1 到达目标、布尔与颜色按 progress 过半切换', () => {
  const current = T.idleOptions(false);
  const target = T.stateToSphereOptions(active(), NOW);
  assert.deepEqual(T.smoothOptions(current, target, 0, 0), current);
  assert.deepEqual(T.smoothOptions(current, target, 1, 1), target);
  const early = T.smoothOptions(current, target, 0.4, 0.4);
  const late = T.smoothOptions(current, target, 0.6, 0.6);
  assert.equal(early.heartbeatEnabled, false, 'progress<0.5 不切心跳');
  assert.equal(late.heartbeatEnabled, true, 'progress>=0.5 切心跳');
  assert.equal(early.color, current.color);
  assert.equal(late.color, target.color);
  assert.ok(late.coreScale > early.coreScale, '插值单调');
});

test('插值按真实排程收敛：RAMP_MS 内补齐到目标（不会永远差一点点）', () => {
  const target = T.stateToSphereOptions(active(), NOW);
  let current = T.idleOptions(false);
  const ticks = [];
  for (let t = 0; t <= T.RAMP_MS + T.RAMP_MS; t += 33) {
    const progress = Math.min(1, t / T.RAMP_MS);
    // 与 client.js 的 step() 同序：progress>=1 直接补到 target，否则指数插值
    current = progress >= 1 ? target : T.smoothOptions(current, target, 0.3, progress);
    ticks.push({ t, progress });
    if (progress >= 1) break;
  }
  assert.deepEqual(current, target, `RAMP_MS 内未补齐（走了 ${ticks.length} 步）`);
  assert.ok(ticks.length >= 4 && ticks.length <= 20, `步数应在合理区间：${ticks.length}`);
  assert.ok(T.RAMP_MS >= 200 && T.RAMP_MS <= 800, 'RAMP_MS 应在几百毫秒量级');
});

test('运行态三环转速仍高于心跳（环1 rev/min ≥ 1.0 × bpm；环2/环3 同速域推进）', () => {
  const defs = { ring1: 0.11, ring2: 0.075, ring3: 0.045 };   // rad/s @ 1×（energy-sphere.js 的 OUTER_RING_DEFINITIONS）
  const toRpm = (radPerSec) => (radPerSec * 60) / (2 * Math.PI);
  for (const intensity of [0, 0.5, 1]) {
    const o = T.stateToSphereOptions(active({ intensity }), NOW);
    const ring1Rpm = toRpm(defs.ring1 * o.rotationSpeed);
    // 三环基准角速度本来就不同（0.11 / 0.075 / 0.045 rad/s，为的是层次感），
    // 因此"明显高于心跳"这条钉在**最快环**上；另两环按几何比例留在同一速域但更低。
    assert.ok(ring1Rpm >= 1.0 * o.bpm,
      `强度 ${intensity}: 环1 ${ring1Rpm.toFixed(1)} rpm 仍应高于心跳 ${o.bpm} bpm`);
    const ring2Rpm = toRpm(defs.ring2 * o.rotationSpeed);
    const ring3Rpm = toRpm(defs.ring3 * o.rotationSpeed);
    assert.ok(ring2Rpm >= 0.7 * o.bpm, `强度 ${intensity}: 环2 ${ring2Rpm.toFixed(1)} rpm 应 ≥0.7×bpm`);
    assert.ok(ring3Rpm >= 0.4 * o.bpm, `强度 ${intensity}: 环3 ${ring3Rpm.toFixed(1)} rpm 应 ≥0.4×bpm`);
    assert.ok(ring1Rpm > ring2Rpm && ring2Rpm > ring3Rpm, '三环仍应保持快慢层次');
  }
  const idleOpts = T.stateToSphereOptions(idle(), NOW);
  assert.ok(toRpm(defs.ring1 * idleOpts.rotationSpeed) < 5, '静息仍要慢（环1 < 5 rpm）');
});
