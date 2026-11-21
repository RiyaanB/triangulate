// TRIANGULATE server: static client + WebSocket game server on one port.
// Works behind HTTPS reverse proxies / tunnels (client derives a relative wss:// URL; set TRUST_PROXY=1 so
// per-IP limits use X-Forwarded-For). SIGTERM drains running games before exiting (graceful restart).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Lobby } from '../lib/rooms/lobby.js';
import { TriangulateRoom } from '../shared/game/room.js';
import { loadClueSource } from './clues.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};
const MOUNTS = [['/shared/', path.join(ROOT, 'shared')], ['/', path.join(ROOT, 'public')]];
const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

/** Client IP: X-Forwarded-For is only believed from a trusted proxy (TRUST_PROXY=1, or loopback peers by default). */
export function clientIp(req, trust = process.env.TRUST_PROXY ?? 'loopback') {
  const peer = req.socket?.remoteAddress || '?';
  const xff = req.headers?.['x-forwarded-for'];
  const trusted = trust === '1' || trust === 'true' || (trust === 'loopback' && LOOPBACK.test(peer));
  if (trusted && typeof xff === 'string' && xff.length < 512) return xff.split(',')[0].trim() || peer;
  return peer;
}

export function createServer({ port = Number(process.env.PORT) || 8787, host = '0.0.0.0', speed = Number(process.env.TRI_SPEED) || 1, quiet = false, limits, emptyGraceMs } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
  const clues = loadClueSource(ROOT);
  const lobby = new Lobby({
    log, limits, emptyGraceMs,
    createRoom: ({ code, mode, send, onEmpty }) => new TriangulateRoom({ code, mode, clues, send, onEmpty, speed, log }),
  });

  const gzCache = new Map();
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return; }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch { res.writeHead(400, { 'content-type': 'text/plain' }); res.end('bad request'); return; }
    if (pathname.includes('\0')) { res.writeHead(400); res.end(); return; }
    if (pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: !lobby.draining, draining: lobby.draining, rooms: lobby.rooms.size, games: lobby.activeGames(), sockets: lobby.sockets.size, ...lobby.stats }));
      return;
    }
    if (pathname === '/') pathname = '/index.html';
    const mount = MOUNTS.find(([p]) => pathname.startsWith(p));
    const base = mount[1];
    const file = path.normalize(path.join(base, pathname.slice(mount[0].length)));
    if (!file.startsWith(base + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
      const ext = path.extname(file);
      const headers = {
        'content-type': MIME[ext] || 'application/octet-stream',
        'cache-control': /\/(vendor|data)\//.test(file) ? 'public, max-age=3600' : 'no-cache',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      };
      const gz = /gzip/.test(req.headers['accept-encoding'] || '') && /\.(js|json|css|html|svg)$/.test(ext) && st.size > 1024;
      if (gz) {
        const key = file + ':' + st.mtimeMs;
        let buf = gzCache.get(key);
        if (!buf) {
          try { buf = zlib.gzipSync(fs.readFileSync(file)); } catch { res.writeHead(500); res.end(); return; }
          gzCache.set(key, buf);
        }
        res.writeHead(200, { ...headers, 'content-encoding': 'gzip', 'content-length': buf.length, vary: 'accept-encoding' });
        res.end(req.method === 'HEAD' ? undefined : buf);
        return;
      }
      res.writeHead(200, { ...headers, 'content-length': st.size });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    });
  });
  server.on('clientError', (err, sock) => { try { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* ignore */ } });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8192 });
  wss.on('connection', (ws, req) => lobby.attach(ws, clientIp(req)));
  lobby.startHeartbeat(wss);

  const close = () => new Promise((r) => { lobby.dispose(); for (const c of wss.clients) c.terminate(); wss.close(); server.close(() => r()); });
  /** Graceful restart: refuse new games, let running ones finish (<= maxMs), then close sockets with 1012. */
  const shutdown = async ({ maxMs } = {}) => {
    log(`draining (${lobby.activeGames()} games running)…`);
    const how = await lobby.drain({ maxMs });
    log(`drain ${how}; closing`);
    lobby.closeAll(wss);
    await new Promise((r) => setTimeout(r, 300));
    await close();
  };

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      log(`TRIANGULATE listening on http://${host}:${server.address().port} (speed x${speed})`);
      resolve({ server, wss, lobby, port: server.address().port, close, shutdown });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await createServer();
  let stopping = false;
  // SIGTERM (deploys / process managers): finish running games first (TRI_DRAIN_MS, default 8 min).
  // SIGINT (Ctrl-C): quick drain (5 s). A second signal exits immediately.
  const stop = (maxMs) => async () => {
    if (stopping) { console.log('forced exit'); process.exit(1); }
    stopping = true;
    await s.shutdown({ maxMs });
    process.exit(0);
  };
  process.on('SIGTERM', stop(Number(process.env.TRI_DRAIN_MS) || 8 * 60000));
  process.on('SIGINT', stop(5000));
}
