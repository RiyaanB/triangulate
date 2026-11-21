#!/usr/bin/env node
// Offline clue-pack builder: downloads Natural Earth (public domain) layers and pre-builds
// one compact JSON per clue + a low-res world basemap.  Usage: npm run build:data
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadShapefile, mergeLayers } from '../lib/mapdata/loader.js';
import { makeProjection, polygonLayer, lineLayer, pointLayer, toPath, ringArea, lineLength, SIZE } from '../lib/mapdata/snippet.js';
import { simplify } from '../lib/mapdata/geometry.js';
import { LOCATIONS, LOCAL_SCRIPT, CIPHER_SCRIPTS } from './locations.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'data/raw');
const OUT_PRIVATE = path.join(ROOT, 'data/build');
const OUT_PUBLIC = path.join(ROOT, 'public/data');

const SOURCES = {
  ne_10m_land: '10m/physical', ne_10m_minor_islands: '10m/physical', ne_10m_lakes: '10m/physical',
  ne_10m_lakes_europe: '10m/physical', ne_10m_lakes_north_america: '10m/physical',
  ne_10m_rivers_lake_centerlines: '10m/physical', ne_10m_rivers_europe: '10m/physical',
  ne_10m_rivers_north_america: '10m/physical', ne_10m_roads: '10m/cultural', ne_10m_railroads: '10m/cultural',
  ne_10m_urban_areas: '10m/cultural', ne_10m_populated_places: '10m/cultural',
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
const SCRIPT_FAMILY = { ru: 'Cyrillic', uk: 'Cyrillic', el: 'Greek', he: 'Hebrew', ar: 'Arabic', fa: 'Arabic', ur: 'Arabic', hi: 'Devanagari', bn: 'Bengali', zh: 'Hanzi', zht: 'Hanzi', ja: 'Kana', ko: 'Hangul' };
const LATIN = /[A-Za-zÀ-ɏ]/;
const isWide = (ch) => /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿぀-ヿ]/.test(ch);
const textWidth = (t, size) => [...t].reduce((w, ch) => w + (isWide(ch) ? 1.0 : 0.6), 0) * size;
const hash = (s) => crypto.createHash('sha1').update('triangulate:' + s).digest('hex');

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
  // merge last+first if ring wraps
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

