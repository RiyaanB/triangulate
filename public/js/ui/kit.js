// Reusable UI kit: DOM helpers, toasts, wipe banners + screen shake, countdown ring, count-up,
// confetti cannons, procedural WebAudio sfx, FLIP list reordering with rank-change flashes.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
export const fmt = (n) => Math.round(n).toLocaleString('en-US');
const LOFX = matchMedia('(pointer: coarse)').matches;

// ---- toasts
let toastBox;
export function toast(text, ms = 2200) {
  if (!toastBox) { toastBox = h('div', { class: 'toasts' }); document.body.append(toastBox); }
  const t = h('div', { class: 'toast' }, text);
  toastBox.append(t);
  while (toastBox.children.length > 3) toastBox.firstChild.remove();
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
  return t;
}

// ---- screen shake + flash
export function shake(el = document.querySelector('.screen.active') || document.body) {
  el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
  setTimeout(() => el.classList.remove('shake'), 600);
}

// ---- banner: diagonal wipe band with big type (round intros, eliminations)
export function banner(title, sub = '', { ms = 1600, color, cls = '' } = {}) {
  for (const old of $$('.banner')) old.remove();
  const b = h('div', { class: 'banner ' + cls, style: color ? { '--bc': color } : {} },
    h('div', { class: 'wipe' }),
    h('div', { class: 'banner-inner' }, h('h1', {}, title), sub ? h('p', {}, sub) : null));
  if (color) b.style.setProperty('--bc', color);
  document.body.append(b);
  sfx.whoosh?.();
  if (cls.includes('elim')) {
    shake();
    const f = h('div', { class: 'flash-red' }); document.body.append(f); setTimeout(() => f.remove(), 950);
  }
  setTimeout(() => { b.classList.add('out'); setTimeout(() => b.remove(), 420); }, ms);
  return b;
}

// ---- countdown ring (with per-second bump and a global "urgent" state for the last 5 s)
export function makeRing(el) {
  const C = 2 * Math.PI * 22;
  el.classList.add('ring');
  el.innerHTML = `<svg viewBox="0 0 52 52"><circle class="track" cx="26" cy="26" r="22" fill="none" stroke-width="4"/><circle class="bar" cx="26" cy="26" r="22" fill="none" stroke-width="4" stroke-dasharray="${C}" stroke-dashoffset="0"/></svg><div class="num"></div>`;
  const bar = el.querySelector('.bar'), num = el.querySelector('.num');
  let lastSec = -1, lastUrgent = false;
  return {
    set(remainMs, totalMs) {
      const f = totalMs > 0 ? Math.max(0, Math.min(1, remainMs / totalMs)) : 0;
      bar.setAttribute('stroke-dashoffset', String(C * (1 - f)));
      const s = Math.ceil(remainMs / 1000);
      const urgent = remainMs > 0 && remainMs < 5000;
      if (s !== lastSec) {
        num.textContent = String(Math.max(0, s)); lastSec = s;
        if (urgent) { num.classList.remove('bump'); void num.offsetWidth; num.classList.add('bump'); }
      }
      if (urgent !== lastUrgent) { lastUrgent = urgent; el.classList.toggle('urgent', urgent); document.body.classList.toggle('urgent', urgent && el.closest('.screen.active') != null); }
      return s;
    },
  };
}

// ---- number count-up with a pop at the end
export function countUp(el, to, { from = 0, ms = 900, prefix = '', suffix = '', tick = true } = {}) {
  const t0 = performance.now();
  let lastTick = 0;
  const step = (t) => {
    const f = Math.min(1, (t - t0) / ms);
    const e = 1 - Math.pow(1 - f, 3);
    el.textContent = prefix + fmt(from + (to - from) * e) + suffix;
    if (tick && to > 0 && t - lastTick > 55 && f < 1) { lastTick = t; sfx.count?.(e); }
    if (f < 1) requestAnimationFrame(step);
    else if (to > 0) el.animate([{ transform: 'scale(1.35)', filter: 'brightness(1.6)' }, { transform: 'scale(1)', filter: 'none' }], { duration: 450, easing: 'cubic-bezier(.34,1.56,.64,1)' });
  };
  requestAnimationFrame(step);
}

