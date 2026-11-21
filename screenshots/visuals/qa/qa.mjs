// QA driver: node screenshots/visuals/qa/qa.mjs [name ...]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('screenshots/visuals/qa');
const BASE = 'http://localhost:9137';
const VPS = {
  p360: { viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  p412: { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  t768: { viewport: { width: 768, height: 1024 }, deviceScaleFactor: 1, hasTouch: true },
  l1024: { viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1 },
  d1280: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 },
  d1920: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 },
  lp844: { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
const GAMEOVER = new Set(['p360', 'd1280']);
const args = process.argv.slice(2);
const names = args.filter((a) => !a.startsWith('--'));
const themesOnly = args.includes('--themes');

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const report = {};

function checks() {
  return document.defaultView.eval(`(() => {
    const W = innerWidth, H = innerHeight, out = { sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, W, H, over: [], overlap: [], clip: [] };
    const vis = (e) => { const s = getComputedStyle(e); if (s.display==='none'||s.visibility==='hidden'||+s.opacity===0) return false; const r=e.getBoundingClientRect(); if(!r.width||!r.height) return false; let p=e; while(p){ const ps=getComputedStyle(p); if(ps.display==='none'||ps.visibility==='hidden'||+ps.opacity===0) return false; p=p.parentElement;} return true; };
    const desc = (e) => (e.id ? '#' + e.id : '') + '.' + [...e.classList].join('.') + '<' + e.tagName.toLowerCase() + '>';
    const sel = '.card, .btn, .chip, .lock-btn, .result, .board, .clue-card, .topbar > *, .topbar > * > *, .mini-board, .gm-zoom, .gm-zoom button, .world-btn, .hint, .stagebar .seg, .skip-bar, .map-actions';
    const els = [...document.querySelectorAll('.screen.active ' + sel.split(', ').join(', .screen.active ')), ...document.querySelectorAll('.skip-bar')].filter(vis);
    for (const e of els) { const r = e.getBoundingClientRect();
      if (r.left < -0.5 || r.top < -0.5 || r.right > W + 0.5 || r.bottom > H + 0.5) out.over.push(desc(e) + ' ' + [r.left,r.top,r.right,r.bottom].map(Math.round).join(','));
    }
    const inter = ['#btn-lock', '.gm-zoom', '#btn-world', '#result', '#mini-board', '#board', '.clue-card', '.topbar', '#hint', '.skip-bar'].map((s) => document.querySelector(s)).filter((e) => e && vis(e));
    for (let i = 0; i < inter.length; i++) for (let j = i + 1; j < inter.length; j++) {
      const a = inter[i].getBoundingClientRect(), b = inter[j].getBoundingClientRect();
      const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left), iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ix > 1 && iy > 1) out.overlap.push(desc(inter[i]) + ' X ' + desc(inter[j]) + ' ' + Math.round(ix) + 'x' + Math.round(iy));
    }
    for (const e of document.querySelectorAll('.screen.active *')) { if (!vis(e) || e.children.length > 3) continue; const s = getComputedStyle(e);
      if ((s.overflowX !== 'visible' || s.textOverflow === 'ellipsis') && e.scrollWidth > e.clientWidth + 1 && e.textContent.trim()) out.clip.push(desc(e) + ' "' + e.textContent.trim().slice(0, 40) + '" ' + e.scrollWidth + '>' + e.clientWidth);
    }
    const lk = document.querySelector('#btn-lock');
    if (lk) { const r = lk.getBoundingClientRect(); const cx = r.left + r.width/2, cy = r.top + r.height/2; const hit = document.elementFromPoint(cx, cy); out.lock = { rect: [r.left,r.top,r.right,r.bottom].map(Math.round), visible: vis(lk), hitOk: !!hit && lk.contains(hit), hit: hit ? desc(hit) : null, disabled: lk.disabled, text: lk.textContent }; }
    out.phase = window.__tri && window.__tri.phase;
    return out;
  })()`);
}

async function waitPhase(page, ps, timeout = 120000) {
  const h = await page.waitForFunction((ps) => (ps.includes(window.__tri.phase) ? window.__tri.phase : null), ps, { timeout, polling: 50 });
  return h.jsonValue();
}
const oracle = (page) => page.evaluate(() => { const m = window.__tri.conn?.room?.clue?.meta; return m ? { lat: m.lat, lon: m.lon } : null; });
async function tap(page, lat, lon, mobile) {
  const pt = await page.evaluate(([lat, lon]) => { const m = window.__triMap; const r = m.canvas.getBoundingClientRect(); const [x, y] = m.sp(lat, lon); return { x: r.left + x, y: r.top + y }; }, [lat, lon]);
  if (mobile) await page.touchscreen.tap(pt.x, pt.y); else await page.mouse.click(pt.x, pt.y);
}

async function run(name, opts, qs = '', full = true) {
  const mobile = !!opts.hasTouch;
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errs = [];
  const R = (report[name] = { errs, shots: {} });
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type() + ': ' + m.text()); });
  const snap = async (n) => { const f = path.join(OUT, `${name}-${n}.png`); await page.screenshot({ path: f }); R.shots[n] = await page.evaluate(checks); };
  const click = (s) => (mobile ? page.tap(s) : page.click(s));
  try {
    await page.goto(`${BASE}/?speed=3${qs ? '&' + qs : ''}`);
    await page.waitForTimeout(1500);
    await snap('01-title');
    if (!full) return;
    await click('#btn-solo');
    await waitPhase(page, ['intro', 'round']);
    await page.waitForFunction(() => window.__tri.stage >= 3, null, { timeout: 90000, polling: 50 });
    await page.waitForTimeout(900);
    const a = await oracle(page);
    await tap(page, a.lat + 1.5, a.lon - 2, mobile);
    await page.waitForTimeout(500);
    await snap('02-round-pin');
    await click('#btn-lock');
    await waitPhase(page, ['reveal']);
    await page.waitForTimeout(2500);
    await snap('03-reveal');
    await waitPhase(page, ['standings']);
    await page.waitForTimeout(900);
    await snap('04-standings');
    if (!GAMEOVER.has(name)) return;
    for (;;) {
      const ph = await waitPhase(page, ['round', 'over'], 150000);
      if (ph === 'over') break;
      await page.waitForFunction(() => window.__tri.stage >= 1 || window.__tri.phase !== 'round', null, { timeout: 60000 });
      const o = await oracle(page);
      if (o && (await page.evaluate(() => window.__tri.alive)) && (await page.evaluate(() => window.__tri.phase)) === 'round') {
        await page.evaluate(() => window.__triMap.fitWorld(false));
        await page.waitForTimeout(80);
        await tap(page, o.lat + 0.3, o.lon + 0.3, mobile);
        await page.waitForTimeout(120);
        await click('#btn-lock').catch(() => {});
      }
      const p2 = await waitPhase(page, ['standings', 'over'], 150000);
      if (p2 === 'over') break;
    }
    await page.waitForTimeout(2200);
    await snap('05-over');
  } catch (e) { errs.push('driver: ' + e.message.split('\n')[0]); try { await snap('zz-fail'); } catch {} }
  finally { await ctx.close(); }
}

