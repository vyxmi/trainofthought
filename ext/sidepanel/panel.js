/**
 * panel.js — the side panel.
 *
 * Architecture note: this file never messages the service worker. It reads and
 * writes chrome.storage.local directly and re-renders from storage.onChanged.
 * Rendering is a pure function of state plus a diff against the previous state,
 * and the diff exists only to decide which of the four motions to play. That
 * means the panel is correct after a reload, after the worker is evicted, and
 * after a second window opens the panel — all of which happen constantly.
 */

import {
  STATUS,
  LEFT,
  EV,
  readState,
  readObs,
  subscribe,
  logEvent,
  readEvents,
  clearAll,
} from '../lib/store.js';
import * as T from '../lib/tracks.js';
import { computeLayout, buildYard, syncAspects, aspectFor } from '../lib/railway.js';
import { Motion } from '../lib/motion.js';
import { engineName } from '../lib/anim.js';

const $ = (id) => document.getElementById(id);
const svgEl = $('rail');
const yardEl = $('yard');
const labelsEl = $('labels');
const nowEl = $('now');
const sheetEl = $('sheet');
const scrimEl = $('scrim');
const toastEl = $('toast');

let state = null;
let layout = null;
let handles = null;
let shapeKey = '';
let editingStop = false;
let skipNextAnim = false;
let toastTimer = 0;

const motion = new Motion(svgEl);

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function statusWord(t) {
  if (!t) return '';
  switch (t.status) {
    case STATUS.ACTIVE:
      return 'on track';
    case STATUS.READY:
      return 'ready';
    case STATUS.WAITING:
      return 'waiting';
    case STATUS.AI:
      return 'AI working';
    case STATUS.PARKED:
      return t.leftBecause === LEFT.BLOCKED ? 'stopped' : 'parked';
    default:
      return '';
  }
}

function stateClass(t) {
  if (t.status === STATUS.READY) return 'is-ready';
  if (t.status === STATUS.WAITING) return 'is-waiting';
  if (t.status === STATUS.AI) return 'is-ai';
  if (t.status === STATUS.PARKED && t.leftBecause === LEFT.BLOCKED) return 'is-blocked';
  return '';
}

