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

const NOW = 1755200000000;
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
      leftAt: null,
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
  if (seed) await page.addInitScript((s) => (window.__SEED__ = s), seed);
  await page.goto('http://localhost:8899/ext/sidepanel/_preview.html');
  await page.waitForTimeout(500);
  return { ctx, page };
}

const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

// 1. First run
{
  const { ctx, page } = await openPanel(null);
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
  await ctx.close();
}

// 3. The switch flow, including a mid-animation frame
{
  const { ctx, page } = await openPanel(seeded);
  await page.click('[data-act="switch"]');
  await page.waitForTimeout(320);
  await shot(page, '05-switch-sheet');

  await page.click('.chip[data-reason="ai"]');
  await page.click('[data-dest="d"]');
  // Sample the run so the arc through the turnouts can actually be inspected.
  for (const [i, ms] of [180, 160, 160, 200].entries()) {
    await page.waitForTimeout(ms);
    await shot(page, `06-switch-f${i + 1}`);
  }
  await page.waitForTimeout(1400);
  await shot(page, '07-switch-done');

  const after = await page.evaluate(async () => {
    const got = await chrome.storage.local.get('ty');
    return {
      loco: got.ty.locomotive.trackId,
      portfolio: { status: got.ty.tracks.a.status, stop: got.ty.tracks.a.currentStop, left: !!got.ty.tracks.a.leftAt },
      job: got.ty.tracks.d.status,
      markersVisible: [...document.querySelectorAll('.marker')].filter((m) => !m.classList.contains('is-hidden')).length,
    };
  });
  console.log('after switch:', JSON.stringify(after));
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
  await shot(page, '12-settings');
  await page.keyboard.press('Escape');

  await page.click('[data-act="arrived"]');
  await page.waitForTimeout(1600);
  await shot(page, '13-arrived');
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

  // Resuming a track must lift its return board rather than leaving it standing.
  // The engine is in the shed after the arrival, so there is nothing to park and
  // the label click resumes directly without the switch sheet.
  await page.click('.lbl[data-id="b"]');
  await page.waitForTimeout(1800);
  const resumed = await page.evaluate(async () => ({
    loco: (await chrome.storage.local.get('ty')).ty.locomotive.trackId,
    bMarkerHidden: document.querySelector('.row[data-id="b"] .marker').classList.contains('is-hidden'),
  }));
  console.log('after resume:', JSON.stringify(resumed), resumed.loco === 'b' && resumed.bMarkerHidden ? 'OK' : 'BAD');
  await shot(page, '15-resumed');
  await ctx.close();
}

// 6. Narrow panel — Chrome lets users drag the side panel quite thin
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
