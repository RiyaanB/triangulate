// Connections: WebSocket (live) with auto-reconnect, and an in-browser Local connection for SOLO.
import { TriangulateRoom } from '../shared/game/room.js';

export function wsUrl() {
  const u = new URL('ws', location.href); // relative to page => works behind path-prefixed proxies
  u.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  u.hash = ''; u.search = '';
  return u.href;
}

export class WsConnection {
  constructor(joinMsg, { onStatus = () => {} } = {}) {
    this.joinMsg = joinMsg; this.onStatus = onStatus;
    this.onmessage = () => {};
    this.closed = false; this.tries = 0; this.session = null;
    this.open();
  }
  open() {
    let ws;
    try { ws = new WebSocket(wsUrl()); } catch (e) { this.fail(e); return; }
    this.ws = ws;
    ws.onopen = () => {
      this.tries = 0;
      const msg = this.session ? { ...this.joinMsg, token: this.session.token, code: this.session.code } : this.joinMsg;
      ws.send(JSON.stringify(msg));
      this.onStatus(this.session ? 'reconnected' : 'open');
      clearInterval(this.ping);
      this.ping = setInterval(() => this.send({ t: 'ping', c: Date.now() }), 15000);
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'welcome') this.session = { token: m.token, code: m.code };
      if (m.t === 'pong') return;
      this.onmessage(m);
    };
    ws.onclose = (e) => {
      clearInterval(this.ping);
      if (this.closed || e.code === 4000) return;
      this.tries++;
      if (this.tries > 12) { this.onStatus('failed'); return; }
      this.onStatus('reconnecting');
      setTimeout(() => !this.closed && this.open(), Math.min(5000, 400 * this.tries));
    };
    ws.onerror = () => {};
  }
  fail() { this.onStatus('failed'); }
  send(m) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m)); }
  close() {
    this.closed = true; clearInterval(this.ping);
    try { this.send({ t: 'leave' }); this.ws?.close(); } catch { /* ignore */ }
  }
}

// ---- SOLO: clue pack shipped statically; answers lightly obfuscated
let soloPack = null;
async function loadSoloPack() {
  if (soloPack) return soloPack;
  const j = await (await fetch('data/solo-pack.json')).json();
  const bin = atob(j.p);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) ^ (0x5a + (i % 13));
  soloPack = JSON.parse(new TextDecoder().decode(bytes));
  return soloPack;
}

export async function soloClueSource() {
  const metas = await loadSoloPack();
  const cache = new Map();
  return {
    list: () => metas,
    async load(id) {
      if (!cache.has(id)) cache.set(id, fetch(`data/solo/${id}.json`).then((r) => { if (!r.ok) throw new Error('clue ' + r.status); return r.json(); }));
      return cache.get(id);
    },
  };
}

export class LocalConnection {
  constructor({ name, seed, speed = 1 }) {
    this.onmessage = () => {};
    this.queue = [];
    this.ready = soloClueSource().then((clues) => {
      this.room = new TriangulateRoom({
        code: 'SOLO', mode: 'solo', clues, speed, seed,
        send: (pid, msg) => setTimeout(() => this.onmessage(structuredClone(msg)), 0),
      });
      this.me = this.room.addHuman({ name });
    });
  }
  send(m) { this.ready.then(() => this.room && !this.room.disposed && this.room.handle(this.me.id, m)); }
  close() { this.ready.then(() => this.room?.dispose()); }
}
