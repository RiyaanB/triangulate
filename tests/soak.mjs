// Bot soak test: many rooms at once, driven through the real WebSocket server by passive
// "observer" clients (all guessing is done by bots), plus in-process rooms at very high speed.
import WebSocket from 'ws';
import { TriangulateRoom } from '../shared/game/room.js';
import { loadClueSource } from '../server/clues.js';

function wsClient(url, join, { dropAfterMs } = {}) {
  return new Promise((resolve, reject) => {
    let ws = new WebSocket(url);
    const st = { msgs: 0, phases: new Set(), over: null, session: null, reconnected: false };
    const timer = setTimeout(() => reject(new Error('soak client timeout ' + JSON.stringify([...st.phases]))), 240000);
    const wire = () => {
      ws.on('message', (raw) => {
        const m = JSON.parse(raw);
        st.msgs++;
        st.phases.add(m.t);
        if (m.t === 'welcome') st.session = { token: m.token, code: m.code };
        if (m.t === 'lobby' && join.mode === 'create' && !st.started && m.host) { st.started = true; ws.send(JSON.stringify({ t: 'start', bots: true })); }
        if (m.t === 'over') { st.over = m; clearTimeout(timer); ws.close(); resolve(st); }
      });
      ws.on('error', () => {});
    };
    wire();
    ws.on('open', () => ws.send(JSON.stringify(join)));
    if (dropAfterMs) setTimeout(() => {
      ws.terminate();
      setTimeout(() => {
        ws = new WebSocket(url); wire();
        ws.on('open', () => { st.reconnected = true; ws.send(JSON.stringify({ ...join, token: st.session.token, code: st.session.code })); });
      }, 500);
    }, dropAfterMs);
  });
}

export async function runSoak({ base, lobby, root, wsRooms = 6, localRooms = 12 }) {
  const url = base.replace(/^http/, 'ws') + '/ws';
  const errors = [];
  const t0 = Date.now();
  const mem0 = process.memoryUsage().heapUsed;
  // WS-driven rooms (private rooms filled with bots), one of which drops + reconnects mid-game
  const ws = Array.from({ length: wsRooms }, (_, i) => wsClient(url, { t: 'join', mode: 'create', name: 'soak' + i }, { dropAfterMs: i === 0 ? 9000 : 0 }));
  // plus a couple of public-room observers
  ws.push(wsClient(url, { t: 'join', mode: 'public', name: 'pubA' }), wsClient(url, { t: 'join', mode: 'public', name: 'pubB' }));
  // in-process rooms at very high speed with a single passive human each
  const clues = loadClueSource(root);
  const local = Array.from({ length: localRooms }, (_, i) => new Promise((resolve, reject) => {
    let room;
    const to = setTimeout(() => reject(new Error('local room timeout')), 120000);
    room = new TriangulateRoom({
      code: 'L' + i, mode: 'public', clues, speed: 150,
      send: (pid, m) => { if (m.t === 'over') { clearTimeout(to); resolve(m); setTimeout(() => room.dispose(), 0); } },
    });
    room.addHuman({ name: 'watcher' + i });
  }));
  const wsRes = await Promise.allSettled(ws);
  const locRes = await Promise.allSettled(local);
  for (const r of [...wsRes, ...locRes]) if (r.status === 'rejected') errors.push('soak: ' + r.reason.message);
  const okWs = wsRes.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  for (const s of okWs) {
    if (s.over.ranking.length < 8) errors.push('soak: too few players in ranking ' + s.over.ranking.length);
    if (!s.over.ranking.some((p) => p.bot)) errors.push('soak: no bots in room');
    const alive = s.over.ranking.filter((p) => p.alive).length;
    if (alive < 3) errors.push('soak: fewer than 3 finalists');
  }
  if (!okWs[0]?.reconnected) errors.push('soak: reconnect client did not reconnect');
  const winners = locRes.filter((r) => r.status === 'fulfilled').map((r) => r.value.ranking[0]);
  const botWins = winners.filter((w) => w.bot).length;
  // rooms should be cleaned up after everyone left
  await new Promise((r) => setTimeout(r, 3500));
  if (lobby.rooms.size) errors.push('soak: rooms not cleaned up: ' + lobby.rooms.size);
  const summary = {
    seconds: ((Date.now() - t0) / 1000).toFixed(1), wsGames: okWs.length, localGames: winners.length,
    avgWinnerScore: Math.round(winners.reduce((a, w) => a + w.total, 0) / Math.max(1, winners.length)),
    botWinsVsPassiveHuman: `${botWins}/${winners.length}`, roomsLeftOpen: lobby.rooms.size,
    heapDeltaMB: ((process.memoryUsage().heapUsed - mem0) / 1e6).toFixed(1),
  };
  return { errors, summary };
}
