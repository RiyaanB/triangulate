// Generic WebSocket room/lobby server: public matchmaking, private codes, session resume tokens,
// heartbeats, per-socket + per-IP rate limiting, input validation, and graceful drain for restarts.
// Game rules live in the Room implementation, which must provide:
//   addHuman({name, preSend}) -> {id}, findByToken(token) -> player|null, reconnect(token) -> {id}|null,
//   disconnect(pid, {leave}), handle(pid, msg), canJoinPublic() -> bool, canJoinPrivate() -> bool,
//   connectedHumans() -> [], phase, players (Map), dispose()
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[A-Z2-9]{4}$/;
const TOKEN_RE = /^[a-z0-9]{8,64}$/i;
const GAME_TYPES = new Set(['pin', 'lock', 'start', 'again', 'skip', 'snap']);

export const LIMITS = {
  msgBurst: 40, // token bucket per socket
  msgPerSec: 20,
  maxMsgBytes: 4096,
  floodCloseAt: -60, // bucket this far in debt = flooding -> close the socket
  maxSocketsPerIp: 24,
  maxRooms: 400,
  roomCreatesPerIpPerMin: 12,
  joinsPerSocketPerMin: 30,
  connsPerIpPerMin: 90, // new sockets per IP per minute (reconnect storms fit easily; scanners don't)
  privateFailsPerIpPerMin: 20, // wrong room codes per IP per minute (stops brute-forcing 4-letter codes)
};

/** Sliding-window counter per key: hit(key) -> false once more than `max` hits happened in the last minute. */
function windowCounter(max, windowMs = 60000) {
  const m = new Map();
  return {
    hit(key, now = Date.now()) {
      const list = (m.get(key) || []).filter((t) => now - t < windowMs);
      const ok = list.length < max;
      if (ok) list.push(now);
      m.set(key, list);
      if (m.size > 5000) m.clear(); // bound memory
      return ok;
    },
    count(key, now = Date.now()) { return (m.get(key) || []).filter((t) => now - t < windowMs).length; },
  };
}

export class Lobby {
  /**
   * @param {object} o
   * @param {(o:{code, mode, send, onEmpty}) => Room} o.createRoom
   * @param {number} [o.emptyGraceMs] keep an abandoned in-game room alive for reconnects
   */
  constructor({ createRoom, emptyGraceMs = 30000, log = console.log, limits = {} }) {
    this.createRoom = createRoom;
    this.emptyGraceMs = emptyGraceMs;
    this.log = log;
    this.limits = { ...LIMITS, ...limits };
    this.rooms = new Map();
    this.sockets = new Map(); // pid -> ws
    this.ipSockets = new Map(); // ip -> count
    this.ipCreates = new Map(); // ip -> [timestamps]
    this.draining = false;
    this.ipConns = windowCounter(this.limits.connsPerIpPerMin);
    this.ipPrivFails = windowCounter(this.limits.privateFailsPerIpPerMin);
    this.stats = { connections: 0, messages: 0, rejected: 0, rateLimited: 0 };
  }

  newCode() {
    for (;;) {
      let c = '';
      for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
      if (!this.rooms.has(c)) return c;
    }
  }

  makeRoom(mode) {
    const code = this.newCode();
    const room = this.createRoom({
      code, mode,
      send: (pid, msg) => this.sendTo(pid, msg),
      onEmpty: (r) => this.scheduleCleanup(r),
    });
    room._lobbyMode = mode;
    this.rooms.set(code, room);
    this.log(`[lobby] room ${code} (${mode}) created; ${this.rooms.size} rooms`);
    return room;
  }

  closeRoom(room) {
    clearTimeout(room._cleanup);
    room.dispose();
    this.rooms.delete(room.code);
    this.log(`[lobby] room ${room.code} closed; ${this.rooms.size} rooms`);
    this.checkDrained();
  }

  scheduleCleanup(room) {
    clearTimeout(room._cleanup);
    // private lobbies survive a host's network blip (the code was shared with friends); public ones briefly
    const grace = room.phase === 'lobby' ? (room._lobbyMode === 'private' ? this.emptyGraceMs : Math.min(8000, this.emptyGraceMs))
      : room.phase === 'over' ? 2000 : this.emptyGraceMs;
    room._cleanup = setTimeout(() => {
      if (room.connectedHumans().length || !this.rooms.has(room.code)) return;
      this.closeRoom(room);
    }, grace);
  }

