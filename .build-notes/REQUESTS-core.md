# Requests from `core` to other sessions

## To `visuals` — open bugs from the mobile bug hunt (your files; details in BUGHUNT-core.md)

- **M1 (critical): landscape phones narrower than 761 px can't play.** At 740x360 / 667x375 the clue card fills
  the screen and the map + LOCK button sit below the fold (no scroll). The phone rules only match portrait and
  the floating layout needs `min-width: 761px`. Suggested fix: lower `min-width: 761px` to `560px` in both
  landscape media queries (and the 761–1100 drawer query); your `max-height: 520px` landscape block already
  sizes things for these screens. Repro: `ONLY_LAND=1 node tmp/bughunt/mobile/quick.mjs` (core worktree).
- **M2 (high): rotating mid-round / mid-reveal keeps the old map framing** (world squeezed into the left 375 px,
  answer under the clue card; rotating back during the reveal shows no land). `guessmap.js resize()` only updates
  zoom limits. Suggested fix: remember the reveal's framed points (clear in `reset()`), re-run `fitPoints`
  without animation in `resize()` when a reveal is showing, else keep the world point at the old free-area
  centre at the same zoom relative to `fitK`.
- **M3 (medium): 844x390 game-over card is 586 px tall**, Play again / Share / Home below the fold. Make
  `.over-btns` sticky at the bottom (solid background) and shrink podium/title in the short-landscape block.
- Nits: at 844x390 the answer tag overlaps the coordinates line in the reveal, and the standings drawer covers
  the right half of the result card; an eliminated player's own row is below the fold of the auto-opened sheet.

## To `visuals` — data/UI hooks from core (still current)

1. **Clue format v2: stage-1 national borders** `s1.borders: string[]` (SVG paths, 1000x1000 frame). The new
   ClueCard doesn't draw them yet; `app.js` has a marked fallback (`drawBordersFallback`) that prepends dashed
   paths (`stroke: var(--m-border)`) into `card.L.coast`. Set `supports = { borders: true }` on ClueCard when
   you draw them natively (ideally with your draw-in animation) and the fallback switches off.
2. **Label kind `'g'`** in `s4.labels` (`[x, y, text, 'g', size]`, no dot): islands, peninsulas, ranges,
   deserts. `app.js` gives them letter-spacing/opacity inline (`styleTerrainLabels`) until `.lab-g` is styled.
   Kind `'w'` now includes seas, gulfs, bays, straits.
3. **Scripts**: stage 4 can be Thai, Lao, Khmer, Burmese, Georgian, Armenian, Ethiopic, Sinhala, Tamil,
   Malayalam, Telugu, Gujarati, Tibetan, Devanagari, Bengali, Cyrillic, Greek, Hebrew, Arabic, CJK, Hangul — or
   **`'Latin'`** for Latin-script countries, which now show their own local names (no more transliteration;
   your "Hebrew for Venezuela" report is fixed in the data). `#script-tag` reads "Local place names" for Latin.
   Khmer and Tibetan render as tofu on this headless box (no fonts) — fine on phones/macOS/Windows; a
   `font-family` fallback to `system-ui, "Noto Sans"` helps Linux desktops.
4. **UI hooks created by app.js** (work unstyled): `#title-meta.meta-row` (title), `#over-meta.meta-row` with
   `.meta-xp` and `.meta-bar` (game over), `#btn-share` (next to Play again), banners `CLOSE CALL`
   (`cls: 'close-call'`) and `LEVEL UP` (desktop; phones get a toast), bullseye toast on reveal, lobby
   `.host-crown` span (moves on host migration), `#btn-solo` becomes "☀ Practice" once today's daily is done.
5. Reveal results carry `bull`, `bonus`, `streak`, `base` per player — a bullseye highlight on the ghost pins
   would be a nice touch.

## To whoever merges / deploys

- `data/raw/` in this worktree is a directory of symlinks to the main checkout's raw layers plus three new
  Natural Earth downloads (`ne_10m_admin_0_boundary_lines_land`, `ne_10m_geography_marine_polys`,
  `ne_10m_geography_regions_polys`). `npm run build:data` downloads anything missing.
- **Answer pool exposure**: `docs/` (static build) intentionally ships ALL clues, and `data/build/` is committed.
  If a public live server ever runs next to a public Pages site / public repo, its answers can be looked up.
  For that setup build the site with `npm run build:static -- --solo-only` and stop committing `data/build/`.
- Behind a reverse proxy on another host set `TRUST_PROXY=1` (default trusts only loopback proxies). If the
  game page is served from a different origin than `/ws`, list it in `TRI_ALLOWED_ORIGINS`.
