// Shapefile loading into a flat, bbox-indexed list of parts (reusable map-data pipeline).
import * as shapefile from 'shapefile';
import fs from 'node:fs';
import { bboxOf } from './geometry.js';

const clean = (v) => (typeof v === 'string' ? v.replace(/\u0000/g, '').trim() || null : v);

/**
 * Load a shapefile. Returns { kind: 'polygon'|'line'|'point', items: [{ parts, bbox, props }] }.
 * For polygons `parts` is a list of rings, for lines a list of polylines, for points [[lon,lat]].
 * `filter(props)` may drop features; `map(props)` may reduce stored properties.
 */
export async function loadShapefile(base, { filter, map } = {}) {
  if (!fs.existsSync(base + '.shp')) throw new Error('Missing shapefile ' + base + '.shp (run npm run build:data which downloads it)');
  const src = await shapefile.open(base + '.shp', base + '.dbf', { encoding: 'utf-8' });
  const items = [];
  let kind = null;
  for (;;) {
    const r = await src.read();
    if (r.done) break;
    const f = r.value;
    if (!f.geometry) continue;
    const props = {};
    for (const k in f.properties) props[k] = clean(f.properties[k]);
    if (filter && !filter(props)) continue;
    const p = map ? map(props) : props;
    const g = f.geometry;
    if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
      kind = 'polygon';
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
      for (const poly of polys) items.push({ parts: poly, bbox: bboxOf(poly[0]), props: p });
    } else if (g.type === 'LineString' || g.type === 'MultiLineString') {
      kind = 'line';
      const lines = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
      for (const line of lines) items.push({ parts: [line], bbox: bboxOf(line), props: p });
    } else if (g.type === 'Point') {
      kind = 'point';
      const c = g.coordinates;
      items.push({ parts: [[c]], bbox: [c[0], c[1], c[0], c[1]], props: p });
    }
  }
  return { kind, items };
}

export function mergeLayers(...layers) {
  return { kind: layers[0].kind, items: layers.flatMap((l) => l.items) };
}
