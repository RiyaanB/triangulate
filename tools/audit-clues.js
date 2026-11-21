#!/usr/bin/env node
// Clue quality audit over data/build/build-report.json (written by build-data.js).
// Fails (exit 1) on hard problems: ocean-only frames, empty stage 1, too few stage-4 labels,
// near-duplicate windows. Prints warnings, continent balance and difficulty histogram.
//   node tools/audit-clues.js [--json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { distanceKm } from '../shared/kit/geo.js';
import { LOCATIONS } from './locations.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const RULES = {
  minLand: 0.04, // below: ocean-only frame
  maxWater: 0.985,
  minS1: 160, // stage-1 linework (coast + lakeshore + borders, frame units)
  warnS1: 400,
  minLabels: 2,
  warnLabels: 3,
  dupFrac: 0.45, // centres closer than this fraction of the mean window size = near-duplicate
};

export function audit(report) {
  const fails = [], warns = [];
  const byName = new Map(LOCATIONS.map((l) => [l[0], l]));
  for (const r of report) {
    const tag = `${r.name} (${r.cc}, ${r.km}km)`;
    if (r.land < RULES.minLand) fails.push(`${tag}: ocean-only frame (land ${r.land})`);
    if (r.s1 < RULES.minS1) fails.push(`${tag}: stage 1 nearly empty (s1=${r.s1})`);
    else if (r.s1 < RULES.warnS1) warns.push(`${tag}: weak stage 1 (s1=${r.s1})`);
    if (r.labels < RULES.minLabels) fails.push(`${tag}: only ${r.labels} stage-4 labels (${r.lang})`);
    else if (r.labels < RULES.warnLabels) warns.push(`${tag}: ${r.labels} stage-4 labels (${r.lang})`);
    if (r.rivers < 60 && r.roads < 120 && r.urban < 5) warns.push(`${tag}: stages 2-3 nearly empty`);
    if (r.badScript?.length) warns.push(`${tag}: dropped wrong-script names: ${r.badScript.join(', ')}`);
  }
  for (let i = 0; i < report.length; i++) {
    for (let j = i + 1; j < report.length; j++) {
      const a = byName.get(report[i].name), b = byName.get(report[j].name);
      if (!a || !b) continue;
      const d = distanceKm(a[1], a[2], b[1], b[2]);
      if (d < RULES.dupFrac * (a[3] + b[3]) / 2) fails.push(`near-duplicate: ${a[0]} / ${b[0]} (${Math.round(d)} km apart)`);
    }
  }
  const cont = {}, hist = Array(10).fill(0), scripts = {};
  for (const r of report) {
    cont[r.cont] = (cont[r.cont] || 0) + 1;
    hist[Math.min(9, Math.floor(r.rating) - 1)]++;
    const k = r.translit ? 'translit' : r.lang;
    scripts[k] = (scripts[k] || 0) + 1;
  }
  return { fails, warns, cont, hist, scripts, n: report.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/build/build-report.json'), 'utf8'));
  const res = audit(report);
  if (process.argv.includes('--json')) { console.log(JSON.stringify(res, null, 1)); process.exit(res.fails.length ? 1 : 0); }
  console.log(`${res.n} clues`);
  console.log('continents:', Object.entries(res.cont).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · '));
  console.log('label scripts:', Object.entries(res.scripts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '));
  console.log('difficulty 1..10:', res.hist.join(' '));
  if (res.warns.length) console.log(`\nWARN (${res.warns.length})\n  ` + res.warns.join('\n  '));
  if (res.fails.length) console.log(`\nFAIL (${res.fails.length})\n  ` + res.fails.join('\n  '));
  process.exit(res.fails.length ? 1 : 0);
}
