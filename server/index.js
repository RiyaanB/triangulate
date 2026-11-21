// TRIANGULATE server: static client + WebSocket game server on one port.
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

export function createServer({ port = Number(process.env.PORT) || 8787, host = '0.0.0.0', speed = Number(process.env.TRI_SPEED) || 1, quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
  const clues = loadClueSource(ROOT);
  const lobby = new Lobby({
    log,
    createRoom: ({ code, mode, send, onEmpty }) => new TriangulateRoom({ code, mode, clues, send, onEmpty, speed, log }),
  });

  const gzCache = new Map();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rooms: lobby.rooms.size, sockets: lobby.sockets.size, ...lobby.stats }));
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
      };
      const gz = /gzip/.test(req.headers['accept-encoding'] || '') && /\.(js|json|css|html|svg)$/.test(ext) && st.size > 1024;
      if (gz) {
        const key = file + ':' + st.mtimeMs;
        let buf = gzCache.get(key);
        if (!buf) { buf = zlib.gzipSync(fs.readFileSync(file)); gzCache.set(key, buf); }
        res.writeHead(200, { ...headers, 'content-encoding': 'gzip', 'content-length': buf.length, vary: 'accept-encoding' });
        res.end(req.method === 'HEAD' ? undefined : buf);
        return;
      }
      res.writeHead(200, { ...headers, 'content-length': st.size });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8192 });
  wss.on('connection', (ws) => lobby.attach(ws));
  lobby.startHeartbeat(wss);

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      log(`TRIANGULATE listening on http://${host}:${server.address().port} (speed x${speed})`);
      resolve({
        server, wss, lobby, port: server.address().port,
        close: () => new Promise((r) => { lobby.dispose(); for (const c of wss.clients) c.terminate(); wss.close(); server.close(() => r()); }),
      });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await createServer();
  const stop = async () => { await s.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
