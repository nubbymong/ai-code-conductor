## 2026-11-19 -- A held terminal shown again from the middle of its output says so and asks its program to redraw

Plan 2.1.3-beta.12, section A1 (aicc_planning#352). The fix probe P19 handed over (S13). Only a
terminal through a holder changes, and both session helper switches are off by default.

- **When it happens.** The holder keeps the last 2 MiB of output. A held terminal taken over
  again (after a crash, an update on Windows, or Re-attach) always asks for offset 0, and an attach
  again after the holder closed a connection that fell behind (up to 4 MiB waiting) asks for the
  byte after the last one it showed. When the ring no longer holds that offset, the holder answers
  from its oldest byte with `truncated` true. Until now the app moved its offset and nothing more:
  no word that output was missing, and only a resize to the tab's own size, which P19 found makes
  a program redraw only on the ConPTY built into Windows.
- **What the app does now** (session-helper/helper-pty.ts). Before the first replayed byte the
  tab gets the cancel character (a sequence the old stream left half read ends), the attribute
  reset, and one line: "[Earlier output of this terminal is no longer held, so it is not shown.]",
  on a line of its own after output already shown, on the first line of a tab that shows nothing
  yet. Bytes at the replay's very start that continue a character cut in half (at most 3) are
  dropped. Once the offset reaches the replay's end and the program still runs: one resize one row
  shorter than the tab (one taller for a tab one row high), then, 300 ms later, one at the tab's
  size as it is then. The resize an attach sends at the tab's size is not sent as well. A resize
  the tab asks for in between goes out as before. The timer is cleared when the terminal detaches,
  ends, is let go of for an update or is replaced. A redraw still waiting for the replay's end
  when the connection closes (the holder closes one that falls behind in the middle of a replay
  too) is kept for the attach again, which waits for its own replay's end; a cut character whose
  bytes have not come yet still has them dropped. A connection that closes with the second half
  unread leaves the holder one row short, so the attach again sends the tab's size. One log line
  holds the session id and the count of bytes no longer held (both gaps, when an attach again
  finds a second one), never output text.
- **A limit, not in the plan.** The replay can start inside an escape sequence rather than a
  character: the end of that sequence then shows as a few stray characters right after the notice.
  Only cut characters are dropped, as the plan says.
- **Not done, on purpose.** The view is not cleared and no terminal reset is written: on an attach
  again the tab's terminal still holds the modes the program set. No screen is switched and no mode
  is set; the modes come back from the holder's screen in a later step (the plan's orchestrator
  decision). Until then, a full-screen program in a plain terminal taken over again from the middle
  is drawn on the normal screen until it is started again. An attach that is not truncated, and
  follows no gap whose replay a close cut short, is as before. Nothing under helper/ changed, and
  no pane is resized (the redraw goes to the holder).
- **Tests.** tests/unit/main/session-helper-flow.test.ts, on vitest's clock, against the fake
  holder, whose ring now has a start (`ringStart`, `forget`) so it can answer `truncated`, and
  whose replay a close can cut short (`cutReplay`). Two cases feed the stream to @xterm/headless
  6.0.0 after an old stream cut inside a title sequence and inside a colour sequence, and check
  that no title is set. The PR body lists the mutants run and which cases each turned red.
- **Docs.** docs/remote/helper-protocol.md, section 11 (Terminal reattach) and the Attach
  paragraph of section 15, say what the app on This computer now does and that the screen in use
  and the input modes are not restored yet.
- **Owed.** The VM check at the release smoke (plan section A1's VM line). The ADR-009 pass before
  stable, on the #320 list: a holder that answers `truncated` on every attach, and a notice that
  passes for program output.
