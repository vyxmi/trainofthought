/**
 * preview.mjs — drives the side panel in headless Chromium and screenshots it.
 *
 * Loading an unpacked extension for every code change is slow, and side panels
 * are awkward to script. Instead this serves ext/ over http (ES modules refuse to
 * load from file://), injects the chrome.* mock, and interacts with the real
 * panel.js. Console errors are treated as failures — a silent exception in a
 * render path is exactly the bug this is here to catch.
 *
 *   node dev/preview.mjs
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'ext');
const SHOTS = path.join(ROOT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// --- build the preview page ------------------------------------------------

const indexHtml = fs.readFileSync(path.join(EXT, 'sidepanel', 'index.html'), 'utf8');
const previewHtml = indexHtml.replace(
  '<script type="module" src="panel.js"></script>',
  `<script src="/dev/mock-chrome.js"></script>
    <script>if (window.__SEED__) window.__seed(window.__SEED__);</script>
    <script type="module" src="panel.js"></script>`
);
fs.writeFileSync(path.join(EXT, 'sidepanel', '_preview.html'), previewHtml);

// --- static server ---------------------------------------------------------

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end('nope');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(8899, r));

// --- fixtures --------------------------------------------------------------

const NOW = Date.now();
const t = (id, name, extra = {}) => ({
  id,
  name,
  destination: '',
  currentStop: '',
  status: 'parked',
  leftBecause: 'switching',
  createdAt: NOW - 86400000,
  updatedAt: NOW,
  lastActiveAt: NOW - 3600000,
  leftAt: NOW - 3600000,
  readyAt: null,
  arrivedAt: null,
  contexts: [],
  snapshot: null,
  msOnTrack: 900000,
  ...extra,
});

const seeded = {
  schemaVersion: 1,
  createdAt: NOW - 700000000,
  locomotive: { trackId: 'a', sinceAt: NOW - 900000 },
  tracks: {
    a: t('a', 'Portfolio', {
      destination: 'Finish deposit-flow case study',
      currentStop: 'Write deposit-flow results',
      status: 'active',
      leftBecause: null,
      leftAt: NOW - 10800000,
      lastActiveAt: NOW - 900000,
      snapshot: { takenAt: NOW - 3600000, tabs: [{ url: 'https://figma.com', title: 'Figma', active: true }] },
    }),
    b: t('b', 'PMO', { currentStop: 'Test guest → registered UID', status: 'ready', readyAt: NOW - 300000 }),
    c: t('c', 'Chance', { currentStop: 'Review Rampage implementation', status: 'ai_working', leftBecause: 'ai' }),
    d: t('d', 'Job application', {
      currentStop: 'Need referral from Sam before the cover letter',
      status: 'waiting',
      leftBecause: 'waiting',
    }),
    e: t('e', 'Taxes', { currentStop: 'Waiting on the 1099 from Stripe', leftBecause: 'blocked' }),
  },
  order: ['a', 'b', 'c', 'd', 'e'],
  history: [],
  settings: { observe: true, motion: 'full', restoreTabs: 'ask' },
  onboardedAt: NOW - 700000000,
};

// --- run -------------------------------------------------------------------

const CHROME = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
].find((p) => p && fs.existsSync(p));
const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const errors = [];

async function openPanel(seed, { dark = false } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 380, height: 800 },
    deviceScaleFactor: 2,
    colorScheme: dark ? 'dark' : 'light',
    reducedMotion: 'no-preference',
  });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  if (seed) {
    const initialSeed = structuredClone(seed);
    initialSeed.settings = { ...initialSeed.settings, theme: dark ? 'nighttime' : initialSeed.settings?.theme || 'daytime' };
    await page.addInitScript((s) => (window.__SEED__ = s), initialSeed);
  }
  await page.goto('http://localhost:8899/ext/sidepanel/_preview.html');
  await page.waitForTimeout(500);
  return { ctx, page };
}

const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

// 1. First run
{
  const { ctx, page } = await openPanel(null);
  const firstTheme = await page.getAttribute('html', 'data-theme');
  const wordmark = await page.textContent('.wordmark span');
  if (firstTheme !== 'nighttime') throw new Error('Fresh installs should start in nighttime mode');
  if (wordmark !== 'TRAIN OF THOUGHT') throw new Error('Updated extension name is not visible');
  await shot(page, '01-empty');
  await page.fill('#first-name', 'Portfolio');
  await page.click('#first-go');
  await page.waitForTimeout(1400);
  await shot(page, '02-first-track');
  await ctx.close();
}

// 2. A populated yard, light and dark
{
  const { ctx, page } = await openPanel(seeded);
  await shot(page, '03-yard-light');
  const box = await page.locator('.loco').boundingBox();
  console.log('loco at', box);
  await ctx.close();
}
{
  const { ctx, page } = await openPanel(seeded, { dark: true });
  await shot(page, '04-yard-dark');
  const currentStopHeader = await page.locator('.now-current').textContent();
  if (!currentStopHeader.toLowerCase().includes('current stop') || !currentStopHeader.toLowerCase().includes('on track · 15m')) {
    throw new Error(`Current Stop header is wrong: ${currentStopHeader}`);
  }
  if (await page.locator('.now-restore').count()) throw new Error('Removed tab snapshot UI is still visible');
  if ((await page.locator('.now-actions .action-icon').count()) !== 3) throw new Error('Action icons are missing');
  if ((await page.locator('.now-actions .btn-quiet').count()) < 3) throw new Error('Top actions do not share the quiet style');
  const statusAlignment = await page.evaluate(() => {
    const group = document.querySelector('.track-label-group[data-id="b"]');
    const status = group.querySelector('.lbl-status');
    const a = group.getBoundingClientRect();
    const b = status.getBoundingClientRect();
    return Math.round(a.right - b.right);
  });
  if (statusAlignment > 6) throw new Error(`Track status is not right-aligned: ${statusAlignment}px gap`);
  const idleMotion = await page.evaluate(() => ({
    loco: getComputedStyle(document.querySelector('.loco-idle')).animationName,
    rail: getComputedStyle(document.querySelector('.row.is-active .sleepers')).animationName,
    wheel: getComputedStyle(document.querySelector('.loco .wheel')).animationName,
    glint: getComputedStyle(document.querySelector('.row.is-active .railhead')).animationName,
    direction: document.querySelector('.loco-direction').getAttribute('transform'),
  }));
  if ([idleMotion.loco, idleMotion.rail, idleMotion.wheel, idleMotion.glint].some((name) => name === 'none')) {
    throw new Error(`The active locomotive and track are not moving: ${JSON.stringify(idleMotion)}`);
  }
  if (idleMotion.direction !== 'scale(-1 1)') {
    throw new Error(`The locomotive is not facing left-to-right: ${JSON.stringify(idleMotion)}`);
  }
  await page.click('.details-track[data-id="a"]');
  const detailStyle = await page.evaluate(() => {
    const name = document.querySelector('.details-heading h2');
    return { nameColor: getComputedStyle(name).color };
  });
  if (detailStyle.nameColor === 'rgb(0, 0, 0)') throw new Error('Track Details title is black in nighttime mode');
  if (await page.locator('.track-stats').count()) throw new Error('Unhelpful Track Details stats are still visible');
  await page.click('#details-delete');
  const toastStyle = await page.locator('.toast').evaluate((el) => ({
    background: getComputedStyle(el).backgroundColor,
    color: getComputedStyle(el).color,
  }));
  if (toastStyle.background === 'rgb(247, 243, 234)' || toastStyle.background === 'rgb(255, 255, 255)') {
    throw new Error(`Undo toast is still light in nighttime mode: ${JSON.stringify(toastStyle)}`);
  }
  await page.click('.toast button');
  await ctx.close();
}

// 3. The switch flow, including a mid-animation frame
{
  const { ctx, page } = await openPanel(seeded);
  await page.click('[data-act="switch"]');
  await page.waitForTimeout(320);
  if (!(await page.locator('[data-dest="__depot__"] .dest-shed').count())) throw new Error('Park destination shed icon is missing');
  if (await page.locator('[data-dest="__depot__"] .dest-stop').count()) throw new Error('Park destination helper text was not removed');
  await shot(page, '05-switch-sheet');

  await page.click('.chip[data-reason="ai"]');
  await page.focus('#sw-stop');
  await page.keyboard.press('Shift+Enter');
  const multilineStop = await page.inputValue('#sw-stop');
  console.log('shift+enter newline:', multilineStop.includes('\n') ? 'OK' : 'BAD');
  if (!multilineStop.includes('\n')) throw new Error('Shift+Enter did not add a newline to the pickup note');
  await page.click('[data-dest="d"]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.rail-svg.is-moving');
  const bladeFirst = await page.evaluate(() => ({
    blade: !!document.querySelector('.blade.is-thrown'),
    running: document.querySelector('.rail-svg').classList.contains('is-running'),
    wheel: getComputedStyle(document.querySelector('.loco .wheel')).animationName,
  }));
  if (!bladeFirst.blade || bladeFirst.running || bladeFirst.wheel.includes('wheel-roll')) {
    throw new Error(`The switch blade did not move before the locomotive: ${JSON.stringify(bladeFirst)}`);
  }
  await page.waitForSelector('.rail-svg.is-running');
  const runningMotion = await page.evaluate(() => ({
    wheel: getComputedStyle(document.querySelector('.loco .wheel')).animationName,
    rod: getComputedStyle(document.querySelector('.loco .rod')).animationName,
  }));
  if (!runningMotion.wheel.includes('wheel-roll') || !runningMotion.rod.includes('rod-pump')) {
    throw new Error(`Travel mechanics are not animated: ${JSON.stringify(runningMotion)}`);
  }
  // Sample the run so the arc through the turnouts can actually be inspected.
  for (const [i, ms] of [180, 160, 160, 200].entries()) {
    await page.waitForTimeout(ms);
    await shot(page, `06-switch-f${i + 1}`);
  }
  await page.waitForTimeout(1400);
  await shot(page, '07-switch-done');

  const portfolioStop = await page.locator('.event-marker.marker-stop[data-id="a"].is-latest').textContent();
  if (!portfolioStop.includes('Write deposit-flow results') || portfolioStop.includes('AI working')) {
    throw new Error('Stop marker does not show a note independently from track status');
  }
  await page.click('.event-marker.marker-stop[data-id="a"].is-latest');
  const focusedStop = await page.locator('.marker-inspect-text').textContent();
  if (!focusedStop.includes('Write deposit-flow results')) throw new Error('Stop marker did not open its inspector');
  await page.keyboard.press('Escape');

  const after = await page.evaluate(async () => {
    const got = await chrome.storage.local.get('ty');
    return {
      loco: got.ty.locomotive.trackId,
      portfolio: {
        status: got.ty.tracks.a.status,
        stop: got.ty.tracks.a.currentStop,
        left: !!got.ty.tracks.a.leftAt,
        eventTypes: got.ty.tracks.a.events.map((event) => event.type),
      },
      job: got.ty.tracks.d.status,
      markersVisible: [...document.querySelectorAll('.marker')].filter((m) => !m.classList.contains('is-hidden')).length,
    };
  });
  console.log('after switch:', JSON.stringify(after));
  if (!after.portfolio.eventTypes.includes('switch') || !after.portfolio.eventTypes.includes('ride') || !after.portfolio.eventTypes.includes('stop')) {
    throw new Error('Switch, ride, and Stop events were not written to Track history');
  }
  await ctx.close();
}

// 4. Laying a new track
{
  const { ctx, page } = await openPanel(seeded);
  await page.click('#btn-new');
  await page.waitForTimeout(250);
  await page.fill('#nt-name', 'Birthday party');
  await page.fill('#nt-dest', 'Book the venue');
  await shot(page, '08-new-track-sheet');
  await page.click('#nt-go');
  await page.waitForTimeout(400);
  await shot(page, '09-laying-rail');
  await page.waitForTimeout(1800);
  await shot(page, '10-new-track-done');
  await ctx.close();
}

// 5. Signals, settings, arrival
{
  const { ctx, page } = await openPanel(seeded);
  await page.click('.row[data-id="c"] .signal .sig-hit');
  await page.waitForTimeout(400);
  const aspect = await page.getAttribute('.row[data-id="c"] .signal', 'class');
  console.log('chance signal after tap:', aspect);
  await shot(page, '11-marked-ready');

  await page.click('#btn-settings');
  await page.waitForTimeout(250);
  if (await page.locator('text=Choose the light in the yard.').count()) throw new Error('Removed theme subtext is still visible');
  if (await page.locator('.data-details').evaluate((el) => el.open)) throw new Error('Your data should start collapsed');
  await page.click('.data-details summary');
  if (!(await page.locator('.data-details').evaluate((el) => el.open))) throw new Error('Your data did not expand');
  await shot(page, '12-settings');
  await page.click('[data-theme="nighttime"]');
  await page.waitForTimeout(150);
  const theme = await page.getAttribute('html', 'data-theme');
  console.log('theme toggle:', theme, theme === 'nighttime' ? 'OK' : 'BAD');
  if (theme !== 'nighttime') throw new Error('Nighttime setting did not apply');
  await shot(page, '12b-settings-nighttime');
  await page.keyboard.press('Escape');

  await page.click('[data-act="arrived"]');
  await page.waitForTimeout(1600);
  await shot(page, '13-arrived');
  await page.click('#btn-arrivals');
  if ((await page.locator('.details-heading .eyebrow').textContent()).trim().toLowerCase() !== 'arrivals') {
    throw new Error('Arrivals sheet eyebrow is not ARRIVALS');
  }
  if (await page.locator('.details-heading h2').count()) throw new Error('Redundant Arrivals title is still visible');
  const arrivalText = await page.locator('.arrival-row[data-arrival-id="a"]').textContent();
  if (!arrivalText.includes('Portfolio')) throw new Error('Arrived track is missing from Arrivals');
  await page.click('.arrival-row[data-arrival-id="a"]');
  const arrivalHistory = (await page.locator('.episode-track').textContent()).toLowerCase();
  if (!arrivalHistory.includes('track started') || !arrivalHistory.includes('arrived')) {
    throw new Error('Arrivals did not preserve the cognitive timeline');
  }
  await shot(page, '13b-arrival-details');
  await ctx.close();
}

// 5b. Regressions from the code review — these are the ones worth asserting.
{
  const { ctx, page } = await openPanel(seeded);

  // Double-clicking "arrived" during its ~1s departure must not double-file it.
  await page.click('[data-act="arrived"]');
  await page.click('[data-act="arrived"]', { force: true }).catch(() => {});
  await page.waitForTimeout(1800);
  const hist = await page.evaluate(async () => (await chrome.storage.local.get('ty')).ty.history);
  console.log('history after double-click arrive:', JSON.stringify(hist), hist.length === 1 ? 'OK' : 'DUPLICATED');

  // Stops are one durable current re-entry point, not an accumulating flag archive.
  // The engine is in the shed after the arrival, so there is nothing to park and
  // the label click resumes directly without the switch sheet.
  await page.click('.track-title[data-id="b"] .lbl-name');
  await page.waitForTimeout(1800);
  const resumed = await page.evaluate(async () => ({
    loco: (await chrome.storage.local.get('ty')).ty.locomotive.trackId,
    stops: (await chrome.storage.local.get('ty')).ty.tracks.b.events.filter((event) => event.type === 'stop').length,
    svgFlags: document.querySelectorAll('.marker').length,
  }));
  console.log(
    'after resume:',
    JSON.stringify(resumed),
    resumed.loco === 'b' && resumed.stops === 1 && resumed.svgFlags === 0 ? 'OK' : 'BAD'
  );
  if (resumed.stops !== 1 || resumed.svgFlags !== 0) throw new Error('Stops still behave like accumulating flag markers');
  await shot(page, '15-resumed');

  // The shed drawing and its label both expose the same park action. The label
  // is the easier target at narrow widths, so exercise that path here.
  await page.click('.depot-label');
  const depotSelected = await page.locator('[data-dest="__depot__"]').evaluate((el) => el.classList.contains('is-selected'));
  console.log('shed click selects park:', depotSelected ? 'OK' : 'BAD');
  if (!depotSelected) throw new Error('Clicking the shed did not preselect park');
  await page.click('#sw-go');
  await page.waitForSelector('.depot.is-open');
  const shedDoors = await page.evaluate(() => ({
    left: document.querySelector('.shed-door-left').getAttribute('transform'),
    right: document.querySelector('.shed-door-right').getAttribute('transform'),
  }));
  if (shedDoors.left === 'translate(0 0)' || shedDoors.right === 'translate(0 0)') {
    throw new Error(`The shed doors did not open for parking: ${JSON.stringify(shedDoors)}`);
  }
  await page.waitForTimeout(1800);
  const parked = await page.evaluate(async () => (await chrome.storage.local.get('ty')).ty.locomotive.trackId);
  console.log('shed enter parks:', parked === null ? 'OK' : 'BAD');
  if (parked !== null) throw new Error('The switch sheet Enter button did not park the locomotive');
  await ctx.close();
}

// 6. Stops, Notes, inline editing, fixed order, details, and recoverable delete
{
  const plain = structuredClone(seeded);
  plain.tracks.a.currentStop = '';
  const { ctx, page } = await openPanel(plain);
  await page.click('[data-act="switch"]');
  await page.click('[data-dest="b"]');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1400);
  const plainSwitch = await page.evaluate(async () => {
    const track = (await chrome.storage.local.get('ty')).ty.tracks.a;
    return {
      visibleStop: !!document.querySelector('.event-marker.marker-stop[data-id="a"]'),
      events: track.events.map((event) => event.type),
    };
  });
  if (plainSwitch.visibleStop || !plainSwitch.events.includes('switch') || plainSwitch.events.includes('stop')) {
    throw new Error('Plain switching should log a switch without creating a visible Stop');
  }
  await ctx.close();
}

{
  const { ctx, page } = await openPanel(seeded);
  // The current track's key fields edit in place, and not in Track Details.
  await page.click('#now-name-btn');
  await page.fill('input.now-name', 'Portfolio review');
  await page.press('input.now-name', 'Enter');
  await page.click('#now-dest-btn');
  await page.fill('input.now-dest', 'Publish the case study');
  await page.press('input.now-dest', 'Enter');
  await page.click('#stop-btn');
  await page.fill('textarea.now-stop', 'Tighten the results section');
  await page.press('textarea.now-stop', 'Enter');
  await page.waitForTimeout(250);
  const inline = await page.evaluate(async () => {
    const track = (await chrome.storage.local.get('ty')).ty.tracks.a;
    return { name: track.name, destination: track.destination, stop: track.currentStop };
  });
  if (
    inline.name !== 'Portfolio review' ||
    inline.destination !== 'Publish the case study' ||
    inline.stop !== 'Tighten the results section'
  ) {
    throw new Error(`Inline current-track editing failed: ${JSON.stringify(inline)}`);
  }

  // Build enough history to prove the yard caps markers while preserving all
  // events in the track timeline.
  for (const text of ['Remember the API edge case', 'Check empty state', 'Ask Maya about copy', 'Verify mobile width']) {
    await page.click('.add-note[data-id="c"]');
    await page.fill('#note-text', text);
    await page.click('#note-save');
    await page.waitForTimeout(120);
  }
  const markerCounts = {
    total: await page.locator('.event-marker[data-id="c"]').count(),
    latest: await page.locator('.event-marker[data-id="c"].is-latest').count(),
    compact: await page.locator('.event-marker[data-id="c"].is-compact').count(),
  };
  if (markerCounts.total !== 4 || markerCounts.latest !== 1 || markerCounts.compact !== 3) {
    throw new Error(`Marker cap or hierarchy is wrong: ${JSON.stringify(markerCounts)}`);
  }
  await page.locator('.event-marker[data-id="c"].is-compact').first().hover();
  const compactReveal = await page.locator('.event-marker[data-id="c"].is-compact').first().locator('time').evaluate(
    (time) => getComputedStyle(time).display
  );
  if (compactReveal !== 'block') throw new Error('Older marker hover did not reveal its timestamp');
  await page.click('.event-marker.marker-note[data-id="c"].is-latest');
  if (!(await page.locator('.marker-inspect-text').textContent()).includes('Verify mobile width')) {
    throw new Error('Note marker did not open its inspector');
  }
  await page.click('#marker-continue');
  await page.click('#sw-go');
  await page.waitForTimeout(1500);
  const continued = await page.evaluate(async () => {
    const next = (await chrome.storage.local.get('ty')).ty;
    return { active: next.locomotive.trackId, stop: next.tracks.c.currentStop, order: next.order };
  });
  if (
    continued.active !== 'c' ||
    continued.stop !== 'Verify mobile width' ||
    continued.order.join(',') !== seeded.order.join(',')
  ) {
    throw new Error(`Continue from Note failed: ${JSON.stringify(continued)}`);
  }

  await page.click('.event-marker.marker-note[data-id="c"].is-latest');
  await page.click('#marker-resolve');
  await page.waitForTimeout(200);
  const resolved = await page.evaluate(async () => {
    const events = (await chrome.storage.local.get('ty')).ty.tracks.c.events;
    return events.filter((event) => event.type === 'note').map((event) => event.text);
  });
  if (resolved.includes('Verify mobile width') || (await page.locator('.event-marker.marker-note[data-id="c"]').allTextContents()).join(' ').includes('Verify mobile width')) {
    throw new Error('Resolving a Note did not remove it');
  }

  if (!(await page.locator('.drag-track').count())) throw new Error('Track reorder handles are missing');
  await page.click('.details-track[data-id="c"]');
  if (await page.locator('.details-heading input').count()) throw new Error('Editing is still buried in Track Details');
  const episodeText = (await page.locator('.episode-track').textContent()).toLowerCase();
  if (!episodeText.includes('note:') || episodeText.includes('status changed')) {
    throw new Error(`Track Details is not a meaningful railway timeline: ${episodeText}`);
  }
  await page.waitForTimeout(250);
  await shot(page, '16a-cognitive-timeline');
  await page.click('#details-delete');
  await page.waitForTimeout(250);
  if (await page.evaluate(async () => !!(await chrome.storage.local.get('ty')).ty.tracks.c)) throw new Error('Delete did not remove track');
  await page.click('.toast button');
  await page.waitForTimeout(250);
  if (!(await page.evaluate(async () => !!(await chrome.storage.local.get('ty')).ty.tracks.c))) throw new Error('Delete undo did not restore track');
  await shot(page, '16-notes-fixed-order');
  await ctx.close();
}

// 7. Ten active tracks use vertical space rather than squeezing the rails.
{
  const { ctx, page } = await openPanel(seeded, { dark: true });

  const geometry = await page.evaluate(() => {
    const rail = document.querySelector('.row[data-id="a"] .rail').getBoundingClientRect();
    const title = document.querySelector('.track-label-group[data-id="a"]').getBoundingClientRect();
    const marker = document.querySelector('.event-marker[data-id="a"]').getBoundingClientRect();
    const loco = document.querySelector('.loco').getBoundingClientRect();
    return { railY: rail.top, titleTop: title.top, markerBottom: marker.bottom, locoLeft: loco.left };
  });
  if (geometry.titleTop <= geometry.railY || geometry.markerBottom > geometry.railY + 2 || geometry.locoLeft > 62) {
    throw new Error(`Rail content geometry is wrong: ${JSON.stringify(geometry)}`);
  }
  if ((await page.locator('.track-label-group[data-id="c"] .lbl-status').textContent()).trim()) {
    throw new Error('Parked/AI track still displays a status label');
  }

  // Every signal cycles neutral → waiting → ready → neutral, including active.
  for (const id of ['a', 'c']) {
    const expected = ['aspect-caution', 'aspect-ready', 'aspect-off'];
    for (const className of expected) {
      await page.click(`.row[data-id="${id}"] .sig-hit`);
      await page.waitForTimeout(80);
      const cls = await page.getAttribute(`.row[data-id="${id}"] .signal`, 'class');
      if (!cls.includes(className)) throw new Error(`Signal ${id} did not cycle to ${className}: ${cls}`);
    }
  }

  // Timeboxes run only on the active track and can be paused without deleting.
  await page.click('[data-act="timebox"]');
  await page.fill('#timebox-minutes', '15');
  await page.click('#timebox-save');
  await page.waitForTimeout(1100);
  const timerRunning = await page.evaluate(async () => (await chrome.storage.local.get('ty')).ty.tracks.a.timebox);
  if (!timerRunning?.runningSince || timerRunning.durationMs !== 900000 || timerRunning.elapsedMs < 0) {
    throw new Error(`Timebox did not start correctly: ${JSON.stringify(timerRunning)}`);
  }
  await page.click('[data-act="timebox-toggle"]');
  const timerPaused = await page.evaluate(async () => (await chrome.storage.local.get('ty')).ty.tracks.a.timebox);
  if (timerPaused.runningSince || timerPaused.elapsedMs < 900) throw new Error(`Timebox did not pause: ${JSON.stringify(timerPaused)}`);

  // A branch is laid under its parent; resolving the active branch returns home.
  await page.click('[data-act="branch"]');
  await page.fill('#branch-name', 'Check one assumption');
  await page.fill('#branch-destination', 'Choose an approach');
  await page.click('#branch-save');
  await page.waitForTimeout(1700);
  const branched = await page.evaluate(async () => {
    const next = (await chrome.storage.local.get('ty')).ty;
    const branch = Object.values(next.tracks).find((track) => track.parentId === 'a' && track.status !== 'arrived');
    return { active: next.locomotive.trackId, id: branch?.id, parentId: branch?.parentId, order: next.order };
  });
  if (!branched.id || branched.active !== branched.id || branched.parentId !== 'a' || branched.order.indexOf(branched.id) !== branched.order.indexOf('a') + 1) {
    throw new Error(`Branch creation failed: ${JSON.stringify(branched)}`);
  }
  if (!(await page.locator(`.track-label-group[data-id="${branched.id}"].is-branch`).count())) throw new Error('Branch is not visually nested');
  await shot(page, '18-branch-and-timebox');
  await page.click('[data-act="resolve-branch"]');
  await page.waitForTimeout(1800);
  const resolvedBranch = await page.evaluate(async (id) => {
    const next = (await chrome.storage.local.get('ty')).ty;
    return { active: next.locomotive.trackId, status: next.tracks[id].status, inYard: next.order.includes(id) };
  }, branched.id);
  if (resolvedBranch.active !== 'a' || resolvedBranch.status !== 'arrived' || resolvedBranch.inYard) {
    throw new Error(`Resolving a branch did not return to its parent: ${JSON.stringify(resolvedBranch)}`);
  }
  await ctx.close();
}

{
  const { ctx, page } = await openPanel(seeded);
  // Inactive tracks can arrive without first stealing the locomotive.
  await page.click('.arrive-track[data-id="b"]');
  await page.waitForTimeout(160);
  const inactiveArrival = await page.evaluate(async () => {
    const next = (await chrome.storage.local.get('ty')).ty;
    return { active: next.locomotive.trackId, status: next.tracks.b.status, inYard: next.order.includes('b') };
  });
  if (inactiveArrival.active !== 'a' || inactiveArrival.status !== 'arrived' || inactiveArrival.inYard) {
    throw new Error(`Inactive arrival failed: ${JSON.stringify(inactiveArrival)}`);
  }

  // Reordering is explicit and persists; there is no recency auto-sort.
  await page.locator('.drag-track[data-id="d"]').dragTo(page.locator('.track-label-group[data-id="a"]'));
  await page.waitForTimeout(220);
  const reordered = await page.evaluate(async () => (await chrome.storage.local.get('ty')).ty.order);
  if (reordered[0] !== 'd') throw new Error(`Drag reorder did not persist: ${JSON.stringify(reordered)}`);
  await ctx.close();
}

// 8. Ten active tracks use vertical space rather than squeezing the rails.
{
  const fullYard = structuredClone(seeded);
  for (const [id, name] of [
    ['f', 'Launch plan'],
    ['g', 'Research synthesis'],
    ['h', 'Quarterly review'],
    ['i', 'Travel planning'],
    ['j', 'Kitchen repair'],
  ]) {
    fullYard.tracks[id] = t(id, name, { currentStop: '' });
    fullYard.order.push(id);
  }
  const { ctx, page } = await openPanel(fullYard);
  const yard = await page.locator('#yard').evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
  const titleCount = await page.locator('.track-title').count();
  const addDisabled = await page.locator('#btn-new').isDisabled();
  if (titleCount !== 10 || yard.scrollHeight <= yard.clientHeight || !addDisabled) {
    throw new Error(`Ten-track yard failed: ${JSON.stringify({ titleCount, yard, addDisabled })}`);
  }
  await page.locator('.track-title[data-id="j"]').scrollIntoViewIfNeeded();
  await shot(page, '17-ten-track-scroll');
  await ctx.close();
}

// 9. Narrow panel: Chrome lets users drag the side panel quite thin
{
  const { ctx, page } = await openPanel(seeded);
  await page.setViewportSize({ width: 260, height: 700 });
  await page.waitForTimeout(400);
  await shot(page, '14-narrow');
  await ctx.close();
}

await browser.close();
server.close();
fs.rmSync(path.join(EXT, 'sidepanel', '_preview.html'), { force: true });

if (errors.length) {
  console.error('\n--- ERRORS ---');
  for (const e of errors) console.error(e);
  process.exit(1);
}
console.log('\nno console errors. shots in', SHOTS);
