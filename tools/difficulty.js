// Clue difficulty rating (1 = trivial .. 10 = brutal) from the curated base difficulty plus what the
// map actually shows at each stage. Used to order rounds easy -> hard and to scale bot accuracy.
export function rateClue(s) {
  const base = [0, 2.5, 5, 7.5][s.diff] ?? 5;
  let r = base;
  // Stage 1 is the high-multiplier stage: how much recognisable shape does it show?
  if (s.s1 < 250) r += 1.2;
  else if (s.s1 < 600) r += 0.6;
  else if (s.s1 > 2500 && s.landFrac > 0.08 && s.landFrac < 0.92) r -= 0.6; // long, distinctive coastline
  // Little extra detail in later stages (small islands, deserts) -> fewer chances to recover
  if (s.rivers < 150 && s.roads < 300) r += 0.4;
  // Stage 4 help: transliterated exonyms are a weaker hint than true local script; few labels weaker still
  if (s.translit) r += 0.4;
  if (s.labels < 3) r += 0.5;
  return Math.round(Math.max(1, Math.min(10, r)) * 10) / 10;
}
