// Planar geometry helpers for building map snippets (reusable map-data pipeline).
// Points are [x, y] arrays. Bboxes are [xmin, ymin, xmax, ymax].

export function bboxOf(points, out = [Infinity, Infinity, -Infinity, -Infinity]) {
  for (const p of points) {
    if (p[0] < out[0]) out[0] = p[0];
    if (p[1] < out[1]) out[1] = p[1];
    if (p[0] > out[2]) out[2] = p[0];
    if (p[1] > out[3]) out[3] = p[1];
  }
  return out;
}

export function bboxIntersects(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

// Sutherland–Hodgman clip of a closed ring to an axis-aligned rectangle.
// Works for concave rings (may leave zero-width edges along the clip border, harmless for fills).
export function clipRing(ring, [xmin, ymin, xmax, ymax]) {
  let pts = ring;
  if (pts.length && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts = pts.slice(0, -1);
  const edges = [
    (p) => p[0] >= xmin, (a, b) => { const t = (xmin - a[0]) / (b[0] - a[0]); return [xmin, a[1] + t * (b[1] - a[1])]; },
    (p) => p[0] <= xmax, (a, b) => { const t = (xmax - a[0]) / (b[0] - a[0]); return [xmax, a[1] + t * (b[1] - a[1])]; },
    (p) => p[1] >= ymin, (a, b) => { const t = (ymin - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), ymin]; },
    (p) => p[1] <= ymax, (a, b) => { const t = (ymax - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), ymax]; },
  ];
  for (let e = 0; e < 8; e += 2) {
    const inside = edges[e], cross = edges[e + 1];
    const out = [];
    const n = pts.length;
    if (!n) return [];
    for (let i = 0; i < n; i++) {
      const cur = pts[i], prev = pts[(i + n - 1) % n];
      const ci = inside(cur), pi = inside(prev);
      if (ci) {
        if (!pi) out.push(cross(prev, cur));
        out.push(cur);
      } else if (pi) out.push(cross(prev, cur));
    }
    pts = out;
  }
  return pts;
}

// Clip a polyline to a rectangle, returning a list of polylines (Liang–Barsky per segment).
export function clipLine(line, [xmin, ymin, xmax, ymax]) {
  const result = [];
  let cur = null;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i], b = line[i + 1];
    let t0 = 0, t1 = 1;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const p = [-dx, dx, -dy, dy];
    const q = [a[0] - xmin, xmax - a[0], a[1] - ymin, ymax - a[1]];
    let ok = true;
    for (let k = 0; k < 4; k++) {
      if (p[k] === 0) { if (q[k] < 0) { ok = false; break; } }
      else {
        const r = q[k] / p[k];
        if (p[k] < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; }
        else { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
      }
    }
    if (!ok) { if (cur) { result.push(cur); cur = null; } continue; }
    const s = [a[0] + t0 * dx, a[1] + t0 * dy], e = [a[0] + t1 * dx, a[1] + t1 * dy];
    if (!cur) cur = [s];
    cur.push(e);
    if (t1 < 1) { result.push(cur); cur = null; }
  }
  if (cur) result.push(cur);
  return result.filter((l) => l.length > 1);
}

// Douglas–Peucker simplification (iterative).
export function simplify(points, tol) {
  const n = points.length;
  if (n < 3) return points.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [s, e] = stack.pop();
    const ax = points[s][0], ay = points[s][1], bx = points[e][0], by = points[e][1];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let maxD = -1, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const px = points[i][0], py = points[i][1];
      let d2;
      if (len2 === 0) d2 = (px - ax) ** 2 + (py - ay) ** 2;
      else {
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        d2 = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      }
      if (d2 > maxD) { maxD = d2; idx = i; }
    }
    if (maxD > tol2) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}

export function ringArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function lineLength(line) {
  let L = 0;
  for (let i = 1; i < line.length; i++) L += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  return L;
}

// Compact SVG path: integer absolute moveTo then relative lineTo.
export function toPath(lines, closed = false) {
  let s = '';
  for (const line of lines) {
    let px = Math.round(line[0][0]), py = Math.round(line[0][1]);
    let seg = `M${px} ${py}`;
    let count = 0;
    let l = '';
    for (let i = 1; i < line.length; i++) {
      const x = Math.round(line[i][0]), y = Math.round(line[i][1]);
      const dx = x - px, dy = y - py;
      if (dx === 0 && dy === 0) continue;
      l += (l === '' ? '' : (dx < 0 ? '' : ' ')) + dx + (dy < 0 ? '' : ' ') + dy;
      px = x; py = y; count++;
    }
    if (count === 0) continue;
    seg += 'l' + l + (closed ? 'z' : '');
    s += seg;
  }
  return s;
}
