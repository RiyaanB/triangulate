# Multi-agent bug hunt (core session)

Process: 4 **finder** agents in parallel (server state machine, client flow, mobile, security/edge cases),
each confirming bugs with repro scripts (`tmp/bughunt/<area>/*.mjs`, git-ignored) → fixes by core →
1 **verifier** agent re-ran every repro against the fixed code (adapting outdated scripts in
`tmp/bughunt/verify/`) → one regression it found (brute-force side door) fixed → regression tests.
Regression coverage: `tests/core.test.js` ("regress: …" tests) and `tests/regress-client.mjs` (browser).

| # | Area | Bug | Sev | Status | Regression test |
|---|---|---|---|---|---|
| S1 | server | Private-room creator's reconnect silently created a NEW room (friends stranded) | high | fixed (server: creator rejoin by code / `expired`; client: reconnect targets the room) | core: creator rejoins SAME room |
| S2 | server | Start ignored forever after everyone dropped during the 3 s countdown (`_starting` stuck) | high | fixed (guard on `phaseEnd`) | core: Start works after drop |
| S3 | server/sec | Resuming a seat never closed the old socket; it could still lock/leave for the new tab | high | fixed (close 4000, owner-only routing) | core: old socket closed, can't act |
| S4 | server | A 1 s blip by the only living human cut the round to ~6 s | med-high | fixed (wait for living humans who haven't LEFT) | core: blip doesn't cut round |
| S5 | server | Lone host with bots off got a 1-round game | med | fixed | core: plays 7 rounds |
| S6 | server | `_loadFails` carried across games | low | fixed | — |
| S7 | server/sec | Re-sending a join with your own token dropped the seat and leaked socket entries | low | fixed | core: own-seat rejoin no leak |
| S8 | server | Start while draining left the lobby on a dead countdown | low | fixed | core: drain + start |
| S9 | server | Leaving mid-game kept you alive (could "win" while gone) | low | fixed (forfeit) | core: leave forfeits |
| C1 | client | Next game in the same room: eliminated/late-join player stuck as spectator; no XP for game 2 | high | fixed (per-game reset in `onLobby`) | browser: next game starts fresh |
| C2 | client | Reload on results screen recorded XP + win twice | high | fixed (server game id `gid`, recorded once per gid) | browser: no double XP |
| C3 | client | Mid-game reload lost earlier rounds from share grid/XP | med | fixed (snapshot carries `hist`) | core: snapshot hist + gid |
| C4 | client | Reload with `?room=CODE` invite link didn't resume the seat | high | fixed | browser: invite-link reload |
| C5 | client | Creator offline > 20 s got a new room | high | fixed (see S1) | core S1 |
| C7 | client | Pin/lock queued offline landed in a later round | med | fixed (round-tagged inputs + stale queue drop) | core: old-round lock ignored |
| C8 | client | Resume session expired 15 min after joining even while active | med | fixed (touch on pong/hide) | — |
| C9 | client | Host crown never moved / no "you're host" toast on migration | low-med | fixed | browser: host migration |
| C10 | client | Resync on results forgot "Play again" was pressed; replayed confetti | low | fixed | — |
| C11 | client | Stale "Next game in Ns" on solo results | low | fixed | — |
| C12 | client | Stage bar showed 100% at stage 1 after an early end | low | fixed | — |
| C13 | client | Spectator score chip "#0 · 0" | low | fixed ("👁 watching") | — |
| C+ | client | Delayed banners/toasts popping over the title after Home; daily replay farming XP | low | fixed (`later()`/`cancelLater()`; daily done → Practice) | — |
| X1 | security | Static `docs/` build ships the live answer pool (cheat lookup) | high* | **by design** (user spec: static build packs all clues); `build:static --solo-only` added for mixed deployments | — |
| X2 | security | Private room codes brute-forceable (~43k guesses/s) | med | fixed (per-IP wrong-code budget, per-IP connection rate; verifier found + closed a side door) | core: brute force throttled |
| X3 | security | Per-IP limits trusted the client-controlled FIRST X-Forwarded-For entry | med | fixed (last entry) | core: XFF test |
| X4 | security | Names could be invisible / bidi / half-emoji | low | fixed | core: names |
| X5 | security | `/ws` accepted any Origin | info | fixed (same-host Origin; `TRI_ALLOWED_ORIGINS`, `TRI_ORIGIN_CHECK=0`) | core: origin |
| M1 | mobile | Landscape phones < 761 px wide: no layout, map + lock below the fold → unplayable | **critical** | **open — CSS (visuals)**, see REQUESTS-core.md | — |
| M2 | mobile | Rotation mid-round/reveal keeps the old map framing (answer under the clue card) | high | **open — guessmap.js (visuals)** | — |
| M3 | mobile | 844x390: game-over buttons below the fold | med | **open — CSS (visuals)** | — |
| M4 | mobile | LEVEL UP banner covered the XP row on phones | low | fixed (toast on phones) | — |
| M5 | mobile | "Waiting for others…" wrapped the big button | low | fixed ("Waiting…") | — |
| M6 | mobile | XP row / title meta / Daily button wrapped awkwardly | low | fixed (nowrap pieces, "☀ Practice") | — |

Checked and clean (finders): path traversal (159 variants), malformed HTTP/WS input, message floods (1008),
no answer leakage in the live protocol before the reveal, XSS (names/codes always via textContent),
128-bit seat tokens, `endRound` idempotence, dispose/timer cleanup, bot fill caps, drain().
