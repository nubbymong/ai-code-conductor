## 2026-11-21 -- The earlier-output notice stays where the tab can keep it

Plan 2.1.3-beta.12, section A1 (aicc_planning#352), a fix on the release PR. The release smoke on
the VM found the notice pushed out of reach: it was written once, before the replay, and a replay
of 2 MiB of plain text is some 28,700 lines, while a tab keeps 10,000 (paging to the top showed a
line of the run, not the notice). Every release text says the tab first shows that line, so the
code was fixed, not the wording.

- **What the app does now** (session-helper/helper-pty.ts). After a gap the replay's text is held,
  not shown, until the offset reaches the reply's `ring_end`. Then, in one piece: the cancel
  character, the alternate screen left whenever the part left out switched it, the attribute reset
  (after the leave, which can restore colours saved when a program entered that screen), the line
  break after output already shown, the notice, the input modes the part left out set or reset,
  and only the tail of the held text that the tab keeps. The budget is the tab's scrollback
  less a screen's rows and the notice's own (at least a screen), so the notice stays in the
  scrollback through the redraw and a screen more of output.
- **How rows are counted** (session-helper/replay-tail.ts, new). The text is read as xterm.js 6
  reads it, as far as rows go: its parser's states (CSI, OSC, DCS, SOS, PM and APC strings, the
  8-bit forms, CAN and SUB; a character past U+009F ends a SOS, PM or APC string, or a DCS one
  before its final byte, and what follows is text, but not a DCS string the tab ignores to its
  end), its Unicode 6 widths, its wrap (a wide character that does not fit the last column wraps
  early) and its cursor (carriage return, backspace, tabs stopping at the last column, the column
  moves, CSI b, a cursor saved and restored). A row is added by a line feed, vertical tab, form
  feed, index or next line, 7-bit and 8-bit, and by a wrap; a bare line feed keeps the column.
  What a program draws on the alternate screen takes no row and the cut never lands there. Where
  it differs from the tab it counts more, never fewer, with three known exceptions: after a program
  sets its own tab stops; a repeat (CSI b) that follows a sequence the tab ignores or ends in error,
  or an 8-bit CSI, string introducer or ST (the tab still repeats the character before it; here it
  is forgotten); and a column counted further than the tab's on the alternate screen (a combining
  character, an emoji, an autowrap turned off), which can wrap there uncounted while the tab wraps
  only after the program left that screen with mode 47 or 1047, at most a row each time. No program
  is known to write the second or the third. Vertical cursor moves add no scrollback row, so they
  are not counted. Memory is bounded by the budget.
- **Where the cut lands.** At a line start; inside a line only when that line alone takes as many
  rows as the budget or more (the last line, or one before a short prompt), or when only empty
  rows follow it, at the start of one of its rows, so the tab never shows the notice alone while
  there is output. Never inside an escape sequence or a character.
- **What goes across the cut.** Leaving the alternate screen whenever the part left out switched
  it (before the notice, so the notice is on the normal screen; with 47 when that part entered it
  first, which restores no cursor, since the tab can still be on it from a program whose leave is
  no longer held) and the DEC private modes that are flags only, each at its last value, in the
  order of their last change; ESC = and ESC > as the keypad mode; a full reset as the modes it
  restores, but for the cursor, which is shown again (the tab's xterm.js leaves a hidden one
  hidden; a shell should not be left without one). Checked on @xterm/headless for a program
  started in the shown part (the tab ends on its screen with its modes, the notice first on the
  normal screen), one that ended in the part left out (the tab leaves its screen and modes, the
  notice within reach), and a tab still on the alternate screen when the part left out entered and
  left it again (the tab ends on the normal screen, the notice there).
- **One constant.** The 10,000 moved to `src/shared/terminal-scrollback.ts`
  (TERMINAL_SCROLLBACK_LINES), read by TerminalView.tsx and helper-pty.ts, so the two cannot drift;
  a test pins the value and both readers.
- **A hold outlives a dropped connection.** The holder closes a connection that falls behind, in
  the middle of a replay too. The hold is kept and the attach again, with no new gap, holds its
  replay to its own `ring_end`, so the whole replay is trimmed as one; with a new gap the old hold
  is shown first, then a new one starts. Every other way out shows what was held, notice first,
  once: the replay's end (the redraw follows, after it), replaced, the program over (before its
  holder is ended), ended, started the usual way, let go of for an update, and the cap, 2 s from
  the hold's start. A fixed cap, not a wait reset by each chunk: a local replay of at most 2 MiB is
  in well within it, and a cap bounds how long a tab can stay blank. It is the one way the notice
  can still go out of reach: a rest that comes after the cap and is longer than the tab keeps is
  not trimmed. A frame that carries the replay's end and live output after it is held whole. Typed
  input and resizes go out during the hold as at any time.
- **Logs.** The redraw's line keeps its exact start. When lines are left out, one more line says how
  many (and when the start of a line is left out too); when the cap fires, one says so. No output
  text in either.
- **Known issues and notes.** A full-screen program now keeps its screen when it started inside the
  last 2 MiB, so the Known issues paragraph and the release line say it is drawn on the normal
  screen only when it started before them.
- **Tests.** tests/unit/main/session-helper-replay-tail.test.ts (new, 27 cases, counted against
  @xterm/headless) and tests/unit/main/session-helper-flow.test.ts (the hold over a drop, an empty
  replay, no `ring_end`, a last line over the budget, the two screen and mode cases). Each new case
  was run against the mutant it guards and went red. Two lines were removed as dead: an empty
  replay's own show (the redraw or the exit's wait shows it at once) and the exit's own show before
  `endHolder` (which shows it first). The hold's own end and the redraw's are the same offset, so
  either alone shows a replay: kept both, so the redraw never goes first.
- **Owed.** Nothing: the A1 VM re-check on the final code (3ccb6995) passed. Nothing under
  helper/ changed.