const jobs = [];
if (themesOnly) {
  for (const th of ['atlas', 'arcade']) {
    jobs.push(run(`th-${th}-390`, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, `theme=${th}`, false));
    jobs.push(run(`th-${th}-1440`, { viewport: { width: 1440, height: 900 } }, `theme=${th}`, false));
  }
} else {
  for (const n of names.length ? names : Object.keys(VPS)) jobs.push(run(n, VPS[n]));
}
await Promise.all(jobs);
await browser.close();
fs.writeFileSync(path.join(OUT, themesOnly ? 'report-themes.json' : `report-${(names.join('_') || 'all')}.json`), JSON.stringify(report, null, 1));
for (const [n, r] of Object.entries(report)) {
  console.log('==', n, r.errs.length ? 'ERRS: ' + r.errs.join(' | ') : '');
  for (const [s, c] of Object.entries(r.shots)) {
    console.log('  ', s, `phase=${c.phase} sw=${c.sw}/${c.W} sh=${c.sh}/${c.H}`);
    if (c.over.length) console.log('     OVER:', c.over.join(' ; '));
    if (c.overlap.length) console.log('     OVERLAP:', c.overlap.join(' ; '));
    if (c.clip.length) console.log('     CLIP:', c.clip.slice(0, 8).join(' ; '));
    if (c.lock && c.lock.visible) console.log('     LOCK:', JSON.stringify(c.lock));
  }
}
