/**
 * motion.js — the four movements that mean something.
 *
 * Motion here is semantic, not decorative. Every animation in this file exists
 * to answer a question the user would otherwise have to reconstruct:
 *
 *   switchTracks  — "where did my attention just go, and where did it come from"
 *   layTrack      — "this is a new place, it did not exist a second ago"
 *   markReturn    — "something was left behind, deliberately, right there"
 *   resumeTo      — "you are back, and this is the spot"
 *
 * CSS handles tactile hover states; all mechanical motion here is tied to an
 * actual state change. Total budget for the signature switch stays near one
 * second, with the shed adding a short door action when it is involved.
 */

import { followPath, place, drawPath, tween, cancel, setMotionMode, motionDisabled } from './anim.js';
import { switchPath, locomotive, GEO } from './railway.js';

const BLADE_MS = 170;
const RUN_MS = 680;
const LAY_MS = 520;
const MARKER_MS = 300;

export class Motion {
  constructor(svg) {
    this.svg = svg;
    this.loco = locomotive();
    this.layout = null;
    this.handles = null;
    /** Movements are queued, never overlapped. Two concurrent runs on one
     *  locomotive fight over cancel(): each kills the other's tween, fires the
     *  loser's onComplete, and leaves blades thrown and the engine snapped to
     *  the wrong platform. Reachable by double-clicking, or by a second window
     *  writing state mid-flight. */
    this._chain = Promise.resolve();
  }

  /** Run `fn` after any movement already in flight. */
  _serial(fn) {
    const next = this._chain.then(fn);
    this._chain = next.catch(() => {});
    return next;
  }

  setMode(mode) {
    setMotionMode(mode);
  }

  /** Called after every structural rebuild — the engine outlives the yard. */
  attach(layout, handles) {
    this.layout = layout;
    this.handles = handles;
    this.svg.appendChild(this.loco); // always last child, always on top
  }

  get guides() {
    return this.handles?.guides;
  }

  rowOf(index) {
    const slot = this.layout?.slots[index];
    if (!slot?.id) return null;
    return this.handles?.rows.get(slot.id) || null;
  }

  indexFor(trackId) {
    const slot = this.layout?.slotFor(trackId);
    return slot ? slot.index : this.layout ? this.layout.depot.index : 0;
  }

  /** Drop the engine where it belongs with no movement. Used on first paint and
   *  after a resize, where animating would imply a change that didn't happen. */
  settle(trackId) {
    if (!this.layout) return;
    const slot = this.layout.slotFor(trackId);
    place(this.loco, slot.platformX, slot.y, 0);
    this.loco.classList.toggle('at-depot', slot.kind === 'depot');
  }

  // -------------------------------------------------------------------------
  // 1. Switch tracks — the signature interaction
  // -------------------------------------------------------------------------

  /**
   * The blade throws first, then the engine moves. That order is not a detail:
   * it is the difference between a machine responding to a decision and a
   * cartoon train sliding around. The mechanism commits, then the mass follows.
   */
  switchTracks(fromId, toId, opts = {}) {
    return this._serial(() => this._switch(fromId, toId, opts));
  }

  async _switch(fromId, toId, { leaveMarker = true } = {}) {
    if (!this.layout) return;
    const a = this.indexFor(fromId);
    const b = this.indexFor(toId);
    const A = this.layout.slots[a];
    const B = this.layout.slots[b];
    if (!A || !B) return;

    cancel(this.loco);
    this.svg.classList.add('is-moving');
    const usesShed = A.kind === 'depot' || B.kind === 'depot';

    try {
      if (usesShed) await this.setShed(true);
      // Throw both blades — the one letting us out, the one letting us in.
      const dir = Math.sign(b - a) || 1;
      await Promise.all([this.throwBlade(a, dir), this.throwBlade(b, -dir)]);

      const d = switchPath(this.layout, a, b, A.platformX, B.platformX);

      // The board goes up as the engine pulls away, not after it has gone. You
      // should see the thing being left behind while you're still leaving.
      const departing = leaveMarker && A.kind === 'track' ? this.markReturn(a) : Promise.resolve();

      this.svg.classList.add('is-running');
      try {
        await Promise.all([
          followPath(this.loco, d, { layer: this.guides, duration: RUN_MS, ease: 'rail', autoRotate: true }),
          departing,
        ]);
      } finally {
        this.svg.classList.remove('is-running');
      }

      // Rotation accumulated through the turnouts; level the engine on arrival.
      place(this.loco, B.platformX, B.y, 0);
      this.loco.classList.toggle('at-depot', B.kind === 'depot');
      await this.arrivalSettle(b);
    } finally {
      this.svg.classList.remove('is-moving');
      this.svg.classList.remove('is-running');
      this.resetBlades();
      if (usesShed) await this.setShed(false);
    }
  }

  /**
   * Resume is a switch that ends by clearing the board you left.
   *
   * The board has to be forced visible first: render() runs syncAspects before
   * animateDiff, and syncAspects has already hidden the marker on the track
   * being boarded. Without this the lift silently no-ops and the board just
   * vanishes a frame early — which loses the one moment that says "you're back,
   * and this is the spot you meant".
   */
  resumeTo(fromId, toId, opts = {}) {
    return this._serial(async () => {
      const row = this.rowOf(this.indexFor(toId));
      if (row?.marker) {
        row.marker.classList.remove('is-hidden');
        row.marker.style.opacity = '';
      }
      await this._switch(fromId, toId, opts);
      if (row) await this.liftMarker(row);
    });
  }

  // -------------------------------------------------------------------------
  // 2. Lay a new track
  // -------------------------------------------------------------------------

