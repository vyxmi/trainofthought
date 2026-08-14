/**
 * railway.js — geometry and SVG construction.
 *
 * The layout is a yard ladder: a single leaning spine on the left with a turnout
 * onto every track, and an engine shed at the bottom. That shape isn't decorative
 * — it's the reason the metaphor holds. A ladder means every track is reachable
 * from every other track by exactly one route, which is precisely true of the
 * thing being modelled: your attention can go from anything to anything, but it
 * has to physically travel, and it can only be in one place.
 *
 * Coordinates are 1:1 with CSS pixels (the viewBox is regenerated on resize), so
 * HTML labels can be absolutely positioned against SVG geometry without any
 * transform math.
 */

import { STATUS, LEFT } from './store.js';

const NS = 'http://www.w3.org/2000/svg';

export const GEO = {
  PAD_R: 14, // right margin — rails run toward it, never quite off the edge
  LADDER_X0: 22, // ladder x at the top row
  LADDER_SLOPE: 5, // ladder leans right as it descends, like a real yard throat
  // Row height is set by clearance, not taste: the label block is ~32px tall and
  // must clear the locomotive's roof (19px above the rail) with air to spare, or
  // the engine parks on top of the words.
  ROW_TOP: 62,
  ROW_H: 74,
  DEPOT_GAP: 44,
  // Small and tidy. A large radius made the drawn turnouts read as decorative
  // hooks; the near-vertical ladder run it was trying to hide is dealt with by
  // clamping the engine's lean instead (see anim.js maxRotate).
  TURNOUT_R: 14,
  PLATFORM_DX: 78, // where the locomotive stands, measured from the ladder
  SIGNAL_INSET: 22, // signals align in a column on the right edge
  // Labels clear the ladder entirely. The left gutter belongs to the railway —
  // it is the one column the locomotive travels through, and text in it gets run
  // over. This is why the yard has a spine.
  LABEL_DX: 46,
  LABEL_TOP: -56, // label block sits above its rail, which underlines it
};

/**
 * @param {number} width       panel width in px
 * @param {string[]} trackIds  live track ids, top to bottom
 * @returns layout with a `slots` array; slot index === row index, and the final
 *          slot is always the depot, so switch paths need no special-casing.
 */
export function computeLayout(width, trackIds) {
  const W = Math.max(240, Math.round(width));
  const n = trackIds.length;
  const slots = [];

  for (let i = 0; i < n; i++) {
    const y = GEO.ROW_TOP + i * GEO.ROW_H;
    const lx = GEO.LADDER_X0 + i * GEO.LADDER_SLOPE;
    slots.push({
      kind: 'track',
      id: trackIds[i],
      index: i,
      y,
      lx,
      platformX: lx + GEO.PLATFORM_DX,
      signalX: W - GEO.SIGNAL_INSET,
      railEndX: W - GEO.PAD_R,
      labelX: lx + GEO.LABEL_DX,
      labelY: y + GEO.LABEL_TOP,
    });
  }

  const depotY = (n ? GEO.ROW_TOP + (n - 1) * GEO.ROW_H : GEO.ROW_TOP - GEO.ROW_H) + GEO.DEPOT_GAP;
  const depotLx = GEO.LADDER_X0 + n * GEO.LADDER_SLOPE;
  slots.push({
    kind: 'depot',
    id: null,
    index: n,
    y: depotY,
    lx: depotLx,
    platformX: depotLx + 44,
    railEndX: depotLx + 92,
    labelX: depotLx + 100,
    labelY: depotY - 9,
  });

  return {
    width: W,
    height: depotY + 30,
    slots,
    tracks: slots.slice(0, n),
    depot: slots[n],
    byId: new Map(slots.filter((s) => s.id).map((s) => [s.id, s])),
    /** Slot for a track id, or the depot when id is null/unknown. */
    slotFor(id) {
      return (id && this.byId.get(id)) || this.depot;
    },
  };
}

