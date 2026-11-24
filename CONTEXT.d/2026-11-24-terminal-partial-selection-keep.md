## 2026-11-24 -- A drag over part of a line keeps its text across a change of the columns (aicc_planning#424; beta.17 C11)

Found by C10 (aicc_planning#422) and there on the published beta.16 too; fixed under "never ship a
known bug". This supersedes the "Not handled" bullet of
2026-11-24-terminal-live-button-and-line-selection.md (C10: a partial drag below a re-wrapped line
"stays on its row as xterm keeps it") and that fragment's "A partial drag ... left as xterm keeps
them"; and the first sentence of the "Not handled" bullet of 2026-11-24-cc-narrow-banner-limits.md
(C5b): any selection C5b selects again is now kept at the next change of the columns.

- **Measured first**, on the app's xterm (@xterm/xterm 6.0.0 in jsdom, no module wired; the
  aicc_planning#424 measurement block of terminal-line-selection.test.ts). xterm keeps a drag by its
  cells and moves none with its re-wrap. A drag over "$ she" under a 25-cell line copies "xxxxx"
  after 30 to 20 columns. A drag over part of a 45-cell wrapped line across its row break
  ("CCCCCDDDDD") copies "CCCCC" at 20 columns and "CCCCCDDDDDDDDDDEEEEE\n$ she" at 50. A drag over
  the ends of two lines ("shell 3\n$ she") copies "xxx\n$ she". Through C5b's Claude Code paint
  through the aligner (it selects the same cells again) the first case still copies "xxxxx". C10's
  whole-lines path left all of these to xterm, and with them a whole-row drag over part of a wrapped
  line (review:C10 F1): over its second row, the copy after a narrowing was the first row's tail.
- **Fix** (terminal/lineSelectionKeep.ts, C10's module; TerminalView only has its comment changed):
  each end of any selection is noted as a marker on the first row of its line and how many cells
  into that line it is: the line's rows counted end to end, less the cell xterm leaves empty at a
  row's end when the wide character after it does not fit (its re-wrap skips that cell:
  BufferReflow.ts, getWrappedLineTrimmedLength). An end past the last cell of its line's last row
  stays past it, so whole lines are selected again exactly as C10 selected them. After a change of
  the columns alone both ends are found again at the new width and selected again when xterm's cells
  differ; when they are the same nothing is selected, so xterm's own drag is left exact. xterm
  re-wraps no line of the alternate buffer and not the line its cursor is on (Buffer.ts;
  TerminalView leaves reflowCursorLine off): an end there keeps its row and column. After each
  change the note is taken again at the new width, so a cursor's line cut by a narrowing is counted
  as it is after the cut when a later widening re-wraps it. Select all, a change of the rows (xterm
  clears it), C10's clear-then-same-cells microtask and an end whose line was trimmed off the top
  behave as C10 had them; @xterm/headless gets nothing.
- **Not handled.** xterm's public `select` takes a start and a length, so a selection it has to
  select again cannot end on a line's first cell (a drag down to a row's left edge, whose copy ends
  with the line break before that line): it ends on the last cell of the row before, the same cells,
  and the copy loses that last line break (measured: "$ shell 3\n$ shell 4\n" becomes
  "$ shell 3\n$ shell 4" when a narrowing moves those lines; SelectionModel.finalSelectionEnd ends a
  length at a row's end). Only when the lines moved: with nothing moved it is left exact. C5b's
  selecting again after its paint has the same limit. Ending it there needs xterm's private
  selection model, which the app's code does not touch.
- **Tests.** terminal-line-selection.test.ts, 45: C10's 4 measurements, 5 new ones (above), C10's
  18 keep tests and 18 new. One of C10's changed: a drag over a wrapped line's second row asserted
  that nothing was selected again (the bug); it now asserts its text ('w' x15, at (10,2)-(20,3)).
  C10's "$ she" measurement moved to the new block and runs on xterm alone (with the module wired it
  is now kept). Red on the base 3bacadfc: 13 of 45 (the changed one and 12 new); the other 6 new
  are guards (a cursor's line, the alternate buffer, a drag ending on a line's first cell with
  nothing moved, empty cells mapped to nothing, Select all across a widening, a trimmed first line).
  Mutants, each red: the wide character's empty cell counted (2), the cursor's line taken as
  re-wrapped (2), the alternate buffer taken as re-wrapped (1), no clamp on a line's last row (13),
  no clamp of a column past a row's cells (1), selected again when xterm already has it (2), not
  noted again when nothing fired (1), a trimmed line selected again (2), past the line's end kept
  as a count (2), a start on a row's end kept on the row before (1), Select all noted (1), an
  empty range selected (1). With C5b's four console-repaint files and C10's
  terminalview-live-button.test.tsx: 141 of 141 across the 6 files.
