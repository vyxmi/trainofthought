/**
 * anim.js — the motion engine.
 *
 * Two interchangeable backends behind one API:
 *
 *   native (default) — requestAnimationFrame + SVGGeometryElement.getPointAtLength().
 *                      This is what GSAP's MotionPathPlugin does under the hood:
 *                      sample the centerline, derive the tangent, set the transform.
 *                      Zero dependencies, ships working out of the box.
 *
 *   gsap   (opt-in)  — real GSAP + MotionPathPlugin. Better easing vocabulary,
 *                      a proper timeline, and smoother resampling on long paths.
 *
 * To switch: drop gsap.min.js and MotionPathPlugin.min.js into ext/vendor/, then
 * set USE_GSAP = true below. Nothing else in the codebase changes — every caller
 * goes through place() / followPath() / tween() / drawPath(), and both backends
 * implement all four with identical semantics.
 *
 * The one rule that keeps them interchangeable: a given element is positioned by
 * exactly one backend for its whole life. Never mix the transform *attribute*
 * (native) with GSAP's CSS transforms on the same node, or they double-apply.
 */

export const USE_GSAP = false;

const G = () => (typeof window !== 'undefined' ? window.gsap : undefined);
export const engineName = USE_GSAP && G() ? 'gsap' : 'native';

// ---------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------

/** Newton-Raphson cubic-bezier solver, so named eases match CSS and GSAP exactly. */
function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) {
      const d = slopeX(t);
      if (Math.abs(d) < 1e-6) break;
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-6) break;
      t -= err / d;
    }
    return sampleY(t);
  };
}

export const EASE = {
  /** A locomotive under power: unhurried pull away, confident run, long brake.
   *  The asymmetry is the point — arrival should feel like it was decided. */
  rail: cubicBezier(0.42, 0.0, 0.12, 1.0),
  /** Rail being laid. Quick out of the gate, then it reaches. */
  lay: cubicBezier(0.22, 0.9, 0.24, 1.0),
  /** Mechanical, no easing personality — for switch blades and signal arms. */
  mech: cubicBezier(0.6, 0.0, 0.3, 1.0),
  out: cubicBezier(0.16, 0.84, 0.32, 1.0),
  inOut: cubicBezier(0.65, 0.0, 0.35, 1.0),
  linear: (t) => t,
};

const GSAP_EASE = {
  rail: 'power3.inOut',
  lay: 'power2.out',
  mech: 'power2.inOut',
  out: 'power3.out',
  inOut: 'power2.inOut',
  linear: 'none',
};

// ---------------------------------------------------------------------------
// Reduced motion
// ---------------------------------------------------------------------------

let motionMode = 'auto'; // 'auto' | 'full' | 'off'

export function setMotionMode(mode) {
  motionMode = mode || 'auto';
}

export function motionDisabled() {
  if (motionMode === 'off') return true;
  if (motionMode === 'full') return false;
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Scale any duration through the current motion mode. */
function dur(ms) {
  return motionDisabled() ? 0 : ms;
}

// ---------------------------------------------------------------------------
// Core loop
// ---------------------------------------------------------------------------

const running = new WeakMap(); // el -> cancel fn

/** Cancel any in-flight animation on an element. Prevents two switches racing. */
export function cancel(el) {
  const stop = running.get(el);
  if (stop) stop();
  running.delete(el);
  if (engineName === 'gsap') G()?.killTweensOf(el);
}

function raf(el, ms, easeFn, onFrame) {
  return new Promise((resolve) => {
    if (ms <= 0) {
      onFrame(1);
      resolve();
      return;
    }
    cancel(el);
    let id = 0;
    let start = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      running.delete(el);
      resolve();
    };
    running.set(el, () => {
      cancelAnimationFrame(id);
      finish();
    });
    const step = (now) => {
      if (!start) start = now;
      const p = Math.min(1, (now - start) / ms);
      onFrame(easeFn(p));
      if (p < 1) id = requestAnimationFrame(step);
      else finish();
    };
    id = requestAnimationFrame(step);
  });
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/** Position an SVG group. The only function allowed to move the locomotive. */
export function place(el, x, y, rot = 0) {
  if (!el) return;
  if (engineName === 'gsap') {
    G().set(el, { x, y, rotation: rot, transformOrigin: '50% 50%', xPercent: 0, yPercent: 0 });
  } else {
    el.setAttribute('transform', `translate(${round(x)},${round(y)}) rotate(${round(rot)})`);
  }
}

const round = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Path following
// ---------------------------------------------------------------------------

/**
 * Ensure a measurable guide path exists. It must live inside a rendered <svg>
 * (not display:none) for getPointAtLength to work, so guides sit in a hidden-by-
 * paint layer rather than a hidden-by-layout one.
 */
export function makeGuide(layer, d) {
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d);
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'none');
  layer.appendChild(p);
  return p;
}

