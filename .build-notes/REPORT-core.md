# REPORT — core session (branch `worktree-tri-core`)

Scope: gameplay tuning, clue content, netcode, local meta progression, a multi-agent bug hunt, and tests.
Files owned: `server/**`, `shared/**`, `lib/**`, `tools/**`, `public/js/net.js`, `public/js/app.js` (game flow,
marked `[core]` hooks), `tests/**`, `data/**`. `main` (static build + visuals) was merged twice; conflicts
were only in tests and `build-data.js` and have been resolved.

## Result
- **`npm test` ALL PASSED** (411 s, PORT=9180). It runs:
  - data build and 43 unit/regression tests (`tests/unit.test.js` + new `tests/core.test.js`)
  - the bot soak test
  - browser e2e, desktop 1440x900 and mobile 390x844: solo, live public, private room with a mid-round reconnect, play-again
  - browser client regressions (`tests/regress-client.mjs`)
  - a graceful-restart test (real process, SIGTERM)
  - static `docs/` build + e2e served by `python3 -m http.server`: a full 20-player match on desktop and a daily solo on mobile
- Proxy behaviour (relative `wss://` URL under a path prefix, X-Forwarded-For trust) is covered by unit tests.
- `npm run build:data` builds 303 clues in ~17 s; `npm run build:static` gives `docs/` (303 clues).
- Final screenshots are in `screenshots/core/final/` (title, stage 1, stage 4, reveal, game over and title-after for solo + static; lobby, round and standings for live), at both sizes, with no page errors. I looked at them.
- Before: `screenshots/core/before/`. Content contact sheets: `screenshots/core/contact/` (regenerate with `node tools/contact-sheet.js`).

## 1. Gameplay tuning (tools/sim.js, shared/game/rules.js)
- **One guess model for bots and the simulator.** Recognition is logistic in stage, skill and clue difficulty. A player who recognises the place locks soon and accurately; an unsure player waits and guesses at region level; a gambler sometimes locks early anyway. Bots now behave like people: good bots lock early on easy clues.
- **Simulator:** about 8,000 full games per second, using the real rules and the real clue difficulty distribution. It reports win / top-3 / survival / lock-stage numbers for four human archetypes.
- **Bot skill** is now `0.07 + 0.61·u^1.5` (it was too sharp: a "decent" human won 3%).
- **Public 20-player results:**

  | Human | Win | Top 3 | Survives round 2 | Rounds alive |
  |---|---|---|---|---|
  | Casual | 0.6% | — | 78% | — |
  | Decent | 13.5% | 40% | 94% | 5.7 of 7 |
  | Strong | 45% | — | — | — |
  | Expert | 76% | — | — | — |

  In daily solo (10 players) a decent player wins 26%.
- **Scoring:** distance decay is 1200 km (was 1500). New **bullseye bonus**: +500 when the guess lands inside the clue window. New **streak bonus**: +250 per consecutive bullseye, capped at +750. Stage multipliers are unchanged.
- **Eliminations:** the bottom 25% go out (was 20%), so the final round has 4 players instead of 6. **Close calls** (surviving the cut by less than 1,200 pts) get a "CLOSE CALL" banner.
- **Clue order:** easy to hard, with a target rating per round of 2.2 → 7.5. The **daily** uses a separate clue RNG, so everyone gets the same 5 clues on the same local date, whatever the bots do. Once the day's daily is done, Solo becomes Practice.
- **Rounds end early** once no living human is still guessing, so spectators aren't stuck waiting. A player who drops connection does not cut a round short.

## 2. Content (tools/build-data.js, tools/locations.js, lib/mapdata/scripts.js, data/local-names.json)
- **303 clues** (was 233), balanced: Asia 87, Europe 54, Africa 44, North America 41, Middle East 28, South America 28, Oceania 21. No near-duplicate windows.
- **Stage 1 now shows national borders.** About 60 inland clues were blank at stage 1; Natural Earth 10m boundaries fix that.
- I replaced, reframed or dropped weak clues:
  - ocean-only or blank frames: Maldives, Cape Verde, Delhi, Chongqing, Mauritius and others;
  - near-duplicates: Bahrain/Qatar, Damascus/Beirut, Shatt al-Arab/Kuwait, Almaty/Issyk-Kul;
  - added 70 new locations.
