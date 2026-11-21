// Browser regressions for client-flow bugs found in the bug hunt (headless Chrome, real server):
//  1. the next game in the same room starts fresh (an eliminated player is NOT stuck spectating)
//  2. reloading on the results screen does not record XP / the win twice
//  3. a reload with an invite link (?room=CODE) resumes the saved seat
//  4. the host crown moves when the private-room host leaves the lobby
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const log = (...a) => console.log('  [regress]', ...a);
const phase = (p) => p.evaluate(() => window.__tri.phase);

export async function runClientRegressions({ base, lobby }) {
  const errors = [];
  const browser = await chromium.launch({ executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined, headless: true });
  const watch = (p, tag) => { p.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`)); };
  const check = (cond, msg) => { if (!cond) errors.push(msg); else log('ok:', msg); };
  try {
    // ---- 1 + 2: private room, host only (bots fill); never guesses -> eliminated; finish; play again; reload on over
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await ctx.newPage(); watch(page, 'r12');
      await page.goto(base);
      await page.click('#btn-private'); await page.click('#btn-create');
      await page.waitForFunction(() => window.__tri.phase === 'lobby' && window.__tri.code, null, { timeout: 10000 });
      const code = await page.evaluate(() => window.__tri.code);
      await page.click('#btn-start');
      await page.waitForFunction(() => window.__tri.alive === false, null, { timeout: 120000 }); // never guesses -> out
      await page.waitForFunction(() => window.__tri.phase === 'over', null, { timeout: 120000 });
      await page.waitForTimeout(400);
      const meta1 = await page.evaluate(() => JSON.parse(localStorage.getItem('tri.meta')));
      // reload on the results screen: resumes into 'over' but must not count the game again
      await page.reload();
      await page.waitForFunction(() => window.__tri.phase === 'over', null, { timeout: 15000 });
      await page.waitForTimeout(600);
      const meta2 = await page.evaluate(() => JSON.parse(localStorage.getItem('tri.meta')));
      check(meta1 && meta2 && meta2.games === meta1.games && meta2.xp === meta1.xp, `reload on results does not double-record XP (games ${meta1?.games}->${meta2?.games})`);
      check(await page.isVisible('#btn-share'), 'share button still available after reload');
      // play again: the same room starts a new game and I'm a player again, not a spectator
      await page.click('#btn-again');
      await page.waitForFunction((c) => window.__tri.phase === 'lobby' && window.__tri.code === c, code, { timeout: 15000 });
      await page.click('#btn-start');
      await page.waitForFunction(() => window.__tri.phase === 'round', null, { timeout: 30000 });
      const st = await page.evaluate(() => ({ alive: window.__tri.alive, spec: !document.querySelector('#spec-chip').classList.contains('hidden'), map: window.__triMap.enabled, lock: document.querySelector('#btn-lock .lock-txt')?.textContent }));
      check(st.alive && !st.spec && st.map, `next game starts fresh (alive=${st.alive} specChip=${st.spec} map=${st.map} lock="${st.lock}")`);
      await ctx.close();
    }
    // ---- 3 + 4: invite link reload resumes; host leaves the lobby -> crown moves to the guest
    {
      const ch = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const cg = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const host = await ch.newPage(), guest = await cg.newPage();
      watch(host, 'r34-host'); watch(guest, 'r34-guest');
      await host.goto(base);
      await host.click('#btn-private'); await host.click('#btn-create');
      await host.waitForFunction(() => window.__tri.phase === 'lobby' && window.__tri.code, null, { timeout: 10000 });
      const code = await host.evaluate(() => window.__tri.code);
      await guest.goto(`${base}/?room=${code}`);
      await guest.tap('#btn-join');
      await guest.waitForFunction(() => window.__tri.phase === 'lobby', null, { timeout: 10000 });
      const you1 = await guest.evaluate(() => window.__tri.you);
      await guest.reload(); // URL still has ?room=CODE
      await guest.waitForFunction(() => window.__tri.phase === 'lobby' && window.__tri.you, null, { timeout: 10000 });
      const you2 = await guest.evaluate(() => window.__tri.you);
      check(you1 === you2, 'invite-link reload resumes the same seat');
      await host.click('#btn-leave-lobby');
      await guest.waitForFunction(() => window.__tri.host === window.__tri.you, null, { timeout: 10000 });
      await guest.waitForTimeout(300);
      const crown = await guest.evaluate(() => {
        const me = document.querySelector(`.lp[data-key="${window.__tri.you}"]`);
        return { mine: !!me?.querySelector('.host-crown'), total: document.querySelectorAll('#lobby-players .host-crown').length, start: !document.querySelector('#btn-start').classList.contains('hidden') };
      });
      check(crown.mine && crown.total === 1 && crown.start, `host migration: crown + Start move to the guest (${JSON.stringify(crown)})`);
      await ch.close(); await cg.close();
    }
  } catch (e) {
    errors.push('client regressions: ' + (e.stack || e.message));
  } finally {
    await browser.close();
  }
  return { errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const { createServer } = await import('../server/index.js');
  const srv = await createServer({ port: Number(process.env.PORT) || 9175, speed: Number(process.env.TEST_SPEED) || 8, quiet: true });
  const { errors } = await runClientRegressions({ base: `http://127.0.0.1:${srv.port}`, lobby: srv.lobby });
  await srv.close();
  if (errors.length) { console.error(errors.map((e) => '  ✖ ' + e).join('\n')); process.exit(1); }
  console.log('  ✔ client regressions ok');
}
