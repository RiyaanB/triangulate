// Plays a full static (docs/) match via PLAY at ?speed=4, desktop + mobile, with screenshots.
import { chromium } from 'playwright';
import fs from 'node:fs';
const base = process.argv[2] || 'http://localhost:9152';
const out = 'screenshots/visuals/static';
fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
const errors = [];
for (const [tag, ctxOpt] of [['d', { viewport: { width: 1440, height: 900 } }], ['m', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }]]) {
  const p = await (await b.newContext(ctxOpt)).newPage();
  p.on('pageerror', (e) => errors.push(tag + ' ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(tag + ' console ' + m.text()); });
  await p.goto(base + '/?speed=4');
  await p.waitForTimeout(800);
  if (!(await p.evaluate(() => window.TRI_STATIC))) errors.push('TRI_STATIC flag missing');
  await (tag === 'm' ? p.tap('#btn-play') : p.click('#btn-play'));
  await p.waitForFunction(() => window.__tri.phase === 'lobby', null, { timeout: 15000 });
  await p.waitForTimeout(600);
  await p.screenshot({ path: `${out}/${tag}-lobby.png` });
  let rounds = 0;
  for (;;) {
    const ph = await (await p.waitForFunction(() => ['round', 'over'].includes(window.__tri.phase) && (window.__tri.phase === 'over' || window.__tri.stage >= 1) ? window.__tri.phase : null, null, { timeout: 120000, polling: 50 })).jsonValue();
    if (ph === 'over') break;
    rounds = await p.evaluate(() => window.__tri.round);
    if (await p.evaluate(() => window.__tri.alive)) {
      await p.evaluate(() => window.__triMap.fitWorld(false)); await p.waitForTimeout(60);
      const pt = await p.evaluate(() => { const m = window.__tri.conn.room.clue.meta; const M = window.__triMap; const r = M.canvas.getBoundingClientRect(); const [x, y] = M.sp(m.lat + 0.2, m.lon + 0.2); return { x: r.left + x, y: r.top + y }; });
      if (tag === 'm') await p.touchscreen.tap(pt.x, pt.y); else await p.mouse.click(pt.x, pt.y);
      await p.waitForTimeout(100);
      if (await p.evaluate(() => !!window.__tri.myPin && window.__tri.phase === 'round')) await (tag === 'm' ? p.tap('#btn-lock') : p.click('#btn-lock'));
      else errors.push(`${tag}: pin failed in round ${rounds}`);
    }
    await p.waitForFunction(() => window.__tri.phase !== 'round', null, { timeout: 120000 });
    if (rounds === 3) { await p.waitForTimeout(1500); await p.screenshot({ path: `${out}/${tag}-reveal-r3.png` }); }
  }
  await p.waitForTimeout(2200);
  await p.screenshot({ path: `${out}/${tag}-over.png` });
  const title = await p.evaluate(() => document.querySelector('#over-title').textContent + ' | ' + document.querySelector('#over-me').textContent);
  console.log(tag, 'rounds', rounds, '→', title);
  await p.context().close();
}
await b.close();
console.log(errors.length ? 'ERRORS\n' + errors.join('\n') : 'static ok, no errors');
