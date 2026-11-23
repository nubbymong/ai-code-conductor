## 2026-11-22 -- A restored terminal whose window changed size gets its replay at the holder's size

Plan 2.1.3-beta.14, section C8 (aicc_planning#392, from #374 P3.1). With "Plain terminals through
the session helper" on, a restored terminal's replay waits for its tab to reach the holder's size
(2.1.3-beta.13). When the window changed size between the two runs the tab never gets there: the
wait ended at its cap and the replay was written at the tab's size, so a Windows console's long
lines came back broken.

- **Main** (session-helper/helper-pty.ts). At the cap, a replay still held is counted at the
  holder's size, the cursor's row followed, and the tab is told that size and the replay's length
  just before the replay (`setReplayAtHolderSizeNotice`). Nothing goes to the holder until the tab
  gives its size after the write and the fit; then the redraw after a gap, or the take-over's one
  resize, goes at the tab's size. A tab that gives none within 3 s (`FIT_WAIT_MAX_MS`) has its last
  size used. A tab narrower than the holder rewraps each row into up to ceil(holder columns / (tab
  columns less 1)) rows, so the replay's budget is cut to what still leaves the notice in the
  tab's scrollback after the fit: such a tab keeps fewer rows (half, from 103 to 93 columns).
- **The carrier** (shared/replay-at-holder-size.ts, ipc-channels.ts, the preload, ipc/pty-handlers.ts).
  One main-to-renderer channel per session, `pty:replayAtHolderSize:<id>`, carrying `{cols, rows,
  length}`. The replay itself still goes on `pty:data`, right after it, to the same window, so
  pty-manager.ts's data path (its stale-process guard, the integrity count) is unchanged. The PTY
  handlers set the notice with the app's window.
- **The renderer** (TerminalView.tsx). The next chunk of that length, and only that one, is written
  with the terminal resized to the holder's size; once xterm has parsed it, the terminal is fitted
  to the tab and the tab's size goes to main even when it equals the size last sent. No other fit
  runs and no size goes to main meanwhile. A hidden terminal writes what it queued first.
- **As before.** A tab at the holder's size, a holder with no screen reads, a read that fails, and
  a run with no window to tell.
- **Tests.** tests/unit/main/session-helper-replay-at-holder-size.test.ts (main, and what the tab
  shows after the fit in @xterm/headless: every kept line whole, the notice the first row),
  tests/unit/renderer/terminalview-replay-at-holder-size.test.tsx,
  tests/unit/main/pty-handlers-replay-at-holder-size.test.ts.
