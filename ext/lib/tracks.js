/**
 * tracks.js — domain logic.
 *
 * Every operation is a pure-ish mutation over the state object, run inside
 * store.update() so writes are serialised. The invariants this file exists to
 * protect:
 *
 *   1. Exactly one track can be ACTIVE, and it is always the one the locomotive
 *      is on. If locomotive.trackId is null, no track is ACTIVE.
 *   2. Every departure is recorded. A visible Stop is created only when the
 *      user leaves a meaningful currentStop note.
 *   3. ARRIVED tracks leave `order` and enter `history`. They stop being work.
 */

import { STATUS, SIGNAL, LEFT, EV, logEvent, newTrack, uid, update } from './store.js';

const TRACK_EVENT_CAP = 500;

function addTrackEvent(track, type, props = {}, at = Date.now()) {
  if (!Array.isArray(track.events)) track.events = [];
  const event = { id: uid(), type, at, ...props };
  track.events.push(event);
  if (track.events.length > TRACK_EVENT_CAP) track.events.splice(0, track.events.length - TRACK_EVENT_CAP);
  return event;
}

function trackName(state, id) {
  return id ? state.tracks[id]?.name || null : null;
}

/** The locomotive's current track object, or null if it's in the depot. */
export function activeTrack(state) {
  const id = state.locomotive?.trackId;
  return id ? state.tracks[id] || null : null;
}

export function liveTracks(state) {
  return state.order.map((id) => state.tracks[id]).filter(Boolean);
}

/** Tracks the locomotive is not on, in display order. */
export function otherTracks(state) {
  const cur = state.locomotive?.trackId;
  return liveTracks(state).filter((t) => t.id !== cur);
}

function touch(t) {
  t.updatedAt = Date.now();
}

/** Accrue time-on-track before the locomotive moves away. */
function settleTime(state, endedAt = Date.now()) {
  const cur = activeTrack(state);
  const since = state.locomotive?.sinceAt;
  if (!cur || !since) return null;
  const durationMs = Math.max(0, endedAt - since);
  cur.msOnTrack += durationMs;
  addTrackEvent(cur, 'ride', { startedAt: since, endedAt, durationMs }, endedAt);
  settleTimebox(cur, endedAt);
  return { startedAt: since, endedAt, durationMs };
}

function settleTimebox(track, at = Date.now()) {
  if (!track?.timebox?.runningSince) return;
  track.timebox.elapsedMs = Math.max(0, track.timebox.elapsedMs || 0) + Math.max(0, at - track.timebox.runningSince);
  track.timebox.runningSince = null;
}

