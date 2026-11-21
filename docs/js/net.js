// Connections: WebSocket (live) with auto-reconnect + session resume, and an in-browser Local
// connection for SOLO / the static build (the same room engine runs in the page).
import { TriangulateRoom } from '../shared/game/room.js';

export function wsUrl(loc = location) {
  const u = new URL('ws', loc.href); // relative to page => works behind path-prefixed proxies
  u.protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  u.hash = ''; u.search = '';
  return u.href;
}

// ---- session persistence: a page reload (or a mobile browser killing the tab) can rejoin the same seat
const SESSION_KEY = 'tri.session';
const SESSION_TTL = 15 * 60000;
export const session = {
  load() {
    try {
      const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
      return s && Date.now() - s.t < SESSION_TTL && s.token && s.code ? s : null;
    } catch { return null; }
  },
  save(s) { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ ...s, t: Date.now() })); } catch { /* private mode */ } },
  clear() { try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ } },
};

const PING_MS = 10000;
const DEAD_MS = 25000; // no traffic for this long while "open" => assume a dead socket and reconnect

export class WsConnection {
  /**
   * @param {object} joinMsg  {t:'join', name, mode, code?, token?, resume?}
   * @param {object} o
   * @param {(status:string, info?:object)=>void} [o.onStatus]  open | reconnecting | reconnected | failed | replaced | restarting
   */
  constructor(joinMsg, { onStatus = () => {} } = {}) {
    this.joinMsg = joinMsg; this.onStatus = onStatus;
    this.onmessage = () => {};
    this.closed = false; this.tries = 0; this.rtt = 0;
    this.session = joinMsg.token && joinMsg.code ? { token: joinMsg.token, code: joinMsg.code } : null;
    this.pending = []; // game inputs sent while (re)connecting are flushed after re-joining
    this.restarting = false;
    this._onVis = () => this.onVisibility();
    this._onOnline = () => this.kick();
    document.addEventListener('visibilitychange', this._onVis);
    addEventListener('online', this._onOnline);
    this.open();
  }

  open() {
    clearTimeout(this.retryT);
    let ws;
    try { ws = new WebSocket(wsUrl()); } catch (e) { this.onStatus('failed', { reason: e.message }); return; }
    this.ws = ws;
    this.lastRx = Date.now();
    ws.onopen = () => {
      const msg = this.session ? { ...this.joinMsg, token: this.session.token, code: this.session.code } : this.joinMsg;
      ws.send(JSON.stringify(msg));
      this.onStatus(this.session && this.everOpen ? 'reconnected' : 'open');
      this.everOpen = true;
      clearInterval(this.ping);
      this.ping = setInterval(() => this.heartbeat(), PING_MS);
    };
    ws.onmessage = (e) => {
      this.lastRx = Date.now();
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'pong') { if (m.c) this.rtt = Date.now() - m.c; return; }
      if (m.t === 'welcome') {
        this.tries = 0; this.restarting = false;
        this.session = { token: m.token, code: m.code };
        session.save({ token: m.token, code: m.code, mode: m.mode, name: this.joinMsg.name });
        // inputs queued while offline go out only once we hold our seat again
        for (const q of this.pending.splice(0)) ws.send(JSON.stringify(q));
      }
      if (m.t === 'server' && m.code === 'restarting') this.restarting = true;
      if (m.t === 'error' && (m.code === 'expired' || m.code === 'noroom')) session.clear();
      this.onmessage(m);
    };
    ws.onclose = (e) => {
      clearInterval(this.ping);
      if (this.ws !== ws || this.closed) return;
      if (e.code === 4000) { this.closed = true; session.clear(); this.onStatus('replaced'); return; }
      if (e.code === 1008 || e.code === 1013) { this.closed = true; this.onStatus('failed', { reason: e.reason }); return; }
      if (e.code === 1012) this.restarting = true;
      this.tries++;
      // a restarting server needs a little while; normal drops retry fast first, then back off
      const max = this.restarting ? 40 : 20;
      if (this.tries > max) { this.onStatus('failed'); return; }
      this.onStatus(this.restarting ? 'restarting' : 'reconnecting');
      const delay = this.restarting ? 1500 : Math.min(5000, 300 * this.tries);
      this.retryT = setTimeout(() => !this.closed && this.open(), document.hidden ? Math.max(delay, 3000) : delay);
    };
    ws.onerror = () => {};
  }

  heartbeat() {
    if (this.ws?.readyState !== 1) return;
    if (Date.now() - this.lastRx > DEAD_MS) { this.drop(); return; }
    this.send({ t: 'ping', c: Date.now() });
  }

  /** Force-close a socket we believe is dead; onclose schedules the reconnect. */
  drop() { try { this.ws.close(); } catch { /* ignore */ } }

  /** Reconnect right now (network came back / tab became visible) instead of waiting for the backoff. */
  kick() {
    if (this.closed) return;
    const st = this.ws?.readyState;
    if (st === 2 || st === 3 || st == null) { this.tries = Math.max(0, this.tries - 1); this.open(); }
  }

  onVisibility() {
    if (this.closed) return;
    if (document.hidden) { this.hiddenAt = Date.now(); return; }
    const away = Date.now() - (this.hiddenAt || Date.now());
    if (this.ws?.readyState !== 1) { this.kick(); return; }
    // back from background: timers in the page may have drifted, resync from the server
    if (away > 3000) { this.send({ t: 'ping', c: Date.now() }); this.send({ t: 'snap' }); }
  }

  send(m) {
    if (this.ws?.readyState === 1 && (this.session || m.t === 'ping')) this.ws.send(JSON.stringify(m));
    else if (!this.closed && m.t !== 'ping' && m.t !== 'snap' && this.pending.length < 20) this.pending.push(m);
  }

  close() {
    this.closed = true; clearInterval(this.ping); clearTimeout(this.retryT);
    document.removeEventListener('visibilitychange', this._onVis);
    removeEventListener('online', this._onOnline);
    session.clear();
    try { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'leave' })); this.ws?.close(); } catch { /* ignore */ }
  }
}

// ---- SOLO / static: clue pack shipped statically; answers lightly obfuscated
let soloPack = null;
async function loadSoloPack() {
  if (soloPack) return soloPack;
  const r = await fetch('data/solo-pack.json');
  if (!r.ok) throw new Error('pack ' + r.status);
  const j = await r.json();
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
    load(id) {
      if (!cache.has(id)) {
        const p = fetch(`data/solo/${id}.json`).then((r) => { if (!r.ok) throw new Error('clue ' + r.status); return r.json(); });
        p.catch(() => cache.delete(id)); // don't cache failures: a later round may retry
        cache.set(id, p);
      }
      return cache.get(id);
    },
  };
}

export class LocalConnection {
  // mode 'solo' (daily run) or 'public' (full match vs in-browser bots, used by the static build)
  constructor({ name, seed, speed = 1, mode = 'solo', config = {} }) {
    this.onmessage = () => {};
    this.rtt = 0;
    this.ready = soloClueSource().then((clues) => {
      if (this.closed) return;
      this.room = new TriangulateRoom({
        code: mode === 'solo' ? 'SOLO' : 'BOTS', mode, clues, speed, seed, config,
        send: (pid, msg) => setTimeout(() => { if (!this.closed) this.onmessage(structuredClone(msg)); }, 0),
      });
      this.me = this.room.addHuman({ name });
    });
  }
  send(m) { this.ready.then(() => this.room && !this.room.disposed && this.room.handle(this.me.id, m)); }
  close() { this.closed = true; this.ready.then(() => this.room?.dispose()).catch(() => {}); }
}
