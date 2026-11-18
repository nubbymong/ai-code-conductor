## 2026-11-18 -- Insights' report terminal runs through the session helper, off by default (2.1.3-beta.9 section B1)

**Why.** Insights starts Claude Code for its report in a node-pty terminal of
main's own (insights-runner.ts), the app's third PTY owner. A normal quit ends
it (killInsightsPty, #317), but an update's app.exit or a crash ended nothing
of it. This is the first step of S18 (ADR-030 row 11): the report terminal
takes the agent sessions' path through the helper, with no protocol change.

**What changed.** Only while "Claude Code and Codex sessions through the
session helper" (agentSessionsThroughHelper) is on; no new setting.
- `session-helper/manager.ts`: `spawnRunPty({ runId, kind }, file, args,
  opts)`, beside spawnAgentPty. node-pty's spawn with the same arguments
  unless the switch is on or an earlier holder of the same run is still
  being ended. Otherwise `spawnRun`, which is spawnAgent under the run's own
  agent id (heldAgentSessionId(runId, kind)), with `run: true` in the context:
  hookRoute answers none for a run (it has no per-session settings file), so
  its connections never ack `hooks`. A crash's or a quit's leftover record is
  an agent record, so the next start ends it and never shows it again, and
  Re-attach refuses it. A run id no holder can carry as its label, a helper
  that is not ready, and a launch the helper would refuse each start the
  usual way with one log line.
- The Machines page lists a running report as "Insights report" (by the run
  id's first part), kind Claude Code, with End and no Re-attach. Before this
  it would have read "Session". The row is marked as a run (`run: true` on
  HeldSession), so its End asks "End this Insights report? Claude Code stops
  and the report fails." with an "End report" button, not the tab sentence
  of a session. With the switch turned off during a report, the page's line
  says the terminal goes when its report finishes, not when its tab closes
  (`offStillHoldingSentence(n, runs)`).
- A run whose earlier holder could not be ended starts nothing (as an agent
  session does) and its output says so in a run's words
  (`HELPER_SENTENCES.runNotCleared`), not a tab's. Its log lines say "this
  report", and the two lines every terminal shares say "for this terminal"
  and "for its terminal" (helper-pty.ts, endUntilGone), not "tab".
- `insights-runner.ts`: the start is `spawnRunPty({ runId:
  insightsRunId(profileId), kind: 'claude' }, cmd, [], <the same options>)`,
  where the id is `insights-` and the account's profile id, or
  `insights--default` for the global sign-in. The plan's `insights-default`
  would be the id of a profile named `default` too (a valid profile id), whose
  report may run beside the global one, and either start would then end the
  other's holder (PR review); no profile id starts with a hyphen, so
  `insights--default` is no profile's. `spawnClaudeInsights` takes the run id
  as its second parameter (its one caller, runInsights, passes it), and
  `insightsRunId` is exported for the test. The node-pty import is now a type
  import only. The program, arguments, environment, folder, the three writes,
  the KPI step and killInsightsPty are unchanged. The Codex Insights run and
  every headless run are untouched.
- Through the helper only (a HelperPty): the 20 s start-up fallback (type
  /insights when no prompt was seen) counts from the terminal's first output,
  not from the start call. The start can wait for an earlier holder of the
  run to end (up to about 130 s) and for the hold (up to 20 s), and what is
  typed meanwhile waits and reaches Claude Code the moment it starts, before
  its prompt. With node-pty the fallback counts from the start call, as
  before. A holder lost during the report (LOST_EXIT_CODE) fails the run with
  `HELPER_SENTENCES.runLost` ("The session helper lost this report's
  terminal. Run the report again.") at the end of its output, so the run's
  error says why.
- Settings, the agent switch's note: "Insights' Claude Code report runs this
  way too."

**Two differences on the fallback paths, accepted.** Both apply when the
switch is on and the helper hands the report back to node-pty (the
switch-on fallback after a failed hold, and the wait after a crash with the
switch off):
- The node-pty terminal HelperPty starts there is guarded by helper-pty.ts
  guardInner, not by Insights' own guardPtyIo (which only logs; a HelperPty
  has nothing for it to guard). After an input or output failure it is ended
  3 s later and `[This session stopped taking input, so it was ended.]` goes
  into the report's output, so the run fails then. Before, after an input
  failure (no /insights or /exit can reach Claude Code) the run failed at its
  10-minute limit; after an output failure alone it could still finish,
  since the report's end is seen in report.html, not in the output. It now
  fails in both cases, as every other terminal of the app is ended.
- `timedStart` (main-thread-ops.ts) times only the HelperPty's construction;
  the node-pty start it makes later is not timed or logged as slow.

**Premise note.** The plan lists "a batch file" among the launches the helper
refuses. The helper refuses a batch file only with an exact command line
(`line`). Insights passes an argument list, so an npm `claude.cmd` goes
through the holder as node-pty would start it. The test covers the refused
form (a string argument line).

**Tests.** `tests/unit/main/session-helper-manager.test.ts` (nine cases),
the new `tests/unit/main/insights-run-terminal.test.ts` (characterisation of
the start, the run id, the writes and their delays on a fake clock, the kill
at quit, a helper on for plain terminals only, and on Windows the report
through a fake holder: the same writes, the quit's kill, a start held past
20 s, a lost holder), a case in `tests/unit/renderer/machines-page.test.tsx`,
two log lines in `tests/unit/main/session-helper-flow.test.ts`, one line in
`tests/unit/renderer/held-terminal-tab.test.ts`, and
`tests/unit/main/spawn-site-inventory.json` (insights-runner's node-pty site
is gone; manager.ts's usual-way site counts four). The red runs and the
mutants are listed in the PR.

**At the cutover (S20, S21), not now.** Delete insights-runner.ts's node-pty
type import, the direct start through node-pty that is now spawnRunPty's off
branch in manager.ts (its `pty.spawn(file, args, opts)`, and spawnRunPty with
it once no run needs the switch), `insightsPtys` and `killInsightsPty`, and
the quit special case they carry (#317).

**Owed.** The VM check of this section, at the release smoke. ADR-009 pass
before stable (aicc_planning #320 list): a new caller of the holder's launch;
attack the environment carried into the launch frame, a run adopted or
re-attached, and the fallback.
