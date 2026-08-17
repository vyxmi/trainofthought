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
  LEFT_LABEL,
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
let editingNowField = null;
let skipNextAnim = false;
let toastTimer = 0;
let newMarkerEventIds = new Set();

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
      return `on track · ${duration(Date.now() - (state?.locomotive?.sinceAt || Date.now()))}`;
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

function duration(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 60_000) return '<1m';
  const minutes = Math.round(value / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (hours < 24) return rem ? `${hours}h ${rem}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function dateTime(at) {
  if (!at) return 'not recorded';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(at));
}

const ACTION_ICONS = {
  switch: `<svg viewBox="0 0 18 14" aria-hidden="true"><path d="M2 3h4c4 0 4 8 8 8h2M2 11h4c2.7 0 3.5-3.6 5.2-6C12.3 3.5 13.6 3 16 3"/><path d="m13.5 1.2 2.5 1.8-2.5 1.8M13.5 9.2 16 11l-2.5 1.8"/></svg>`,
  park: `<svg viewBox="0 0 18 14" aria-hidden="true"><path d="M2 12h14M4 12V7.5a5 5 0 0 1 10 0V12M7 12V8.2a2 2 0 0 1 4 0V12"/></svg>`,
  arrived: `<svg viewBox="0 0 18 14" aria-hidden="true"><path d="M4 13V1.5M4.5 2h8l-1.8 2.5L12.5 7h-8"/><path d="m7.2 10 1.4 1.4 2.8-3"/></svg>`,
};

function actionLabel(icon, label) {
  return `<span class="action-icon">${ACTION_ICONS[icon]}</span><span>${label}</span>`;
}

function shedIcon() {
  return `<svg class="dest-shed" viewBox="0 0 38 26" aria-hidden="true"><path class="dest-shed-floor" d="M1 24h36"/><path class="dest-shed-shell" d="M7 24V12a12 12 0 0 1 24 0v12"/><path class="dest-shed-mouth" d="M12 24V13a7 7 0 0 1 14 0v11"/></svg>`;
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
  newMarkerEventIds = new Set();
  if (before) {
    for (const id of next.order) {
      const previous = new Set((before.tracks[id]?.events || []).map((event) => event.id));
      for (const event of next.tracks[id]?.events || []) {
        if (!previous.has(event.id) && (event.type === 'note' || event.type === 'stop')) newMarkerEventIds.add(event.id);
      }
    }
  }
  state = next;
  document.documentElement.dataset.theme = next.settings?.theme === 'nighttime' ? 'nighttime' : 'daytime';
  document.documentElement.dataset.motion = next.settings?.motion || 'auto';
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
  if (before) {
    for (const id of next.order) {
      if (before.tracks[id]?.status === next.tracks[id]?.status) continue;
      const signal = handles?.rows.get(id)?.signal;
      if (!signal) continue;
      signal.classList.add('is-changing');
      setTimeout(() => signal.classList.remove('is-changing'), 520);
    }
  }
  renderLabels(next);
  if (!editingNowField) renderNow(next);
  renderFooter(next);

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
    const group = document.createElement('div');
    group.className = ['track-label-group', t.id === activeId ? 'is-active' : '', stateClass(t)].filter(Boolean).join(' ');
    group.dataset.id = t.id;
    group.style.left = `${Math.max(4, slot.labelX - 18)}px`;
    group.style.top = `${slot.labelY}px`;
    group.style.width = `${Math.max(120, layout.width - slot.labelX - 30)}px`;
    group.innerHTML = `
      <button class="track-title" data-id="${esc(t.id)}" title="${t.id === activeId ? 'Current track' : `Switch to ${esc(t.name)}`}">
        <span class="lbl-name">${esc(t.name)}</span>
        <span class="lbl-status">${esc(statusWord(t))}</span>
      </button>
      <span class="track-tools">
        <button class="add-note" data-id="${esc(t.id)}" title="Add a note">+ note</button>
        <button class="details-track" data-id="${esc(t.id)}" aria-label="Open details for ${esc(t.name)}" title="Track details">•••</button>
      </span>`;
    labelsEl.appendChild(group);

    const markerEvents = (t.events || [])
      .filter((event) => event.type === 'stop' || event.type === 'note')
      .slice(-4);
    if (markerEvents.length) {
      const newestRelevant = [...markerEvents]
        .reverse()
        .find((event) => (event.type === 'stop' ? !event.passedAt : !event.resolvedAt));
      const newestId = (newestRelevant || markerEvents.at(-1)).id;
      const markers = document.createElement('div');
      markers.className = 'event-markers';
      markers.style.left = `${slot.platformX + 18}px`;
      markers.style.top = `${slot.y + 5}px`;
      markers.style.width = `${Math.max(70, layout.width - slot.platformX - 46)}px`;
      markers.innerHTML = markerEvents
        .map(
          (event) => `
          <button class="event-marker marker-${event.type} ${event.id === newestId ? 'is-latest' : 'is-compact'}
                  ${event.passedAt ? 'is-passed' : ''} ${event.resolvedAt ? 'is-resolved' : ''}
                  ${newMarkerEventIds.has(event.id) ? 'is-new' : ''}"
                  data-id="${esc(t.id)}" data-event-id="${esc(event.id)}"
                  aria-label="Inspect ${event.type}: ${esc(event.text || '')}">
            <span class="event-icon" aria-hidden="true"></span>
            <span class="event-body"><span class="event-text">${esc(event.text || '')}</span>
            <time>${esc(dateTime(event.at))}</time></span>
          </button>`
        )
        .join('');
      labelsEl.appendChild(markers);
    }
  }

  const d = document.createElement('button');
  d.type = 'button';
  d.className = 'depot-label';
  d.dataset.action = 'depot';
  d.style.left = `${layout.depot.labelX}px`;
  d.style.top = `${layout.depot.labelY}px`;
  d.textContent = 'shed';
  d.title = activeId ? 'Park in the shed' : 'The locomotive is in the shed';
  labelsEl.appendChild(d);
}

function renderFooter(s) {
  const arrivals = $('btn-arrivals');
  if (arrivals) {
    const count = s.history?.length || 0;
    arrivals.innerHTML = `arrivals${count ? ` <span>${count}</span>` : ''}`;
    arrivals.classList.toggle('has-arrivals', count > 0);
  }
  const add = $('btn-new');
  if (add) {
    add.disabled = s.order.length >= 10;
    add.title = s.order.length >= 10 ? 'The yard holds up to 10 active tracks' : 'Lay a new track';
  }
}

function renderNow(s) {
  const live = s.order.filter((id) => s.tracks[id]);

  if (!live.length) {
    nowEl.innerHTML = `
      <div class="empty">
        <h2>Lay your first track.</h2>
        <p>A track is one train of thought: a project, a thread, a thing you keep coming back to. There's one locomotive: your attention. It can only be in one place, which is the honest part.</p>
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
        ready.length ? `${ready.length} ready to pick up. Tap a track below` : 'Tap a track below to take the locomotive out'
      }</div>
      <div class="now-actions"><button class="btn" data-act="new">+ new track</button></div>`;
    wireNow();
    return;
  }

  const hasStop = !!cur.currentStop;

  nowEl.innerHTML = `
    <div class="eyebrow now-current"><span>current stop</span><i class="eyebrow-line"></i>
      <strong>${esc(statusWord(cur))}</strong></div>
    <button class="now-name now-inline-edit" id="now-name-btn" title="Edit track name">${esc(cur.name)}</button>
    <button class="now-dest now-inline-edit ${cur.destination ? '' : 'is-empty'}" id="now-dest-btn" title="Edit destination">${
      cur.destination ? `→ ${esc(cur.destination)}` : '+ add destination'
    }</button>
    <button class="now-stop ${hasStop ? '' : 'is-empty'}" id="stop-btn" title="Click to edit">${
      hasStop ? esc(cur.currentStop) : 'What are you doing right now?'
    }</button>
    <div class="now-actions">
      <button class="btn btn-quiet action-button" data-act="switch">${actionLabel('switch', 'switch tracks')}</button>
      <button class="btn btn-quiet action-button" data-act="park">${actionLabel('park', 'park')}</button>
      <button class="btn btn-quiet action-button" data-act="arrived">${actionLabel('arrived', 'arrived')}</button>
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
    };
  });
  const sb = $('stop-btn');
  if (sb) sb.onclick = () => beginNowEdit('stop');
  const name = $('now-name-btn');
  if (name) name.onclick = () => beginNowEdit('name');
  const destination = $('now-dest-btn');
  if (destination) destination.onclick = () => beginNowEdit('destination');
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
    const leaveMarker = !!(fromId && next.tracks[fromId]?.currentStop?.trim());
    const targetHasStop = !!(toId && before.tracks[toId]?.leftAt && before.tracks[toId]?.currentStop?.trim());
    if (targetHasStop) await motion.resumeTo(fromId, toId, { leaveMarker });
    else await motion.switchTracks(fromId, toId, { leaveMarker });
    return;
  }

  if (rebuilt) motion.settle(toId);
}

