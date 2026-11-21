## 2026-11-21 -- Codex's screen reader reads the hint rows probe P19's second run recorded

Plan 2.1.3-beta.12, section C3 (aicc_planning #357), built on A2 step 2's reviewed head
(6abb571f, test/p19-second-run-corpus). One file of product code: src/shared/codex-screen.ts.

- **The measurement (A2 as it left the corpus).** All 33 recordings P19's second run added read
  unrecognised, both Codex versions, every system: the reader took one row under the footer,
  exactly `? for shortcuts` (#740), and each of these ends in another. The rows: Codex 0.170.0's
  ready row `<left arrow> for agents . ? for shortcuts`; the shortcuts key rebound to F6
  (`f6 for shortcuts` in 0.157.1, `<left arrow> for agents . f6 for shortcuts` in 0.170.0); a
  warning count `<warning sign> 1 warning . f2 to view` at the right of the ready row, one cell
  from the right edge (both versions); and the queue hint `tab to queue message` under a draft
  typed while a turn runs (both versions).
- **What changed.** `HINT_ROWS` lists those rows as recorded, with #740's row first. A row counts
  only as the one row under the footer of a one-row composer, at the footer row's own indent;
  the warning count only after a gap of three spaces or more and ending one cell from the right
  edge (held to the edge when the reader knows the row's width). The queue hint reads busy,
  never ready. `codexComposerDraft` and `codexComposerRows` strip the same row, because the
  recordings showed them wrong (no reading of an empty 0.170.0 composer, or of the queue hint's
  draft). `codexTextTyped` and `codexPastedContentShown` are unchanged: the one recording with
  typed text is the queue hint, where "not confirmed" is right (a turn runs), and none holds a
  paste. composer-submit.ts, the Watchdog, the renderer's reader, cli-contract.ts and
  pty-manager.ts are untouched.
- **Result.** 20 of the 33 now read their state: 0.170.0's ready (4 systems), agents form,
  rebound key and warning count (macOS and the bundled ConPTY each), its Linux after-reply;
  0.157.1's rebound key and warning count (2 each), its queue hint (2, busy) and three
  after-replies. Left in KNOWN_MISREADS, both still on aicc_planning#357:
  - **A wrapped footer (8, unrecognised).** Codex 0.170.0 adds the thread's title to its footer
    once a prompt is sent; on macOS and Windows the probe's folder and title did not fit in 120
    columns, and the footer took two rows (mid-reply, after-reply and the queue hint). The plan
    keeps a wrapped footer unrecognised, so nothing is typed there. In use this shows wherever
    folder and title do not fit the pane.
  - **A reply streaming (5, ready, not busy).** The reader's only busy sign is the
    `esc to interrupt` row, and Codex draws it once, right after Enter, and not while the reply
    streams (A2's finding, both versions). With a footer of one row, the mid-reply screens end in
    the same rows as their after-reply screens, so they read ready. Nothing in the rows can tell
    them apart. The same holds for #740's row: since 2.1.3-beta.10 a 0.157.1 reply streaming with
    no warning on screen ends in its ready screen's rows and reads ready. What follows when the
    app types then: Codex swaps
    its hint row for the queue hint, which no confirm reader accepts, so Enter is never pressed;
    the renderer's typing erases what it typed, and composer-submit (the Watchdog's retry) now
    reads the draft over the queue hint and takes it back with Ctrl+U. A busy sign that survives
    a streamed reply needs another source than the rows (for example the spinner Codex puts in
    the window title). It is not in this section.
- **Not reached, so still refused.** Another rebound key, another warning count (`2 warnings`),
  the warning beside the rebound or queue rows, 0.157.1's agents form (it has none), and text
  typed into a 0.170.0 composer with no turn running (no recording, so whether
  `codexTextTyped` confirms it there is unmeasured).
- **Tests.** tests/unit/shared/codex-screen-hint-rows.test.ts copies the bottom six rows of each
  recording it reads. Red on 6abb571f before the reader changed: 7 of its cases, and case 2 of
  the corpus test for the 25 recordings whose line changed (the 20 fixed, now unlisted, and the 5
  streaming ones, now listed as ready). #740's test lost two rows from its "any other row" list
  (the queue hint and 0.170.0's agents row), which it refused only because nothing had recorded
  them; its other eight cases are unchanged. Mutants, each planted and restored: any row under
  the footer accepted, the row at any indent, the queue hint read ready, and the warning count
  anywhere on the row; each turned a case red.
- **WP1.** The new test is an added row in the ledger; the reader's, the corpus test's and
  #740's test's rows say what C3 changed; the manifest regenerated.
