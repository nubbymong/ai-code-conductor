## 2026-11-19 -- The Watchdog's Codex retry is typed by the Codex composer rule

Section A2 of the 2.1.3-beta.10 plan (aicc_planning #336; ADR-030 slice S14,
component rows 3 and 14). A change in how a Codex retry is typed, not in
whether or when one is sent.

**Before.** Main held two Codex submit rules. The Watchdog typed a Codex
session's retry by its own (watchdog-manager submitCodex): the text through a
raw writer (session-input typeKeys), then 300 ms later Enter if its own
headless pane showed exactly the text typed, its own Backspaces if the
composer held it but something else changed, or nothing. Canvas markers, Ask
Conductor and the prompt buttons used the other: the Codex package's submit
primitive (providers/codex/composer-submit.ts), on the pane every local Codex
session has from its first byte.

**Now.** One door, `submitRetry(sessionId, text)` in
src/main/session-input/index.ts, and the Watchdog's host send is wired to it
(src/main/index.ts):
- A Codex session's retry goes to `codexRunScreen().submit(sessionId, text,
  { readyWaitMs: 5000 })`, as a canvas marker's does. It is typed only when
  the pane reads Codex's ready, empty composer on two reads 300 ms apart; its
  Enter follows once the text is confirmed on screen (polled for up to 5 s)
  instead of at a fixed 300 ms; a text not confirmed is taken back with
  Ctrl+U instead of Backspaces. The answer comes back to the Watchdog, which
  logs one of not delivered with its reason and types nothing more for it.
- Every other session's retry (Claude Code, on this computer, held by the
  session helper or over SSH) is submitLine's, byte for byte: the line and
  Enter in one write through writePty, after tmux's leave key on an SSH
  Persistent session.
- Gone: typeKeys, submitCodex, CODEX_SUBMIT_DELAY_MS, the Watchdog's own
  Backspace and Enter keys, and the host's `write` option. The Watchdog's
  detectors, its send gate, its timing, its retry text and its own headless
  pane (it still reads the limit and stop screens) are unchanged.

**One difference worth knowing.** The old rule's Enter was skipped when the
Watchdog was torn down (switched off, or restarted from the Services panel)
in the 300 ms after the text went. Now a retry not yet typed is never typed
once its incident is over (the Watchdog torn down or replaced, the limit
cleared, the check turned off: see the 2026-11-20 paragraph below), but a
retry already typed is confirmed and submitted in the same run, as the
composer rule finishes what it typed. A new run never gets it (the pane
belongs to the run). A retry message starting with / is no longer submitted
while Codex shows its command list under it: the composer rule reads the
list as part of the composer's text, so it neither submits it nor takes it
back, and it stays there for the user (the old rule's check allowed the
list). The default, continue, is not affected. The same now holds for any caller's text that starts with / (a Codex prompt button such as /compact is the likely one): it is left in the composer and answered not delivered, where before the review fix it was taken back.

**Tests.** codex-watchdog-submit.test.ts is rewritten: the real
SessionWatchdog and the real session input module over fake ports, wired as
index.ts wires it; the retry reaches the run screen's submit with a 5 s ready
wait and nothing is written raw; an answer of not delivered is logged with
its reason and nothing more is typed; with the real run screen and no pane,
session-gone is logged and nothing is written; and index.ts's own source
wires the Watchdog's send to submitRetry with no raw writer (index.ts boots
the app, so the case reads its text). session-input.test.ts points
the submitLine cases at submitRetry (local, held by the helper, the repeat
guard, the 256-byte slices) and adds an SSH Persistent case over fake ports
and the two Codex cases; the typeKeys case is gone. watchdog-manager.test.ts
gains the Codex delegation and the not-delivered log. Seen red on the base
(bee1e075): the rewritten file's first three cases, also with their host
wired as the base's index.ts wired it (the retry went raw), and the new
session-input and watchdog-manager cases. Six mutants each turned a test
red: a Codex retry written raw with Enter, a Claude Code retry routed to the
Codex rule, the leave key dropped, a not-delivered answer left unlogged, and
at index.ts's own wiring, send back to submitLine and a raw write handed in
again (these two red the index.ts case).

**2026-11-20, the PR #746 review (two regressions, fixed in the one rule).**
- The take-back cleared the user's typing. The composer rule sent Ctrl+U into
  any readable screen with no prompt up, so text the user typed beside an
  unconfirmed retry (or marker, or question) was cleared with it; the old
  Watchdog rule left such a composer alone. Now Ctrl+U goes only into a
  composer holding nothing but the rule's own text: empty, a contiguous part
  of it, or for a folded text the paste placeholder alone. It reads that
  through a new shared reader, codexComposerDraft (src/shared/codex-screen.ts),
  which reads the composer as codexTextTyped does. Otherwise nothing is
  taken back and the answer is the same not delivered.
- A retry could be typed late. Every submission for a run waits its turn
  (session-screen's chain), and a retry's 5 s began only when its turn came,
  so one queued behind a canvas marker or Ask Conductor's question (which
  wait up to 2 and 5 minutes) could be typed after the session had
  recovered. Two options of the composer rule, set only by submitRetry:
  `readyBy`, the end of the 5 s fixed when the Watchdog sends; and
  `stillWanted`, asked before each poll of the ready wait and just before the text is typed,
  which the Watchdog manager answers from a per-session count of status
  changes (the same watcher, no status change since the send). A retry whose
  incident is over is answered session-gone, typed nothing, and the Watchdog
  logs it as dropped untyped. Canvas markers, Ask Conductor and the prompt
  buttons set neither option, so they behave as before.
- Tests: codex-composer-submit.test.ts gains the reader's cases, the take-back
  cases (the user typing beside an exact and a folded text) and the readyBy
  and stillWanted cases; codex-watchdog-submit.test.ts gains the incident
  check (yes while the limit is up; no once it clears, the check is turned
  off or the watcher is replaced) and three cases through the real run
  screen's pane with a fake Codex behind it that both panes read: the user
  typing beside the retry, an earlier submission recovering the session while
  the retry waits behind it, and one holding the run past the retry's 5 s.
  session-input.test.ts checks readyBy and stillWanted are handed on.
  Seen red on 8bbd33ad: every new case in those three files but the two
  composer cases marked green on it too and the reader's (8bbd33ad has no
  reader), and the two watchdog-manager.test.ts cases whose send assertions
  now expect the incident check as a third argument.

**Left.** The renderer's own Codex rule (codexComposer.ts) stays until the
renderer's typing moves (S13). ADR-009: no path on the AGENTS.md list; on
the #320 list all the same, to attack a retry typed into a later run or over
a prompt.
