// TRIANGULATE client controller: screens, message handling, HUD.
import { $, $$, h, fmt, toast, banner, makeRing, countUp, confetti, sfx, flip } from './ui/kit.js';
import { WsConnection, LocalConnection } from './net.js';
import { ClueCard } from './cluecard.js';
import { GuessMap } from './guessmap.js';
import { STAGE_MULT, elimCount, makeConfig } from '../shared/game/rules.js';

const params = new URLSearchParams(location.search);
const SPEED = Number(params.get('speed')) || 1;

const S = {
  conn: null, mode: null, you: null, code: null, host: null, phase: null,
  players: [], round: 0, rounds: 7, stage: 0, myLock: 0, myPin: null,
  rt: null, // round timing (performance.now based)
  phaseEnd: 0, phaseTotal: 0, reveal: null, elimAfter: false, seenHint: localStorage.getItem('tri.hint') === '1',
  alive: true, lastTick: -1, overEnd: 0,
};
window.__tri = S; // for automated tests

// ------------------------------------------------------------------ setup
const card = new ClueCard($('#clue-frame'));
const ring = makeRing($('#ring'));
let map;

const ADJ = ['Swift', 'Quiet', 'Lucky', 'Brave', 'Clever', 'Rapid', 'Sunny', 'Misty', 'Bold', 'Witty', 'Sly', 'Calm', 'Keen', 'Wild'];
const NOUN = ['Otter', 'Falcon', 'Heron', 'Lynx', 'Gecko', 'Puffin', 'Marten', 'Ibis', 'Orca', 'Yak', 'Kiwi', 'Tapir', 'Wombat', 'Koi'];
const randName = () => ADJ[Math.random() * ADJ.length | 0] + NOUN[Math.random() * NOUN.length | 0];
$('#nick').value = localStorage.getItem('tri.nick') || randName();
$('#dice').onclick = () => { $('#nick').value = randName(); sfx.pin(); };
const nick = () => { const n = $('#nick').value.trim() || randName(); localStorage.setItem('tri.nick', n); return n; };

function show(id) {
  for (const s of $$('.screen')) s.classList.toggle('active', s.id === id);
  if (id === 'scr-game' && map) requestAnimationFrame(() => map.resize());
}

const STATIC = !!window.TRI_STATIC;

// ------------------------------------------------------------------ connecting
function connect(kind, extra = {}) {
  sfx.unlock();
  disconnect();
  S.mode = kind === 'solo' ? 'solo' : kind;
  resetGameState();
  if (STATIC && kind !== 'solo') {
    // static build (GitHub Pages): full 20-player match against in-browser bots, no server
    S.conn = new LocalConnection({ name: nick(), seed: 'match-' + Math.random(), speed: SPEED, mode: 'public', config: { lobbyMs: 5000 } });
    S.conn.onmessage = onMsg;
    S.conn.ready.catch((e) => { toast('Could not load clue pack: ' + e.message); show('scr-title'); });
    setConn('');
  } else if (kind === 'solo') {
    const daily = extra.practice ? 'practice-' + Math.random() : 'daily-' + new Date().toISOString().slice(0, 10);
    S.conn = new LocalConnection({ name: nick(), seed: daily, speed: SPEED });
    S.conn.onmessage = onMsg;
    S.conn.ready.catch((e) => { toast('Could not load solo pack: ' + e.message); show('scr-title'); });
    setConn('');
  } else {
    const join = { t: 'join', name: nick(), mode: kind, code: extra.code };
    let opened = false;
    S.conn = new WsConnection(join, {
      onStatus: (st) => {
        if (st === 'open') opened = true;
        if (st === 'reconnecting') setConn('reconnecting…');
        if (st === 'reconnected' || st === 'open') setConn('');
        if (st === 'failed') {
          setConn('offline');
          toast(opened ? 'Connection lost.' : 'Can’t reach the server — try Daily solo!', 4000);
          show('scr-title');
        }
      },
    });
    S.conn.onmessage = onMsg;
  }
  showLobbyLoading(kind);
}
function disconnect() { if (S.conn) { S.conn.close(); S.conn = null; } }
function setConn(t) { $('#conn-state').textContent = t; }
function send(m) { S.conn?.send(m); }

