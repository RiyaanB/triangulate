// Build a square, north-up map snippet around a point from bbox-indexed layers.
// Output coordinates live in a SIZE x SIZE frame (y down), with NO lat/lon leakage.
import { bboxIntersects, clipRing, clipLine, simplify, ringArea, lineLength, toPath } from './geometry.js';

export const SIZE = 1000;
const R = 6371;
const D2R = Math.PI / 180;

export function makeProjection(lat0, lon0, km) {
  const upk = SIZE / km; // units per km
  const sp0 = Math.sin(lat0 * D2R), cp0 = Math.cos(lat0 * D2R);
  const fwd = ([lon, lat]) => {
    const l = (lon - lon0) * D2R, p = lat * D2R;
    const cp = Math.cos(p);
    const x = R * cp * Math.sin(l);
    const y = R * (cp0 * Math.sin(p) - sp0 * cp * Math.cos(l));
    return [SIZE / 2 + x * upk, SIZE / 2 - y * upk];
  };
  // lon/lat prefilter box with generous margin
  const dLat = (km / 2 / 111.2) * 1.35;
  const dLon = Math.min(170, dLat / Math.max(0.15, Math.cos(Math.min(85, Math.abs(lat0) + dLat) * D2R)));
  const geoBox = [lon0 - dLon, lat0 - dLat, lon0 + dLon, lat0 + dLat];
  return { fwd, geoBox, upk };
}

const FRAME = [0, 0, SIZE, SIZE];
const PAD_FRAME = [-2, -2, SIZE + 2, SIZE + 2];

export function polygonLayer(layer, proj, { tol = 0.8, minArea = 6 } = {}) {
  const rings = [];
  for (const it of layer.items) {
    if (!bboxIntersects(it.bbox, proj.geoBox)) continue;
    for (const ring of it.parts) {
      let r = clipRing(ring, proj.geoBox);
      if (r.length < 3) continue;
      r = clipRing(r.map(proj.fwd), PAD_FRAME);
      if (r.length < 3) continue;
      r = simplify([...r, r[0]], tol);
      if (r.length < 4 || Math.abs(ringArea(r)) < minArea) continue;
      rings.push({ ring: r, props: it.props });
    }
  }
  return rings;
}

export function lineLayer(layer, proj, { tol = 0.8, minLen = 4 } = {}) {
  const out = [];
  for (const it of layer.items) {
    if (!bboxIntersects(it.bbox, proj.geoBox)) continue;
    for (const line of it.parts) {
      // pre-trim in geo space to avoid projecting far-away vertices
      const near = clipLine(line, proj.geoBox);
      for (const nl of near) {
        for (const piece of clipLine(nl.map(proj.fwd), PAD_FRAME)) {
          const s = simplify(piece, tol);
          if (s.length < 2 || lineLength(s) < minLen) continue;
          out.push({ line: s, props: it.props });
        }
      }
    }
  }
  return out;
}

export function pointLayer(layer, proj, margin = 12) {
  const out = [];
  for (const it of layer.items) {
    if (!bboxIntersects(it.bbox, proj.geoBox)) continue;
    const [x, y] = proj.fwd(it.parts[0][0]);
    if (x < margin || y < margin || x > SIZE - margin || y > SIZE - margin) continue;
    out.push({ x, y, props: it.props });
  }
  return out;
}

export { toPath, ringArea, lineLength };
