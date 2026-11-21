## 2026-11-21 -- The earlier-output notice stays where the tab can keep it

Plan 2.1.3-beta.12, section A1 (aicc_planning#352), a fix on the release PR. The release smoke on
the VM found the notice pushed out of reach: it was written once, before the replay, and a replay
of 2 MiB of plain text is some 28,700 lines, while a tab keeps 10,000 (paging to the top showed a
line of the run, not the notice). Every release text says the tab first shows that line, so the
code was fixed, not the wording.

- **What the app does now** (session-helper/helper-pty.ts). After a gap the replay's text is held,
  not shown, until the offset reaches the reply's `ring_end`. Then, in one piece: the cancel
  character, the attribute reset, the line break after output already shown, the notice, and only
  the tail of the held text that the tab keeps. The budget is the tab's scrollback less a screen's
  rows (at least a screen), so the notice stays in the scrollback through the redraw and a screen
  more of output. Rows are counted, not lines: a line takes ceil(width / cols) rows, at least 1,
  where the width leaves out escape sequences and carriage returns, a wide character counts two
  columns and a tab moves to the next multiple of 8. The cut is only ever at a line start, and a
  line break inside an escape sequence (an OSC string can hold one) is no line start. The last line
  is kept even when it alone is over the budget.
- **One constant.** The 10,000 moved to `src/shared/terminal-scrollback.ts`
  (TERMINAL_SCROLLBACK_LINES), read by TerminalView.tsx and helper-pty.ts, so the two cannot drift.
- **Every way out shows what was held**, notice first, trimmed the same way, once: the replay's end
  (the redraw follows, after it); the connection closing or dropping (the attach again goes on from
  the last byte seen, with no second notice); replaced; the program over (before its holder is
  ended); ended or let go of for an update; and a safety cap, 2 s from the hold's start. A fixed cap,
  not a wait reset by each chunk: a local replay of at most 2 MiB is in well within it, and a cap
  bounds how long a tab can stay blank whatever pace the bytes come at. A frame that carries the
  replay's end and live output after it is held whole. Typed input and resizes go out during the
  hold as at any time.
- **Logs.** The redraw's line keeps its exact start. When lines are left out, one more line says how
  many; when the cap fires, one says so. No output text in either.
- **Tests.** tests/unit/main/session-helper-flow.test.ts, twelve new cases on the fake holder, which
  gains `stallReplay` (a replay whose end never comes). Each failed on the old helper-pty.ts.
- **Owed.** The A1 VM re-check at the release smoke (orchestrator). Nothing under helper/ changed.
