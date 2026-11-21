import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreFor, elimCount, makeConfig, planBotGuess, isElimRound } from '../shared/game/rules.js';
import { distanceKm, destination, greatCircle } from '../shared/kit/geo.js';
import { makeRng } from '../shared/kit/rng.js';
import { Scheduler } from '../shared/kit/scheduler.js';
import { clipRing, clipLine, simplify, toPath } from '../lib/mapdata/geometry.js';
import { TriangulateRoom, sanitizeName } from '../shared/game/room.js';

test('scoring: distance decay and stage multipliers', () => {
  assert.equal(scoreFor(0, 4), 5000);
  assert.equal(scoreFor(0, 1), 10000);
  assert.ok(scoreFor(1500, 4) > 1830 && scoreFor(1500, 4) < 1845);
  assert.ok(scoreFor(100, 2) > scoreFor(100, 3));
  assert.ok(scoreFor(20000, 1) < 10);
});

test('elimination: bottom 20%, never below minAlive, only rounds 2..6', () => {
  const c = makeConfig('public');
  assert.equal(elimCount(c, 20), 4);
  assert.equal(elimCount(c, 4), 1);
  assert.equal(elimCount(c, 3), 0);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((n) => isElimRound(c, n)), [false, true, true, true, true, true, false]);
  let alive = 20;
  for (let r = 2; r <= 6; r++) alive -= elimCount(c, alive);
  assert.ok(alive >= 3 && alive <= 6, 'final alive ' + alive);
});

test('geo: distance/destination roundtrip and great circle', () => {
  const d = distanceKm(51.5, -0.12, 48.85, 2.35);
  assert.ok(Math.abs(d - 343) < 5, String(d));
  const [lat, lon] = destination(10, 20, 45, 1000);
  assert.ok(Math.abs(distanceKm(10, 20, lat, lon) - 1000) < 0.5);
  const gc = greatCircle([0, 170], [0, -170], 10);
  assert.equal(gc.length, 11);
});

test('bots: heavy-tailed errors with stage choice', () => {
  const rng = makeRng(42);
  const cfg = makeConfig('public');
  const errs = [], stages = [0, 0, 0, 0];
  for (let i = 0; i < 2000; i++) {
    const p = planBotGuess(rng, { skill: rng(), aggression: rng() }, { lat: 30, lon: 30, diff: 2 }, cfg);
    errs.push(distanceKm(30, 30, p.lat, p.lon)); stages[p.stage - 1]++;
    assert.ok(p.lockAt > 0 && p.lockAt < cfg.roundMs);
  }
  errs.sort((a, b) => a - b);
  const med = errs[1000], p95 = errs[1900];
  assert.ok(med > 300 && med < 2500, 'median ' + med);
  assert.ok(p95 > 3 * med, 'heavy tail');
  assert.ok(stages.every((s) => s > 100), 'all stages used ' + stages);
});

test('scheduler: virtual time and speed changes', async () => {
  const s = new Scheduler({ speed: 10 });
  const order = [];
  s.after(200, () => order.push('b'));
  s.after(100, () => order.push('a'));
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(order, ['a', 'b']);
  s.dispose();
});

test('geometry: clipping and simplification', () => {
  const ring = [[-10, -10], [10, -10], [10, 10], [-10, 10]];
  const c = clipRing(ring, [0, 0, 20, 20]);
  assert.equal(c.length, 4);
  const lines = clipLine([[-5, 5], [5, 5], [5, 25], [5, 30]], [0, 0, 10, 10]);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0][0], [0, 5]);
  const s = simplify([[0, 0], [1, 0.01], [2, 0], [3, 5]], 0.1);
  assert.equal(s.length, 3);
  assert.equal(toPath([[[0, 0], [3, 4], [1, 1]]]), 'M0 0l3 4-2-3');
});

test('names are sanitised', () => {
  assert.equal(sanitizeName('<b>hi</b>'), 'bhi/b');
  assert.equal(sanitizeName('x'.repeat(40)).length, 16);
  assert.match(sanitizeName('  '), /^Player\d+$/);
});

test('room: full fast game with a disconnecting human ends with ranking', async () => {
  const metas = [1, 2, 3].flatMap((d) => Array.from({ length: 6 }, (_, i) => ({ id: `c${d}${i}`, lat: i * 10, lon: d * 20, name: 'X', cc: 'XX', diff: d, km: 300 })));
  const clue = { km: 300, s1: { land: '', coast: [], lakes: '' }, s2: { rivers: [] }, s3: { roads: [], rail: [], urban: '' }, s4: { labels: [] } };
  const clues = { list: () => metas, load: async () => clue };
  const got = { a: [], b: [] };
  let room; var A;
  const over = new Promise((resolve) => {
    room = new TriangulateRoom({
      code: 'T', mode: 'public', clues, speed: 400,
      send: (pid, m) => { const isA = typeof A !== "undefined" && pid === A?.id; (isA ? got.a : got.b).push(m.t); if (m.t === "over" && isA) resolve(m); },
    });
  });
  A = room.addHuman({ name: 'alice' });
  const B = room.addHuman({ name: 'bob' });
  setTimeout(() => room.disconnect(B.id), 150); // bob drops mid-game
  const m = await over;
  assert.equal(m.ranking.length, 20);
  assert.ok(got.a.includes('reveal') && got.a.includes('standings'));
  assert.ok(m.ranking.filter((r) => r.alive).length >= 3);
  room.dispose();
});
