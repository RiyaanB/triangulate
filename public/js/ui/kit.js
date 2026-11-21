// Reusable UI kit: toasts, banners, countdown ring, count-up, confetti, WebAudio blips, FLIP lists.
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

// ---- toasts
let toastBox;
export function toast(text, ms = 2200) {
  if (!toastBox) { toastBox = h('div', { class: 'toasts' }); document.body.append(toastBox); }
  const t = h('div', { class: 'toast' }, text);
  toastBox.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
  return t;
}

// ---- banner (big centred text)
export function banner(title, sub = '', { ms = 1600, color, cls = '' } = {}) {
  const b = h('div', { class: 'banner ' + cls }, h('div', { class: 'banner-inner' }, h('h1', { style: color ? { color } : {} }, title), sub ? h('p', {}, sub) : null));
  document.body.append(b);
  setTimeout(() => { b.classList.add('out'); setTimeout(() => b.remove(), 400); }, ms);
  return b;
}

// ---- countdown ring
export function makeRing(el) {
  const C = 2 * Math.PI * 22;
  el.classList.add('ring');
  el.innerHTML = `<svg viewBox="0 0 52 52"><circle class="track" cx="26" cy="26" r="22" fill="none" stroke-width="4"/><circle class="bar" cx="26" cy="26" r="22" fill="none" stroke-width="4" stroke-dasharray="${C}" stroke-dashoffset="0"/></svg><div class="num"></div>`;
  const bar = el.querySelector('.bar'), num = el.querySelector('.num');
  let lastSec = -1;
  return {
    set(remainMs, totalMs) {
      const f = totalMs > 0 ? Math.max(0, Math.min(1, remainMs / totalMs)) : 0;
      bar.setAttribute('stroke-dashoffset', String(C * (1 - f)));
      const s = Math.ceil(remainMs / 1000);
      if (s !== lastSec) { num.textContent = String(Math.max(0, s)); lastSec = s; }
      el.classList.toggle('urgent', remainMs > 0 && remainMs < 5000);
      return s;
    },
  };
}

// ---- number count-up
export function countUp(el, to, { from = 0, ms = 900, prefix = '', suffix = '' } = {}) {
  const t0 = performance.now();
  const step = (t) => {
    const f = Math.min(1, (t - t0) / ms);
    const e = 1 - Math.pow(1 - f, 3);
    el.textContent = prefix + fmt(from + (to - from) * e) + suffix;
    if (f < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---- confetti
export function confetti({ count = 180, ms = 4200 } = {}) {
  const c = h('canvas', { class: 'confetti-canvas' });
  document.body.append(c);
  const dpr = Math.min(2, devicePixelRatio || 1);
  c.width = innerWidth * dpr; c.height = innerHeight * dpr;
  const ctx = c.getContext('2d');
  const colors = ['#5ce1e6', '#7c6cff', '#ffcc4d', '#ff5d73', '#4ee6a0', '#ffffff'];
  const parts = Array.from({ length: count }, () => ({
    x: innerWidth * (0.2 + Math.random() * 0.6), y: innerHeight * 0.35, vx: (Math.random() - 0.5) * 14, vy: -6 - Math.random() * 12,
    r: 4 + Math.random() * 6, a: Math.random() * 6, va: (Math.random() - 0.5) * 0.4, col: colors[(Math.random() * colors.length) | 0],
  }));
  const t0 = performance.now();
  const frame = (t) => {
    const el = t - t0;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += 0.32; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.a += p.va;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a);
      ctx.globalAlpha = Math.max(0, 1 - el / ms);
      ctx.fillStyle = p.col; ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2);
      ctx.restore();
    }
    if (el < ms) requestAnimationFrame(frame); else c.remove();
  };
  requestAnimationFrame(frame);
}

// ---- WebAudio blips (no audio files)
export const sfx = (() => {
  let ctx = null, muted = localStorage.getItem('tri.muted') === '1';
  const ensure = () => {
    if (muted) return null;
    if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  };
  const tone = (freq, dur = 0.12, { type = 'sine', vol = 0.12, slide = 0, delay = 0 } = {}) => {
    const a = ensure(); if (!a) return;
    const t = a.currentTime + delay;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(a.destination); o.start(t); o.stop(t + dur + 0.02);
  };
  return {
    unlock: ensure,
    get muted() { return muted; },
    toggle() { muted = !muted; localStorage.setItem('tri.muted', muted ? '1' : '0'); return muted; },
    tick: () => tone(1200, 0.05, { type: 'square', vol: 0.03 }),
    pin: () => tone(520, 0.08, { type: 'triangle', vol: 0.1, slide: 300 }),
    stage: () => { tone(330, 0.25, { vol: 0.06, slide: 330 }); tone(660, 0.2, { vol: 0.04, delay: 0.08 }); },
    lock: () => { tone(440, 0.09, { type: 'square', vol: 0.06 }); tone(880, 0.18, { type: 'triangle', vol: 0.1, delay: 0.07 }); },
    reveal: () => [523, 659, 784].forEach((f, i) => tone(f, 0.22, { type: 'triangle', vol: 0.08, delay: i * 0.07 })),
    bad: () => tone(200, 0.4, { type: 'sawtooth', vol: 0.05, slide: -120 }),
    win: () => [523, 659, 784, 1046, 784, 1046].forEach((f, i) => tone(f, 0.25, { type: 'triangle', vol: 0.09, delay: i * 0.11 })),
  };
})();

// ---- FLIP reorder animation for a container's children (keyed by data-key)
export function flip(container, update) {
  const first = new Map();
  for (const el of container.children) first.set(el.dataset.key, el.getBoundingClientRect().top);
  update();
  for (const el of container.children) {
    const f = first.get(el.dataset.key);
    if (f == null) continue;
    const dy = f - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) continue;
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: 450, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
}
