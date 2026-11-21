#!/usr/bin/env node
// npm test: (a) build data, (b) unit tests, (c) start server, (d) bot soak, (e) browser e2e (solo + live,
// desktop + mobile) with screenshots in ./screenshots/.
// Flags: --no-build (reuse built data), --skip-e2e, --skip-soak, --skip-static.  Env: PORT (default 8787), STATIC_PORT
// (default PORT+1, serves docs/), TEST_SPEED (default 4), SHOTS_DIR (screenshots)
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const speed = Number(process.env.TEST_SPEED) || 4;
const port = Number(process.env.PORT) || 8787;
const t0 = Date.now();
const step = (s) => console.log(`\n=== ${s} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
let failed = false;

if (!args.has('--no-build')) {
  step('build data');
  const r = spawnSync(process.execPath, ['tools/build-data.js'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  if (r.status !== 0) { console.error('build:data failed'); process.exit(1); }
  console.log('  data built');
}

step('unit tests');
const u = spawnSync(process.execPath, ['--test', 'tests/unit.test.js', 'tests/core.test.js'], { cwd: ROOT, encoding: 'utf8' });
console.log(u.stdout.split('\n').filter((l) => /^(✔|✖|ℹ (pass|fail))/.test(l.trim())).map((l) => '  ' + l.trim()).join('\n'));
if (u.status !== 0) { console.error(u.stdout.slice(-3000)); failed = true; }

step(`start server on :${port} at speed x${speed}`);
const srv = await createServer({ port, speed, quiet: true });
const base = `http://127.0.0.1:${srv.port}`;
try {
  if (!args.has('--skip-soak')) {
    step('bot soak test');
    const { runSoak } = await import('./soak.mjs');
    const { errors, summary } = await runSoak({ base, lobby: srv.lobby, root: ROOT });
    console.log('  ', summary);
    if (errors.length) { failed = true; console.error(errors.map((e) => '  ✖ ' + e).join('\n')); } else console.log('  ✔ soak ok');
  }
  if (!args.has('--skip-e2e')) {
    step('browser e2e (solo + live, desktop 1440x900 + mobile 390x844)');
    const { runE2E } = await import('./e2e.mjs');
    const { errors, results } = await runE2E({ base, speed, lobby: srv.lobby });
    for (const [k, v] of Object.entries(results)) console.log(`   ${k}: rounds=${v.rounds} eliminated=${v.elim} -> ${v.title}`);
    if (errors.length) { failed = true; console.error(errors.map((e) => '  ✖ ' + e).join('\n')); } else console.log('  ✔ e2e ok — screenshots in ./screenshots/');
    step('client regressions (bug hunt): fresh next game, no double XP on reload, invite-link resume, host migration');
    const { runClientRegressions } = await import('./regress-client.mjs');
    const rc = await runClientRegressions({ base, lobby: srv.lobby });
    if (rc.errors.length) { failed = true; console.error(rc.errors.map((e) => '  ✖ ' + e).join('\n')); } else console.log('  ✔ client regressions ok');
  }
} catch (e) {
  failed = true;
  console.error('  ✖', e.stack || e);
} finally {
  await srv.close();
}
if (!args.has('--skip-soak')) {
  step('graceful restart (SIGTERM drains the running game, then 1012)');
  const { runRestartTest } = await import('./restart.mjs');
  const { errors, summary } = await runRestartTest({ root: ROOT, port: Number(process.env.RESTART_PORT) || port + 2 });
  console.log('  ', summary);
  if (errors.length) { failed = true; console.error(errors.map((e) => '  ✖ ' + e).join('\n')); } else console.log('  ✔ restart ok');
}
if (!args.has('--skip-static') && !args.has('--skip-e2e')) {
  step('static build (docs/) + e2e without a game server');
  const b = spawnSync(process.execPath, ['tools/build-static.js'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  if (b.status !== 0) { failed = true; console.error('  ✖ build:static failed'); } else {
    const { runStaticE2E } = await import('./static-e2e.mjs');
    const { errors } = await runStaticE2E({ root: ROOT, speed, port: Number(process.env.STATIC_PORT) || port + 1 });
    if (errors.length) { failed = true; console.error(errors.map((e) => '  ✖ ' + e).join('\n')); } else console.log('  ✔ static build plays a full match + daily solo');
  }
}
step(failed ? 'FAILED' : 'ALL PASSED');
process.exit(failed ? 1 : 0);