// ---------------------------------------------------------------------------
// Path geometry
// ---------------------------------------------------------------------------

export function railPath(slot) {
  return `M ${slot.lx},${slot.y} L ${slot.railEndX},${slot.y}`;
}

/** The two halves of a turnout, drawn only where the ladder actually continues. */
export function turnoutPaths(layout, slot) {
  const r = GEO.TURNOUT_R;
  const out = [];
  if (slot.index > 0) {
    const prev = layout.slots[slot.index - 1];
    const ax = slot.lx + (prev.lx - slot.lx) * 0.25;
    out.push({ dir: 'up', d: `M ${ax},${slot.y - r} Q ${slot.lx},${slot.y} ${slot.lx + r},${slot.y}` });
  }
  if (slot.index < layout.slots.length - 1) {
    const next = layout.slots[slot.index + 1];
    const ax = slot.lx + (next.lx - slot.lx) * 0.25;
    out.push({ dir: 'down', d: `M ${ax},${slot.y + r} Q ${slot.lx},${slot.y} ${slot.lx + r},${slot.y}` });
  }
  return out;
}

export function ladderPath(layout) {
  if (layout.slots.length < 2) return '';
  return layout.slots.map((s, i) => `${i ? 'L' : 'M'} ${s.lx},${s.y}`).join(' ');
}

/**
 * The composite route the locomotive actually drives when changing tracks:
 * run back along the current track, curve into the ladder at the turnout, travel
 * the ladder, curve out onto the new track, run up to its platform.
 *
 * This is one continuous path with real curves at both turnouts, which is why
 * autoRotate looks right — the engine leans into the junction instead of pivoting.
 */
export function switchPath(layout, fromIndex, toIndex, fromX, toX) {
  const A = layout.slots[fromIndex];
  const B = layout.slots[toIndex];
  if (!A || !B) return '';
  const r = GEO.TURNOUT_R;

  if (fromIndex === toIndex) return `M ${fromX},${A.y} L ${toX},${A.y}`;

  const dir = Math.sign(toIndex - fromIndex);
  return [
    `M ${fromX},${A.y}`,
    `L ${A.lx + r},${A.y}`,
    `Q ${A.lx},${A.y} ${A.lx},${A.y + dir * r}`,
    `L ${B.lx},${B.y - dir * r}`,
    `Q ${B.lx},${B.y} ${B.lx + r},${B.y}`,
    `L ${toX},${B.y}`,
  ].join(' ');
}

// ---------------------------------------------------------------------------
// Signal aspects
// ---------------------------------------------------------------------------

/** Status → signal aspect. Six statuses, five aspects: parked-because-blocked
 *  gets a distinct red, because "I stopped here for a reason" reads differently
 *  from "I stepped away", and that difference is the whole value of the marker. */
export function aspectFor(track) {
  if (!track) return 'off';
  switch (track.status) {
    case STATUS.ACTIVE:
      return 'clear';
    case STATUS.READY:
      return 'ready';
    case STATUS.WAITING:
      return 'caution';
    case STATUS.AI:
      return 'auto';
    case STATUS.PARKED:
      return track.leftBecause === LEFT.BLOCKED ? 'danger' : 'off';
    default:
      return 'off';
  }
}

// ---------------------------------------------------------------------------
// SVG helpers
// ---------------------------------------------------------------------------

function el(name, attrs = {}, children = []) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    node.setAttribute(k, String(v));
  }
  for (const c of children) node.appendChild(c);
  return node;
}

/**
 * A shunter, not an express engine. The choice is deliberate: a shunter's entire
 * job is moving stock between tracks in a yard, which is exactly the job being
 * modelled. It also reads more clearly than a steam profile at 36px.
 * Drawn facing right, wheels on y=0, so it can be dropped straight onto a rail.
 */
