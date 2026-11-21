# REPORT — visuals session (branch `worktree-tri-visuals`)

Goal: make TRIANGULATE look and feel striking (clue card, world map, juice, title/lobby/results, mobile).

## Result
- `npm test` (build + 9 unit + bot soak + browser e2e: solo/live/private, desktop 1440x900 + mobile 390x844, reconnect, play-again): **ALL PASSED** on the merged branch (PORT=9141).
- `npm run build:static` → docs/ (233 clues). Served with `python3 -m http.server 9152 -d docs`; headless Chrome at `?speed=4` played a full 7-round, 20-player PLAY match on desktop and on mobile to the winner screen, with no console/page errors (`screenshots/visuals/static-check.mjs`).
- `main` was merged in first (static mode + build1 fixes); conflicts were only in `guessmap.js` / `ui/kit.js` (mine kept, main's clamps re-applied).

## Direction: 3 quick styles → picked "night"
Built as swappable token sets (CSS variables in `ui-kit.css`; the canvas map and SVG clue card read the same `--m-*` map tokens, so a theme restyles everything):
1. **night** (default) — cartographer's night: navy, glowing cyan linework, magenta pin, lime lock-in, corner brackets, mono labels. Matches the mockups session's direction A.
2. **atlas** — warm parchment, ink coastlines, red roads, serif display type.
3. **arcade** — bright purple bg, yellow land, chunky dark outlines (inspired by mockup C).
Picked **night**: highest contrast for glow/juice, reads best at a glance on phones, closest to the mockups' recommendation. The other two are still selectable on the title ("Style: Night / Atlas / Arcade", persisted; `?theme=atlas|arcade` also works).
Comparison shots: `screenshots/visuals/final/d-04-pin.png` (night), `screenshots/visuals/theme-atlas/d-04-pin.png`, `screenshots/visuals/theme-arcade/d-04-pin.png`.

## What changed (files I own)
- **public/js/cluecard.js** — layered cartographic SVG: ocean + concentric *water-ripple lines* around coasts (and inside lakes), land with a lit gradient + procedural tileable hillshade texture (value-noise fBm, NW light, generated once on a canvas), glowing coastline (wide translucent under-stroke, no filters), lakes, rivers with a *stepped taper* toward the mouth + flowing highlight dashes (desktop only), cased roads in a 2-level hierarchy, rail with ties, hatched urban areas popping in, native-script labels with halo popping in biggest-first, neatline ticks, alternating scale bar, redacted coordinates that un-redact at reveal, target crosshair on the answer. Each stage gets a light sweep + a "+ RIVERS" style stamp. Phones: tap the clue to enlarge it.
- **public/js/guessmap.js** — full rewrite: themed ocean gradient, dotted land fill (constant screen-size dots), glowing coasts, dashed borders, Antarctica/polar clip, horizontal world wrap (copies drawn only when zoomed in), cached base layer (pan/zoom redraws only the overlay when static), d3-zoom with *inertia/fling*, +/− buttons, bigger tap tolerance, fit into the area *not* covered by floating panels (`data-map-obstacle`). Pin: bounce drop with squash + landing ripple + idle breathing halo. Lock-in: shockwave, particle burst, floating "×1.6" label (guarded against double-firing). Reveal: target ripples, ghost pins of every other player pop in staggered (bots violet / humans gold, "★ best" tag), faint lines to the truth, my great-circle arc drawn with a glowing head and a *km counter riding the arc*, truth name pill; arcs never jump the antimeridian. Exposes `window.__triMap` itself.
- **public/js/ui/kit.js** — diagonal wipe banners (round intros) + screen shake + red flash (eliminations); countdown ring with per-second bump and body-level urgency state; count-up with tick sounds and a pop; confetti cannons (two sides + top burst, fluttering ribbons, theme colours, fewer on phones); procedural WebAudio (compressor bus, noise whooshes, rising-pitch last-5s ticks, lock thunk+chime, elimination boom, win arpeggio; mute toggle persisted); FLIP leaderboard with ▲/▼ rank-change flashes.
- **public/js/fx/ambient.js** (new) — rotating linework globe with "triangulation" ping arcs behind title/lobby/results (30 fps cap on phones, paused during the game), theme picker, mobile mini-standings strip (mirrors the leaderboard DOM via MutationObserver; tap to open the bottom sheet, tap outside to close).
- **public/css/ui-kit.css** — reusable tokens for 3 themes, buttons (sheen), CTA, cards with corner brackets (glass blur only on hover-capable devices), chips, toasts, wipe banner, ring, shake, reduced-motion.
- **public/css/game.css** — rewritten. Desktop: the world map is full-bleed behind floating clue card (left) and standings (right); lock button centered in the free area. Tablet: standings become a drawer. Phone portrait: clue on top (4:3.1 crop, tap to expand), map below, mini standings strip, full-width 62px thumb LOCK button, standings as a bottom sheet; no backdrop-filter on phones. Lobby slots + "N joined · scanning…" counter, podium with crown + sheen, urgency vignette in the last 5 s.
- **public/index.html** — new structure (theme boot script, globe canvas, bracketed cards, mini-board, icons). **public/favicon.svg** — new mark.

### app.js edits (minimal, marked `// [visuals]`)
1. `sfx.tick(s)` — pass seconds left so the tick pitch rises.
2. `card.showAnswer(m.answer.name, m.answer)` — lets the clue card un-redact its coordinates.

## Before / after
- Before: `screenshots/visuals/before/*.png` (copied from main's e2e run at the start).
- After: `screenshots/visuals/final/` (desktop `d-*` 1440x900, mobile `m-*` 390x844: title, intro, stages 1–4 incl. mid-reveal sweep, pin, locked, reveal, standings, round-2 standings, winner), `screenshots/visuals/static/` (static docs/ build: lobby, reveal, winner), `screenshots/visuals/vp/` (844x390 landscape phone, 768x1024, 1024x768, 1280x720, 360x740), theme comparisons in `screenshots/visuals/theme-*/`, and the regenerated e2e shots in `screenshots/*.png`.

## Visual QA pass (sub-agent)
A read-only finder agent swept 360x740, 412x915, 768x1024, 1024x768, 1280x720, 1920x1080 and 844x390 (scripts + JSON in `screenshots/visuals/qa/`). It found no console errors, no horizontal overflow, and the lock button was always tappable during rounds; it reported 8 layout bugs, all fixed (`screenshots/visuals/qa-fixes.py`) and re-verified with `vp-check.mjs`:
wordmark overlapping the title card (atlas/arcade, landscape phone) · zoom/globe buttons under the result card (now hidden outside the guessing phase) · cramped landscape-phone clue card (new short-landscape rules) · stage labels ellipsized at 1024–1280 (container query hides labels on narrow clue cards) · skip bar over the result card (moved to top) · mini-board and lock button hiding parts of the fitted map (now `data-map-obstacle` top/bottom) · game-over card taller than short screens · minor: arcade tagline contrast, dangling footer "·".

## Known issues / notes
- World basemap (`data/world.json`) is coarse, so very close reveals look angular; reveal zoom is capped at 14× fit to limit this.
- Stage-4 data for some Latin-script countries uses transliterated non-Latin labels (e.g. Hebrew for Venezuela) — content choice owned by core.
- Custom display/mono fonts are not bundled (system fallbacks: Bahnschrift/DIN/Arial Narrow, ui-monospace) to keep load size small.
- UI JS+CSS grew from ~48 KB to ~116 KB uncompressed (~25 KB gzip); no new assets or dependencies.

## Reusable
- `ui-kit.css` + `ui/kit.js`: themeable .io UI kit (tokens, buttons, cards, banners/shake, ring, count-up, confetti, WebAudio sfx, FLIP lists) — game-agnostic.
- `guessmap.js`: drop-in themed world pin-map (wrap, inertia, obstacle-aware fit, reveal arcs).
- `cluecard.js` hillshade generator + ripple-line technique, `fx/ambient.js` globe background.
- `screenshots/visuals/shoot.mjs` / `static-check.mjs`: screenshot + full-match drivers.

## Time
Session 1 (~30 min before the pause): exploration, kit/cluecard/guessmap/ambient rewrites. Session 2 (~2.5 h): merge with main, game.css, screenshot-driven fixes, 3 themes, `npm test` ×2 (all passed), static build check ×2, QA sweep + fixes, report.

## Servers / hygiene
Test servers used ports 9137 (app), 9141 (npm test), 9152 (static docs/); all stopped. `node_modules` and `data/raw` are symlinks to the main checkout and are git-ignored (`node_modules`, `data/raw` without trailing slash). Scratch screenshot runs (`screenshots/visuals/r1..r4`, `qa/*.png`) are ignored via `screenshots/visuals/.gitignore`.
