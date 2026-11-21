// Clue card: renders stage geometry (1000x1000 local frame) as layered cartographic SVG with
// staged draw-in animations. All colours come from CSS --m-* tokens, so themes restyle it.
//  s1: ocean ripples (water lines), land fill + procedural hillshade texture, lakes, glowing coastline
//  s2: rivers (stepped taper + flowing highlight)
//  s3: urban areas (hatched), rail (ties), roads (cased, 2-level hierarchy)
//  s4: native-script labels with halo, staggered pop-in
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
const LOFX = matchMedia('(pointer: coarse)').matches; // phones: skip continuous effects

// ---- procedural, tileable "hillshade" texture (value-noise fBm, lit from the north-west)
let hillURL = null;
function hillshade(size = 192) {
  if (hillURL) return hillURL;
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'); const img = g.createImageData(size, size);
  let seed = 1337; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const octaves = [[4, 1], [8, 0.5], [16, 0.26], [32, 0.13]].map(([n, amp]) => ({ n, amp, v: Float32Array.from({ length: n * n }, rnd) }));
  const sm = (t) => t * t * (3 - 2 * t);
  const H = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let h = 0;
    for (const o of octaves) {
      const fx = (x / size) * o.n, fy = (y / size) * o.n, x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = sm(fx - x0), ty = sm(fy - y0), x1 = (x0 + 1) % o.n, y1 = (y0 + 1) % o.n;
      const a = o.v[y0 * o.n + x0], b = o.v[y0 * o.n + x1], cc = o.v[y1 * o.n + x0], d = o.v[y1 * o.n + x1];
      h += o.amp * (a + (b - a) * tx + (cc - a) * ty + (a - b - cc + d) * tx * ty);
    }
    H[y * size + x] = h;
  }
  const at = (x, y) => H[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const s = (at(x - 1, y - 1) - at(x + 1, y + 1)) * 9 + (Math.random() - 0.5) * 0.05; // light from NW + grain
    const i = (y * size + x) * 4;
    const v = s > 0 ? 255 : 0;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = Math.min(255, Math.abs(s) * 255 * (s > 0 ? 0.55 : 0.8));
  }
  g.putImageData(img, 0, 0);
  hillURL = c.toDataURL();
  return hillURL;
}

const STAGE_NAME = ['', 'Coastline', 'Rivers', 'Roads & rail', 'Local names'];

