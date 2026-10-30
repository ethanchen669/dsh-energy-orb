/**
 * OrbRenderer 的纯逻辑层（无 DOM、无 THREE 引用，导入即安全；node --test 直接测）。
 * 契约见 docs/design.md「接口」节 + 计划 Task 4；绘制层（createOrb）在 Task 6 追加于本文件。
 */

export const STALE_MS = 10_000;

const IDLE = Object.freeze({ scale: 0.6, glow: 0.3, particles: 0.18, ringSpeed: 0.35 });
const ACTIVE = Object.freeze({ scale: 1.0, glow: 0.8, particles: 1.0, ringSpeed: 1.2 });

/** 0.9 → 1.1 快起慢落心搏；攻起 12% 周期、舒张 48% 周期、其余间歇。intensity ∈ [0,1] 提频 60→120 BPM。 */
export function heartbeatScale(tMs, intensity = 0) {
  const i = Math.min(1, Math.max(0, Number(intensity) || 0));
  const period = 60_000 / (60 + 60 * i);
  const t = ((tMs % period) + period) % period;
  const attack = 0.12 * period;   // 60 BPM 时 = 120ms
  const decay = 0.48 * period;    // 60 BPM 时 = 480ms
  if (t < attack) return 0.9 + 0.2 * (t / attack);
  if (t < attack + decay) {
    const k = (t - attack) / decay;
    return 0.9 + 0.2 * Math.exp(-4 * k);
  }
  return 0.9;
}

function idleTargets() {
  return { ...IDLE, phase: 'idle' };
}

/**
 * 状态 → 渲染目标参数。陈旧（updatedAt 距今 > 10s）或畸形 → idle 目标；
 * version 不认识 / 结构坏 → 恰一次 warn（由调用方注入 warn 桩计数）。
 */
export function stateToTargets(state, nowMs, warn = console.warn) {
  if (state === null || typeof state !== 'object') {
    warn('[energy-orb] malformed state: not an object');
    return idleTargets();
  }
  if (state.version !== 1) {
    warn(`[energy-orb] unknown state version: ${String(state.version)}`);
    return idleTargets();
  }
  const active = !!state.active;
  const intensity = Math.min(1, Math.max(0, Number(state.intensity) || 0));
  const updatedAt = Number(state.updatedAt);
  const stale = !Number.isFinite(updatedAt) || nowMs - updatedAt > STALE_MS;
  if (stale) return idleTargets();
  const phase = state.phase === 'error' ? 'error' : active ? 'active' : 'idle';
  return active
    ? { ...ACTIVE, phase }
    : { ...IDLE, phase: 'idle' };
}

/** Fibonacci 均匀 42 点（单位球面）+ 近邻边（i<j、无自环、无重复）。 */
export function buildSphere() {
  const n = 42;
  const points = [];
  const gr = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = gr * i;
    points.push([Math.cos(th) * r, y, Math.sin(th) * r]);
  }
  const edges = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = points[i], b = points[j];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (d < 0.55) edges.push([i, j]);
    }
  }
  return { points, edges };
}

/** 球核 18 点（半径 0.08–0.46，单位球内），确定性哈希布点。 */
export function buildCore() {
  const hash = (i) => {
    const x = Math.sin(i * 127.1) * 43758.5453;
    return x - Math.floor(x);
  };
  const points = [];
  for (let i = 0; i < 18; i++) {
    const th = hash(i * 9.2) * Math.PI * 2;
    const ph = Math.acos(2 * hash(i * 3.7) - 1);
    const rr = 0.08 + hash(i * 5.9) * 0.38;
    points.push([Math.sin(ph) * Math.cos(th) * rr, Math.sin(ph) * Math.sin(th) * rr, Math.cos(ph) * rr]);
  }
  return points;
}

