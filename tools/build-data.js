#!/usr/bin/env node
// Offline clue-pack builder: downloads Natural Earth (public domain) layers and pre-builds
// one compact JSON per clue + a low-res world basemap.  Usage: npm run build:data
//   --names-needed   also write tmp/names-needed.json (places that need curated local-script names)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadShapefile, mergeLayers } from '../lib/mapdata/loader.js';
import { makeProjection, polygonLayer, lineLayer, pointLayer, toPath, ringArea, lineLength, SIZE } from '../lib/mapdata/snippet.js';
import { simplify } from '../lib/mapdata/geometry.js';
import { LANGS, inScript, textEm } from '../lib/mapdata/scripts.js';
import { LOCATIONS, LOCAL_LANG, TRANSLIT_LANGS, continentOf } from './locations.js';
import { rateClue } from './difficulty.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'data/raw');
const OUT_PRIVATE = path.join(ROOT, 'data/build');
const OUT_PUBLIC = path.join(ROOT, 'public/data');
const ARGS = new Set(process.argv.slice(2));

const SOURCES = {
  ne_10m_land: '10m/physical', ne_10m_minor_islands: '10m/physical', ne_10m_lakes: '10m/physical',
  ne_10m_lakes_europe: '10m/physical', ne_10m_lakes_north_america: '10m/physical',
  ne_10m_rivers_lake_centerlines: '10m/physical', ne_10m_rivers_europe: '10m/physical',
  ne_10m_rivers_north_america: '10m/physical', ne_10m_roads: '10m/cultural', ne_10m_railroads: '10m/cultural',
  ne_10m_urban_areas: '10m/cultural', ne_10m_populated_places: '10m/cultural',
  ne_10m_admin_0_boundary_lines_land: '10m/cultural',
  ne_50m_land: '50m/physical', ne_50m_lakes: '50m/physical', ne_50m_admin_0_boundary_lines_land: '50m/cultural',
};

async function ensureData() {
  for (const [name, dir] of Object.entries(SOURCES)) {
    const d = path.join(RAW, name);
    if (fs.existsSync(path.join(d, name + '.shp'))) continue;
    fs.mkdirSync(d, { recursive: true });
    const zip = path.join(d, name + '.zip');
    const [res, kind] = dir.split('/');
    const urls = [
      `https://naciscdn.org/naturalearth/${dir}/${name}.zip`,
      `https://www.naturalearthdata.com/http//www.naturalearthdata.com/download/${res}/${kind}/${name}.zip`,
    ];
    let ok = false;
    for (const u of urls) {
      try {
        console.log('download', u);
        execFileSync('curl', ['-sSfL', '--retry', '3', '-o', zip, u], { stdio: 'inherit' });
        ok = true; break;
      } catch { console.warn('  failed', u); }
    }
    if (!ok) throw new Error('Could not download ' + name);
    execFileSync('unzip', ['-oq', zip, '-d', d]);
  }
}

const shp = (n) => path.join(RAW, n, n);
const hash = (s) => crypto.createHash('sha1').update('triangulate:' + s).digest('hex');
const LOCAL_NAMES = loadLocalNames();

function loadLocalNames() {
  const f = path.join(ROOT, 'data/local-names.json');
  if (!fs.existsSync(f)) return {};
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  delete j._comment;
  return j;
}

// Split a clipped ring into coastline polylines, dropping edges that lie on the frame border.
function ringCoast(ring) {
  const onB = (a, b) => (Math.abs(a[0] - b[0]) < 0.01 && (a[0] <= -1.9 || a[0] >= SIZE + 1.9)) ||
    (Math.abs(a[1] - b[1]) < 0.01 && (a[1] <= -1.9 || a[1] >= SIZE + 1.9));
  const lines = [];
  let cur = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i], b = ring[i + 1];
    if (onB(a, b)) { if (cur.length > 1) lines.push(cur); cur = []; continue; }
    if (!cur.length) cur.push(a);
    cur.push(b);
  }
  if (cur.length > 1) lines.push(cur);
  if (lines.length > 1) {
    const f = lines[0], l = lines[lines.length - 1];
    if (f[0] === l[l.length - 1]) { lines[0] = l.concat(f.slice(1)); lines.pop(); }
  }
  return lines;
}

