## 2026-11-24 -- The Live button after any scroll up, and a triple-click's line across a change of the columns (aicc_planning#421, #422; beta.17 C10)

Both were seen by the beta.17 VM line for C5b on the C5b head and on the published beta.16
(runs tv-b1 and pv-b1; ta-a2 and pa-a2), so they were pre-existing, and both were measured on
the app's xterm (@xterm/xterm 6.0.0 in jsdom) before any fix.

- **#421, cause.** TerminalView set its scrolled-up state (the Live button) only from its wheel
  listener on the element the terminal is opened in, 80 ms after the last wheel event; onScroll
  only cleared it. xterm 6 scrolls with VS Code's scrollable element, which calls
  `stopPropagation()` on every wheel event it moves the view with (scrollableElement.ts
  `_onMouseWheel`: `consumeMouseWheel = didScroll`). So the listener heard a wheel only where the
  view could not move: at the top of the scrollback (why C5's big steps showed the button) or at
  the bottom. Not a harness effect: the stop is xterm's for any wheel that moved its scroll
  position, whatever its step; measured for one row's height (the VM line's step), a mouse notch
  (100 px), a touchpad's fractional steps and a line-mode wheel (terminal-live-button-xterm.test.ts,
  9 tests). jsdom's WheelEvent has no wheelDeltaY, so xterm reads deltaY there (-deltaY / 40) where
  Chromium's event has one (wheelDeltaY / 120): the step's size differs from the app's, the stop
  does not. Present since the move to xterm 6 (93eb5de0,
  2026-06-15); hidden while output flowed, because each write samples the view (decideFollow,
  #73) and shows the button.
- **#421, fix.** onScroll, which every user scroll fires (wheel, scroll bar, keyboard: measured),
  now arms the same settled check (one 80 ms timer, shared with the wheel) when the view is above
  the bottom and the button is not shown; at the bottom nothing is armed, so output streaming at
  the bottom costs no timer; back at the bottom the button still goes at once. The old warning
  (onScroll fires during term.write) is kept by the settle: a view that passes above the bottom
  and back within 80 ms never shows the button, and follow is decided from the live view (#73),
  not from this state. The wheel listener is unchanged (its #273 repaint still runs only for a
  wheel at the view's ends; turning it on for every wheel would add an atlas rebuild per scroll,
  which nothing measured asks for).
- **#422, cause.** xterm keeps a triple-click's line as a start and a length, the length being the
  row's width then (SelectionService `_selectLineAt`). A change of the columns alone keeps the
  selection (only a change of the rows clears one, xtermjs/xterm.js#5300), and that length at a
  narrower width runs on into the next row: measured (0,2)-(30,2) becoming (0,2)-(10,3) and the
  copy "$ shell 3\n$ shell 4", the same with C5b's paint through the aligner after it (C5b selects
  it again by its start and length). A drag keeps its end, so its text. A narrowing's re-wrap of a
  longer line above also moves the line a row down under the selection.
- **#422, fix.** terminal/lineSelectionKeep.ts, wired once in TerminalView after `term.open`: a
  selection of whole lines (from column 0 of a line's first row to the row's width on its last
  row: a triple-click's line, a line-mode drag, or a drag from a line's first cell past its last)
  is noted with a marker on its first row and its count of lines (a wrapped line counts once);
  after a change of the columns alone that many whole lines from the marker's row are selected
  again at the new width. xterm moves markers with the rows a re-wrap adds (narrowing, onInsert)
  or joins (widening, reflowLargerCreateNewLayout fires onDelete), so the line is followed both
  ways. A drag over whole rows that are only part of a wrapped line is not a line and is left as
  xterm keeps it (measured on 12510407, which took it for its line: a drag over the first 30 cells
  of a 45-cell line copied all 45 after a widening to 50). A partial drag, Select all and a change
  of the rows (xterm clears it) are left as xterm keeps them; @xterm/headless gets nothing.
- **#422, a clear and the same cells selected again.** C5b's bringRowsDown clears the selection
  with its two sizes and selects the same cells again at once. xterm reports both clears and not
  the selection made again: SelectionService._fireEventIfSelectionChanged compares with the cells
  it last reported, and clearSelection does not reset them. 12510407 dropped its note at the
  clear, so the next change of the columns after a Claude Code paint ran on again (measured:
  (0,2)-(5,3) and "$ shell 3\n$ she" after 30, 20 and 15 columns). A clear now keeps the note
  until the code that cleared it has run (a microtask), and a change of the columns with nothing
  selected drops it. Not longer: later, the same cells selected again without a report can only
  be a hand drag over exactly them (a click's release reports the clear first, so a triple-click
  is reported), and output may have moved other lines under them since. Measured with the note
  kept: typing cleared "L8", a full scrollback dropped two rows, a drag over the same cells (now
  "L10") copied "L8" after a narrowing; with the microtask it copies "L10", a drag kept by its
  cells as xterm keeps any drag. With this, C5b's note "a selection selected again keeps its start
  and length" holds only for a selection that is not of whole lines.
- **Tests.** terminal-line-selection.test.ts (23: 5 measurements, 10 red before (7 with the
  module a no-op; 3 on 12510407: the second change of the columns after the paint, and a drag
  over the first and over the second row of a wrapped line), 8 guards) and
  terminalview-live-button.test.tsx (5: 2 red before on the base TerminalView, 3 guards). Mutants:
  7 of the module on 12510407 and 7 on this head (the note kept past the clearing code; dropped at
  the clear; dropped by the microtask whatever is selected; keep() without its nothing-selected
  check; each half of the whole-lines check; the size never updated), and 5 of TerminalView, each
  red.
- **Not handled.** A partial drag selection below a line that a change of the columns re-wraps
  stays on its row as xterm keeps it (xterm moves no selection with its re-wrap), as before:
  measured, a drag over "$ she" under a 25-cell line copies "xxxxx" after a narrowing from 30 to
  20 columns. The brief kept drags as they are; it is xterm's own behaviour, on beta.16 too.
  Handled since by C11 (aicc_planning#424, 2026-11-24-terminal-partial-selection-keep.md).
