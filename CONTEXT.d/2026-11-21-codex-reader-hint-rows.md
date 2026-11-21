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
- **What changed.** `HINT_ROWS` lists the agents row, the two rebound rows and the queue hint as
  recorded, with #740's row first. For the screen's state a row counts only as the one row under
  the footer of a one-row composer, at the footer row's own indent. The queue hint reads busy,
  never ready. `codexComposerDraft` and `codexComposerRows` strip the same row when it is the last
  row, whatever the composer's height, because the recordings showed them wrong (no reading of an
  empty 0.170.0 composer, or of the queue hint's draft). So composer-submit can take back a text
  it typed, one row or wrapped onto more. The wrapped case is not recorded (every recorded draft
  is one row): the test builds it from the recorded queue hint, after the final-head review's dry
  run. `codexTextTyped` and `codexPastedContentShown` are unchanged. composer-submit.ts, the Watchdog, the renderer's reader, cli-contract.ts and
  pty-manager.ts are untouched.
- **The warning count is not taken (found at the final-head review).** Once a text is typed at an
  idle composer, Codex hides the left hint and keeps the count alone under the footer: its own
  snapshot test `warning_notice_styles` (chat_composer/warning_notice_tests.rs at rust-v0.157.1
  and rust-v0.170.0), and P19's bytes (codex-macos-queue-hint event 83 blanks the left hint and
  leaves the count). No reader that confirms a typed text takes that row. With the count
  accepted, the app typed the text, never pressed Enter and could not take it back, where at
  6abb571f the screen read unrecognised and nothing was typed. So the warning rows are not
  accepted: such a screen reads unrecognised, as before C3. In P19's runs both versions showed
  the count in every launch from the first prompt on (with the stand-in model; what it warns of
  was not read), so in those runs no screen after the first prompt reads ready. Whether a
  signed-in Codex shows the count in normal use is not measured.
- **Result.** 12 of the 33 now read their state: 0.170.0's ready screen (4 systems), its agents
  form and its rebound key (macOS and the bundled ConPTY each); 0.157.1's rebound key (2) and its
  queue hint (2, busy). Left in KNOWN_MISREADS, all unrecognised, all on aicc_planning#357:
  - **A wrapped footer (8).** Codex 0.170.0 adds the thread's title to its footer once a prompt
    is sent. On macOS and Windows the probe's folder and title did not fit in 120 columns, and the
    footer took two rows (mid-reply, after-reply and the queue hint). The plan keeps a wrapped
    footer unrecognised, so nothing is typed there. In use this shows wherever the folder and the
    title do not fit the pane.
  - **A warning count (13).** The 8 screens that end in the count under a one-row footer, and the
    5 mid-reply screens whose footer is one row, which end in it too.
- **A reply streaming.** The reader's only busy sign is the `esc to interrupt` row, and Codex
  draws it once, right after Enter, and not while the reply streams (A2's finding, both versions,
  measured only against the probe's stand-in model; no real account was used). Every recorded
  mid-reply screen shows the warning count, so each reads unrecognised. Without the count, a
  streaming reply very likely ends in its ready screen's rows and reads ready: for 0.170.0's
  agents and rebound rows from C3 on, and for #740's row since 2.1.3-beta.10 (inferred, not
  recorded: every mid-reply and after-reply screen in the corpus shows the warning count, so none
  shows a streaming reply without it). What follows when the app types then: Codex swaps its hint
  row for the queue hint, which no confirm reader accepts, so Enter is not pressed while the turn
  runs. The renderer erases a one-row command it typed, and composer-submit (the main process
  typing, the Watchdog retry included) reads the draft over the queue hint, one row or wrapped
  onto more, and takes it back with Ctrl+U. A busy sign that survives a streamed reply needs
  another source than the rows (for example the spinner Codex puts in the window title). It is
  not in this section.
- **Not reached, so still refused.** A draft typed at an idle composer while the warning count
  shows (the count alone under the footer; the reason the warning rows are refused), another
  rebound key, another warning count (`2 warnings`), the warning beside the rebound or queue rows,
  and 0.157.1's agents form (it has none). Text typed at a 0.170.0 composer with no turn running
  is recorded with no warning (codex170-macos-queue-hint events 38 to 40: the hint row goes and
  the footer takes the last row, which codexTextTyped confirms); what is not recorded is the same
  with a warning count.
- **Tests.** tests/unit/shared/codex-screen-hint-rows.test.ts copies the bottom six rows of each
  recording it reads. On 6abb571f, before the reader changed, 7 of its 16 cases were red, and
  case 2 of the corpus test was red for the 12 recordings now read (now unlisted). The other 9
  pass before and after by design: 8 refusals that pin what must stay unrecognised or unread, and
  one check that the rows it builds equal the recorded ones. The review fixes were red first on
  22d36619: the warning screens reading unrecognised, and a two-row draft read over the queue hint
  (2 cases), and case 2 of the corpus test for the 13 warning recordings. #740's test lost two
  rows from its "any other row" list (the queue hint and 0.170.0's agents row), which it refused
  only because nothing had recorded them; its other cases are unchanged. Mutants, each planted
  and restored, each turned a case red: any row under the footer accepted; the row at any indent;
  the queue hint read ready; the recorded warning rows accepted again; any last row stripped under
  a taller composer; the draft read over the queue hint only under a one-row composer. One planted
  change is equivalent and survived: the state reader taking the row under a composer of any
  height. It reads ready or busy only when the footer alone is left, so the three readers share
  one rule.
- **WP1.** The new test is an added row in the ledger; the reader's, the corpus test's and
  #740's test's rows say what C3 changed; the manifest regenerated.