function ago(ms) {
  if (!ms && ms !== 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Tab snapshots are the one place full URLs are written, and only on purpose. */
async function captureSnapshot() {
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const keep = tabs
      .filter((t) => t.url && /^https?:/.test(t.url))
      .slice(0, 12)
      .map((t) => ({ url: t.url, title: (t.title || '').slice(0, 120), active: !!t.active, pinned: !!t.pinned }));
    return keep.length ? { takenAt: Date.now(), tabs: keep } : null;
  } catch {
    return null;
  }
}

function toast(message, actionLabel, onAction) {
  clearTimeout(toastTimer);
  toastEl.replaceChildren();
  const span = document.createElement('span');
  span.textContent = message;
  toastEl.appendChild(span);
  if (actionLabel) {
    const b = document.createElement('button');
    b.textContent = actionLabel;
    b.onclick = () => {
      hideToast();
      onAction?.();
    };
    toastEl.appendChild(b);
  }
  toastEl.hidden = false;
  toastTimer = setTimeout(hideToast, 7000);
}

function hideToast() {
  toastEl.hidden = true;
  clearTimeout(toastTimer);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

async function render(next, { animate = true } = {}) {
  const before = state;
  state = next;
  motion.setMode(next.settings?.motion || 'auto');

  const ids = next.order.filter((id) => next.tracks[id]);
  const width = yardEl.clientWidth || 340;
  const key = `${width}|${ids.join(',')}`;
  const rebuilt = key !== shapeKey;

  if (rebuilt) {
    layout = computeLayout(width, ids);
    handles = buildYard(svgEl, layout, next.tracks);
    motion.attach(layout, handles);
    shapeKey = key;
  }

  syncAspects(handles, layout, next);
  renderLabels(next);
  if (!editingStop) renderNow(next);

  const consumed = skipNextAnim;
  skipNextAnim = false;
  await animateDiff(before, next, rebuilt, animate && !consumed);
}

function renderLabels(s) {
  labelsEl.replaceChildren();
  labelsEl.style.height = `${layout.height}px`;
  const activeId = s.locomotive?.trackId || null;

  for (const slot of layout.tracks) {
    const t = s.tracks[slot.id];
    if (!t) continue;
    const b = document.createElement('button');
    b.className = ['lbl', t.id === activeId ? 'is-active' : '', stateClass(t)].filter(Boolean).join(' ');
    b.dataset.id = t.id;
    b.style.left = `${slot.labelX}px`;
    b.style.top = `${slot.labelY}px`;
    b.style.width = `${Math.max(90, layout.width - slot.labelX - 36)}px`;
    const stop = t.currentStop || (t.id === activeId ? 'no stop noted' : 'nothing noted');
    b.innerHTML =
      `<span class="lbl-head"><span class="lbl-name">${esc(t.name)}</span>` +
      `<span class="lbl-status">${esc(statusWord(t))}</span></span>` +
      `<span class="lbl-stop">${esc(stop)}</span>`;
    b.title = t.id === activeId ? `${t.name} — the locomotive is here` : `Resume ${t.name}`;
    labelsEl.appendChild(b);
  }

  const d = document.createElement('div');
  d.className = 'depot-label';
  d.style.left = `${layout.depot.labelX}px`;
  d.style.top = `${layout.depot.labelY}px`;
  d.textContent = 'shed';
  labelsEl.appendChild(d);
}

function renderNow(s) {
  const live = s.order.filter((id) => s.tracks[id]);

  if (!live.length) {
    nowEl.innerHTML = `
      <div class="empty">
        <h2>Lay your first track.</h2>
        <p>A track is one train of thought — a project, a thread, a thing you keep coming back to. There's one locomotive: your attention. It can only be in one place, which is the honest part.</p>
        <div class="empty-form">
          <div class="field">
            <label for="first-name">What are you working on?</label>
            <input type="text" id="first-name" placeholder="Portfolio" autocomplete="off" />
          </div>
          <div><button class="btn btn-primary" id="first-go">lay track</button></div>
        </div>
      </div>`;
    $('first-go').onclick = layFirst;
    $('first-name').onkeydown = (e) => {
      if (e.key === 'Enter') layFirst();
    };
    return;
  }

  const cur = T.activeTrack(s);

  if (!cur) {
    const ready = live.map((id) => s.tracks[id]).filter((t) => t.status === STATUS.READY);
    nowEl.innerHTML = `
      <div class="eyebrow">in the shed</div>
      <div class="now-name" style="font-size:15px;font-weight:560;color:var(--ink-2)">Your attention isn't on a track.</div>
      <div class="now-dest">${
        ready.length ? `${ready.length} ready to pick up — tap a track below` : 'Tap a track below to take the locomotive out'
      }</div>
      <div class="now-actions"><button class="btn" data-act="new">+ new track</button></div>`;
    wireNow();
    return;
  }

  const hasStop = !!cur.currentStop;
  const snap = cur.snapshot?.tabs?.length || 0;

  nowEl.innerHTML = `
    <div class="eyebrow">now</div>
    <h1 class="now-name">${esc(cur.name)}</h1>
    ${cur.destination ? `<div class="now-dest">→ ${esc(cur.destination)}</div>` : ''}
    <button class="now-stop ${hasStop ? '' : 'is-empty'}" id="stop-btn" title="Click to edit">${
      hasStop ? esc(cur.currentStop) : 'What are you doing right now?'
    }</button>
    ${
      snap
        ? `<div class="now-restore"><span>${snap} tab${snap === 1 ? '' : 's'} from when you left</span>
           <button class="btn btn-quiet" data-act="restore">restore</button></div>`
        : ''
    }
    <div class="now-actions">
      <button class="btn" data-act="switch">switch tracks</button>
      <button class="btn" data-act="park">park</button>
      <button class="btn btn-quiet" data-act="arrived">arrived</button>
    </div>`;
  wireNow();
}

function wireNow() {
  nowEl.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = () => {
      const act = b.dataset.act;
      if (act === 'switch') openSwitchSheet('switch');
      if (act === 'park') openSwitchSheet('park');
      if (act === 'arrived') doArrive();
      if (act === 'new') openSwitchSheet('switch', { jumpToNew: true });
      if (act === 'restore') doRestore();
    };
  });
  const sb = $('stop-btn');
  if (sb) sb.onclick = beginEditStop;
}

