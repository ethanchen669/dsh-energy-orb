// Client 半边：OrbClient（shell.overlay 挂载 + 轮询 + 显示偏好 + 拖拽）。
// 渲染器与 Three.js 经资产路由动态 import 懒加载（Task 6 完成绘制，Task 7 收口降级）。
window.__ModuleLoader__.load({
  id: 'dsh-energy-orb',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PREFS_KEY = 'energy-orb.display';
    const POLL_OK_MS = 2_000;
    const POLL_FAIL_MS = 10_000;
    const STATE_URL = '/api/energy-orb/state';
    const RENDERER_URL = '/energy-orb/assets/orb-renderer.js';
    const THREE_URL = '/energy-orb/assets/three.module.min.js';

    // ---------- 纯逻辑（__testables 供 node --test 直接测） ----------
    function loadPrefs(storage) {
      try {
        const raw = JSON.parse(storage.getItem(PREFS_KEY));
        return normalizePrefsShape(raw);
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
    // 本地 prefs 形状 clamp（与 orb-renderer.normalizePrefs 同契约；client.js 是 classic
    // script 不能静态 import，此处保留一份极简镜像，绘制层用渲染器的完整版）
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

    // ---------- 组件 ----------
    function OrbComponent() {
      const [prefs, setPrefs] = React.useState(() => loadPrefs(window.localStorage));
      const [fallback, setFallback] = React.useState(false);
      const canvasRef = React.useRef(null);
      const orbRef = React.useRef(null);
      const prefsRef = React.useRef(prefs);
      prefsRef.current = prefs;

      // 初始化渲染器 + 轮询；卸载时全部释放（Task 7 进一步收口）
      React.useEffect(() => {
        let stopped = false;
        let timer = 0;
        const storage = window.localStorage;
        const reduced = window.matchMedia
          ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
          : false;

        (async () => {
          try {
            const [rendererMod, THREE] = await Promise.all([
              import(RENDERER_URL),
              import(THREE_URL),
            ]);
            if (!stopped && canvasRef.current) {
              orbRef.current = rendererMod.createOrb(canvasRef.current, { reducedMotion: reduced, THREE });
            }
          } catch {
            if (!stopped) setFallback(true);   // vendor/WebGL 失败 → CSS 降级球
          }
          const loop = async () => {
            if (stopped) return;
            const ms = await pollOnce(window.fetch.bind(window), (state) => {
              if (!stopped && orbRef.current) orbRef.current.setState(state);
            });
            timer = window.setTimeout(loop, ms);
          };
          loop();
        })();

        return () => {
          stopped = true;
          window.clearTimeout(timer);
          if (orbRef.current) {
            orbRef.current.dispose();
            orbRef.current = null;
          }
        };
      }, []);

      // 拖拽改 offset（存 localStorage）；点击充能 = 本地视觉脉冲
      const onPointerDown = (e) => {
        const start = { x: e.clientX, y: e.clientY, ox: prefsRef.current.offset.x, oy: prefsRef.current.offset.y };
        let moved = false;
        const move = (ev) => {
          moved = true;
          const next = normalizePrefsShape({
            ...prefsRef.current,
            offset: { x: start.ox + ev.clientX - start.x, y: start.oy + ev.clientY - start.y },
          });
          setPrefs(next);
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          if (moved) savePrefs(window.localStorage, prefsRef.current);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        if (!moved && orbRef.current && orbRef.current.pulse) orbRef.current.pulse();
      };

      const style = {
        position: 'fixed',
        right: prefs.anchor === 'bottom-right' ? `calc(26px + ${prefs.offset.x}px)` : 'auto',
        left: prefs.anchor === 'bottom-left' ? `calc(26px + ${prefs.offset.x}px)` : 'auto',
        bottom: `calc(22px + ${-prefs.offset.y}px)`,
        width: `${prefs.size * 2}px`,
        height: `${prefs.size * 2}px`,
        zIndex: 40,
        pointerEvents: 'auto',
        touchAction: 'none',
        display: prefs.visible ? 'block' : 'none',
      };

      return h('div', {
        'data-dsh-energy-orb-root': '',
        className: 'energyOrb-root',
        style,
        onPointerDown,
      }, fallback
        ? h('div', { className: 'energyOrb-fallback', 'data-dsh-energy-orb-fallback': '' })
        : h('canvas', { ref: canvasRef, 'data-dsh-energy-orb-canvas': '' }));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          { name: 'shell.overlay', id: 'dsh-energy-orb', order: 10 },
          OrbComponent,
        ));
      },
      __testables: { pollOnce, loadPrefs, savePrefs },
    };
  },
});