function showLobbyLoading(kind) {
  if (kind === 'solo') { show('scr-game'); prepareRoundUi(); return; }
  $('#lobby-kind').textContent = kind === 'public' ? 'Public match' : 'Private room';
  $('#lobby-title').textContent = 'Connecting…';
  $('#lobby-players').replaceChildren();
  $('#lobby-ms').textContent = '–';
  show('scr-lobby');
}

function resetGameState() {
  Object.assign(S, { you: null, phase: null, players: [], round: 0, stage: 0, myLock: 0, myPin: null, rt: null, reveal: null, alive: true });
  $('#skip-bar').classList.add('hidden');
  $('#spec-chip').classList.add('hidden');
}

// ------------------------------------------------------------------ messages
function onMsg(m) {
  switch (m.t) {
    case 'welcome': S.you = m.you; S.code = m.code; S.mode = m.mode; break;
    case 'snap': applySnap(m); break;
    case 'players': S.players = m.players; renderPlayers(); break;
    case 'lobby': onLobby(m); break;
    case 'intro': onIntro(m); break;
    case 'round': onRound(m); break;
    case 'stage': onStage(m); break;
    case 'lock': break;
    case 'locked': onLocked(m); break;
    case 'ending': toast('Everyone locked in!', 1200); break;
    case 'reveal': onReveal(m); break;
    case 'standings': onStandings(m); break;
    case 'over': onOver(m); break;
    case 'error':
      toast(m.msg || 'Error', 3000);
      if (m.code === 'noroom') { disconnect(); show('scr-title'); }
      break;
  }
}

function setPhaseClass() {
  const g = $('#scr-game');
  for (const c of [...g.classList]) if (c.startsWith('ph-')) g.classList.remove(c);
  if (S.phase) g.classList.add('ph-' + S.phase);
}
function setPhaseTimer(ms) {
  setPhaseClass(); S.phaseTotal = ms; S.phaseEnd = ms ? performance.now() + ms : 0; }

function applySnap(m) {
  S.you = m.you; S.code = m.code; S.mode = m.mode; S.host = m.host; S.players = m.players;
  S.round = m.round; S.rounds = m.rounds; S.phase = m.phase;
  const me = m.players.find((p) => p.id === S.you);
  S.alive = !!me?.alive;
  if (m.phase === 'lobby') { onLobby({ ms: m.ms, host: m.host, code: m.code, mode: m.mode }); return; }
  show('scr-game');
  setSpectator(!S.alive);
  if (m.phase === 'round' && m.roundInfo) {
    prepareRoundUi();
    onRound(m.roundInfo, true);
    m.stages.forEach((d, i) => onStage({ i: i + 1, data: d }, true));
    if (m.mine?.guess) { S.myPin = m.mine.guess; map.setPin(m.mine.guess.lat, m.mine.guess.lon, false); }
    if (m.mine?.lock) onLocked({ stage: m.mine.lock }, true);
    updateLockBtn();
  } else if ((m.phase === 'reveal' || m.phase === 'standings') && m.reveal) {
    prepareRoundUi();
    onReveal({ ...m.reveal, ms: m.ms }, true);
  } else if (m.phase === 'over' && m.ranking) onOver({ ranking: m.ranking, ms: m.ms });
  else if (m.phase === 'intro') { prepareRoundUi(); setPhaseTimer(m.ms); }
  renderPlayers();
}

// ------------------------------------------------------------------ lobby
function onLobby(m) {
  S.phase = 'lobby'; S.host = m.host; S.code = m.code;
  if (S.mode === 'solo') return;
  show('scr-lobby');
  const priv = m.mode === 'private';
  $('#lobby-kind').textContent = priv ? 'Private room' : 'Public match';
  $('#lobby-title').textContent = priv ? (m.ms ? 'Get ready!' : 'Waiting for host…') : 'Finding players…';
  $('#lobby-code-row').classList.toggle('hidden', !priv);
  $('#lobby-code').textContent = m.code;
  const isHost = S.host === S.you;
  $('#btn-start').classList.toggle('hidden', !(priv && isHost && !m.ms));
  $('#bots-toggle').classList.toggle('hidden', !(priv && isHost && !m.ms));
  if (priv && isHost && !m.ms) $('#lobby-title').textContent = 'Invite friends, then start';
  setPhaseTimer(m.ms || 0);
  if (!m.ms) $('#lobby-ms').textContent = '…';
  renderPlayers();
}