// ---------------------------------------------------------------------------
// Inline current-track editing
// ---------------------------------------------------------------------------

function beginNowEdit(field) {
  const cur = T.activeTrack(state);
  if (!cur) return;
  const config = {
    name: { id: 'now-name-btn', value: cur.name, placeholder: 'Track name', className: 'now-name now-inline-input' },
    destination: {
      id: 'now-dest-btn',
      value: cur.destination || '',
      placeholder: 'Optional destination',
      className: 'now-dest now-inline-input',
    },
    stop: { id: 'stop-btn', value: cur.currentStop || '', placeholder: 'What are you doing right now?', className: 'now-stop' },
  }[field];
  const button = config && $(config.id);
  if (!button) return;

  editingNowField = field;
  const input = document.createElement(field === 'stop' ? 'textarea' : 'input');
  if (field !== 'stop') input.type = 'text';
  input.className = config.className;
  input.value = config.value;
  input.placeholder = config.placeholder;
  input.maxLength = field === 'name' ? 80 : 180;
  if (field === 'stop') input.rows = 1;
  button.replaceWith(input);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  if (field === 'stop') {
    autosize(input);
    input.oninput = () => autosize(input);
  }

  const commit = async (save) => {
    if (editingNowField !== field) return;
    editingNowField = null;
    const value = input.value.trim();
    if (save && field === 'name' && value) await T.editTrack(cur.id, { name: value });
    else if (save && field === 'destination') await T.editTrack(cur.id, { destination: value });
    else if (save && field === 'stop') await T.setStop(cur.id, value);
    else renderNow(state);
    const unchanged =
      (field === 'name' && value === cur.name) ||
      (field === 'destination' && value === (cur.destination || '')) ||
      (field === 'stop' && value === (cur.currentStop || ''));
    if (save && unchanged) renderNow(state);
  };

  input.onblur = () => commit(true);
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && (field !== 'stop' || !e.shiftKey)) {
      e.preventDefault();
      input.blur();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      input.onblur = null;
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
  sheetEl.onkeydown = null;
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
function openSwitchSheet(mode = 'switch', { jumpToNew = false, initialDest = null, resumeEventId = null } = {}) {
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
          ${t.currentStop?.trim() ? `<span class="dest-stop">${esc(t.currentStop.trim())}</span>` : ''}
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
             <h3>Why are you leaving?</h3>
             <div class="chips" id="sw-reasons">
               <button class="chip is-on" data-reason="${LEFT.SWITCHING}">just switching</button>
               <button class="chip" data-reason="${LEFT.BLOCKED}">hit a stop</button>
               <button class="chip" data-reason="${LEFT.WAITING}">waiting</button>
               <button class="chip" data-reason="${LEFT.AI}">AI working</button>
             </div>
           </div>
           <div class="sheet-step">
             <h3>Where should we pick <strong class="track-inline">${esc(cur.name)}</strong> back up? <span class="optional">(optional)</span></h3>
             <textarea id="sw-stop" rows="2" placeholder="Test whether guest UID survives signup">${esc(prefill)}</textarea>
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
            ? `<button class="dest dest-park" data-dest="__depot__">
                 <span class="dest-lamp"></span>
                 <span class="dest-body"><span class="dest-name">nowhere: park it</span></span>
                 ${shedIcon()}
               </button>`
            : ''
        }
      </div>
    </div>
    <div class="sheet-actions switch-actions">
      <button class="sheet-cancel" data-close><span>cancel</span><small>esc to cancel</small></button>
      <span class="spacer"></span>
      <button class="btn btn-primary enter-button" id="sw-go" disabled>enter</button>
    </div>`,
    () => {
      let reason = LEFT.SWITCHING;
      let selectedDest = mode === 'park' ? '__depot__' : initialDest;
      let submitting = false;
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
        };
      };

      const go = $('sw-go');
      const selectDestination = (dest, { scroll = false } = {}) => {
        selectedDest = dest;
        sheetEl.querySelectorAll('[data-dest]').forEach((b) => b.classList.toggle('is-selected', b.dataset.dest === dest));
        go.disabled = !selectedDest;
        const selected = sheetEl.querySelector(`[data-dest="${CSS.escape(dest)}"]`);
        if (scroll) selected?.scrollIntoView({ block: 'nearest' });
      };

      const submit = async () => {
        if (!selectedDest || submitting) return;
        submitting = true;
        go.disabled = true;
        const dest = selectedDest;
        const leave = await gather();
        closeSheet();
        if (dest === '__new__') return openNewTrackSheet(leave);
        if (dest === '__depot__') return T.park(leave);
        const target = state.tracks[dest];
          if (!target) return;
          if (target.leftAt) return T.resume({ toId: dest, resumeEventId: dest === initialDest ? resumeEventId : null, ...leave });
          return T.switchTo({ toId: dest, ...leave });
      };

      sheetEl.querySelectorAll('[data-dest]').forEach((b) => {
        b.onclick = () => selectDestination(b.dataset.dest);
      });
      go.onclick = submit;
      sheetEl.onkeydown = (e) => {
        if (e.key !== 'Enter') return;
        if (e.target === stopField && e.shiftKey) return;
        e.preventDefault();
        submit();
      };

      if (selectedDest) selectDestination(selectedDest, { scroll: true });
      if (jumpToNew) {
        selectDestination('__new__');
        submit();
      }
    }
  );
}

/** Creating a track asks for a name. Destination is optional and looks optional. */
function openNewTrackSheet(leave = null) {
  if (state.order.length >= 10) {
    toast('The yard holds up to 10 active tracks.');
    return;
  }
  openSheet(
    `
    <div class="sheet-step">
      <h3>What train of thought is this?</h3>
      <input type="text" id="nt-name" placeholder="Portfolio" autocomplete="off" />
    </div>
    <div class="sheet-step">
      <h3>Where are you headed? <span class="optional">(optional)</span></h3>
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

function timelineEpisodes(track) {
  const episodes = [];
  let awayAt = null;
  const push = (event, label, kind = event.type, interactive = false) =>
    episodes.push({ id: event.id, eventId: event.id, at: event.at, label, kind, interactive });

  for (const event of [...(track.events || [])].sort((a, b) => a.at - b.at)) {
    switch (event.type) {
      case 'created':
        push(event, 'track started', 'origin');
        break;
      case 'started':
        push(event, 'first ride', 'resume');
        break;
      case 'ride':
      case 'carried_time':
        if (event.durationMs) push(event, `rode ${duration(event.durationMs)}`, 'ride');
        break;
      case 'switch':
        awayAt = event.at;
        push(event, event.toName ? `switched to ${event.toName}` : 'switched tracks', 'switch');
        break;
      case 'park':
        awayAt = event.at;
        push(event, 'parked in the shed', 'park');
        break;
      case 'stop':
        awayAt ||= event.at;
        push(event, `stopped: “${event.text || 'no note'}”${event.passedAt ? ' · passed' : ''}`, 'stop', true);
        break;
      case 'note':
        push(event, `note: “${event.text || ''}”${event.resolvedAt ? ' · resolved' : ''}`, 'note', true);
        break;
      case 'resume':
        if (awayAt && event.at > awayAt) {
          episodes.push({ id: `${event.id}-away`, eventId: null, at: event.at, label: `${duration(event.at - awayAt)} away`, kind: 'away' });
        }
        push(event, 'resumed', 'resume');
        awayAt = null;
        break;
      case 'continued':
        push(event, `continued from ${event.fromType || 'marker'}`, 'resume');
        break;
      case 'arrived':
        push(event, 'arrived', 'arrived');
        break;
      case 'reopened':
        push(event, 'returned to the yard', 'resume');
        break;
      default:
        break;
    }
  }
  return episodes;
}

function openTrackDetails(id, { focusEventId = null } = {}) {
  const track = state.tracks[id];
  if (!track) return;
  const episodes = timelineEpisodes(track);
  const arrived = track.status === STATUS.ARRIVED;
  openSheet(
    `
    <div class="details-heading">
      <div>
        <div class="eyebrow">${arrived ? 'arrival' : 'track details'}</div>
        <h2>${esc(track.name)}</h2>
        ${track.destination ? `<div class="details-destination">→ ${esc(track.destination)}</div>` : ''}
      </div>
      <button class="icon-text-button" data-close>close</button>
    </div>
    <div class="episode-heading"><span>attention line</span><small>${episodes.length} episode${episodes.length === 1 ? '' : 's'}</small></div>
    <div class="episode-viewport">
      <ol class="episode-track" style="--episode-count:${Math.max(1, episodes.length)}">
        ${episodes
          .map(
            (episode) => `<li id="episode-${esc(episode.id)}" class="episode episode-${esc(episode.kind)}">
              <span class="episode-pin" aria-hidden="true"></span>
              ${
                episode.interactive
                  ? `<button class="episode-copy" data-marker-id="${esc(episode.eventId)}"><strong>${esc(episode.label)}</strong><time>${esc(dateTime(episode.at))}</time></button>`
                  : `<div class="episode-copy"><strong>${esc(episode.label)}</strong><time>${esc(dateTime(episode.at))}</time></div>`
              }
            </li>`
          )
          .join('')}
      </ol>
    </div>
    <div class="sheet-actions details-actions">
      <button class="btn btn-danger" id="details-delete">delete track</button>
      <span class="spacer"></span>
      <button class="btn" data-close>done</button>
    </div>`,
    () => {
      sheetEl.querySelectorAll('[data-marker-id]').forEach((button) => {
        button.onclick = () => openMarkerSheet(id, button.dataset.markerId);
      });
      $('details-delete').onclick = () => deleteTrackWithUndo(id);
      if (focusEventId) {
        requestAnimationFrame(() => {
          const target = document.getElementById(`episode-${focusEventId}`);
          target?.classList.add('is-focused');
          target?.scrollIntoView({ block: 'nearest', inline: 'center' });
        });
      }
    }
  );
}

function openMarkerSheet(id, eventId) {
  const track = state.tracks[id];
  const event = (track?.events || []).find(
    (item) => item.id === eventId && (item.type === 'stop' || item.type === 'note')
  );
  if (!track || !event) return;
  const isNote = event.type === 'note';
  const stateLabel = event.passedAt ? 'passed' : event.resolvedAt ? 'resolved' : 'current';
  openSheet(
    `
    <div class="details-heading marker-heading">
      <div><div class="eyebrow">${esc(event.type)}</div><h2>${esc(track.name)}</h2></div>
      <button class="icon-text-button" data-close>close</button>
    </div>
    <blockquote class="marker-inspect-text">${esc(event.text || 'No note')}</blockquote>
    <div class="marker-inspect-meta"><time>${esc(dateTime(event.at))}</time><span>${esc(stateLabel)}</span></div>
    <div class="sheet-actions marker-actions">
      <button class="btn btn-quiet" id="marker-details">track details</button>
      ${isNote ? `<button class="btn" id="marker-resolve">${event.resolvedAt ? 'reopen note' : 'resolve note'}</button>` : ''}
      <span class="spacer"></span>
      ${track.status !== STATUS.ARRIVED ? `<button class="btn btn-primary" id="marker-continue">continue from here</button>` : ''}
    </div>`,
    () => {
      $('marker-details').onclick = () => openTrackDetails(id, { focusEventId: eventId });
      const resolve = $('marker-resolve');
      if (resolve) {
        resolve.onclick = async () => {
          const willResolve = !event.resolvedAt;
          await T.setNoteResolved(id, eventId, willResolve);
          closeSheet();
          toast(willResolve ? 'Note resolved.' : 'Note reopened.');
        };
      }
      const continueButton = $('marker-continue');
      if (continueButton) continueButton.onclick = () => continueFromMarker(id, eventId);
    }
  );
}

async function continueFromMarker(id, eventId) {
  const cur = T.activeTrack(state);
  closeSheet();
  if (cur?.id === id) {
    await T.continueOnTrack(id, eventId);
    return;
  }
  if (!cur) {
    await T.resume({ toId: id, resumeEventId: eventId });
    return;
  }
  openSwitchSheet('switch', { initialDest: id, resumeEventId: eventId });
}

function openNoteSheet(id) {
  const track = state.tracks[id];
  if (!track || track.status === STATUS.ARRIVED) return;
  openSheet(
    `
    <div class="sheet-step">
      <h3>Add a note to <strong class="track-inline">${esc(track.name)}</strong></h3>
      <textarea id="note-text" rows="3" maxlength="180" placeholder="One thought to keep with this track"></textarea>
      <div class="field-counter"><span id="note-count">0</span>/180</div>
    </div>
    <div class="sheet-actions">
      <button class="btn btn-quiet" data-close>cancel</button>
      <span class="spacer"></span>
      <button class="btn btn-primary" id="note-save" disabled>add note</button>
    </div>`,
    () => {
      const input = $('note-text');
      const save = $('note-save');
      const updateCount = () => {
        $('note-count').textContent = String(input.value.length);
        save.disabled = !input.value.trim();
      };
      input.oninput = updateCount;
      input.onkeydown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (!save.disabled) save.click();
        }
      };
      save.onclick = async () => {
        const text = input.value.trim();
        if (!text) return;
        closeSheet();
        await T.addNote(id, text);
      };
      input.focus();
    }
  );
}

