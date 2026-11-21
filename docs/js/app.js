// TRIANGULATE client controller: screens, message handling, HUD.
import { $, $$, h, fmt, toast, banner, makeRing, countUp, confetti, sfx, flip } from './ui/kit.js';
import { WsConnection, LocalConnection, session } from './net.js';
import { ClueCard } from './cluecard.js';
import { GuessMap } from './guessmap.js';
import { STAGE_MULT, elimCount, makeConfig } from '../shared/game/rules.js';
import { localDay, dailyNumber, normalizeMeta, recordGame, levelFor, titleFor, liveStreak, shareText } from '../shared/game/meta.js';

const params = new URLSearchParams(location.search);
const SPEED = Number(params.get('speed')) || 1;

const S = {
  conn: null, mode: null, you: null, code: null, host: null, phase: null,
  players: [], round: 0, rounds: 7, stage: 0, myLock: 0, myPin: null,
  rt: null, // round timing (performance.now based)
  phaseEnd: 0, phaseTotal: 0, reveal: null, elimAfter: false, seenHint: localStorage.getItem('tri.hint') === '1',
  alive: true, lastTick: -1, overEnd: 0,
  daily: null, // 'YYYY-MM-DD' while playing today's daily
  myRounds: [], // my per-round results this game (share grid)
  recorded: false, // XP/streak already recorded for this game
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

// [core] timers for delayed effects (toasts, banners, count-ups): cleared whenever the game state resets
const pendingFx = new Set();
function later(fn, ms) { const t = setTimeout(() => { pendingFx.delete(t); fn(); }, ms); pendingFx.add(t); return t; }
function cancelLater() { for (const t of pendingFx) clearTimeout(t); pendingFx.clear(); }
const isPhone = () => innerWidth <= 760;

// [core] games already recorded for XP/streak (by server game id) — a reload on the results screen
// must not record the same game twice; the share text is kept so the button still works after a reload
const REC_KEY = 'tri.recorded';
function recordedGames() { try { return JSON.parse(sessionStorage.getItem(REC_KEY) || '{}'); } catch { return {}; } }
function markRecorded(gid, data) {
  try {
    const all = recordedGames(); all[gid] = data;
    const keys = Object.keys(all); for (const k of keys.slice(0, Math.max(0, keys.length - 20))) delete all[k];
    sessionStorage.setItem(REC_KEY, JSON.stringify(all));
  } catch { /* private mode */ }
}

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
    // daily: same seed for everyone on the same local date -> same 5 clues (room uses a separate clue RNG)
    const dailyDone = !!loadMeta().daily.results[localDay()];
    S.daily = extra.practice || dailyDone ? null : localDay();
    const seed = S.daily ? 'daily-' + S.daily : 'practice-' + Math.random();
    S.conn = new LocalConnection({ name: nick(), seed, speed: SPEED });
    S.conn.onmessage = onMsg;
    S.conn.ready.catch((e) => { toast('Could not load solo pack: ' + e.message); show('scr-title'); });
    setConn('');
  } else {
    // 'resume' = rejoin the seat saved in sessionStorage (page reload / tab killed by a mobile browser)
    const join = kind === 'resume'
      ? { t: 'join', resume: true, name: extra.name || nick(), mode: extra.mode, token: extra.token, code: extra.code }
      : { t: 'join', name: nick(), mode: kind, code: extra.code };
    let opened = false;
    S.conn = new WsConnection(join, {
      onStatus: (st, info) => {
        if (st === 'open') opened = true;
        if (st === 'reconnecting') setConn('reconnecting…');
        if (st === 'restarting') setConn('server restarting…');
        if (st === 'reconnected' || st === 'open') setConn('');
        if (st === 'replaced') { toast('This game is open in another tab.', 3500); goHome(); }
        if (st === 'failed') {
          setConn('offline');
          toast(info?.reason ? info.reason : opened ? 'Connection lost.' : 'Can’t reach the server — try Daily solo!', 4000);
          disconnect(); resetGameState(); show('scr-title');
        }
      },
    });
    S.conn.onmessage = onMsg;
  }
  showLobbyLoading(kind === 'resume' ? extra.mode : kind);
}
function disconnect() { if (S.conn) { S.conn.close(); S.conn = null; } }
function setConn(t) { $('#conn-state').textContent = t; }
function send(m) { S.conn?.send(m); }

