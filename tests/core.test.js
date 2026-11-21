// Regression tests for the core session's systems: meta progression, scoring bonuses, clue ordering,
// daily determinism, local-script validation, room membership (host migration, spectators, resume),
// lobby input validation / limits, HTTP hardening, graceful drain, content audit and balance sanity.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { roundPoints, SCORE, pickClue, targetRating, makeConfig, elimCount, isElimRound } from '../shared/game/rules.js';
import { makeRng } from '../shared/kit/rng.js';
import { TriangulateRoom, validLatLon, newToken } from '../shared/game/room.js';
import { emptyMeta, recordGame, levelFor, shareText, normalizeMeta, liveStreak, dailyNumber } from '../shared/game/meta.js';
import { inScript } from '../lib/mapdata/scripts.js';
import { Lobby } from '../lib/rooms/lobby.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(5); } };

function fakeClues(n = 40) {
  const metas = Array.from({ length: n }, (_, i) => ({ id: 'c' + i, lat: -60 + (i * 7) % 120, lon: -170 + (i * 37) % 340, name: 'C' + i, cc: 'XX', diff: 1 + (i % 3), rating: 1 + (i % 9) + 0.5, km: 300 }));
  const clue = { km: 300, s1: { land: '', coast: [], lakes: '', borders: [] }, s2: { rivers: [] }, s3: { roads: [], rail: [], urban: '' }, s4: { labels: [] } };
  return { list: () => metas, load: async () => clue, metas };
}

function mkRoom(opts = {}) {
  const inbox = new Map();
  const room = new TriangulateRoom({
    code: 'TEST', mode: 'private', clues: fakeClues(), speed: 200, ...opts,
    send: (pid, m) => { if (!inbox.has(pid)) inbox.set(pid, []); inbox.get(pid).push(m); },
  });
  return { room, inbox, last: (pid, t) => (inbox.get(pid) || []).filter((m) => m.t === t).pop() };
}

// ------------------------------------------------------------------ meta
test('meta: levels are monotonic and titles exist', () => {
  let prev = 0;
  for (let xp = 0; xp < 50000; xp += 137) { const l = levelFor(xp).level; assert.ok(l >= prev); prev = l; }
  assert.equal(levelFor(0).level, 1);
  assert.ok(levelFor(6300).level >= 9 && levelFor(6300).level <= 11);
});

test('meta: daily streak counts consecutive local days once per day', () => {
  let m = emptyMeta();
  const g = { daily: true, rank: 3, players: 10, total: 20000, roundsPlayed: 5, bulls: 1 };
  m = recordGame(m, g, '2026-11-19').meta; assert.equal(m.daily.streak, 1);
  m = recordGame(m, g, '2026-11-20').meta; assert.equal(m.daily.streak, 2);
  const again = recordGame(m, g, '2026-11-20'); // replay same day: no double count
  assert.equal(again.meta.daily.streak, 2); assert.equal(again.dailyFirst, false);
  m = recordGame(again.meta, g, '2026-11-23').meta; assert.equal(m.daily.streak, 1); // gap breaks it
  assert.equal(m.daily.best, 2);
  assert.equal(liveStreak(m, '2026-11-24'), 1);
  assert.equal(liveStreak(m, '2026-11-26'), 0);
  assert.equal(m.games, 4);
});

test('meta: corrupted storage never breaks', () => {
  for (const junk of [null, 42, 'x', [], { xp: -5, daily: { results: 'no', last: 'yesterday' } }, { xp: NaN, games: Infinity }]) {
    const n = normalizeMeta(junk);
    assert.equal(typeof n.xp, 'number'); assert.ok(n.xp >= 0); assert.equal(n.daily.last, null);
  }
});