function openArrivals() {
  const arrivals = (state.history || []).map((id) => state.tracks[id]).filter(Boolean);
  openSheet(
    `
    <div class="details-heading">
      <div><div class="eyebrow">arrivals</div></div>
      <button class="icon-text-button" data-close>close</button>
    </div>
    ${
      arrivals.length
        ? `<div class="arrivals-list">${arrivals
            .map(
              (track) => `<button class="arrival-row" data-arrival-id="${esc(track.id)}">
                <span class="arrival-main"><strong>${esc(track.name)}</strong>${track.destination ? `<small>${esc(track.destination)}</small>` : ''}</span>
                <span class="arrival-times"><span>${esc(dateTime(track.createdAt))}</span><strong>${esc(duration(track.msOnTrack))}</strong></span>
              </button>`
            )
            .join('')}</div>`
        : `<div class="arrivals-empty"><strong>No arrivals yet.</strong><span>Completed tracks will wait here with their full history.</span></div>`
    }`,
    () => {
      sheetEl.querySelectorAll('[data-arrival-id]').forEach((button) => {
        button.onclick = () => openTrackDetails(button.dataset.arrivalId);
      });
    }
  );
}

async function deleteTrackWithUndo(id) {
  const track = state.tracks[id];
  if (!track) return;
  const saved = structuredClone(track);
  const orderIndex = state.order.indexOf(id);
  const historyIndex = state.history.indexOf(id);
  closeSheet();
  await T.removeTrack(id);
  toast(`${track.name} deleted.`, 'undo', () => T.restoreTrack({ track: saved, orderIndex, historyIndex }));
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
        <strong>Time of day</strong>
      </div>
      <div class="theme-toggle" role="group" aria-label="Time of day">
        <button type="button" data-theme="daytime" aria-label="Daytime" title="Daytime" class="${s.theme !== 'nighttime' ? 'is-on' : ''}">
          <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.7"></circle><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.1 3.1l1.4 1.4M11.5 11.5l1.4 1.4M12.9 3.1l-1.4 1.4M4.5 11.5l-1.4 1.4"></path></svg>
          <span>daytime</span>
        </button>
        <button type="button" data-theme="nighttime" aria-label="Nighttime" title="Nighttime" class="${s.theme === 'nighttime' ? 'is-on' : ''}">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12.9 10.7A6 6 0 0 1 5.3 3.1a5.4 5.4 0 1 0 7.6 7.6Z"></path></svg>
          <span>nighttime</span>
        </button>
      </div>
    </div>
    <div class="setting">
      <div class="setting-copy">
        <strong>Learn where I work (optional)</strong>
        <span>When enabled, Train of Thought records the hostnames you visit while a track is active to learn which sites belong with it. This browsing activity stays only in Chrome storage on this device; it is never sent to us or anyone else. Page contents are never read.</span>
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
    <details class="data-details">
      <summary>
        <span class="setting-copy">
          <strong>Your data</strong>
          <span>Everything lives on this machine.</span>
        </span>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 5.5 8 10.5 13 5.5"></path></svg>
      </summary>
      <div class="data-details-body">
        <div class="sheet-actions data-actions">
          <button class="btn" id="set-export">export json</button>
          <button class="btn" id="set-events">export usage log</button>
          <span class="spacer"></span>
          <button class="btn btn-quiet" id="set-clear">erase everything</button>
        </div>
        <p class="privacy-note">
          Train of Thought has no host permissions and no content scripts, so it cannot read page contents.
          If you enable Learn where I work, it stores only tab hostnames to learn track associations. Full URLs are not stored.
        </p>
      </div>
    </details>
    <div class="sheet-actions">
      <button class="btn btn-quiet" data-close>close</button>
    </div>`,
    () => {
      sheetEl.querySelectorAll('[data-theme]').forEach((button) => {
        button.onclick = async () => {
          const theme = button.dataset.theme;
          document.documentElement.dataset.theme = theme;
          sheetEl.querySelectorAll('[data-theme]').forEach((item) => item.classList.toggle('is-on', item === button));
          await T.setSetting('theme', theme);
        };
      });
      $('set-observe').onchange = (e) => T.setSetting('observe', e.target.checked);
      $('set-motion').onchange = (e) => T.setSetting('motion', e.target.value);
      $('set-export').onclick = async () =>
        download('train-of-thought-state.json', { state: await readState(), observed: await readObs() });
      $('set-events').onclick = async () => download('train-of-thought-usage.json', await readEvents());
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
  openSwitchSheet('switch', { initialDest: id });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

svgEl.addEventListener('click', (e) => {
  const sig = e.target.closest?.('[data-action="signal"]');
  if (sig) return onSignal(sig.dataset.id);
  const event = e.target.closest?.('[data-action="event"]');
  if (event) return openMarkerSheet(event.dataset.id, event.dataset.eventId);
  const depot = e.target.closest?.('[data-action="depot"]');
  if (depot && T.activeTrack(state)) return openSwitchSheet('park');
});

svgEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = e.target.closest?.('[data-action]');
  if (!el) return;
  e.preventDefault();
  if (el.dataset.action === 'signal') onSignal(el.dataset.id);
  else if (el.dataset.action === 'event') openMarkerSheet(el.dataset.id, el.dataset.eventId);
  else if (el.dataset.action === 'depot') {
    if (T.activeTrack(state)) openSwitchSheet('park');
  } else onPickTrack(el.dataset.id);
});

labelsEl.addEventListener('click', (e) => {
  const event = e.target.closest?.('.event-marker');
  if (event) return openMarkerSheet(event.dataset.id, event.dataset.eventId);
  const note = e.target.closest?.('.add-note');
  if (note) return openNoteSheet(note.dataset.id);
  const details = e.target.closest?.('.details-track');
  if (details) return openTrackDetails(details.dataset.id);
  const title = e.target.closest?.('.track-title');
  if (title) return onPickTrack(title.dataset.id);
  const depot = e.target.closest?.('[data-action="depot"]');
  if (depot && T.activeTrack(state)) openSwitchSheet('park');
});

labelsEl.addEventListener('pointerover', (e) => {
  const group = e.target.closest?.('.track-label-group');
  if (!group) return;
  handles?.rows.get(group.dataset.id)?.g.classList.add('is-hovered');
});

labelsEl.addEventListener('pointerout', (e) => {
  const group = e.target.closest?.('.track-label-group');
  if (!group || group.contains(e.relatedTarget)) return;
  handles?.rows.get(group.dataset.id)?.g.classList.remove('is-hovered');
});

$('btn-new').onclick = () => {
  if (state?.order?.length >= 10) return toast('The yard holds up to 10 active tracks.');
  if (!state?.order?.length) return openNewTrackSheet(null);
  openSwitchSheet('switch', { jumpToNew: true });
};
$('btn-arrivals').onclick = openArrivals;
$('btn-settings').onclick = openSettings;

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state) render(state, { animate: false });
  }, 120);
});

setInterval(() => {
  const cur = state && T.activeTrack(state);
  if (!cur) return;
  if (!editingNowField) renderNow(state);
  const status = labelsEl.querySelector(`.track-label-group[data-id="${CSS.escape(cur.id)}"] .lbl-status`);
  if (status) status.textContent = statusWord(cur);
}, 30_000);

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