function renderLobbyPlayers() {
  const box = $('#lobby-players');
  const have = new Set($$('.lp', box).map((e) => e.dataset.key));
  const want = new Set(S.players.map((p) => p.id));
  for (const e of $$('.lp', box)) if (!want.has(e.dataset.key)) e.remove();
  for (const p of S.players) {
    if (have.has(p.id)) continue;
    const hue = [...p.name].reduce((a, c) => a + c.charCodeAt(0), 0) * 47 % 360;
    box.append(h('div', { class: 'lp' + (p.id === S.you ? ' me' : ''), 'data-key': p.id },
      h('span', { class: 'av', style: { background: `hsl(${hue} 80% 65%)` } }, p.name[0].toUpperCase()),
      h('span', { class: 'nm' }, p.name), p.bot ? h('span', { class: 'tag-bot' }, '🤖 BOT') : null,
      p.host ? h('span', { title: 'host' }, '👑') : null));
  }
}

// ------------------------------------------------------------------ rounds
function prepareRoundUi() {
  card.clear();
  $('#script-tag').classList.add('hidden');
  $('#answer-tag').classList.add('hidden');
  $('#result').classList.add('hidden');
  $('#board').classList.remove('open');
  $$('#stagebar .seg').forEach((s) => { s.classList.remove('on', 'done'); s.querySelector('.fill').style.width = '0'; });
  S.myLock = 0; S.myPin = null; S.stage = 0; S.rt = null; S.reveal = null;
  map?.reset();
  if (map) map.enabled = false;
  updateLockBtn();
}

function onIntro(m) {
  show('scr-game');
  S.phase = 'intro'; S.round = m.round; S.rounds = m.rounds; S.elimAfter = m.elimAfter;
  prepareRoundUi();
  setPhaseTimer(m.ms);
  $('#round-chip').textContent = (innerWidth < 500 ? 'R' : 'Round ') + `${m.round}/${m.rounds}`;
  const sub = m.elimAfter ? '⚠ Bottom 20% eliminated after this round' : m.round === m.rounds ? 'Final round!' : `${m.km} km window`;
  banner(m.round === m.rounds ? 'FINAL ROUND' : `ROUND ${m.round}`, sub, { ms: Math.min(1900, m.ms - 300) });
  renderPlayers();
}

function onRound(m, silent) {
  S.phase = 'round'; S.round = m.round; S.rounds = m.rounds; S.elimAfter = m.elimAfter;
  const now = performance.now();
  S.rt = { stageT: m.stageMs.map((x) => now + x), end: now + m.ms, total: m.totalMs };
  setPhaseTimer(m.ms);
  S.phaseTotal = m.totalMs;
  $('#round-chip').textContent = (innerWidth < 500 ? 'R' : 'Round ') + `${m.round}/${m.rounds}`;
  map.enabled = S.alive;
  if (S.alive && !S.seenHint && !silent) {
    $('#hint').classList.remove('hidden');
  }
  updateLockBtn();
  renderPlayers();
}

function onStage(m, silent) {
  S.stage = m.i;
  card.draw(m.i, m.data, { animate: !silent });
  if (m.i === 1 && m.data.borders?.length && !card.supports?.borders) drawBordersFallback(m.data.borders);
  $$('#stagebar .seg').forEach((s) => {
    const i = +s.dataset.i;
    s.classList.toggle('on', i === m.i);
    s.classList.toggle('done', i < m.i);
  });
  if (m.i === 1 && !(m.data.coast || []).length) {
    const t = $('#script-tag');
    t.innerHTML = '🏜 <b>Inland</b> — no coastline in view';
    t.classList.remove('hidden');
  }
  if (m.i === 4 && m.data.script) {
    const t = $('#script-tag');
    t.innerHTML = m.data.translit ? `Names in <b>${m.data.script}</b> <span style="opacity:.7">(transliterated, not local)</span>` : `Names in local script: <b>${m.data.script}</b>`;
    t.classList.remove('hidden');
  }
  if (!silent) { if (m.i > 1) sfx.stage(); }
  updateLockBtn();
}

// [core] fallback until cluecard.js renders clue-format-v2 stage-1 borders itself (see REQUESTS-core.md)
function drawBordersFallback(paths) {
  const host = card.layers?.coast;
  if (!host) return;
  for (const d of paths) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', '#f5a3c7');
    p.setAttribute('stroke-width', '2.5');
    p.setAttribute('stroke-dasharray', '10 7');
    p.setAttribute('opacity', '.75');
    host.prepend(p);
  }
}