// ---- confetti: two side cannons + a top burst; ribbons that flutter
export function confetti({ count = 180, ms = 4600 } = {}) {
  if (LOFX) count = Math.round(count * 0.55);
  const c = h('canvas', { class: 'confetti-canvas' });
  document.body.append(c);
  const dpr = Math.min(2, devicePixelRatio || 1);
  const W = innerWidth, H = innerHeight;
  c.width = W * dpr; c.height = H * dpr;
  const ctx = c.getContext('2d');
  const cs = getComputedStyle(document.documentElement);
  const colors = ['--accent', '--accent2', '--gold', '--hot', '--good', '--cta'].map((k) => cs.getPropertyValue(k).trim()).concat('#ffffff');
  const parts = Array.from({ length: count }, (_, i) => {
    const side = i % 3; // 0 left cannon, 1 right cannon, 2 top burst
    const sp = 9 + Math.random() * 13;
    const ang = side === 0 ? -Math.PI / 3 - Math.random() * 0.5 : side === 1 ? -Math.PI * 2 / 3 + Math.random() * 0.5 : Math.random() * Math.PI * 2;
    return {
      x: side === 0 ? -10 : side === 1 ? W + 10 : W / 2 + (Math.random() - 0.5) * 80, y: side === 2 ? H * 0.3 : H * 0.85,
      vx: Math.cos(ang) * sp * (side === 2 ? 0.6 : 1), vy: Math.sin(ang) * sp * (side === 2 ? 0.6 : 1) - (side === 2 ? 4 : 0),
      w: 6 + Math.random() * 7, hgt: 3 + Math.random() * 4, a: Math.random() * 6, va: (Math.random() - 0.5) * 0.35, ph: Math.random() * 6,
      col: colors[(Math.random() * colors.length) | 0], delay: side === 2 ? 250 : Math.random() * 150, round: Math.random() < 0.25,
    };
  });
  const t0 = performance.now();
  let last = t0;
  const frame = (t) => {
    const el = t - t0, dt = Math.min(2, (t - last) / 16.7); last = t;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = Math.max(0, Math.min(1, (ms - el) / 700));
    for (const p of parts) {
      if (el < p.delay) continue;
      p.vy += 0.3 * dt; p.vx *= Math.pow(0.985, dt); p.vy *= Math.pow(0.99, dt);
      p.x += (p.vx + Math.sin(el / 300 + p.ph) * 0.8) * dt; p.y += p.vy * dt; p.a += p.va * dt;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a);
      ctx.scale(1, Math.cos(el / 120 + p.ph)); // flutter
      ctx.fillStyle = p.col;
      if (p.round) { ctx.beginPath(); ctx.arc(0, 0, p.hgt, 0, 7); ctx.fill(); } else ctx.fillRect(-p.w / 2, -p.hgt / 2, p.w, p.hgt);
      ctx.restore();
    }
    if (el < ms) requestAnimationFrame(frame); else c.remove();
  };
  requestAnimationFrame(frame);
}

