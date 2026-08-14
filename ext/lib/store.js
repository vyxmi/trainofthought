/**
 * store.js — the single source of truth.
 *
 * Everything lives in chrome.storage.local. The side panel does not message the
 * service worker and the service worker does not message the panel; both read and
 * write storage, and both listen to chrome.storage.onChanged. That means there is
 * exactly one place state can come from, and the panel can always rebuild itself
 * from disk after Chrome evicts the service worker (which it will, constantly).
 *
 * Three keys, deliberately separated so that noisy writes never wake the UI:
 *   ty        — durable state the panel renders (tracks, locomotive, settings)
 *   ty_obs    — passive context observation buffer (written often, panel ignores)
 *   ty_events — local analytics ring buffer (append-only, capped, never leaves disk)
 */

export const SCHEMA_VERSION = 1;

export const K_STATE = 'ty';
export const K_OBS = 'ty_obs';
export const K_EVENTS = 'ty_events';

const EVENT_CAP = 3000;

/** A track's status. Intentionally small — see product spec §9. */
export const STATUS = {
  ACTIVE: 'active',
  PARKED: 'parked',
  WAITING: 'waiting',
  AI: 'ai_working',
  READY: 'ready',
  ARRIVED: 'arrived',
};

/**
 * Why the locomotive left a track. This is metadata, not status — it drives the
 * label and the signal aspect without inflating the state machine.
 */
export const LEFT = {
  SWITCHING: 'switching',
  BLOCKED: 'blocked',
  WAITING: 'waiting',
  AI: 'ai',
};

/** Human words. No productivity jargon (spec §10). */
export const LEFT_LABEL = {
  [LEFT.SWITCHING]: 'just switching',
  [LEFT.BLOCKED]: 'hit a stop',
  [LEFT.WAITING]: 'waiting',
  [LEFT.AI]: 'AI working',
};

export const STATUS_LABEL = {
  [STATUS.ACTIVE]: 'on track',
  [STATUS.PARKED]: 'parked',
  [STATUS.WAITING]: 'waiting',
  [STATUS.AI]: 'AI working',
  [STATUS.READY]: 'ready',
  [STATUS.ARRIVED]: 'arrived',
};

export function uid() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function defaultState() {
  const t = Date.now();
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: t,
    /** The one locomotive. trackId === null means it is in the depot: attention
     *  is not on any tracked work. This state only exists because there is one
     *  locomotive, and it turns out to be genuinely useful. */
    locomotive: { trackId: null, sinceAt: t },
    tracks: {},
    /** Display order of live track ids, top to bottom. */
    order: [],
    /** Arrived tracks, most recent first. Lightweight history, not an archive. */
    history: [],
    settings: {
      observe: true,
      motion: 'auto', // 'auto' respects prefers-reduced-motion | 'full' | 'off'
      restoreTabs: 'ask', // 'ask' | 'never'
    },
    onboardedAt: null,
  };
}

