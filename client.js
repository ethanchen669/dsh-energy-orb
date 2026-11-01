// Client 半边：OrbClient（shell.overlay 挂载 + 轮询 + 状态→球体参数 + 显示偏好 + 拖拽）。
// 球体绘制是 apps/energy-sphere-demo 的 vendored 副本（client/sphere/），经资产路由懒加载；
// 加载/WebGL 失败一律降级成 CSS 球（不空白、不炸页）。
window.__ModuleLoader__.load({
  id: '@dsh-fly/dsh-energy-orb',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PREFS_KEY = 'energy-orb.display';
    const POLL_OK_MS = 2_000;
    const POLL_FAIL_MS = 10_000;
    const STATE_URL = '/api/energy-orb/state';
    const SPHERE_URL = '/energy-orb/assets/sphere/energy-sphere.js';
    // 测试/fixture 缝：允许覆盖球体入口 URL（其余资产由球体模块按相对 URL 自己 import）
    const ASSETS = (globalThis.__ENERGY_ORB_ASSETS__) || { sphere: SPHERE_URL };
    const STALE_MS = 10_000;
    const RAMP_STEP_MS = 33;
    const RAMP_ALPHA = 0.3;
    const RAMP_MS = 420;

    // 降级警示：每类恰一次（设计「错误与失败模式」）
    let warned = false;
    const warnOnce = (msg) => {
      if (!warned) {
        warned = true;
        console.warn(msg);
      }
    };

    // ---------- 纯逻辑（__testables 供 node --test 直接测） ----------
    function loadPrefs(storage) {
      try {
        return normalizePrefsShape(JSON.parse(storage.getItem(PREFS_KEY)));
      } catch {
        return normalizePrefsShape(null);
      }
    }
    function savePrefs(storage, prefs) {
      storage.setItem(PREFS_KEY, JSON.stringify(prefs));
    }
    /** 一次拉取：成功回 2s、失败回 10s（退避）。状态经 onState 上交。 */
    async function pollOnce(fetchImpl, onState) {
      try {
        const res = await fetchImpl(STATE_URL);
        if (!res.ok) throw new Error(`state fetch ${res.status}`);
        onState(await res.json());
        return POLL_OK_MS;
      } catch {
        return POLL_FAIL_MS;
      }
    }
    // 本地 prefs 形状 clamp（与渲染器 normalizePrefs 同契约；client.js 是 classic script 不能静态 import）
    function normalizePrefsShape(raw) {
      const src = raw && typeof raw === 'object' ? raw : {};
      const size = Math.min(256, Math.max(32, Number(src.size) || 96));
      const anchor = src.anchor === 'bottom-left' ? 'bottom-left' : 'bottom-right';
      const off = src.offset && typeof src.offset === 'object' ? src.offset : {};
      const clampOff = (v) => {
        const x = Number(v);
        return Number.isFinite(x) ? Math.min(4096, Math.max(-4096, x)) : 0;
      };
      return {
        visible: src.visible === undefined ? true : !!src.visible,
        size,
        anchor,
        offset: { x: clampOff(off.x), y: clampOff(off.y) },
      };
    }

    /** 状态合法性：只认 version 1 + 布尔 active + 有限 updatedAt；畸形 → null（→ idle）。 */
    function sanitizeState(state) {
      if (!state || typeof state !== 'object') return null;
      if (state.version !== 1) return null;
      if (typeof state.active !== 'boolean') return null;
      if (!Number.isFinite(state.updatedAt)) return null;
      const intensity = Number.isFinite(state.intensity) ? Math.min(1, Math.max(0, state.intensity)) : 0;
      const phase = ['idle', 'active', 'error'].includes(state.phase) ? state.phase : (state.active ? 'active' : 'idle');
      return { active: state.active, intensity, phase, updatedAt: state.updatedAt };
    }

    /**
     * 状态 → 球体参数（设计「状态 → 参数」表）。
     * 静息：核心缩到 0.82×、辉光 0.5，**关掉心跳**（静态就是静态），外环缓转；
     * 激活：核心 1.08×、辉光 1.3，心跳 64→112 BPM 随 intensity 提频，外环全速。
     * 畸形/陈旧（>10s）一律按静息呈现。reducedMotion 只保留大小与亮度差，全部运动量归零。
     */
    function stateToSphereOptions(state, nowMs, options = {}) {
      const { reducedMotion = false, warn = () => {} } = options;
      const clean = sanitizeState(state);
      if (!clean) {
        if (state !== null && state !== undefined) warn('[energy-orb] malformed state; rendering idle');
        return idleOptions(reducedMotion);
      }
      const stale = nowMs - clean.updatedAt > STALE_MS;
      if (stale) {
        if (clean.active) warn('[energy-orb] state stale (>10s); rendering idle');
        return idleOptions(reducedMotion);
      }
      if (clean.phase === 'error') {
        return {
          color: '#ff6a84',
          heartbeatEnabled: false,
          coreScale: 0.95,
          coreBrightness: 0.9,
          energy: 0.9,
          rotationSpeed: reducedMotion ? 0 : 0.8,
          bpm: 72,
        };
      }
      if (!clean.active) return idleOptions(reducedMotion);
      return {
        color: '#42dcff',
        heartbeatEnabled: !reducedMotion,
        coreScale: reducedMotion ? 1.05 : 1.08,
        coreBrightness: reducedMotion ? 1.15 : 1.3,
        energy: 1,
        rotationSpeed: reducedMotion ? 0 : 1,
        bpm: 64 + 48 * clean.intensity,
      };
    }

    function idleOptions(reducedMotion) {
      return {
        color: '#42dcff',
        heartbeatEnabled: false,
        coreScale: 0.82,
        coreBrightness: 0.5,
        energy: 0.55,
        rotationSpeed: reducedMotion ? 0 : 0.55,
        bpm: 56,
      };
    }

    const NUMERIC_KEYS = ['coreScale', 'coreBrightness', 'energy', 'rotationSpeed', 'bpm'];
    const OPTION_KEYS = [...NUMERIC_KEYS, 'color', 'heartbeatEnabled'];

    /**
     * 两帧参数之间做指数插值（状态切换不跳变）。
     * `progress` 是「本次 ramp 已走过的比例」（0..1）：布尔/颜色在过半时切换——
     * 只用 alpha 判的话，固定 alpha（如 0.3）永远够不到 0.5，心跳就永不切换（试过，40 步收敛不了）。
     */
    function smoothOptions(current, target, alpha, progress = 1) {
      const out = {};
      for (const key of NUMERIC_KEYS) {
        const from = Number.isFinite(current[key]) ? current[key] : target[key];
        out[key] = from + (target[key] - from) * alpha;
      }
      const switchNow = progress >= 0.5;
      out.heartbeatEnabled = switchNow ? target.heartbeatEnabled : current.heartbeatEnabled;
      out.color = switchNow ? target.color : current.color;
      return out;
    }

    function toPatch(options) {
      const patch = {};
      for (const key of OPTION_KEYS) patch[key] = options[key];
      return patch;
    }

    // ---------- 组件 ----------
    function OrbComponent() {
      const [prefs, setPrefs] = React.useState(() => loadPrefs(window.localStorage));
      const [fallback, setFallback] = React.useState(false);
      const [lastState, setLastState] = React.useState(null);
      const containerRef = React.useRef(null);
      const sphereRef = React.useRef(null);
      const prefsRef = React.useRef(prefs);
      const lastStateRef = React.useRef(null);
      prefsRef.current = prefs;

      // 初始化球体 + 轮询；卸载时全部释放
      React.useEffect(() => {
        let stopped = false;
        let timer = 0;
        let rampTimer = 0;
        const reduced = window.matchMedia
          ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
          : false;
        let currentOptions = idleOptions(reduced);
        let targetOptions = currentOptions;
        let rampStart = 0;

        /** 把插值后的参数推给球体；到时限就补齐并停（不做无限参数循环）。 */
        const step = () => {
          rampTimer = 0;
          if (stopped || !sphereRef.current) return;
          const progress = Math.min(1, (Date.now() - rampStart) / RAMP_MS);
          currentOptions = progress >= 1
            ? targetOptions
            : smoothOptions(currentOptions, targetOptions, RAMP_ALPHA, progress);
          sphereRef.current.update(toPatch(currentOptions));
          if (progress < 1) rampTimer = window.setTimeout(step, RAMP_STEP_MS);
        };
        const retarget = (state) => {
          targetOptions = stateToSphereOptions(state, Date.now(), { reducedMotion: reduced, warn: warnOnce });
          if (rampTimer) return;   // 已在插值：循环自带读取最新 target
          rampStart = Date.now();
          rampTimer = window.setTimeout(step, 0);
        };

        (async () => {
          try {
            const sphereMod = await import(ASSETS.sphere);
            const createEnergySphere = sphereMod && sphereMod.createEnergySphere;
            if (typeof createEnergySphere !== 'function') {
              throw new Error('sphere asset does not export createEnergySphere');
            }
            const container = containerRef.current;
            if (stopped || !container) return;
            const sphere = createEnergySphere(container, {
              ...currentOptions,
              onError: () => {
                // WebGL 不可用 / 上下文丢失 → 宿主显示 CSS 降级球
                warnOnce('[energy-orb] webgl unavailable; CSS fallback');
                if (!stopped) setFallback(true);
              },
            });
            // renderer.setSize(w, h, false) 不写 style：不拉伸的话 canvas 会以 DPR 放大后的
            // 属性尺寸溢出容器（DPR=2 时正好 2 倍）——这是「画布溢出/球被裁」的经典成因
            const canvas = typeof container.querySelector === 'function' ? container.querySelector('canvas') : null;
            if (canvas && canvas.style) {
              canvas.style.width = '100%';
              canvas.style.height = '100%';
              canvas.style.display = 'block';
            }
            sphereRef.current = sphere;
            if (lastStateRef.current) retarget(lastStateRef.current);
          } catch {
            warnOnce('[energy-orb] sphere/vendor load failed; CSS fallback');
            if (!stopped) setFallback(true);
          }
          const loop = async () => {
            if (stopped) return;
            const ms = await pollOnce(window.fetch.bind(window), (state) => {
              if (stopped) return;
              lastStateRef.current = state;
              setLastState(state);
              retarget(state);
            });
            if (stopped) return;
            timer = window.setTimeout(loop, ms);
          };
          loop();
        })();

        return () => {
          stopped = true;
          window.clearTimeout(timer);
          window.clearTimeout(rampTimer);
          if (sphereRef.current) {
            sphereRef.current.dispose();
            sphereRef.current = null;
          }
        };
      }, []);

      // 记录最近一次状态，供球体 late-init 后立即对齐

      // 拖拽改 offset（存 localStorage）；纯点击充能 = 一次本地脉冲
      const onPointerDown = (e) => {
        const start = { x: e.clientX, y: e.clientY, ox: prefsRef.current.offset.x, oy: prefsRef.current.offset.y };
        let moved = false;
        const move = (ev) => {
          moved = true;
          setPrefs(normalizePrefsShape({
            ...prefsRef.current,
            offset: { x: start.ox + ev.clientX - start.x, y: start.oy + ev.clientY - start.y },
          }));
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          if (moved) savePrefs(window.localStorage, prefsRef.current);
          else if (sphereRef.current && sphereRef.current.pulse) sphereRef.current.pulse(1.2);   // 纯点击才充能，拖拽不算
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      };

      // 拖拽 offset 语义：右拖 x+ → 球向右；下拖 y+ → 球向下。
      // right 锚点「向右」= right 减小；left 锚点「向右」= left 增大；bottom「向下」= bottom 减小。
      // calc 用显式 +/- 连接绝对值（`calc(26px + -40px)` 语法不可靠）。
      const calcShift = (base, delta, decreaseWhenPositive) => {
        const decrease = decreaseWhenPositive ? delta >= 0 : delta < 0;
        return `calc(${base}px ${decrease ? '-' : '+'} ${Math.abs(delta)}px)`;
      };
      const style = {
        position: 'fixed',
        right: prefs.anchor === 'bottom-right' ? calcShift(26, prefs.offset.x, true) : 'auto',
        left: prefs.anchor === 'bottom-left' ? calcShift(26, prefs.offset.x, false) : 'auto',
        bottom: calcShift(22, prefs.offset.y, true),
        width: `${prefs.size * 2}px`,
        height: `${prefs.size * 2}px`,
        zIndex: 40,
        pointerEvents: 'auto',
        touchAction: 'none',
        display: prefs.visible ? 'block' : 'none',
      };

      const active = !!(lastState && lastState.active);
      return h('div', {
        'data-dsh-energy-orb-root': '',
        className: 'energyOrb-root',
        style,
        onPointerDown,
      }, fallback
        ? [
            h('div', {
              key: 'fallback',
              className: 'energyOrb-fallback',
              'data-dsh-energy-orb-fallback': '',
              style: {
                width: '100%',
                height: '100%',
                borderRadius: '50%',
                background: 'radial-gradient(circle at 38% 32%, rgba(150,210,255,.95), rgba(76,141,246,.55) 45%, rgba(24,48,96,.18) 72%, transparent 78%)',
                boxShadow: '0 0 26px rgba(76,141,246,.45)',
                transform: `scale(${active ? 1 : 0.6})`,
                opacity: active ? 1 : 0.55,
                transition: 'transform 300ms ease, opacity 300ms ease',
                animation: 'energyOrbBreath 10s ease-in-out infinite',
              },
            }),
            h('style', { key: 'fallbackStyle' },
              '@keyframes energyOrbBreath{0%,100%{filter:brightness(.85)}50%{filter:brightness(1.12)}}'),
          ]
        : h('div', {
            key: 'stage',
            ref: containerRef,
            'data-dsh-energy-orb-stage': '',
            style: { width: '100%', height: '100%' },
          }));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          { name: 'shell.overlay', id: 'dsh-energy-orb', order: 10 },
          OrbComponent,
        ));
      },
      __testables: {
        pollOnce,
        loadPrefs,
        savePrefs,
        stateToSphereOptions,
        smoothOptions,
        sanitizeState,
        idleOptions,
        STALE_MS,
        OPTION_KEYS,
        RAMP_MS,
      },
    };
  },
});
