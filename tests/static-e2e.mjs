// Static build (docs/, GitHub Pages) end-to-end: serve docs/ with a plain static file server
// (python3 -m http.server, like Pages — no game server at all), press PLAY and finish a full
// 20-player match against in-browser bots, plus a daily solo on mobile. Screenshots -> SHOTS_DIR.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const SHOTS = path.resolve(process.env.SHOTS_DIR || 'screenshots/core', 'static');
const log = (...a) => console.log('  [static]', ...a);

/** Serve a directory: python3 http.server when available (closest to Pages), else a tiny node server. */
async function serve(dir, port) {
  const py = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '-d', dir], { stdio: 'ignore' });
  const ok = await new Promise((resolve) => {
    py.on('error', () => resolve(false));
    let tries = 0;
    const probe = () => http.get(`http://127.0.0.1:${port}/index.html`, (r) => { r.resume(); resolve(r.statusCode === 200); })
      .on('error', () => (++tries > 40 ? resolve(false) : setTimeout(probe, 100)));
    probe();
  });
  if (ok) return { port, close: () => py.kill() };
  py.kill();
  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
  const srv = http.createServer((req, res) => {
    const p = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
    if (!p.startsWith(path.resolve(dir))) { res.writeHead(403); res.end(); return; }
    fs.readFile(p, (e, b) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' }); res.end(b); });
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { port, close: () => srv.close() };
}

async function playToEnd(page, { mobile = false, smart = true } = {}) {
  let rounds = 0;
  for (let i = 0; i < 1500; i++) {
    const st = await page.evaluate(() => ({ ph: window.__tri.phase, stage: window.__tri.stage, lock: window.__tri.myLock, alive: window.__tri.alive, round: window.__tri.round }));
    if (st.ph === 'over') return rounds;
    rounds = Math.max(rounds, st.round);
    if (st.ph === 'round' && st.alive && !st.lock && st.stage >= 1) {
      const ans = smart ? await page.evaluate(() => { const m = window.__tri.conn?.room?.clue?.meta; return m && [m.lat + 0.3, m.lon + 0.3]; }) : [20, 10];
      if (ans) {
        const pt = await page.evaluate(([lat, lon]) => { const m = window.__triMap; m.fitWorld(false); const r = m.canvas.getBoundingClientRect(); const [x, y] = m.sp(lat, lon); return { x: r.left + x, y: r.top + y }; }, ans);
        await page.waitForTimeout(60);
        if (mobile) await page.touchscreen.tap(pt.x, pt.y); else await page.mouse.click(pt.x, pt.y);
        await page.waitForTimeout(60);
        if (await page.evaluate(() => !!window.__tri.myPin)) await page.evaluate(() => document.querySelector('#btn-lock').click());
      }
    }
    await page.waitForTimeout(200);
  }
  throw new Error('static match did not finish');
}

export async function runStaticE2E({ root = process.cwd(), port = Number(process.env.STATIC_PORT) || 9165, speed = 4 } = {}) {
  const errors = [];
  const docs = path.join(root, 'docs');
  if (!fs.existsSync(path.join(docs, 'index.html'))) return { errors: ['docs/ missing — run npm run build:static'], results: {} };
  fs.mkdirSync(SHOTS, { recursive: true });
  const srv = await serve(docs, port);
  const base = `http://127.0.0.1:${srv.port}`;
  const browser = await chromium.launch({ executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined, headless: true });
  const results = {};
  const watch = (p, tag) => { p.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`)); p.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag} console: ${m.text()}`); }); };
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage(); watch(page, 'static-d');
    await page.goto(`${base}/?speed=${speed}`);
    await page.waitForTimeout(700);
    if (!(await page.evaluate(() => window.TRI_STATIC === true))) errors.push('static flag missing');
    if (await page.isVisible('#btn-private')) errors.push('private rooms button visible in static build');
    await page.screenshot({ path: path.join(SHOTS, 'title.png') });
    await page.click('#btn-play');
    await page.waitForFunction(() => ['lobby', 'intro', 'round'].includes(window.__tri.phase), null, { timeout: 15000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(SHOTS, 'lobby.png') });
    await page.waitForFunction(() => window.__tri.phase === 'round' && window.__tri.stage >= 3, null, { timeout: 60000 });
    await page.screenshot({ path: path.join(SHOTS, 'round.png') });
    const rounds = await playToEnd(page);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(SHOTS, 'over.png') });
    const res = await page.evaluate(() => ({ title: document.querySelector('#over-title').textContent, players: window.__tri.players.length }));
    results.staticMatch = { rounds, ...res };
    log('match:', JSON.stringify(results.staticMatch));
    if (res.players < 20) errors.push('static match had only ' + res.players + ' players');
    if (rounds < 7) errors.push('static strong player did not reach round 7 (' + rounds + ')');
    await ctx.close();
    // daily solo on a phone
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const mp = await mctx.newPage(); watch(mp, 'static-m');
    await mp.goto(`${base}/?speed=${speed}`);
    await mp.waitForTimeout(600);
    await mp.tap('#btn-solo');
    const r2 = await playToEnd(mp, { mobile: true });
    await mp.waitForTimeout(1000);
    await mp.screenshot({ path: path.join(SHOTS, 'm-solo-over.png') });
    results.staticSoloMobile = { rounds: r2, share: await mp.evaluate(() => window.__tri.shareText || '') };
    if (!/TRIANGULATE Daily #\d+/.test(results.staticSoloMobile.share)) errors.push('daily share text missing in static solo');
    log('mobile daily:', results.staticSoloMobile.share.split('\n')[0]);
    await mctx.close();
  } catch (e) {
    errors.push('static e2e: ' + (e.stack || e.message));
  } finally {
    await browser.close();
    srv.close();
  }
  return { errors, results };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const { errors } = await runStaticE2E({ speed: Number(process.env.TEST_SPEED) || 4 });
  if (errors.length) { console.error(errors.map((e) => '  ✖ ' + e).join('\n')); process.exit(1); }
  console.log('  ✔ static ok');
}
