// Portal packages (dist/itch, dist/crazygames): serve each unzipped game dir on 127.0.0.1 (CrazyGames SDK
// runs in its "local" mode there), play a full bots match on desktop + phone, press Play again (midgame ad
// break on CrazyGames), confirm a second match starts. 0 console errors. Shots -> SHOTS_DIR/portal-*.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
const ROOT = process.cwd();
const SHOTS = path.resolve(process.env.SHOTS_DIR || 'screenshots/core');
const SPEED = Number(process.env.TEST_SPEED) || 4;
const only = process.argv[2];
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

const errors = [];
const browser = await chromium.launch({ executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined, headless: true });
let port = Number(process.env.PORTAL_PORT) || 9491;
for (const name of ['itch', 'crazygames'].filter((n) => !only || n === only)) {
  const dir = path.join(ROOT, 'dist', name, 'game');
  if (!fs.existsSync(dir)) { errors.push(`${name}: dist missing — npm run build:portals`); continue; }
  const stop = await serve(dir, port);
  const base = `http://127.0.0.1:${port++}`;
  for (const dev of [
    { tag: 'desktop', opts: { viewport: { width: 1280, height: 800 } }, mobile: false },
    { tag: 'cg-iframe', opts: { viewport: { width: 907, height: 510 } }, mobile: false, quick: true },
    { tag: 'phone', opts: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, mobile: true },
  ]) {
    if (dev.quick && name !== 'crazygames') continue;
    const tag = `${name}-${dev.tag}`;
    const ctx = await browser.newContext(dev.opts);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag} console: ${m.text()}`); });
    p.on('requestfailed', (r) => errors.push(`${tag} reqfail: ${r.url()}`));
    try {
      await p.goto(`${base}/index.html?speed=${SPEED}`, { waitUntil: 'load' });
      await p.waitForFunction(() => !!window.__triMap, null, { timeout: 15000 });
      await p.waitForTimeout(1500);
      const label = await p.textContent('#btn-play small');
      await p.screenshot({ path: path.join(SHOTS, `portal-${tag}-title.png`) });
      if (dev.mobile) await p.tap('#btn-play'); else await p.click('#btn-play');
      await p.waitForFunction(() => window.__tri.phase === 'round' && window.__tri.stage >= 2, null, { timeout: 60000 });
      await p.screenshot({ path: path.join(SHOTS, `portal-${tag}-round.png`) });
      if (dev.quick) { console.log(`  [portal] ${tag}: round ok, label="${label}"`); await ctx.close(); continue; }
      const rounds = await playToEnd(p, dev.mobile);
      await p.waitForTimeout(1500);
      await p.screenshot({ path: path.join(SHOTS, `portal-${tag}-over.png`) });
      const share = await p.evaluate(() => window.__tri.shareText || '');
      if (/https?:\/\//.test(share)) errors.push(`${tag}: share text contains a URL`);
      if (dev.mobile) await p.tap('#btn-again'); else await p.click('#btn-again');
      await p.waitForTimeout(1200);
      await p.screenshot({ path: path.join(SHOTS, `portal-${tag}-adbreak.png`) });
      if (name === 'crazygames') await p.waitForFunction(() => (window.__portalEvents || []).some((e) => e.startsWith('ad:')), null, { timeout: 95000 });
      await p.waitForFunction(() => ['lobby', 'intro', 'round'].includes(window.__tri.phase), null, { timeout: 90000 });
      await p.waitForFunction(() => window.__tri.phase === 'round', null, { timeout: 60000 });
      const ev = await p.evaluate(() => window.__portalEvents || []);
      console.log(`  [portal] ${tag}: rounds=${rounds} label="${label}" events=${ev.join(',')}`);
      if (name === 'crazygames') {
        if (!ev.some((e) => e.startsWith('init:local'))) errors.push(`${tag}: SDK not in local mode`);
        for (const need of ['gameplayStart', 'gameplayStop', 'loadingStart', 'loadingStop']) if (!ev.includes(need)) errors.push(`${tag}: no ${need}`);
        if (!ev.some((e) => e.startsWith('ad:'))) errors.push(`${tag}: midgame ad never resolved`);
        if (ev.filter((e) => e === 'gameplayStart').length < 2) errors.push(`${tag}: second match did not signal gameplayStart`);
      } else if (ev.length) errors.push(`${tag}: portal hooks active in itch build: ${ev}`);
    } catch (e) { errors.push(`${tag}: ${e.message}`); }
    await ctx.close();
  }
  stop();
}
await browser.close();
if (errors.length) { console.error(errors.map((e) => '  ✖ ' + e).join('\n')); process.exit(1); }
console.log('  ✔ portal packages ok');