function updateLockBtn() {
  const b = $('#btn-lock');
  const mult = STAGE_MULT[(S.myLock || S.stage || 1) - 1];
  $('#lock-mult').textContent = '×' + mult.toFixed(1);
  const txt = b.querySelector('.lock-txt');
  b.classList.toggle('locked', !!S.myLock);
  if (!S.alive) { txt.textContent = 'Spectating'; b.disabled = true; return; }
  if (S.myLock) { txt.textContent = 'Locked in'; b.disabled = true; return; }
  if (S.phase !== 'round') { txt.textContent = S.phase === 'intro' ? 'Get ready' : 'Drop a pin'; b.disabled = true; return; }
  txt.textContent = S.myPin ? 'Lock in' : 'Drop a pin';
  b.disabled = !S.myPin;
}

function onPin(lat, lon) {
  if (S.phase !== 'round' || S.myLock || !S.alive) return;
  S.myPin = { lat, lon };
  send({ t: 'pin', lat, lon });
  sfx.pin();
  if (!S.seenHint) { S.seenHint = true; localStorage.setItem('tri.hint', '1'); $('#hint').classList.add('hidden'); }
  updateLockBtn();
}

function lockIn() {
  if (S.phase !== 'round' || S.myLock || !S.myPin || !S.alive) return;
  send({ t: 'lock', lat: S.myPin.lat, lon: S.myPin.lon });
  S.myLock = S.stage; // optimistic
  map.setLocked(true);
  sfx.lock();
  updateLockBtn();
}

function onLocked(m, silent) {
  S.myLock = m.stage;
  if (m.lat != null) { S.myPin = { lat: m.lat, lon: m.lon }; }
  map.locked = true; if (silent) map.draw(); else map.setLocked(true);
  updateLockBtn();
}

// ------------------------------------------------------------------ reveal & standings
function onReveal(m, silent) {
  S.phase = 'reveal'; S.reveal = m; S.rt = null;
  setPhaseTimer(m.ms || 0);
  map.enabled = false;
  $('#hint').classList.add('hidden');
  $$('#stagebar .seg').forEach((s) => s.classList.remove('on'));
  const mine = m.results.find((r) => r.id === S.you);
  const byId = new Map(S.players.map((p) => [p.id, p]));
  const others = m.results.filter((r) => r.id !== S.you && r.lat != null).map((r) => ({ ...r, bot: byId.get(r.id)?.bot }));
  map.showReveal(m.answer, mine && mine.lat != null ? mine : null, others);
  card.showAnswer(m.answer.name);
  const at = $('#answer-tag');
  at.textContent = '📍 ' + m.answer.name;
  at.classList.remove('hidden');
  const res = $('#result');
  $('#res-place').replaceChildren(h('span', {}, m.answer.name), h('small', {}, countryName(m.answer.cc)));
  if (mine && S.alive) {
    $('#res-dist').textContent = mine.d == null ? 'no guess' : fmt(mine.d) + ' km';
    $('#res-mult').textContent = mine.stage ? '×' + STAGE_MULT[mine.stage - 1].toFixed(1) : '–';
    if (silent) $('#res-pts').textContent = '+' + fmt(mine.pts);
    else setTimeout(() => { countUp($('#res-pts'), mine.pts, { prefix: '+', ms: 1100 }); sfx.reveal(); }, 900);
    $('#res-pts').textContent = '+0';
  } else {
    $('#res-dist').textContent = '–'; $('#res-mult').textContent = '–'; $('#res-pts').textContent = '–';
  }
  const best = m.results[0];
  const bp = best && byId.get(best.id);
  $('#res-best').textContent = best && best.pts > 0 ? `Round best: ${bp?.name ?? '?'}${bp?.bot ? ' 🤖' : ''} · ${fmt(best.d)} km · ${fmt(best.pts)} pts` : '';
  res.classList.remove('hidden');
  updateLockBtn();
  renderPlayers(true);
}

