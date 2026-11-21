// Authoritative TRIANGULATE room engine. Transport-agnostic: runs on the Node server (WebSocket)
// and in the browser for SOLO mode. All answers stay inside this object until reveal.
import { Scheduler } from '../kit/scheduler.js';
import { makeRng } from '../kit/rng.js';
import { distanceKm } from '../kit/geo.js';
import { makeBot } from '../kit/bots.js';
import { makeConfig, scoreFor, elimCount, isElimRound, planBotGuess, diffWeights } from './rules.js';

let uid = 0;
const newId = (p) => p + (++uid).toString(36) + Math.floor(Math.random() * 1296).toString(36);

export class TriangulateRoom {
  /**
   * @param {object} o
   * @param {string} o.code       room code
   * @param {'public'|'private'|'solo'} o.mode
   * @param {object} o.clues      { list(): meta[], load(id): Promise<clue> }  meta = {id, lat, lon, name, cc, diff, km}
   * @param {(pid:string, msg:object)=>void} o.send
   * @param {number} [o.speed]    time multiplier (tests)
   * @param {object} [o.config]   overrides
   */
  constructor({ code, mode = 'public', clues, send, speed = 1, seed, config = {}, onEmpty = () => {}, log = () => {} }) {
    this.code = code; this.mode = mode; this.clues = clues; this._send = send;
    this.cfg = makeConfig(mode, config);
    this.rng = makeRng(seed ?? undefined);
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
    };
  }
  playersMsg() { return { t: 'players', players: this.list.map((p) => this.publicPlayer(p)) }; }
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

  addHuman({ name, token, preSend }) {
    const p = {
      id: newId('p'), token: token || newId('t') + newId('t'), name: sanitizeName(name), bot: false, conn: true,
      alive: this.phase === 'lobby', spec: this.phase !== 'lobby', total: 0, last: 0, lock: 0, guess: null,
      elimRound: 0, join: ++this.joinSeq, ready: false,
    };
    // bots make way for humans: every human joining a public lobby replaces one bot
    if (this.mode === 'public' && this.phase === 'lobby') this.removeOneBot();
    this.players.set(p.id, p);
    if (preSend) preSend(p.id);
    if (!this.hostId || !this.players.get(this.hostId)?.conn) this.hostId = p.id;
    this.log(`[${this.code}] + ${p.name} (${this.connectedHumans().length} humans)`);
    this.sendWelcome(p);
    this.markPlayers();
    if (this.phase === 'lobby') this.onLobbyJoin();
    return p;
  }

  sendWelcome(p) {
    this._send(p.id, { t: 'welcome', you: p.id, token: p.token, code: this.code, mode: this.mode });
    this._send(p.id, this.snapshot(p));
  }

  reconnect(token) {
    const p = this.list.find((x) => !x.bot && x.token === token && !x.left);
    if (!p) return null;
    p.conn = true;
    this.sched.cancel('empty');
    this.sendWelcome(p);
    this.markPlayers();
    return p;
  }

  disconnect(pid, { leave = false } = {}) {
    const p = this.players.get(pid);
    if (!p) return;
    p.conn = false;
    if (leave) p.left = true;
    if (this.phase === 'lobby' || (leave && p.spec)) this.players.delete(pid);
    if (this.hostId === pid) this.hostId = this.connectedHumans()[0]?.id || null;
    this.log(`[${this.code}] - ${p.name} (${this.connectedHumans().length} humans left)`);
    this.markPlayers();
    if (!this.connectedHumans().length) {
      if (this.phase === 'lobby') { this.sched.clear(); this.removeAllBots(); }
      this.onEmpty(this);
    } else if (this.phase === 'round') this.checkAllLocked();
  }

  removeOneBot() {
    const bots = this.list.filter((p) => p.bot).sort((a, b) => b.join - a.join);
    if (bots[0]) this.players.delete(bots[0].id);
  }
  removeAllBots() { for (const p of this.list) if (p.bot) this.players.delete(p.id); }
  addBot() {
    const taken = new Set(this.list.map((p) => p.name));
    const b = makeBot(this.rng, newId('b'), taken);
    Object.assign(b, { alive: true, total: 0, last: 0, lock: 0, guess: null, elimRound: 0, join: ++this.joinSeq });
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
      Object.assign(p, { alive: true, spec: false, total: 0, last: 0, lock: 0, guess: null, elimRound: 0, ready: false });
    }
    this.round = 0; this.used.clear(); this._soloStarted = false;
    this.setPhase('lobby');
    this.reveal = null; this.ranking = null; this.clue = null;
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
    this.sched.cancel('lobby');
    if (this.cfg.fillBots) {
      const target = this.mode === 'private' ? Math.max(8, this.list.length) : this.cfg.maxPlayers;
      while (this.list.length < target) this.addBot();
    }
    this.games++;
    this.log(`[${this.code}] game start with ${this.list.length} players`);
    this.startRound(1);
  }

  pickClue() {
    const all = this.clues.list();
    const w = diffWeights(this.round, this.cfg.rounds);
    let pool = all.filter((c) => !this.used.has(c.id));
    if (!pool.length) { this.used.clear(); pool = all; }
    const d = this.rng.weighted(w) + 1;
    const byDiff = pool.filter((c) => c.diff === d);
    const meta = this.rng.pick(byDiff.length ? byDiff : pool);
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
    this.broadcast({ t: 'intro', round: n, rounds: this.cfg.rounds, ms: this.ms(introEnd), km: meta.km, elimAfter: isElimRound(this.cfg, n) });
    this.markPlayers();
    let clue;
    try { clue = await this.clues.load(meta.id); } catch (e) {
      this.log('clue load failed', meta.id, e.message);
      this.used.add(meta.id);
      return this.startRound(n);
    }
    if (this.disposed) return;
    this.clue = { meta, data: clue };
    this.sched.after(Math.max(0, introEnd - this.sched.vnow()), () => this.beginStages(), 'phase');
  }

  beginStages() {
    const c = this.cfg;
    this.setPhase('round', c.roundMs);
    this.roundStart = this.sched.vnow();
    this.stage = 1;
    for (const p of this.alive()) if (p.bot) {
      p.plan = planBotGuess(this.rng, p.profile, { lat: this.clue.meta.lat, lon: this.clue.meta.lon, diff: this.clue.meta.diff }, c);
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
    const hs = this.alive().filter((p) => !p.bot && p.conn);
    if (!hs.length || hs.some((p) => !p.lock)) return;
    // everyone human has locked: wrap up quickly; bots keep their planned outcome
    this._endingEarly = true;
    this.sched.cancel('phase');
    this.sched.cancel('bots');
    this.sched.after(1400, () => this.endRound(), 'phase');
    this.broadcast({ t: 'ending', ms: this.ms(this.sched.vnow() + 1400) });
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
      let pts = 0, d = null;
      if (p.guess) { d = distanceKm(p.guess.lat, p.guess.lon, meta.lat, meta.lon); pts = scoreFor(d, p.lock); }
      p.last = pts; p.total += pts;
      results.push({ id: p.id, lat: p.guess?.lat ?? null, lon: p.guess?.lon ?? null, d: d == null ? null : Math.round(d), stage: p.lock || 0, pts });
    }
    results.sort((a, b) => b.pts - a.pts);
    this.reveal = {
      t: 'reveal', round: this.round, rounds: this.cfg.rounds,
      answer: { lat: meta.lat, lon: meta.lon, name: meta.name, cc: meta.cc, km: meta.km },
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
    let elim = [];
    if (isElimRound(this.cfg, n)) {
      const alive = this.alive().sort((a, b) => (a.total - b.total) || (a.last - b.last) || (b.join - a.join));
      elim = alive.slice(0, elimCount(this.cfg, alive.length));
      for (const p of elim) { p.alive = false; p.elimRound = n; }
    }
    const last = n >= this.cfg.rounds;
    const dur = last ? 2500 : this.cfg.standingsMs;
    this.setPhase('standings', dur);
    this.broadcast({ t: 'standings', round: n, rounds: this.cfg.rounds, elim: elim.map((p) => p.id), ms: this.ms(this.phaseEnd), final: last });
    this.markPlayers();
    this.sched.after(dur, () => (last ? this.gameOver() : this.startRound(n + 1)), 'phase');
  }

  gameOver() {
    const r = this.ranked();
    this.ranking = r.map((p, i) => ({ id: p.id, name: p.name, bot: !!p.bot, total: p.total, rank: i + 1, alive: p.alive, elim: p.elimRound }));
    this.setPhase('over', this.cfg.gameoverMs);
    this.broadcast({ t: 'over', ranking: this.ranking, ms: this.cfg.gameoverMs ? this.ms(this.phaseEnd) : 0 });
    this.log(`[${this.code}] game over, winner ${r[0]?.name}`);
    if (this.cfg.gameoverMs) this.sched.after(this.cfg.gameoverMs, () => this.backToLobby(true), 'phase');
  }

  // ------------------------------------------------------------ input
  handle(pid, msg) {
    const p = this.players.get(pid);
    if (!p || !msg || typeof msg.t !== 'string') return;
    switch (msg.t) {
      case 'pin': {
        if (this.phase !== 'round' || !p.alive || p.lock) return;
        const g = validLatLon(msg); if (g) p.guess = g;
        break;
      }
      case 'lock': {
        if (this.phase !== 'round' || !p.alive || p.lock) return;
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
        if (this.phase === 'lobby' && this.mode !== 'solo' && pid === this.hostId) {
          if (typeof msg.bots === 'boolean') this.cfg.fillBots = msg.bots;
          this.sched.cancel('lobby');
          this.setPhase('lobby', 3000);
          this.broadcastLobby();
          this.sched.after(3000, () => this.beginGame(), 'lobby');
        }
        break;
      }
      case 'again': {
        if (this.phase !== 'over') return;
        p.ready = true;
        if (this.connectedHumans().every((h) => h.ready)) this.backToLobby(true);
        else this.markPlayers();
        break;
      }
      case 'skip': { // solo only: fast-forward the rest of the game
        if (this.mode === 'solo') this.sched.setSpeed(30);
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
    if ((this.phase === 'reveal' || this.phase === 'standings') && this.reveal) s.reveal = this.reveal;
    if (this.phase === 'over') s.ranking = this.ranking;
    return s;
  }

  dispose() { this.disposed = true; this.sched.dispose(); this.players.clear(); }
}

function validLatLon(m) {
  const lat = Number(m.lat), lon = Number(m.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 540) return null;
  return { lat, lon: ((lon + 540) % 360) - 180 };
}

export function sanitizeName(n) {
  const s = String(n ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 16);
  return s || 'Player' + Math.floor(Math.random() * 900 + 100);
}
