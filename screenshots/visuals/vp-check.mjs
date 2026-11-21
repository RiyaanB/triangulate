// Re-check QA viewports: title (3 themes) + in-round with pin + reveal, reports overflow.
import { chromium } from 'playwright';
import fs from 'node:fs';
const base = process.argv[2] || 'http://localhost:9137';
const out = 'screenshots/visuals/vp';
fs.mkdirSync(out, { recursive: true });
const VPS = {
  lp844: { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  t768: { viewport: { width: 768, height: 1024 }, hasTouch: true },
  l1024: { viewport: { width: 1024, height: 768 } },
  d1280: { viewport: { width: 1280, height: 720 } },
  p360: { viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
const notes = [];
for (const [tag, o] of Object.entries(VPS)) {
  for (const theme of tag === 'lp844' || tag === 'l1024' ? ['night', 'arcade'] : ['night']) {
    const p = await (await b.newContext(o)).newPage();
    p.on('pageerror', (e) => notes.push(tag + ' ERR ' + e.message));
    await p.goto(`${base}/?speed=3&theme=${theme}`);
    await p.waitForTimeout(700);
    await p.screenshot({ path: `${out}/${tag}-${theme}-title.png` });
    const ov = await p.evaluate(() => { const w = document.querySelector('.logo-word').getBoundingClientRect(), c = document.querySelector('.title-card').getBoundingClientRect(); return { overlap: w.right > c.left && w.bottom > c.top && w.top < c.bottom && w.left < c.left, sw: document.documentElement.scrollWidth > innerWidth }; });
    if (ov.overlap || ov.sw) notes.push(`${tag}/${theme} title overlap=${ov.overlap} hscroll=${ov.sw}`);
    await p.context().close();
  }
  const p = await (await b.newContext(o)).newPage();
  await p.goto(`${base}/?speed=3&theme=night`);
  await (o.hasTouch ? p.tap('#btn-solo') : p.click('#btn-solo'));
  await p.waitForFunction(() => window.__tri.stage >= 4, null, { timeout: 90000 });
  await p.waitForTimeout(1200);
  const pt = await p.evaluate(() => { const m = window.__tri.conn.room.clue.meta; const M = window.__triMap; const r = M.canvas.getBoundingClientRect(); const [x, y] = M.sp(m.lat + 2, m.lon + 2); return { x: r.left + x, y: r.top + y }; });
  if (o.hasTouch) await p.touchscreen.tap(pt.x, pt.y); else await p.mouse.click(pt.x, pt.y);
  await p.waitForTimeout(500);
  await p.screenshot({ path: `${out}/${tag}-round.png` });
  await p.waitForFunction(() => window.__tri.phase === 'reveal', null, { timeout: 60000 });
  await p.waitForTimeout(2800);
  await p.screenshot({ path: `${out}/${tag}-reveal.png` });
  await p.context().close();
}
await b.close();
console.log(notes.length ? notes.join('\n') : 'no overlap/overflow/errors');