function onStandings(m) {
  S.phase = 'standings';
  setPhaseTimer(m.ms);
  const elim = new Set(m.elim);
  if (m.elim.length) {
    if (elim.has(S.you)) {
      S.alive = false;
      banner('ELIMINATED', 'You can keep watching — or play again after the game.', { ms: 2600, color: '#ff5d73', cls: 'elim' });
      sfx.bad();
      setSpectator(true);
    } else {
      toast(`💥 ${m.elim.length} eliminated`, 1800);
      if (S.alive && S.mode) setTimeout(() => toast('You survived ✅', 1500), 500);
    }
  }
  if (innerWidth <= 1100) setTimeout(() => { if (S.phase === 'standings') $('#board').classList.add('open'); }, elim.has(S.you) ? 2700 : 0);
  renderPlayers(false, elim);
}

function setSpectator(on) {
  $('#spec-chip').classList.toggle('hidden', !on);
  $('#skip-bar').classList.toggle('hidden', !(on && S.mode === 'solo'));
  if (map) map.enabled = !on && S.phase === 'round';
  updateLockBtn();
}

// ------------------------------------------------------------------ leaderboard
function sortedPlayers() {
  return S.players.filter((p) => !p.spec).sort((a, b) => (b.alive - a.alive) || (b.alive ? 0 : b.elim - a.elim) || (b.total - a.total) || a.name.localeCompare(b.name));
}

function renderPlayers(withDelta = false, elimNow = new Set()) {
  if (S.phase === 'lobby') { renderLobbyPlayers(); return; }
  const list = sortedPlayers();
  const alive = list.filter((p) => p.alive);
  $('#alive-chip').textContent = `${alive.length} alive`;
  const me = S.players.find((p) => p.id === S.you);
  if (me) {
    const rank = list.findIndex((p) => p.id === S.you) + 1;
    $('#my-score').textContent = `#${rank} · ${fmt(me.total)}`;
  }
  const cfg = makeConfig(S.mode === 'solo' ? 'solo' : 'public', { rounds: S.rounds });
  const cut = S.elimAfter && (S.phase === 'round' || S.phase === 'reveal' || S.phase === 'intro') ? elimCount(cfg, alive.length) : 0;
  $('#board-sub').textContent = `${alive.length}/${list.length} alive`;
  $('#board-foot').textContent = cut ? `Bottom ${cut} will be eliminated after this round` : '';
  const ol = $('#board-list');
  flip(ol, () => {
    const rows = [];
    list.forEach((p, i) => {
      if (cut && i === alive.length - cut) rows.push(h('li', { class: 'cutline', 'data-key': 'cut' }));
      const danger = cut && p.alive && i >= alive.length - cut;
      const st = S.phase === 'round' && p.alive && p.lock ? h('span', { class: 'lk', title: 'Locked at stage ' + p.lock }, String(p.lock)) : !p.alive ? '✕' : '';
      const row = h('li', {
        class: 'row' + (p.id === S.you ? ' me' : '') + (p.alive ? '' : ' dead') + (danger ? ' danger' : '') + (elimNow.has(p.id) ? ' elim-now' : '') + (p.conn ? '' : ' dc'),
        'data-key': p.id,
      },
        h('span', { class: 'rk' }, i + 1),
        h('span', { class: 'nm' }, h('span', {}, p.name), p.bot ? h('i', { class: 'tag-bot', title: 'Bot' }, '🤖') : null),
        h('span', { class: 'sc' }, fmt(p.total)),
        h('span', { class: 'st' }, st));
      if (withDelta && p.last > 0) row.append(h('span', { class: 'delta' }, '+' + fmt(p.last)));
      rows.push(row);
    });
    ol.replaceChildren(...rows);
  });
}

// ------------------------------------------------------------------ game over
function onOver(m) {
  S.phase = 'over';
  setPhaseTimer(m.ms || 0);
  S.overEnd = m.ms ? performance.now() + m.ms : 0;
  show('scr-over');
  $('#skip-bar').classList.add('hidden');
  const r = m.ranking;
  const meIdx = r.findIndex((p) => p.id === S.you);
  const won = meIdx === 0;
  $('#over-title').textContent = won ? '🏆 You win!' : `${r[0]?.name}${r[0]?.bot ? ' 🤖' : ''} wins`;
  const pod = $('#podium');
  pod.replaceChildren(...[1, 0, 2].map((i) => r[i] ? h('div', { class: `pod p${i + 1}` + (r[i].id === S.you ? ' me' : '') },
    h('div', { class: 'nm' }, r[i].name + (r[i].bot ? ' 🤖' : '')), h('div', { class: 'sc' }, fmt(r[i].total) + ' pts'),
    h('div', { class: 'blk' }, String(i + 1))) : h('div')));
  if (meIdx >= 0) {
    const me = r[meIdx];
    $('#over-me').innerHTML = `You finished <b>#${meIdx + 1}</b> of ${r.length} with <b>${fmt(me.total)}</b> pts` + (me.elim ? ` <span style="color:var(--muted)">(out in round ${me.elim})</span>` : '');
  } else $('#over-me').textContent = '';
  $('#over-list').replaceChildren(...r.slice(3, 12).map((p) => h('div', { class: 'row' + (p.id === S.you ? ' me' : '') + (p.alive ? '' : ' dead') },
    h('span', { class: 'rk' }, p.rank), h('span', { class: 'nm' }, h('span', {}, p.name), p.bot ? h('i', { class: 'tag-bot' }, '🤖') : null), h('span', { class: 'sc' }, fmt(p.total)))));
  $('#btn-again').disabled = false;
  $('#btn-again').textContent = 'Play again';
  if (won) { confetti(); sfx.win(); setTimeout(() => confetti({ count: 120 }), 900); } else sfx.reveal();
}