/** 边缘点带 72 粒：angle 均布 + 抖动，radius ∈ [0.77, 1.05]（外密内疏：u² 反向），alpha ∈ (0,1)。 */
export function buildRim() {
  const hash = (i) => {
    const x = Math.sin(i * 127.1) * 43758.5453;
    return x - Math.floor(x);
  };
  const dots = [];
  for (let i = 0; i < 72; i++) {
    const angle = (i / 72) * Math.PI * 2 + hash(i * 2.7) * 0.09;
    const u = hash(i * 4.1);
    const radius = 1.05 - u * u * 0.28;
    const alpha = 0.22 + 0.5 * hash(i * 6.3);
    dots.push({ angle, radius, alpha });
  }
  return dots;
}

/** 显示偏好 clamp：缺失/越界回落默认；size 32..256；anchor 枚举外回落 bottom-right。 */
export function normalizePrefs(raw) {
  const defaults = { visible: true, size: 96, anchor: 'bottom-right', offset: { x: 0, y: 0 } };
  const src = raw && typeof raw === 'object' ? raw : {};
  const size = Math.min(256, Math.max(32, Number(src.size) || defaults.size));
  const anchor = src.anchor === 'bottom-left' ? 'bottom-left' : 'bottom-right';
  const clampOff = (v) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.min(4096, Math.max(-4096, x)) : 0;
  };
  const off = src.offset && typeof src.offset === 'object' ? src.offset : {};
  return {
    visible: src.visible === undefined ? defaults.visible : !!src.visible,
    size,
    anchor,
    offset: { x: clampOff(off.x), y: clampOff(off.y) },
  };
}

// ================= 绘制层（Three.js 五层 + 3D 化，对照 docs/mockups/orb-mockup.html） =================
// 层序：核心辉光 → 球核（聚）→ 球面疏网（少）→ 边缘点带（密）→ 倾斜轨道环 → HUD 同心环 → 粒子。
// 3D 化四要素：透视相机（近大远小）+ 连续深度渐变 + 定向光（左上前）+ 轨道环前弧亮/后弧暗。

const COL = {
  glow: [0.24, 0.67, 1.0],
  web: [0.36, 0.9, 1.0],
  node: [0.78, 0.98, 1.0],
  core: [0.85, 0.99, 1.0],
  rim: [0.7, 0.95, 1.0],
  orbit: [0.55, 0.92, 1.0],
  hud: [0.42, 0.88, 1.0],
  tick: [0.78, 0.95, 1.0],
  particle: [0.65, 0.93, 1.0],
  warm: [1.0, 0.75, 0.47],
};
const LIGHT = { x: -0.55, y: -0.75, z: 0.42 };