function chunkPaths(lines, maxPer = 12) {
  // group polylines into a handful of paths (keeps draw-in animation parallel but DOM small)
  lines.sort((a, b) => lineLength(b) - lineLength(a));
  const groups = [];
  lines.forEach((l, i) => { const g = i < maxPer ? i : maxPer - 1 - (i % maxPer); (groups[g] ||= []).push(l); });
  return groups.map((g) => toPath(g)).filter(Boolean);
}

const sumLen = (lines) => lines.reduce((a, l) => a + lineLength(l), 0);

/** Pick the label language for a location: explicit override, country default, or a transliteration. */
function langsFor(loc) {
  const [name, , , , cc, , opts = {}] = loc;
  if (opts.lang) return { chain: [opts.lang, ...(opts.fallback ? [opts.fallback] : [])], translit: false };
  const l = LOCAL_LANG[cc];
  if (l) return { chain: Array.isArray(l) ? l : [l], translit: false };
  // Latin-script country: show exonyms transliterated into a decodable script, clearly tagged.
  const h = parseInt(hash(name).slice(0, 6), 16);
  const first = TRANSLIT_LANGS[h % TRANSLIT_LANGS.length];
  return { chain: [first, ...TRANSLIT_LANGS.filter((x) => x !== first)], translit: true };
}

/** Local-script name for a feature in `lang`, or null. Curated table first, then Natural Earth fields. */
function nameIn(props, lang, kind, need) {
  const table = LOCAL_NAMES[lang];
  const keys = kind === 'c' ? [props.NAME, props.NAME_EN, props.NAMEASCII] : [props.name_en, props.name];
  if (table) for (const k of keys) if (k && table[k]) return table[k];
  const field = LANGS[lang]?.ne;
  let t = null;
  if (field) t = kind === 'c' ? props['NAME_' + field.toUpperCase()] : props['name_' + field];
  if (t) t = String(t).replace(/\s*\(.*?\)\s*/g, ' ').trim();
  if (!t && need && !field) need(keys.find(Boolean), props, kind);
  return t || null;
}