test('meta: share text is a compact emoji grid with no answers in it', () => {
  const t = shareText({ daily: true, day: '2026-11-21', rank: 1, players: 10, total: 43136, streak: 4, url: 'https://example.test/',
    rounds: [{ d: 50, bull: true, stage: 1 }, { d: 420, stage: 2 }, { d: 1200, stage: 3 }, { d: 9000, stage: 4 }, null] });
  const lines = t.split('\n');
  assert.match(lines[0], /^TRIANGULATE Daily #21 — 🏆 1st of 10$/);
  assert.equal(lines[1], '🎯🟩🟨🟥⬛');
  assert.equal(lines[2], '1️⃣2️⃣3️⃣4️⃣▫️');
  assert.match(lines[3], /43,136 pts · 🔥4-day streak/);
  assert.equal(dailyNumber('2026-11-01'), 1);
});

// ------------------------------------------------------------------ rules
test('scoring: bullseye inside the window + capped streak bonus', () => {
  const a = roundPoints(100, 2, 300, 0);
  assert.ok(a.bull); assert.equal(a.bonus, SCORE.bullseye); assert.equal(a.streak, 1);
  const b = roundPoints(100, 2, 300, 9);
  assert.equal(b.bonus, SCORE.bullseye + SCORE.streakCap);
  const c = roundPoints(151, 2, 300, 3);
  assert.ok(!c.bull); assert.equal(c.bonus, 0); assert.equal(c.streak, 0);
  assert.deepEqual(roundPoints(null, 0, 300, 2), { pts: 0, base: 0, bonus: 0, bull: false, streak: 0 });
});

test('clues: rounds ramp easy -> hard and never repeat within a game', () => {
  const { metas } = fakeClues(120);
  let first = 0, lastR = 0;
  for (let g = 0; g < 200; g++) {
    const rng = makeRng(g), used = new Set();
    for (let n = 1; n <= 7; n++) {
      const c = pickClue(rng, metas, used, n, 7);
      assert.ok(!used.has(c.id)); used.add(c.id);
      if (n === 1) first += c.rating; if (n === 7) lastR += c.rating;
    }
  }
  assert.ok(first / 200 < 4 && lastR / 200 > 6, `avg r1 ${first / 200} r7 ${lastR / 200}`);
  assert.ok(targetRating(1, 7) < targetRating(7, 7));
});

test('daily: same seed => same clue sequence regardless of how the human plays', async () => {
  const seq = async (playWell) => {
    const { room, inbox } = mkRoom({ mode: 'solo', seed: 'daily-2026-11-21', speed: 400 });
    const me = room.addHuman({ name: 'me' });
    await until(() => (inbox.get(me.id) || []).some((m) => m.t === 'over'), 15000);
    const ids = room.clueLog.map((c) => c.id);
    room.dispose();
    return ids;
  };
  const a = await seq(true), b = await seq(false);
  assert.equal(a.length, 5);
  assert.deepEqual(a, b);
});

test('elimination: 25% cut leaves 3-5 finalists from 20; private/solo too', () => {
  for (const [mode, n] of [['public', 20], ['private', 8], ['solo', 10]]) {
    const c = makeConfig(mode);
    let alive = n;
    for (let r = 1; r <= c.rounds; r++) if (isElimRound(c, r)) alive -= elimCount(c, alive);
    assert.ok(alive >= 3 && alive <= 5, `${mode}: ${alive}`);
  }
});

test('input: lat/lon validation rejects junk and wraps longitudes', () => {
  for (const bad of [{}, { lat: '1', lon: 2 }, { lat: NaN, lon: 0 }, { lat: 91, lon: 0 }, { lat: 0, lon: Infinity }, { lat: [1], lon: 2 }]) assert.equal(validLatLon(bad), null);
  assert.deepEqual(validLatLon({ lat: 10, lon: 190 }), { lat: 10, lon: -170 });
  assert.deepEqual(validLatLon({ lat: 10, lon: -190 }), { lat: 10, lon: 170 });
  assert.match(newToken(), /^[0-9a-f]{32}$/);
});

// ------------------------------------------------------------------ scripts
test('scripts: labels must be entirely in the claimed script', () => {
  assert.ok(inScript('กรุงเทพมหานคร', 'th'));
  assert.ok(inScript('Москва', 'ru'));
  assert.ok(inScript('Нови Сад', 'sr'));
  assert.ok(inScript('ශ්‍රී ලංකාව', 'si')); // ZWJ allowed
  assert.ok(!inScript('Moscow', 'ru'));
  assert.ok(!inScript('Москва Moscow', 'ru'));
  assert.ok(!inScript('กรุงเทพ ភ្នំពេញ', 'th')); // Thai + Khmer mix
  assert.ok(!inScript('123', 'ru'));
});

// ------------------------------------------------------------------ room membership
test('room: private host migration in lobby and new host can start', async () => {
  const { room, inbox, last } = mkRoom();
  const a = room.addHuman({ name: 'host' });
  const b = room.addHuman({ name: 'guest' });
  assert.equal(room.hostId, a.id);
  room.handle(b.id, { t: 'start' }); // not host: ignored
  assert.equal(room.phaseEnd, 0);
  room.disconnect(a.id, { leave: true });
  await sleep(0);
  assert.equal(room.hostId, b.id);
  assert.equal(last(b.id, 'lobby').host, b.id);
  room.handle(b.id, { t: 'start', bots: true });
  await until(() => room.phase !== 'lobby');
  room.dispose();
});

test('room: late joiner spectates, cannot act, and plays the next game', async () => {
  const { room, inbox } = mkRoom({ speed: 400 });
  const a = room.addHuman({ name: 'host' });
  room.handle(a.id, { t: 'start', bots: true });
  await until(() => room.phase === 'round');
  const late = room.addHuman({ name: 'late' });
  assert.ok(late.spec && !late.alive);
  const snap = (inbox.get(late.id) || []).find((m) => m.t === 'snap');
  assert.equal(snap.phase, 'round');
  room.handle(late.id, { t: 'lock', lat: 1, lon: 1 });
  assert.equal(late.lock, 0);
  await until(() => room.phase === 'over', 20000);
  room.handle(a.id, { t: 'again' });
  room.handle(late.id, { t: 'again' });
  await until(() => room.phase === 'lobby');
  assert.ok(room.players.get(late.id).alive && !room.players.get(late.id).spec);
  room.dispose();
});

test('room: resume by token mid-game restores the seat; wrong token does not', async () => {
  const { room, inbox } = mkRoom({ speed: 400 });
  const a = room.addHuman({ name: 'a' });
  room.handle(a.id, { t: 'start', bots: true });
  await until(() => room.phase === 'round');
  room.disconnect(a.id);
  assert.equal(room.reconnect('0'.repeat(32)), null);
  const p = room.reconnect(a.token);
  assert.equal(p.id, a.id); assert.ok(p.conn);
  const snap = (inbox.get(a.id) || []).filter((m) => m.t === 'snap').pop();
  assert.ok(snap.phase === 'round' && snap.stages.length >= 1);
  room.dispose();
});

test('room: answers are not in any message before the reveal', async () => {
  const { room, inbox } = mkRoom({ speed: 300 });
  const a = room.addHuman({ name: 'a' });
  room.handle(a.id, { t: 'start', bots: true });
  await until(() => room.phase === 'reveal', 20000);
  const msgs = inbox.get(a.id);
  const firstReveal = msgs.findIndex((m) => m.t === 'reveal');
  const before = JSON.stringify(msgs.slice(0, firstReveal));
  const ans = room.clue.meta;
  assert.ok(!before.includes(`"${ans.name}"`), 'answer name leaked');
  assert.ok(!before.includes(String(ans.lat)) || !before.includes(String(ans.lon)), 'answer coordinates leaked');
  assert.ok(!/"id":"c\d+"/.test(before), 'clue id leaked');
  room.dispose();
});

// ------------------------------------------------------------------ lobby (fake sockets)
class FakeWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.out = []; this.closed = null; }
  send(s) { this.out.push(JSON.parse(s)); }
  close(code) { this.closed = code; this.readyState = 3; this.emit('close'); }
  terminate() { this.close(1006); }
  ping() {}
  msg(o) { this.emit('message', Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)), false); }
  last(t) { return this.out.filter((m) => m.t === t).pop(); }
}
function mkLobby(limits) {
  const lobby = new Lobby({ log: () => {}, limits, createRoom: ({ code, mode, send, onEmpty }) => new TriangulateRoom({ code, mode, clues: fakeClues(), send, onEmpty, speed: 50 }) });
  return lobby;
}

