// TRIANGULATE rules: timings, scoring, elimination, player/bot guess model. Shared by server + browser.
// Tuned with tools/sim.js (thousands of simulated games); see .build-notes/REPORT-core.md.
import { destination } from '../kit/geo.js';

export const STAGE_MULT = [2.0, 1.6, 1.3, 1.0];
export const STAGE_NAMES = ['Coast', 'Rivers', 'Roads', 'Names'];

export const BASE_CONFIG = {
  rounds: 7,
  maxPlayers: 20,
  stageAt: [0, 8000, 16000, 24000], // ms from round start when each stage reveals
  roundMs: 34000,
  introMs: 2600,
  revealMs: 8500,
  standingsMs: 5500,
  gameoverMs: 18000,
  lobbyMs: 12000, // public lobby countdown
  elimFrac: 0.25,
  minAlive: 3,
  fillBots: true,
};

export const MODE_CONFIG = {
  public: {},
  private: { lobbyMs: 0, maxPlayers: 12 },
  solo: { rounds: 5, maxPlayers: 10, lobbyMs: 0, gameoverMs: 0 },
};

export function makeConfig(mode, overrides = {}) {
  return { ...BASE_CONFIG, ...MODE_CONFIG[mode], ...overrides, mode };
}

/** Elimination happens after rounds 2..(rounds-1) */
export const isElimRound = (cfg, n) => n >= 2 && n < cfg.rounds;

// ------------------------------------------------------------------ scoring
export const SCORE = {
  max: 5000, // per round at 0 km, before the stage multiplier
  scaleKm: 1200, // exponential distance decay
  bullseye: 500, // guess lands inside the clue window (d <= window/2)
  streakStep: 250, // +250 per consecutive bullseye after the first ...
  streakCap: 750, // ... up to +750
};

/** Distance + stage points (no bonuses). */
export function scoreFor(distKm, stage) {
  const base = SCORE.max * Math.exp(-distKm / SCORE.scaleKm);
  return Math.round(base * STAGE_MULT[stage - 1]);
}

export const isBullseye = (distKm, windowKm) => distKm != null && distKm <= windowKm / 2;

/**
 * Full round result for one player. `streak` = bullseyes in a row before this round.
 * Returns { pts, base, bonus, bull, streak } where `streak` is the new streak length.
 */
export function roundPoints(distKm, stage, windowKm, streak = 0) {
  if (distKm == null || !stage) return { pts: 0, base: 0, bonus: 0, bull: false, streak: 0 };
  const base = scoreFor(distKm, stage);
  const bull = isBullseye(distKm, windowKm);
  const newStreak = bull ? streak + 1 : 0;
  const bonus = bull ? SCORE.bullseye + Math.min(SCORE.streakCap, SCORE.streakStep * (newStreak - 1)) : 0;
  return { pts: base + bonus, base, bonus, bull, streak: newStreak };
}

export function elimCount(cfg, alive) {
  if (alive <= cfg.minAlive) return 0;
  return Math.min(alive - cfg.minAlive, Math.max(1, Math.round(alive * cfg.elimFrac)));
}

/** "Close call": survivors whose total is within this many points of the best eliminated player. */
export const CLOSE_CALL_PTS = 1200;

// ------------------------------------------------------------------ clue difficulty curve
/** Target difficulty rating (1 easy .. 10 hard) for round n of `rounds`: a gentle ramp easy -> hard. */
export function targetRating(n, rounds) {
  const t = rounds <= 1 ? 0 : (n - 1) / (rounds - 1);
  return 2.2 + t * 5.3; // 2.2 .. 7.5
}

/** Clue meta difficulty: numeric rating if built with one, else the legacy 1..3 bucket. */
export const clueRating = (m) => m.rating ?? ([0, 2.5, 5, 7.5][m.diff] || 5);

/** Pick a clue for round n: closest to the target rating among unused ones, with some randomness. */
export function pickClue(rng, metas, used, n, rounds) {
  let pool = metas.filter((c) => !used.has(c.id));
  if (!pool.length) pool = metas;
  const target = targetRating(n, rounds);
  for (const win of [1.2, 2.2, 3.5, 99]) {
    const near = pool.filter((c) => Math.abs(clueRating(c) - target) <= win);
    if (near.length >= 3 || win === 99) return rng.pick(near.length ? near : pool);
  }
  return rng.pick(pool);
}

// ------------------------------------------------------------------ guess model (bots + simulator)
/**
 * Cumulative probability that a player of skill k (0..1) has recognised the place by stage s (1..4)
 * for a clue of difficulty rating R (1..10). Logistic in stage, skill and difficulty.
 */
export function recogProb(s, k, R) {
  const x = -3.0 + 1.2 * s + 4.2 * k - 0.45 * R;
  return 1 / (1 + Math.exp(-x));
}

/**
 * Plan one player's guess for a round. Recognition happens at the first stage where a single
 * uniform draw falls under recogProb; recognised players are accurate (~frame scale) and lock soon,
 * unsure players wait for more detail and guess at region level, gamblers sometimes lock early anyway.
 * @returns {{stage:number, dist:number, recognised:boolean}}
 */
export function planGuess(rng, profile, clue) {
  const k = profile.skill, agg = profile.aggression ?? 0.5;
  const R = clueRating(clue);
  const u = rng();
  let rs = 0;
  for (let s = 1; s <= 4; s++) if (u < recogProb(s, k, R)) { rs = s; break; }
  let stage, dist;
  const recErr = () => (25 + 9 * R) * (1.35 - 0.7 * k) * Math.exp(0.55 * rng.normal());
  const regionErr = (s) => {
    if (rng() < 0.1 * (1 - k) * (1.2 - 0.25 * s)) return 2500 + rng() * 6500; // wrong continent
    return [2400, 1700, 1150, 650][s - 1] * (1.45 - 0.85 * k) * Math.exp(0.7 * rng.normal());
  };
  if (rs && rs < 4 && rng() > 0.45 + 0.35 * k + 0.15 * agg) {
    stage = rs + 1; // recognised but double-checks one more stage
    dist = recErr() * 0.8;
  } else if (rs) {
    stage = rs; dist = recErr();
  } else if (rng() < 0.12 * agg) {
    stage = 1 + rng.int(2); dist = regionErr(stage); // gamble
  } else {
    stage = rng() < 0.25 + 0.3 * agg ? 3 : 4;
    dist = regionErr(stage);
  }
  return { stage, dist: Math.min(15000, Math.max(2, dist)), recognised: !!rs };
}

/** Bot brain: planGuess + a concrete lat/lon and a human-looking lock time inside that stage. */
export function planBotGuess(rng, profile, clue, cfg) {
  const { stage, dist } = planGuess(rng, profile, clue);
  const [lat, lon] = destination(clue.lat, clue.lon, rng() * 360, dist);
  const start = cfg.stageAt[stage - 1] + 900;
  const end = (stage < 4 ? cfg.stageAt[stage] : cfg.roundMs - 1500) - 300;
  const lockAt = start + (end - start) * Math.pow(rng(), 0.7);
  return { stage, lat: Math.max(-85, Math.min(85, lat)), lon, lockAt };
}

/** Bot skill profile: most bots casual-to-decent, a few sharp ones (see tools/sim.js for the tuning). */
export function botSkill(rng) {
  return 0.07 + 0.61 * Math.pow(rng(), 1.5);
}
