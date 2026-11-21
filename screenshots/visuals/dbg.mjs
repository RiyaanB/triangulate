// debug helper: where do later-round taps land?
import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
p.on('pageerror', (e) => console.log('ERR', e.message));
await p.goto((process.argv[2] || 'http://localhost:9137') + '/?speed=4');
await p.click('#btn-solo');
for (let r = 1; r <= 3; r++) {
  await p.waitForFunction((r) => window.__tri.round === r && window.__tri.phase === 'round' && window.__tri.stage >= 1, r, { timeout: 60000 });
  await p.evaluate(() => window.__triMap.fitWorld(false)); await p.waitForTimeout(100);
  const info = await p.evaluate(() => {
    const m = window.__tri.conn.room.clue.meta; const M = window.__triMap; const r = M.canvas.getBoundingClientRect();
    const [x, y] = M.sp(m.lat + 0.3, m.lon + 0.3); const el = document.elementFromPoint(r.left + x, r.top + y);
    return { m: [m.lat, m.lon], x, y, el: el.className || el.tagName, t: [M.t.x, M.t.y, M.t.k], fitK: M.fitK, free: M.free() };
  });
  console.log(r, JSON.stringify(info));
  await p.waitForFunction(() => window.__tri.phase !== 'round', null, { timeout: 60000 });
}
await b.close();
