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
  it would have read "Session". Nothing else on the page changed.
- A run whose earlier holder could not be ended starts nothing (as an agent
  session does) and its output says so in a run's words
  (`HELPER_SENTENCES.runNotCleared`), not a tab's.
- `insights-runner.ts`: the start is `spawnRunPty({ runId:
  insightsRunId(profileId), kind: 'claude' }, cmd, [], <the same options>)`,
  where the id is `insights-` and the account's profile id, or
  `insights-default`. The program, arguments, environment, folder, timings,
  the three writes, the KPI step and killInsightsPty are unchanged. The Codex
  Insights run and every headless run are untouched.
- Settings, the agent switch's note: "Insights' Claude Code report runs this
  way too."

**Premise note.** The plan lists "a batch file" among the launches the helper
refuses. The helper refuses a batch file only with an exact command line
(`line`). Insights passes an argument list, so an npm `claude.cmd` goes
through the holder as node-pty would start it. The test covers the refused
form (a string argument line).

**Tests.** `tests/unit/main/session-helper-manager.test.ts` (seven cases),
the new `tests/unit/main/insights-run-terminal.test.ts` (characterisation of
the start, the run id, the writes and their delays on a fake clock, the kill
at quit), one line in `tests/unit/renderer/held-terminal-tab.test.ts`, and
`tests/unit/main/spawn-site-inventory.json` (insights-runner's node-pty site
is gone; manager.ts's usual-way site counts four). The red runs and the
mutants are listed in the PR.

**At the cutover (S20, S21), not now.** Delete insights-runner.ts's node-pty
import, its direct start through node-pty, `insightsPtys` and
`killInsightsPty`, and the quit special case they carry (#317).

**Owed.** The VM check of this section, at the release smoke. ADR-009 pass
before stable (aicc_planning #320 list): a new caller of the holder's launch;
attack the environment carried into the launch frame, a run adopted or
re-attached, and the fallback.