function buildClue(loc, L) {
  const [name, lat, lon, km, cc, diff] = loc;
  const proj = makeProjection(lat, lon, km);
  const stats = {};

  // ---- stage 1: land + coast + lakes
  const landRings = polygonLayer(L.land, proj, { tol: 0.7, minArea: 4 });
  const lakeRings = polygonLayer(L.lakes, proj, { tol: 0.7, minArea: 20 });
  const coastLines = landRings.flatMap((r) => ringCoast(r.ring)).filter((l) => lineLength(l) > 3);
  const lakeLines = lakeRings.flatMap((r) => ringCoast(r.ring));
  const landArea = landRings.reduce((a, r) => a + ringArea(r.ring), 0);
  stats.landFrac = Math.abs(landArea) / (SIZE * SIZE);
  stats.coast = Math.round(coastLines.reduce((a, l) => a + lineLength(l), 0));
  stats.lakes = lakeRings.length;
  const s1 = {
    land: toPath(landRings.map((r) => r.ring), true),
    coast: chunkPaths(coastLines.concat(lakeLines), 10),
    lakes: toPath(lakeRings.map((r) => r.ring), true),
  };
  // ---- stage 2: rivers
  const rivers = lineLayer(L.rivers, proj, { tol: 0.8, minLen: 6 });
  stats.rivers = rivers.length;
  const rw = (sr) => (sr <= 4 ? 3 : sr <= 7 ? 2 : 1);
  const s2 = { rivers: [3, 2, 1].map((w) => [w, chunkPaths(rivers.filter((r) => rw(r.props.scalerank ?? 9) === w).map((r) => r.line), 8)]).filter((x) => x[1].length) };
  // ---- stage 3: urban + roads + rail
  const urban = polygonLayer(L.urban, proj, { tol: 0.8, minArea: 10 });
  const roads = lineLayer(L.roads, proj, { tol: 0.8, minLen: 4 });
  const rail = lineLayer(L.rail, proj, { tol: 0.8, minLen: 4 });
  stats.roads = roads.length; stats.rail = rail.length;
  const roadW = (p) => (p.expressway === 1 || p.type === 'Major Highway' || p.type === 'Beltway' ? 2 : 1);
  const s3 = {
    urban: toPath(urban.map((r) => r.ring), true),
    roads: [2, 1].map((w) => [w, chunkPaths(roads.filter((r) => roadW(r.props) === w).map((r) => r.line), 8)]).filter((x) => x[1].length),
    rail: chunkPaths(rail.map((r) => r.line), 6),
  };
  // ---- stage 4: names in local (or transliterated) script
  let lang = LOCAL_SCRIPT[cc];
  const translit = !lang;
  if (!lang) lang = CIPHER_SCRIPTS[parseInt(hash(name).slice(0, 6), 16) % CIPHER_SCRIPTS.length];
  const placeField = 'NAME_' + lang.toUpperCase();
  const cands = [];
  for (const p of pointLayer(L.places, proj, 14)) {
    const t = p.props[placeField];
    if (!t || LATIN.test(t)) continue;
    const big = p.props.FEATURECLA?.startsWith('Admin-0 capital') || p.props.SCALERANK <= 2;
    const size = big ? 34 : p.props.SCALERANK <= 5 ? 28 : 23;
    cands.push({ x: p.x, y: p.y, t, k: 'c', s: size, pri: p.props.SCALERANK - (big ? 5 : 0), dot: 1 });
  }
  const lf = 'name_' + lang;
  for (const r of lakeRings) {
    const t = r.props[lf];
    if (!t || LATIN.test(t) || Math.abs(ringArea(r.ring)) < 9000) continue;
    let cx = 0, cy = 0; for (const p of r.ring) { cx += p[0]; cy += p[1]; } cx /= r.ring.length; cy /= r.ring.length;
    cands.push({ x: cx, y: cy, t, k: 'w', s: 24, pri: 6 });
  }
  const byRiver = new Map();
  for (const r of rivers) {
    const t = r.props[lf];
    if (!t || LATIN.test(t)) continue;
    const len = lineLength(r.line);
    if (len < 140) continue;
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
  for (const c of cands) {
    if (labels.length >= 14) break;
    const w = textWidth(c.t, c.s), h = c.s * 1.2;
    let x = c.x, y = c.dot ? c.y - c.s * 0.55 : c.y;
    x = Math.max(w / 2 + 6, Math.min(SIZE - w / 2 - 6, x));
    y = Math.max(h / 2 + 4, Math.min(SIZE - h / 2 - 4, y));
    const box = [x - w / 2 - 4, y - h / 2, x + w / 2 + 4, y + h / 2];
    if (boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
    boxes.push(box);
    if (c.dot) boxes.push([c.x - 6, c.y - 6, c.x + 6, c.y + 6]);
    const lab = [Math.round(x), Math.round(y), c.t, c.k, c.s];
    if (c.dot) lab.push(Math.round(c.x), Math.round(c.y));
    else if (c.a) lab.push(c.a);
    labels.push(lab);
  }
  stats.labels = labels.length;
  const s4 = { labels, script: SCRIPT_FAMILY[lang], translit };
  return { clue: { v: 1, km, s1, s2, s3, s4 }, stats };
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

async function main() {
  const t0 = Date.now();
  await ensureData();
  console.log('loading layers...');
  const L = {
    land: mergeLayers(await loadShapefile(shp('ne_10m_land')), await loadShapefile(shp('ne_10m_minor_islands'))),
    lakes: mergeLayers(await loadShapefile(shp('ne_10m_lakes')), await loadShapefile(shp('ne_10m_lakes_europe')), await loadShapefile(shp('ne_10m_lakes_north_america'))),
    rivers: mergeLayers(await loadShapefile(shp('ne_10m_rivers_lake_centerlines')), await loadShapefile(shp('ne_10m_rivers_europe')), await loadShapefile(shp('ne_10m_rivers_north_america'))),
    roads: await loadShapefile(shp('ne_10m_roads'), { filter: (p) => !/Ferry/.test(p.type || '') }),
    rail: await loadShapefile(shp('ne_10m_railroads')),
    urban: await loadShapefile(shp('ne_10m_urban_areas')),
    places: await loadShapefile(shp('ne_10m_populated_places')),
  };
  console.log('layers loaded in', ((Date.now() - t0) / 1000).toFixed(1), 's');

  fs.mkdirSync(path.join(OUT_PRIVATE, 'clues'), { recursive: true });
  fs.mkdirSync(path.join(OUT_PUBLIC, 'solo'), { recursive: true });
  const live = [], solo = [], report = [];
  LOCATIONS.forEach((loc, i) => {
    const [name, lat, lon, km, cc, diff] = loc;
    const { clue, stats } = buildClue(loc, L);
    const id = hash(name).slice(0, 10);
    const json = JSON.stringify(clue);
    const meta = { id, name, lat, lon, km, cc, diff };
    if (i % 4 === 1) {
      fs.writeFileSync(path.join(OUT_PUBLIC, 'solo', id + '.json'), json);
      solo.push(meta);
    } else {
      fs.writeFileSync(path.join(OUT_PRIVATE, 'clues', id + '.json'), json);
      live.push(meta);
    }
    report.push({ name, kb: +(json.length / 1024).toFixed(1), ...stats, land: +stats.landFrac.toFixed(2) });
  });
  fs.writeFileSync(path.join(OUT_PRIVATE, 'answers.json'), JSON.stringify(live, null, 0));
  // solo pack: answers lightly obfuscated so they aren't readable at a glance (client-side mode)
  const enc = Buffer.from(JSON.stringify(solo)).map((b, i) => b ^ (0x5a + (i % 13))).toString('base64');
  fs.writeFileSync(path.join(OUT_PUBLIC, 'solo-pack.json'), JSON.stringify({ v: 1, n: solo.length, p: enc }));

  console.log('building world basemap...');
  const W = {
    land: await loadShapefile(shp('ne_50m_land')),
    lakes: await loadShapefile(shp('ne_50m_lakes'), { filter: (p) => (p.scalerank ?? 9) <= 4 }),
    borders: await loadShapefile(shp('ne_50m_admin_0_boundary_lines_land')),
  };
  const world = JSON.stringify(buildWorld(W));
  fs.writeFileSync(path.join(OUT_PUBLIC, 'world.json'), world);

  console.table(report.filter((r) => r.labels < 3 || (r.coast < 50 && r.lakes === 0 && r.rivers < 2)));
  const kb = report.reduce((a, r) => a + r.kb, 0);
  console.log(`built ${live.length} live + ${solo.length} solo clues (${kb.toFixed(0)} KB total, avg ${(kb / report.length).toFixed(1)} KB), world ${(world.length / 1024).toFixed(0)} KB in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  fs.writeFileSync(path.join(OUT_PRIVATE, 'build-report.json'), JSON.stringify(report, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