function hash(i) {
  const x = Math.sin(i * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

/** 每帧深度/光照着色：view z 连续渐变 + 定向光（mockup 的 dep/shade 等价）。 */
function shadeVertex(wx, wy, wz, out, outIdx, base, radius) {
  const dep = Math.pow(Math.max(0, (wz / radius + 1) / 2), 1.7);
  const len = Math.hypot(wx, wy, wz) || 1;
  const dot = (wx / len) * LIGHT.x + (wy / len) * LIGHT.y + (wz / len) * LIGHT.z;
  const shade = 0.6 + 0.4 * Math.max(0, dot);
  const k = (0.15 + 1.05 * dep) * shade;   // 可略超 1：前侧热点像 mockup 一样冲白
  out[outIdx] = base[0] * k;
  out[outIdx + 1] = base[1] * k;
  out[outIdx + 2] = base[2] * k;
}

/** WebGL 上下文丢失监视：首次丢失 → 尝试恢复（限时）；限时未恢复或二次丢失 → onFinal（降级）。 */
export function watchContext(canvas, onFinal, { restoreTimeoutMs = 2000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = 0;
  let lostOnce = false;
  const cleanup = () => {
    canvas.removeEventListener('webglcontextlost', onLost);
    canvas.removeEventListener('webglcontextrestored', onRestored);
    clearTimer(timer);
  };
  function onLost(e) {
    e?.preventDefault?.();
    if (lostOnce) {
      cleanup();
      onFinal();
      return;
    }
    lostOnce = true;
    timer = setTimer(() => {
      cleanup();
      onFinal();
    }, restoreTimeoutMs);
  }
  function onRestored() {
    clearTimer(timer);
    lostOnce = false;
  }
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  return { dispose: cleanup };
}

export function createOrb(canvas, { reducedMotion = false, THREE, preserveDrawingBuffer = false, onFallback = null } = {}) {
  if (!THREE) throw new Error('[energy-orb] THREE is required');
  const renderer = new THREE.WebGLRenderer({
    canvas, alpha: true, antialias: true, preserveDrawingBuffer,
  });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.z = 3.4;

  const disposables = [];
  const track = (obj) => { disposables.push(obj); return obj; };

  // ---- 0) 核心辉光（Sprite + CanvasTexture 径向渐变）----
  const glowCanvas = document.createElement('canvas');
  glowCanvas.width = glowCanvas.height = 128;
  const g2 = glowCanvas.getContext('2d');
  const grad = g2.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, 'rgba(60,170,255,0.85)');
  grad.addColorStop(0.45, 'rgba(40,120,255,0.22)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g2.fillStyle = grad;
  g2.fillRect(0, 0, 128, 128);
  const glowTex = track(new THREE.CanvasTexture(glowCanvas));
  // 圆形柔光点纹理（PointsMaterial 默认是方块，mockup 是圆点）
  const dotCanvas = document.createElement('canvas');
  dotCanvas.width = dotCanvas.height = 64;
  const d2 = dotCanvas.getContext('2d');
  const dgrad = d2.createRadialGradient(32, 32, 0, 32, 32, 32);
  dgrad.addColorStop(0, 'rgba(255,255,255,1)');
  dgrad.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  dgrad.addColorStop(1, 'rgba(255,255,255,0)');
  d2.fillStyle = dgrad;
  d2.fillRect(0, 0, 64, 64);
  const dotTex = track(new THREE.CanvasTexture(dotCanvas));
  const glowMat = track(new THREE.SpriteMaterial({
    map: glowTex, transparent: true, opacity: 0.5,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  const glowSprite = new THREE.Sprite(glowMat);
  glowSprite.scale.setScalar(2.8);
  scene.add(glowSprite);

  // ---- 旋转的球体组（球核 + 球面疏网 + 边缘点带）----
  const orbGroup = new THREE.Group();
  orbGroup.rotation.x = 0.42;
  scene.add(orbGroup);

  function makeCloud(points3, base, size, radiusForShade, kOverride = null) {
    const n = points3.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    points3.forEach((p, i) => {
      pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2];
      if (kOverride !== null) {
        col[i * 3] = base[0] * kOverride;
        col[i * 3 + 1] = base[1] * kOverride;
        col[i * 3 + 2] = base[2] * kOverride;
      } else {
        shadeVertex(p[0], p[1], p[2], col, i * 3, base, radiusForShade);
      }
    });
    const geo = track(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = track(new THREE.PointsMaterial({
      size, map: dotTex, vertexColors: true, transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    }));
    return new THREE.Points(geo, mat);
  }

  function makeWeb(points3, edges, base, radiusForShade, widthBoost) {
    const n = edges.length * 2;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    edges.forEach(([i, j], e) => {
      [i, j].forEach((idx, k) => {
        const p = points3[idx];
        const o = (e * 2 + k) * 3;
        pos[o] = p[0]; pos[o + 1] = p[1]; pos[o + 2] = p[2];
        shadeVertex(p[0], p[1], p[2], col, o, base, radiusForShade);
      });
    });
    const geo = track(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = track(new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: widthBoost,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    return new THREE.LineSegments(geo, mat);
  }

  // 1) 球面疏网（42 点 + 近邻边）
  const sphere = buildSphere();
  const webLines = makeWeb(sphere.points, sphere.edges, COL.web, 1.0, 0.9);
  const webNodes = makeCloud(sphere.points, COL.node, 0.075, 1.0);
  orbGroup.add(webLines, webNodes);

  // 2) 球核（18 点聚 + 最近邻短边）
  const core = buildCore();
  const coreEdges = [];
  for (let i = 0; i < core.length; i++) {
    for (let j = i + 1; j < core.length; j++) {
      const d = Math.hypot(core[i][0] - core[j][0], core[i][1] - core[j][1], core[i][2] - core[j][2]);
      if (d < 0.3) coreEdges.push([i, j]);
    }
  }
  const coreLines = makeWeb(core, coreEdges, COL.core, 1.0, 0.75);
  const coreNodes = makeCloud(core, COL.core, 0.1, 1.0);
  orbGroup.add(coreLines, coreNodes);

  // 3) 边缘点带（72 粒，贴剪影的相机朝向环，慢速漂移）
  const rim = buildRim();
  const rimPts = rim.map((d) => [Math.cos(d.angle) * d.radius, Math.sin(d.angle) * d.radius, 0]);
  const rimCloud = makeCloud(rimPts, COL.rim, 0.08, 1.05, 0.85);   // 平面点带不做深度衰减
  scene.add(rimCloud);

  // ---- 4) 倾斜轨道环（2 条，前弧亮/后弧暗 = 静态顶点色 + 慢速进动）----
  function makeOrbit(radius, tiltRad, alpha) {
    const group = new THREE.Group();
    group.rotation.x = tiltRad;
    const pts = [];
    const cols = [];
    const N = 96;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const x = Math.cos(a) * radius, y = Math.sin(a) * radius, z = 0;
      pts.push(x, y, z);
      const wz = Math.sin(a) * radius * Math.sin(tiltRad);
      const dep = Math.pow(Math.max(0, (wz / radius + 1) / 2), 1.8);
      const k = 0.1 + 0.9 * dep;
      cols.push(COL.orbit[0] * k, COL.orbit[1] * k, COL.orbit[2] * k);
    }
    const geo = track(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    const mat = track(new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: alpha,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    group.add(new THREE.LineLoop(geo, mat));
    return group;
  }
  const orbitA = makeOrbit(1.34, 1.12, 0.9);
  const orbitB = makeOrbit(1.12, 0.5, 0.7);
  scene.add(orbitA, orbitB);

  // ---- 5) HUD 同心环（3 层：实线圈 + 虚线圈 + 刻度齿 + 切向数据块），相机朝向 ----
  function makeHud(radius, tickCount, alpha) {
    const group = new THREE.Group();
    const circlePts = [];
    for (let i = 0; i < 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      circlePts.push(Math.cos(a) * radius, Math.sin(a) * radius, 0);
    }
    const ringGeo = track(new THREE.BufferGeometry());
    ringGeo.setAttribute('position', new THREE.Float32BufferAttribute(circlePts, 3));
    const ringMat = track(new THREE.LineBasicMaterial({
      color: new THREE.Color(...COL.hud), transparent: true, opacity: 0.6 * alpha,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    group.add(new THREE.LineLoop(ringGeo, ringMat));

    const tickPts = [];
    for (let k = 0; k < tickCount; k++) {
      const th = (k / tickCount) * Math.PI * 2;
      const long = k % 4 === 0;
      const L = long ? 0.075 : 0.038;
      const c = Math.cos(th), s = Math.sin(th);
      tickPts.push(c * radius, s * radius, 0, c * (radius + L), s * (radius + L), 0);
    }
    const tickGeo = track(new THREE.BufferGeometry());
    tickGeo.setAttribute('position', new THREE.Float32BufferAttribute(tickPts, 3));
    const tickMat = track(new THREE.LineBasicMaterial({
      color: new THREE.Color(...COL.tick), transparent: true, opacity: 0.7 * alpha,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    group.add(new THREE.LineSegments(tickGeo, tickMat));

    // 切向数据块（10 个小矩形线框）
    const blockPts = [];
    for (let k = 0; k < 10; k++) {
      const th = hash(k * 7 + radius) * Math.PI * 2;
      const w = 0.06 + hash(k * 13) * 0.14, h = 0.022;
      const c = Math.cos(th), s = Math.sin(th);
      const ux = c * radius, uy = s * radius;            // 径向位置
      const tx = -s, ty = c;                             // 切向
      const corners = [
        [ux + tx * -w / 2 + c * -h / 2, uy + ty * -w / 2 + s * -h / 2],
        [ux + tx * w / 2 + c * -h / 2, uy + ty * w / 2 + s * -h / 2],
        [ux + tx * w / 2 + c * h / 2, uy + ty * w / 2 + s * h / 2],
        [ux + tx * -w / 2 + c * h / 2, uy + ty * -w / 2 + s * h / 2],
      ];
      for (let e = 0; e < 4; e++) {
        const p0 = corners[e], p1 = corners[(e + 1) % 4];
        blockPts.push(p0[0], p0[1], 0, p1[0], p1[1], 0);
      }
    }
    const blockGeo = track(new THREE.BufferGeometry());
    blockGeo.setAttribute('position', new THREE.Float32BufferAttribute(blockPts, 3));
    const blockMat = track(new THREE.LineBasicMaterial({
      color: new THREE.Color(...COL.hud), transparent: true, opacity: 0.5 * alpha,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    group.add(new THREE.LineSegments(blockGeo, blockMat));
    return group;
  }
  const hudA = makeHud(1.22, 28, 1.0);
  const hudB = makeHud(1.46, 18, 0.85);
  const hudC = makeHud(1.7, 44, 0.6);
  scene.add(hudA, hudB, hudC);

  // ---- 6) 粒子（26 粒外飘，1/6 暖色）----
  const particles = [];
  for (let i = 0; i < 26; i++) {
    const th = hash(i * 3.1) * Math.PI * 2;
    const rr = 1.12 + hash(i * 5.3) * 1.15;
    particles.push([Math.cos(th) * rr, Math.sin(th) * rr * 0.92, (hash(i * 7.7) - 0.5) * 0.4]);
  }
  const partPos = new Float32Array(particles.length * 3);
  const partCol = new Float32Array(particles.length * 3);
  particles.forEach((p, i) => {
    partPos[i * 3] = p[0]; partPos[i * 3 + 1] = p[1]; partPos[i * 3 + 2] = p[2];
    const c = i % 6 === 0 ? COL.warm : COL.particle;
    partCol[i * 3] = c[0]; partCol[i * 3 + 1] = c[1]; partCol[i * 3 + 2] = c[2];
  });
  const partGeo = track(new THREE.BufferGeometry());
  partGeo.setAttribute('position', new THREE.BufferAttribute(partPos, 3));
  partGeo.setAttribute('color', new THREE.BufferAttribute(partCol, 3));
  const partMat = track(new THREE.PointsMaterial({
    size: 0.07, map: dotTex, vertexColors: true, transparent: true, opacity: 0.8,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  }));
  const partCloud = new THREE.Points(partGeo, partMat);
  scene.add(partCloud);

  // ---- 参数状态：目标 → 指数平滑（τ≈300ms）；心搏叠加 ----
  let targets = stateToTargets({ version: 1, active: false, intensity: 0, phase: 'idle', updatedAt: Date.now() }, Date.now());
  let cur = { ...targets };
  let startMs = Date.now();
  let raf = 0;
  let disposed = false;
  let pulseBoost = 0;

  function step(dt, nowMs) {
    const tau = 0.3;
    const k = 1 - Math.exp(-dt / tau);
    for (const key of ['scale', 'glow', 'particles', 'ringSpeed']) {
      cur[key] += (targets[key] - cur[key]) * k;
    }
    cur.phase = targets.phase;
    pulseBoost = Math.max(0, pulseBoost - dt * 1.6);

    const beat = reducedMotion
      ? 1
      : (cur.phase === 'active' ? heartbeatScale(nowMs, 0) : 1);
    const breath = reducedMotion ? 1 + 0.02 * Math.sin(nowMs / 5000) : 1;
    const s = cur.scale * beat * breath * (1 + 0.18 * pulseBoost);
    orbGroup.scale.setScalar(s);
    rimCloud.scale.setScalar(s);
    orbitA.scale.setScalar(s);
    orbitB.scale.setScalar(s);
    hudA.scale.setScalar(s);
    hudB.scale.setScalar(s);
    hudC.scale.setScalar(s);
    glowSprite.scale.setScalar(2.8 * s);
    glowMat.opacity = 0.32 * cur.glow * (0.85 + 0.3 * (beat - 0.9) * 5 + pulseBoost);

    const spin = cur.ringSpeed * 0.35;
    orbGroup.rotation.y += dt * spin;
    rimCloud.rotation.z += dt * 0.05 * cur.ringSpeed;
    orbitA.rotation.y += dt * 0.16 * cur.ringSpeed;
    orbitB.rotation.y -= dt * 0.11 * cur.ringSpeed;
    hudA.rotation.z += dt * 0.2 * cur.ringSpeed;
    hudB.rotation.z -= dt * 0.13 * cur.ringSpeed;
    hudC.rotation.z += dt * 0.07 * cur.ringSpeed;
    partCloud.rotation.z += dt * 0.05 * cur.ringSpeed;
    partMat.opacity = 0.8 * cur.particles;
    webNodes.material.opacity = 0.9 + 0.1 * cur.glow;
    webLines.material.opacity = 1.0;
    coreNodes.material.opacity = 0.9 + 0.1 * cur.glow;
    rimCloud.material.opacity = 0.6 + 0.4 * cur.glow;

    renderer.render(scene, camera);
  }

  let lastMs = startMs;
  function loop() {
    if (disposed) return;
    const nowMs = Date.now();
    const dt = Math.min(0.1, (nowMs - lastMs) / 1000);
    lastMs = nowMs;
    step(dt, nowMs - startMs + 2000);
    raf = requestAnimationFrame(loop);
  }

  function resize() {
    const w = canvas.clientWidth || 240, h = canvas.clientHeight || 240;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    disposables.push({ dispose: () => ro.disconnect() });
  }
  if (typeof canvas.addEventListener === 'function') {
    disposables.push(watchContext(canvas, () => onFallback?.()));
  }

  return {
    setState(state) {
      targets = stateToTargets(state, Date.now());
    },
    setConfig() { /* 大小/显隐由容器 CSS 负责；渲染器跟随画布尺寸 */ },
    pulse() { pulseBoost = 1; },
    /** 测试缝：固定时间确定性渲染一帧（verify-visual 用；角度按 time×speed 参数化，同 mockup） */
    __renderAt(tMs) {
      cur = { ...targets };
      const spin = cur.ringSpeed * 0.35;
      orbGroup.rotation.y = tMs * 0.001 * spin;
      rimCloud.rotation.z = tMs * 0.001 * 0.05 * cur.ringSpeed;
      orbitA.rotation.y = tMs * 0.001 * 0.16 * cur.ringSpeed;
      orbitB.rotation.y = -tMs * 0.001 * 0.11 * cur.ringSpeed;
      hudA.rotation.z = tMs * 0.001 * 0.2 * cur.ringSpeed;
      hudB.rotation.z = -tMs * 0.001 * 0.13 * cur.ringSpeed;
      hudC.rotation.z = tMs * 0.001 * 0.07 * cur.ringSpeed;
      step(0, tMs);
    },
    start() { if (!raf && !disposed) raf = requestAnimationFrame(loop); },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      for (const d of disposables) d.dispose?.();
      renderer.dispose();
    },
  };
}
