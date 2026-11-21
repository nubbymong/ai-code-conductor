## 2026-11-21 -- A restored held terminal's replay waits until the tab is at the holder's size

Plan 2.1.3-beta.13, section A1 (aicc_planning#374, P1.1 to P1.3). The beta.12 VM check of "Plain
terminals through the session helper" saw kept long lines come back broken up in 2 of 6 restores.
A Windows console's output is right only at the size it was made for, and the replay was written
at the tab's first size, which can differ for a moment from the one it settles at.

- **The renderer** (TerminalView.tsx `fitAndSpawn`). The first fit, and so the PTY's size, waits
  for the pane's renderer. The WebGL addon is attached by its own effect, which runs after the
  terminal is built; a fit that won that race measured the DOM renderer's wider cell (93 columns
  where WebGL fits 103). An active pane with GPU rendering on and no WebGL handle yet puts the fit
  off one frame at a time, at most 30 frames. A WebGL that fails to load still leaves a handle, so
  that pane fits at once on the DOM renderer. GPU rendering off, and an inactive pane, fit at once
  as before.
- **Main** (session-helper/helper-pty.ts, manager.ts, connection.ts). A plain terminal's
  connections ask for `screen`. A take-over reads the holder's size with `screen.read` before it
  attaches (`readScreen`, read strictly by the existing `readScreenRows`). While the program runs
  and the tab is not at that size, the replay is held, cut or whole, and no size goes to the
  holder, so it never redraws for a size the tab only passes through. The hold ends when the
  replay is all in and the tab is at the holder's size, or at the size wait's own cap
  (`SIZE_WAIT_MAX_MS`, 2,000 ms from when the size is known); then the redraw after a gap, or the
  take-over's one resize, goes out as before. A whole replay is shown as it is, with no notice.
  A kill, an exit, a replaced connection, a fallback or a release shows what was held at once, as
  before.
- **Logs** (P1.3). One line when the tab reaches the holder's size, with the time from the spawn
  (what the VM line reads in each restore to set the cap from the longest with a margin), or one
  line with both sizes when the cap ends the wait. The line about the oldest lines left out of a
  cut replay names the size the rows were counted at.
- **As before.** A holder without the screen reads, a read that fails, a tab at the holder's size
  from its start, and a program that is over before the attach: the replay is shown as it comes.
  A window whose size changed between the two runs (#374 P3.1) still gets the replay at the tab's
  size, after the cap.
- **Tests.** tests/unit/renderer/terminalview-renderer-wait.test.tsx (new) and the take-over block
  in session-helper-flow.test.ts, with the fake holder answering `screen.read`; one manager test
  and one connection test. Each was shown red against the old code and under the plan's mutants.
