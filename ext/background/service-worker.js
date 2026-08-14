/**
 * service-worker.js — the quiet half.
 *
 * This file does three things and deliberately not a fourth:
 *   1. wires the side panel to the toolbar action and keyboard commands
 *   2. observes browser context passively and learns domain associations
 *   3. flushes that observation to storage on a timer
 *
 * The fourth thing it does not do is *ask the user anything*. There is no junction
 * detection in this build. The observation below is instrumentation for a feature
 * that has not been earned yet: until the core park→resume loop is proven useful,
 * a prompt that fires at the wrong moment can only subtract. Everything needed to
 * build junction detection later is being recorded now; nothing acts on it.
 *
 * Privacy posture (spec §20): the extension has no host permissions and no content
 * scripts. It cannot read page contents. It stores hostnames — never full URLs,
 * never page titles — for association learning. Full URLs are written exactly once,
 * into an explicit snapshot, at the moment you deliberately leave a track.
 */

import { readState, updateObs } from '../lib/store.js';

const FLUSH_ALARM = 'ty-flush';
const FLUSH_EVERY_MIN = 1;

/** Hostnames we never record — these are not "context", they're plumbing. */
const IGNORED_SCHEMES = ['chrome:', 'chrome-extension:', 'edge:', 'about:', 'devtools:', 'file:', 'view-source:'];

/** In-memory buffer. The service worker dies constantly; this is best-effort by
 *  design, and losing a minute of association hits costs nothing. */
let pending = new Map(); // domain -> hits
let pendingTrackId = null;
let lastDomain = null;
let awaySince = null;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (e) {
    console.warn('[trainyard] setPanelBehavior unavailable', e);
  }
  chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: FLUSH_EVERY_MIN });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: FLUSH_EVERY_MIN });
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === FLUSH_ALARM) flush();
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

chrome.commands.onCommand.addListener((command, tab) => {
  // sidePanel.open() must be called while the user-gesture scope from this
  // dispatch is still live. Any `await` before it — even a storage write —
  // releases that scope and the call rejects with "may only be called in
  // response to a user gesture". So: open first, synchronously, then write the
  // intent. The panel picks the intent up either at boot or via its session
  // storage listener, so the ordering doesn't matter to it.
  if (tab?.windowId !== undefined) {
    try {
      chrome.sidePanel.open({ windowId: tab.windowId });
    } catch (e) {
      console.warn('[trainyard] sidePanel.open failed', e);
    }
  }

  if (command === 'quick-switch') setIntent({ open: 'switch' });
  if (command === 'quick-park') setIntent({ open: 'park' });
});

/** Intents live in session storage: they are a nudge for this browser session
 *  only, and must never survive a restart and surprise someone. */
function setIntent(intent) {
  try {
    return chrome.storage.session.set({ ty_intent: { ...intent, at: Date.now() } });
  } catch {
    /* session storage unavailable in some contexts; the panel copes */
  }
}

// ---------------------------------------------------------------------------
// Passive observation
// ---------------------------------------------------------------------------

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    note(tab?.url);
  } catch {
    /* tab vanished mid-flight */
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Only top-level navigations of the focused tab are meaningful signal. Firing
  // on every subresource load would bury the actual context change in noise.
  if (!changeInfo.url || !tab.active) return;
  note(changeInfo.url);
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // Chrome lost focus. We genuinely do not know what happens next (spec §15).
    // Record the boundary, assume nothing, say nothing.
    awaySince = Date.now();
    flush();
    return;
  }
  if (awaySince) {
    const ms = Date.now() - awaySince;
    awaySince = null;
    recordAbsence(ms);
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    note(tab?.url);
  } catch {
    /* no-op */
  }
});

function domainOf(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (IGNORED_SCHEMES.includes(u.protocol)) return null;
    return u.hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

async function note(url) {
  const domain = domainOf(url);
  if (!domain) return;
  if (domain === lastDomain) return; // dwell, not a switch
  lastDomain = domain;

  const state = await readState();
  if (!state.settings?.observe) return;
  const trackId = state.locomotive?.trackId;
  if (!trackId) return; // locomotive is in the depot; nothing to associate with

  if (pendingTrackId && pendingTrackId !== trackId) await flush();
  pendingTrackId = trackId;
  pending.set(domain, (pending.get(domain) || 0) + 1);

  if (pending.size >= 12) flush();
}

/**
 * Fold the in-memory hits into the observation store.
 *
 * This writes `ty_obs` and never `ty`. That separation is load-bearing: this
 * function fires on a one-minute alarm, and if it wrote the durable state blob
 * it would periodically read a snapshot, hold it across three awaits, and write
 * it back over whatever switch the user made in between — silently undoing a
 * user action. Different key, different owner, no race.
 */
async function flush() {
  if (!pending.size || !pendingTrackId) return;
  const hits = pending;
  const trackId = pendingTrackId;
  pending = new Map();
  pendingTrackId = null;

  const state = await readState();

  await updateObs(async (obs) => {
    const now = Date.now();
    const byDomain = new Map((obs.byTrack[trackId] || []).map((c) => [c.domain, c]));
    for (const [domain, n] of hits) {
      const existing = byDomain.get(domain);
      if (existing) {
        existing.hits += n;
        existing.lastSeen = now;
      } else {
        byDomain.set(domain, { domain, hits: n, lastSeen: now });
      }
    }
    // Keep the strongest 24 associations. Confidence is share-of-hits, computed
    // on read rather than stored, so it can never drift out of sync.
    obs.byTrack[trackId] = [...byDomain.values()].sort((a, b) => b.hits - a.hits).slice(0, 24);

    // Drop associations for tracks that no longer exist, so deleting a track
    // really does delete what was learned about it.
    for (const id of Object.keys(obs.byTrack)) {
      if (!state.tracks[id]) delete obs.byTrack[id];
    }
  });
}

/** Absences are recorded but never surfaced. See the note at the top of the file. */
async function recordAbsence(ms) {
  if (ms < 60_000) return; // short absences are not events
  await updateObs(async (obs) => {
    obs.absences = (obs.absences || []).slice(-199);
    obs.absences.push({ t: Date.now(), ms });
  });
}

// Flush whatever we have if the worker is about to be torn down.
chrome.runtime.onSuspend?.addListener?.(() => {
  flush();
});
