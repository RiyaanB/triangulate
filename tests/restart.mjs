// Graceful restart: start the real server process, begin a private game, send SIGTERM mid-game.
// Expect: a 'draining' notice, the running game still finishes ('over'), new joins are refused with
// 'restarting', then sockets close with 1012 and the process exits 0.
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

export async function runRestartTest({ root = process.cwd(), port = Number(process.env.RESTART_PORT) || 9166 } = {}) {
  const errors = [];
  const proc = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, PORT: String(port), TRI_SPEED: '25', TRI_DRAIN_MS: '60000' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((r) => proc.on('exit', (code) => r(code)));
  try {
    await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const iv = setInterval(() => { if (/listening/.test(out)) { clearInterval(iv); resolve(); } else if (Date.now() - t0 > 10000) { clearInterval(iv); reject(new Error('server did not start: ' + out)); } }, 50);
    });
    const url = `ws://127.0.0.1:${port}/ws`;
    const seen = [];
    let closeCode = null;
    const ws = new WebSocket(url);
    await new Promise((r) => ws.on('open', r));
    ws.on('close', (c) => { closeCode = c; });
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      seen.push(m.t === 'server' ? 'server:' + m.code : m.t);
      if (m.t === 'lobby' && !seen.includes('sent-start')) { seen.push('sent-start'); ws.send(JSON.stringify({ t: 'start', bots: true })); }
      if (m.t === 'round' && !seen.includes('sent-term')) { seen.push('sent-term'); proc.kill('SIGTERM'); }
    });
    ws.send(JSON.stringify({ t: 'join', mode: 'create', name: 'drainer' }));
    // while draining, a newcomer must be refused
    await new Promise((r) => { const iv = setInterval(() => { if (seen.includes('server:draining')) { clearInterval(iv); r(); } }, 20); });
    const late = new WebSocket(url);
    const lateMsg = await new Promise((resolve) => {
      late.on('open', () => late.send(JSON.stringify({ t: 'join', mode: 'public', name: 'late' })));
      late.on('message', (raw) => resolve(JSON.parse(raw)));
      late.on('error', () => resolve(null));
      setTimeout(() => resolve(null), 4000);
    });
    if (lateMsg?.t !== 'error' || lateMsg.code !== 'restarting') errors.push('newcomer not refused while draining: ' + JSON.stringify(lateMsg));
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 90000))]);
    if (code !== 0) errors.push('server exit code ' + code);
    if (!seen.includes('over')) errors.push('running game did not finish before shutdown: ' + seen.slice(-8).join(','));
    if (closeCode !== 1012) errors.push('client close code ' + closeCode + ' (want 1012)');
    return { errors, summary: { exit: code, closeCode, sawOver: seen.includes('over') } };
  } catch (e) {
    errors.push('restart test: ' + e.message);
    return { errors, summary: {} };
  } finally {
    if (proc.exitCode == null) proc.kill('SIGKILL');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const { errors, summary } = await runRestartTest();
  console.log('  ', summary);
  if (errors.length) { console.error(errors.map((e) => '  ✖ ' + e).join('\n')); process.exit(1); }
  console.log('  ✔ graceful restart ok');
}
