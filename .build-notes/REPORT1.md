# TRIANGULATE — build report #1

Date: 2026-11-21, roughly 11:37–12:40 local (about 1 h of wall-clock time, all autonomous).

## What's done

- **Data pipeline** (`npm run build:data`, ~15 s): downloads 15 Natural Earth layers. It builds **233 clues**
  (175 live and 58 solo, from hand-picked spots on every inhabited continent: coastlines, deltas, islands,
  lakes and inland hubs), each about 11 KB of JSON. It also builds a 388 KB world basemap. Clue geometry
  is clipped, simplified and projected into a 1000×1000 local frame, so it contains no lat/lon. Stage 4
  uses local-script names (Cyrillic, Greek, Hebrew, Arabic, Persian, Urdu, Devanagari, Bengali, Chinese,
  Japanese, Korean). Latin-script or unsupported countries get names transliterated into a foreign script,
  clearly marked. Labels include populated places, lakes and rivers (rotated along the river), with
  collision avoidance.
- **Authoritative room engine** (`shared/game/room.js`). It handles lobby countdown, bot trickle-in and
  despawn, 4-stage rounds (stages at 0/8/16/24 s, 34 s per round), lock-in with stage multipliers, early
  finish when every human has locked, reveal, elimination of the bottom 20 % after rounds 2–6 (never below 3
  players), game over with ranking, play-again into the same room, spectators, and disconnects. The same
  code runs on the server and in the browser (SOLO).
- **Server**: one Node process with static files, gzip, `/healthz` and a `ws` lobby (public matchmaking,
  private 4-char codes, reconnect tokens, heartbeat, rate limiting, empty-room cleanup). It uses relative
  `ws`/`wss` URLs, so it works behind proxies and path prefixes.
- **Client**: title (big PLAY, random nickname, Daily solo, Private room), lobby, and the game screen. The
  game screen has a framed SVG clue card with a stage bar, countdown ring, stroke-dash draw-in, pop-in
  labels and a scale bar. It also has a canvas Mercator guess map (d3-zoom pan/zoom/pinch, tap to pin,
  drop/lock animations) and a live leaderboard with lock indicators, an elimination cut line, FLIP reordering
  and score deltas. Then come the reveal (great-circle line, everyone's guesses, count-up points, answer
  name), an ELIMINATED banner plus spectator mode (solo: "Skip to results"), and a podium winner screen with
  confetti. WebAudio blips with a mute toggle, Space/Enter to lock in, a one-time onboarding hint, and the
  Natural Earth credit line are included.
- **Responsive**: desktop has 3 columns; at 1100 px and below the leaderboard becomes a drawer; portrait
  phones put the clue on top and the map below. Screenshots were checked at 1440×900 and 390×844.
- **Tests** (`npm test`, about 5.5 min, all passing):
  - 9 unit tests: scoring, elimination, geo math, the bot error distribution, the scheduler, clipping, name
    sanitising, a full in-process game with a mid-game disconnect, and a check that no live clue or answer
    is exposed statically.
  - Bot soak: 8 WebSocket-driven rooms (one of them drops and reconnects) plus 12 in-process rooms at ×150
    speed. It checks that every room is cleaned up afterwards (0 left open); heap grew by about 4 MB.
  - Playwright + system Chrome e2e: solo desktop (strong player wins), solo mobile (random player is
    eliminated and skips ahead), live public with 2 humans (desktop + mobile) in the same room, and a private
    room created and joined by code with a forced socket drop and reconnect mid-round, then Play again →
    both players back in the same room. 31 screenshots go to `./screenshots/`.

## Not done / missing

- The guess map doesn't wrap at the antimeridian (Pacific guesses near ±180° are fine but you can't pan
  across). No clues sit on the antimeridian.
- Natural Earth has no Thai, Khmer, Burmese, Sinhala, Amharic, Georgian or Armenian name fields, so those
  countries use transliterated scripts.
- 13 inland clues show a blank land square at stage 1. The UI says "Inland — no coastline in view"; it's
  intentional, but those rounds are harder.
- There's no persistent stats, accounts, chat or emotes. Solo "daily" picks clues by date seed but has no
  share card yet.
- Solo answers ship in the browser (XOR-obfuscated). That's fine for a practice mode, but it isn't secure.
- Bot difficulty is fixed. It was tuned with a simulator (`tmp/sim.mjs`, not committed): a player
  averaging about 600 km at stage 3 wins about 40 % of public games, and a passive human always loses.
- No bundled webfont; it uses the system font stack.

## Known bugs / rough edges

- At test speed (×4) banners and screenshots can overlap phase changes. At normal speed timings are relaxed.
- The reveal map redraws every frame while the truth marker pulses. That's cheap, but not idle-friendly on
  low-end phones.
- If you open a second tab with the same session it takes over the first socket (by design). The old tab
  then sits on its last screen.
- `confirm()` is used for "Leave this game?" — it works, but it's not styled.

## Time per phase (approx.)

| Phase | Time |
|---|---|
| Data download + inspection | 5 min |
| Map pipeline + 233 locations | 12 min |
| Engine, rules, bots, lobby/server | 12 min |
| Client (UI kit, clue card, guess map, app) | 15 min |
| First playable + visual fixes | 5 min |
| Tests (unit/soak/e2e) + fixes found by them | 12 min |
| README / report | 4 min |

## What was hard

- **Keeping answers secret** while still sending geometry: the local projection frame, per-stage delivery,
  and a separate solo pool. A stale-build leak was caught and is now covered by a test.
- **Making 233 clipped snippets look right without a GIS stack.** Coastlines come from land polygons with
  clip-border edges removed, so the coastline, fill and minor islands always match.
- **Time control for tests**: the virtual-time `Scheduler` lets the same engine run at ×4 for browser tests,
  ×150 for soak tests, and ×30 for the solo "skip".
- **Reconnects**: the snapshot rebuilds the UI mid-round, and inputs sent while offline are queued and
  replayed after the rejoin.

## Reusable for other games

- `lib/rooms/lobby.js` — a generic WebSocket lobby (matchmaking, codes, reconnect, heartbeat, rate limit).
  You plug in any room class.
- `shared/kit/` — seeded RNG, a virtual-time scheduler, geo math, and a bot identity/skill framework.
- `lib/mapdata/` — shapefile loading, rectangle clipping, simplification and compact SVG paths. It's good for
  any "map snippet" or geography game.
- `public/css/ui-kit.css` + `public/js/ui/kit.js` — the dark .io-style UI kit (toasts, banners, countdown
  ring, count-up, confetti, WebAudio sfx, FLIP).
- The pattern of **one transport-agnostic room engine** that runs on the server and offline in the browser,
  with the same client code for both.
- `tests/e2e.mjs` patterns: a Playwright harness driving games through `window.__tri` state, and a
  server-side oracle for a "strong player".
