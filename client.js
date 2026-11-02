// Client 半边：OrbClient（shell.overlay 挂载 + 轮询 + 状态→球体参数 + 显示偏好 + 拖拽）。
// 球体绘制是 apps/energy-sphere-demo 的 vendored 副本（client/sphere/），经资产路由懒加载；
// 加载/WebGL 失败一律降级成 CSS 球（不空白、不炸页）。
window.__ModuleLoader__.load({
  id: '@dsh-fly/dsh-energy-orb',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 焦点会话服务（api-session-controller）；null = 宿主没有这个服务，退回全局快照。 */
    let sessionSource = null;
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
    // 环速的 ramp 比其余参数**更短更陡**：静息↔运行切换时，转速要在 ~170ms 内到位，
    // 先给你一记"起转"的手感，核大小/亮度仍按 420ms 慢慢过渡。
    const ROT_RAMP_MS = 170;
    const ROT_RAMP_ALPHA = 0.45;
    const RAMP_MS = 420;
    /** 折叠后小把手的边长（px）：要小到"不占地方"，又要大到点得中（40 是触控下限附近）。 */
    const HANDLE_SIZE = 40;
    /** 折叠动画时长：根节点尺寸、舞台缩放淡出、把手缩放淡入**共用**，两个方向才是同一组过渡的逆过程。 */
    const COLLAPSE_MS = 220;
    /** 折叠把手/隐藏按钮的样式（一次注入，避免每帧拼样式字符串）。 */
    const CHROME_CSS = [
      '.energyOrb-hide{opacity:0;transition:opacity 160ms ease}',
      '.energyOrb-root:hover .energyOrb-hide,.energyOrb-hide:focus-visible{opacity:1}',
      '.energyOrb-handle{font:700 18px/1 ui-monospace,monospace;color:#c8eeff;letter-spacing:0;',
      'text-shadow:0 0 10px rgba(66,220,255,.85);',
      'background:rgba(8,14,20,.62);border:1px solid rgba(66,220,255,.38);border-radius:12px;',
      'box-shadow:0 0 12px rgba(66,220,255,.28),inset 0 0 10px rgba(66,220,255,.12);',
      'cursor:pointer;display:flex;align-items:center;justify-content:center;width:100%;height:100%;',
      'padding:0;appearance:none;backdrop-filter:blur(6px);transition:transform 160ms ease,box-shadow 160ms ease}',
      '.energyOrb-handle:hover{transform:translateY(-1px);box-shadow:0 0 18px rgba(66,220,255,.45),inset 0 0 12px rgba(66,220,255,.18)}',
      '.energyOrb-handle:focus-visible{outline:2px solid rgba(66,220,255,.8);outline-offset:2px}',
      '@keyframes energyOrbHandlePulse{0%,100%{opacity:.55}50%{opacity:1}}',
      // 悬浮在 × 上时的提示文字（"隐藏 / hide"）：纯 CSS 显隐，不引入状态机
      '.energyOrb-hideLabel{position:absolute;right:27px;top:50%;transform:translateY(-50%) translateX(4px);',
      'white-space:nowrap;padding:3px 8px;border-radius:7px;font:600 11.5px/1.35 -apple-system,"PingFang SC",sans-serif;',
      'letter-spacing:.02em;color:#d8f1ff;background:rgba(8,14,20,.86);border:1px solid rgba(66,220,255,.35);',
      'box-shadow:0 2px 10px rgba(0,0,0,.35);opacity:0;pointer-events:none;',
      'transition:opacity 140ms ease,transform 140ms ease}',
      '.energyOrb-hide:hover .energyOrb-hideLabel,.energyOrb-hide:focus-visible .energyOrb-hideLabel{opacity:1;',
      'transform:translateY(-50%) translateX(0)}',
    ].join('\n');

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
      storage.setItem(PREFS_KEY, JSON.stringify({ ...prefs, v: PREFS_VERSION }));
    }
    /** 一次拉取：成功回 2s、失败回 10s（退避）。状态经 onState 上交。 */
    async function pollOnce(fetchImpl, onState, url = STATE_URL) {
      try {
        const res = await fetchImpl(url);
        if (!res.ok) throw new Error(`state fetch ${res.status}`);
        onState(await res.json());
        return POLL_OK_MS;
      } catch {
        return POLL_FAIL_MS;
      }
    }
    // 本地 prefs 形状 clamp（与渲染器 normalizePrefs 同契约；client.js 是 classic script 不能静态 import）
    /** 视图等比放大 1.25× 的迁移版本：存过的旧偏好（无 v 字段，size 语义是 ×1.25 之前）按 1.25 放大一次。 */
    const PREFS_VERSION = 2;
    const SIZE_SCALE = 1.25;
    const DEFAULT_SIZE = Math.round(96 * SIZE_SCALE);   // 120 → 画布 240×240

    function normalizePrefsShape(raw) {
      const src = raw && typeof raw === 'object' ? raw : {};
      // 旧存档迁移：没有 v 或 v < 2 的，把 size 乘 1.25（默认值同样是 96×1.25=120）
      // 注意 NaN：旧存档没有 v 字段，`Number(undefined) < 2` 是 **false**（NaN 比较恒假），
      // 写成 `<` 会让迁移静默失效 —— 用 `!>=` 把"缺字段/垃圾值"都当成旧存档。
      const legacy = !(Number(src.v) >= PREFS_VERSION);
      const rawSize = Number(src.size);
      const migrated = legacy && Number.isFinite(rawSize) ? Math.round(rawSize * SIZE_SCALE) : rawSize;
      const size = Math.min(256, Math.max(32, migrated || DEFAULT_SIZE));
      const anchor = src.anchor === 'bottom-left' ? 'bottom-left' : 'bottom-right';
      const off = src.offset && typeof src.offset === 'object' ? src.offset : {};
      const clampOff = (v) => {
        const x = Number(v);
        return Number.isFinite(x) ? Math.min(4096, Math.max(-4096, x)) : 0;
      };
      return {
        v: PREFS_VERSION,
        visible: src.visible === undefined ? true : !!src.visible,
        // 折叠 = 收成一个小把手（隐藏/展开功能）；默认展开。缺字段的老存档一律按展开处理
        collapsed: src.collapsed === true,
        size,
        anchor,
        offset: { x: clampOff(off.x), y: clampOff(off.y) },
      };
    }

    /**
     * 从 `sessions` 服务（@deepseek-ai/dsh-api-session-controller 提供的客户端服务）的快照里，
     * 挑出**主视图正在显示的那一个会话**：`retainedBy.mainView > 0` 就是"当前打开的会话"。
     * 服务缺失（老宿主 / fixture）→ null，调用方退回 HTTP 全局快照。
     */
    function pickFocusedSession(sessions) {
      if (!sessions || !sessions.list || typeof sessions.list.getSnapshot !== 'function') return null;
      let snapshot;
      try {
        snapshot = sessions.list.getSnapshot();
      } catch {
        return null;
      }
      const rows = snapshot && snapshot.byId ? Object.values(snapshot.byId) : [];
      const shown = rows.find((row) => row && (row.retainedBy && row.retainedBy.mainView ? row.retainedBy.mainView : 0) > 0);
      if (!shown || typeof shown.id !== 'string') return null;
      return { id: shown.id, running: shown.running === true };
    }

    /**
     * 把「焦点会话的 running」与 HTTP 快照合成球体状态。
     * 焦点会话优先：切换左侧栏会话时，球跟着**那一个会话**的静息/运行走，而不是"全局有没有在跑"。
     */
    function resolveOrbState(httpState, focused) {
      if (!focused) return httpState;
      const active = focused.running === true;
      return {
        ...httpState,
        active,
        intensity: active ? 1 : 0,
        phase: active ? 'active' : 'idle',
      };
    }

    /** 状态路由 URL：带上焦点会话 id，宿主侧据此过滤（拿不到 id 就用全局口径）。 */
    function stateUrl(sessionId) {
      return sessionId ? `${STATE_URL}?session=${encodeURIComponent(sessionId)}` : STATE_URL;
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
        // 亮度按用户口径取「上一版（1.3 / 1）与本轮暗版（0.65 / 0.8）」的中间值：
        // coreBrightness 0.975、energy 0.9 ⇒ 实测 core 圆内平均亮度约为原版的 75%（见 probe 输出）。
        coreBrightness: reducedMotion ? 0.87 : 0.975,
        energy: 0.9,
        // 环速随活动强度提频（1.8~3.0×，静息 0.55×）：转速是逐帧积分的
        // （见 energy-sphere.js 的 updateRingPose），ramp 只做平滑加减速、不回卷历史角。
        // 环速跟着心跳走：乘子 = 1.05 × bpm ⇒ 环1 的 rev/min ≈ 1.1 × bpm
        // （仍高于心跳，但比 1.2 那版慢约 12%，给"看清细节"让位）。
        rotationSpeed: reducedMotion ? 0 : 1.05 * (64 + 48 * clean.intensity),
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
        // 静息 = 旧静息 0.55× 的 1.5 倍（用户口径）
        rotationSpeed: reducedMotion ? 0 : 0.825,
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
    function smoothOptions(current, target, alpha, progress = 1, rotation = null) {
      const out = {};
      for (const key of NUMERIC_KEYS) {
        const from = Number.isFinite(current[key]) ? current[key] : target[key];
        // 转速走自己的（更陡的）插值参数，其余参数用通用那组
        const a = key === 'rotationSpeed' && rotation ? rotation.alpha : alpha;
        out[key] = from + (target[key] - from) * a;
      }
      // 转速的 ramp 一到期就**精确落位**（指数插值永远差最后一点，手感上会"起转一半"）
      if (rotation && rotation.progress >= 1) out.rotationSpeed = target.rotationSpeed;
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
      // 折叠/展开要**立刻**生效：显式 React 一定会重渲染，但 fixture/极简渲染器不会，
      // 所以两处都做 —— 这里持有 DOM 引用，toggle 时直接改样式与属性（幂等，React 重渲染结果相同）。
      const rootRef = React.useRef(null);
      const stageRef = React.useRef(null);
      const handleRef = React.useRef(null);
      const hideRef = React.useRef(null);
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
          const now = Date.now();
          const progress = Math.min(1, (now - rampStart) / RAMP_MS);
          const rotProgress = Math.min(1, (now - rampStart) / ROT_RAMP_MS);
          currentOptions = progress >= 1
            ? targetOptions
            : smoothOptions(currentOptions, targetOptions, RAMP_ALPHA, progress, {
              alpha: ROT_RAMP_ALPHA,
              progress: rotProgress,
            });
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
            if (prefsRef.current.collapsed === true) sphere.update({ paused: true });   // 上次就折叠着：别再空转
            if (lastStateRef.current) retarget(lastStateRef.current);
          } catch {
            warnOnce('[energy-orb] sphere/vendor load failed; CSS fallback');
            if (!stopped) setFallback(true);
          }
          let httpState = null;
          const applyState = () => {
            if (stopped) return;
            const focused = pickFocusedSession(sessionSource);
            const resolved = resolveOrbState(httpState, focused);
            lastStateRef.current = resolved;
            setLastState(resolved);
            retarget(resolved);
          };
          // 切换左侧栏会话 / 该会话开跑或停跑 → 立刻重算（不用等下一轮 2s 轮询）
          let stopSessions = null;
          if (sessionSource && sessionSource.list && typeof sessionSource.list.subscribe === 'function') {
            stopSessions = sessionSource.list.subscribe(() => applyState());
          }
          const loop = async () => {
            if (stopped) return;
            const focusedId = (pickFocusedSession(sessionSource) || {}).id;
            const ms = await pollOnce(window.fetch.bind(window), (state) => {
              httpState = state;
              applyState();
            }, stateUrl(focusedId));
            if (stopped) return;
            timer = window.setTimeout(loop, ms);
          };
          loop();
          if (lastStateRef.current) applyState();
        })();

        return () => {
          stopped = true;
          if (typeof stopSessions === 'function') stopSessions();
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
      const collapsed = prefs.collapsed === true;
      /**
       * 折叠/展开的定位框（唯一真源，render 与命令式切换共用）。
       * 关键：收起时**上边与右边不动**（× 就在盒子的上右角）⇒ 盒子朝 × 那个角缩进去，
       * 视觉上的消失点 = × 的位置；展开就是同一组边的逆过程。
       */
      const frameStyle = (isCollapsed, prefsNow) => {
        const full = prefsNow.size * 2;
        const px = isCollapsed ? HANDLE_SIZE : full;
        const shrink = full - HANDLE_SIZE;          // 收起时盒子变小的量（保持上边不动 ⇒ bottom 增加）
        if (prefsNow.anchor === 'bottom-left') {
          // 左锚点：保持右边缘不动 ⇒ left 增加 shrink
          return {
            right: 'auto',
            left: calcShift(26 + (isCollapsed ? shrink : 0), prefsNow.offset.x, false),
            bottom: calcShift(22 + (isCollapsed ? shrink : 0), prefsNow.offset.y, true),
            width: `${px}px`,
            height: `${px}px`,
          };
        }
        // 右锚点：右边缘不动 ⇒ 只把 bottom 增加 shrink
        return {
          right: calcShift(26, prefsNow.offset.x, true),
          left: 'auto',
          bottom: calcShift(22 + (isCollapsed ? shrink : 0), prefsNow.offset.y, true),
          width: `${px}px`,
          height: `${px}px`,
        };
      };
      const frame = frameStyle(collapsed, prefs);
      const style = {
        position: 'fixed',
        ...frame,
        zIndex: 40,
        pointerEvents: 'auto',
        touchAction: 'none',
        display: prefs.visible ? 'block' : 'none',
        // 收起时越界的画面裁掉，配合舞台的 top-right 缩放原点，视觉上"缩进 × 那个角"
        overflow: 'hidden',
        transformOrigin: 'top right',
        transition: `width ${COLLAPSE_MS}ms ease, height ${COLLAPSE_MS}ms ease, bottom ${COLLAPSE_MS}ms ease, left ${COLLAPSE_MS}ms ease`,
      };

      const active = !!(lastState && lastState.active);
      /** 改折叠状态并落盘；展开/隐藏都走这一条，避免两处状态不同步。 */
      /** 把折叠状态**立即**落到 DOM 上（与 render 里的初始值同形；幂等）。 */
      const applyCollapsedDom = (next) => {
        const collapsedNow = next === true;
        const root = rootRef.current;
        if (root && root.style) {
          root.setAttribute('data-dsh-energy-orb-collapsed', collapsedNow ? 'true' : 'false');
          const next = frameStyle(collapsedNow, prefsRef.current);
          root.style.width = next.width;
          root.style.height = next.height;
          root.style.right = next.right;
          root.style.left = next.left;
          root.style.bottom = next.bottom;
        }
        const stage = stageRef.current;
        if (stage && stage.style) {
          stage.style.opacity = collapsedNow ? '0' : '1';
          stage.style.transform = `scale(${collapsedNow ? 0.32 : 1})`;
          stage.style.pointerEvents = collapsedNow ? 'none' : 'auto';
        }
        const handle = handleRef.current;
        if (handle && handle.style) {
          handle.style.opacity = collapsedNow ? '1' : '0';
          handle.style.transform = `scale(${collapsedNow ? 1 : 0.85})`;
          handle.style.pointerEvents = collapsedNow ? 'auto' : 'none';
          handle.tabIndex = collapsedNow ? 0 : -1;
        }
        const hide = hideRef.current;
        if (hide && hide.style) {
          // × 不需要动画：它只属于展开态（hover 才显形）
          hide.style.display = collapsedNow ? 'none' : 'block';
        }
      };

      const setCollapsed = (next) => {
        const updated = normalizePrefsShape({ ...prefsRef.current, collapsed: next });
        setPrefs(updated);
        savePrefs(window.localStorage, updated);
        applyCollapsedDom(next);
        // 折叠时把球体冻住（rAF 不空转、不白烧 GPU），展开立刻恢复
        const sphere = sphereRef.current;
        if (sphere && typeof sphere.update === 'function') sphere.update({ paused: next === true });
      };

      const chrome = h('style', { key: 'chrome' }, CHROME_CSS);

      // 折叠把手：永远挂载，靠 display 切换（React 重渲染与命令式切换结果一致）
      const handle = h('button', {
        key: 'handle',
        type: 'button',
        ref: handleRef,
        className: 'energyOrb-handle',
        'data-dsh-energy-orb-handle': '',
        'aria-label': '展开能量球',
        'aria-expanded': !collapsed,
        title: '展开能量球',
        tabIndex: collapsed ? 0 : -1,
        style: {
          // 与舞台同一组属性、同一个时长，只是端点反过来：展开时把手缩小淡出、舞台放大淡入
          opacity: collapsed ? 1 : 0,
          transform: `scale(${collapsed ? 1 : 0.85})`,
          transition: `opacity ${COLLAPSE_MS}ms ease, transform ${COLLAPSE_MS}ms ease`,
          pointerEvents: collapsed ? 'auto' : 'none',
        },
        onClick: (event) => {
          event.stopPropagation();
          setCollapsed(false);
        },
        onPointerDown: (event) => event.stopPropagation(),
      }, prefs.anchor === 'bottom-left' ? '↘' : '↙');

      // 隐藏按钮：展开态右上角，平时透明、hover/focus 显形（不抢拖拽的面子）
      const hideButton = h('button', {
        key: 'hide',
        type: 'button',
        ref: hideRef,
        className: 'energyOrb-hide',
        'data-dsh-energy-orb-hide': '',
        'aria-label': '隐藏能量球',
        'aria-expanded': !collapsed,
        title: '隐藏能量球',
        style: {
          display: collapsed ? 'none' : 'block',
          position: 'absolute',
          top: '2px',
          right: '2px',
          width: '22px',
          height: '22px',
          padding: 0,
          lineHeight: '20px',
          textAlign: 'center',
          borderRadius: '50%',
          border: '1px solid rgba(66,220,255,.4)',
          background: 'rgba(8,14,20,.66)',
          color: '#9fd8ff',
          font: '600 13px/20px ui-monospace,monospace',
          cursor: 'pointer',
          appearance: 'none',
          backdropFilter: 'blur(6px)',
          zIndex: 2,
        },
        onClick: (event) => {
          event.stopPropagation();
          setCollapsed(true);
        },
        onPointerDown: (event) => event.stopPropagation(),
      }, [
        h('span', { key: 'glyph', 'aria-hidden': 'true' }, '×'),
        // 悬浮提示：hover / focus 时出现在 × 左侧。`aria-hidden` 掉，读屏器用按钮自己的 aria-label
        h('span', {
          key: 'label',
          className: 'energyOrb-hideLabel',
          'data-dsh-energy-orb-hide-label': '',
          'aria-hidden': 'true',
        }, '隐藏 / hide'),
      ]);

      const stage = h('div', {
        key: 'stage',
        ref: (node) => {
          stageRef.current = node;
          containerRef.current = node;
        },
        'data-dsh-energy-orb-stage': '',
        style: {
          width: '100%',
          height: '100%',
          // 折叠 = 缩小 + 淡出（不是 display:none 一刀切），展开就是它的逆过程
          opacity: collapsed ? 0 : 1,
          transform: `scale(${collapsed ? 0.32 : 1})`,
          // 收起要缩进 × 所在的角：× 永远在盒子右上角，所以原点固定 top right
          transformOrigin: 'top right',
          transition: `opacity ${COLLAPSE_MS}ms ease, transform ${COLLAPSE_MS}ms ease`,
          pointerEvents: collapsed ? 'none' : 'auto',
        },
        onPointerDown: (e) => {
          if (e.target && e.target.closest && e.target.closest('.energyOrb-hide')) return;   // 隐藏按钮自己处理
          onPointerDown(e);
        },
      });

      const paint = fallback
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
        : stage;

      return h('div', {
        'data-dsh-energy-orb-root': '',
        'data-dsh-energy-orb-collapsed': collapsed ? 'true' : 'false',
        ref: rootRef,
        className: 'energyOrb-root',
        style,
      }, [chrome, hideButton, handle, ...(Array.isArray(paint) ? paint : [paint])]);

    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 焦点会话来源：sessions 服务由 api-session-controller 的客户端半边提供。
        // 用 ctx.inject 懒挂（而不是写进 dsh.client.inject 硬依赖）：拿不到就退回 HTTP 全局快照，
        // 插件在极简宿主里仍然能装、能显示。
        // 防御：极简宿主（或老 cordis）可能没有 ctx.inject —— 那时不许把整个 apply 炸掉，
        // 只是拿不到焦点会话、退回 HTTP 全局口径。
        if (typeof ctx.inject === 'function') {
          ctx.inject(['sessions'], (scoped) => {
            sessionSource = scoped.sessions;
            return () => {
              if (sessionSource === scoped.sessions) sessionSource = null;
            };
          });
        }
        ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          { name: 'shell.overlay', id: 'dsh-fly-energy-orb', order: 10 },
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
        pickFocusedSession,
        resolveOrbState,
        stateUrl,
        idleOptions,
        STALE_MS,
        OPTION_KEYS,
        RAMP_MS,
        ROT_RAMP_MS,
        ROT_RAMP_ALPHA,
        RAMP_ALPHA,
      },
    };
  },
});
