// Generic WebSocket room/lobby server: public matchmaking, private codes, reconnect tokens,
// heartbeats and per-socket rate limiting. Game rules live in the Room implementation, which must provide:
//   addHuman({name, token}) -> {id}, reconnect(token) -> {id}|null, disconnect(pid, {leave}), handle(pid, msg),
//   canJoinPublic() -> bool, connectedHumans() -> [], dispose()
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class Lobby {
  /**
   * @param {object} o
   * @param {(o:{code, mode, send}) => Room} o.createRoom
   * @param {number} [o.emptyGraceMs] keep an abandoned in-game room alive for reconnects
   */
  constructor({ createRoom, emptyGraceMs = 30000, log = console.log }) {
    this.createRoom = createRoom;
    this.emptyGraceMs = emptyGraceMs;
    this.log = log;
    this.rooms = new Map();
    this.sockets = new Map(); // pid -> ws
    this.stats = { connections: 0, messages: 0 };
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

  scheduleCleanup(room) {
    clearTimeout(room._cleanup);
    const grace = room.phase === 'lobby' ? 0 : room.phase === 'over' ? 2000 : this.emptyGraceMs;
    room._cleanup = setTimeout(() => {
      if (room.connectedHumans().length) return;
      room.dispose();
      this.rooms.delete(room.code);
      this.log(`[lobby] room ${room.code} closed; ${this.rooms.size} rooms`);
    }, grace);
  }

  sendTo(pid, msg) {
    const ws = this.sockets.get(pid);
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify(msg)); } catch { /* socket closing */ }
    }
  }

  findPublic() {
    let best = null;
    for (const r of this.rooms.values()) {
      if (r._lobbyMode !== 'public' || !r.canJoinPublic()) continue;
      if (!best || r.connectedHumans().length > best.connectedHumans().length) best = r;
    }
    return best || this.makeRoom('public');
  }

  /** Attach a ws (from the `ws` package) */
  attach(ws) {
    this.stats.connections++;
    let pid = null, room = null;
    let bucket = 40, last = Date.now();
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const bind = (r, p) => {
      room = r; pid = p.id;
      const old = this.sockets.get(pid);
      if (old && old !== ws) try { old.close(4000, 'replaced'); } catch { /* ignore */ }
      this.sockets.set(pid, ws);
      clearTimeout(r._cleanup);
    };
    ws.on('message', (raw) => {
      const now = Date.now();
      bucket = Math.min(40, bucket + ((now - last) / 1000) * 20); last = now;
      if (--bucket < 0) return; // rate limited
      if (raw.length > 4096) return;
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      this.stats.messages++;
      if (msg.t === 'ping') { this.sendRaw(ws, { t: 'pong', c: msg.c }); return; }
      if (msg.t === 'join') {
        if (room) { // switching rooms: leave the old one
          this.sockets.delete(pid);
          room.disconnect(pid, { leave: true });
          room = null; pid = null;
        }
        // reconnect path
        if (msg.token && msg.code && this.rooms.has(String(msg.code).toUpperCase())) {
          const r = this.rooms.get(String(msg.code).toUpperCase());
          const p0 = r.players?.get ? [...r.players.values()].find((x) => x.token === msg.token && !x.left) : null;
          if (p0) {
            this.sockets.set(p0.id, ws); // so the welcome/snapshot reaches this socket
            const p = r.reconnect(msg.token);
            if (p) { bind(r, p); return; }
          }
        }
        let r;
        if (msg.mode === 'create') r = this.makeRoom('private');
        else if (msg.mode === 'private') {
          r = this.rooms.get(String(msg.code || '').toUpperCase().trim());
          if (!r || r._lobbyMode === 'solo') { this.sendRaw(ws, { t: 'error', code: 'noroom', msg: 'Room not found' }); return; }
        } else r = this.findPublic();
        const p = r.addHuman({ name: msg.name, token: null, preSend: (id) => this.sockets.set(id, ws) });
        bind(r, p);
        return;
      }
      if (msg.t === 'leave') {
        if (room) { this.sockets.delete(pid); room.disconnect(pid, { leave: true }); room = null; pid = null; }
        return;
      }
      if (room && pid) room.handle(pid, msg);
    });
    ws.on('close', () => {
      if (room && pid && this.sockets.get(pid) === ws) {
        this.sockets.delete(pid);
        room.disconnect(pid);
      }
    });
    ws.on('error', () => {});
  }

  sendRaw(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }

  startHeartbeat(wss, ms = 20000) {
    const iv = setInterval(() => {
      for (const ws of wss.clients) {
        if (!ws.isAlive) { ws.terminate(); continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch { /* ignore */ }
      }
    }, ms);
    wss.on('close', () => clearInterval(iv));
    return iv;
  }

  dispose() { for (const r of this.rooms.values()) r.dispose(); this.rooms.clear(); }
}
