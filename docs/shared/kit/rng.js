// Seeded RNG utilities (browser + node). Reusable across games.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFromString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function makeRng(seed = (Math.random() * 2 ** 32) >>> 0) {
  const r = mulberry32(typeof seed === 'string' ? seedFromString(seed) : seed);
  const rng = () => r();
  rng.int = (n) => Math.floor(r() * n);
  rng.range = (a, b) => a + r() * (b - a);
  rng.pick = (arr) => arr[Math.floor(r() * arr.length)];
  rng.normal = () => {
    let u = 0, v = 0;
    while (u === 0) u = r();
    while (v === 0) v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  rng.weighted = (weights) => {
    const s = weights.reduce((a, b) => a + b, 0);
    let x = r() * s;
    for (let i = 0; i < weights.length; i++) { x -= weights[i]; if (x <= 0) return i; }
    return weights.length - 1;
  };
  rng.shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  return rng;
}
