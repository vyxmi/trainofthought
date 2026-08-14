# Trainyard

One locomotive, many tracks. A Chrome side panel for switching between trains of thought without losing them.

**V1 scope:** the core loop only — lay a track, work, leave a stop, switch, resume. Plus the minimum railway needed to make state legible at a glance. No junction detection, no prompting, no automation. Context observation runs silently and records; it never asks you anything.

---

## Install

1. `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select the `ext/` folder
4. Pin the icon, or press <kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>Y</kbd>

No build step. Edit a file, hit the reload arrow on the extensions page, reopen the panel.

**Shortcuts:** <kbd>Ctrl/Cmd+Shift+Y</kbd> open · <kbd>Alt+Shift+S</kbd> switch tracks · <kbd>Alt+Shift+P</kbd> park. Rebind at `chrome://extensions/shortcuts`.

---

## The model

| Thing | What it is |
|---|---|
| **Locomotive** | Your attention. There is exactly one. It is on one track or in the shed. |
| **Track** | A train of thought — a project, a thread, a thing you return to. |
| **Current stop** | Where you are on that track. It is *also* the re-entry cue: when you leave, this is what you'll read when you come back. One field, not two. |
| **Destination** | Optional. The stable goal. Never required to create a track. |
| **Signal** | The track's state, at the entrance. Tap it to mark a track ready. |
| **Return board** | The marker left standing where the engine was. Shown only on tracks the engine isn't on — where it *is*, the engine is the marker. |
| **Shed** | Where the locomotive sits when your attention isn't on anything tracked. |

States: `active` · `parked` · `waiting` · `ai_working` · `ready` · `arrived`. "Hit a stop" is parked with a red signal rather than a seventh state.

---

## Layout

```
ext/
  manifest.json              MV3. Permissions: sidePanel, storage, tabs, alarms.
  background/
    service-worker.js        Silent observation, keyboard commands. Writes ty_obs only.
  lib/
    store.js                 chrome.storage.local schema, migrations, local event log
    tracks.js                Domain logic. All state transitions live here.
    railway.js               Yard geometry + SVG construction
    anim.js                  Motion engine (native path-follower, or GSAP)
    motion.js                The four semantic movements
  sidepanel/
    index.html  panel.css  panel.js
  icons/
dev/                         Not shipped. Preview harness, chrome mock, icon generator.
```

**Architecture:** the panel never messages the service worker. Both read and write `chrome.storage.local` and re-render from `storage.onChanged`. The panel is therefore correct after a reload, after Chrome evicts the worker (constantly), and with two windows open.

**Storage ownership** matters and is load-bearing: `ty` (durable state) is written **only** by the panel. `ty_obs` (learned domain associations) is written **only** by the worker. Since every writer sets a whole key, shared ownership would mean the worker's per-minute flush could read a snapshot, hold it across a few awaits, and write it back over a switch you just made — silently undoing your action. Different keys, no race. If you ever make the worker mutate a track, that guarantee is gone and you need a real lock.

---

## Motion

Four movements, and nothing else moves:

| Movement | What it answers |
|---|---|
| `switchTracks` | where did my attention go, and where from |
| `layTrack` | this place is new — it was built, not appended |
| `markReturn` | something was deliberately left, right there |
| `resumeTo` | you're back, and this is the spot |

The blade throws *before* the engine moves. That order is the whole difference between a mechanism responding to a decision and a cartoon train sliding around.

The engine's lean is clamped to 38° (`anim.js` `maxRotate`). The yard ladder is near-vertical in a panel this narrow, so a literally correct tangent points the engine straight down for most of a long switch and reads as falling. Same licence a track diagram takes over a survey drawing.

### Swapping in GSAP

`anim.js` ships a native engine: `requestAnimationFrame` + `getPointAtLength()`, which is what MotionPathPlugin does underneath. It works out of the box with zero dependencies. GSAP is a drop-in replacement:

```bash
npm pack gsap && tar -xzf gsap-*.tgz
cp package/dist/gsap.min.js package/dist/MotionPathPlugin.min.js ext/vendor/
```

Then in `ext/sidepanel/index.html`, before `panel.js`:

```html
<script src="../vendor/gsap.min.js"></script>
<script src="../vendor/MotionPathPlugin.min.js"></script>
<script>gsap.registerPlugin(MotionPathPlugin)</script>
```

…and set `USE_GSAP = true` at the top of `lib/anim.js`. Nothing else changes — every caller goes through `place()` / `followPath()` / `tween()` / `drawPath()`, and both backends implement all four identically. MV3 blocks remote scripts, so the files must be vendored locally.

*(They aren't bundled here because the build sandbox had no npm access.)*

**One rule if you touch this:** a given element is positioned by exactly one backend for its whole life. Never mix the transform *attribute* (native) with GSAP's CSS transforms on the same node — they double-apply.

---

## Privacy

- **No host permissions. No content scripts.** The extension cannot read any page you visit, at all.
- It sees tab hostnames and titles that Chrome hands it. Only **hostnames** are stored, for association learning.
- Full URLs are written in exactly one place: a snapshot, taken only when you deliberately leave a track, deleted when that track arrives.
- Everything is local. No account, no server, no network code.
- Settings → toggle observation off, export everything, or erase everything.

---

## Reading the results

Settings → **export usage log** gives you the raw local event stream. What to look at, in priority order:

**Does the loop work at all?**
- `track_created` ordinal ≥ 2 — did they build a second track, or is this a single-project tool?
- `track_parked` → `track_resumed` rate. *Parked tracks that are never resumed are the loudest failure signal.* It means the yard became a graveyard, i.e. a task list.
- `msParked` on resume. If this is usually days, this isn't a context-switching tool, it's a backlog.

**Is the return point earning its place?**
- `hasStop` on `track_parked`. If mostly false, people are switching without leaving a cue, and the promise doesn't hold.
- `stop_accepted` vs `stop_edited`. If the prefill is nearly always accepted unchanged, it's free and correct. If it's nearly always edited, the prefill is wrong and is costing a step.

**Is it annoying?**
- Nothing prompts in this build, so the only annoyance signal is `observe_disabled`.

Deliberately not recorded: hours focused, task counts, streaks, anything scoreable.

---

## Development

```bash
node dev/preview.mjs
```

Serves `ext/` over http, injects a `chrome.*` mock, drives the real panel in headless Chromium, and writes screenshots of every state to `shots/`. **Console errors fail the run.** This is the fastest way to catch a silent exception in a render path — it has already caught an invisible overlay eating every click at the bottom of the panel, and two `text-overflow: ellipsis` rules that did nothing because they were on inline spans.

---

## What is deliberately not built

Junction detection is the obvious missing piece and it is missing on purpose. It's the second hypothesis, not the first, and a prompt that fires at the wrong moment during dogfooding will make you abandon a core loop that was actually working. Everything needed to build it is being recorded now (`ty_obs.byTrack` holds per-track domain hit counts; `ty_obs.absences` holds away-from-Chrome durations) and nothing acts on it.

Build it when — and only when — the export above says people are actually resuming what they park.

Also not built, per spec §29: task management, calendar, Pomodoro, blocking, scoring, collaboration, agent integrations, automatic decomposition, an elaborate railway map.
