// Ambient client-only FX (no game logic):
//  - slowly rotating linework globe with "triangulation" ping arcs behind title / lobby / results
//  - theme picker (night / atlas / signal), persisted
//  - mobile mini-standings strip mirrored from the leaderboard DOM; tap to open the sheet
const LOFX = matchMedia('(pointer: coarse)').matches;
const root = document.documentElement;
const css = (k) => getComputedStyle(root).getPropertyValue(k).trim();

// ---------------------------------------------------------------- globe
function startGlobe() {
  const cv = document.getElementById('bg-globe');
  if (!cv || !window.d3) return;
  const ctx = cv.getContext('2d');
  let land = null, W = 0, H = 0, dpr = 1, R = 0, cx = 0, cy = 0;
  const proj = d3.geoOrthographic().clipAngle(90).precision(0.6);
  const path = d3.geoPath(proj, ctx);
  const grat = d3.geoGraticule10();
  const CITIES = [[2.3, 48.8], [-74, 40.7], [139.7, 35.7], [-46.6, -23.5], [77.2, 28.6], [31.2, 30], [151.2, -33.9], [37.6, 55.7], [-99.1, 19.4], [103.8, 1.3], [36.8, -1.3], [116.4, 39.9], [18.4, -33.9], [-58.4, -34.6], [-122.4, 37.8], [28.9, 41], [-0.1, 51.5], [100.5, 13.7], [44.4, 33.3], [-3.7, 40.4]];
  const arcs = [];
  const spawn = (now) => {
    const a = CITIES[(Math.random() * CITIES.length) | 0], b = CITIES[(Math.random() * CITIES.length) | 0];
    if (a !== b) arcs.push({ a, b, i: d3.geoInterpolate(a, b), t0: now, ms: 2600 + Math.random() * 1600 });
  };
  fetch('data/world.json').then((r) => r.json()).then((w) => {
    const step = LOFX ? 3 : 2;
    land = { type: 'MultiPolygon', coordinates: [] };
    const lines = { type: 'MultiLineString', coordinates: w.land.filter((r) => r.length > 8).map((r) => r.filter((_, i) => i % step === 0 || i === r.length - 1)) };
    land.lines = lines;
  }).catch(() => {});
  const size = () => {
    dpr = Math.min(LOFX ? 1.5 : 2, devicePixelRatio || 1);
    W = innerWidth; H = innerHeight;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const portrait = H > W;
    R = portrait ? W * 0.95 : Math.min(W, H) * 0.62;
    cx = portrait ? W * 0.5 : W * 0.72; cy = portrait ? H * 1.02 : H * 0.62;
    proj.scale(R).translate([cx, cy]);
  };
  addEventListener('resize', size); size();
  let last = 0, rot = 20;
  const frame = (now) => {
    requestAnimationFrame(frame);
    const active = document.querySelector('.screen.active');
    if (!active || active.id === 'scr-game') return; // the game map covers the background
    if (LOFX && now - last < 33) return; // ~30fps on phones
    const dt = Math.min(64, now - (last || now)); last = now;
    rot += dt * 0.004;
    proj.rotate([rot, -18, 0]);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const acc = css('--accent'), coast = css('--m-coast'), hot = css('--hot');
    // sphere glow
    const g = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.35, R * 0.1, cx, cy, R * 1.05);
    g.addColorStop(0, css('--m-ocean2')); g.addColorStop(1, css('--m-ocean'));
    ctx.beginPath(); path({ type: 'Sphere' }); ctx.fillStyle = g; ctx.globalAlpha = 0.9; ctx.fill(); ctx.globalAlpha = 0.5; ctx.strokeStyle = acc; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.globalAlpha = 0.16; ctx.beginPath(); path(grat); ctx.strokeStyle = acc; ctx.lineWidth = 0.7; ctx.stroke();
    if (land) { ctx.globalAlpha = 0.55; ctx.beginPath(); path(land.lines); ctx.strokeStyle = coast; ctx.lineWidth = 1; ctx.stroke(); }
    // triangulation arcs
    if (arcs.length < (LOFX ? 3 : 5) && Math.random() < 0.03) spawn(now);
    for (let k = arcs.length - 1; k >= 0; k--) {
      const A = arcs[k], f = (now - A.t0) / A.ms;
      if (f >= 1) { arcs.splice(k, 1); continue; }
      const head = Math.min(1, f * 1.6), tail = Math.max(0, f * 1.6 - 0.6);
      const pts = []; for (let s = tail; s <= head; s += 0.02) pts.push(A.i(s));
      pts.push(A.i(head));
      ctx.globalAlpha = 0.85 * Math.min(1, (1 - f) * 3);
      ctx.beginPath(); path({ type: 'LineString', coordinates: pts }); ctx.strokeStyle = hot; ctx.lineWidth = 1.6; ctx.stroke();
      for (const [c, on] of [[A.a, true], [A.b, head >= 1]]) {
        if (!on) continue;
        const p = proj(c); if (!p || d3.geoDistance(c, proj.invert([cx, cy])) > Math.PI / 2) continue;
        const pr = ((now - A.t0) / 900) % 1;
        ctx.beginPath(); ctx.arc(p[0], p[1], 2.5, 0, 7); ctx.fillStyle = hot; ctx.fill();
        ctx.beginPath(); ctx.arc(p[0], p[1], 3 + pr * 14, 0, 7); ctx.globalAlpha *= 1 - pr; ctx.strokeStyle = hot; ctx.lineWidth = 1; ctx.stroke();
        ctx.globalAlpha = 0.85 * Math.min(1, (1 - f) * 3);
      }
    }
    ctx.globalAlpha = 1;
  };
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- theme picker
function themePicker() {
  const cur = () => root.dataset.theme || 'night';
  const mark = () => document.querySelectorAll('[data-theme-set]').forEach((b) => b.classList.toggle('on', b.dataset.themeSet === cur()));
  document.querySelectorAll('[data-theme-set]').forEach((b) => b.addEventListener('click', () => {
    const t = b.dataset.themeSet;
    if (t === 'night') delete root.dataset.theme; else root.dataset.theme = t;
    try { localStorage.setItem('tri.theme', t); } catch { /* ignore */ }
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', css('--bg'));
    mark();
  }));
  mark();
}