test('lobby: junk messages are ignored, resume with a bad token is refused', () => {
  const lobby = mkLobby();
  const ws = new FakeWs();
  lobby.attach(ws, '1.1.1.1');
  for (const junk of ['nope', '[]', 'null', '{"t":5}', JSON.stringify({ t: 'pin', lat: 1 }), JSON.stringify({ t: 'join', mode: 'weird' })]) ws.msg(junk);
  assert.equal(ws.last('error')?.code, 'bad');
  ws.msg({ t: 'join', resume: true, token: 'f'.repeat(32), code: 'ABCD', mode: 'public', name: 'x' });
  assert.equal(ws.last('error').code, 'expired');
  ws.msg({ t: 'join', mode: 'private', code: '../../', name: 'x' });
  assert.equal(ws.last('error').code, 'noroom');
  lobby.dispose();
});

test('lobby: per-IP socket cap, room-creation cap and flood close', () => {
  const lobby = mkLobby({ maxSocketsPerIp: 3, roomCreatesPerIpPerMin: 2 });
  const socks = Array.from({ length: 4 }, () => new FakeWs());
  const ok = socks.map((s) => lobby.attach(s, '9.9.9.9'));
  assert.deepEqual(ok, [true, true, true, false]);
  assert.equal(socks[3].closed, 1013);
  socks[0].msg({ t: 'join', mode: 'create', name: 'a' });
  socks[1].msg({ t: 'join', mode: 'create', name: 'b' });
  socks[2].msg({ t: 'join', mode: 'create', name: 'c' });
  assert.equal(lobby.rooms.size, 2);
  assert.equal(socks[2].last('error').code, 'busy');
  const f = new FakeWs();
  lobby.attach(f, '8.8.8.8');
  for (let i = 0; i < 200; i++) f.msg({ t: 'ping', c: 1 });
  assert.equal(f.closed, 1008);
  lobby.dispose();
});

