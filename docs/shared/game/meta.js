// Lightweight local progression: XP / levels, daily streak, and the share-result text.
// Pure functions over a plain state object (the browser keeps it in localStorage; nothing leaves the device).

export const DAILY_EPOCH = '2026-11-01'; // Daily #1

/** Local calendar date as YYYY-MM-DD (players expect "today" in their own timezone). */
export function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const dayNum = (s) => Math.round(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000);
export const dailyNumber = (day) => dayNum(day) - dayNum(DAILY_EPOCH) + 1;
export const prevDay = (day) => { const t = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) - 86400000); return t.toISOString().slice(0, 10); };

export function emptyMeta() {
  return { v: 1, xp: 0, games: 0, wins: 0, bulls: 0, best: 0, daily: { last: null, streak: 0, best: 0, results: {} } };
}

/** Defensive load: anything malformed becomes a fresh profile instead of breaking the title screen. */
export function normalizeMeta(m) {
  const e = emptyMeta();
  if (!m || typeof m !== 'object') return e;
  const num = (x, d = 0) => (Number.isFinite(x) && x >= 0 ? Math.floor(x) : d);
  const out = { v: 1, xp: num(m.xp), games: num(m.games), wins: num(m.wins), bulls: num(m.bulls), best: num(m.best), daily: { ...e.daily } };
  const d = m.daily || {};
  out.daily.last = typeof d.last === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.last) ? d.last : null;
  out.daily.streak = num(d.streak); out.daily.best = num(d.best);
  if (d.results && typeof d.results === 'object') {
    // keep the last 60 daily results only
    const keys = Object.keys(d.results).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort().slice(-60);
    for (const k of keys) out.daily.results[k] = d.results[k];
  }
  return out;
}

// ---- levels: level L -> L+1 costs 200 + 100*(L-1) XP (first level-up after 1-2 games, L10 after ~30)
export function levelFor(xp) {
  let lvl = 1, need = 200, floor = 0;
  while (xp >= floor + need) { floor += need; lvl++; need = 200 + 100 * (lvl - 1); }
  return { level: lvl, into: xp - floor, need, frac: (xp - floor) / need };
}

export const TITLES = [[1, 'Tourist'], [3, 'Backpacker'], [5, 'Navigator'], [8, 'Surveyor'], [12, 'Cartographer'], [17, 'Geodesist'], [23, 'Atlas']];
export const titleFor = (level) => TITLES.filter(([l]) => level >= l).pop()[1];

/**
 * XP for one finished game.
 * @param {object} g { rank, players, roundsPlayed, rounds, bulls, total, won, daily }
 */
export function xpForGame(g) {
  const parts = [
    ['Played', 40],
    ['Rounds', 15 * (g.roundsPlayed || 0)],
    ['Bullseyes', 25 * (g.bulls || 0)],
    ['Placement', g.rank === 1 ? 150 : g.rank <= 3 ? 60 : g.rank <= Math.ceil((g.players || 20) / 2) ? 20 : 0],
    ['Score', Math.floor((g.total || 0) / 2000) * 5],
  ];
  if (g.dailyFirst) parts.push(['Daily', 50]);
  const xp = parts.reduce((a, [, v]) => a + v, 0);
  return { xp, parts: parts.filter(([, v]) => v > 0) };
}

/**
 * Apply a finished game. Returns { meta, gained, levelUp, before, after, streak }.
 * For daily games, the first result of a (local) day counts for the streak and is stored for sharing.
 */
export function recordGame(meta0, g, today = localDay()) {
  const meta = normalizeMeta(meta0);
  const before = levelFor(meta.xp);
  let dailyFirst = false;
  if (g.daily) {
    const d = meta.daily;
    if (!d.results[today]) {
      dailyFirst = true;
      d.streak = d.last === prevDay(today) ? d.streak + 1 : d.last === today ? d.streak : 1;
      d.best = Math.max(d.best, d.streak);
      d.last = today;
      d.results[today] = { rank: g.rank, players: g.players, total: g.total, grid: g.grid || [] };
    }
  }
  const { xp, parts } = xpForGame({ ...g, dailyFirst });
  meta.xp += xp; meta.games++; meta.bulls += g.bulls || 0;
  if (g.rank === 1) meta.wins++;
  meta.best = Math.max(meta.best, g.total || 0);
  const after = levelFor(meta.xp);
  return { meta: normalizeMeta(meta), gained: xp, parts, levelUp: after.level > before.level, before, after, dailyFirst, streak: meta.daily.streak };
}

/** Current daily streak as of today (a streak is broken once a whole day is skipped). */
export function liveStreak(meta, today = localDay()) {
  const d = normalizeMeta(meta).daily;
  return d.last === today || d.last === prevDay(today) ? d.streak : 0;
}

// ---- share text (Wordle-style; copied to the clipboard only)
/** One emoji per round: 🎯 bullseye, 🟩 <500 km, 🟨 <1500, 🟧 <3000, 🟥 farther, ⬜ no guess, ⬛ eliminated. */
export function roundEmoji(r) {
  if (!r) return '⬛';
  if (r.d == null) return '⬜';
  if (r.bull) return '🎯';
  return r.d < 500 ? '🟩' : r.d < 1500 ? '🟨' : r.d < 3000 ? '🟧' : '🟥';
}
const KEYCAP = ['', '1️⃣', '2️⃣', '3️⃣', '4️⃣'];

/**
 * @param {object} o { day, rank, players, total, rounds:[{d,bull,stage}|null], streak, url, daily }
 */
export function shareText(o) {
  const ord = (n) => n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');
  const head = o.daily ? `TRIANGULATE Daily #${dailyNumber(o.day)}` : 'TRIANGULATE';
  const place = o.rank === 1 ? `🏆 1st of ${o.players}` : `${ord(o.rank)} of ${o.players}`;
  const grid = o.rounds.map(roundEmoji).join('');
  const stages = o.rounds.map((r) => (r && r.stage ? KEYCAP[r.stage] : '▫️')).join('');
  const lines = [`${head} — ${place}`, grid, stages, `${Number(o.total || 0).toLocaleString('en-US')} pts` + (o.streak > 1 ? ` · 🔥${o.streak}-day streak` : '')];
  if (o.url) lines.push(o.url);
  return lines.join('\n');
}