/**
 * Move `el` along path `d`, rotating to the tangent.
 * @returns {Promise<void>} resolves when the locomotive has stopped.
 */
export function followPath(
  el,
  d,
  { layer, duration = 700, ease = 'rail', autoRotate = true, maxRotate = 38, onUpdate } = {}
) {
  const guide = makeGuide(layer, d);
  const cleanup = () => guide.remove();

  let len = 0;
  try {
    len = guide.getTotalLength();
  } catch {
    len = 0;
  }
  if (!len) {
    cleanup();
    return Promise.resolve();
  }

  /**
   * Tangent angle at arc-length l, leaned rather than followed exactly.
   *
   * The yard ladder is close to vertical in a panel this narrow, so a literally
   * correct tangent points the engine straight down for most of a long switch,
   * and it reads as falling rather than travelling. Clamping the lean keeps the
   * engine legible while still turning the right way through each turnout —
   * the same licence a track diagram takes over a survey drawing.
   */
  const rotAt = (l) => {
    if (!autoRotate) return 0;
    // 1.5px chord: long enough to be numerically stable, short enough to
    // resolve the turnout curves.
    const a = guide.getPointAtLength(Math.max(0, l - 1.5));
    const b = guide.getPointAtLength(Math.min(len, l + 1.5));
    const deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    return Math.max(-maxRotate, Math.min(maxRotate, deg));
  };

  if (engineName === 'gsap') {
    return new Promise((resolve) => {
      G().to(el, {
        duration: dur(duration) / 1000,
        ease: GSAP_EASE[ease] || ease,
        // Position from MotionPath, rotation from the sampler above, so both
        // engines lean identically.
        motionPath: { path: guide, align: guide, alignOrigin: [0.5, 0.5], autoRotate: false },
        onUpdate() {
          const p = this.progress();
          G().set(el, { rotation: rotAt(p * len) });
          onUpdate?.(p);
        },
        onComplete: () => {
          cleanup();
          resolve();
        },
      });
    });
  }

  return raf(el, dur(duration), EASE[ease] || EASE.rail, (p) => {
    const l = p * len;
    const pt = guide.getPointAtLength(l);
    place(el, pt.x, pt.y, rotAt(l));
    onUpdate?.(p, pt);
  }).then(cleanup, cleanup);
}

/** Drop an element onto a path at position t (0..1) with no animation. */
export function placeOnPath(el, d, t, { layer, autoRotate = true } = {}) {
  const guide = makeGuide(layer, d);
  try {
    const len = guide.getTotalLength();
    const pt = guide.getPointAtLength(t * len);
    let rot = 0;
    if (autoRotate && len > 3) {
      const a = guide.getPointAtLength(Math.max(0, t * len - 1.5));
      const b = guide.getPointAtLength(Math.min(len, t * len + 1.5));
      rot = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    }
    place(el, pt.x, pt.y, rot);
  } finally {
    guide.remove();
  }
}

// ---------------------------------------------------------------------------
// Generic tweens
// ---------------------------------------------------------------------------

/**
 * Tween arbitrary numbers and hand them back each frame. Used for stroke
 * dashoffset, opacity, blade rotation — anything that isn't path following.
 */
export function tween({ el, from = 0, to = 1, duration = 300, ease = 'out', apply, onComplete }) {
  const target = el || {};
  if (engineName === 'gsap' && G()) {
    const proxy = { v: from };
    return new Promise((resolve) => {
      G().to(proxy, {
        v: to,
        duration: dur(duration) / 1000,
        ease: GSAP_EASE[ease] || ease,
        onUpdate: () => apply(proxy.v),
        onComplete: () => {
          onComplete?.();
          resolve();
        },
      });
    });
  }
  return raf(target, dur(duration), EASE[ease] || EASE.out, (p) => apply(from + (to - from) * p)).then(() => {
    onComplete?.();
  });
}

/** Draw a stroked path on (or off) using dash offset. The rail-laying primitive. */
export function drawPath(pathEl, { duration = 520, ease = 'lay', reverse = false } = {}) {
  let len = 0;
  try {
    len = pathEl.getTotalLength();
  } catch {
    len = 0;
  }
  if (!len) return Promise.resolve();
  pathEl.style.strokeDasharray = `${len}`;
  return tween({
    el: pathEl,
    from: reverse ? 0 : len,
    to: reverse ? len : 0,
    duration,
    ease,
    apply: (v) => {
      pathEl.style.strokeDashoffset = String(v);
    },
    onComplete: () => {
      if (!reverse) {
        pathEl.style.strokeDasharray = '';
        pathEl.style.strokeDashoffset = '';
      }
    },
  });
}

export function wait(ms) {
  return new Promise((r) => setTimeout(r, dur(ms)));
}