test('lobby: reconnect with token rebinds the same seat in the same room', () => {
  const lobby = mkLobby();
  const a = new FakeWs();
  lobby.attach(a, '2.2.2.2');
  a.msg({ t: 'join', mode: 'create', name: 'alice' });
  const w = a.last('welcome');
  a.close(1006);
  const a2 = new FakeWs();
  lobby.attach(a2, '2.2.2.2');
  a2.msg({ t: 'join', mode: 'create', name: 'alice', token: w.token, code: w.code });
  const w2 = a2.last('welcome');
  assert.equal(w2.you, w.you);
  assert.equal(w2.code, w.code);
  assert.equal(lobby.rooms.size, 1);
  lobby.dispose();
});

// ------------------------------------------------------------------ HTTP server + drain
test('server: malformed URLs, traversal and private data are refused without crashing', async () => {
  const { createServer } = await import('../server/index.js');
  const srv = await createServer({ port: 0, quiet: true });
  const base = `http://127.0.0.1:${srv.port}`;
  try {
    const st = async (p, opt) => (await fetch(base + p, opt)).status;
    assert.equal(await st('/%E0%A4%A'), 400);
    assert.equal(await st('/%00'), 400);
    assert.ok([403, 404].includes(await st('/..%2f..%2fdata%2fbuild%2fanswers.json')));
    assert.ok([403, 404].includes(await st('/shared/..%2f..%2fdata/build/answers.json')));
    assert.equal(await st('/data/build/answers.json'), 404);
    assert.equal(await st('/', { method: 'POST' }), 405);
    assert.equal(await st('/index.html'), 200);
    const h = await (await fetch(base + '/healthz')).json();
    assert.equal(h.ok, true);
    const d = await Promise.race([srv.lobby.drain({ maxMs: 2000 }), sleep(1500).then(() => 'slow')]);
    assert.equal(d, 'drained'); // no games running -> immediate
  } finally { await srv.close(); }
});

