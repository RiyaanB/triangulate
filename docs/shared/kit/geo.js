// Spherical geo helpers (browser + node).
const R = 6371;
const D2R = Math.PI / 180;

export function distanceKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * D2R, dLon = (lon2 - lon1) * D2R;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function destination(lat, lon, bearingDeg, km) {
  const d = km / R, b = bearingDeg * D2R, p1 = lat * D2R, l1 = lon * D2R;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  let lon2 = l2 / D2R;
  lon2 = ((lon2 + 540) % 360) - 180;
  return [p2 / D2R, lon2];
}

/** Points along the great circle between a and b ([lat,lon]) */
export function greatCircle(a, b, n = 64) {
  const toV = ([lat, lon]) => [Math.cos(lat * D2R) * Math.cos(lon * D2R), Math.cos(lat * D2R) * Math.sin(lon * D2R), Math.sin(lat * D2R)];
  const va = toV(a), vb = toV(b);
  const dot = Math.max(-1, Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
  const w = Math.acos(dot);
  if (w < 1e-6) return [a, b];
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const s1 = Math.sin((1 - t) * w) / Math.sin(w), s2 = Math.sin(t * w) / Math.sin(w);
    const v = [s1 * va[0] + s2 * vb[0], s1 * va[1] + s2 * vb[1], s1 * va[2] + s2 * vb[2]];
    out.push([Math.atan2(v[2], Math.hypot(v[0], v[1])) / D2R, Math.atan2(v[1], v[0]) / D2R]);
  }
  return out;
}
