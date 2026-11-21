// TRIANGULATE rules: timings, scoring, elimination, bot error model. Shared by server + solo client.
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
  elimFrac: 0.2,
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

export function scoreFor(distKm, stage) {
  const base = 5000 * Math.exp(-distKm / 1500);
  return Math.round(base * STAGE_MULT[stage - 1]);
}

export function elimCount(cfg, alive) {
  if (alive <= cfg.minAlive) return 0;
  return Math.min(alive - cfg.minAlive, Math.max(1, Math.round(alive * cfg.elimFrac)));
}

/** Difficulty curve for picking clues per round (weights for diff 1,2,3). */
export function diffWeights(n, rounds) {
  const t = rounds <= 1 ? 0 : (n - 1) / (rounds - 1);
  if (n === 1) return [1, 0.25, 0];
  return [Math.max(0.15, 1 - t * 1.2), 1, 0.2 + t * 1.3];
}

/**
 * Bot brain: decide when (which stage) a bot locks and where it guesses.
 * Heavy-tailed (log-normal + occasional wild miss) error around the truth.
 */
export function planBotGuess(rng, profile, clue, cfg) {
  const { skill, aggression } = profile;
  const a = aggression;
  const w = [0.04 + 0.42 * a * (0.5 + skill), 0.14 + 0.25 * a, 0.32, 0.55 - 0.4 * a];
  const stage = rng.weighted(w) + 1;
  const baseByDiff = [520, 950, 1550][clue.diff - 1] || 950;
  const stageFactor = [2.1, 1.55, 1.1, 0.7][stage - 1];
  const skillFactor = 2.4 - 1.95 * skill; // 0.45 .. 2.4
  let d = baseByDiff * stageFactor * skillFactor * Math.exp(0.85 * rng.normal());
  if (rng() < 0.08 - 0.05 * skill) d = 2500 + rng() * 7500; // wild miss: wrong continent
  d = Math.min(14000, Math.max(3, d));
  const [lat, lon] = destination(clue.lat, clue.lon, rng() * 360, d);
  // lock time: somewhere inside that stage's window, biased toward its end (thinking)
  const start = cfg.stageAt[stage - 1] + 600;
  const end = (stage < 4 ? cfg.stageAt[stage] : cfg.roundMs - 1500) - 300;
  const lockAt = start + (end - start) * Math.pow(rng(), 0.6);
  return { stage, lat: Math.max(-85, Math.min(85, lat)), lon, lockAt };
}