const CC = { RU: 'Russia', UA: 'Ukraine', GR: 'Greece', CY: 'Cyprus', BG: 'Bulgaria', RS: 'Serbia', MK: 'North Macedonia', IT: 'Italy', IS: 'Iceland', PT: 'Portugal', ES: 'Spain', FR: 'France', NL: 'Netherlands', DK: 'Denmark', SE: 'Sweden', NO: 'Norway', GB: 'United Kingdom', IE: 'Ireland', CH: 'Switzerland', HU: 'Hungary', RO: 'Romania', AT: 'Austria', DE: 'Germany', PL: 'Poland', LV: 'Latvia', FI: 'Finland', BY: 'Belarus', MT: 'Malta', TR: 'Türkiye', AE: 'UAE', QA: 'Qatar', BH: 'Bahrain', KW: 'Kuwait', IQ: 'Iraq', IR: 'Iran', OM: 'Oman', SA: 'Saudi Arabia', YE: 'Yemen', IL: 'Israel', LB: 'Lebanon', SY: 'Syria', EG: 'Egypt', AZ: 'Azerbaijan', GE: 'Georgia', AM: 'Armenia', ZA: 'South Africa', MG: 'Madagascar', TZ: 'Tanzania', KE: 'Kenya', UG: 'Uganda', RW: 'Rwanda', ET: 'Ethiopia', DJ: 'Djibouti', SD: 'Sudan', TN: 'Tunisia', DZ: 'Algeria', MA: 'Morocco', SN: 'Senegal', GM: 'Gambia', NG: 'Nigeria', GH: 'Ghana', CD: 'DR Congo', AO: 'Angola', ZW: 'Zimbabwe', MW: 'Malawi', MU: 'Mauritius', CV: 'Cape Verde', SO: 'Somalia', LY: 'Libya', IN: 'India', BD: 'Bangladesh', LK: 'Sri Lanka', PK: 'Pakistan', NP: 'Nepal', MV: 'Maldives', AF: 'Afghanistan', JP: 'Japan', KR: 'South Korea', KP: 'North Korea', CN: 'China', HK: 'Hong Kong', TW: 'Taiwan', MN: 'Mongolia', SG: 'Singapore', TH: 'Thailand', VN: 'Vietnam', PH: 'Philippines', ID: 'Indonesia', MY: 'Malaysia', MM: 'Myanmar', KH: 'Cambodia', LA: 'Laos', BN: 'Brunei', TL: 'Timor-Leste', UZ: 'Uzbekistan', KZ: 'Kazakhstan', KG: 'Kyrgyzstan', TM: 'Turkmenistan', TJ: 'Tajikistan', AU: 'Australia', NZ: 'New Zealand', FJ: 'Fiji', PF: 'French Polynesia', US: 'United States', PG: 'Papua New Guinea', NC: 'New Caledonia', CA: 'Canada', MX: 'Mexico', CU: 'Cuba', PA: 'Panama', PR: 'Puerto Rico', JM: 'Jamaica', NI: 'Nicaragua', GT: 'Guatemala', DO: 'Dominican Rep.', TT: 'Trinidad & Tobago', BR: 'Brazil', AR: 'Argentina', UY: 'Uruguay', CL: 'Chile', PE: 'Peru', CO: 'Colombia', VE: 'Venezuela', EC: 'Ecuador', FK: 'Falkland Is.' };
const countryName = (cc) => CC[cc] || cc;

