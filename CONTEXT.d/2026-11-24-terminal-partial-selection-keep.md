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
  clears it) and C10's clear-then-same-cells microtask behave as C10 had them; an end whose line
  was trimmed off the top is not selected again (and see the third review item below);
  @xterm/headless gets nothing.
- **Not handled.** xterm's public `select` takes a start and a length, so a selection it has to
  select again cannot end on a line's first cell (a drag down to a row's left edge, whose copy ends
  with the line break before that line): it ends on the last cell of the row before, the same cells,
  and the copy loses that last line break (measured: "$ shell 3\n$ shell 4\n" becomes
  "$ shell 3\n$ shell 4" when a narrowing moves those lines; SelectionModel.finalSelectionEnd ends a
  length at a row's end). Only when the lines moved: with nothing moved it is left exact. C5b's
  selecting again after its paint has the same limit. Ending it there needs xterm's private
  selection model, which the app's code does not touch.
  A selection on the top rows of a full scrollback is not kept through a narrowing: xterm's trim
  (one row for each row the re-wrap adds) takes its rows above row 0. xterm clears a drag there,
  with no event, though its line may still be in the buffer lower down (measured by the fixer: the
  full 50 + 10 row test buffer narrowed 40 to 39 pushes 12 rows off; a drag on row 11 is cleared,
  its line now on row 2; from row 12 down the text is kept, where xterm alone copies other text).
  How many rows that is depends on how much re-wraps (measured on xterm alone at 140x28 with 10,000
  rows of scrollback, 30% of the lines 200 cells long, 140 to 100 columns: the trim is 2,354 rows,
  and the lines that were on rows 1,908 to 2,353 are still in the buffer). Keeping it needs a hook
  into xterm's resize. Any other selection there is cleared too (the third item below), so nothing
  else is copied.
- **Found in review (review:C11), fixed on this branch.**
  - *A full scrollback.* In a tab whose scrollback is full (any long session), a narrowing selected
    other text again, for a drag and for a triple-clicked line. Cause, in xterm 6.0.0
    (Buffer._reflowSmaller): it lays rows out from the bottom and stops at row 0, so it fires an
    insert only for added rows that stay in the buffer, while its trim counts every added row; every
    marker left is then as many rows above its line as rows were added among those pushed off the
    top. Measured by the review at the app's size (140x28, 10,000 rows of scrollback, 12,000 lines,
    one in twelve as wide as the screen, 140 to 120 columns), a drag over "line 11993": af3fa861
    copies "line 11934", 64 rows above its line; the fix, 0 rows; xterm alone, 835. In the test (a
    full 50 + 10 row buffer, a drag over " 197 " narrowed by one column), af3fa861 gives
    `expected [ 4, 54, 9, 54 ] to deeply equal [ 4, 56, 9, 56 ]` and copies "-----" (the rule line
    above it); a triple-click there copies the rule. Fix: a marker kept on the first row of the
    buffer's last line while a selection is noted (set at the note and after each write, through
    `onWriteParsed`). That line stays the last through a narrowing, so its marker is off by the same
    count as every other, and both ends are placed that many rows down. Only on a narrowing: a
    widening fires every delete, and a narrowing of a buffer with room pops blank rows off its
    bottom, so the count is clamped at 0. A note whose ends are off and that has nothing to select
    again is dropped.
  - *A drag in progress.* xterm reports a selection only at the release, so during a drag the note
    was still the selection before it. A change of the columns then (a pane opening beside the
    terminal by itself, such as the Agent Canvas) selected the earlier one again, removed xterm's
    drag listeners, and the rest of the drag and its release did nothing. Fix: while the left button
    (the only one xterm drags a selection with) is pressed in the terminal and not yet let go, a
    change of the columns drops the note and selects nothing again. The release is heard by a
    once-only listener on the document, added per press, so nothing stays on it.
  - *A selection a trim takes above row 0* (the review's re-check of 0e7b7eeb; fixed on
    fix/terminal-selection-trim-clear). In a full scrollback other text stayed selected when output
    or a narrowing's trim took a selection's rows above row 0. Cause, in xterm 6.0.0
    (SelectionModel.handleTrim): it clears only a selection that has an end (a drag). One made by a
    start and a length (a triple-clicked line, and every selection this module or C5b selected again
    with `select`) is never cleared: its start is moved to row 0 and its length kept. xterm disposes
    the note's markers in the same trim, so keep() forgot the note and left that row-0 selection.
    Measured by the review on 0e7b7eeb (the full 50 + 10 row buffer, each of its 40 short lines in
    turn): a triple-clicked line narrowed 40 to 20 copies other text in 35 of 40
    ("ion\n--------------------"); a drag kept once (40 to 39) and pushed off by 80 lines of output
    copies "r 21", where xterm alone has nothing selected; in 320 random sessions 64 of 621 checks
    left other text. Fix: when a trim disposes the end's marker (the first row of the end's line
    went off the top), the note goes and the selection is cleared, unless a drag is in progress
    (xterm's). forget() drops the note before it disposes the markers, so its own disposals are not
    taken for xterm's. xterm disposes a marker on a row a program erases (ESC[J, ESC[2J:
    InputHandler._resetBufferLine, Buffer.clearMarkers) or deletes (delete line, scroll up: a
    splice) too, and leaves the selection on its cells. The first version of this fix took any
    disposal for a trim (found by the review's second re-check of c1bba4aa): a selection in view was
    cleared whenever a program erased its rows, even when it painted the same text again on the same
    rows (8 of 8 cases, where xterm alone keeps it), and when a delete or a scroll up took the
    start's marker it was selected again from the buffer's first row, taking in the whole scrollback
    above. Only a trim is acted on now. A marker on the buffer's first row, registered ahead of the
    ends' markers when a selection is noted, tells them apart: xterm disposes a trim's markers in the
    order they were registered, and any trim takes that row, while an erase of the screen does not
    reach it or reaches it after the selection's rows. When an end's marker goes and that one is
    still there, the note goes and the selection stays as xterm keeps it. After a write whose trim
    took that marker but left the note, the note is taken again, so a new one is again ahead of the
    ends' markers. Measured by the fixer, the 10 new tests (below): red on c1bba4aa `Tests  8 failed
    | 64 passed (72)` (the 2 guards pass there), 72 of 72 with the fix. Replayed with a selection
    made in view (a drag and a selected row, on two rows of each screen), the repo's 11 after-reply
    recordings in helper/fixtures/screens (each span of output that erases the display; 136 checks
    from 4 Claude Code and 5 Codex recordings, the other 2 have no row with text there) and
    console-repaint-cc-streams.ts's 5 Claude Code recordings (each paint after its size, plain and
    through the aligner; 56 checks): this branch matches xterm alone and C10's head 3fb3e921 in 192
    of 192; c1bba4aa cleared 20 that all three leave selected (Codex's redraw after a size change,
    the lower row, its cells then blank). Not covered (measured by the review): one write
    that both pushes rows off the top and then erases the selection's rows is still read as a trim,
    and the selection is cleared where xterm alone keeps it; likewise an erase of a selection whose
    end's line is the buffer's first row (the first-row marker is on that row, and goes first).
    When output takes only the start's line, the rest is kept: a drag over three lines kept once
    ran on past its end (copied "...line 197 of the session\nline 198 " where "...line 197 " was
    selected). xterm keeps a drag's end and moves its start to row 0, its column kept: left so and
    noted again, so a
    later change of the columns keeps it. One made by a start and a length runs on: selected again
    from row 0, column 0, to the noted end, once the trim is over (xterm moves the end's marker
    after the start's, so a microtask). A first drag's rest so loses the cells of row 0 before its
    start's column, where xterm's comment says column 0; left as xterm keeps it. In a narrowing a
    start's marker the trim disposes does not mean its line has gone (every marker it keeps is left
    rows above its line), and the rest from row 0 took in text above the start (measured by the
    fixer: a drag from row 10 narrowed 40 to 39 kept 40 dashes where 35 were selected, its rule line
    still on rows 0 and 1; kept once and narrowed 39 to 20, from rows 35 and 36, it took in the five
    lines above), so keep() clears it there, as for an end's. Measured by the fixer on three-line
    drags from each of rows 0 to 47, seven plans (40 to 39; 40 to 20; kept once then 20; kept once
    then 30; output; kept once then output; kept once, output, then 30): other text 105 of 336 on
    0e7b7eeb, 0 of 336 with the fix; kept once then output, the rest from (0,0) in 37 of 48, where
    0e7b7eeb copies other text in 37 (the other 11 are cleared at 39; on 0e7b7eeb 10 are, and one
    copies other text).
- **Tests.** terminal-line-selection.test.ts, 72: C10's 4 measurements, 5 new ones (above), C10's
  18 keep tests and 18 new, 7 from the review round, 10 from its re-check and 10 from its second
  re-check. One of C10's changed:
  a drag over a wrapped line's second row asserted that nothing was selected again (the bug); it
  now asserts its text ('w' x15, at (10,2)-(20,3)).
  C10's "$ she" measurement moved to the new block and runs on xterm alone (with the module wired it
  is now kept). Red on the base 3bacadfc: 13 of 45 (the changed one and 12 new); the other 6 new
  are guards (a cursor's line, the alternate buffer, a drag ending on a line's first cell with
  nothing moved, empty cells mapped to nothing, Select all across a widening, a trimmed first line).
  Mutants, each red: the wide character's empty cell counted (2), the cursor's line taken as
  re-wrapped (2), the alternate buffer taken as re-wrapped (1), no clamp on a line's last row (13),
  no clamp of a column past a row's cells (1), selected again when xterm already has it (2), not
  noted again when nothing fired (1), a trimmed line selected again (2), past the line's end kept
  as a count (2), a start on a row's end kept on the row before (1), Select all noted (1), an
  empty range selected (1).
  The review round's 7: a full scrollback (a drag narrowed by one column, widened back and narrowed
  to 25; a triple-clicked line; output after the drag; a program screen whose last row is as wide
  as the screen; a drag over empty cells narrowed below its start and widened back), a drag in
  progress, and the right button held (a guard). Red on af3fa861: `Tests  6 failed | 46 passed
  (52)`, the 6 that test the two fixes; the right-button guard passes there. Mutants on the fix,
  each red (failed of 51, before the guard was added): the count always 0 (5), no `onWriteParsed`
  listener (1), the buffer's last row instead of its line's first row (1), the count on a widening
  too (9), no clamp at 0 (11), no bottom marker at the note (4), an off note with nothing to select
  kept (1), no check of a press in progress (1), a press never noted (1), a press never let go
  (26), no mouseup listener (26); the left-button check dropped: 1 of 52.
  The re-check's 10: the review's 7 (a triple-clicked line a narrowing pushes off; a triple-clicked
  line still in the buffer after 40 to 20; a drag kept once then narrowed to 20; a drag kept once
  then pushed off by output; a triple-clicked line pushed off by output; and two guards: a line
  moved up but not off is kept, a drag in progress while output pushes the noted one off goes on)
  and 3 for the start's line (a drag over three lines kept once, its first line pushed off by
  output: the rest from row 0, column 0; a first drag, output, then a widening: the rest as xterm
  keeps it, kept on its text; a narrowing's trim takes the start's marker while its line is lower
  down: nothing selected). Red on 0e7b7eeb: `62 tests | 8 failed`; the 2 guards pass there.
  Mutants on the fix, each red (failed of 62): no end hook (2), any disposal taken for xterm's (46),
  the note not dropped first (46), cleared during a drag too (1), the note dropped but not cleared
  (5), the start's marker heard for the clear (3), no start hook (2), the start hook run during the
  trim (2), the rest always left as xterm keeps it (1), the rest always from row 0 (2), the rest
  from xterm's start column (1), a narrowing's gone start not cleared (1), a narrowing's gone start
  kept from row 0 (1), the rest not noted again (1).
  The second re-check's 10: 8 for a program's erase or delete (a drag, the screen erased from home
  and the same rows painted again; a triple-clicked line, the screen erased with ESC[2J; a drag
  over four lines, erased from the row under its first line; the alternate buffer; erased, then a
  change of the columns: not selected again; output that trims without reaching the selection,
  then an erase: the first-row marker taken again; a drag over four lines, its first line deleted;
  a drag from the view's top row, the screen scrolled up one row) and 2 guards for the order (a
  triple-clicked line on the buffer's first row, one line of output: nothing selected; three lines
  selected by a start and a length from the buffer's first row, one line of output: the rest from
  row 0, column 0). Red on c1bba4aa: `Tests  8 failed | 64 passed (72)`, the 2 guards passing.
  Mutants on the fix, each red (failed of 72): the end's hook takes any disposal (1), the start's
  hook takes any disposal (2), not noted again after a write that trimmed (1), the first-row
  marker registered after the ends' (6), a trimmed end never cleared (6). With C5b's four
  console-repaint files and C10's terminalview-live-button.test.tsx: 168 of 168 across the 6 files.