function statusFromReason(reason) {
  switch (reason) {
    case LEFT.WAITING:
      return STATUS.WAITING;
    case LEFT.AI:
      return STATUS.AI;
    case LEFT.BLOCKED:
    case LEFT.SWITCHING:
    default:
      return STATUS.PARKED;
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Lay a new track. Name is the only requirement (spec §11 as revised).
 * If `board` is true the locomotive switches onto it immediately — which is
 * almost always what you want, since you create a track because you're about to
 * work on it.
 */
export async function createTrack({ name, destination = '', board = true, leave = null, parentId = null }) {
  return update(async (state) => {
    if (state.order.length >= 10) return;
    const t = newTrack({ name, destination, parentId });
    state.tracks[t.id] = t;
    // Append, so laying a new track never moves an existing one.
    if (parentId && state.order.includes(parentId)) {
      let index = state.order.indexOf(parentId) + 1;
      while (index < state.order.length && state.tracks[state.order[index]]?.parentId === parentId) index += 1;
      state.order.splice(index, 0, t.id);
    } else state.order.push(t.id);

    await logEvent(EV.TRACK_CREATED, {
      id: t.id,
      hasDestination: !!t.destination,
      // Second-track creation is the activation moment worth watching (spec §23).
      ordinal: state.order.length,
    });

    if (board) {
      // Creating a track you're about to work on is still leaving the one you're
      // on. The old track must be parked properly or the promise breaks.
      await leave_(state, {
        stopText:
          leave?.stopText ??
          (parentId && state.locomotive?.trackId === parentId ? state.tracks[parentId]?.currentStop || '' : ''),
        reason: leave?.reason || LEFT.SWITCHING,
        stopPrefilled: !!leave?.stopPrefilled,
        toId: t.id,
      });
      await board_(state, t.id, { isNew: true });
    }
  });
}

/**
 * Move the locomotive to `toId`, recording the departure and optionally leaving
 * a visible Stop when stopText is meaningful. This is the signature interaction.
 *
 * @param {string|null} toId  target track, or null for the depot
 * @param {string} stopText   where to pick the *departing* track back up
 * @param {string} reason     LEFT.*
 */
export async function switchTo({ toId, stopText = '', reason = LEFT.SWITCHING, stopPrefilled = false }) {
  return update(async (state) => {
    // Check the destination against *this* freshly-read state before leaving.
    // A panel can hold a stale track list (a second window may have arrived or
    // deleted the target while its switch sheet was open); leaving first and
    // discovering the target is gone second would park the current track and
    // strand the locomotive pointing at it.
    if (toId && !boardable(state, toId)) return;
    await leave_(state, { stopText, reason, stopPrefilled, toId });
    if (toId) await board_(state, toId, {});
    else {
      state.locomotive = { trackId: null, sinceAt: Date.now() };
    }
  });
}

/** A track can be boarded only if it exists, is live, and hasn't arrived. */
function boardable(state, id) {
  const t = state.tracks[id];
  return !!t && t.status !== STATUS.ARRIVED && state.order.includes(id);
}

/** Leave the current track without boarding another. The locomotive goes to the depot. */
export async function park({ stopText = '', reason = LEFT.SWITCHING, stopPrefilled = false }) {
  return switchTo({ toId: null, stopText, reason, stopPrefilled });
}

/** Resume is a switch whose *destination* is the interesting half. */
export async function resume({
  toId,
  stopText = '',
  reason = LEFT.SWITCHING,
  stopPrefilled = false,
  resumeEventId = null,
}) {
  return update(async (state) => {
    if (!boardable(state, toId)) return;
    const target = state.tracks[toId];
    const away = target.leftAt ? Date.now() - target.leftAt : null;
    const wasStatus = target.status;

    await leave_(state, { stopText, reason, stopPrefilled, toId });
    await board_(state, toId, { resumeEventId });

    await logEvent(EV.TRACK_RESUMED, {
      id: toId,
      msParked: away, // park → resume latency (spec §23)
      fromStatus: wasStatus,
      hadStop: !!target.currentStop,
    });
  });
}

async function leave_(state, { stopText, reason, stopPrefilled, toId = null }) {
  const cur = activeTrack(state);
  if (!cur) return;
  const at = Date.now();
  const ride = settleTime(state, at);

  const text = String(stopText || '').trim();
  cur.currentStop = text;

  const nextStatus = statusFromReason(reason);
  const previousStatus = cur.status;
  cur.status = nextStatus;
  cur.leftBecause = reason;
  cur.leftAt = at;
  cur.readyAt = null;
  touch(cur);

  addTrackEvent(
    cur,
    toId ? 'switch' : 'park',
    {
      reason,
      toId,
      toName: trackName(state, toId),
      rideDurationMs: ride?.durationMs || 0,
    },
    at
  );
  // A Stop is the current re-entry point, not an archive. Departures remain in
  // history, but a new Stop replaces the previous one.
  cur.events = (cur.events || []).filter((event) => event.type !== 'stop');
  if (text) addTrackEvent(cur, 'stop', { text, reason }, at);
  if (previousStatus !== nextStatus) addTrackEvent(cur, 'status', { from: previousStatus, to: nextStatus }, at);

  await logEvent(EV.TRACK_PARKED, {
    id: cur.id,
    reason,
    hasStop: !!cur.currentStop,
    // If the prefilled stop was accepted unchanged, return-point entry cost
    // nothing. If it was always edited, the prefill isn't earning its place.
    stopPrefilled: !!stopPrefilled,
    msOnTrack: cur.msOnTrack,
  });
  if (stopPrefilled) await logEvent(EV.STOP_ACCEPTED, { id: cur.id });
}

async function board_(state, id, { stopText = '', isNew = false, resumeEventId = null } = {}) {
  // Arrived tracks stay in `state.tracks` for history, so an existence check is
  // not enough — a stale UI row could otherwise board a track that has left the
  // yard, producing an active track with no rail to draw it on.
  if (!boardable(state, id)) return;
  const t = state.tracks[id];
  const from = state.locomotive?.trackId || null;
  const at = Date.now();
  const wasVisited = !!t.lastActiveAt;
  const previousStatus = t.status;
  const timelinePoint = resumeEventId
    ? (t.events || []).find((event) => event.id === resumeEventId && (event.type === 'stop' || event.type === 'note'))
    : wasVisited
      ? [...(t.events || [])].reverse().find((event) => event.type === 'stop')
      : null;

  t.status = STATUS.ACTIVE;
  t.leftBecause = null;
  t.lastActiveAt = at;
  t.readyAt = null;
  if (timelinePoint?.text) t.currentStop = String(timelinePoint.text).trim();
  else if (stopText) t.currentStop = String(stopText).trim();
  if (t.timebox && !t.timebox.paused && (t.timebox.elapsedMs || 0) < t.timebox.durationMs) t.timebox.runningSince = at;
  touch(t);

  state.locomotive = { trackId: id, sinceAt: at };

  if (!isNew) {
    addTrackEvent(
      t,
      wasVisited ? 'resume' : 'started',
      { fromId: from, fromName: trackName(state, from), previousStatus },
      at
    );
  }
  if (previousStatus !== STATUS.ACTIVE) addTrackEvent(t, 'status', { from: previousStatus, to: STATUS.ACTIVE }, at);

  // Deliberately NOT reordering on board. Recency ordering would reshuffle the
  // yard on every switch, and spatial memory ("PMO is the third rail down") is
  // worth more than sorting. Tracks stay where they were laid.

  await logEvent(EV.TRACK_SWITCHED, { from, to: id, isNew });
}

/**
 * Mark a track ready. In V1 this is manual, and honestly it should be: nothing
 * in the browser knows that your coworker replied or that Claude finished. The
 * user is the sensor. What the product does is remember it for them.
 */
export async function markReady(id) {
  return update(async (state) => {
    const t = state.tracks[id];
    if (!t || t.status === STATUS.ACTIVE || t.status === STATUS.ARRIVED) return;
    const at = Date.now();
    const previousStatus = t.status;
    t.status = STATUS.READY;
    t.readyAt = at;
    touch(t);
    addTrackEvent(t, 'status', { from: previousStatus, to: STATUS.READY }, at);
    await logEvent(EV.TRACK_READY, {
      id,
      // How long the blocker actually lasted.
      msBlocked: t.leftAt ? Date.now() - t.leftAt : null,
      fromReason: t.leftBecause,
    });
  });
}

/** Cycle every signal through neutral → waiting → ready, independent of which
 * track currently carries the locomotive. */
export async function cycleSignal(id) {
  return update(async (state) => {
    const t = state.tracks[id];
    if (!t || t.status === STATUS.ARRIVED) return;
    const current = t.signalState || SIGNAL.IDLE;
    const next = current === SIGNAL.IDLE ? SIGNAL.WAITING : current === SIGNAL.WAITING ? SIGNAL.READY : SIGNAL.IDLE;
    t.signalState = next;
    if (t.status !== STATUS.ACTIVE) {
      t.status = next === SIGNAL.WAITING ? STATUS.WAITING : next === SIGNAL.READY ? STATUS.READY : STATUS.PARKED;
      t.readyAt = next === SIGNAL.READY ? Date.now() : null;
    }
    touch(t);
    addTrackEvent(t, 'signal', { from: current, to: next });
  });
}

/** Undo a ready mark — back to whatever leaving reason it had. */
export async function unmarkReady(id) {
  return update(async (state) => {
    const t = state.tracks[id];
    if (!t || t.status !== STATUS.READY) return;
    const at = Date.now();
    const nextStatus = statusFromReason(t.leftBecause || LEFT.SWITCHING);
    t.status = nextStatus;
    t.readyAt = null;
    touch(t);
    addTrackEvent(t, 'status', { from: STATUS.READY, to: nextStatus }, at);
  });
}

/** The train of thought is complete. It leaves the yard. */
export async function arrive(id) {
  return update(async (state) => {
    const t = state.tracks[id];
    // Idempotent: the arrived button stays live through its ~1s departure
    // animation, and a double click would otherwise push the id into history
    // twice — which eventually deletes the track object out from under the
    // surviving copy when the 100-entry cap trims it.
    if (!t || t.status === STATUS.ARRIVED) return;
    if (state.order.some((trackId) => state.tracks[trackId]?.parentId === id)) return;
    const at = Date.now();
    if (state.locomotive?.trackId === id) {
      settleTime(state, at);
      state.locomotive = { trackId: null, sinceAt: at };
    }
    const previousStatus = t.status;
    t.status = STATUS.ARRIVED;
    t.arrivedAt = at;
    touch(t);
    addTrackEvent(t, 'status', { from: previousStatus, to: STATUS.ARRIVED }, at);
    addTrackEvent(t, 'arrived', { totalActiveMs: t.msOnTrack, startedAt: t.createdAt }, at);

    state.order = state.order.filter((x) => x !== id);
    state.history.unshift(id);
    if (state.history.length > 100) {
      const drop = state.history.splice(100);
      for (const d of drop) delete state.tracks[d];
    }

    await logEvent(EV.TRACK_ARRIVED, {
      id,
      msAlive: at - t.createdAt,
      msOnTrack: t.msOnTrack,
      wasResumed: !!t.leftAt, // % of resumed tracks that eventually complete
    });
  });
}

/** Undo an arrival. Exists because "arrived" is the one irreversible-feeling
 *  action in the product, and it should not be. */
export async function unarrive(id) {
  return update(async (state) => {
    const t = state.tracks[id];
    if (!t || t.status !== STATUS.ARRIVED) return;
    const at = Date.now();
    const nextStatus = statusFromReason(t.leftBecause || LEFT.SWITCHING);
    t.status = nextStatus;
    t.arrivedAt = null;
    touch(t);
    addTrackEvent(t, 'reopened', { from: STATUS.ARRIVED, to: nextStatus }, at);
    state.history = state.history.filter((x) => x !== id);
    if (!state.order.includes(id)) state.order.push(id);
  });
}

export async function setStop(id, text) {
  return update(async (state) => {
    const t = state.tracks[id];
    if (!t) return;
    const next = String(text || '').trim();
    if (next === t.currentStop) return;
    t.currentStop = next;
    t.events = (t.events || []).filter((event) => event.type !== 'stop');
    if (next) addTrackEvent(t, 'stop', { text: next, reason: t.leftBecause || null });
    touch(t);
    await logEvent(EV.STOP_EDITED, { id, len: next.length, inline: true });
  });
}

export async function editTrack(id, { name, destination }) {
  return update(async (state) => {
    const t = state.tracks[id];
    if (!t) return;
    if (typeof name === 'string' && name.trim() && name.trim() !== t.name) {
      const previousName = t.name;
      t.name = name.trim();
      addTrackEvent(t, 'renamed', { from: previousName, to: t.name });
    }
    if (typeof destination === 'string') t.destination = destination.trim();
    touch(t);
  });
}

/** Remove without ceremony. Not "arrived" — this is "that was a mistake". */
export async function removeTrack(id) {
  return update(async (state) => {
    if (state.order.some((trackId) => state.tracks[trackId]?.parentId === id)) return;
    if (state.locomotive?.trackId === id) state.locomotive = { trackId: null, sinceAt: Date.now() };
    delete state.tracks[id];
    state.order = state.order.filter((x) => x !== id);
    state.history = state.history.filter((x) => x !== id);
  });
}

export async function restoreTrack({ track, orderIndex = 0, historyIndex = -1 }) {
  return update(async (state) => {
    if (!track?.id || state.tracks[track.id]) return;
    state.tracks[track.id] = track;
    if (track.status === STATUS.ARRIVED) {
      const index = Math.max(0, Math.min(historyIndex < 0 ? state.history.length : historyIndex, state.history.length));
      state.history.splice(index, 0, track.id);
    } else {
      const index = Math.max(0, Math.min(orderIndex, state.order.length));
      state.order.splice(index, 0, track.id);
    }
  });
}

export async function addNote(id, text) {
  return update(async (state) => {
    const t = state.tracks[id];
    const value = String(text || '').trim().slice(0, 180);
    if (!t || t.status === STATUS.ARRIVED || !value) return;
    addTrackEvent(t, 'note', { text: value, resolvedAt: null });
    touch(t);
  });
}

export async function setNoteResolved(id, eventId, resolved = true) {
  return update(async (state) => {
    const t = state.tracks[id];
    const event = (t?.events || []).find((item) => item.id === eventId && item.type === 'note');
    if (!t || !event) return;
    if (resolved) t.events = t.events.filter((item) => item.id !== eventId);
    touch(t);
  });
}

export async function continueOnTrack(id, eventId) {
  return update(async (state) => {
    const t = state.tracks[id];
    const event = (t?.events || []).find(
      (item) => item.id === eventId && (item.type === 'stop' || item.type === 'note')
    );
    if (!t || !event || !event.text) return;
    const at = Date.now();
    t.currentStop = String(event.text).trim();
    t.events = (t.events || []).filter((item) => item.type !== 'stop');
    addTrackEvent(t, 'stop', { text: t.currentStop, reason: 'continued' }, at);
    addTrackEvent(t, 'continued', { fromEventId: event.id, fromType: event.type }, at);
    touch(t);
  });
}

export async function reorder(ids) {
  return update(async (state) => {
    const known = new Set(state.order);
    const requested = ids.filter((id, index) => known.has(id) && ids.indexOf(id) === index);
    for (const id of state.order) if (!requested.includes(id)) requested.push(id);
    const roots = requested.filter((id) => !state.tracks[id]?.parentId);
    const next = [];
    for (const rootId of roots) {
      next.push(rootId);
      next.push(...requested.filter((id) => state.tracks[id]?.parentId === rootId));
    }
    state.order = next;
  });
}

export async function setTimebox(id, durationMinutes) {
  return update(async (state) => {
    const t = state.tracks[id];
    if (!t || t.status === STATUS.ARRIVED) return;
    const durationMs = Math.max(1, Number(durationMinutes) || 25) * 60_000;
    t.timebox = {
      durationMs,
      elapsedMs: 0,
      runningSince: state.locomotive?.trackId === id ? Date.now() : null,
      paused: false,
    };
    touch(t);
  });
}

export async function toggleTimebox(id) {
  return update(async (state) => {
    const t = state.tracks[id];
    if (!t?.timebox) return;
    if (t.timebox.runningSince) {
      settleTimebox(t);
      t.timebox.paused = true;
    }
    else if (state.locomotive?.trackId === id && (t.timebox.elapsedMs || 0) < t.timebox.durationMs) {
      t.timebox.runningSince = Date.now();
      t.timebox.paused = false;
    }
    touch(t);
  });
}

export async function clearTimebox(id) {
  return update(async (state) => {
    const t = state.tracks[id];
    if (!t) return;
    t.timebox = null;
    touch(t);
  });
}

export async function createBranch(parentId, { name, destination = '' }) {
  const branchName = String(name || '').trim();
  if (!branchName) return;
  return update(async (state) => {
    const parent = state.tracks[parentId];
    if (
      !parent ||
      parent.parentId ||
      parent.status === STATUS.ARRIVED ||
      state.locomotive?.trackId !== parentId ||
      !state.order.includes(parentId) ||
      state.order.length >= 10
    )
      return;
    const branch = newTrack({ name: branchName, destination, parentId });
    state.tracks[branch.id] = branch;
    let index = state.order.indexOf(parentId) + 1;
    while (index < state.order.length && state.tracks[state.order[index]]?.parentId === parentId) index += 1;
    state.order.splice(index, 0, branch.id);
    await leave_(state, {
      stopText: state.locomotive?.trackId === parentId ? parent.currentStop || '' : '',
      reason: LEFT.SWITCHING,
      stopPrefilled: false,
      toId: branch.id,
    });
    await board_(state, branch.id, { isNew: true });
    addTrackEvent(branch, 'branch_created', { parentId, parentName: parent.name });
    await logEvent(EV.TRACK_CREATED, { id: branch.id, hasDestination: !!branch.destination, ordinal: state.order.length, branch: true });
  });
}

export async function resolveBranch(id) {
  return update(async (state) => {
    const branch = state.tracks[id];
    const parent = branch?.parentId ? state.tracks[branch.parentId] : null;
    if (!branch || !parent || branch.status === STATUS.ARRIVED) return;
    const at = Date.now();
    const wasActive = state.locomotive?.trackId === id;
    if (wasActive) settleTime(state, at);
    branch.status = STATUS.ARRIVED;
    branch.arrivedAt = at;
    branch.resolvedAt = at;
    addTrackEvent(branch, 'branch_resolved', { parentId: parent.id, parentName: parent.name }, at);
    state.order = state.order.filter((trackId) => trackId !== id);
    if (!state.history.includes(id)) state.history.unshift(id);
    if (wasActive) {
      state.locomotive = { trackId: null, sinceAt: at };
      await board_(state, parent.id, {});
      addTrackEvent(parent, 'branch_returned', { branchId: id, branchName: branch.name }, at);
    }
  });
}

export async function setSetting(key, value) {
  return update(async (state) => {
    state.settings[key] = value;
    if (key === 'observe' && value === false) await logEvent(EV.OBSERVE_DISABLED, {});
  });
}

export async function markOnboarded() {
  return update(async (state) => {
    if (!state.onboardedAt) state.onboardedAt = Date.now();
  });
}
