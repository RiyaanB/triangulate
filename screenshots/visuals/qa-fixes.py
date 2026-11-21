# one-shot CSS/HTML/JS patch for the QA findings (kept for the record)
p = 'public/css/game.css'
s = open(p).read()


def rep(old, new):
    global s
    assert old in s, old[:60]
    s = s.replace(old, new)


rep(".logo-word { position: relative; margin: 0; font: 800 clamp(40px, 6.4vw, 78px)/1 var(--display); letter-spacing: .07em; white-space: nowrap;",
    ".logo-word { position: relative; margin: 0; font: 800 clamp(30px, 4.2vw, 68px)/1 var(--display); letter-spacing: .07em; white-space: nowrap; min-width: 0;")
rep('[data-theme="atlas"] .logo-word { background: none; color: var(--text); filter: none; letter-spacing: .12em; }',
    '[data-theme="atlas"] .logo-word { background: none; color: var(--text); filter: none; letter-spacing: .06em; }')
rep(".tagline b { color: var(--accent); }", ".tagline b { color: var(--accent); }\n[data-theme=\"arcade\"] .tagline::before { color: #ffd43b; }")
rep(".clue-card { display: flex; flex-direction: column; padding: 10px; gap: 10px; }",
    ".clue-card { display: flex; flex-direction: column; padding: 10px; gap: 10px; container-type: inline-size; }\n@container (max-width: 560px) { .seg .lbl { display: none; } .seg { justify-content: center; gap: 8px; } .seg b { margin-left: 0; } }")
rep(".skip-bar { position: fixed; left: 50%; bottom: 34px;", ".skip-bar { position: fixed; left: 50%; top: 66px;")
rep("#conn-state:empty { display: none; }", "#conn-state:empty { display: none; }\n#conn-state:not(:empty)::before { content: '· '; }")
s += """
/* ================================================================== short / landscape phones */
@media (max-height: 520px) and (orientation: landscape) {
  .topbar { padding: 6px 10px; }
  .topbar .chip { height: 28px; font-size: 11px; padding: 0 8px; }
  .topbar .btn-icon { width: 30px; height: 30px; }
  .game-grid { top: 44px !important; bottom: 18px !important; gap: 10px !important; }
  #scr-game { --clue-w: min(calc(100dvh - 110px), 44vw) !important; }
  .clue-card { padding: 6px; gap: 6px; }
  .seg { padding: 5px 3px; font-size: 10px; }
  .seg b { font-size: 10px; }
  .script-tag { font-size: 10px; padding: 4px 7px; max-width: calc(100% - 64px); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .answer-tag { font-size: 13px; padding: 6px 10px; bottom: 26px; }
  .clue-ring { transform: scale(.72); transform-origin: top right; }
  .clue-stamp { font-size: 15px; }
  .lock-btn { height: 50px; min-width: 230px; font-size: 16px; }
  .result { padding: 10px 12px; } .res-place { font-size: 15px; margin-bottom: 4px; } .res-pts b { font-size: 24px; } .res-row b { font-size: 14px; } .res-best { display: none; }
  #scr-title { padding-top: 14px; }
  .logo-mark { width: 52px; height: 52px; }
}
@media (max-height: 780px) {
  .over { gap: 10px; padding: 18px 20px; }
  .pod.p1 .blk { height: 100px; } .pod.p2 .blk { height: 74px; } .pod.p3 .blk { height: 54px; }
  .pod.p1 .nm::before { font-size: 20px; }
  .over-list { max-height: 20vh; }
  .over h2 { font-size: clamp(26px, 5vw, 38px); }
}
"""
open(p, 'w').write(s)

p = 'public/index.html'
s = open(p).read()
rep('<footer class="credits">Map data: Natural Earth (public domain) · <span id="conn-state"></span></footer>',
    '<footer class="credits">Map data: Natural Earth (public domain) <span id="conn-state"></span></footer>')
rep('<div class="mini-board" id="mini-board" role="button"', '<div class="mini-board" id="mini-board" data-map-obstacle="top" role="button"')
rep('<button id="btn-lock" class="btn btn-cta lock-btn" disabled>', '<button id="btn-lock" class="btn btn-cta lock-btn" data-map-obstacle="bottom" disabled>')
open(p, 'w').write(s)

p = 'public/js/guessmap.js'
s = open(p).read()
rep("""      if (o.dataset.mapObstacle === 'top') { if (r.height && r.bottom > hr.top && r.top <= hr.top + 4) y0 = Math.max(y0, r.bottom - hr.top); continue; }""",
    """      if (o.dataset.mapObstacle === 'top') { if (r.height && r.bottom > hr.top && r.top <= hr.top + 16) y0 = Math.max(y0, r.bottom - hr.top); continue; }
      if (o.dataset.mapObstacle === 'bottom') { if (r.height && r.top < hr.bottom && r.bottom >= hr.bottom - 40 && r.top > hr.top + hr.height * 0.5) y1 = Math.min(y1, r.top - hr.top - 6); continue; }""")
open(p, 'w').write(s)
print('patched')
