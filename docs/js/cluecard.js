// Clue card: renders stage geometry (1000x1000 local frame) as layered SVG with draw-in animations.
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

export class ClueCard {
  constructor(host) {
    this.host = host;
    this.svg = el('svg', { viewBox: '0 0 1000 1000', class: 'clue-svg', preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': 'Map clue' });
    const defs = el('defs');
    defs.innerHTML = `
      <pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse"><path d="M50 0H0V50" fill="none" stroke="rgba(120,170,255,0.06)" stroke-width="1"/></pattern>
      <radialGradient id="vign" cx="50%" cy="50%" r="72%"><stop offset="60%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity=".55"/></radialGradient>
      <linearGradient id="landg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1f3049"/><stop offset="1" stop-color="#18263b"/></linearGradient>
      <filter id="glow" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      <clipPath id="frameclip"><rect width="1000" height="1000"/></clipPath>`;
    this.svg.append(defs);
    this.root = el('g', { 'clip-path': 'url(#frameclip)' });
    this.svg.append(this.root);
    this.layers = {};
    for (const name of ['ocean', 'land', 'urban', 'lakes', 'coast', 'rivers', 'rail', 'roads', 'labels', 'overlay']) {
      const g = el('g', { class: 'L-' + name });
      this.layers[name] = g; this.root.append(g);
    }
    this.layers.ocean.append(el('rect', { width: 1000, height: 1000, fill: '#0a1626' }), el('rect', { width: 1000, height: 1000, fill: 'url(#grid)' }));
    this.svg.append(el('rect', { width: 1000, height: 1000, fill: 'url(#vign)', 'pointer-events': 'none' }));
    host.append(this.svg);
    this.scale = document.createElement('div');
    this.scale.className = 'clue-scale';
    host.append(this.scale);
  }

  clear() {
    for (const k of ['land', 'urban', 'lakes', 'coast', 'rivers', 'rail', 'roads', 'labels', 'overlay']) this.layers[k].replaceChildren();
    this.scale.innerHTML = '';
    this.host.classList.remove('has-s1');
  }

  setScale(km) {
    // pick a round distance ~ 1/4 of the frame
    const nice = [10, 20, 25, 50, 75, 100, 150, 200];
    const target = km / 4;
    const d = nice.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
    this.scale.innerHTML = `<span class="bar" style="width:${(d / km) * 100}%"></span><span>${d} km</span>`;
  }

  draw(i, data, { animate = true } = {}) {
    const dur = animate ? 1500 : 0;
    if (i === 1) {
      this.setScale(data.km);
      this.host.classList.add('has-s1');
      if (data.land) this.fade(this.layers.land, el('path', { d: data.land, fill: 'url(#landg)', 'fill-rule': 'evenodd' }), dur);
      if (data.lakes) this.fade(this.layers.lakes, el('path', { d: data.lakes, fill: '#0c1b2f', 'fill-rule': 'evenodd' }), dur);
      for (const d of data.coast || []) this.drawIn(this.layers.coast, el('path', { d, class: 'coast' }), dur);
    } else if (i === 2) {
      for (const [w, paths] of data.rivers || []) for (const d of paths) this.drawIn(this.layers.rivers, el('path', { d, class: 'river w' + w }), dur);
    } else if (i === 3) {
      if (data.urban) this.fade(this.layers.urban, el('path', { d: data.urban, class: 'urban' }), dur);
      for (const d of data.rail || []) this.drawIn(this.layers.rail, el('path', { d, class: 'rail' }), dur);
      for (const [w, paths] of data.roads || []) for (const d of paths) this.drawIn(this.layers.roads, el('path', { d, class: 'road w' + w }), dur);
    } else if (i === 4) {
      let k = 0;
      for (const lab of data.labels || []) {
        const [x, y, t, kind, size, a, b] = lab;
        const g = el('g', { class: 'lab lab-' + kind });
        if (kind === 'c' && a != null) g.append(el('circle', { cx: a, cy: b, r: size > 30 ? 7 : 5, class: 'dot' }));
        const tx = el('text', { x, y, 'font-size': size, 'text-anchor': 'middle', 'dominant-baseline': 'central' });
        if (kind === 'r' && a) tx.setAttribute('transform', `rotate(${a} ${x} ${y})`);
        tx.textContent = t;
        g.append(tx);
        if (animate) g.style.animation = `labIn .5s ${0.08 * k++}s cubic-bezier(.2,1.4,.4,1) both`;
        this.layers.labels.append(g);
      }
    }
  }

  fade(parent, node, dur) {
    parent.append(node);
    if (dur) node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: dur * 0.8, easing: 'ease-out' });
  }

  drawIn(parent, path, dur) {
    parent.append(path);
    if (!dur) return;
    let len = 0;
    try { len = path.getTotalLength(); } catch { len = 0; }
    if (!len) return;
    path.style.strokeDasharray = `${len} ${len}`;
    path.style.strokeDashoffset = String(len);
    const a = path.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: dur + Math.random() * 400, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' });
    a.onfinish = () => { path.style.strokeDasharray = ''; path.style.strokeDashoffset = ''; a.cancel(); };
  }

  /** Overlay the answer name after reveal. */
  showAnswer(name) {
    this.layers.overlay.replaceChildren();
    const g = el('g', { class: 'answer-mark' });
    g.append(el('circle', { cx: 500, cy: 500, r: 16, class: 'ans-ring' }), el('circle', { cx: 500, cy: 500, r: 5, class: 'ans-dot' }));
    this.layers.overlay.append(g);
    this.host.dataset.answer = name;
  }
}
