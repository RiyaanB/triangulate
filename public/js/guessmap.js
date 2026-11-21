// Guess map: Mercator world on canvas, d3-zoom pan/zoom/pinch, pin drop, reveal animations.
import { greatCircle } from '../shared/kit/geo.js';

const W = 1000;
const D2R = Math.PI / 180;
export const proj = (lon, lat) => {
  const la = Math.max(-85, Math.min(85, lat)) * D2R;
  return [((lon + 180) / 360) * W, (W / (2 * Math.PI)) * (Math.PI - Math.log(Math.tan(Math.PI / 4 + la / 2)))];
};
export const inv = (x, y) => [(x / W) * 360 - 180, (2 * Math.atan(Math.exp(Math.PI - (y * 2 * Math.PI) / W)) - Math.PI / 2) / D2R];
const Y_TOP = proj(0, 78)[1], Y_BOT = proj(0, -57)[1];

export class GuessMap {
  constructor(host, { onPin } = {}) {
    this.host = host; this.onPin = onPin;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'gm-canvas';
    host.append(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.pin = null; this.locked = false; this.enabled = false;
    this.others = []; this.truth = null; this.lineT = 0; this.pinAnim = 0;
    this.t = d3.zoomIdentity;
    this.zoom = d3.zoom().scaleExtent([0.5, 80]).on('zoom', (e) => { this.t = e.transform; this.draw(); });
    this.sel = d3.select(this.canvas).call(this.zoom).on('dblclick.zoom', null);
    this.canvas.addEventListener('click', (e) => this.click(e));
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  async load(url = 'data/world.json') {
    const w = await (await fetch(url)).json();
    const ring = (r, close) => { const p = new Path2D(); r.forEach(([lon, lat], i) => { const [x, y] = proj(lon, lat); i ? p.lineTo(x, y) : p.moveTo(x, y); }); if (close) p.closePath(); return p; };
    this.land = new Path2D(); for (const r of w.land) this.land.addPath(ring(r, true));
    this.lakes = new Path2D(); for (const r of w.lakes) this.lakes.addPath(ring(r, true));
    this.borders = new Path2D(); for (const r of w.borders) this.borders.addPath(ring(r, false));
    this.grat = new Path2D();
    for (let lon = -180; lon <= 180; lon += 30) { const a = proj(lon, -85), b = proj(lon, 85); this.grat.moveTo(...a); this.grat.lineTo(...b); }
    for (let lat = -60; lat <= 80; lat += 20) { const a = proj(-180, lat), b = proj(180, lat); this.grat.moveTo(...a); this.grat.lineTo(...b); }
    this.draw();
  }

  resize() {
    const r = this.host.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = Math.min(2.5, devicePixelRatio || 1);
    this.w = r.width; this.h = r.height; this.dpr = dpr;
    this.canvas.width = Math.round(r.width * dpr); this.canvas.height = Math.round(r.height * dpr);
    this.canvas.style.width = r.width + 'px'; this.canvas.style.height = r.height + 'px';
    const fitK = Math.min(r.width / W, r.height / (Y_BOT - Y_TOP));
    this.fitK = fitK;
    this.zoom.scaleExtent([fitK * 0.95, fitK * 90]).translateExtent([[-W * 0.1, Y_TOP - 40], [W * 1.1, Y_BOT + 40]]).extent([[0, 0], [r.width, r.height]]);
    if (!this.didFit) { this.didFit = true; this.fitWorld(false); } else this.draw();
  }

  fitWorld(animate = true) {
    const k = this.fitK;
    const t = d3.zoomIdentity.translate(this.w / 2 - k * W / 2, this.h / 2 - k * (Y_TOP + Y_BOT) / 2).scale(k);
    (animate ? this.sel.transition().duration(900) : this.sel).call(this.zoom.transform, t);
  }

  fitPoints(pts, animate = true) {
    const xy = pts.map(([lat, lon]) => proj(lon, lat));
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of xy) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const pad = 0.28;
    const dx = Math.max(x1 - x0, 6), dy = Math.max(y1 - y0, 6);
    const k = Math.min(this.fitK * 40, Math.max(this.fitK, Math.min(this.w / (dx * (1 + 2 * pad)), (this.h * 0.82) / (dy * (1 + 2 * pad)))));
    const t = d3.zoomIdentity.translate(this.w / 2 - k * (x0 + x1) / 2, this.h * 0.45 - k * (y0 + y1) / 2).scale(k);
    (animate ? this.sel.transition().duration(1100).ease(d3.easeCubicInOut) : this.sel).call(this.zoom.transform, t);
  }

  click(e) {
    if (!this.enabled || this.locked) return;
    const r = this.canvas.getBoundingClientRect();
    const [ux, uy] = this.t.invert([e.clientX - r.left, e.clientY - r.top]);
    if (uy < Y_TOP - 30 || uy > Y_BOT + 30) return;
    let [lon, lat] = inv(ux, uy);
    lon = ((lon + 540) % 360) - 180;
    this.setPin(lat, lon, true);
    this.onPin?.(lat, lon);
  }

  setPin(lat, lon, animate) {
    this.pin = lat == null ? null : { lat, lon };
    if (animate) this.animate('pinAnim', 380); else { this.pinAnim = 1; this.draw(); }
  }
  setLocked(v) { this.locked = v; if (v) this.animate('lockAnim', 600); else this.draw(); }

  reset() {
    this.pin = null; this.locked = false; this.others = []; this.truth = null; this.lineT = 0; this.lockAnim = 0;
    this.fitWorld(true);
    this.draw();
  }

  showReveal(truth, mine, others) {
    this.truth = truth; this.others = others; this.lineT = 0;
    this.line = mine ? greatCircle([mine.lat, mine.lon], [truth.lat, truth.lon], 80) : null;
    this.otherLines = others.map((o) => greatCircle([o.lat, o.lon], [truth.lat, truth.lon], 24));
    this.fitPoints(mine ? [[truth.lat, truth.lon], [mine.lat, mine.lon]] : [[truth.lat, truth.lon]]);
    setTimeout(() => this.animate('lineT', 1200), 700);
  }

  animate(key, ms) {
    const t0 = performance.now();
    this[key] = 0;
    const step = (t) => {
      this[key] = Math.max(0, Math.min(1, (t - t0) / ms));
      this.draw();
      if (this[key] < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  draw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
  }

  sp(lat, lon) { const [x, y] = proj(lon, lat); return this.t.apply([x, y]); }

  path(pts, frac = 1) {
    const ctx = this.ctx;
    const n = Math.max(2, Math.ceil(pts.length * frac));
    ctx.beginPath();
    let prev = null;
    for (let i = 0; i < n; i++) {
      const [lat, lon] = pts[i];
      const [x, y] = this.sp(lat, lon);
      if (prev && Math.abs(lon - prev) > 180) ctx.moveTo(x, y); else if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      prev = lon;
    }
  }

  render() {
    const { ctx, dpr, t } = this;
    if (!this.w) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#081221';
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.setTransform(dpr * t.k, 0, 0, dpr * t.k, dpr * t.x, dpr * t.y);
    if (this.grat) { ctx.strokeStyle = 'rgba(120,170,255,0.07)'; ctx.lineWidth = 1 / t.k; ctx.stroke(this.grat); }
    if (this.land) {
      ctx.fillStyle = '#1c2b42'; ctx.fill(this.land, 'evenodd');
      ctx.strokeStyle = '#3d6390'; ctx.lineWidth = 1.1 / t.k; ctx.stroke(this.land);
      ctx.fillStyle = '#081221'; ctx.fill(this.lakes); ctx.strokeStyle = '#2c4a6e'; ctx.lineWidth = 0.8 / t.k; ctx.stroke(this.lakes);
      ctx.strokeStyle = 'rgba(150,180,220,0.28)'; ctx.lineWidth = 0.8 / t.k; ctx.setLineDash([3 / t.k, 2 / t.k]); ctx.stroke(this.borders); ctx.setLineDash([]);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // reveal: other players' guesses
    if (this.truth) {
      const f = this.lineT;
      this.others.forEach((o, i) => {
        ctx.strokeStyle = 'rgba(160,170,255,0.22)'; ctx.lineWidth = 1;
        this.path(this.otherLines[i], f); ctx.stroke();
        const [x, y] = this.sp(o.lat, o.lon);
        ctx.fillStyle = o.bot ? 'rgba(185,176,255,0.85)' : 'rgba(255,204,77,0.95)';
        ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI * 2); ctx.fill();
      });
      if (this.line) {
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.5; ctx.setLineDash([7, 6]);
        this.path(this.line, f); ctx.stroke(); ctx.setLineDash([]);
      }
      const [tx, ty] = this.sp(this.truth.lat, this.truth.lon);
      const pulse = (performance.now() % 1400) / 1400;
      ctx.strokeStyle = `rgba(78,230,160,${1 - pulse})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(tx, ty, 8 + pulse * 22, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#4ee6a0'; ctx.strokeStyle = '#04150d'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(tx, ty, 8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      this.draw(); // keep pulsing
    }
    // my pin
    if (this.pin) {
      const [x, y] = this.sp(this.pin.lat, this.pin.lon);
      const a = this.pinAnim ?? 1;
      const bounce = a < 1 ? 1 - Math.pow(1 - a, 3) : 1;
      const drop = (1 - bounce) * -26;
      if (this.locked && this.lockAnim < 1) {
        ctx.strokeStyle = `rgba(92,225,230,${1 - this.lockAnim})`; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(x, y, 6 + this.lockAnim * 40, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath(); ctx.ellipse(x, y, 7 * bounce, 3 * bounce, 0, 0, Math.PI * 2); ctx.fill();
      ctx.save(); ctx.translate(x, y + drop);
      const col = this.locked ? '#5ce1e6' : '#ffcc4d';
      ctx.fillStyle = col; ctx.strokeStyle = '#06101c'; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.bezierCurveTo(-4, -8, -11, -13, -11, -21); ctx.arc(0, -21, 11, Math.PI, 0); ctx.bezierCurveTo(11, -13, 4, -8, 0, 0);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#06101c'; ctx.beginPath(); ctx.arc(0, -21, this.locked ? 4.5 : 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }
}