export function locomotive() {
  return el('g', { class: 'loco', 'aria-hidden': 'true' }, [
    el('g', { class: 'loco-shadow' }, [el('ellipse', { cx: 0, cy: 1.2, rx: 14, ry: 2 })]),
    // wheels
    el('circle', { class: 'wheel', cx: -8, cy: -3.4, r: 3.4 }),
    el('circle', { class: 'wheel', cx: -0.5, cy: -3.4, r: 3.4 }),
    el('circle', { class: 'wheel wheel-driver', cx: 7.8, cy: -4, r: 4 }),
    el('path', { class: 'rod', d: 'M -8,-3.4 L 7.8,-4' }),
    // frame
    el('rect', { class: 'body frame', x: -13.5, y: -9, width: 27, height: 3, rx: 0.8 }),
    // hood
    el('rect', { class: 'body hood', x: -13, y: -15.2, width: 16, height: 6.4, rx: 1.6 }),
    el('rect', { class: 'body stack', x: -9.6, y: -17.2, width: 3, height: 2.4, rx: 0.7 }),
    // cab
    el('rect', { class: 'body cab', x: 2.4, y: -19, width: 10.8, height: 10.2, rx: 1.8 }),
    el('rect', { class: 'glass', x: 4.1, y: -17.1, width: 7.2, height: 4.4, rx: 0.9 }),
    // lamp
    el('circle', { class: 'lamp', cx: -13.4, cy: -12, r: 1.4 }),
    el('path', { class: 'beam', d: 'M -14.2,-12 L -26,-15.5 L -26,-8.5 Z' }),
  ]);
}

/** A signal governs entry to a track. Tapping it is how you say "this is ready". */
export function signal(track) {
  const aspect = aspectFor(track);
  const g = el('g', {
    class: `signal aspect-${aspect}`,
    'data-id': track.id,
    'data-action': 'signal',
    role: 'button',
    tabindex: '0',
  });
  g.appendChild(el('title', {}, []));
  g.lastChild.textContent = `${track.name} — ${aspect}`;
  g.appendChild(el('rect', { class: 'sig-base', x: -3.5, y: -3, width: 7, height: 3, rx: 1 }));
  g.appendChild(el('path', { class: 'sig-post', d: 'M 0,-2 L 0,-21' }));
  g.appendChild(el('path', { class: 'sig-hood', d: 'M -5.5,-30.5 A 5.5 5.5 0 0 1 5.5,-30.5' }));
  g.appendChild(el('circle', { class: 'sig-lamp', cx: 0, cy: -26, r: 4.2 }));
  g.appendChild(el('circle', { class: 'sig-glow', cx: 0, cy: -26, r: 8 }));
  // Generous invisible hit area — a 4px lamp is not a tap target.
  g.appendChild(el('rect', { class: 'sig-hit', x: -11, y: -34, width: 22, height: 36, fill: 'transparent' }));
  return g;
}

/**
 * The return marker: a permanent-way board left standing where the locomotive
 * was when you left. It appears only on tracks the locomotive is *not* on —
 * on the active track the engine itself is the marker.
 */
export function returnMarker(track) {
  const g = el('g', { class: 'marker', 'data-id': track.id, 'data-action': 'resume', role: 'button', tabindex: '0' });
  // A board, not a disc. A disc at this size is indistinguishable from a wheel,
  // which made the yard look like it had engines parked on every track.
  g.appendChild(el('path', { class: 'mk-post', d: 'M 0,0 L 0,-16' }));
  g.appendChild(el('rect', { class: 'mk-plate', x: 0.5, y: -17.5, width: 9.5, height: 7, rx: 1.2 }));
  g.appendChild(el('path', { class: 'mk-dot', d: 'M 3,-14.8 H 7.5' }));
  g.appendChild(el('rect', { class: 'mk-hit', x: -7, y: -21, width: 20, height: 24, fill: 'transparent' }));
  return g;
}