- **Stage-4 labels are genuinely local** and every label is checked against its script's Unicode ranges.
  - Natural Earth fields cover Cyrillic, Greek, Hebrew, Arabic, Devanagari, Bengali, CJK and Hangul.
  - Curated names cover Thai, Lao, Khmer, Burmese, Georgian, Armenian, Amharic, Tigrinya, Tibetan, Mongolian, Sinhala, Tamil, Malayalam, Telugu, Marathi, Gujarati, Nepali, Serbian, Bulgarian and Macedonian. Four translator sub-agents produced them, with confident spellings only.
  - **Latin-script countries now use their own local names** (e.g. Spanish for Venezuela), as requested. There are no more foreign-script transliterations. The tag reads "Local place names".
- **Labels never give the answer away:**
  - nothing is labelled near the frame centre;
  - no lake, island or bay label for a feature that contains the centre;
  - no feature whose name matches the clue (e.g. "Hà Nội" on the Hanoi clue).
  - A regression test checks every clue.
- Sea, bay and island labels come from Natural Earth's marine and region layers.
- **Difficulty rating 1–10** is the curated base plus measured stage-1 linework, later-stage detail, label count and Latin-name readability.
- **Tools:** `tools/audit-clues.js` (hard fails and warnings), `tools/contact-sheet.js` (visual review sheets).

## 3. Netcode (lib/rooms/lobby.js, server/index.js, shared/game/room.js, public/js/net.js)
- **Sessions and reconnects**
  - 128-bit seat tokens.
  - A page reload resumes the same seat via sessionStorage (also with `?room=` invite links). The session TTL refreshes on activity.
  - A resumed seat closes the old tab's socket, and that socket can no longer act on the seat.
  - Lobby seats survive a 20 s network blip. A room creator's reconnect never creates a new room.
  - Inputs queued offline carry their round number, so they can't land in a later round.
- **Rooms and players**
  - Late joiners to a private game spectate, then play the next game.
  - Host migration works (crown, Start button, toast).
  - Leaving mid-game counts as a forfeit.
- **Connection health:** a client watchdog (no traffic for 25 s → reconnect), immediate reconnect when the tab becomes visible or the network comes back, a resync after time in the background, and RTT.
- **Rate limiting and validation**
  - per-socket token bucket, closed with 1008 on flooding;
  - per-IP caps: sockets, connections per minute, rooms created per minute, wrong room codes per minute;
  - a global room cap and strict message validation (types, lengths, lat/lon, codes, tokens);
  - names stripped of control, bidi and invisible characters;
  - `/ws` requires a same-host Origin.
- **No answer leakage:** verified by a test that scans every message before the reveal. Malformed URLs and NUL bytes return 400 instead of crashing.
- **Reverse proxies:** the client uses a relative `ws`/`wss` URL. `X-Forwarded-For` is trusted only from loopback, or when `TRUST_PROXY=1`, and only its last entry.
- **Graceful restart:** SIGTERM stops new games and lets running games finish (`TRI_DRAIN_MS`, default 8 min). It then closes sockets with 1012 and exits 0. Clients show "server restarting…" and retry.

## 4. Meta (shared/game/meta.js + app.js, localStorage only)
- XP per game, from rounds played, bullseyes, placement, score and the daily bonus.
- 25+ levels with titles (Tourist … Atlas). Level-ups show a banner on desktop and a toast on phones.
- Daily streak and best streak by local date.
- Each game is recorded once, by server game id, so a reload doesn't double-count.
- Share text is a Wordle-style emoji grid (distance squares + lock-stage keycaps + streak), copied to the clipboard only. Example:
  ```
  TRIANGULATE Daily #21 — 🏆 1st of 10
  🎯🟩🟨🟥⬛
  1️⃣2️⃣3️⃣4️⃣▫️
  43,136 pts · 🔥4-day streak
  ```