export class ClueCard {
  constructor(host) {
    this.host = host;
    this.svg = el('svg', { viewBox: '0 0 1000 1000', class: 'clue-svg', preserveAspectRatio: 'xMidYMid slice', role: 'img', 'aria-label': 'Map clue' });
    const defs = el('defs');
    defs.innerHTML = `
      <pattern id="cc-grid" width="100" height="100" patternUnits="userSpaceOnUse"><path d="M100 0H0V100" fill="none" style="stroke:var(--m-grid)" stroke-width="1.5"/></pattern>
      <pattern id="cc-hill" width="560" height="560" patternUnits="userSpaceOnUse"><image href="${hillshade()}" width="560" height="560" preserveAspectRatio="none"/></pattern>
      <pattern id="cc-hatch" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="9" height="9" style="fill:var(--m-urban)"/><path d="M0 0V9" style="stroke:var(--m-urban-line)" stroke-width="2.2"/></pattern>
      <radialGradient id="cc-sea" cx="50%" cy="45%" r="70%"><stop offset="0" style="stop-color:var(--m-ocean2)" stop-opacity=".55"/><stop offset="1" style="stop-color:var(--m-ocean2)" stop-opacity="0"/></radialGradient>
      <linearGradient id="cc-landg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:var(--m-land2)"/><stop offset="1" style="stop-color:var(--m-land)"/></linearGradient>
      <radialGradient id="cc-vign" cx="50%" cy="50%" r="72%"><stop offset="62%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity=".5"/></radialGradient>
      <clipPath id="cc-landclip"><path id="cc-landclip-p" clip-rule="evenodd"/></clipPath>
      <clipPath id="cc-lakeclip"><path id="cc-lakeclip-p" clip-rule="evenodd"/></clipPath>`;
    this.svg.append(defs);
    this.L = {};
    for (const name of ['ocean', 'ripples', 'seaglow', 'land', 'hill', 'urban', 'lakes', 'lakerip', 'coastglow', 'coast', 'rivers', 'rail', 'roadcase', 'roads', 'labels', 'overlay']) {
      this.L[name] = el('g', { class: 'L-' + name });
      this.svg.append(this.L[name]);
    }
    this.L.ocean.append(el('rect', { width: 1000, height: 1000, class: 'sea' }));
    this.L.seaglow.append(el('rect', { width: 1000, height: 1000, fill: 'url(#cc-sea)' }), el('rect', { width: 1000, height: 1000, fill: 'url(#cc-grid)' }));
    this.L.lakerip.setAttribute('clip-path', 'url(#cc-lakeclip)');
    this.L.hill.setAttribute('clip-path', 'url(#cc-landclip)');
    // neatline ticks around the frame edge
    let ticks = '';
    for (let i = 50; i < 1000; i += 50) { const l = i % 250 === 0 ? 16 : 8; ticks += `M${i} 0v${l}M${i} 1000v-${l}M0 ${i}h${l}M1000 ${i}h-${l}`; }
    this.svg.append(el('rect', { width: 1000, height: 1000, fill: 'url(#cc-vign)', 'pointer-events': 'none', class: 'vign' }), el('path', { d: ticks, class: 'ticks' }));
    host.append(this.svg);
    this.sweep = document.createElement('div'); this.sweep.className = 'clue-sweep';
    this.stamp = document.createElement('div'); this.stamp.className = 'clue-stamp';
    this.scale = document.createElement('div'); this.scale.className = 'clue-scale';
    this.coords = document.createElement('div'); this.coords.className = 'clue-coords';
    host.append(this.sweep, this.stamp, this.scale, this.coords);
    // phones: tap the clue to enlarge it
    host.addEventListener('click', () => { if (matchMedia('(max-width: 760px)').matches) host.closest('.clue-card')?.classList.toggle('expanded'); });
    this.anims = [];
  }

  clear() {
    for (const a of this.anims) a.cancel?.();
    this.anims = [];
    clearTimeout(this._t);
    for (const k of ['ripples', 'land', 'hill', 'urban', 'lakes', 'lakerip', 'coastglow', 'coast', 'rivers', 'rail', 'roadcase', 'roads', 'labels', 'overlay']) this.L[k].replaceChildren();
    this.scale.innerHTML = ''; this.coords.innerHTML = ''; this.stamp.className = 'clue-stamp';
    this.host.classList.remove('has-s1', 's1', 's2', 's3', 's4', 'answered');
    this.host.closest('.clue-card')?.classList.remove('expanded');
    delete this.host.dataset.answer;
  }

  setScale(km) {
    const nice = [10, 20, 25, 50, 75, 100, 150, 200];
    const target = km / 4;
    const d = nice.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
    this.scale.innerHTML = `<span class="bar" style="width:${(d / km) * 100}%"><i></i><i></i><i></i><i></i></span><span>${d} km</span>`;
    this.coords.innerHTML = '<span class="redact">██.█°N ███.█°E</span>';
  }

