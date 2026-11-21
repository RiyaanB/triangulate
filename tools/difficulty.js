// Clue difficulty rating (1 = trivial .. 10 = brutal) from the curated base difficulty plus what the
// map actually shows at each stage. Used to order rounds easy -> hard and to scale bot accuracy.
export function rateClue(s) {
  const base = [0, 2.5, 5, 7.5][s.diff] ?? 5;
  let r = base;
  // Stage 1 is the high-multiplier stage: how much recognisable shape does it show? (log scale:
  // s1 ~100 frame units of linework = nearly blank, ~10000 = long intricate coastline)
  const s1n = Math.max(0, Math.min(1, (Math.log10(s.s1 + 10) - 2) / 2));
  r += (0.6 - s1n) * 1.6;
  // a frame that is mostly one big shape (island in open sea, lake) is easier than a busy one
  if (s.landFrac > 0.05 && s.landFrac < 0.35) r -= 0.3;
  // Little extra detail in later stages (small islands, deserts) -> fewer chances to recover
  if (s.rivers < 150 && s.roads < 300) r += 0.4;
  // Stage 4 help: transliterated exonyms are a weaker hint than true local script; few labels weaker still
  if (s.translit) r += 0.4;
  r += s.labels < 3 ? 0.5 : s.labels < 6 ? 0.2 : -0.1;
  return Math.round(Math.max(1, Math.min(10, r)) * 10) / 10;
}