// ---------------------------------------------------------------------------
// Animation dispatch
// ---------------------------------------------------------------------------

async function animateDiff(before, next, rebuilt, allow) {
  const fromId = before?.locomotive?.trackId ?? null;
  const toId = next.locomotive?.trackId ?? null;

  if (!before || !allow) {
    motion.settle(toId);
    return;
  }

  const created = next.order.filter((id) => !before.order.includes(id));

  // 2. Lay a new track: the rail is built, then boarded.
  if (created.length && toId && created.includes(toId)) {
    motion.settle(fromId);
    await motion.layTrack(toId, fromId);
    return;
  }

  // 1 & 4. Switching or resuming.
  if (fromId !== toId) {
    motion.settle(fromId);
    const wasLeftBehind = toId ? !!before.tracks[toId]?.leftAt : false;
    if (wasLeftBehind) await motion.resumeTo(fromId, toId);
    else await motion.switchTracks(fromId, toId);
    return;
  }

  if (rebuilt) motion.settle(toId);
}

// ---------------------------------------------------------------------------
// Inline stop editing
// ---------------------------------------------------------------------------

function beginEditStop() {
  const cur = T.activeTrack(state);
  if (!cur) return;
  const btn = $('stop-btn');
  if (!btn) return;

  editingStop = true;
  const ta = document.createElement('textarea');
  ta.className = 'now-stop';
  ta.value = cur.currentStop || '';
  ta.rows = 1;
  ta.placeholder = 'Write results section';
  btn.replaceWith(ta);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  autosize(ta);
  ta.oninput = () => autosize(ta);

  const commit = async (save) => {
    if (!editingStop) return;
    editingStop = false;
    const val = ta.value;
    if (save) await T.setStop(cur.id, val);
    else renderNow(state);
    if (save && val.trim() === (cur.currentStop || '')) renderNow(state);
  };

  ta.onblur = () => commit(true);
  ta.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ta.blur();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      ta.onblur = null;
      commit(false);
    }
  };
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight}px`;
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

function openSheet(html, onMount) {
  sheetEl.innerHTML = html;
  sheetEl.hidden = false;
  scrimEl.hidden = false;
  sheetEl.querySelectorAll('[data-close]').forEach((b) => (b.onclick = closeSheet));
  onMount?.();
}

function closeSheet() {
  sheetEl.hidden = true;
  scrimEl.hidden = true;
  sheetEl.replaceChildren();
}

scrimEl.onclick = closeSheet;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !sheetEl.hidden) closeSheet();
});

/**
 * The signature flow. All three questions are on one sheet rather than in a
 * wizard: the stop is prefilled, the reason defaults to "just switching", so
 * picking a destination is a single click if you don't want to say more. The
 * steps are still visually separated, so it reads as three questions and
 * behaves as one.
 */
function openSwitchSheet(mode = 'switch', { jumpToNew = false } = {}) {
  const cur = T.activeTrack(state);
  const prefill = cur?.currentStop || '';
  const others = state.order.map((id) => state.tracks[id]).filter((t) => t && t.id !== cur?.id);

  const destRows = others
    .map(
      (t) => `
      <button class="dest" data-dest="${esc(t.id)}">
        <span class="dest-lamp aspect-${aspectFor(t)}"></span>
        <span class="dest-body">
          <span class="dest-name">${esc(t.name)}</span>
          <span class="dest-stop">${esc(t.currentStop || 'nothing noted')}</span>
        </span>
        <span class="dest-meta">${esc(statusWord(t))}</span>
      </button>`
    )
    .join('');

  openSheet(
    `
    ${
      cur
        ? `<div class="sheet-step">
             <h3>Where should we pick ${esc(cur.name)} back up?</h3>
             <textarea id="sw-stop" rows="2" placeholder="Test whether guest UID survives signup">${esc(prefill)}</textarea>
           </div>
           <div class="sheet-step">
             <h3>Why are you leaving?</h3>
             <div class="chips" id="sw-reasons">
               <button class="chip is-on" data-reason="${LEFT.SWITCHING}">just switching</button>
               <button class="chip" data-reason="${LEFT.BLOCKED}">hit a stop</button>
               <button class="chip" data-reason="${LEFT.WAITING}">waiting</button>
               <button class="chip" data-reason="${LEFT.AI}">AI working</button>
             </div>
           </div>`
        : ''
    }
    <div class="sheet-step">
      <h3>${cur ? 'Where to?' : 'Take the locomotive to'}</h3>
      <div class="dest-list">
        ${destRows}
        <button class="dest" data-dest="__new__">
          <span class="dest-lamp"></span>
          <span class="dest-body"><span class="dest-name">+ new track</span>
          <span class="dest-stop">lay a new line and switch onto it</span></span>
        </button>
        ${
          cur
            ? `<button class="dest" data-dest="__depot__">
                 <span class="dest-lamp"></span>
                 <span class="dest-body"><span class="dest-name">nowhere — park it</span>
                 <span class="dest-stop">the locomotive goes back to the shed</span></span>
               </button>`
            : ''
        }
      </div>
    </div>
    <div class="sheet-actions">
      <button class="btn btn-quiet" data-close>cancel</button>
      <span class="spacer"></span>
      <span class="hint">esc to cancel</span>
    </div>`,
    () => {
      let reason = LEFT.SWITCHING;
      const chips = sheetEl.querySelectorAll('#sw-reasons .chip');
      chips.forEach(
        (c) =>
          (c.onclick = () => {
            chips.forEach((x) => x.classList.remove('is-on'));
            c.classList.add('is-on');
            reason = c.dataset.reason;
          })
      );

      const stopField = $('sw-stop');
      if (stopField && mode !== 'park') {
        stopField.focus();
        stopField.setSelectionRange(stopField.value.length, stopField.value.length);
      }

      const gather = async () => {
        const stopText = stopField ? stopField.value : '';
        return {
          stopText,
          reason,
          stopPrefilled: !!prefill && stopText.trim() === prefill.trim(),
          snapshot: cur ? await captureSnapshot() : null,
        };
      };

      sheetEl.querySelectorAll('[data-dest]').forEach((b) => {
        b.onclick = async () => {
          const dest = b.dataset.dest;
          const leave = await gather();
          closeSheet();
          if (dest === '__new__') return openNewTrackSheet(leave);
          if (dest === '__depot__') return T.park(leave);
          const target = state.tracks[dest];
          if (!target) return;
          if (target.leftAt) return T.resume({ toId: dest, ...leave });
          return T.switchTo({ toId: dest, ...leave });
        };
      });

      if (jumpToNew) sheetEl.querySelector('[data-dest="__new__"]')?.click();
    }
  );
}

/** Creating a track asks for a name. Destination is optional and looks optional. */
function openNewTrackSheet(leave = null) {
  openSheet(
    `
    <div class="sheet-step">
      <h3>What train of thought is this?</h3>
      <input type="text" id="nt-name" placeholder="Portfolio" autocomplete="off" />
    </div>
    <div class="sheet-step">
      <h3>Where are you headed? <span class="optional">— optional</span></h3>
      <input type="text" id="nt-dest" placeholder="Finish deposit-flow case study" autocomplete="off" />
    </div>
    <div class="sheet-actions">
      <button class="btn btn-quiet" data-close>cancel</button>
      <span class="spacer"></span>
      <button class="btn btn-primary" id="nt-go">lay track</button>
    </div>`,
    () => {
      const name = $('nt-name');
      const dest = $('nt-dest');
      name.focus();
      const go = async () => {
        if (!name.value.trim()) {
          name.focus();
          return;
        }
        closeSheet();
        await T.createTrack({ name: name.value, destination: dest.value, board: true, leave });
      };
      $('nt-go').onclick = go;
      [name, dest].forEach(
        (i) =>
          (i.onkeydown = (e) => {
            if (e.key === 'Enter') go();
          })
      );
    }
  );
}

function openSettings() {
  // state is null before boot() resolves, and again while "erase everything"
  // re-boots. Both are short windows the settings button is live in.
  if (!state) return;
  const s = state.settings || {};
  openSheet(
    `
    <h3>Settings</h3>
    <div class="setting">
      <div class="setting-copy">
        <strong>Learn where I work (optional)</strong>
        <span>When enabled, Trainyard records the hostnames you visit while a track is active to learn which sites belong with it. This browsing activity stays only in Chrome storage on this device; it is never sent to us or anyone else. Page contents are never read.</span>
      </div>
      <input type="checkbox" class="switch" id="set-observe" ${s.observe ? 'checked' : ''} />
    </div>
    <div class="setting">
      <div class="setting-copy">
        <strong>Motion</strong>
        <span>How much the yard moves.</span>
      </div>
      <select id="set-motion">
        <option value="auto"${s.motion === 'auto' ? ' selected' : ''}>follow system</option>
        <option value="full"${s.motion === 'full' ? ' selected' : ''}>full</option>
        <option value="off"${s.motion === 'off' ? ' selected' : ''}>off</option>
      </select>
    </div>
    <div class="setting">
      <div class="setting-copy">
        <strong>Your data</strong>
        <span>Everything lives on this machine. There is no account and no server to send it to.</span>
      </div>
    </div>
    <div class="sheet-actions">
      <button class="btn" id="set-export">export json</button>
      <button class="btn" id="set-events">export usage log</button>
      <span class="spacer"></span>
      <button class="btn btn-quiet" id="set-clear">erase everything</button>
    </div>
    <p class="privacy-note">
      Trainyard has no host permissions and no content scripts, so it cannot read any page you visit.
      It sees tab hostnames and titles it is handed by Chrome. Hostnames are stored to learn track associations.
      Full URLs are written only into a snapshot, only at the moment you deliberately leave a track, and are
      deleted when that track arrives.
    </p>
    <div class="sheet-actions">
      <button class="btn btn-quiet" data-close>close</button>
    </div>`,
    () => {
      $('set-observe').onchange = (e) => T.setSetting('observe', e.target.checked);
      $('set-motion').onchange = (e) => T.setSetting('motion', e.target.value);
      $('set-export').onclick = async () =>
        download('trainyard-state.json', { state: await readState(), observed: await readObs() });
      $('set-events').onclick = async () => download('trainyard-usage.json', await readEvents());
      $('set-clear').onclick = async () => {
        if (!confirm('Erase every track, association and usage record on this machine?')) return;
        await clearAll();
        closeSheet();
        shapeKey = '';
        state = null;
        await boot();
      };
    }
  );
}

function download(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function layFirst() {
  const input = $('first-name');
  if (!input?.value.trim()) return;
  await T.createTrack({ name: input.value, board: true });
  await T.markOnboarded();
}

let arriving = false;

async function doArrive() {
  const cur = T.activeTrack(state);
  if (!cur || arriving) return;
  // The button stays on screen for the whole ~1s departure, so guard the entry
  // point as well as the reducer.
  arriving = true;
  nowEl.querySelectorAll('[data-act]').forEach((b) => (b.disabled = true));
  try {
    // Drive the engine home *before* the track leaves the yard, so the departure
    // is something you watch rather than something that already happened.
    skipNextAnim = true;
    await motion.switchTracks(cur.id, null, { leaveMarker: false });
    await T.arrive(cur.id);
    toast(`${cur.name} arrived.`, 'undo', () => T.unarrive(cur.id));
  } finally {
    arriving = false;
  }
}

async function doRestore() {
  const cur = T.activeTrack(state);
  const tabs = cur?.snapshot?.tabs || [];
  if (!tabs.length) return;
  await logEvent(EV.TABS_RESTORED, { id: cur.id, count: tabs.length });
  for (const t of tabs) {
    try {
      await chrome.tabs.create({ url: t.url, active: false, pinned: t.pinned });
    } catch {
      /* a URL Chrome refuses to open should not abort the rest */
    }
  }
  await T.editTrack(cur.id, {});
  toast(`Reopened ${tabs.length} tab${tabs.length === 1 ? '' : 's'}.`);
}

/** Tapping a signal is how you say "this is ready now". */
async function onSignal(id) {
  const t = state.tracks[id];
  if (!t || t.status === STATUS.ACTIVE) return;
  if (t.status === STATUS.READY) await T.unmarkReady(id);
  else await T.markReady(id);
}

function onPickTrack(id) {
  const cur = T.activeTrack(state);
  if (cur && cur.id === id) return;
  const target = state.tracks[id];
  if (!target) return;
  if (!cur) {
    // Nothing to leave behind — go straight there.
    if (target.leftAt) return T.resume({ toId: id });
    return T.switchTo({ toId: id });
  }
  openSwitchSheet('switch');
  // Preselect the destination the user already indicated.
  requestAnimationFrame(() => {
    const btn = sheetEl.querySelector(`[data-dest="${CSS.escape(id)}"]`);
    if (btn) {
      btn.style.borderColor = 'var(--accent)';
      btn.scrollIntoView({ block: 'nearest' });
    }
  });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

svgEl.addEventListener('click', (e) => {
  const sig = e.target.closest?.('[data-action="signal"]');
  if (sig) return onSignal(sig.dataset.id);
  const mk = e.target.closest?.('[data-action="resume"]');
  if (mk) return onPickTrack(mk.dataset.id);
});

svgEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = e.target.closest?.('[data-action]');
  if (!el) return;
  e.preventDefault();
  if (el.dataset.action === 'signal') onSignal(el.dataset.id);
  else onPickTrack(el.dataset.id);
});

labelsEl.addEventListener('click', (e) => {
  const lbl = e.target.closest?.('.lbl');
  if (lbl) onPickTrack(lbl.dataset.id);
});

$('btn-new').onclick = () => {
  if (!state?.order?.length) return openNewTrackSheet(null);
  openSwitchSheet('switch', { jumpToNew: true });
};
$('btn-settings').onclick = openSettings;

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state) render(state, { animate: false });
  }, 120);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  const s = await readState();
  await render(s, { animate: false });
  await logEvent(EV.PANEL_OPENED, { tracks: s.order.length });
  $('engine-hint').textContent = engineName === 'gsap' ? 'gsap' : '';
  await consumeIntent();
}

/** A keyboard command may have asked for a specific sheet before we existed. */
async function consumeIntent() {
  try {
    const got = await chrome.storage.session.get('ty_intent');
    const intent = got?.ty_intent;
    if (!intent) return;
    await chrome.storage.session.remove('ty_intent');
    applyIntent(intent);
  } catch {
    /* session storage unavailable — no intent, no problem */
  }
}

function applyIntent(intent) {
  if (!intent || Date.now() - intent.at > 10_000) return; // stale; moment passed
  if (!state || !T.activeTrack(state)) return;
  if (intent.open === 'switch') openSwitchSheet('switch');
  if (intent.open === 'park') openSwitchSheet('park');
}

// render() already skips renderNow while a stop is being edited, so the caret is
// safe. Skipping the whole render would leave signals, labels and the engine
// stale until some unrelated write happened to arrive.
subscribe((next) => render(next));

/**
 * A keyboard command can fire while the panel is already open, in which case
 * boot() never runs again. Watch session storage so the intent is honoured
 * either way.
 */
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session' || !changes.ty_intent?.newValue) return;
    applyIntent(changes.ty_intent.newValue);
    chrome.storage.session.remove('ty_intent').catch(() => {});
  });
} catch {
  /* session storage unavailable — keyboard intents just won't arrive */
}

boot();