  /**
   * Rail draws outward from the junction, then the engine switches onto it.
   * Creating a place and going to it are two events, and showing them as two
   * events is what makes a new track feel like it was *built* rather than
   * appended to a list.
   */
  layTrack(trackId, fromId) {
    return this._serial(() => this._lay(trackId, fromId));
  }

  async _lay(trackId, fromId) {
    if (!this.layout) return;
    const row = this.handles?.rows.get(trackId);
    if (!row) return;

    const paths = [row.g.querySelector('.sleepers'), row.g.querySelector('.rail'), row.g.querySelector('.railhead')];
    const decor = [...row.g.querySelectorAll('.turnout, .signal, .blade')];

    for (const el of decor) el.style.opacity = '0';
    row.marker?.classList.add('is-hidden');

    await Promise.all(
      paths.filter(Boolean).map((p, i) => drawPath(p, { duration: LAY_MS + i * 40, ease: 'lay' }))
    );

    await Promise.all(
      decor.map((el, i) =>
        tween({
          el,
          from: 0,
          to: 1,
          duration: 200,
          ease: 'out',
          apply: (v) => {
            el.style.opacity = String(v);
          },
        }).then(() => {
          el.style.opacity = '';
        })
      )
    );

    await this._switch(fromId, trackId);
  }

  // -------------------------------------------------------------------------
  // 3. Mark a return point
  // -------------------------------------------------------------------------

  /** The board drops into place at the platform the engine is leaving. */
  async markReturn(index) {
    const row = this.rowOf(index);
    if (!row?.marker) return;
    const m = row.marker;
    // Set the start of the animation before revealing it. syncAspects has
    // already un-hidden this marker at full size, so removing the class first
    // shows one frame of the finished state and the board appears to pop.
    m.style.opacity = '0';
    m.classList.remove('is-hidden');
    m.style.pointerEvents = '';
    const { platformX, y } = row.slot;

    return tween({
      el: m,
      from: 0,
      to: 1,
      duration: MARKER_MS,
      ease: 'out',
      apply: (v) => {
        // Falls the last few pixels into the ground and settles.
        m.setAttribute('transform', `translate(${platformX},${y - (1 - v) * 9}) scale(${0.7 + 0.3 * v})`);
        m.style.opacity = String(v);
      },
      onComplete: () => {
        m.setAttribute('transform', `translate(${platformX},${y})`);
        m.style.opacity = '';
      },
    });
  }

  /** ...and lifts away when the engine takes its place. */
  async liftMarker(row) {
    if (!row?.marker || row.marker.classList.contains('is-hidden')) return;
    const m = row.marker;
    const { platformX, y } = row.slot;
    await tween({
      el: m,
      from: 1,
      to: 0,
      duration: 200,
      ease: 'inOut',
      apply: (v) => {
        m.setAttribute('transform', `translate(${platformX},${y - (1 - v) * 7}) scale(${0.75 + 0.25 * v})`);
        m.style.opacity = String(v);
      },
    });
    m.classList.add('is-hidden');
    m.style.opacity = '';
    m.setAttribute('transform', `translate(${platformX},${y})`);
  }

  // -------------------------------------------------------------------------
  // Mechanism
  // -------------------------------------------------------------------------

  async throwBlade(index, dir) {
    const row = this.rowOf(index);
    if (!row?.blade) return;
    const arm = row.blade.querySelector('.blade-arm');
    if (!arm) return;
    row.blade.classList.add('is-thrown');
    await tween({
      el: arm,
      from: 0,
      to: dir * 6.5,
      duration: BLADE_MS,
      ease: 'mech',
      apply: (v) => {
        arm.setAttribute('transform', `rotate(${v})`);
      },
    });
  }

  resetBlades() {
    if (!this.handles) return;
    for (const row of this.handles.rows.values()) {
      row.blade?.classList.remove('is-thrown');
      const arm = row.blade?.querySelector('.blade-arm');
      arm?.setAttribute('transform', 'rotate(0)');
    }
  }

  /** Split doors slide apart before the locomotive enters or leaves, then meet
   *  again once the movement is complete. */
  async setShed(open) {
    const depot = this.handles?.depot;
    const left = depot?.querySelector('.shed-door-left');
    const right = depot?.querySelector('.shed-door-right');
    if (!depot || !left || !right) return;
    const finish = (value) => {
      left.setAttribute('transform', `translate(${-5 * value} 0)`);
      right.setAttribute('transform', `translate(${5 * value} 0)`);
      depot.classList.toggle('is-open', value > 0.5);
    };
    if (motionDisabled()) {
      finish(open ? 1 : 0);
      return;
    }
    const from = open ? 0 : 1;
    const to = open ? 1 : 0;
    depot.classList.toggle('is-opening', open);
    await tween({
      el: depot,
      from,
      to,
      duration: 180,
      ease: 'mech',
      apply: finish,
      onComplete: () => {
        finish(to);
        depot.classList.remove('is-opening');
      },
    });
  }

  /** A very small compression on arrival — the engine taking up the slack in the
   *  couplings. Two frames of physicality, not a bounce. */
  async arrivalSettle(index) {
    if (motionDisabled()) return;
    const slot = this.layout.slots[index];
    await tween({
      el: this.loco,
      from: 0,
      to: 1,
      duration: 180,
      ease: 'out',
      apply: (v) => {
        const back = Math.sin(v * Math.PI) * 1.8;
        place(this.loco, slot.platformX - back, slot.y, 0);
      },
      onComplete: () => place(this.loco, slot.platformX, slot.y, 0),
    });
  }

}

export { GEO };
