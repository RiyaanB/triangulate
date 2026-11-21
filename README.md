# TRIANGULATE

A live geo-guessing battle royale played from **map shapes alone**. Each clue is a real place shown as a
framed map snippet that reveals in 4 timed stages — **coastline → rivers → roads → place names in a
non-Latin script**. Drop a pin on the world map and lock in: the earlier you lock, the bigger the
multiplier (×2.0 / ×1.6 / ×1.3 / ×1.0). After rounds 2–6 the bottom 20 % are eliminated. 7 rounds,
last ones standing win.

## Run

```bash
npm install
npm run build:data   # downloads Natural Earth (~60 MB raw, gitignored) and builds clue packs (~15 s)
npm start            # http://localhost:8787  (PORT env to change; binds 0.0.0.0)
npm test             # build data + unit + bot soak + headless-Chrome e2e; screenshots -> ./screenshots/
```

Built clue packs are committed, so `npm start` works right after `npm install`.
`npm test` flags: `--no-build`, `--skip-soak`, `--skip-e2e`. Env: `TEST_SPEED` (default 4), `TRI_SPEED`
(speed up all server timers, e.g. for demos). Solo accepts `?speed=N`.

Behind a reverse proxy / tunnel: all asset and WebSocket URLs are relative to the page
(`new URL('ws', location.href)`, `wss:` on https), so it also works under a path prefix. Health check: `/healthz`.

## Modes

- **PLAY** – public matchmaking: joins an open lobby or creates one; a 12 s countdown, bots trickle in and
  fill to 20 at start; every human who joins replaces a bot.
- **Daily solo** – 5 clues vs 9 bots, runs fully in the browser (works with no WebSocket). Same clues for
  everyone on a given day; "Play again" gives a random practice run.
- **Private room** – 4-character code / invite link (`?room=CODE`); the host starts, with an optional "fill with bots" setting.
- After game over, **Play again** returns everyone to the same room.

Reconnects: the client keeps a session token and reconnects automatically (inputs sent while offline are
queued). A player who leaves mid-round just scores 0 for that round. Empty rooms are closed after a grace period.

## Architecture

```
tools/            build-data.js (offline clue-pack builder), locations.js (233 hand-picked places)
lib/mapdata/      REUSABLE map pipeline: shapefile loader, rect clipping, Douglas–Peucker, local projection,
                  compact SVG path encoding (snippet.js / geometry.js / loader.js)
lib/rooms/        REUSABLE WebSocket lobby: matchmaking, private codes, reconnect tokens, heartbeat, rate limit
shared/kit/       REUSABLE browser+node utils: seeded RNG, virtual-time Scheduler (speed-up/skip), geo math,
                  bot framework (names, skill profiles)
shared/game/      TRIANGULATE rules (scoring, elimination, bot error model) + authoritative room engine
                  (transport-agnostic: runs on the server for LIVE, in the browser for SOLO)
server/           http static server + ws wiring; clue source (answers stay server-side)
public/css/ui-kit.css, public/js/ui/kit.js   REUSABLE dark .io UI kit (buttons, cards, toasts, banners,
                  countdown ring, count-up, confetti, WebAudio blips, FLIP list animation)
public/js/        app.js (screens/HUD), cluecard.js (SVG stage renderer), guessmap.js (canvas Mercator + d3-zoom),
                  net.js (WS + local connections)
public/vendor/    d3.min.js (vendored, no CDN at runtime)
tests/            unit.test.js, soak.mjs, e2e.mjs, run-all.js
```

**Answer secrecy:** live clues live in `data/build/` (not served). Clue geometry is projected into a
1000×1000 local frame (no lat/lon), and the server sends each stage only when it is revealed. The answer
arrives with the `reveal` message. Solo clues are a separate pool (`public/data/solo/`), with lightly
obfuscated answers. A test checks that no live clue is ever exposed statically.

**Protocol** (JSON over `/ws`). Client → server: `join{mode,name,code?,token?}`, `pin`, `lock`, `start`, `again`,
`leave`, `ping`. Server → client: `welcome`, `snap` (full state, used on join and reconnect), `players`, `lobby`,
`intro`, `round`, `stage`, `lock`, `locked`, `ending`, `reveal`, `standings`, `over`.

**Bots:** each bot has a skill and an aggression level. Per round it picks a lock-in stage (aggressive bots
lock early) and a guess that is offset from the truth by a log-normal distance (median depends on clue
difficulty × stage × skill). There is also a small chance of a "wrong continent" miss. Most bots are average
or worse and a few are sharp, so a decent human can win. Bots are always tagged 🤖.

**Scoring:** `round(5000 · e^(−d/1500 km) · stageMultiplier)`. An unlocked pin at time-out counts at ×1.0.

## Static version (GitHub Pages, no server)

`npm run build:static` writes a server-free site to `docs/`. It contains the client, the shared game engine and all clue packs (233 clues). **PLAY** runs a full 20-player match against in-browser bots (the same room engine the server uses, running locally), and **Daily solo** works the same as before. Private rooms need the Node server, so they're hidden in the static build. Preview it locally with `npm run serve:static` (http://localhost:8810). For GitHub Pages, publish from the `main` branch, `/docs` folder. Note that answers in the static build are only lightly obfuscated, as in solo mode.

## Data & license

All map data is from [Natural Earth](https://www.naturalearthdata.com/) (public domain): 10m land and
minor islands, lakes (+ Europe/N. America supplements), rivers (+ supplements), roads, railroads, urban
areas, populated places (localized `name_xx` fields), plus 50m land, lakes and borders for the world map.
Credits line in the UI: "Map data: Natural Earth (public domain)". d3 is ISC-licensed.

Stage-4 labels use the local script for countries that Natural Earth covers (Cyrillic, Greek, Hebrew,
Arabic, Persian, Urdu, Devanagari, Bengali, Chinese, Japanese, Korean). For countries whose local script is
Latin, or not available (Thai, Khmer, Sinhala, Amharic, …), names are shown **transliterated into a
foreign script** (e.g. Dallas in Chinese characters) and marked "transliterated, not local". Latin names
are never shown.

Code: MIT (see LICENSE). Map data: Natural Earth, public domain.