function showLobbyLoading(kind) {
  if (kind === 'solo') { show('scr-game'); prepareRoundUi(); return; }
  $('#lobby-kind').textContent = kind === 'public' ? 'Public match' : 'Private room';
  $('#lobby-title').textContent = kind === 'resume' || session.load() ? 'Rejoining…' : 'Connecting…';
  $('#lobby-players').replaceChildren();
  $('#lobby-ms').textContent = '–';
  show('scr-lobby');
}

function resetGameState() {
  cancelLater();
  Object.assign(S, { you: null, phase: null, players: [], round: 0, stage: 0, myLock: 0, myPin: null, rt: null, reveal: null, alive: true, myRounds: [], recorded: false, shareText: null, toldSpec: false, gid: null, seenLobby: false, host: null });
  $('#over-sub') && ($('#over-sub').textContent = '');
  $('#skip-bar').classList.add('hidden');
  $('#spec-chip').classList.add('hidden');
}

// ------------------------------------------------------------------ messages
function onMsg(m) {
  switch (m.t) {
    case 'welcome': S.you = m.you; S.code = m.code; S.mode = m.mode; break;
    case 'snap': applySnap(m); break;
    case 'players':
      S.players = m.players;
      if (m.host && m.host !== S.host) { S.host = m.host; if (S.phase === 'lobby') updateLobbyControls(); if (m.host === S.you && S.mode === 'private') toast('👑 You are now the host', 2200); }
      renderPlayers();
      break;
    case 'lobby': onLobby(m); break;
    case 'server': toast(m.msg || 'Server notice', 5000); break;
    case 'intro': onIntro(m); break;
    case 'round': onRound(m); break;
    case 'stage': onStage(m); break;
    case 'lock': break;
    case 'locked': onLocked(m); break;
    case 'ending': if (S.alive) toast('Everyone locked in!', 1200); setPhaseTimer(m.ms || 0); if (S.rt) S.rt.end = performance.now() + (m.ms || 0); break;
    case 'reveal': onReveal(m); break;
    case 'standings': onStandings(m); break;
    case 'over': onOver(m); break;
    case 'error':
      toast(m.code === 'expired' ? 'That game has ended — jump into a new one!' : m.msg || 'Error', 3500);
      if (['noroom', 'expired', 'full', 'busy', 'restarting', 'bad'].includes(m.code)) { disconnect(); resetGameState(); show('scr-title'); refreshTitleMeta(); }
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
  if (Array.isArray(m.hist)) S.myRounds = m.hist.map((x) => x || null);
  if (m.phase === 'lobby') { onLobby({ ms: m.ms, host: m.host, code: m.code, mode: m.mode }); return; }
  show('scr-game');
  setSpectator(!S.alive);
  // late join into a running private game: you watch until the next game starts
  if (me?.spec && !S.toldSpec) { S.toldSpec = true; toast('Game in progress — you’re spectating and will join the next game.', 4000); }
  if (m.intro) { S.round = m.intro.round; S.elimAfter = m.intro.elimAfter; $('#round-chip').textContent = (innerWidth < 500 ? 'R' : 'Round ') + `${m.intro.round}/${m.intro.rounds}`; }
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
  } else if (m.phase === 'over' && m.ranking) onOver({ ranking: m.ranking, ms: m.ms, rounds: m.played, gid: m.gid }, true);
  else if (m.phase === 'intro') { prepareRoundUi(); setPhaseTimer(m.ms); }
  renderPlayers();
}