// ---------------------------------------------------------------- mobile mini standings
function miniBoard() {
  const list = document.getElementById('board-list'), mini = document.getElementById('mini-board'), board = document.getElementById('board');
  if (!list || !mini) return;
  const render = () => {
    const rows = [...list.querySelectorAll('li.row')];
    if (!rows.length) { mini.replaceChildren(); return; }
    const me = rows.findIndex((r) => r.classList.contains('me'));
    const pick = new Set([0, 1, 2]);
    if (me >= 0) pick.add(me);
    const out = [];
    for (const i of [...pick].sort((a, b) => a - b)) {
      const r = rows[i]; if (!r) continue;
      const nm = r.querySelector('.nm span')?.textContent || '';
      const s = document.createElement('span');
      s.className = 'mb-item' + (r.classList.contains('me') ? ' me' : '') + (r.classList.contains('danger') ? ' danger' : '') + (r.classList.contains('dead') ? ' dead' : '');
      s.innerHTML = `<b>#${i + 1}</b>${r.querySelector('.tag-bot') ? '<i>🤖</i>' : ''}<span></span><em>${r.querySelector('.sc')?.textContent || ''}</em>`;
      s.querySelector('span').textContent = nm;
      out.push(s);
    }
    const more = document.createElement('span'); more.className = 'mb-more'; more.textContent = '▾';
    mini.replaceChildren(...out, more);
  };
  new MutationObserver(render).observe(list, { childList: true });
  const toggle = () => board.classList.toggle('open');
  mini.addEventListener('click', toggle);
  mini.addEventListener('keydown', (e) => { if (e.key === 'Enter') toggle(); });
  // tap outside the open sheet closes it (phones/tablets)
  document.addEventListener('pointerdown', (e) => {
    if (!board.classList.contains('open') || innerWidth > 1100) return;
    if (board.contains(e.target) || mini.contains(e.target) || e.target.closest('#btn-board')) return;
    board.classList.remove('open');
  });
}

function boot() { startGlobe(); themePicker(); miniBoard(); }
if (document.readyState === 'complete') boot(); else addEventListener('load', boot);