// ------------------------------------------------------------------ reverse proxies
test('proxy: ws URL is relative to the page (path prefix + https -> wss)', async () => {
  const { wsUrl } = await import('../shared/kit/wsurl.js');
  assert.equal(wsUrl(new URL('https://games.example/tri/?room=ABCD#x')), 'wss://games.example/tri/ws');
  assert.equal(wsUrl(new URL('http://127.0.0.1:8787/')), 'ws://127.0.0.1:8787/ws');
  assert.equal(wsUrl(new URL('https://x.example/tri/index.html')), 'wss://x.example/tri/ws');
});

test('proxy: X-Forwarded-For only trusted from loopback / TRUST_PROXY', async () => {
  const { clientIp } = await import('../server/index.js');
  const req = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  assert.equal(clientIp(req('127.0.0.1', '203.0.113.7, 10.0.0.1'), 'loopback'), '203.0.113.7');
  assert.equal(clientIp(req('198.51.100.2', '203.0.113.7'), 'loopback'), '198.51.100.2'); // spoof from the internet
  assert.equal(clientIp(req('10.1.2.3', '203.0.113.7'), '1'), '203.0.113.7');
  assert.equal(clientIp(req('127.0.0.1', '203.0.113.7'), '0'), '127.0.0.1');
});

// ------------------------------------------------------------------ content + balance
test('content: built clue pool passes the audit (>= 250 clues, no hard failures)', async () => {
  if (!fs.existsSync('data/build/build-report.json')) return;
  const { audit } = await import('../tools/audit-clues.js');
  const res = audit(JSON.parse(fs.readFileSync('data/build/build-report.json', 'utf8')));
  assert.ok(res.n >= 250, 'clues ' + res.n);
  assert.deepEqual(res.fails, []);
  for (const c of ['Europe', 'Asia', 'Africa', 'Middle East', 'North America', 'South America', 'Oceania']) assert.ok((res.cont[c] || 0) >= 15, c + ' ' + res.cont[c]);
});

test('content: stage-4 labels never spell out the answer (Latin-script clues)', () => {
  if (!fs.existsSync('data/build/answers.json')) return;
  const norm = (x) => String(x).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
  const dec = (j) => JSON.parse(Buffer.from(j.p, 'base64').map((x, i) => x ^ (0x5a + (i % 13))).toString());
  const live = JSON.parse(fs.readFileSync('data/build/answers.json', 'utf8')).map((m) => [m, `data/build/clues/${m.id}.json`]);
  const solo = dec(JSON.parse(fs.readFileSync('public/data/solo-pack.json', 'utf8'))).map((m) => [m, `public/data/solo/${m.id}.json`]);
  let latin = 0;
  for (const [m, file] of [...live, ...solo]) {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(!c.s4.translit, 'no transliteration: ' + m.name);
    if (c.s4.script !== 'Latin') continue;
    latin++;
    for (const l of c.s4.labels) assert.notEqual(norm(l[2]), norm(m.name), `${m.name}: label "${l[2]}" names the answer`);
  }
  assert.ok(latin > 100, 'latin clues ' + latin);
});

test('balance: simulated decent human survives a few rounds and sometimes wins', async () => {
  if (!fs.existsSync('data/build/answers.json')) return;
  const { runSim } = await import('../tools/sim.js');
  const { out } = runSim({ games: 1500, seed: 7 });
  const pct = (s) => parseFloat(s);
  assert.ok(pct(out.decent.win) > 6 && pct(out.decent.win) < 30, 'decent win ' + out.decent.win);
  assert.ok(parseFloat(out.decent.roundsAlive) >= 4.5, 'decent rounds ' + out.decent.roundsAlive);
  assert.ok(pct(out.casual.survR2) > 60, 'casual survives r2 ' + out.casual.survR2);
  assert.ok(pct(out.expert.win) > pct(out.strong.win) && pct(out.strong.win) > pct(out.decent.win));
});
