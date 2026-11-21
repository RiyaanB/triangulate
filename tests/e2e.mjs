// End-to-end browser tests (headless Chrome via Playwright). Plays SOLO and LIVE games at desktop
// and mobile sizes and writes screenshots to ./screenshots/.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const SHOTS = path.resolve('screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
const MOBILE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true };
const CITIES = [[48.8, 2.3], [40.7, -74], [35.7, 139.7], [-23.5, -46.6], [28.6, 77.2], [30, 31.2], [-33.9, 151.2], [55.7, 37.6], [19.4, -99.1], [1.3, 103.8], [-1.3, 36.8], [39.9, 116.4]];

const log = (...a) => console.log('  [e2e]', ...a);
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, name + '.png') });
const phase = (page) => page.evaluate(() => window.__tri.phase);

async function waitPhase(page, phases, timeout = 90000) {
  const h = await page.waitForFunction((ps) => ps.includes(window.__tri.phase) ? window.__tri.phase : null, phases, { timeout, polling: 100 });
  return h.jsonValue();
}

async function tapLatLon(page, lat, lon, mobile) {
  const pt = await page.evaluate(([lat, lon]) => {
    const m = window.__triMap; const r = m.canvas.getBoundingClientRect();
    const [x, y] = m.sp(lat, lon);
    return { x: r.left + x, y: r.top + y, ok: x > 4 && y > 4 && x < r.width - 4 && y < r.height - 70 };
  }, [lat, lon]);
  if (!pt.ok) return false;
  if (mobile) await page.touchscreen.tap(pt.x, pt.y); else await page.mouse.click(pt.x, pt.y);
  return true;
}

/**
 * Play until game over. `oracle(page)` may return the true answer (for a strong player);
 * otherwise guesses a random big city.
 */
async function playGame(page, { tag, mobile = false, oracle = null, jitterKm = 150, shots = {}, stagePick = () => 1 + Math.floor(Math.random() * 4) }) {
  const seen = { elim: false, rounds: 0 };
  for (;;) {
    const ph = await waitPhase(page, ['round', 'over'], 120000);
    if (ph === 'over') break;
    const round = await page.evaluate(() => window.__tri.round);
    seen.rounds = Math.max(seen.rounds, round);
    const alive = await page.evaluate(() => window.__tri.alive);
    if (alive) {
      const target = round === 1 && shots.stages ? 4 : stagePick(round);
      for (let s = 1; s <= target; s++) {
        await page.waitForFunction((s) => window.__tri.stage >= s || window.__tri.phase !== 'round', s, { timeout: 60000, polling: 50 });
        if (round === 1 && shots.stages) { await page.waitForTimeout(1700); await shot(page, `${shots.stages}-stage${s}`); }
      }
      if ((await phase(page)) === 'round') {
        let ans = oracle ? await oracle(page) : null;
        let [lat, lon] = ans ? [ans.lat + (Math.random() - 0.5) * jitterKm / 55, ans.lon + (Math.random() - 0.5) * jitterKm / 55] : CITIES[Math.floor(Math.random() * CITIES.length)];
        let ok = await tapLatLon(page, lat, lon, mobile);
        if (!ok) { await page.evaluate(() => window.__triMap.fitWorld(false)); await page.waitForTimeout(100); ok = await tapLatLon(page, lat, lon, mobile); }
        await page.waitForTimeout(150);
        const pinned = await page.evaluate(() => !!window.__tri.myPin);
        if (!pinned) throw new Error(`${tag}: pin drop failed in round ${round}`);
        if (round === 1 && shots.pin) await shot(page, shots.pin);
        if ((await phase(page)) === 'round') {
          const btn = page.locator('#btn-lock');
          for (let tries = 0; tries < 3; tries++) {
            await (mobile ? btn.tap({ timeout: 3000 }) : btn.click({ timeout: 3000 })).catch(() => {});
            const ok = await page.waitForFunction(() => window.__tri.myLock > 0 || window.__tri.phase !== 'round', null, { timeout: 5000 }).then(() => true, () => false);
            if (ok) break;
            // lost pin (e.g. snapshot after reconnect): drop it again
            await tapLatLon(page, lat, lon, mobile);
          }
          if (round === 1 && shots.locked) await shot(page, shots.locked);
        }
      }
    }
    const p2 = await waitPhase(page, ['reveal', 'over'], 90000);
    if (p2 === 'over') break;
    if (shots.reveal && round === (shots.revealRound || 1)) { await page.waitForTimeout(2600); await shot(page, shots.reveal); }
    const p3 = await waitPhase(page, ['standings', 'over'], 60000);
    if (p3 === 'over') break;
    await page.waitForTimeout(500);
    const nowAlive = await page.evaluate(() => window.__tri.alive);
    if (alive && !nowAlive && !seen.elim) { seen.elim = true; log(tag, 'eliminated in round', round); if (shots.elim) await shot(page, shots.elim); }
    if (shots.board && round === 2) await shot(page, shots.board);
    // solo: once out, skip ahead
    if (!nowAlive && (await page.evaluate(() => window.__tri.mode)) === 'solo') {
      if (await page.isVisible('#btn-skip')) await page.click('#btn-skip');
    }
  }
  await page.waitForTimeout(1500);
  const res = await page.evaluate(() => {
    const S = window.__tri; return { title: document.querySelector('#over-title').textContent, me: document.querySelector('#over-me').textContent, alive: S.alive };
  });
  log(tag, 'game over —', res.title, '|', res.me);
  return { ...seen, ...res };
}

