// Single-file CrazyGames build test: node tests/single-e2e.mjs [dir=dist/crazygames-single]
// (derived from portal-e2e) Asserts dir holds exactly one file (index.html), serves ONLY that dir on 127.0.0.1, then on
// desktop (1280x800) + phone (390x844): loads to title, page is UTF-8, starts a bots match and plays it to 'over'.
// Fails on any console error / page error / failed request, and on any request to the local server other than
// index.html (= a leftover relative reference). CrazyGames SDK (remote; offline or "local" mode here) noise is only
// noted. Shots -> SHOTS_DIR/single-*.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.resolve(process.env.SHOTS_DIR || 'screenshots/core');
const SPEED = Number(process.env.TEST_SPEED) || 4;
fs.mkdirSync(SHOTS, { recursive: true });

async function serve(dir, port) {
  const py = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '-d', dir], { stdio: 'ignore' });
  await new Promise((res, rej) => { let n = 0; const probe = () => http.get(`http://127.0.0.1:${port}/index.html`, (r) => { r.resume(); res(); }).on('error', () => (++n > 50 ? rej(new Error('no server')) : setTimeout(probe, 100))); probe(); });
  return () => py.kill();
}
async function playToEnd(page, mobile) {
  let rounds = 0;
  for (let i = 0; i < 1500; i++) {
    const st = await page.evaluate(() => ({ ph: window.__tri.phase, stage: window.__tri.stage, lock: window.__tri.myLock, alive: window.__tri.alive, round: window.__tri.round }));
    if (st.ph === 'over') return rounds;
    rounds = Math.max(rounds, st.round);
    if (st.ph === 'round' && st.alive && !st.lock && st.stage >= 1) {
      const ans = await page.evaluate(() => { const m = window.__tri.conn?.room?.clue?.meta; return m && [m.lat + 0.3, m.lon + 0.3]; });
      if (ans) {
        const pt = await page.evaluate(([la, lo]) => { const m = window.__triMap; m.fitWorld(false); const r = m.canvas.getBoundingClientRect(); const [x, y] = m.sp(la, lo); return { x: r.left + x, y: r.top + y }; }, ans);
        await page.waitForTimeout(60);
        if (mobile) await page.touchscreen.tap(pt.x, pt.y); else await page.mouse.click(pt.x, pt.y);
        await page.waitForTimeout(60);
        if (await page.evaluate(() => !!window.__tri.myPin)) await page.evaluate(() => document.querySelector('#btn-lock').click());
      }
    }
    await page.waitForTimeout(200);
  }
  throw new Error('match did not finish');
}

const DIR = path.resolve(process.argv[2] || path.join(ROOT, 'dist/crazygames-single'));
const errors = [], notes = [], warnings = [];
const listing = fs.readdirSync(DIR);
if (listing.length !== 1 || listing[0] !== 'index.html' || !fs.statSync(path.join(DIR, 'index.html')).isFile()) {
  console.error(`ERROR: ${DIR} must contain exactly one file, index.html (found: ${listing.join(', ') || 'nothing'})`); process.exit(1);
}
console.log(`  [single] ${DIR}: index.html ${(fs.statSync(path.join(DIR, 'index.html')).size / 1048576).toFixed(2)} MB, TEST_SPEED=${SPEED}`);
const browser = await chromium.launch({ executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined, headless: true });
const stop = await serve(DIR, 9493);
const base = 'http://127.0.0.1:9493';
for (const dev of [
  { tag: 'desktop', opts: { viewport: { width: 1280, height: 800 } }, mobile: false },
  { tag: 'phone', opts: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, mobile: true },
]) {
  const tag = 'single-' + dev.tag;
  const ctx = await browser.newContext(dev.opts);
  const p = await ctx.newPage();
  const sdk = (u) => /sdk\.crazygames\.com/.test(u);
  p.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') { if (sdk(m.location().url || '') || /crazygames/i.test(m.text())) notes.push(`${tag} (sdk/offline) ${m.type()}: ${m.text()}`); else if (m.type() === 'error') errors.push(`${tag} console: ${m.text()}`); else warnings.push(`${tag} warning: ${m.text()}`); } });
  p.on('requestfailed', (r) => (sdk(r.url()) ? notes : errors).push(`${tag} reqfail: ${r.url()}`));
  const reqs = new Set(); p.on('request', (r) => { if (!r.url().startsWith('data:')) reqs.add(r.url()); });
  await p.goto(`${base}/index.html?speed=${SPEED}`, { waitUntil: 'load' });
  await p.waitForFunction(() => !!window.__triMap, null, { timeout: 15000 });
  await p.waitForTimeout(1500);
  const enc = await p.evaluate(() => ({ cs: document.characterSet, dice: document.getElementById('dice').textContent, title: document.title, active: document.querySelector('.screen.active')?.id }));
  if (enc.cs !== 'UTF-8' || enc.dice !== '\u{1F3B2}' || !enc.title.includes('\u2014')) errors.push(`${tag}: page not decoded as UTF-8 (${JSON.stringify(enc)})`);
  if (enc.active !== 'scr-title') errors.push(`${tag}: title screen not active (${enc.active})`);
  await p.screenshot({ path: path.join(SHOTS, `${tag}-title.png`) });
  if (dev.mobile) await p.tap('#btn-play'); else await p.click('#btn-play');
  await p.waitForFunction(() => window.__tri.phase === 'round' && window.__tri.stage >= 2, null, { timeout: 60000 });
  await p.screenshot({ path: path.join(SHOTS, `${tag}-round.png`) });
  const rounds = await playToEnd(p, dev.mobile);
  await p.screenshot({ path: path.join(SHOTS, `${tag}-over.png`) });
  if (!(await p.evaluate(() => document.getElementById('scr-over').classList.contains('active')))) errors.push(`${tag}: game-over screen not shown`);
  const local = [...reqs].filter((u) => u.startsWith(base) && new URL(u).pathname !== '/index.html');
  if (local.length) errors.push(`${tag}: local requests besides index.html: ${local.join(' ')}`);
  console.log(`  [single] ${tag}: match finished, rounds=${rounds}, requests=${[...reqs].join(' ')}`);
  await ctx.close();
}
stop(); await browser.close();
notes.forEach((n) => console.log('  note:', n));
warnings.forEach((n) => console.log('  warn:', n));
if (errors.length) { console.error('ERRORS:\n' + errors.join('\n')); process.exit(1); }
console.log('single-file e2e OK, 0 console errors');