// ------------------------------------------------------------------ lobby
function onLobby(m) {
  const wasHost = S.host === S.you;
  S.phase = 'lobby'; S.host = m.host; S.code = m.code; S.lobbyMode = m.mode; S.lobbyMs = m.ms || 0;
  Object.assign(S, { toldSpec: false, alive: true, myRounds: [], recorded: false, shareText: null, gid: null, myLock: 0, myPin: null });
  cancelLater();
  setSpectator(false);
  $('#btn-again').disabled = false; $('#btn-again').textContent = 'Play again';
  if (S.mode === 'solo') return;
  if (!wasHost && m.host === S.you && S.you && m.mode === 'private' && S.seenLobby) toast('👑 You are now the host', 2200);
  S.seenLobby = true;
  show('scr-lobby');
  updateLobbyControls();
  setPhaseTimer(m.ms || 0);
  if (!m.ms) $('#lobby-ms').textContent = '…';
  renderPlayers();
}

/** Lobby title/buttons depend on who is host — re-run on host migration. */
function updateLobbyControls() {
  const priv = S.lobbyMode === 'private';
  const counting = !!S.lobbyMs;
  $('#lobby-kind').textContent = priv ? 'Private room' : 'Public match';
  $('#lobby-title').textContent = priv ? (counting ? 'Get ready!' : 'Waiting for host…') : 'Finding players…';
  $('#lobby-code-row').classList.toggle('hidden', !priv);
  $('#lobby-code').textContent = S.code;
  const isHost = S.host === S.you;
  $('#btn-start').classList.toggle('hidden', !(priv && isHost && !counting));
  $('#bots-toggle').classList.toggle('hidden', !(priv && isHost && !counting));
  if (priv && isHost && !counting) $('#lobby-title').textContent = 'Invite friends, then start';
}

function renderLobbyPlayers() {
  const box = $('#lobby-players');
  const have = new Set($$('.lp', box).map((e) => e.dataset.key));
  const want = new Set(S.players.map((p) => p.id));
  for (const e of $$('.lp', box)) if (!want.has(e.dataset.key)) e.remove();
  for (const p of S.players) {
    if (have.has(p.id)) {
      const row = box.querySelector(`.lp[data-key="${CSS.escape(p.id)}"]`);
      const crown = row?.querySelector('.host-crown');
      if (row && p.host && !crown) row.append(h('span', { class: 'host-crown', title: 'host' }, '👑'));
      if (row && !p.host && crown) crown.remove();
      continue;
    }
    const hue = [...p.name].reduce((a, c) => a + c.charCodeAt(0), 0) * 47 % 360;
    box.append(h('div', { class: 'lp' + (p.id === S.you ? ' me' : ''), 'data-key': p.id },
      h('span', { class: 'av', style: { background: `hsl(${hue} 80% 65%)` } }, (Array.from(p.name)[0] || '?').toUpperCase()),
      h('span', { class: 'nm' }, p.name), p.bot ? h('span', { class: 'tag-bot' }, '🤖 BOT') : null,
      p.host ? h('span', { class: 'host-crown', title: 'host' }, '👑') : null));
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
  const sub = m.elimAfter ? `⚠ Bottom ${m.cut || 'quarter'} eliminated after this round` : m.round === m.rounds ? 'Final round!' : `${m.km} km window`;
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
    // Latin-script countries show their own local names: no script hint (it would only say "Latin")
    if (m.data.script === 'Latin') t.innerHTML = '🏷 <b>Local place names</b>';
    else t.innerHTML = `Names in local script: <b>${m.data.script}</b>`;
    t.classList.remove('hidden');
    styleTerrainLabels();
  }
  if (!silent) { if (m.i > 1) sfx.stage(); }
  updateLockBtn();
}

