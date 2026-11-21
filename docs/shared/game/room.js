// Authoritative TRIANGULATE room engine. Transport-agnostic: runs on the Node server (WebSocket)
// and in the browser for SOLO / static mode. All answers stay inside this object until reveal.
import { Scheduler } from '../kit/scheduler.js';
import { makeRng } from '../kit/rng.js';
import { distanceKm } from '../kit/geo.js';
import { makeBot } from '../kit/bots.js';
import {
  makeConfig, elimCount, isElimRound, planBotGuess, pickClue, roundPoints, botSkill, clueRating, CLOSE_CALL_PTS,
} from './rules.js';

const LOBBY_DROP_GRACE_MS = 20000;
let uid = 0;
const newId = (p) => p + (++uid).toString(36) + Math.floor(Math.random() * 1296).toString(36);
/** Unguessable session token (128 bit). Works in browsers and Node >= 19 (globalThis.crypto). */
export function newToken() {
  const b = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export class TriangulateRoom {
  /**
   * @param {object} o
   * @param {string} o.code       room code
   * @param {'public'|'private'|'solo'} o.mode
   * @param {object} o.clues      { list(): meta[], load(id): Promise<clue> }  meta = {id, lat, lon, name, cc, diff, rating, km}
   * @param {(pid:string, msg:object)=>void} o.send
   * @param {number} [o.speed]    time multiplier (tests)
   * @param {string|number} [o.seed] RNG seed. Clue order uses its own stream (seed + ':clues') so a daily
   *                              seed gives every player the same clues whatever the bots/eliminations do.
   * @param {object} [o.config]   overrides
   */
  constructor({ code, mode = 'public', clues, send, speed = 1, seed, config = {}, onEmpty = () => {}, log = () => {} }) {
    this.code = code; this.mode = mode; this.clues = clues; this._send = send;
    this.cfg = makeConfig(mode, config);
    const s = seed ?? Math.floor(Math.random() * 2 ** 32);
    this.rng = makeRng(s);
    this.clueRng = makeRng(String(s) + ':clues');
    this.sched = new Scheduler({ speed });
    this.onEmpty = onEmpty; this.log = log;
    this.players = new Map();
    this.joinSeq = 0;
    this.phase = 'lobby';
    this.round = 0;
    this.used = new Set();
    this.hostId = null;
    this.phaseEnd = 0; // virtual time
    this.disposed = false;
    this.games = 0;
    this.uid = newToken().slice(0, 8);
    this.clueLog = []; // [{round, id, rating}] of the current game (tests + daily share)
    this._playersDirty = false;
  }

  // ------------------------------------------------------------ helpers
  get list() { return [...this.players.values()]; }
  humans() { return this.list.filter((p) => !p.bot); }
  connectedHumans() { return this.list.filter((p) => !p.bot && p.conn); }
  alive() { return this.list.filter((p) => p.alive); }
  send(p, msg) { if (!p.bot && p.conn) this._send(p.id, msg); }
  broadcast(msg) { for (const p of this.players.values()) this.send(p, msg); }
  ms(vt) { return Math.round(this.sched.realUntil(vt)); }
  setPhase(phase, durMs) {
    this.phase = phase;
    this.phaseEnd = durMs != null ? this.sched.vnow() + durMs : 0;
  }
  publicPlayer(p) {
    return {
      id: p.id, name: p.name, bot: !!p.bot, alive: p.alive, total: p.total, last: p.last, conn: p.bot ? true : p.conn,
      lock: this.phase === 'round' ? p.lock : 0, elim: p.elimRound || 0, spec: !!p.spec, host: p.id === this.hostId,
      streak: p.streak || 0, ready: !!p.ready,
    };
  }
  playersMsg() { return { t: 'players', players: this.list.map((p) => this.publicPlayer(p)), host: this.hostId }; }
  markPlayers() {
    if (this._playersDirty) return;
    this._playersDirty = true;
    queueMicrotask(() => { this._playersDirty = false; if (!this.disposed) this.broadcast(this.playersMsg()); });
  }

  // ------------------------------------------------------------ membership
  canJoinPublic() {
    return this.phase === 'lobby' && !this.disposed && this.humans().length < this.cfg.maxPlayers &&
      (!this.phaseEnd || this.ms(this.phaseEnd) > 2500);
  }

  /** Private rooms accept late joiners (they spectate until the next game) up to the player cap. */
  canJoinPrivate() {
    return !this.disposed && this.humans().filter((p) => !p.left).length < this.cfg.maxPlayers;
  }

  addHuman({ name, preSend }) {
    const lobby = this.phase === 'lobby';
    const p = {
      id: newId('p'), token: newToken(), name: sanitizeName(name), bot: false, conn: true,
      alive: lobby, spec: !lobby, total: 0, last: 0, lock: 0, guess: null, streak: 0,
      elimRound: 0, join: ++this.joinSeq, ready: false, hist: [],
    };
    // bots make way for humans: every human joining a public lobby replaces one bot
    if (this.mode === 'public' && lobby) this.removeOneBot();
    this.players.set(p.id, p);
    if (preSend) preSend(p.id);
    if (!this.hostId || !this.players.get(this.hostId)?.conn) this.setHost(p.id);
    this.log(`[${this.code}] + ${p.name}${p.spec ? ' (spectating)' : ''} (${this.connectedHumans().length} humans)`);
    this.sendWelcome(p);
    this.markPlayers();
    if (lobby) this.onLobbyJoin();
    return p;
  }

  setHost(id) {
    if (this.hostId === id) return;
    this.hostId = id;
    if (this.phase === 'lobby' && this.mode !== 'solo') this.broadcastLobby();
    this.markPlayers();
  }

  sendWelcome(p) {
    this._send(p.id, { t: 'welcome', you: p.id, token: p.token, code: this.code, mode: this.mode });
    this._send(p.id, this.snapshot(p));
  }

  findByToken(token) {
    if (typeof token !== 'string' || token.length < 8) return null;
    return this.list.find((x) => !x.bot && x.token === token && !x.left) || null;
  }

  reconnect(token) {
    const p = this.findByToken(token);
    if (!p) return null;
    p.conn = true;
    clearTimeout(p._dropTimer);
    clearTimeout(this._emptyTimer);
    // host migration: an orphaned room gets its returning player as host
    if (!this.hostId || !this.players.get(this.hostId)?.conn) this.setHost(p.id);
    this.log(`[${this.code}] ~ ${p.name} reconnected`);
    this.sendWelcome(p);
    this.markPlayers();
    if (this.phase === 'lobby') this.onLobbyJoin(); // restart a public countdown that stopped while empty
    return p;
  }

  disconnect(pid, { leave = false } = {}) {
    const p = this.players.get(pid);
    if (!p) return;
    p.conn = false;
    if (leave) {
      p.left = true;
      if (this.phase !== 'lobby' && this.phase !== 'over' && p.alive) { p.alive = false; p.elimRound = Math.max(1, this.round); p.forfeit = true; }
    }
    if ((this.phase === 'lobby' && leave) || (leave && p.spec)) this.players.delete(pid);
    else if (this.phase === 'lobby') {
      // network blip in the lobby: keep the seat (and host role) for a while so a reconnect resumes it
      clearTimeout(p._dropTimer);
      p._dropTimer = setTimeout(() => {
        if (!p.conn && this.phase === 'lobby' && this.players.get(pid) === p) { this.players.delete(pid); this.markPlayers(); }
      }, LOBBY_DROP_GRACE_MS);
      p._dropTimer.unref?.();
    }
    // host migration: hand the room to the longest-present connected human
    if (this.hostId === pid) {
      const next = this.connectedHumans().sort((a, b) => a.join - b.join)[0];
      this.hostId = null;
      if (next) this.setHost(next.id);
    }
    this.log(`[${this.code}] - ${p.name}${leave ? ' left' : ' dropped'} (${this.connectedHumans().length} humans left)`);
    this.markPlayers();
    if (!this.connectedHumans().length) {
      if (this.phase === 'lobby') { this.sched.clear(); this.removeAllBots(); this.setPhase('lobby'); }
      this.onEmpty(this);
    } else if (this.phase === 'round') this.checkAllLocked();
    else if (this.phase === 'over') this.checkAllReady();
  }

  removeOneBot() {
    const bots = this.list.filter((p) => p.bot).sort((a, b) => b.join - a.join);
    if (bots[0]) this.players.delete(bots[0].id);
  }
  removeAllBots() { for (const p of this.list) if (p.bot) this.players.delete(p.id); }
  addBot() {
    const taken = new Set(this.list.map((p) => p.name));
    const b = makeBot(this.rng, newId('b'), taken);
    b.profile.skill = botSkill(this.rng);
    Object.assign(b, { alive: true, total: 0, last: 0, lock: 0, guess: null, streak: 0, elimRound: 0, join: ++this.joinSeq });
    this.players.set(b.id, b);
    this.markPlayers();
    return b;
  }

  // ------------------------------------------------------------ lobby
  onLobbyJoin() {
    if (this.mode === 'solo') {
      if (this.phase === 'lobby' && !this._soloStarted) { this._soloStarted = true; this.sched.after(400, () => this.beginGame(), 'lobby'); }
      return;
    }
    if (this.mode === 'public' && !this.phaseEnd) this.startLobbyCountdown(this.cfg.lobbyMs);
    this.broadcastLobby();
  }

  startLobbyCountdown(ms) {
    this.sched.cancel('lobby');
    this.setPhase('lobby', ms);
    this.sched.after(ms, () => this.beginGame(), 'lobby');
    // bots trickle in so the room feels alive; final fill happens at start
    if (this.cfg.fillBots) {
      const target = Math.floor(this.cfg.maxPlayers * 0.75);
      const n = Math.max(0, target - this.list.length);
      for (let i = 0; i < n; i++) {
        this.sched.after(((i + 1) / (n + 1)) * ms * 0.85 + this.rng() * 300, () => {
          if (this.phase === 'lobby' && this.list.length < this.cfg.maxPlayers - 1) this.addBot();
        }, 'lobby');
      }
    }
    this.broadcastLobby();
  }

  broadcastLobby() {
    this.broadcast({ t: 'lobby', ms: this.phaseEnd ? this.ms(this.phaseEnd) : 0, host: this.hostId, code: this.code, mode: this.mode });
  }

  resetForNewGame() {
    for (const p of this.list) {
      if (p.bot || !p.conn) { this.players.delete(p.id); continue; }
      Object.assign(p, { alive: true, spec: false, total: 0, last: 0, lock: 0, guess: null, streak: 0, elimRound: 0, ready: false, hist: [], forfeit: false });
    }
    this.round = 0; this.used.clear(); this._soloStarted = false; this.clueLog = []; this._loadFails = 0;
    this.setPhase('lobby');
    this.reveal = null; this.ranking = null; this.clue = null;
    if (!this.players.get(this.hostId)?.conn) { this.hostId = null; const h = this.connectedHumans().sort((a, b) => a.join - b.join)[0]; if (h) this.hostId = h.id; }
  }

  backToLobby(quick = false) {
    this.sched.clear();
    this.resetForNewGame();
    if (!this.connectedHumans().length) { this.onEmpty(this); return; }
    if (this.mode === 'public') this.startLobbyCountdown(quick ? 6000 : this.cfg.lobbyMs);
    else this.broadcastLobby();
    this.broadcast(this.playersMsg());
  }

  // ------------------------------------------------------------ game flow
  beginGame() {
    if (this.disposed || this.phase !== 'lobby') return;
    if (this.draining) { // server is restarting: don't start new games, and say so
      this.setPhase('lobby'); this.broadcastLobby();
      this.broadcast({ t: 'server', code: 'restarting', msg: 'Server is restarting — new games start again in a moment.' });
      return;
    }
    this.sched.cancel('lobby');
    // humans who dropped in the lobby and never came back don't get a seat in the game
    for (const p of this.list) if (!p.bot && !p.conn) { clearTimeout(p._dropTimer); this.players.delete(p.id); }
    if (!this.connectedHumans().length) { this.setPhase('lobby'); return; }
    if (this.cfg.fillBots) {
      const target = this.mode === 'private' ? Math.max(8, this.list.length) : this.cfg.maxPlayers;
      while (this.list.length < target) this.addBot();
    }
    this.games++;
    this.log(`[${this.code}] game start with ${this.list.length} players`);
    this.startRound(1);
  }

  pickClue() {
    const meta = pickClue(this.clueRng, this.clues.list(), this.used, this.round, this.cfg.rounds);
    this.used.add(meta.id);
    return meta;
  }

  async startRound(n) {
    this.round = n;
    this.reveal = null;
    const meta = this.pickClue();
    for (const p of this.list) { p.lock = 0; p.guess = null; p.plan = null; p.last = 0; }
    this.setPhase('intro', this.cfg.introMs);
    const introEnd = this.phaseEnd;
    this.broadcast({ t: 'intro', round: n, rounds: this.cfg.rounds, ms: this.ms(introEnd), km: meta.km, elimAfter: isElimRound(this.cfg, n), cut: this.cutPreview(n) });
    this.markPlayers();
    let clue;
    try { clue = await this.clues.load(meta.id); } catch (e) {
      this.log('clue load failed', meta.id, e.message);
      if (this.disposed) return;
      this._loadFails = (this._loadFails || 0) + 1;
      if (this._loadFails > 5) { this.log(`[${this.code}] giving up: clue source failing`); this.gameOver(); return; }
      return this.startRound(n);
    }
    if (this.disposed || this.round !== n || this.phase !== 'intro') return;
    this._loadFails = 0;
    this.clue = { meta, data: clue };
    this.clueLog.push({ round: n, id: meta.id, rating: clueRating(meta) });
    this.sched.after(Math.max(0, introEnd - this.sched.vnow()), () => this.beginStages(), 'phase');
  }

  /** How many players will be cut after round n (0 if none) — shown in the intro banner. */
  cutPreview(n) { return isElimRound(this.cfg, n) ? elimCount(this.cfg, this.alive().length) : 0; }

  beginStages() {
    const c = this.cfg;
    this.setPhase('round', c.roundMs);
    this.roundStart = this.sched.vnow();
    this.stage = 1;
    this._endingEarly = false;
    const m = this.clue.meta;
    for (const p of this.alive()) if (p.bot) {
      p.plan = planBotGuess(this.rng, p.profile, { lat: m.lat, lon: m.lon, diff: m.diff, rating: m.rating, km: m.km }, c);
      this.sched.after(p.plan.lockAt, () => this.botLock(p), 'bots');
    }
    this.broadcast(this.roundMsg());
    this.broadcast({ t: 'stage', i: 1, data: this.stageData(1) });
    for (let s = 2; s <= 4; s++) {
      this.sched.after(c.stageAt[s - 1], () => {
        this.stage = s;
        this.broadcast({ t: 'stage', i: s, data: this.stageData(s), ms: this.ms(this.phaseEnd) });
      }, 'phase');
    }
    this.sched.after(c.roundMs, () => this.endRound(), 'phase');
    this.markPlayers();
    this.checkAllLocked(); // e.g. every human is a spectator or disconnected
  }

  roundMsg() {
    const c = this.cfg;
    return {
      t: 'round', round: this.round, rounds: c.rounds, km: this.clue.meta.km,
      ms: this.ms(this.phaseEnd),
      stageMs: c.stageAt.map((a) => this.ms(this.roundStart + a)),
      totalMs: Math.round(c.roundMs / this.sched.speed),
      elimAfter: isElimRound(c, this.round),
    };
  }

  stageData(s) {
    const d = this.clue.data;
    if (s === 1) return { km: d.km, ...d.s1 };
    return d['s' + s];
  }

  botLock(p) {
    if (this.phase !== 'round' || !p.alive || p.lock) return;
    p.lock = p.plan.stage;
    p.guess = { lat: p.plan.lat, lon: p.plan.lon };
    this.broadcast({ t: 'lock', id: p.id, stage: p.lock });
    this.markPlayers();
  }

  checkAllLocked() {
    if (this.phase !== 'round' || this._endingEarly) return;
    // wait for every living human who hasn't left — connected or not (a blip must not cut the round short)
    const hs = this.alive().filter((p) => !p.bot && !p.left);
    if (hs.some((p) => !p.lock)) return;
    // nobody left to wait for (all humans locked, or none alive+connected): wrap up quickly.
    // Bots keep their planned outcome; with no living humans the round still plays out briefly.
    const wait = hs.length ? 1400 : Math.min(6000, this.cfg.roundMs);
    this._endingEarly = true;
    this.sched.cancel('phase');
    this.sched.cancel('bots');
    // bots that would have locked during the remaining time lock now (keeps lock icons consistent)
    for (const p of this.alive()) if (p.bot && !p.lock && p.plan) this.sched.after(Math.min(wait - 200, 300 + this.rng() * (wait - 500)), () => this.botLock(p), 'bots');
    if (!hs.length) {
      // spectators-only room: still reveal stages quickly so watchers see the whole clue
      for (let s = this.stage + 1; s <= 4; s++) {
        this.sched.after(((s - this.stage) / (5 - this.stage)) * (wait - 400), () => {
          this.stage = s; this.broadcast({ t: 'stage', i: s, data: this.stageData(s), ms: this.ms(this.phaseEnd) });
        }, 'phase');
      }
    }
    this.sched.after(wait, () => this.endRound(), 'phase');
    this.setPhase('round', wait);
    this.broadcast({ t: 'ending', ms: this.ms(this.phaseEnd) });
  }

  endRound() {
    if (this.phase !== 'round') return;
    this._endingEarly = false;
    this.sched.cancel('phase'); this.sched.cancel('bots');
    const { meta } = this.clue;
    const results = [];
    for (const p of this.alive()) {
      if (p.bot && !p.lock && p.plan) { p.lock = p.plan.stage; p.guess = { lat: p.plan.lat, lon: p.plan.lon }; }
      if (!p.bot && p.guess && !p.lock) p.lock = 4; // un-locked pin counts at stage 4
      let d = null;
      if (p.guess) d = distanceKm(p.guess.lat, p.guess.lon, meta.lat, meta.lon);
      const r = roundPoints(d, p.lock, meta.km, p.streak || 0);
      p.last = r.pts; p.total += r.pts; p.streak = r.streak;
      if (!p.bot) (p.hist ||= [])[this.round - 1] = { d: d == null ? null : Math.round(d), bull: r.bull, stage: p.lock || 0, pts: r.pts };
      results.push({
        id: p.id, lat: p.guess?.lat ?? null, lon: p.guess?.lon ?? null, d: d == null ? null : Math.round(d),
        stage: p.lock || 0, pts: r.pts, base: r.base, bonus: r.bonus, bull: r.bull, streak: r.streak,
      });
    }
    results.sort((a, b) => b.pts - a.pts);
    this.reveal = {
      t: 'reveal', round: this.round, rounds: this.cfg.rounds,
      answer: { lat: meta.lat, lon: meta.lon, name: meta.name, cc: meta.cc, km: meta.km, rating: clueRating(meta) },
      results,
    };
    this.setPhase('reveal', this.cfg.revealMs);
    this.broadcast({ ...this.reveal, ms: this.ms(this.phaseEnd) });
    this.markPlayers();
    this.sched.after(this.cfg.revealMs, () => this.standings(), 'phase');
  }

  ranked() {
    return this.list.filter((p) => !p.spec).sort((a, b) =>
      (b.alive - a.alive) || (b.alive ? 0 : b.elimRound - a.elimRound) || (b.total - a.total) || (b.last - a.last) || (a.join - b.join));
  }

  standings() {
    const n = this.round;
    let elim = [], close = [];
    if (isElimRound(this.cfg, n)) {
      const alive = this.alive().sort((a, b) => (a.total - b.total) || (a.last - b.last) || (b.join - a.join));
      const k = elimCount(this.cfg, alive.length);
      elim = alive.slice(0, k);
      for (const p of elim) { p.alive = false; p.elimRound = n; }
      // close calls: survivors who scraped through (within CLOSE_CALL_PTS of the cut line)
      const line = elim.length ? elim[elim.length - 1].total : null;
      if (line != null) close = alive.slice(k).filter((p) => p.total - line < CLOSE_CALL_PTS).map((p) => ({ id: p.id, margin: p.total - line }));
    }
    const last = n >= this.cfg.rounds || (elim.length > 0 && this.alive().length <= 1);
    const dur = last ? 2500 : this.cfg.standingsMs;
    this.setPhase('standings', dur);
    this.broadcast({ t: 'standings', round: n, rounds: this.cfg.rounds, elim: elim.map((p) => p.id), close, ms: this.ms(this.phaseEnd), final: last });
    this.markPlayers();
    this.sched.after(dur, () => (last ? this.gameOver() : this.startRound(n + 1)), 'phase');
  }

  gameOver() {
    this.sched.cancel('phase'); this.sched.cancel('bots');
    const r = this.ranked();
    this.ranking = r.map((p, i) => ({ id: p.id, name: p.name, bot: !!p.bot, total: p.total, rank: i + 1, alive: p.alive, elim: p.elimRound }));
    this.setPhase('over', this.cfg.gameoverMs);
    this.broadcast({ t: 'over', ranking: this.ranking, ms: this.cfg.gameoverMs ? this.ms(this.phaseEnd) : 0, rounds: this.round, clues: this.clueLog.length, gid: this.gid() });
    this.log(`[${this.code}] game over, winner ${r[0]?.name}`);
    this.markPlayers();
    if (this.cfg.gameoverMs) this.sched.after(this.cfg.gameoverMs, () => this.backToLobby(true), 'phase');
  }

  checkAllReady() {
    if (this.phase !== 'over') return;
    const hs = this.connectedHumans();
    if (hs.length && hs.every((h) => h.ready)) this.backToLobby(true);
  }

  // ------------------------------------------------------------ input
  handle(pid, msg) {
    const p = this.players.get(pid);
    if (!p || p.bot || !msg || typeof msg.t !== 'string') return;
    switch (msg.t) {
      case 'pin': {
        if (this.phase !== 'round' || !p.alive || p.lock || staleRound(msg, this.round)) return;
        const g = validLatLon(msg); if (g) p.guess = g;
        break;
      }
      case 'lock': {
        if (this.phase !== 'round' || !p.alive || p.lock || staleRound(msg, this.round)) return;
        const g = validLatLon(msg); if (g) p.guess = g;
        if (!p.guess) return;
        p.lock = this.stage;
        this.send(p, { t: 'locked', stage: p.lock, lat: p.guess.lat, lon: p.guess.lon });
        this.broadcast({ t: 'lock', id: p.id, stage: p.lock });
        this.markPlayers();
        this.checkAllLocked();
        break;
      }
      case 'start': {
        if (this.phase === 'lobby' && this.mode === 'private' && pid === this.hostId && !this.phaseEnd && !this.draining) {
          if (typeof msg.bots === 'boolean') this.cfg.fillBots = msg.bots;
          this.sched.cancel('lobby');
          this.setPhase('lobby', 3000);
          this.broadcastLobby();
          this.sched.after(3000, () => this.beginGame(), 'lobby');
        }
        break;
      }
      case 'again': {
        if (this.phase !== 'over' || p.ready) return;
        p.ready = true;
        this.markPlayers();
        this.checkAllReady();
        break;
      }
      case 'skip': { // solo only: fast-forward the rest of the game once you're out
        if (this.mode === 'solo' && !p.alive) this.sched.setSpeed(30);
        break;
      }
      case 'snap': this.send(p, this.snapshot(p)); break;
      default: break;
    }
  }

  snapshot(p) {
    const s = {
      t: 'snap', you: p.id, code: this.code, mode: this.mode, phase: this.phase, round: this.round, rounds: this.cfg.rounds,
      ms: this.phaseEnd ? this.ms(this.phaseEnd) : 0, host: this.hostId, players: this.list.map((x) => this.publicPlayer(x)),
    };
    if (this.phase === 'round' && this.clue) {
      s.roundInfo = this.roundMsg();
      s.stage = this.stage;
      s.stages = [];
      for (let i = 1; i <= this.stage; i++) s.stages.push(this.stageData(i));
      s.mine = { guess: p.guess, lock: p.lock };
    }
    if (this.phase === 'intro') s.intro = { round: this.round, rounds: this.cfg.rounds, elimAfter: isElimRound(this.cfg, this.round) };
    if ((this.phase === 'reveal' || this.phase === 'standings') && this.reveal) s.reveal = this.reveal;
    if (this.phase === 'over') { s.ranking = this.ranking; s.gid = this.gid(); s.played = this.round; }
    if (!p.bot) s.hist = p.hist || [];
    return s;
  }

  /** Id of the current game (room instance + game counter): lets clients record each game exactly once. */
  gid() { return `${this.code}:${this.uid}:${this.games}`; }

  dispose() {
    this.disposed = true; this.sched.dispose(); clearTimeout(this._emptyTimer);
    for (const p of this.players.values()) clearTimeout(p._dropTimer);
    this.players.clear();
  }
}

/** A pin/lock that says which round it belongs to is ignored outside that round. */
function staleRound(msg, round) { return msg.round != null && msg.round !== round; }

export function validLatLon(m) {
  if (typeof m.lat !== 'number' || typeof m.lon !== 'number') return null;
  const lat = m.lat, lon = m.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 540) return null;
  return { lat, lon: ((((lon + 180) % 360) + 360) % 360) - 180 };
}

// invisible / layout-breaking characters: controls, format chars (bidi, zero-width, soft hyphen),
// line/paragraph separators, Hangul fillers, braille blank, combining grapheme joiner, Mongolian vowel separator
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0\u2800\u034F\u180E]/gu;

export function sanitizeName(n) {
  let s = String(n ?? '').slice(0, 128).normalize('NFC').replace(INVISIBLE, '').replace(/[<>]/g, '');
  s = s.replace(/(\p{M}{2})\p{M}+/gu, '$1'); // cap combining-mark stacks ("zalgo")
  s = s.replace(/\s+/g, ' ').trim();
  s = Array.from(s).slice(0, 16).join('').trim(); // cut by whole code points, never half an emoji
  if (!/[\p{L}\p{N}\p{S}]/u.test(s)) s = ''; // nothing visible left
  return s || 'Player' + Math.floor(Math.random() * 900 + 100);
}