## 5. Multi-agent bug hunt (details: BUGHUNT-core.md)
- **Finders:** 4 parallel agents (server state machine, client flow, mobile, security). They found 34 confirmed issues with repro scripts.
- **Fixes:** I made them.
- **Verifier:** 1 agent re-ran every repro against the fixed code. It confirmed everything was fixed except one brute-force side door that my own fix had introduced; that is now closed.
- **Regression tests:** 13 server/lobby tests in `tests/core.test.js` and 5 browser checks in `tests/regress-client.mjs`.
- **Highest-impact fixes:**
  - a private-room creator's blip created a new room;
  - Start could get stuck;
  - a replaced tab could still control the seat;
  - a network blip cut rounds to about 6 s;
  - the next game left you stuck spectating;
  - XP was recorded twice after a reload;
  - X-Forwarded-For was spoofable;
  - room codes could be brute-forced.

## Known issues
- **Mobile layout bugs in visuals-owned files** (requests filed in REQUESTS-core.md):
  - Landscape phones narrower than 761 px can't play: the map and LOCK button are below the fold.
  - Rotating the phone mid-round keeps the old map framing.
  - On 844x390 screens the game-over buttons are below the fold.
- **The static `docs/` build ships all clues** (your spec), and `data/build/` is committed. A public live server next to a public Pages site or repo could be cheated on. Use `build:static --solo-only` for that setup (see REQUESTS).
- New stage-1 borders and terrain labels are drawn by a small fallback in `app.js` until the clue card draws them natively (requested).
- Khmer and Tibetan labels show as boxes on this headless Linux box (no fonts). Phones, macOS and Windows ship those fonts.
- **Label quality:**
  - The curated non-Latin names are model translations limited to confident spellings, not a native-speaker review.
  - 9 clues have only 2 stage-4 labels.
- **Bot calibration** rests on modelled human archetypes, not real player data. `tools/sim.js` makes re-tuning easy once real numbers exist.
- A clue-load failure retries the round and uses up the daily clue RNG, so that player's later daily clues would differ. Clue files are local, so this is effectively unreachable.

## Reusable
- `tools/sim.js` + `planGuess` / `recogProb`: a reusable shape for simulating any bot/elimination game.
- `lib/mapdata/scripts.js`: script families, Unicode checks and text width for multilingual map labels.
- `lib/rooms/lobby.js`: a game-agnostic WebSocket lobby with resume, per-IP throttles, owner-only routing and drain.
- `shared/kit/wsurl.js`: a proxy-safe relative WebSocket URL.
- `server/index.js`: `clientIp` / `originAllowed`.
- `shared/game/meta.js`: XP, levels, streak and share grid for any daily game.
- Audit and contact-sheet tools for any generated map content. `tests/restart.mjs` and `tests/static-e2e.mjs` work as templates.

## Time spent
- **Session 1 (~30 min before the pause):** exploring the code, baseline test run (passed apart from a guessmap ellipse error), and the start of the data pipeline.
- **Session 2 (~1 h 50):** merging main, content v2 with translator agents, the simulator and tuning, netcode, meta, regression tests, the static and restart tests, and the first full green run. That session's finder agents died with the session.
- **Session 3 (~1 h 45):** merging main again (visuals), local Latin names and answer-safe labels, the foreground bug hunt (4 finders → my fixes → verifier → fix), e2e hardening, three full test runs (the last one green), final screenshots, and this report.

## Hygiene
- Ports used: 9137 (taken, skipped), 9163–9166 and 9175–9184 for my test servers; finder/verifier agents used 9171–9174. All stopped.
- Nothing was pushed. `node_modules` and `data/raw` are symlinks and git-ignored. Scratch output (`tmp/`, `screenshots/core/run*`) is ignored.
