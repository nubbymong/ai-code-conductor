## 2026-11-24 -- A Claude Code tab grown and then narrowed again shows its banner once

Plan 2.1.3-beta.17, section C5 (aicc_planning#414). beta.16 B3's VM line (PR #760, B3 note 1)
read a Claude Code tab grown from 103x27 to 140x28 and maximised back show the top one or two rows
of its banner twice above the screen, 3 of 3; M1's g-ccmain-max on the published beta.14 read the
same.

- **The cause, read from a replay, no VM.** M1's g-ccmain-max (its rows before the size, the size,
  the console's one paint 3 ms after it, 893 characters) written into @xterm/headless 6.0.0 at
  e10278e7. `term.resize(103, 27)` alone moved baseY from 4 to 6, before any output: xterm's
  Buffer._reflowSmaller (node_modules/@xterm/xterm/src/common/buffer/Buffer.ts:446-466) moves the
  top of the screen up one row for each row a re-wrap adds whenever baseY is above 0, whatever
  blank rows sit at the bottom (the screen's bottom 19 rows held no text). The status row and the
  rule above the cursor each took one more row; the rule below the cursor became the cursor's row
  after the first insert and was cut to 103, not re-wrapped (Buffer.ts:372-378). The console kept
  its top row: its paint starts at the banner, whose top two rows xterm now held just above its
  screen, and it was written as it came (beta.16's aligner placed neither way), so they showed
  twice. The aligner was the place: the consoleRepaint.ts header said it did not handle this case;
  TerminalView's resize path and xterm's options were not (TerminalView sets no option that changes
  re-wrapping, console-repaint-after-resize.test.ts pins that).
- **The fix** (consoleRepaint.ts, `bringRowsDown`, a third placement after the two B3 left). A
  paint of the console's whole screen whose top lines are xterm's lines from a row just above its
  screen (top down, at least 2 with text, as `keepRowsAboveTop` matches) brings xterm's rows down
  until that line is its top row, then the paint is written as it came. xterm brings rows down out
  of its scrollback only when its screen gains rows with its cursor on its last row
  (Buffer.ts:189-197), so the screen is cut to the cursor's row and given its rows back (two
  `term.resize` calls at the same width, in the paint's write callback), and the rows brought down
  past the paint's top line go up again by line breaks. The rows the screen gives up are rows the
  paint writes over on today's path too. Bounded by the rows below the cursor; a paint already in
  place, one of fewer rows than the screen, or one found nowhere above is written as it came, the
  terminal untouched. `RepaintTerminal` gains `resize`.
- **Tests.** `tests/unit/renderer/console-repaint-claude-code.test.ts`, 32 tests: g-ccmain-max
  written as it came is still the VM's reading and through the aligner is that reading with the two
  rows once; the published control's maximise back shows its banner once; small terminals for the
  new placement (more and less scrollback than rows below the cursor, a line on the last row, the
  aligner's queue) and for paints left as they came. Red against origin/beta's aligner: 7 of 61
  across this file and console-repaint-after-resize.test.ts. Mutants: the branch dropped (7 red),
  the scroll-back dropped (7 red), the cursor bound dropped (1 red), the in-place check dropped
  (1 red). M1's plain-terminal recordings stay ALL-OK and B3's grow recordings unchanged.
- **Not handled.** A narrowing whose paint starts more rows above xterm's screen than xterm's
  screen has rows below its cursor. **Not checked here:** the app's xterm with its WebGL renderer
  (the two resizes are synchronous, in one write callback; the renderer draws on the next frame);
  C5's VM line reads B3's line on the frozen head.