function watchErrors(page, tag, errors) {
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag} console: ${m.text()}`); });
}

export async function runE2E({ base, speed, lobby }) {
  const browser = await chromium.launch({ executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined, headless: true });
  const errors = [];
  const results = {};
  // server-side oracle: find the answer for the room this page is in (testing only)
  const serverOracle = async (page) => {
    const code = await page.evaluate(() => window.__tri.code);
    const room = lobby.rooms.get(code);
    return room?.clue?.meta;
  };
  const soloOracle = (page) => page.evaluate(() => { const m = window.__tri.conn?.room?.clue?.meta; return m ? { lat: m.lat, lon: m.lon } : null; });
  try {
    // ---------------- SOLO desktop: strong player -> should win, confetti screenshot
    {
      const ctx = await browser.newContext(DESKTOP);
      const page = await ctx.newPage(); watchErrors(page, 'solo-d', errors);
      await page.goto(`${base}/?speed=${speed}`);
      await page.waitForTimeout(900);
      await shot(page, '01-title');
      await page.click('#btn-solo');
      const r = await playGame(page, { tag: 'solo-desktop', oracle: soloOracle, jitterKm: 60, stagePick: () => 1 + Math.floor(Math.random() * 2),
        shots: { stages: '02', pin: '06-pin', locked: '07-locked', reveal: '08-reveal', board: '09-leaderboard' } });
      await page.waitForTimeout(400);
      await shot(page, '10-winner');
      results.soloDesktop = r;
      if (!/You win/.test(r.title)) errors.push('solo desktop strong player did not win: ' + r.title);
      // play again (practice) starts a new solo game
      await page.click('#btn-again');
      await waitPhase(page, ['intro', 'round'], 20000);
      await page.click('#btn-exit');
      await ctx.close();
    }
    // ---------------- SOLO mobile: random player, likely eliminated -> skip
    {
      const ctx = await browser.newContext(MOBILE);
      const page = await ctx.newPage(); watchErrors(page, 'solo-m', errors);
      await page.goto(`${base}/?speed=${speed}`);
      await page.waitForTimeout(900);
      await shot(page, 'm01-title');
      await page.tap('#btn-solo');
      results.soloMobile = await playGame(page, { tag: 'solo-mobile', mobile: true, shots: { stages: 'm02', reveal: 'm03-reveal', board: 'm04-leaderboard', elim: 'm05-eliminated' } });
      await shot(page, 'm06-gameover');
      await ctx.close();
    }
    // ---------------- LIVE public: desktop strong + mobile random in the same room
    {
      const cd = await browser.newContext(DESKTOP), cm = await browser.newContext(MOBILE);
      const pd = await cd.newPage(), pm = await cm.newPage();
      watchErrors(pd, 'live-d', errors); watchErrors(pm, 'live-m', errors);
      await pd.goto(base); await pm.goto(base);
      await pd.fill('#nick', 'DeskAce'); await pm.fill('#nick', 'PhoneRando');
      await pd.click('#btn-play');
      await pd.waitForFunction(() => window.__tri.phase === 'lobby' && window.__tri.code, null, { timeout: 10000 });
      await pm.tap('#btn-play');
      await pm.waitForFunction(() => window.__tri.phase === 'lobby' || window.__tri.phase === 'intro', null, { timeout: 10000 });
      const sameRoom = await pd.evaluate(() => window.__tri.code) === await pm.evaluate(() => window.__tri.code);
      if (!sameRoom) errors.push('public matchmaking put the two humans in different rooms');
      await pd.waitForTimeout(300);
      await shot(pd, '11-live-lobby'); await shot(pm, 'm07-live-lobby');
      const [rd, rm] = await Promise.all([
        playGame(pd, { tag: 'live-desktop', oracle: serverOracle, jitterKm: 250, shots: { reveal: '12-live-reveal', revealRound: 2, board: '13-live-standings' } }),
        playGame(pm, { tag: 'live-mobile', mobile: true, shots: { elim: 'm08-live-eliminated' } }),
      ]);
      await shot(pd, '14-live-over'); await shot(pm, 'm09-live-over');
      results.liveDesktop = rd; results.liveMobile = rm;
      if (rd.rounds < 7) errors.push('live desktop strong player did not reach round 7 (rounds=' + rd.rounds + ')');
      await cd.close(); await cm.close();
    }
    // ---------------- PRIVATE room: create + join by code, reconnect mid-game, play again in same room
    {
      const ch = await browser.newContext(DESKTOP), cg = await browser.newContext(MOBILE);
      const host = await ch.newPage(), guest = await cg.newPage();
      watchErrors(host, 'priv-h', errors); watchErrors(guest, 'priv-g', errors);
      await host.goto(base); await guest.goto(base);
      await host.click('#btn-private'); await host.click('#btn-create');
      await host.waitForFunction(() => window.__tri.phase === 'lobby' && window.__tri.code, null, { timeout: 10000 });
      const code = await host.evaluate(() => window.__tri.code);
      await guest.goto(`${base}/?room=${code}`);
      await guest.tap('#btn-join');
      await guest.waitForFunction(() => window.__tri.phase === 'lobby', null, { timeout: 10000 });
      await host.waitForFunction(() => window.__tri.players.length === 2, null, { timeout: 5000 });
      await shot(host, '15-private-lobby');
      await host.click('#btn-start');
      // guest drops its socket during round 2 and must come back
      const dropper = (async () => {
        await guest.waitForFunction(() => window.__tri.round === 2 && window.__tri.phase === 'round', null, { timeout: 120000 });
        await guest.evaluate(() => window.__tri.conn.ws.close());
        await guest.waitForFunction(() => window.__tri.phase && document.querySelector('#conn-state').textContent === '', null, { timeout: 15000 });
        log('guest reconnected in phase', await phase(guest));
      })();
      const [rh, rg] = await Promise.all([
        playGame(host, { tag: 'private-host', oracle: serverOracle, jitterKm: 400 }),
        playGame(guest, { tag: 'private-guest', mobile: true }),
        dropper,
      ]);
      results.privateHost = rh; results.privateGuest = rg;
      // play again: both press it -> same room goes back to the lobby
      await host.click('#btn-again'); await guest.tap('#btn-again');
      await Promise.all([host, guest].map((p) => p.waitForFunction((c) => window.__tri.phase === 'lobby' && window.__tri.code === c, code, { timeout: 15000 })));
      log('play-again returned both players to room', code);
      await shot(host, '16-private-play-again');
      await ch.close(); await cg.close();
    }
  } finally {
    await browser.close();
  }
  return { errors, results };
}
