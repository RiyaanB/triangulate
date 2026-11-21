#!/usr/bin/env node
// Final screenshot pass: live server + static docs/ build, desktop 1440x900 and phone 390x844.
//   node tools/shoot-final.mjs [--port=9183] [--static-port=9184] [--out=screenshots/core/final]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createServer } from '../server/index.js';

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1] || d;
const OUT = path.resolve(arg('out', 'screenshots/core/final'));
const PORT = Number(arg('port', 9183)), SPORT = Number(arg('static-port', 9184));
fs.mkdirSync(OUT, { recursive: true });
const VIEWS = {
  d: { viewport: { width: 1440, height: 900 } },
  m: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

async function waitFor(page, fn, arg, timeout = 60000) { return page.waitForFunction(fn, arg, { timeout, polling: 60 }); }
async function pinNear(page, mobile, jitter = 0.4) {
  const ans = await page.evaluate(() => { const m = window.__tri.conn?.room?.clue?.meta; return m && [m.lat, m.lon]; });
  const [lat, lon] = ans ? [ans[0] + jitter, ans[1] + jitter] : [20, 10];
  const pt = await page.evaluate(([la, lo]) => { const m = window.__triMap; m.fitWorld(false); const r = m.canvas.getBoundingClientRect(); const [x, y] = m.sp(la, lo); return { x: r.left + x, y: r.top + y }; }, [lat, lon]);
  await page.waitForTimeout(120);
  if (mobile) await page.touchscreen.tap(pt.x, pt.y); else await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(150);
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + '.png') });

async function soloRun(browser, base, v, prefix) {
  const ctx = await browser.newContext(VIEWS[v]);
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?speed=2`);
  await page.waitForTimeout(1200);
  await shot(page, `${prefix}${v}-01-title`);
  if (v === 'm') await page.tap('#btn-solo'); else await page.click('#btn-solo');
  await waitFor(page, () => window.__tri.phase === 'round' && window.__tri.stage >= 1);
  await page.waitForTimeout(1600);
  await shot(page, `${prefix}${v}-02-stage1`);
  await waitFor(page, () => window.__tri.stage >= 4 || window.__tri.phase !== 'round');
  await page.waitForTimeout(1800);
  await shot(page, `${prefix}${v}-03-stage4`);
  await pinNear(page, v === 'm', 0.3);
  await page.evaluate(() => document.querySelector('#btn-lock').click());
  await waitFor(page, () => window.__tri.phase === 'reveal');
  await page.waitForTimeout(2600);
  await shot(page, `${prefix}${v}-04-reveal`);
  // play the rest quickly and well
  for (let i = 0; i < 400; i++) {
    const st = await page.evaluate(() => ({ ph: window.__tri.phase, lock: window.__tri.myLock, alive: window.__tri.alive, stage: window.__tri.stage }));
    if (st.ph === 'over') break;
    if (st.ph === 'round' && st.alive && !st.lock && st.stage >= 1) { await pinNear(page, v === 'm', 0.2); await page.evaluate(() => document.querySelector('#btn-lock').click()); }
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(3500);
  await shot(page, `${prefix}${v}-05-over`);
  if (v === 'm') await page.tap('#btn-home'); else await page.click('#btn-home');
  await page.waitForTimeout(900);
  await shot(page, `${prefix}${v}-06-title-after`);
  await ctx.close();
  return errors;
}

async function liveRun(browser, base, v) {
  const ctx = await browser.newContext(VIEWS[v]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.waitForTimeout(800);
  if (v === 'm') await page.tap('#btn-play'); else await page.click('#btn-play');
  await waitFor(page, () => window.__tri.phase === 'lobby' && window.__tri.players.length > 3, 20000).catch(() => {});
  await page.waitForTimeout(600);
  await shot(page, `live-${v}-01-lobby`);
  await waitFor(page, () => window.__tri.phase === 'round' && window.__tri.stage >= 2, 90000);
  await page.waitForTimeout(1400);
  await shot(page, `live-${v}-02-round`);
  await waitFor(page, () => window.__tri.phase === 'standings', 90000);
  await page.waitForTimeout(900);
  await shot(page, `live-${v}-03-standings`);
  await ctx.close();
  return errors;
}

async function serveStatic(dir, port) {
  const py = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '-d', dir], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    let n = 0;
    const probe = () => http.get(`http://127.0.0.1:${port}/`, (r) => { r.resume(); resolve(); }).on('error', () => (++n > 50 ? reject(new Error('static server')) : setTimeout(probe, 100)));
    probe();
  });
  return py;
}

const srv = await createServer({ port: PORT, speed: 2, quiet: true });
const py = await serveStatic(path.resolve('docs'), SPORT);
const browser = await chromium.launch({ executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined, headless: true });
const errors = [];
try {
  for (const v of ['d', 'm']) {
    errors.push(...await soloRun(browser, `http://127.0.0.1:${PORT}`, v, 'solo-'));
    errors.push(...await liveRun(browser, `http://127.0.0.1:${PORT}`, v));
    errors.push(...await soloRun(browser, `http://127.0.0.1:${SPORT}`, v, 'static-'));
  }
} finally {
  await browser.close(); await srv.close(); py.kill();
}
console.log(errors.length ? 'page errors:\n' + errors.join('\n') : 'no page errors', '->', OUT);
