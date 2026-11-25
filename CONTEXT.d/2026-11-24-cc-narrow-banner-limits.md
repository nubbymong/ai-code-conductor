## 2026-11-24 -- A narrowed Claude Code tab: its banner once when the console paints its own re-wrap first; a selection and a scrolled-up view kept

Plan 2.1.3-beta.17, section C5b (aicc_planning#414, a follow-up to C5 under "never ship a known
bug"). C5's review and join recorded three limits of its narrowing placement (consoleRepaint.ts,
`bringRowsDown`). Each was measured first; all three were real, and each is fixed.

- **1. A paint holding a line longer than a row.** Measured on C5's VM records (9 recorded
  narrowings of Claude Code's main screen: C5's 8 on its head and on the published beta.16, and
  M1's g-ccmain-max), replayed into @xterm/headless 6.0.0 (each replay gives the VM's reading). 1
  of the 9 came as two paints (pn-pcn1, the published beta.16, a tab started at 140x28 and
  maximised back to 103x27): the console's own re-wrap first, 3 ms after the size, 20 lines over
  27 rows (each full-width rule runs on into the row below with no line break: 7 rows run on), then
  Claude Code's paint 15 ms later. That tab had no scrollback, so nothing showed twice. The same two
  paints on the same tab grown first (pn-pcn1b's grown rows; the re-wrap built from pn-pcn1's, from
  the banner on) show the banner's top two rows twice written as they came, through beta.16's
  aligner and through C5's: the re-wrap has fewer lines than the screen has rows, so C5 wrote it as
  it came, and Claude Code's paint after it was then in place. **Fix:** readPaint keeps each line as
  written (its text and its steps right), and `rowsOfPaint` counts the rows each takes at the new
  width as xterm writes it (a character that does not fit starts the next row; a step right stops
  at the last column; xterm's Unicode 6 widths, `cellsOf`, its table of characters with no cell
  copied from @xterm/xterm 6.0.0's UnicodeV6.ts). `bringRowsDown` places a paint whose rows, so
  counted, are the screen's. A paint of as many lines as rows with one line longer than a row (more
  rows than the screen) is no longer placed (C5 placed it).
- **2. A selection.** Measured on the app's xterm (@xterm/xterm 6.0.0 in jsdom): the window's own
  narrowing clears a selection when its rows change (SelectionService.ts:158-162; B3's maximise
  back, 140x28 to 103x27, changes both), and keeps it when only its columns change (a narrower
  window of the same height, a pane opened beside the terminal). On such a narrowing C5's two
  resizes cleared it. **Fix:** `bringRowsDown` reads it before its resizes and selects it again
  after, by its start and length, its columns cut to the screen's width: every row above the
  cursor's keeps its place in the buffer, and
  the paint writes the lines it was found by on the rows that held them.
- **3. A scrolled-up view.** Measured: C5's resizes moved a view the user had scrolled up by the
  rows brought down (C5's VM record tg-cc2, grown and maximised back, a view 3 rows up: from row 6
  to row 0, the top of the buffer, 13 rows brought down; 5 rows in the tests' 10-row screen);
  written as it came, the view stays. In the app's xterm the scroll bar does not move with it, so
  its next wheel step jumped the view back. **Fix:** `putViewBack`: one step up (the app's xterm
  then takes its view from its scroll bar, as headless has none), then the view's row; at once when
  that row is above xterm's screen again, and in any case once the paint is written (the aligner
  passes `settle` to the paint's write: the line breaks that scroll the rows brought down back up
  do not move a scrolled-up view). Never moved to the bottom on the way: TerminalView's onScroll
  would count the user back at the bottom. So a view whose row is xterm's top row once the rows
  are brought down (the bottom) is put back only once the paint is written, not at once.
- **Tests.** `tests/unit/renderer/console-repaint-claude-code.test.ts` (RECORDED_TWO_PAINTS in
  console-repaint-cc-streams.ts: pn-pcn1 through the aligner is the VM's reading; the grown tab's
  two paints show the banner once; small terminals for the re-wrap, wide characters, a combining
  mark and a paint of more rows; `cellsOf` against xterm's own width for every code point of the
  Basic Multilingual Plane and the ranges above it it lists) and the new
  `tests/unit/renderer/console-repaint-narrow-keep.test.ts` (jsdom: the app's xterm for the
  selection, one dragged past the end of its line among them; the app's and headless xterm for the
  view, 1 and 3 rows up for the bottom). Red on C5's head f1999f08: 17 of 91 across those two,
  console-repaint-after-resize.test.ts and terminalview-console-repaint.test.tsx; green after, 91
  of 91. Mutants, each red, counted on the 89 tests before C5b's review added two: rows counted as
  lines (4), no selection again (3), no view kept (7), no `settle` (3), no step up (1), wide
  characters as one cell (2), no-cell characters as one cell (2). Counted on the 18 tests of
  console-repaint-narrow-keep.test.ts after it: the selection's columns not cut to the width (1),
  `<=` for `<` in the view's at-once check (1), the view moved at once in every case (2).
- **Not handled.** A selection selected again is made by `select` (a start and a length), so one that ended on a line's first cell ends on the last cell of the row before and its copy loses that last line break; its text is kept at a later change of the columns by lineSelectionKeep.ts (aicc_planning#422, #424). `rowsOfPaint` has a limit with input
  no console paint holds. **Not checked here:** the app's xterm in Electron with its WebGL renderer
  (jsdom lays nothing out: the tests measure its cell as 9x17).
  The VM line on C5b's head 5a7cf0f2 ran after this was written: PASS (WINDOWS_1).