function buildLabels(loc, proj, L, lakeRings, rivers, lang, need) {
  const cands = [];
  const bad = [];
  const check = (t, kind) => {
    if (!t) return null;
    if (!inScript(t, lang)) { bad.push(t); return null; }
    return t;
  };
  for (const p of pointLayer(L.places, proj, 14)) {
    const t = check(nameIn(p.props, lang, 'c', need), 'c');
    if (!t) continue;
    const big = p.props.FEATURECLA?.startsWith('Admin-0 capital') || p.props.SCALERANK <= 2;
    const size = big ? 34 : p.props.SCALERANK <= 5 ? 28 : 23;
    cands.push({ x: p.x, y: p.y, t, k: 'c', s: size, pri: p.props.SCALERANK - (big ? 5 : 0), dot: 1 });
  }
  for (const r of lakeRings) {
    if (Math.abs(ringArea(r.ring)) < 9000) continue;
    const t = check(nameIn(r.props, lang, 'w', need), 'w');
    if (!t) continue;
    let cx = 0, cy = 0; for (const p of r.ring) { cx += p[0]; cy += p[1]; } cx /= r.ring.length; cy /= r.ring.length;
    cands.push({ x: cx, y: cy, t, k: 'w', s: 24, pri: 6 });
  }
  const byRiver = new Map();
  for (const r of rivers) {
    const len = lineLength(r.line);
    if (len < 140) continue;
    const t = check(nameIn(r.props, lang, 'r', need), 'r');
    if (!t) continue;
    if (!byRiver.has(t) || byRiver.get(t).len < len) byRiver.set(t, { len, line: r.line });
  }
  for (const [t, { line }] of byRiver) {
    const m = Math.floor(line.length / 2);
    const a = line[Math.max(0, m - 1)], b = line[Math.min(line.length - 1, m + 1)];
    let ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
    if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
    ang = Math.max(-50, Math.min(50, ang));
    cands.push({ x: line[m][0], y: line[m][1], t, k: 'r', s: 21, pri: 7, a: Math.round(ang) });
  }
  cands.sort((a, b) => a.pri - b.pri);
  const boxes = [];
  const labels = [];
  const seen = new Set();
  for (const c of cands) {
    if (labels.length >= 14) break;
    if (seen.has(c.t)) continue;
    const w = textEm(c.t) * c.s, h = c.s * 1.25;
    let x = c.x, y = c.dot ? c.y - c.s * 0.6 : c.y;
    x = Math.max(w / 2 + 6, Math.min(SIZE - w / 2 - 6, x));
    y = Math.max(h / 2 + 4, Math.min(SIZE - h / 2 - 4, y));
    const box = [x - w / 2 - 4, y - h / 2, x + w / 2 + 4, y + h / 2];
    if (boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
    boxes.push(box);
    seen.add(c.t);
    if (c.dot) boxes.push([c.x - 6, c.y - 6, c.x + 6, c.y + 6]);
    const lab = [Math.round(x), Math.round(y), c.t, c.k, c.s];
    if (c.dot) lab.push(Math.round(c.x), Math.round(c.y));
    else if (c.a) lab.push(c.a);
    labels.push(lab);
  }
  return { labels, bad };
}

function buildClue(loc, L, need) {
  const [name, lat, lon, km, cc] = loc;
  const proj = makeProjection(lat, lon, km);
  const stats = {};

  // ---- stage 1: land + coast + lakes + national borders (the "shape" stage)
  const landRings = polygonLayer(L.land, proj, { tol: 0.7, minArea: 4 });
  const lakeRings = polygonLayer(L.lakes, proj, { tol: 0.7, minArea: 20 });
  const coastLines = landRings.flatMap((r) => ringCoast(r.ring)).filter((l) => lineLength(l) > 3);
  const lakeLines = lakeRings.flatMap((r) => ringCoast(r.ring));
  const borders = lineLayer(L.borders, proj, { tol: 0.8, minLen: 6 }).map((r) => r.line);
  const landArea = landRings.reduce((a, r) => a + ringArea(r.ring), 0);
  const lakeArea = lakeRings.reduce((a, r) => a + Math.abs(ringArea(r.ring)), 0);
  stats.landFrac = Math.min(1, Math.abs(landArea) / (SIZE * SIZE));
  stats.waterFrac = Math.min(1, 1 - stats.landFrac + lakeArea / (SIZE * SIZE));
  stats.coast = Math.round(sumLen(coastLines));
  stats.lakeShore = Math.round(sumLen(lakeLines));
  stats.border = Math.round(sumLen(borders));
  stats.lakes = lakeRings.length;
  // how much "shape" stage 1 shows (frame = 1000 units wide)
  stats.s1 = stats.coast + stats.lakeShore + Math.round(stats.border * 0.8);
  const s1 = {
    land: toPath(landRings.map((r) => r.ring), true),
    coast: chunkPaths(coastLines.concat(lakeLines), 10),
    lakes: toPath(lakeRings.map((r) => r.ring), true),
    borders: chunkPaths(borders, 6),
  };
  // ---- stage 2: rivers
  const rivers = lineLayer(L.rivers, proj, { tol: 0.8, minLen: 6 });
  stats.rivers = Math.round(sumLen(rivers.map((r) => r.line)));
  const rw = (sr) => (sr <= 4 ? 3 : sr <= 7 ? 2 : 1);
  const s2 = { rivers: [3, 2, 1].map((w) => [w, chunkPaths(rivers.filter((r) => rw(r.props.scalerank ?? 9) === w).map((r) => r.line), 8)]).filter((x) => x[1].length) };
  // ---- stage 3: urban + roads + rail
  const urban = polygonLayer(L.urban, proj, { tol: 0.8, minArea: 10 });
  const roads = lineLayer(L.roads, proj, { tol: 0.8, minLen: 4 });
  const rail = lineLayer(L.rail, proj, { tol: 0.8, minLen: 4 });
  stats.roads = Math.round(sumLen(roads.map((r) => r.line)));
  stats.rail = Math.round(sumLen(rail.map((r) => r.line)));
  stats.urban = Math.round(urban.reduce((a, r) => a + Math.abs(ringArea(r.ring)), 0) / 100);
  const roadW = (p) => (p.expressway === 1 || p.type === 'Major Highway' || p.type === 'Beltway' ? 2 : 1);
  const s3 = {
    urban: toPath(urban.map((r) => r.ring), true),
    roads: [2, 1].map((w) => [w, chunkPaths(roads.filter((r) => roadW(r.props) === w).map((r) => r.line), 8)]).filter((x) => x[1].length),
    rail: chunkPaths(rail.map((r) => r.line), 6),
  };
  // ---- stage 4: names in the local script (or a clearly-tagged transliteration for Latin-script places)
  const { chain, translit } = langsFor(loc);
  let best = null;
  for (const lang of chain) {
    const r = buildLabels(loc, proj, L, lakeRings, rivers, lang, (k, props, kind) => need?.(name, lang, k, props, kind));
    if (!best || r.labels.length > best.labels.length) best = { ...r, lang };
    if (r.labels.length >= 3) break;
  }
  stats.labels = best.labels.length;
  stats.badScript = best.bad.slice(0, 4);
  stats.lang = best.lang;
  stats.translit = translit;
  const s4 = { labels: best.labels, script: LANGS[best.lang].family, translit };
  return { clue: { v: 2, km, s1, s2, s3, s4 }, stats };
}

function buildWorld(W) {
  const r2 = (v) => Math.round(v * 100) / 100;
  const ringsOf = (layer, tol, minPts) => layer.items.flatMap((it) => it.parts).map((r) => simplify(r, tol).map(([x, y]) => [r2(x), r2(y)])).filter((r) => r.length >= minPts);
  return {
    land: ringsOf(W.land, 0.06, 4),
    lakes: ringsOf(W.lakes, 0.06, 4),
    borders: ringsOf(W.borders, 0.06, 2),
  };
}

export async function loadLayers() {
  await ensureData();
  const notCenterline = (p) => !/Centerline/.test(p.featurecla || '');
  return {
    land: mergeLayers(await loadShapefile(shp('ne_10m_land')), await loadShapefile(shp('ne_10m_minor_islands'))),
    lakes: mergeLayers(await loadShapefile(shp('ne_10m_lakes')), await loadShapefile(shp('ne_10m_lakes_europe')), await loadShapefile(shp('ne_10m_lakes_north_america'))),
    rivers: mergeLayers(
      await loadShapefile(shp('ne_10m_rivers_lake_centerlines'), { filter: notCenterline }),
      await loadShapefile(shp('ne_10m_rivers_europe'), { filter: notCenterline }),
      await loadShapefile(shp('ne_10m_rivers_north_america'), { filter: notCenterline })),
    roads: await loadShapefile(shp('ne_10m_roads'), { filter: (p) => !/Ferry/.test(p.type || '') && !/Ferry/.test(p.featurecla || '') }),
    rail: await loadShapefile(shp('ne_10m_railroads')),
    urban: await loadShapefile(shp('ne_10m_urban_areas')),
    places: await loadShapefile(shp('ne_10m_populated_places')),
    borders: await loadShapefile(shp('ne_10m_admin_0_boundary_lines_land'), { filter: (p) => !/Lease|Overlay/.test(p.FEATURECLA || '') }),
  };
}

async function main() {
  const t0 = Date.now();
  console.log('loading layers...');
  const L = await loadLayers();
  console.log('layers loaded in', ((Date.now() - t0) / 1000).toFixed(1), 's');

  // names that need a curated local-script spelling (Thai, Khmer, Georgian, ...): collected for translators
  const needed = {};
  const need = ARGS.has('--names-needed') ? (clue, lang, key, props, kind) => {
    if (!key) return;
    const n = (needed[lang] ||= {});
    const e = (n[key] ||= { kind, clues: [], rank: props.SCALERANK ?? props.scalerank ?? 9, ru: props.NAME_RU || props.name_ru || null, adm1: props.ADM1NAME || null });
    if (!e.clues.includes(clue)) e.clues.push(clue);
  } : null;

  fs.mkdirSync(path.join(OUT_PRIVATE, 'clues'), { recursive: true });
  fs.mkdirSync(path.join(OUT_PUBLIC, 'solo'), { recursive: true });
  const built = [];
  for (const loc of LOCATIONS) {
    const [name, lat, lon, km, cc, diff] = loc;
    const { clue, stats } = buildClue(loc, L, need);
    const id = hash(name).slice(0, 10);
    const rating = rateClue({ diff, ...stats });
    built.push({ id, name, lat, lon, km, cc, diff, rating, cont: continentOf(cc, lon), clue, stats });
  }
  // Solo pack (shipped to the browser, so its answers are public-ish) gets every 3rd clue by difficulty,
  // live rooms (answers kept server-side) get the rest.  Stratified so both span easy..hard.
  const order = built.slice().sort((a, b) => a.rating - b.rating || a.id.localeCompare(b.id));
  const soloIds = new Set(order.filter((_, i) => i % 3 === 1).map((c) => c.id));
  const live = [], solo = [], report = [];
  // clear stale outputs from previous builds (only our own generated files)
  for (const dir of [path.join(OUT_PRIVATE, 'clues'), path.join(OUT_PUBLIC, 'solo')]) {
    for (const f of fs.readdirSync(dir)) if (/^[0-9a-f]{10}\.json$/.test(f)) fs.unlinkSync(path.join(dir, f));
  }
  for (const c of built) {
    const json = JSON.stringify(c.clue);
    const meta = { id: c.id, name: c.name, lat: c.lat, lon: c.lon, km: c.km, cc: c.cc, diff: c.diff, rating: c.rating, cont: c.cont };
    if (soloIds.has(c.id)) {
      fs.writeFileSync(path.join(OUT_PUBLIC, 'solo', c.id + '.json'), json);
      solo.push(meta);
    } else {
      fs.writeFileSync(path.join(OUT_PRIVATE, 'clues', c.id + '.json'), json);
      live.push(meta);
    }
    const s = c.stats;
    report.push({ name: c.name, id: c.id, cc: c.cc, cont: c.cont, km: c.km, diff: c.diff, rating: c.rating, solo: soloIds.has(c.id), kb: +(json.length / 1024).toFixed(1),
      land: +s.landFrac.toFixed(2), water: +s.waterFrac.toFixed(2), s1: s.s1, coast: s.coast, lakeShore: s.lakeShore, border: s.border, rivers: s.rivers,
      roads: s.roads, rail: s.rail, urban: s.urban, labels: s.labels, lang: s.lang, translit: s.translit, badScript: s.badScript });
  }
  fs.writeFileSync(path.join(OUT_PRIVATE, 'answers.json'), JSON.stringify(live, null, 0));
  // solo pack: answers lightly obfuscated so they aren't readable at a glance (client-side mode)
  const enc = Buffer.from(JSON.stringify(solo)).map((b, i) => b ^ (0x5a + (i % 13))).toString('base64');
  fs.writeFileSync(path.join(OUT_PUBLIC, 'solo-pack.json'), JSON.stringify({ v: 2, n: solo.length, p: enc }));

  console.log('building world basemap...');
  const W = {
    land: await loadShapefile(shp('ne_50m_land')),
    lakes: await loadShapefile(shp('ne_50m_lakes'), { filter: (p) => (p.scalerank ?? 9) <= 4 }),
    borders: await loadShapefile(shp('ne_50m_admin_0_boundary_lines_land')),
  };
  const world = JSON.stringify(buildWorld(W));
  fs.writeFileSync(path.join(OUT_PUBLIC, 'world.json'), world);

  fs.writeFileSync(path.join(OUT_PRIVATE, 'build-report.json'), JSON.stringify(report, null, 1));
  if (need) {
    fs.mkdirSync(path.join(ROOT, 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'tmp/names-needed.json'), JSON.stringify(needed, null, 1));
    console.log('names needed:', Object.entries(needed).map(([l, n]) => `${l}:${Object.keys(n).length}`).join(' '));
  }
  const kb = report.reduce((a, r) => a + r.kb, 0);
  console.log(`built ${live.length} live + ${solo.length} solo clues (${kb.toFixed(0)} KB total, avg ${(kb / report.length).toFixed(1)} KB), world ${(world.length / 1024).toFixed(0)} KB in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('run `node tools/audit-clues.js` for a quality report');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