  sendTo(pid, msg) {
    const ws = this.sockets.get(pid);
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify(msg)); } catch { /* socket closing */ }
    }
  }

  sendRaw(ws, msg) { if (ws.readyState === 1) try { ws.send(JSON.stringify(msg)); } catch { /* closing */ } }

  findPublic() {
    let best = null;
    for (const r of this.rooms.values()) {
      if (r._lobbyMode !== 'public' || !r.canJoinPublic()) continue;
      if (!best || r.connectedHumans().length > best.connectedHumans().length) best = r;
    }
    return best;
  }

  /** Per-IP room creation budget (sliding minute). */
  mayCreateRoom(ip) {
    if (this.rooms.size >= this.limits.maxRooms) return false;
    const now = Date.now();
    const list = (this.ipCreates.get(ip) || []).filter((t) => now - t < 60000);
    if (list.length >= this.limits.roomCreatesPerIpPerMin) { this.ipCreates.set(ip, list); return false; }
    list.push(now);
    this.ipCreates.set(ip, list);
    if (this.ipCreates.size > 5000) this.ipCreates.clear(); // bound memory
    return true;
  }

  /**
   * Attach a ws (from the `ws` package). `ip` is the client address (already resolved through a trusted
   * reverse proxy by the caller). Returns false if the connection was refused.
   */
  attach(ws, ip = '?') {
    const L = this.limits;
    const n = (this.ipSockets.get(ip) || 0) + 1;
    if (n > L.maxSocketsPerIp || !this.ipConns.hit(ip)) {
      this.stats.rejected++;
      this.sendRaw(ws, { t: 'error', code: 'busy', msg: 'Too many connections from your network' });
      try { ws.close(1013, 'too many connections'); } catch { /* ignore */ }
      return false;
    }
    this.ipSockets.set(ip, n);
    this.stats.connections++;
    let pid = null, room = null;
    let bucket = L.msgBurst, last = Date.now();
    let joins = [];
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    // `old`: the socket that held this seat before (resume from another tab/connection) — it gets closed
    const bind = (r, p, old = this.sockets.get(p.id)) => {
      room = r; pid = p.id;
      if (old && old !== ws) { old._replaced = true; try { old.close(4000, 'replaced'); } catch { /* ignore */ } }
      this.sockets.set(pid, ws);
      clearTimeout(r._cleanup);
    };
    // only the socket that currently owns a seat may act on it (a replaced tab can't leave/lock for the new one)
    const owns = () => !!(room && pid && this.sockets.get(pid) === ws);
    const leaveCurrent = () => {
      if (!room) return;
      if (owns()) { this.sockets.delete(pid); room.disconnect(pid, { leave: true }); }
      room = null; pid = null;
    };
    const fail = (code, msg) => this.sendRaw(ws, { t: 'error', code, msg });

    ws.on('message', (raw, isBinary) => {
      const now = Date.now();
      bucket = Math.min(L.msgBurst, bucket + ((now - last) / 1000) * L.msgPerSec); last = now;
      if (--bucket < 0) {
        this.stats.rateLimited++;
        if (bucket < L.floodCloseAt) { try { ws.close(1008, 'flood'); } catch { /* ignore */ } }
        return;
      }
      if (isBinary || raw.length > L.maxMsgBytes) return;
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
      this.stats.messages++;
      if (msg.t === 'ping') { this.sendRaw(ws, { t: 'pong', c: typeof msg.c === 'number' ? msg.c : 0 }); return; }
      if (msg.t === 'join') {
        joins = joins.filter((t) => now - t < 60000);
        if (joins.length >= L.joinsPerSocketPerMin) { fail('slow', 'Slow down'); return; }
        joins.push(now);
        this.handleJoin(ws, msg, ip, { leaveCurrent, bind, fail, current: () => ({ room, pid }) });
        return;
      }
      if (msg.t === 'leave') { leaveCurrent(); return; }
      if (GAME_TYPES.has(msg.t) && owns()) room.handle(pid, msg);
    });
    ws.on('close', () => {
      const c = (this.ipSockets.get(ip) || 1) - 1;
      if (c <= 0) this.ipSockets.delete(ip); else this.ipSockets.set(ip, c);
      if (room && pid && this.sockets.get(pid) === ws) {
        this.sockets.delete(pid);
        room.disconnect(pid);
      }
    });
    ws.on('error', () => {});
    return true;
  }

  handleJoin(ws, msg, ip, { leaveCurrent, bind, fail, current }) {
    const name = typeof msg.name === 'string' ? msg.name.slice(0, 64) : '';
    const code = typeof msg.code === 'string' ? msg.code.toUpperCase().trim() : '';
    const token = typeof msg.token === 'string' && TOKEN_RE.test(msg.token) ? msg.token : null;
    // 1) resume an existing seat (reconnect after a network blip or a page reload)
    if (token && CODE_RE.test(code) && this.rooms.has(code)) {
      const r = this.rooms.get(code);
      const p0 = r.findByToken(token);
      if (p0) {
        const cur = current();
        if (!(cur.room === r && cur.pid === p0.id)) leaveCurrent(); // re-sending a join for our own seat is a no-op
        const old = this.sockets.get(p0.id);
        this.sockets.set(p0.id, ws); // so the welcome/snapshot reaches this socket
        const p = r.reconnect(token);
        if (p) { bind(r, p, old); return; }
        if (this.sockets.get(p0.id) === ws) { if (old) this.sockets.set(p0.id, old); else this.sockets.delete(p0.id); }
      }
    }
    // a room creator whose seat expired must not silently get a brand-new room: rejoin the room by code
    let mode = msg.mode;
    if (mode === 'create' && token && CODE_RE.test(code)) {
      // this path takes a code too, so it shares the wrong-code budget (no brute-force side door)
      if (this.ipPrivFails.count(ip) >= this.limits.privateFailsPerIpPerMin) { fail('slow', 'Too many wrong codes — wait a minute'); return; }
      const r = this.rooms.get(code);
      if (!r || r._lobbyMode !== 'private') { this.ipPrivFails.hit(ip); fail('expired', 'That room has closed'); return; }
      mode = 'private';
    }
    if (msg.resume) { // resume-only request (page reload): don't silently start something else
      fail('expired', 'That game is over');
      return;
    }
    if (this.draining) { fail('restarting', 'Server is restarting — try again in a moment'); return; }
    // 2) fresh join
    let r;
    if (mode === 'create') {
      if (!this.mayCreateRoom(ip)) { fail('busy', 'Too many rooms right now — try again soon'); return; }
      leaveCurrent();
      r = this.makeRoom('private');
    } else if (mode === 'private') {
      if (this.ipPrivFails.count(ip) >= this.limits.privateFailsPerIpPerMin) { fail('slow', 'Too many wrong codes — wait a minute'); return; }
      r = CODE_RE.test(code) ? this.rooms.get(code) : null;
      if (!r || r._lobbyMode !== 'private') { this.ipPrivFails.hit(ip); fail('noroom', 'Room not found'); return; }
      if (!r.canJoinPrivate()) { fail('full', 'That room is full'); return; }
      leaveCurrent();
    } else if (mode === 'public' || mode == null) {
      leaveCurrent();
      // reconnecting to a public lobby we were dropped from: prefer the same room if it's still open
      const prev = CODE_RE.test(code) ? this.rooms.get(code) : null;
      r = prev && prev._lobbyMode === 'public' && prev.canJoinPublic() ? prev : this.findPublic();
      if (!r) {
        if (!this.mayCreateRoom(ip)) { fail('busy', 'Server is full — try again soon'); return; }
        r = this.makeRoom('public');
      }
    } else { fail('bad', 'Unknown mode'); return; }
    const p = r.addHuman({ name, preSend: (id) => this.sockets.set(id, ws) });
    bind(r, p);
  }

  startHeartbeat(wss, ms = 20000) {
    const iv = setInterval(() => {
      for (const ws of wss.clients) {
        if (!ws.isAlive) { ws.terminate(); continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch { /* ignore */ }
      }
    }, ms);
    iv.unref?.();
    wss.on('close', () => clearInterval(iv));
    return iv;
  }

  // ------------------------------------------------------------ graceful restart
  /** Number of rooms with a game in progress (not lobby/over) and at least one connected human. */
  activeGames() {
    let n = 0;
    for (const r of this.rooms.values()) if (r.phase !== 'lobby' && r.phase !== 'over' && r.connectedHumans().length) n++;
    return n;
  }

  /**
   * Stop starting new games and tell everyone; resolves when running games have finished (or `maxMs`
   * passed). New joins are refused with code 'restarting'; lobbies won't start their countdown game.
   */
  drain({ maxMs = 8 * 60000, notice = 'Server update: this will be the last game for a moment.' } = {}) {
    if (this.drainPromise) return this.drainPromise;
    this.draining = true;
    for (const r of this.rooms.values()) {
      r.draining = true;
      if (r.phase === 'lobby') r.broadcast?.({ t: 'server', code: 'restarting', msg: 'Server is restarting — reconnecting shortly…' });
      else r.broadcast?.({ t: 'server', code: 'draining', msg: notice });
    }
    this.drainPromise = new Promise((resolve) => {
      this._drainResolve = resolve;
      this._drainTimer = setTimeout(() => { clearInterval(this._drainPoll); resolve('timeout'); }, maxMs);
      this._drainTimer.unref?.();
      this._drainPoll = setInterval(() => this.checkDrained(), 500);
      this._drainPoll.unref?.();
      this.checkDrained();
    });
    return this.drainPromise;
  }

  checkDrained() {
    if (this.draining && this._drainResolve && this.activeGames() === 0) {
      clearTimeout(this._drainTimer);
      clearInterval(this._drainPoll);
      this._drainResolve('drained');
      this._drainResolve = null;
    }
  }

  /** Close every client socket with 1012 (service restart) so clients know to retry shortly. */
  closeAll(wss) {
    for (const c of wss.clients) try { c.close(1012, 'restart'); } catch { /* ignore */ }
  }

  dispose() { for (const r of this.rooms.values()) { clearTimeout(r._cleanup); r.dispose(); } this.rooms.clear(); }
}