// [core] fallback until cluecard.js renders clue-format-v2 stage-1 borders itself (see REQUESTS-core.md)
function drawBordersFallback(paths) {
  const host = card.L?.coast || card.layers?.coast;
  if (!host) return;
  for (const d of paths) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'none');
    p.setAttribute('class', 'border-fallback');
    p.setAttribute('style', 'stroke:var(--m-border,#f5a3c7);stroke-width:2.6;stroke-dasharray:10 7;opacity:.85;stroke-linecap:round');
    host.prepend(p);
  }
}

// [core] terrain labels (islands, ranges, deserts: kind 'g') read as regions, not towns, until cluecard styles them
function styleTerrainLabels() {
  for (const t of $$('#clue-frame .lab-g text')) {
    if (t.dataset.styled) continue;
    t.dataset.styled = '1';
    t.style.letterSpacing = '.12em';
    t.style.fontWeight = '600';
    t.style.fillOpacity = '.78';
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
  send({ t: 'pin', lat, lon, round: S.round });
  sfx.pin();
  if (!S.seenHint) { S.seenHint = true; localStorage.setItem('tri.hint', '1'); $('#hint').classList.add('hidden'); }
  updateLockBtn();
}

function lockIn() {
  if (S.phase !== 'round' || S.myLock || !S.myPin || !S.alive) return;
  send({ t: 'lock', lat: S.myPin.lat, lon: S.myPin.lon, round: S.round });
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
  card.showAnswer(m.answer.name, m.answer); // [visuals] also un-redacts the clue's coordinates
  const at = $('#answer-tag');
  at.textContent = '📍 ' + m.answer.name;
  at.classList.remove('hidden');
  const res = $('#result');
  $('#res-place').replaceChildren(h('span', {}, m.answer.name), h('small', {}, countryName(m.answer.cc)));
  if (mine) S.myRounds[m.round - 1] = { d: mine.d, bull: !!mine.bull, stage: mine.stage, pts: mine.pts };
  if (mine && S.alive) {
    $('#res-dist').textContent = mine.d == null ? 'no guess' : fmt(mine.d) + ' km';
    $('#res-mult').textContent = mine.stage ? '×' + STAGE_MULT[mine.stage - 1].toFixed(1) : '–';
    $('#res-pts').textContent = '+0';
    if (silent) $('#res-pts').textContent = '+' + fmt(mine.pts);
    else later(() => { countUp($('#res-pts'), mine.pts, { prefix: '+', ms: 1100 }); sfx.reveal(); }, 900);
    // bullseye / streak bonus moment (guess landed inside the clue window)
    if (mine.bull && !silent) {
      later(() => toast(`🎯 Bullseye! +${fmt(mine.bonus)}` + (mine.streak > 1 ? ` · 🔥 ${mine.streak} in a row` : ''), 2200), 2100);
    }
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
      const close = (m.close || []).find((c) => c.id === S.you);
      if (S.alive && close) {
        // scraped through: make it a moment
        later(() => { banner('CLOSE CALL', `Survived by just ${fmt(close.margin)} pts`, { ms: 1900, color: '#ffcc4d', cls: 'close-call' }); sfx.stage(); }, 400);
      } else if (S.alive && S.mode) later(() => toast('You survived ✅', 1500), 500);
    }
  }
  if (innerWidth <= 1100) later(() => { if (S.phase === 'standings') $('#board').classList.add('open'); }, elim.has(S.you) ? 2700 : 0);
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
    $('#my-score').textContent = me.spec || rank < 1 ? '👁 watching' : `#${rank} · ${fmt(me.total)}`;
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
function onOver(m, silent = false) {
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
  $('#over-sub').textContent = '';
  const meP = S.players.find((p) => p.id === S.you);
  if (meP?.ready && S.mode !== 'solo') { $('#btn-again').disabled = true; $('#btn-again').textContent = 'Waiting…'; }
  if (!silent) { if (won) { confetti(); sfx.win(); later(() => confetti({ count: 120 }), 900); } else sfx.reveal(); }
  S.gid = m.gid || null;
  showMetaResult(r, meIdx, m.rounds || S.rounds, m.gid);
}

// ------------------------------------------------------------------ meta: XP / level / daily streak / share
// [core] DOM for these is created here (index.html belongs to the visuals session); classes: .meta-row,
// .meta-xp, .meta-bar, #btn-share, #title-meta — see REQUESTS-core.md for styling.
const META_KEY = 'tri.meta';
function loadMeta() { try { return normalizeMeta(JSON.parse(localStorage.getItem(META_KEY) || 'null')); } catch { return normalizeMeta(null); } }
function saveMeta(m) { try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch { /* storage full / private mode */ } }

function showMetaResult(ranking, meIdx, roundsPlayed, gid) {
  let row = $('#over-meta');
  if (!row) {
    row = h('div', { id: 'over-meta', class: 'meta-row', style: { margin: '6px 0 2px', fontSize: '14px', opacity: '.92', textAlign: 'center' } });
    $('#over-me').after(row);
  }
  let shareBtn = $('#btn-share');
  if (!shareBtn) {
    shareBtn = h('button', { id: 'btn-share', class: 'btn', type: 'button' }, '📋 Share result');
    $('#btn-again').after(shareBtn);
  }
  if (meIdx < 0) { shareBtn.classList.add('hidden'); row.replaceChildren(); return; }
  if (S.recorded) { shareBtn.classList.toggle('hidden', !S.shareText); return; }
  S.recorded = true;
  row.replaceChildren();
  const prev = gid ? recordedGames()[gid] : null;
  if (prev) { // this game was already recorded in this tab (page reload on the results screen)
    row.textContent = prev.row || '';
    S.shareText = prev.text;
    shareBtn.classList.toggle('hidden', !prev.text);
    shareBtn.onclick = () => copyText(prev.text);
    return;
  }
  const me = ranking[meIdx];
  const rounds = Array.from({ length: roundsPlayed }, (_, i) => S.myRounds[i] || null);
  const res = recordGame(loadMeta(), {
    rank: meIdx + 1, players: ranking.length, total: me.total, won: meIdx === 0,
    roundsPlayed: rounds.filter(Boolean).length, bulls: rounds.filter((x) => x?.bull).length,
    daily: !!S.daily && S.mode === 'solo', grid: rounds.map((x) => (x ? [x.d, x.bull ? 1 : 0, x.stage] : null)),
  }, S.daily || localDay());
  saveMeta(res.meta);
  const lv = res.after;
  const nw = { whiteSpace: 'nowrap' };
  row.append(
    h('span', { class: 'meta-xp', style: nw }, `+${res.gained} XP`), ' · ',
    h('span', { style: nw }, h('b', {}, `Lv ${lv.level} ${titleFor(lv.level)}`), ' ',
    h('span', { class: 'meta-bar', title: `${lv.into}/${lv.need} XP`, style: { display: 'inline-block', width: '90px', height: '6px', borderRadius: '3px', background: 'rgba(255,255,255,.15)', verticalAlign: 'middle', overflow: 'hidden' } },
      h('span', { style: { display: 'block', height: '100%', width: (lv.frac * 100).toFixed(0) + '%', background: 'linear-gradient(90deg,#5ce1e6,#7c6cff)' } }))),
    res.dailyFirst ? ' · ' : '', res.dailyFirst ? h('span', { style: { whiteSpace: 'nowrap' } }, `🔥 ${res.streak}-day streak`) : '');
  if (res.levelUp) {
    // phones: the banner would cover the very XP row it celebrates -> toast + highlight instead
    if (isPhone()) later(() => { toast(`⬆ Level ${lv.level} — ${titleFor(lv.level)}`, 2600); row.animate?.([{ transform: 'scale(1)' }, { transform: 'scale(1.08)' }, { transform: 'scale(1)' }], { duration: 600 }); }, 1400);
    else later(() => banner('LEVEL UP', `Level ${lv.level} — ${titleFor(lv.level)}`, { ms: 1800, color: '#5ce1e6' }), 1600);
  }
  const text = shareText({
    daily: !!S.daily && S.mode === 'solo', day: S.daily || localDay(), rank: meIdx + 1, players: ranking.length,
    total: me.total, rounds, streak: res.dailyFirst ? res.streak : liveStreak(res.meta), url: location.origin + location.pathname,
  });
  S.shareText = text;
  if (gid) markRecorded(gid, { text, row: row.textContent });
  shareBtn.classList.remove('hidden');
  shareBtn.onclick = () => copyText(text);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Result copied — paste it anywhere 📋'); return; } catch { /* fall back */ }
  const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
  ta.value = text; document.body.append(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch { /* ignore */ }
  ta.remove();
  toast(ok ? 'Result copied 📋' : text, ok ? 2200 : 6000);
}

function refreshTitleMeta() {
  const meta = loadMeta();
  let el = $('#title-meta');
  if (!el) {
    el = h('div', { id: 'title-meta', class: 'meta-row', style: { fontSize: '13px', opacity: '.85', margin: '-4px 0 10px', textAlign: 'center' } });
    $('.nick-row')?.after(el);
  }
  const lv = levelFor(meta.xp);
  const streak = liveStreak(meta);
  const today = localDay();
  const done = !!meta.daily.results[today];
  const parts = meta.games
    ? [`Lv ${lv.level} ${titleFor(lv.level)}`, `${meta.wins} win${meta.wins === 1 ? '' : 's'}`, streak ? `🔥 ${streak}-day streak` : '', done ? `Daily #${dailyNumber(today)} ✓` : '']
    : [`Daily #${dailyNumber(today)} is live`];
  el.replaceChildren();
  parts.filter(Boolean).forEach((p, i) => { if (i) el.append(' · '); el.append(h('span', { style: { whiteSpace: 'nowrap' } }, p)); });
  const solo = $('#btn-solo');
  if (solo) {
    solo.dataset.label ||= solo.textContent;
    solo.textContent = done ? '☀ Practice' : solo.dataset.label;
    solo.title = done ? 'Today’s daily is done — play a practice run (new daily tomorrow)' : '';
  }
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
    if (s <= 5 && s > 0 && s !== S.lastTick && !S.myLock && S.alive) { S.lastTick = s; sfx.tick(s); } // [visuals] pitch rises as time runs out
    $$('#stagebar .seg').forEach((seg) => {
      const i = +seg.dataset.i;
      const a = S.rt.stageT[i - 1], b = Math.max(a + 1, i < 4 ? S.rt.stageT[i] : S.rt.end);
      const f = i > S.stage ? 0 : Math.max(0, Math.min(1, (now - a) / (b - a)));
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
function goHome() { disconnect(); resetGameState(); setConn(''); show('scr-title'); refreshTitleMeta(); }
$('#btn-leave-lobby').onclick = goHome;
$('#btn-exit').onclick = () => { if (S.phase === 'over' || confirm('Leave this game?')) goHome(); };
$('#btn-home').onclick = goHome;
$('#btn-again').onclick = () => {
  if (S.mode === 'solo') { connect('solo', { practice: true }); return; }
  send({ t: 'again' });
  $('#btn-again').disabled = true;
  $('#btn-again').textContent = 'Waiting…';
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
  refreshTitleMeta();
  if (params.get('auto') === 'solo') connect('solo');
  else if (!STATIC) {
    // page reload mid-game: rejoin the same seat (sessionStorage survives reloads, not new tabs)
    const sv = session.load();
    if (sv && (!room || room.toUpperCase() === sv.code)) connect('resume', sv);
  }
});