/** The engine shed. Where the locomotive sits when your attention isn't anywhere. */
export function depotShed(slot) {
  const g = el('g', { class: 'depot', transform: `translate(${slot.railEndX - 4},${slot.y})` });
  g.appendChild(el('path', { class: 'shed-floor', d: `M ${-(slot.railEndX - slot.lx) + 4},0 L 6,0` }));
  g.appendChild(el('path', { class: 'shed', d: 'M -30,0 L -30,-17 A 15 15 0 0 1 0,-17 L 0,0' }));
  g.appendChild(el('path', { class: 'shed-mouth', d: 'M -22,0 L -22,-15 A 11 11 0 0 1 -0.5,-15 L -0.5,0 Z' }));
  return g;
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

/**
 * Rebuild the yard's static structure. Returns handles the motion layer needs.
 * The locomotive node is *not* recreated here — it is owned by the caller and
 * survives rebuilds, so an in-flight movement is never orphaned.
 */
export function buildYard(svg, layout, tracks) {
  svg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
  svg.setAttribute('width', layout.width);
  svg.setAttribute('height', layout.height);

  const guides = el('g', { class: 'guides', 'pointer-events': 'none' });
  const gLadder = el('g', { class: 'ladder-layer' });
  const gRows = el('g', { class: 'rows' });

  const ld = ladderPath(layout);
  if (ld) {
    gLadder.appendChild(el('path', { class: 'ladder-sleepers', d: ld }));
    gLadder.appendChild(el('path', { class: 'ladder-rail', d: ld }));
  }

  const rows = new Map();

  for (const slot of layout.tracks) {
    const track = tracks[slot.id];
    if (!track) continue;
    const g = el('g', { class: 'row', 'data-id': track.id });
    const d = railPath(slot);

    g.appendChild(el('path', { class: 'sleepers', d }));
    g.appendChild(el('path', { class: 'rail', d }));
    g.appendChild(el('path', { class: 'railhead', d }));

    for (const t of turnoutPaths(layout, slot)) {
      g.appendChild(el('path', { class: `turnout turnout-${t.dir}`, d: t.d }));
    }

    // The switch blade: the small moving part that throws *before* the engine
    // moves. Mechanically it's what makes a switch a switch.
    const blade = el('g', { class: 'blade', transform: `translate(${slot.lx + 3},${slot.y})` });
    blade.appendChild(el('path', { class: 'blade-arm', d: 'M 0,0 L 13,0' }));
    g.appendChild(blade);

    const marker = returnMarker(track);
    marker.setAttribute('transform', `translate(${slot.platformX},${slot.y})`);
    g.appendChild(marker);

    const sig = signal(track);
    sig.setAttribute('transform', `translate(${slot.signalX},${slot.y})`);
    g.appendChild(sig);

    gRows.appendChild(g);
    rows.set(track.id, { g, slot, blade, marker, signal: sig, rail: g.querySelector('.rail') });
  }

  svg.replaceChildren(guides, gLadder, gRows, depotShed(layout.depot));
  return { guides, rows, ladder: gLadder, rowsLayer: gRows };
}

/** Update signal aspects and marker visibility without touching structure. */
export function syncAspects(handles, layout, state) {
  const activeId = state.locomotive?.trackId || null;
  for (const [id, row] of handles.rows) {
    const track = state.tracks[id];
    if (!track) continue;
    const aspect = aspectFor(track);
    row.signal.setAttribute('class', `signal aspect-${aspect}`);
    const title = row.signal.querySelector('title');
    if (title) title.textContent = `${track.name} — ${aspect}`;

    const isActive = id === activeId;
    row.g.classList.toggle('is-active', isActive);
    // Marker shows only where the engine isn't, and only once you've actually
    // left something behind there.
    const showMarker = !isActive && !!track.leftAt;
    row.marker.classList.toggle('is-hidden', !showMarker);
    row.marker.style.pointerEvents = showMarker ? '' : 'none';
  }
}
