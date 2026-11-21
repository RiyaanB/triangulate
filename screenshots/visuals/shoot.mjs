// Visual screenshot driver for the "visuals" session.
// usage: node screenshots/visuals/shoot.mjs <outdir> [--base http://localhost:9137] [--only d|m] [--qs theme=x] [--fast] [--live]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const out = path.resolve(args[0] || 'screenshots/visuals/cur');
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes('--' + k);
const base = opt('base', 'http://localhost:9137');
const qs = opt('qs', '');
const only = opt('only', '');
fs.mkdirSync(out, { recursive: true });

const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
const MOBILE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true };

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];

async function waitPhase(page, ps, timeout = 90000) {
  const h = await page.waitForFunction((ps) => (ps.includes(window.__tri.phase) ? window.__tri.phase : null), ps, { timeout, polling: 50 });
  return h.jsonValue();
}
const oracle = (page) => page.evaluate(() => { const m = window.__tri.conn?.room?.clue?.meta; return m ? { lat: m.lat, lon: m.lon } : null; });
async function tap(page, lat, lon, mobile) {
  const pt = await page.evaluate(([lat, lon]) => {
    const m = window.__triMap; const r = m.canvas.getBoundingClientRect();
    const [x, y] = m.sp(lat, lon);
    return { x: r.left + x, y: r.top + y };
  }, [lat, lon]);
  if (mobile) await page.touchscreen.tap(pt.x, pt.y); else await page.mouse.click(pt.x, pt.y);
}

async function run(kind) {
  const mobile = kind === 'm';
  const ctx = await browser.newContext(mobile ? MOBILE : DESKTOP);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(kind + ': ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(kind + ' console: ' + m.text()); });
  const shot = (n) => page.screenshot({ path: path.join(out, `${kind}-${n}.png`) });
  const speed = flag('fast') ? 3 : 1;
  await page.goto(`${base}/?speed=${speed}${qs ? '&' + qs : ''}`);
  await page.waitForTimeout(1600);
  await shot('01-title');
  if (flag('title')) { await ctx.close(); return; }
  if (flag('live')) {
    await (mobile ? page.tap('#btn-play') : page.click('#btn-play'));
    await page.waitForTimeout(2500);
    await shot('02-lobby');
    await ctx.close(); return;
  }
  await (mobile ? page.tap('#btn-solo') : page.click('#btn-solo'));
  await waitPhase(page, ['intro']);
  await page.waitForTimeout(500);
  await shot('02-intro');
  for (let s = 1; s <= 4; s++) {
    await page.waitForFunction((s) => window.__tri.stage >= s, s, { timeout: 60000, polling: 50 });
    await page.waitForTimeout(s === 1 ? 700 : 400);
    if (s === 2) await shot(`03-stage${s}-mid`);
    await page.waitForTimeout(1500);
    await shot(`03-stage${s}`);
    if (s === 3) {
      const a = await oracle(page);
      await tap(page, a.lat + 1.5, a.lon - 2, mobile);
      await page.waitForTimeout(500);
      await shot('04-pin');
    }
  }
  await (mobile ? page.tap('#btn-lock') : page.click('#btn-lock'));
  await page.waitForTimeout(250);
  await shot('05-locked');
  await waitPhase(page, ['reveal']);
  await page.waitForTimeout(1200);
  await shot('06-reveal-a');
  await page.waitForTimeout(1800);
  await shot('06-reveal-b');
  await waitPhase(page, ['standings']);
  await page.waitForTimeout(900);
  await shot('07-standings');
  if (flag('short')) { await ctx.close(); return; }
  // play remaining rounds fast with oracle to reach the winner screen
  for (;;) {
    const ph = await waitPhase(page, ['round', 'over'], 120000);
    if (ph === 'over') break;
    await page.waitForFunction(() => window.__tri.stage >= 1, null, { timeout: 60000 });
    const a = await oracle(page);
    if (a && (await page.evaluate(() => window.__tri.alive))) {
      await page.evaluate(() => window.__triMap.fitWorld(false));
      await page.waitForTimeout(80);
      await tap(page, a.lat + 0.3, a.lon + 0.3, mobile);
      await page.waitForTimeout(120);
      await (mobile ? page.tap('#btn-lock') : page.click('#btn-lock'));
    }
    const r = await page.evaluate(() => window.__tri.round);
    const p2 = await waitPhase(page, ['standings', 'over'], 120000);
    if (p2 === 'over') break;
    if (r === 2) { await page.waitForTimeout(700); await shot('08-standings-r2'); }
  }
  await page.waitForTimeout(600);
  await shot('09-over-a');
  await page.waitForTimeout(1600);
  await shot('09-over-b');
  await ctx.close();
}

try {
  if (only !== 'm') await run('d');
  if (only !== 'd') await run('m');
} catch (e) { errors.push('driver: ' + e.message); }
await browser.close();
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'ok, no page errors');