// ---- WebAudio sfx (procedural, no files). Toggle persisted in localStorage.
export const sfx = (() => {
  let ctx = null, master = null, muted = localStorage.getItem('tri.muted') === '1';
  const ensure = () => {
    if (muted) return null;
    if (!ctx) {
      try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
      master = ctx.createGain(); master.gain.value = 0.9;
      const comp = ctx.createDynamicsCompressor(); master.connect(comp).connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  };
  const tone = (freq, dur = 0.12, { type = 'sine', vol = 0.12, slide = 0, delay = 0, attack = 0.008 } = {}) => {
    const a = ensure(); if (!a) return;
    const t = a.currentTime + delay;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(master); o.start(t); o.stop(t + dur + 0.02);
  };
  let noiseBuf = null;
  const noise = (dur = 0.3, { vol = 0.08, from = 400, to = 3000, q = 1.2, delay = 0 } = {}) => {
    const a = ensure(); if (!a) return;
    if (!noiseBuf) { noiseBuf = a.createBuffer(1, a.sampleRate, a.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    const t = a.currentTime + delay;
    const s = a.createBufferSource(); s.buffer = noiseBuf;
    const f = a.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = q;
    f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = a.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + dur * 0.3); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(master); s.start(t); s.stop(t + dur + 0.05);
  };
  let lastCount = 0;
  return {
    unlock: ensure,
    get muted() { return muted; },
    toggle() { muted = !muted; localStorage.setItem('tri.muted', muted ? '1' : '0'); if (!muted) ensure(); return muted; },
    tick: (s = 5) => { tone(900 + (5 - s) * 140, 0.06, { type: 'square', vol: 0.035 }); tone(1800 + (5 - s) * 280, 0.03, { type: 'sine', vol: 0.02 }); },
    pin: () => { tone(380, 0.07, { type: 'triangle', vol: 0.1, slide: 420 }); noise(0.06, { vol: 0.03, from: 2500, to: 1200, delay: 0.05 }); },
    stage: () => { noise(0.35, { vol: 0.04, from: 300, to: 4000 }); tone(440, 0.22, { vol: 0.05, slide: 220, delay: 0.05 }); tone(880, 0.18, { type: 'triangle', vol: 0.035, delay: 0.14 }); },
    lock: () => { tone(110, 0.18, { type: 'sine', vol: 0.22, slide: -50 }); tone(660, 0.1, { type: 'square', vol: 0.05 }); tone(990, 0.25, { type: 'triangle', vol: 0.09, delay: 0.06 }); tone(1320, 0.3, { type: 'sine', vol: 0.05, delay: 0.12 }); },
    count: (f = 0) => { const n = performance.now(); if (n - lastCount < 50) return; lastCount = n; tone(700 + f * 900, 0.03, { type: 'square', vol: 0.025 }); },
    reveal: () => [523, 659, 784].forEach((f, i) => tone(f, 0.24, { type: 'triangle', vol: 0.08, delay: i * 0.07 })),
    whoosh: () => noise(0.45, { vol: 0.05, from: 200, to: 2400, q: 0.8 }),
    bad: () => { tone(220, 0.5, { type: 'sawtooth', vol: 0.06, slide: -150 }); tone(60, 0.5, { type: 'sine', vol: 0.25, slide: -25 }); noise(0.5, { vol: 0.06, from: 900, to: 120 }); },
    win: () => { [523, 659, 784, 1046, 784, 1046, 1318].forEach((f, i) => tone(f, 0.28, { type: 'triangle', vol: 0.09, delay: i * 0.1 })); noise(0.8, { vol: 0.04, from: 3000, to: 8000, delay: 0.6 }); },
  };
})();

// ---- FLIP reorder animation for a container's children (keyed by data-key); rows that climb or
// drop get .rank-up / .rank-down for a flash.
export function flip(container, update) {
  const first = new Map(), firstIdx = new Map();
  [...container.children].forEach((el, i) => { first.set(el.dataset.key, el.getBoundingClientRect().top); firstIdx.set(el.dataset.key, i); });
  update();
  [...container.children].forEach((el, i) => {
    const f = first.get(el.dataset.key);
    if (f == null) return;
    const dy = f - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) return;
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: 650, easing: 'cubic-bezier(.2,.8,.2,1)' });
    const di = firstIdx.get(el.dataset.key) - i;
    if (el.classList.contains('row') && Math.abs(di) >= 1) {
      el.classList.add(di > 0 ? 'rank-up' : 'rank-down');
      el.dataset.move = (di > 0 ? '▲' : '▼') + Math.abs(di);
      setTimeout(() => { el.classList.remove('rank-up', 'rank-down'); }, 1600);
    }
  });
}