export function newTrack({ name, destination = '' }) {
  const t = Date.now();
  return {
    id: uid(),
    name: String(name || '').trim(),
    /** Optional. The stable goal. Never required. */
    destination: String(destination || '').trim(),
    /** The moving cursor AND the re-entry cue. There is no separate returnPoint —
     *  where you are is where you'll pick up. One field, one truth. */
    currentStop: '',
    status: STATUS.PARKED,
    leftBecause: null,
    createdAt: t,
    updatedAt: t,
    lastActiveAt: null,
    /** When the locomotive last left this track. Drives park→resume analytics. */
    leftAt: null,
    readyAt: null,
    arrivedAt: null,
    /** NOTE: learned domain associations deliberately do NOT live here. They are
     *  written by the service worker every minute, and a worker write of the
     *  whole `ty` blob would clobber whatever the panel was mid-way through
     *  writing. They live in `ty_obs`, which only the worker writes. */
    /** Explicit tab snapshot, captured only at the moment of leaving. */
    snapshot: null,
    /** Cumulative ms the locomotive has spent on this track. */
    msOnTrack: 0,
  };
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

export async function readState() {
  const got = await chrome.storage.local.get(K_STATE);
  const raw = got[K_STATE];
  if (!raw) return defaultState();
  return migrate(raw);
}

function migrate(s) {
  // v0 → v1: earlier prototypes used `trains` and a separate `returnPoint`.
  // Fold returnPoint into currentStop; where both existed the return point wins,
  // because it was written later (at the moment of leaving).
  if (!s.schemaVersion || s.schemaVersion < 1) {
    const tracks = s.tracks || s.trains || {};
    for (const t of Object.values(tracks)) {
      if (t.returnPoint && !t.currentStop) t.currentStop = t.returnPoint;
      else if (t.returnPoint) t.currentStop = t.returnPoint;
      delete t.returnPoint;
      if (t.associatedContexts && !t.contexts) {
        t.contexts = t.associatedContexts;
        delete t.associatedContexts;
      }
    }
    s.tracks = tracks;
    delete s.trains;
    if (!s.locomotive) {
      const activeId = Object.values(tracks).find((t) => t.status === STATUS.ACTIVE)?.id || null;
      s.locomotive = { trackId: activeId, sinceAt: Date.now() };
    }
    s.schemaVersion = 1;
  }
  // Fill any gaps introduced by partial writes.
  return { ...defaultState(), ...s, settings: { ...defaultState().settings, ...(s.settings || {}) } };
}

let writeChain = Promise.resolve();

/**
 * Serialised read-modify-write for durable state.
 *
 * IMPORTANT: this chain is per-JavaScript-realm. The side panel and the service
 * worker each load their own copy of this module and therefore have their own
 * `writeChain`. It prevents lost updates *within* a realm; it cannot prevent
 * them *across* realms, because each writer sets the whole `ty` blob.
 *
 * The way that risk is actually eliminated is by ownership, not locking: the
 * service worker never writes `ty` at all. Everything it produces goes to
 * `ty_obs`, which nothing else writes. `ty` has exactly one writer — the panel —
 * so a cross-realm race cannot arise. If a future feature makes the worker
 * mutate a track, this comment stops being true and the lock has to become real.
 *
 * @param {(state: object) => (void|Promise<void>)} mutate
 * @returns {Promise<object>} the state after mutation
 */
export function update(mutate) {
  const next = writeChain.then(async () => {
    const state = await readState();
    await mutate(state);
    state.schemaVersion = SCHEMA_VERSION;
    await chrome.storage.local.set({ [K_STATE]: state });
    return state;
  });
  // Keep the chain alive even if one mutation throws.
  writeChain = next.catch(() => {});
  return next;
}

// ---------------------------------------------------------------------------
// Observation store — service-worker owned
// ---------------------------------------------------------------------------

let obsChain = Promise.resolve();

export function defaultObs() {
  return { byTrack: {}, absences: [] };
}

export async function readObs() {
  const got = await chrome.storage.local.get(K_OBS);
  return { ...defaultObs(), ...(got[K_OBS] || {}) };
}

export function updateObs(mutate) {
  const next = obsChain.then(async () => {
    const obs = await readObs();
    await mutate(obs);
    await chrome.storage.local.set({ [K_OBS]: obs });
    return obs;
  });
  obsChain = next.catch(() => {});
  return next;
}

export async function writeState(state) {
  await chrome.storage.local.set({ [K_STATE]: state });
}

/** Subscribe to durable state changes only. Observation writes are filtered out. */
export function subscribe(cb) {
  const handler = (changes, area) => {
    if (area !== 'local' || !changes[K_STATE]) return;
    cb(migrate(changes[K_STATE].newValue || defaultState()), changes[K_STATE].oldValue);
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

// ---------------------------------------------------------------------------
// Local analytics (spec §23)
// ---------------------------------------------------------------------------
//
// These never leave the machine. There is no backend and no network permission.
// The point is that *you* can read them to find out whether the core loop works.
// Deliberately absent: hours focused, task counts, streaks, anything scoreable.

export const EV = {
  TRACK_CREATED: 'track_created',
  TRACK_SWITCHED: 'track_switched',
  TRACK_PARKED: 'track_parked',
  TRACK_RESUMED: 'track_resumed',
  TRACK_ARRIVED: 'track_arrived',
  TRACK_READY: 'track_ready',
  STOP_EDITED: 'stop_edited',
  STOP_ACCEPTED: 'stop_accepted', // prefilled stop accepted unchanged — friction signal
  TABS_RESTORED: 'tabs_restored',
  PANEL_OPENED: 'panel_opened',
  OBSERVE_DISABLED: 'observe_disabled',
};

let eventChain = Promise.resolve();

export function logEvent(type, props = {}) {
  // Chained for the same reason as update(): an unserialised read-modify-write
  // drops events whenever two land in the same tick, which is most of them —
  // leave_() and board_() log back to back on every switch.
  const next = eventChain.then(async () => {
    try {
      const got = await chrome.storage.local.get(K_EVENTS);
      const list = got[K_EVENTS] || [];
      list.push({ t: Date.now(), type, ...props });
      if (list.length > EVENT_CAP) list.splice(0, list.length - EVENT_CAP);
      await chrome.storage.local.set({ [K_EVENTS]: list });
    } catch {
      /* analytics must never break the product */
    }
  });
  eventChain = next.catch(() => {});
  return next;
}

export async function readEvents() {
  const got = await chrome.storage.local.get(K_EVENTS);
  return got[K_EVENTS] || [];
}

export async function clearAll() {
  await chrome.storage.local.clear();
}
