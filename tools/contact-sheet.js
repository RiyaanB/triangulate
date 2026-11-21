#!/usr/bin/env node
// Visual QA: renders every built clue (all four stages composited) into contact sheets
// screenshots/core/contact/sheet-NN.png via headless Chrome.  node tools/contact-sheet.js [--filter=name,...] [--per=20]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'screenshots/core/contact');
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1] || d;
const PER = Number(arg('per', 20));
const FILTER = arg('filter', '') ? new Set(arg('filter', '').split(',')) : null;

const dec = (j) => JSON.parse(Buffer.from(j.p, 'base64').map((x, i) => x ^ (0x5a + (i % 13))).toString());
const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/build/build-report.json'), 'utf8'));
const solo = new Set(dec(JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/solo-pack.json')))).map((m) => m.id));
const load = (id) => JSON.parse(fs.readFileSync(path.join(ROOT, solo.has(id) ? 'public/data/solo' : 'data/build/clues', id + '.json'), 'utf8'));

function svg(c) {
  const p = (d, a) => (d ? `<path d="${d}" ${a}/>` : '');
  let s = `<svg viewBox="0 0 1000 1000" xmlns="http://www.w3.org/2000/svg"><rect width="1000" height="1000" fill="#0b1830"/>`;
  s += p(c.s1.land, 'fill="#24364f" fill-rule="evenodd"') + p(c.s1.lakes, 'fill="#0d2240" fill-rule="evenodd"');
  s += p(c.s3.urban, 'fill="#5a4a7a" opacity=".55"');
  for (const d of c.s1.borders || []) s += p(d, 'fill="none" stroke="#f5a3c7" stroke-width="3" stroke-dasharray="10 7"');
  for (const d of c.s1.coast) s += p(d, 'fill="none" stroke="#7fe3ff" stroke-width="3"');
  for (const [w, ds] of c.s2.rivers) for (const d of ds) s += p(d, `fill="none" stroke="#3d8bff" stroke-width="${w * 1.6}"`);
  for (const d of c.s3.rail) s += p(d, 'fill="none" stroke="#999" stroke-width="2" stroke-dasharray="4 4"');
  for (const [w, ds] of c.s3.roads) for (const d of ds) s += p(d, `fill="none" stroke="#ffcc66" stroke-width="${w * 1.5}" opacity=".8"`);
  for (const [x, y, t, k, size, a, b] of c.s4.labels) {
    if (k === 'c' && a != null) s += `<circle cx="${a}" cy="${b}" r="6" fill="#fff"/>`;
    const col = k === 'w' ? '#9fd8ff' : k === 'r' ? '#7fb2ff' : k === 'g' ? '#d8c39a' : '#fff';
    const rot = k === 'r' && a ? ` transform="rotate(${a} ${x} ${y})"` : '';
    s += `<text x="${x}" y="${y}" font-size="${size}" fill="${col}" text-anchor="middle" dominant-baseline="central" font-family="sans-serif" stroke="#000" stroke-width="5" paint-order="stroke"${rot}>${t.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`;
  }
  s += `<circle cx="500" cy="500" r="14" fill="none" stroke="#ff4d6d" stroke-width="4"/></svg>`;
  return s;
}

const rows = report.filter((r) => !FILTER || FILTER.has(r.name)).sort((a, b) => a.rating - b.rating);
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
for (let i = 0; i < rows.length; i += PER) {
  const chunk = rows.slice(i, i + PER);
  const cells = chunk.map((r) => {
    const c = load(r.id);
    return `<div class="cell"><div class="m">${svg(c)}</div><div class="t"><b>${r.name}</b> ${r.cc} · ${r.km}km · r${r.rating} · ${c.s4.script}${c.s4.translit ? '*' : ''} · L${r.labels} s1=${r.s1}</div></div>`;
  }).join('');
  await page.setContent(`<html><body style="margin:0;background:#050a14;color:#cde;font:13px sans-serif">
    <style>.g{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;padding:8px}.m svg{width:100%;display:block;border-radius:6px}.t{padding:3px 2px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}</style>
    <div class="g">${cells}</div></body></html>`);
  await page.waitForTimeout(300);
  const f = path.join(OUT, `sheet-${String(i / PER + 1).padStart(2, '0')}.png`);
  await page.screenshot({ path: f, fullPage: true });
  console.log(f, chunk.map((r) => r.name).join(', '));
}
await browser.close();
