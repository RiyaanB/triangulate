// Guess map: Mercator world on canvas with horizontal wrap, d3-zoom pan/zoom/pinch + inertia,
// bouncing pin drop, lock-in shockwave, reveal with ghost pins + animated great-circle arc + km counter.
// Colours come from CSS --m-* tokens (re-read when data-theme changes).
import { greatCircle } from '../shared/kit/geo.js';

const W = 1000;
const D2R = Math.PI / 180;
export const proj = (lon, lat) => {
  const la = Math.max(-85, Math.min(85, lat)) * D2R;
  return [((lon + 180) / 360) * W, (W / (2 * Math.PI)) * (Math.PI - Math.log(Math.tan(Math.PI / 4 + la / 2)))];
};
export const inv = (x, y) => [(x / W) * 360 - 180, (2 * Math.atan(Math.exp(Math.PI - (y * 2 * Math.PI) / W)) - Math.PI / 2) / D2R];
const Y_TOP = proj(0, 80)[1], Y_BOT = proj(0, -58)[1];
const LOFX = matchMedia('(pointer: coarse)').matches;
const ease = {
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outBack: (t) => { const c = 1.9; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
  outBounce: (t) => {
    const n = 7.5625, d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  },
};
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const fmt = (n) => Math.round(n).toLocaleString('en-US');

export class GuessMap {
  constructor(host, { onPin } = {}) {
    this.host = host; this.onPin = onPin;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'gm-canvas';
    host.append(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.base = document.createElement('canvas');
    this.bctx = this.base.getContext('2d');
    this.pin = null; this.locked = false; this.enabled = false;
    this.fxs = []; // transient effects {t0, ms, draw(ctx, f)}
    this.rev = null;
    this.t = d3.zoomIdentity;
    this.vel = null; this.inertia = 0;
    this.zoom = d3.zoom().scaleExtent([0.5, 80]).clickDistance(LOFX ? 10 : 5).tapDistance(12)
      .on('start', (e) => { if (e.sourceEvent) { cancelAnimationFrame(this.inertia); this.inertia = 0; this.vel = null; this.host.classList.add('dragging'); } })
      .on('zoom', (e) => this.onZoom(e))
      .on('end', (e) => { this.host.classList.remove('dragging'); if (e.sourceEvent) this.fling(); });
    this.sel = d3.select(this.canvas).call(this.zoom).on('dblclick.zoom', null);
    this.canvas.addEventListener('click', (e) => this.click(e));
    // zoom buttons
    const zb = document.createElement('div'); zb.className = 'gm-zoom';
    zb.innerHTML = '<button class="btn btn-icon" data-z="1.8" aria-label="Zoom in">+</button><button class="btn btn-icon" data-z="0.55" aria-label="Zoom out">−</button>';
    zb.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) this.sel.transition().duration(350).ease(d3.easeCubicOut).call(this.zoom.scaleBy, +b.dataset.z); });
    host.append(zb);
    this.readTheme();
    new MutationObserver(() => { this.readTheme(); this.draw(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    window.__triMap = this; // for automated tests
  }

  readTheme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (k) => cs.getPropertyValue('--m-' + k).trim();
    this.C = {};
    for (const k of ['ocean', 'ocean2', 'grid', 'land', 'land2', 'landdot', 'coast', 'coast-glow', 'lake', 'border', 'pin', 'pin-locked', 'truth', 'bot', 'human', 'arc', 'halo', 'label']) this.C[k] = v(k);
    this.themeKey = (document.documentElement.dataset.theme || 'night');
    this.dotPat = null;
  }

  async load(url = 'data/world.json') {
    const w = await (await fetch(url)).json();
    const ring = (p, r, close) => { r.forEach(([lon, lat], i) => { const [x, y] = proj(lon, lat); i ? p.lineTo(x, y) : p.moveTo(x, y); }); if (close) p.closePath(); };
    this.land = new Path2D(); for (const r of w.land) ring(this.land, r, true);
    this.lakes = new Path2D(); for (const r of w.lakes) ring(this.lakes, r, true);
    this.borders = new Path2D(); for (const r of w.borders) ring(this.borders, r, false);
    this.grat = new Path2D();
    for (let lon = -180; lon < 180; lon += 30) { const a = proj(lon, -85), b = proj(lon, 85); this.grat.moveTo(...a); this.grat.lineTo(...b); }
    for (let lat = -60; lat <= 80; lat += 20) { const a = proj(-180, lat), b = proj(180, lat); this.grat.moveTo(...a); this.grat.lineTo(...b); }
    this.baseKey = '';
    this.draw();
  }

  resize() {
    const r = this.host.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = Math.min(LOFX ? 2 : 2.5, devicePixelRatio || 1);
    this.w = r.width; this.h = r.height; this.dpr = dpr;
    for (const c of [this.canvas, this.base]) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
    this.canvas.style.width = r.width + 'px'; this.canvas.style.height = r.height + 'px';
    const f = this.free();
    this.fitK = Math.min(f.w / W, f.h / (Y_BOT - Y_TOP));
    this.zoom.scaleExtent([this.fitK * 0.9, this.fitK * 120]).translateExtent([[-W, Y_TOP - 60], [2 * W, Y_BOT + 60]]).extent([[0, 0], [r.width, r.height]]);
    this.baseKey = '';
    if (!this.didFit) { this.didFit = true; this.fitWorld(false); } else this.draw();
  }

  /** Free (unobstructed) part of the map: desktop panels float over a full-bleed map. */
  free(padBottom = 0) {
    const hr = this.host.getBoundingClientRect();
    let x0 = 0, x1 = hr.width, y0 = 0, y1 = hr.height - padBottom;
    for (const o of document.querySelectorAll('[data-map-obstacle]')) {
      const r = o.getBoundingClientRect();
      if (o.dataset.mapObstacle === 'top') { if (r.height && r.bottom > hr.top && r.top <= hr.top + 4) y0 = Math.max(y0, r.bottom - hr.top); continue; }
      if (!r.width || r.bottom < hr.top + 40 || r.top > hr.bottom - 40) continue;
      if (r.right <= hr.left || r.left >= hr.right) continue;
      const l = r.left - hr.left, rr = r.right - hr.left;
      if (l < hr.width * 0.4) x0 = Math.max(x0, rr + 12); else if (rr > hr.width * 0.6) x1 = Math.min(x1, l - 12);
    }
    if (x1 - x0 < hr.width * 0.3) { x0 = 0; x1 = hr.width; }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  }

  fitWorld(animate = true) {
    const f = this.free();
    const k = this.fitK;
    const t = d3.zoomIdentity.translate(f.cx - k * W / 2, f.cy - k * (Y_TOP + Y_BOT) / 2).scale(k);
    (animate ? this.sel.transition().duration(900).ease(d3.easeCubicInOut) : this.sel.interrupt()).call(this.zoom.transform, t);
  }

  /** Fit [[lat,lon],...] (lon may be unwrapped beyond ±180) into the free area. */
  fitPoints(pts, animate = true, padBottom = 0) {
    const f = this.free(padBottom);
    const xy = pts.map(([lat, lon]) => [((lon + 180) / 360) * W, proj(0, lat)[1]]);
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of xy) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const pad = 0.3;
    const dx = Math.max(x1 - x0, 5), dy = Math.max(y1 - y0, 5);
    const k = Math.min(this.fitK * 40, Math.max(this.fitK, Math.min(f.w / (dx * (1 + 2 * pad)), f.h / (dy * (1 + 2 * pad)))));
    const t = d3.zoomIdentity.translate(f.cx - k * (x0 + x1) / 2, f.y + f.h * 0.52 - k * (y0 + y1) / 2).scale(k);
    (animate ? this.sel.transition().duration(1200).ease(d3.easeCubicInOut) : this.sel).call(this.zoom.transform, t);
  }

  onZoom(e) {
    const prev = this.t;
    this.t = e.transform;
    const se = e.sourceEvent;
    if (se && (se.type === 'mousemove' || se.type === 'touchmove' || se.type === 'pointermove') && prev.k === this.t.k) {
      const now = performance.now();
      const v = this.vel;
      if (v && now - v.t < 80) {
        const dt = Math.max(1, now - v.t);
        const a = 0.35;
        this.vel = { t: now, x: (1 - a) * v.x + a * (this.t.x - prev.x) / dt, y: (1 - a) * v.y + a * (this.t.y - prev.y) / dt };
      } else this.vel = { t: now, x: 0, y: 0 };
    } else if (se && prev.k !== this.t.k) this.vel = null;
    this.draw();
  }

  fling() {
    const v = this.vel; this.vel = null;
    if (!v || performance.now() - v.t > 60) return;
    let vx = v.x, vy = v.y;
    if (Math.hypot(vx, vy) < 0.25) return;
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(32, now - last); last = now;
      const decay = Math.pow(0.94, dt / 16);
      vx *= decay; vy *= decay;
      this.zoom.translateBy(this.sel, (vx * dt) / this.t.k, (vy * dt) / this.t.k);
      this.inertia = Math.hypot(vx, vy) > 0.02 ? requestAnimationFrame(step) : 0;
    };
    this.inertia = requestAnimationFrame(step);
  }

  click(e) {
    if (!this.enabled || this.locked) return;
    const r = this.canvas.getBoundingClientRect();
    const [ux, uy] = this.t.invert([e.clientX - r.left, e.clientY - r.top]);
    if (uy < Y_TOP - 40 || uy > Y_BOT + 40) return;
    let [lon, lat] = inv(ux, uy);
    lon = ((((lon + 180) % 360) + 360) % 360) - 180;
    this.setPin(lat, lon, true);
    this.onPin?.(lat, lon);
  }

  setPin(lat, lon, animate) {
    this.pin = lat == null ? null : { lat, lon, t0: animate ? performance.now() : 0 };
    if (animate && this.pin) {
      const p = this.pin;
      this.addFx(700, (ctx, f) => { // landing ripple
        if (f < 0.35) return;
        const g = (f - 0.35) / 0.65;
        const [x, y] = this.sp(p.lat, p.lon);
        ctx.strokeStyle = this.C.pin; ctx.globalAlpha = 1 - g; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(x, y, 6 + g * 26, (6 + g * 26) * 0.45, 0, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
      });
    }
    this.draw();
  }

  /** Lock-in: shockwave, particle burst and a floating multiplier label. */
  setLocked(v, label) {
    this.locked = v;
    if (v && this.pin) {
      const p = this.pin;
      if (!label) label = document.querySelector('#lock-mult')?.textContent || '';
      const parts = Array.from({ length: LOFX ? 14 : 24 }, (_, i) => { const a = (i / (LOFX ? 14 : 24)) * Math.PI * 2 + Math.random() * 0.3; const s = 40 + Math.random() * 50; return [Math.cos(a) * s, Math.sin(a) * s * 0.8, 1.5 + Math.random() * 2.5]; });
      this.addFx(1100, (ctx, f) => {
        const [x, y] = this.sp(p.lat, p.lon);
        const col = this.C['pin-locked'];
        const g = ease.outCubic(Math.min(1, f * 1.6));
        ctx.strokeStyle = col; ctx.lineWidth = 3 * (1 - g) + 0.5; ctx.globalAlpha = 1 - g;
        ctx.beginPath(); ctx.arc(x, y - 18, 8 + g * 60, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = col;
        for (const [dx, dy, r] of parts) { ctx.beginPath(); ctx.arc(x + dx * g, y - 18 + dy * g + f * f * 20, r * (1 - f), 0, Math.PI * 2); ctx.fill(); }
        ctx.globalAlpha = f < 0.15 ? f / 0.15 : 1 - Math.max(0, (f - 0.6) / 0.4);
        if (label) {
          const sc = 1 + 0.5 * Math.max(0, 1 - f * 5);
          ctx.save(); ctx.translate(x, y - 52 - f * 30); ctx.scale(sc, sc);
          ctx.font = '800 20px ' + getComputedStyle(document.documentElement).getPropertyValue('--mono');
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.lineWidth = 5; ctx.strokeStyle = this.C.halo; ctx.strokeText(label, 0, 0);
          ctx.fillStyle = col; ctx.fillText(label, 0, 0); ctx.restore();
        }
        ctx.globalAlpha = 1;
      });
      this.lockT0 = performance.now();
    }
    this.draw();
  }

  reset() {
    this.pin = null; this.locked = false; this.rev = null; this.fxs = [];
    this.fitWorld(true);
    this.draw();
  }

  showReveal(truth, mine, others) {
    // unwrap every guess's longitude to the copy nearest the truth so arcs never jump the antimeridian
    const near = (lon) => { let l = lon; while (l - truth.lon > 180) l -= 360; while (l - truth.lon < -180) l += 360; return l; };
    const arc = (a) => { const pts = greatCircle([a.lat, a.lon], [truth.lat, truth.lon], 90); let prev = near(pts[0][1]); return pts.map(([la, lo]) => { while (lo - prev > 180) lo -= 360; while (lo - prev < -180) lo += 360; prev = lo; return [la, lo]; }); };
    const best = others.reduce((b, o) => (o.d != null && (!b || o.d < b.d) ? o : b), null);
    this.rev = {
      t0: performance.now(), truth,
      mine: mine ? { ...mine, line: arc(mine) } : null,
      others: others.map((o, i) => ({ ...o, line: arc(o), delay: 900 + i * 45 + Math.random() * 120, best: o === best })),
    };
    // keep the arc's truth end at its real longitude; shift the arc so it ends there
    const fixEnd = (o) => { const end = o.line[o.line.length - 1][1]; const sh = truth.lon - end; o.line = o.line.map(([a, b]) => [a, b + sh]); o.ulon = o.line[0][1]; };
    if (this.rev.mine) fixEnd(this.rev.mine);
    this.rev.others.forEach(fixEnd);
    const pts = [[truth.lat, truth.lon]];
    if (mine) pts.push(...this.rev.mine.line.filter((_, i) => i % 10 === 0), [mine.lat, this.rev.mine.ulon]);
    this.fitPoints(pts, true, this.w < 600 ? 120 : 170);
    this.draw();
  }

  addFx(ms, fn) { this.fxs.push({ t0: performance.now(), ms, fn }); this.draw(); }

  draw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
  }

  /** Screen position of lat/lon on the world copy nearest the view centre (lon may be unwrapped). */
  sp(lat, lon, exact = false) {
    let [x, y] = proj(lon, lat);
    if (lon > 180 || lon < -180) x = ((lon + 180) / 360) * W;
    let sx = this.t.applyX(x);
    if (!exact) {
      const cx = this.w / 2, span = W * this.t.k;
      while (sx - cx > span / 2) sx -= span;
      while (cx - sx > span / 2) sx += span;
    }
    return [sx, this.t.applyY(y)];
  }

  offsets() {
    // which horizontal world copies are visible
    const out = [];
    for (const o of [-W, 0, W, 2 * W]) {
      const a = this.t.applyX(o), b = this.t.applyX(o + W);
      if (b > 0 && a < this.w) out.push(o);
    }
    return out;
  }

  renderBase() {
    const { bctx: ctx, dpr, t, C } = this;
    const key = `${t.x.toFixed(2)},${t.y.toFixed(2)},${t.k.toFixed(5)},${this.w},${this.h},${this.themeKey},${!!this.land}`;
    if (key === this.baseKey) return;
    this.baseKey = key;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = ctx.createRadialGradient(this.w * 0.5, this.h * 0.4, 0, this.w * 0.5, this.h * 0.4, Math.max(this.w, this.h) * 0.75);
    g.addColorStop(0, C.ocean2); g.addColorStop(1, C.ocean);
    ctx.fillStyle = g; ctx.fillRect(0, 0, this.w, this.h);
    if (!this.land) return;
    if (!this.dotPat) {
      const s = Math.round(6 * dpr), pc = document.createElement('canvas'); pc.width = pc.height = s;
      const p = pc.getContext('2d'); p.fillStyle = C.landdot; p.beginPath(); p.arc(s / 2, s / 2, 1.05 * dpr, 0, Math.PI * 2); p.fill();
      this.dotPat = ctx.createPattern(pc, 'repeat');
    }
    const k = t.k;
    for (const o of this.offsets()) {
      ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * (t.x + o * k), dpr * t.y);
      ctx.strokeStyle = C.grid; ctx.lineWidth = 1 / k; ctx.stroke(this.grat);
      // coast glow (wide translucent stroke under the fill)
      ctx.strokeStyle = C['coast-glow']; ctx.lineWidth = 6 / k; ctx.lineJoin = 'round'; ctx.stroke(this.land);
      ctx.fillStyle = C.land; ctx.fill(this.land, 'evenodd');
      if (k < this.fitK * 14) {
        this.dotPat.setTransform(new DOMMatrix([1 / (k * dpr), 0, 0, 1 / (k * dpr), 0, 0]));
        ctx.fillStyle = this.dotPat; ctx.fill(this.land, 'evenodd');
      }
      ctx.fillStyle = C.lake; ctx.fill(this.lakes);
      ctx.strokeStyle = C.border; ctx.lineWidth = 0.9 / k; ctx.setLineDash([3 / k, 2.5 / k]); ctx.stroke(this.borders); ctx.setLineDash([]);
      ctx.strokeStyle = C.coast; ctx.globalAlpha = 0.85; ctx.lineWidth = 1.1 / k; ctx.stroke(this.land); ctx.stroke(this.lakes); ctx.globalAlpha = 1;
    }
  }

  linePath(pts, frac = 1, shift = 0) {
    const ctx = this.ctx;
    const n = Math.max(2, Math.ceil(pts.length * frac));
    ctx.beginPath();
    let last = null;
    for (let i = 0; i < n; i++) {
      const [x, y] = this.sp(pts[i][0], pts[i][1], true);
      if (i) ctx.lineTo(x + shift, y); else ctx.moveTo(x + shift, y);
      last = [x + shift, y];
    }
    return last;
  }

  drawPin(x, y, { col, scale = 1, drop = 0, squash = 0, ring = false }) {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    const sh = scale * (1 - Math.min(0.6, -drop / 60));
    ctx.beginPath(); ctx.ellipse(x, y, 7 * sh, 2.8 * sh, 0, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.translate(x, y + drop); ctx.scale(scale * (1 + squash), scale * (1 - squash));
    if (!LOFX) { ctx.shadowColor = col; ctx.shadowBlur = 14; }
    ctx.fillStyle = col; ctx.strokeStyle = this.C.halo; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.bezierCurveTo(-4, -8, -11, -13, -11, -21); ctx.arc(0, -21, 11, Math.PI, 0); ctx.bezierCurveTo(11, -13, 4, -8, 0, 0);
    ctx.fill(); ctx.shadowBlur = 0; ctx.stroke();
    ctx.fillStyle = this.C.halo; ctx.beginPath(); ctx.arc(0, -21, ring ? 4.8 : 4, 0, Math.PI * 2); ctx.fill();
    if (ring) { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(0, -21, 2, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }

  pill(x, y, text, { fg, bg, font = '700 13px', align = 'center' } = {}) {
    const ctx = this.ctx;
    ctx.font = font + ' ' + (this.monoFont ||= getComputedStyle(document.documentElement).getPropertyValue('--mono'));
    const w = ctx.measureText(text).width + 16;
    const x0 = align === 'center' ? x - w / 2 : x;
    ctx.fillStyle = bg; ctx.beginPath(); ctx.roundRect(x0, y - 12, w, 24, 5); ctx.fill();
    ctx.strokeStyle = fg; ctx.globalAlpha *= 0.6; ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha /= 0.6;
    ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, x0 + w / 2, y + 1);
  }

  render() {
    const { ctx, dpr, C } = this;
    if (!this.w) return;
    const now = performance.now();
    let again = false;
    this.renderBase();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.base, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    // ---- reveal
    const R = this.rev;
    if (R) {
      again = true;
      const e = now - R.t0;
      const [tx, ty] = this.sp(R.truth.lat, R.truth.lon);
      const sh = tx - this.sp(R.truth.lat, R.truth.lon, true)[0]; // every line ends at the truth copy
      // others: faint lines + ghost pins popping in
      for (const o of R.others) {
        const f = clamp01((e - o.delay) / 500);
        if (f <= 0) continue;
        const col = o.bot ? C.bot : C.human;
        ctx.strokeStyle = col; ctx.globalAlpha = 0.22; ctx.lineWidth = 1;
        this.linePath(o.line, ease.outCubic(clamp01((e - o.delay) / 900)), sh); ctx.stroke();
        ctx.globalAlpha = 0.9;
        const [gx, gy] = this.sp(o.lat, o.line[0][1], true);
        this.drawPin(gx + sh, gy, { col, scale: 0.5 * ease.outBack(f) });
        if (o.best && f >= 1) { ctx.globalAlpha = clamp01((e - o.delay - 500) / 300); this.pill(gx + sh, gy - 28, '★ best', { fg: col, bg: C.halo, font: '700 10px' }); }
        ctx.globalAlpha = 1;
      }
      // truth marker
      const tf = clamp01((e - 500) / 600);
      if (tf > 0) {
        for (let i = 0; i < 2; i++) {
          const p = ((now - R.t0) / 1600 + i * 0.5) % 1;
          ctx.strokeStyle = C.truth; ctx.globalAlpha = (1 - p) * tf; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(tx, ty, 8 + p * 34, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.globalAlpha = 1;
        const s = ease.outBack(tf);
        if (!LOFX) { ctx.shadowColor = C.truth; ctx.shadowBlur = 18; }
        ctx.fillStyle = C.truth; ctx.strokeStyle = C.halo; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(tx, ty, 9 * s, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0; ctx.stroke();
        ctx.fillStyle = C.halo; ctx.beginPath(); ctx.arc(tx, ty, 3 * s, 0, Math.PI * 2); ctx.fill();
      }
      // my arc + km counter riding the head
      const M = R.mine;
      if (M) {
        const af = ease.inOut(clamp01((e - 1100) / 1500));
        const [mx, my] = this.sp(M.lat, M.line[0][1], true);
        if (af > 0) {
          ctx.strokeStyle = C.arc; ctx.lineWidth = 6; ctx.globalAlpha = 0.18;
          this.linePath(M.line, af, sh); ctx.stroke();
          ctx.globalAlpha = 1; ctx.lineWidth = 2.5; ctx.setLineDash([8, 6]); ctx.lineDashOffset = -now / 40;
          const head = this.linePath(M.line, af, sh); ctx.stroke(); ctx.setLineDash([]);
          if (af < 1) {
            ctx.fillStyle = C.arc; if (!LOFX) { ctx.shadowColor = C.arc; ctx.shadowBlur = 16; }
            ctx.beginPath(); ctx.arc(head[0], head[1], 5, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
          }
          if (M.d != null) {
            const mid = af < 1 ? head : (() => { const p = M.line[Math.floor(M.line.length / 2)]; const [x, y] = this.sp(p[0], p[1], true); return [x + sh, y]; })();
            const ok = M.d < 500 ? C.truth : M.d < 2000 ? C.human : C.pin;
            this.pill(mid[0], mid[1] - 22, fmt(M.d * af) + ' km', { fg: ok, bg: C.halo, font: '800 14px' });
          }
        }
        this.drawPin(mx + sh, my, { col: C['pin-locked'], ring: true });
      }
      if (tf >= 1 && e > 2600) {
        ctx.globalAlpha = clamp01((e - 2600) / 400);
        this.pill(tx, ty + 30, R.truth.name || '', { fg: C.truth, bg: C.halo, font: '800 13px' });
        ctx.globalAlpha = 1;
      }
    }

    // ---- my pin (pre-reveal)
    if (this.pin && !(R && R.mine)) {
      const [x, y] = this.sp(this.pin.lat, this.pin.lon);
      const a = this.pin.t0 ? clamp01((now - this.pin.t0) / 650) : 1;
      if (a < 1) again = true;
      const drop = -(1 - ease.outBounce(a)) * 46;
      const squash = a > 0.3 && a < 0.75 ? Math.sin(((a - 0.3) / 0.45) * Math.PI) * 0.18 : 0;
      const col = this.locked ? C['pin-locked'] : C.pin;
      if (!this.locked && a >= 1) {
        // idle breathing halo
        const p = (now % 1800) / 1800;
        ctx.strokeStyle = col; ctx.globalAlpha = 0.5 * (1 - p); ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.ellipse(x, y, 5 + p * 16, (5 + p * 16) * 0.45, 0, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
        again = true;
      }
      const lp = this.locked && this.lockT0 ? clamp01((now - this.lockT0) / 450) : 1;
      if (lp < 1) again = true;
      const pop = lp < 1 ? 1 + Math.sin(lp * Math.PI) * 0.35 : 1;
      this.drawPin(x, y, { col, drop, squash: squash - (pop - 1) * 0.3, scale: pop, ring: this.locked });
    }

    // ---- transient fx
    if (this.fxs.length) {
      this.fxs = this.fxs.filter((f) => now - f.t0 < f.ms);
      for (const f of this.fxs) { ctx.save(); f.fn(ctx, clamp01((now - f.t0) / f.ms)); ctx.restore(); }
      if (this.fxs.length) again = true;
    }
    if (again) this.draw();
  }
}
