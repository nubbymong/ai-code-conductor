## 2026-11-23 -- A tab hidden before its first fit starts its terminal at its own size

Plan 2.1.3-beta.15, section B2 (aicc_planning#398, from #386's comment of 2026-11-22T18:01:36Z).
beta.14's C5 VM re-check switched through three new tabs in 51 ms: one console host started with
`--width 80 --height 24` while the others read 103x27. `initTerminal` waits for a pane with a
size, but the first fit runs later (after the font wait and one more frame). A tab switched away
from in between is `display: none` (App.tsx), the fit addon has nothing to measure, the terminal
keeps xterm.js's default 80x24, and the PTY started at it.

- **The fit** (TerminalView.tsx `fitAndSpawn`). It checks the pane's size as `initTerminal` does.
  A pane with no size waits a frame at a time and fits and spawns once it is shown, at the size it
  has then. The check comes before the wait for the WebGL renderer, so the hidden wait spends none
  of that wait's 30 frames. A pane on screen goes on at once, as before.
- **The resize observer.** It does nothing for a pane with no size. With only the fit changed, a
  pane waiting hidden for its first fit would send 80x24 to main, and a view that took over a
  running PTY would leave that PTY at 80x24 once shown (the first fit records the tab's size
  without sending it). A hidden pane's fit never changed anything, so a tab hidden after its start
  behaves as before.
- **Tests.** tests/unit/renderer/terminalview-hidden-before-fit.test.tsx, 9 tests: 5 red on the
  old view, 4 guards that pass on it by design (a pane on screen spawns on its first fit frame,
  GPU rendering on and off; a view that takes over a running PTY never resizes it to 80x24; a
  started pane hidden and shown at another size gets nothing from its observer while hidden and
  the new size once shown). The observer check removed: 2 tests red. The size check moved after
  the renderer wait: 1 test red. The observer check made to return for every pane: 1 test red.
- **VM line** (owed on the section's frozen head, not run when this was written): three new tabs
  switched fast by CDP, and a key switch right after a new tab: each console host is to read its
  tab's size, and 12 new tabs are still to start at 103x27.
(The aggregate's fragment records the result once the line has run.)