  draw(i, data, { animate = true } = {}) {
    const dur = animate ? 1500 : 0;
    this.host.classList.add('s' + i);
    if (animate) this.fx(i);
    if (i === 1) {
      this.setScale(data.km);
      this.host.classList.add('has-s1');
      const coast = (data.coast || []).join('');
      if (coast) {
        // water lines: alternating line/cover strokes leave thin concentric rings around coasts
        const rip = [[46, 43.5, 0.45], [30, 27.6, 0.7], [16, 13.8, 1]];
        for (const [w, cw, o] of rip) {
          this.L.ripples.append(el('path', { d: coast, class: 'rip', 'stroke-width': w, opacity: o }), el('path', { d: coast, class: 'rip-cover', 'stroke-width': cw }));
          this.L.lakerip.append(el('path', { d: coast, class: 'rip', 'stroke-width': w * 0.6, opacity: o }), el('path', { d: coast, class: 'rip-cover lake', 'stroke-width': cw * 0.6 }));
        }
        if (dur) this.fade(this.L.ripples, dur * 0.9, dur * 0.5), this.fade(this.L.lakerip, dur * 0.9, dur * 0.5);
      }
      if (data.land) {
        this.svg.querySelector('#cc-landclip-p').setAttribute('d', data.land);
        this.L.land.append(el('path', { d: data.land, class: 'land', 'fill-rule': 'evenodd' }));
        this.L.hill.append(el('rect', { width: 1000, height: 1000, fill: 'url(#cc-hill)', class: 'hillshade' }));
        if (dur) { this.fade(this.L.land, dur * 0.7, dur * 0.35); this.fade(this.L.hill, dur, dur * 0.6); }
      }
      if (data.lakes) {
        this.svg.querySelector('#cc-lakeclip-p').setAttribute('d', data.lakes);
        this.L.lakes.append(el('path', { d: data.lakes, class: 'lake', 'fill-rule': 'evenodd' }));
        if (dur) this.fade(this.L.lakes, dur * 0.7, dur * 0.4);
      } else this.svg.querySelector('#cc-lakeclip-p').setAttribute('d', 'M0 0');
      for (const d of data.coast || []) {
        this.drawIn(this.L.coastglow, el('path', { d, class: 'coast-glow' }), dur);
        this.drawIn(this.L.coast, el('path', { d, class: 'coast' }), dur);
      }
    } else if (i === 2) {
      let k = 0;
      for (const [w, paths] of data.rivers || []) for (const d of paths) this.river(d, w, dur, (k++ % 6) * 90);
    } else if (i === 3) {
      if (data.urban) {
        const u = el('path', { d: data.urban, class: 'urban', 'fill-rule': 'evenodd' });
        this.L.urban.append(u);
        if (dur) this.anim(u, [{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 700, delay: 500, easing: 'cubic-bezier(.34,1.56,.64,1)', fill: 'backwards' });
      }
      for (const d of data.rail || []) {
        this.L.rail.append(el('path', { d, class: 'rail-base' }), el('path', { d, class: 'rail-ties' }));
      }
      if (dur && data.rail?.length) this.fade(this.L.rail, 700, dur * 0.8);
      const roads = [...(data.roads || [])].sort((a, b) => a[0] - b[0]);
      let k = 0;
      for (const [w, paths] of roads) for (const d of paths) {
        const delay = (k++ % 8) * 70 + (w > 1 ? 0 : 250);
        this.drawIn(this.L.roadcase, el('path', { d, class: 'road-case w' + w }), dur, delay);
        this.drawIn(this.L.roads, el('path', { d, class: 'road w' + w }), dur, delay);
      }
    } else if (i === 4) {
      let k = 0;
      const labs = [...(data.labels || [])].sort((a, b) => b[4] - a[4]); // biggest first
      for (const lab of labs) {
        const [x, y, t, kind, size, a, b] = lab;
        const g = el('g', { class: 'lab lab-' + kind });
        if (kind === 'c' && a != null) {
          g.append(el('circle', { cx: a, cy: b, r: size > 30 ? 11 : 8, class: 'dot-halo' }), el('circle', { cx: a, cy: b, r: size > 30 ? 6 : 4.5, class: 'dot' }));
        }
        const tx = el('text', { x, y, 'font-size': size, 'text-anchor': 'middle', 'dominant-baseline': 'central' });
        if (kind === 'r' && a) tx.setAttribute('transform', `rotate(${a} ${x} ${y})`);
        tx.textContent = t;
        g.append(tx);
        this.L.labels.append(g);
        if (dur) this.anim(g, [{ opacity: 0, transform: 'translateY(14px) scale(.7)' }, { opacity: 1, transform: 'none' }], { duration: 520, delay: 120 + 110 * k++, easing: 'cubic-bezier(.34,1.56,.64,1)', fill: 'backwards' });
      }
    }
  }

  // stage reveal FX: light sweep + stamp naming the new layer
  fx(i) {
    this.sweep.classList.remove('go'); void this.sweep.offsetWidth; this.sweep.classList.add('go');
    this.stamp.textContent = (i > 1 ? '+ ' : '') + STAGE_NAME[i];
    this.stamp.className = 'clue-stamp'; void this.stamp.offsetWidth; this.stamp.className = 'clue-stamp go s' + i;
  }

  river(d, w, dur, delay) {
    // stepped taper: Natural Earth rivers are digitised source -> mouth, so thicken the downstream end
    const base = el('path', { d, class: 'river w' + w });
    this.L.rivers.append(base);
    let len = 0;
    try { len = base.getTotalLength(); } catch { len = 0; }
    if (len > 60) {
      const mid = el('path', { d, class: 'river w' + w + ' t1', style: `stroke-dasharray:${len} ${len};stroke-dashoffset:${-len * 0.45}` });
      const low = el('path', { d, class: 'river w' + w + ' t2', style: `stroke-dasharray:${len} ${len};stroke-dashoffset:${-len * 0.75}` });
      this.L.rivers.append(mid, low);
      if (dur) for (const p of [mid, low]) this.anim(p, [{ opacity: 0 }, { opacity: 1 }], { duration: 500, delay: delay + dur * 0.8, fill: 'backwards' });
      if (!LOFX && w >= 2) {
        const flow = el('path', { d, class: 'river-flow' });
        this.L.rivers.append(flow);
        if (dur) this.anim(flow, [{ opacity: 0 }, { opacity: 1 }], { duration: 600, delay: delay + dur, fill: 'backwards' });
      }
    }
    this.drawIn(null, base, dur, delay, len);
  }

  anim(node, frames, opts) {
    const a = node.animate(frames, opts);
    this.anims.push(a);
    a.onfinish = () => { const i = this.anims.indexOf(a); if (i >= 0) this.anims.splice(i, 1); };
    return a;
  }

  fade(node, duration, delay = 0) { this.anim(node, [{ opacity: 0 }, { opacity: 1 }], { duration, delay, easing: 'ease-out', fill: 'backwards' }); }

  drawIn(parent, path, dur, delay = 0, len = 0) {
    if (parent) parent.append(path);
    if (!dur) return;
    if (!len) { try { len = path.getTotalLength(); } catch { len = 0; } }
    if (!len) return;
    path.style.strokeDasharray = `${len} ${len}`;
    const a = this.anim(path, [{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: dur * (0.8 + Math.random() * 0.35), delay, easing: 'cubic-bezier(.45,0,.2,1)', fill: 'both' });
    a.addEventListener('finish', () => { path.style.strokeDasharray = ''; a.cancel(); });
  }

  /** Mark the answer (frame centre) after the reveal; optional {lat, lon} un-redacts the coordinates. */
  showAnswer(name, at) {
    this.L.overlay.replaceChildren();
    const g = el('g', { class: 'answer-mark' });
    g.append(
      el('circle', { cx: 500, cy: 500, r: 40, class: 'ans-ring r2' }),
      el('circle', { cx: 500, cy: 500, r: 40, class: 'ans-ring' }),
      el('path', { d: 'M500 440v34M500 526v34M440 500h34M526 500h34', class: 'ans-cross' }),
      el('circle', { cx: 500, cy: 500, r: 9, class: 'ans-dot' }));
    this.L.overlay.append(g);
    this.host.dataset.answer = name;
    this.host.classList.add('answered');
    if (at && at.lat != null) {
      const f = (v, p, n) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? p : n}`;
      this.coords.innerHTML = `<span class="unredact">${f(at.lat, 'N', 'S')} ${f(at.lon, 'E', 'W')}</span>`;
    }
  }
}
