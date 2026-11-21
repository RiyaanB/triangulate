# Requests from `core` to other sessions

## To `visuals` (public/js/cluecard.js, css)

1. **Clue format v2: stage-1 national borders.** Stage-1 data now has `s1.borders: string[]` (SVG path data,
   same 1000x1000 frame as `coast`). Please draw them in stage 1 as a thin dashed line under the coast
   (e.g. `stroke: #f5a3c7; stroke-width: 2.5; stroke-dasharray: 10 7; opacity: .8`), with the same draw-in
   animation as coasts. Borders turn ~60 inland clues from a blank stage 1 into a recognisable shape.
   Until cluecard supports it, `app.js` has a small marked fallback (`drawBordersFallback`) that appends
   them to `card.layers.coast` when `card.supports?.borders` is falsy. Set `supports = { borders: true }`
   on ClueCard when you implement it and the fallback switches itself off.
2. **New label kind `'g'`** in `s4.labels` (`[x, y, text, 'g', size]`, no dot): islands, peninsulas,
   mountain ranges, deserts, deltas. Please style like a terrain label (e.g. warm sand colour `#d8c39a`,
   letter-spacing .04em, slightly smaller/lighter than towns). Kind `'w'` now also includes seas, gulfs,
   bays and straits (not just lakes) — same water style as before.
3. **More scripts in stage 4**: Thai, Lao, Khmer, Burmese, Georgian, Armenian, Ethiopic, Sinhala, Tamil,
   Malayalam, Telugu, Gujarati, Tibetan, Thaana are now possible (`s4.script` holds the family name).
   Please make sure the label font stack falls back to system fonts for these (e.g. `font-family: <yours>,
   system-ui, "Noto Sans", sans-serif`) and that wide/tall scripts (Tibetan, Myanmar) don't clip.
4. `guessmap.js` threw `ellipse(): major-axis radius is negative` during the pin-bounce animation in the
   baseline e2e run (main fixed the `t < 0` case in `animate`; the bounce factor itself can still go
   negative with an overshooting easing — clamp `bounce` to `>= 0`).

5. **New UI hooks created by app.js (please style; they work unstyled with inline fallbacks):**
   - `#title-meta.meta-row` (title screen, under the nickname row): "Lv 3 Backpacker · 2 wins · 🔥 4-day streak · Daily #21 ✓".
   - `#over-meta.meta-row` (game over, under `#over-me`): `+120 XP` (`.meta-xp`), level + `.meta-bar` progress bar, streak.
   - `#btn-share` (game over, next to Play again): copies a Wordle-style result to the clipboard.
   - Banners: `banner('CLOSE CALL', …, { cls: 'close-call', color: '#ffcc4d' })` when you survive the cut by
     < 1200 pts, and `banner('LEVEL UP', …)`. Toast `🎯 Bullseye! +500 · 🔥 3 in a row` on reveal.
   - `#btn-solo` text becomes `☀️ Daily ✓ (replay)` once today's daily is done (original label kept in
     `data-label`).
6. Reveal results now carry `bull`, `bonus`, `streak`, `base` per player — a ghost-pin highlight for
   bullseyes on the guess map would be a nice touch.

## To whoever merges

- `data/raw/` in this worktree is a directory of symlinks to the main checkout's raw layers plus three new
  Natural Earth downloads (`ne_10m_admin_0_boundary_lines_land`, `ne_10m_geography_marine_polys`,
  `ne_10m_geography_regions_polys`). `npm run build:data` downloads anything missing.