// ------------------------------------------------------------------ ticker
function tick() {
  const now = performance.now();
  const remain = Math.max(0, S.phaseEnd - now);
  if (S.phase === 'lobby') { $('#lobby-ms').textContent = S.phaseEnd ? String(Math.ceil(remain / 1000)) : '…'; $('.lobby-count').style.visibility = S.phaseEnd ? '' : 'hidden'; }
  if (S.phase === 'round' && S.rt) {
    const s = ring.set(S.rt.end - now, S.rt.total);
    if (s <= 5 && s > 0 && s !== S.lastTick && !S.myLock && S.alive) { S.lastTick = s; sfx.tick(); }
    $$('#stagebar .seg').forEach((seg) => {
      const i = +seg.dataset.i;
      const a = S.rt.stageT[i - 1], b = i < 4 ? S.rt.stageT[i] : S.rt.end;
      const f = Math.max(0, Math.min(1, (now - a) / (b - a)));
      seg.querySelector('.fill').style.width = (f * 100).toFixed(1) + '%';
    });
  } else if (S.phase === 'intro') ring.set(0, 1);
  else if (S.phase === 'reveal' || S.phase === 'standings') ring.set(remain, S.phaseTotal);
  if (S.phase === 'over' && S.mode !== 'solo') {
    $('#over-sub').textContent = S.overEnd ? `Next game in ${Math.ceil(Math.max(0, S.overEnd - now) / 1000)}s` : '';
  }
  requestAnimationFrame(tick);
}

// ------------------------------------------------------------------ wiring
$('#btn-play').onclick = () => connect('public');
$('#btn-solo').onclick = () => connect('solo');
$('#btn-private').onclick = () => { $('#private-panel').classList.toggle('hidden'); $('#code-in').focus(); };
$('#btn-create').onclick = () => connect('create');
$('#btn-join').onclick = () => {
  const c = $('#code-in').value.trim().toUpperCase();
  if (c.length !== 4) { toast('Enter the 4-letter room code'); return; }
  connect('private', { code: c });
};
$('#code-in').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });
$('#nick').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-play').click(); });
$('#btn-start').onclick = () => send({ t: 'start', bots: $('#bots-cb').checked });
$('#btn-copy').onclick = async () => {
  const url = new URL(location.href); url.search = '?room=' + S.code;
  try { await navigator.clipboard.writeText(url.href); toast('Invite link copied'); } catch { toast(url.href, 5000); }
};
const goHome = () => { disconnect(); resetGameState(); show('scr-title'); };
$('#btn-leave-lobby').onclick = goHome;
$('#btn-exit').onclick = () => { if (S.phase === 'over' || confirm('Leave this game?')) goHome(); };
$('#btn-home').onclick = goHome;
$('#btn-again').onclick = () => {
  if (S.mode === 'solo') { connect('solo', { practice: true }); return; }
  send({ t: 'again' });
  $('#btn-again').disabled = true;
  $('#btn-again').textContent = 'Waiting for others…';
};
$('#btn-lock').onclick = lockIn;
$('#btn-world').onclick = () => map.fitWorld(true);
$('#btn-skip').onclick = () => { send({ t: 'skip' }); $('#skip-bar').classList.add('hidden'); };
$('#btn-board').onclick = () => $('#board').classList.toggle('open');
$('#btn-mute').onclick = () => { $('#btn-mute').textContent = sfx.toggle() ? '🔇' : '🔊'; };
$('#btn-mute').textContent = sfx.muted ? '🔇' : '🔊';
document.addEventListener('keydown', (e) => {
  if ((e.key === ' ' || e.key === 'Enter') && $('#scr-game').classList.contains('active') && document.activeElement?.tagName !== 'INPUT') { e.preventDefault(); lockIn(); }
});

window.addEventListener('DOMContentLoaded', async () => {
  map = new GuessMap($('#map-host'), { onPin });
  window.__triMap = map;
  map.load().catch(() => toast('Could not load world map'));
  requestAnimationFrame(tick);
  const room = params.get('room');
  if (room) { $('#private-panel').classList.remove('hidden'); $('#code-in').value = room.toUpperCase(); }
  if (STATIC) { $('#btn-private').classList.add('hidden'); $('#private-panel').classList.add('hidden'); }
  if (params.get('auto') === 'solo') connect('solo');
});
