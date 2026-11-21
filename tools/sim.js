#!/usr/bin/env node
// Gameplay simulator: plays thousands of 20-player public games (1 modelled human + 19 bots) with the
// real rules (shared/game/rules.js) and the real clue difficulty distribution, and reports how each
// kind of human fares.  Used to tune scoring, bonuses, elimination pacing and bot skill.
//   node tools/sim.js [--games=3000] [--mode=public|solo|private] [--scaleKm=1200] [--elimFrac=0.25] [--bullseye=500]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRng } from '../shared/kit/rng.js';
import { makeConfig, isElimRound, elimCount, roundPoints, planGuess, pickClue, botSkill, SCORE, CLOSE_CALL_PTS } from '../shared/game/rules.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };

export const HUMANS = {
  casual: { skill: 0.3, aggression: 0.35 },
  decent: { skill: 0.55, aggression: 0.5 },
  strong: { skill: 0.72, aggression: 0.6 },
  expert: { skill: 0.88, aggression: 0.7 },
};

function loadMetas() {
  const live = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/build/answers.json'), 'utf8'));
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/solo-pack.json'), 'utf8'));
  const solo = JSON.parse(Buffer.from(j.p, 'base64').map((x, i) => x ^ (0x5a + (i % 13))).toString());
  return { live, solo };
}

/** One game. Returns per-player results; player 0 is the modelled human. */
export function simGame(rng, cfg, metas, human, { players = cfg.maxPlayers, skillFn = botSkill } = {}) {
  const ps = [{ id: 0, human: true, profile: human, total: 0, alive: true, elim: 0, streak: 0, bulls: 0 }];
  for (let i = 1; i < players; i++) ps.push({ id: i, profile: { skill: skillFn(rng), aggression: rng() }, total: 0, alive: true, elim: 0, streak: 0, bulls: 0 });
  const used = new Set();
  const log = { cutMargins: [], close: 0, humanRounds: [] };
  for (let n = 1; n <= cfg.rounds; n++) {
    const clue = pickClue(rng, metas, used, n, cfg.rounds);
    used.add(clue.id);
    for (const p of ps) {
      if (!p.alive) continue;
      const g = planGuess(rng, p.profile, clue);
      const r = roundPoints(g.dist, g.stage, clue.km, p.streak);
      p.total += r.pts; p.streak = r.streak; p.bulls += r.bull ? 1 : 0; p.last = r.pts;
      if (p.human) log.humanRounds.push({ n, rating: clue.rating, stage: g.stage, dist: g.dist, pts: r.pts, bull: r.bull });
    }
    if (isElimRound(cfg, n)) {
      const alive = ps.filter((p) => p.alive).sort((a, b) => a.total - b.total || a.last - b.last);
      const k = elimCount(cfg, alive.length);
      const out = alive.slice(0, k);
      for (const p of out) { p.alive = false; p.elim = n; }
      const best = out[out.length - 1]?.total ?? 0;
      const firstSafe = alive[k];
      if (firstSafe) log.cutMargins.push(firstSafe.total - best);
      if (ps[0].alive && k && ps[0].total - best < CLOSE_CALL_PTS) log.close++;
    }
  }
  const ranked = ps.slice().sort((a, b) => (b.alive - a.alive) || (b.alive ? 0 : b.elim - a.elim) || (b.total - a.total));
  return { ps, ranked, log, rank: ranked.indexOf(ps[0]) + 1 };
}

export function runSim({ games = 3000, mode = "public", seed = 1, humans = HUMANS, skillFn = botSkill } = {}) {
  const cfg = makeConfig(mode);
  const { live, solo } = loadMetas();
  const metas = mode === 'solo' ? solo : live;
  const rng = makeRng(seed);
  const out = {};
  for (const [name, h] of Object.entries(humans)) {
    const st = { win: 0, top3: 0, final: 0, survR2: 0, roundsAlive: 0, rank: 0, close: 0, bulls: 0, botWinnerScore: 0, margins: [], stage: [0, 0, 0, 0], pts: 0 };
    for (let g = 0; g < games; g++) {
      const r = simGame(rng, cfg, metas, h, { skillFn });
      const me = r.ps[0];
      if (r.rank === 1) st.win++;
      if (r.rank <= 3) st.top3++;
      if (me.alive) st.final++;
      if (!me.elim || me.elim > 2) st.survR2++;
      st.roundsAlive += me.alive ? cfg.rounds : me.elim;
      st.rank += r.rank;
      st.close += r.log.close;
      st.bulls += me.bulls;
      st.winnerScore = (st.winnerScore || 0) + r.ranked[0].total;
      st.margins.push(...r.log.cutMargins);
      for (const hr of r.log.humanRounds) { st.stage[hr.stage - 1]++; st.pts += hr.pts; }
    }
    st.margins.sort((a, b) => a - b);
    const ns = st.stage.reduce((a, b) => a + b, 0);
    out[name] = {
      win: (st.win / games * 100).toFixed(1) + '%', top3: (st.top3 / games * 100).toFixed(1) + '%',
      final: (st.final / games * 100).toFixed(1) + '%', survR2: (st.survR2 / games * 100).toFixed(1) + '%',
      roundsAlive: (st.roundsAlive / games).toFixed(2), avgRank: (st.rank / games).toFixed(1),
      closeCalls: (st.close / games).toFixed(2), bullseyes: (st.bulls / games).toFixed(2),
      ptsPerRound: Math.round(st.pts / ns), lockStages: st.stage.map((x) => Math.round(x / ns * 100) + '%').join('/'),
      winnerScore: Math.round(st.winnerScore / games), medCutMargin: st.margins[st.margins.length >> 1],
    };
  }
  return { cfg: { rounds: cfg.rounds, players: cfg.maxPlayers, elimFrac: cfg.elimFrac, scale: SCORE.scaleKm, bull: SCORE.bullseye }, out };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // allow quick what-ifs from the CLI
  if (arg('scaleKm')) SCORE.scaleKm = Number(arg('scaleKm'));
  if (arg('bullseye')) SCORE.bullseye = Number(arg('bullseye'));
  if (arg('streakStep')) SCORE.streakStep = Number(arg('streakStep'));
  const { BASE_CONFIG } = await import('../shared/game/rules.js');
  if (arg('elimFrac')) BASE_CONFIG.elimFrac = Number(arg('elimFrac'));
  const res = runSim({ games: Number(arg('games', 3000)), mode: arg('mode', 'public') });
  console.log(JSON.stringify(res.cfg));
  console.table(res.out);
}
