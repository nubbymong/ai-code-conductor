## 2026-11-23 -- A Claude Code tab that grows keeps the rows above its banner

Plan 2.1.3-beta.16, section B3 (aicc_planning#404). beta.15's VM line (vm:A1, the same on the
published beta.14) read a Claude Code tab grown from 103x27 to 140x28 lose the 11 PowerShell rows
above Claude Code's banner: after the grow they were neither on screen nor in the scrollback.

- **The cause, read from a replay.** M1's recorded Claude Code tab (g-ccmain and g-cctrust, each
  grow and max, byte for byte, from the rows the VM read before the size) and the published control
  of A1's line (pg-pcc: its screen before the grow as the VM read it, its paints rebuilt from
  g-ccmain's with that session's version and suggestion, 971 and 892 characters, the recorded
  lengths) were written into @xterm/headless 6.0.0; each gives the VM's reading row for row. Claude
  Code draws its screen again at the new size, so the console's paint starts at the banner and its
  lower lines (Claude Code's rules and status row at the new width) are not xterm's rows. Per
  recording, at 9bfcf0b6: pg-pcc's grow returns null at consoleRepaint.ts:273 (the bottom-up line
  check) and is written as it came, from xterm's top row down over the shell's rows: the 11 rows
  lost; g-ccmain's grow and max return null at :273 too and lose nothing (its shell rows were
  already above xterm's screen); g-cctrust's paints are never looked at (painted with the cursor
  hidden, no `ESC[?25l` or `ESC[?25h`): the shell's rows with text are kept, and one blank row under
  them takes the console's blank top row.
- **The fix** (consoleRepaint.ts, `keepRowsAboveTop`). When the bottom-up placement does not apply,
  the paint's top lines are looked for top down on xterm's screen, from its top row to the row
  above its cursor: the first row where they begin, with at least 2 lines with text in common
  before the first line that differs. A match on the top row is a paint already in place, written
  as it came (the review found the search started on the second row: a block shown twice, the
  upper copy on the top row, moved 4 rows that the paint drew again). Otherwise xterm's rows above
  that row go to its scrollback, then the paint is written as it came. Rows above the first such
  row are not on the console's screen, so none is painted again. pg-pcc: the 11 rows (9 at 140 columns) are the scrollback, the banner is
  xterm's top row, and the screen and cursor are as the paint left them. Every other paint is
  written as before.
- **Tests.** `tests/unit/renderer/console-repaint-claude-code.test.ts` (20 tests, fixture
  `console-repaint-cc-streams.ts`): each recording whole and the VM's reading on both paths;
  pg-pcc's shell lines lost today and kept once each through the aligner; small terminals for the
  new branch and for paints still written as they came, among them a block shown twice with the
  upper copy on xterm's top row, and the alternate screen holding the program's rows (so only its
  type stops the branch). Red against the aligner at 9bfcf0b6: 5 of 20. Mutants measured at the
  first head (19 tests): the branch dropped (5 red), 1 line with text instead of 2 (1 red), the
  cursor bound dropped (1 red), bottom up instead of top down (1 red). Mutants measured on the
  review fix (20 tests): the search from the second row (the first head's code, 1 red), the
  top-row null dropped (2 red), the alternate screen's type check dropped (1 red). M1's
  plain-terminal recordings (`console-repaint-after-resize.test.ts`) stay ALL-OK.
- **Recorded, no code.** The two-step plain-terminal grow (off2-grow, 103x27 to 140x24 to 140x28)
  loses its 1 oldest line (6660, 3 rows at 103 columns) on both paths, as it came and through the
  aligner: 27 to 24 rows with the cursor on the bottom row moves 3 rows into a scrollback already at
  its 10,027 rows. That is the scrollback cap (src/shared/terminal-scrollback.ts) at work.
- **Not handled.** On a narrowing (the window maximised again), xterm re-wraps Claude Code's rules
  and status row and moves the banner's top two rows to its scrollback before the console paints
  them again: they show twice above the screen (g-ccmain-max reads the same on the published
  beta.14). Rows do not come back out of xterm's scrollback, so the aligner cannot undo it. With the
  shell rows now kept, pg-pcc's maximise back shows it too, where before nothing was above the
  banner. **Not checked here:** a grow in two steps on A1's head (vm:A1 kept the lengths of its
  three pieces of output, not their bytes); B3's VM line reads it.
