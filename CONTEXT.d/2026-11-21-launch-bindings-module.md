## 2026-11-21 -- A launch's bindings move out of pty-manager.ts (S16 step 3)

Plan 2.1.3-beta.13, section B1 (aicc_planning#375). No change in behaviour: the
same calls in the same order, with the same log lines. pty-manager.ts goes from
8,187 lines to 7,773, and `PTY_MANAGER_LINE_CAP` is lowered to match. The SSH
branch is not touched (no hunk lies between its first line and the Codex
branch's), but pty-manager.ts is a radius file, so the live SSH matrix runs once
on this head.

**Where things are now.** `src/main/sessions/launch-bindings.ts` holds the
bindings, each called where its code was:
- a Codex launch: `mintCodexHooks` (before its command is built),
  `keepCodexHooks` (once it is built), `bindCodexLease` (right before the
  spawn), `bindCodexPane` and `bindCodexLaunch` (after it);
- a Claude Code launch: `bindClaudeLaunch`, right after its spawn;
- every launch: `bindLoggingRun`, once the session is registered;
- the end: `unbindLaunchFiles` at the session's own exit, and
  `unbindCodexLease`, `unbindLaunchTelemetry` and `unbindLaunchRegistrations`
  at their three places in `cleanupSessionResources`.

pty-manager.ts registers its records and helpers with the module once, as it
loads (`setLaunchBindingPorts`), so the module imports nothing of it. Steps 4
and 5 can call these functions for a held session without touching
pty-manager.ts, apart from the one take-over entry step 5 plans.

**What stayed in pty-manager.ts, and why.**
- The two raw writers into a Codex PTY: they are handed in, because the
  session input check counts them in `spawnPtyResolved`.
- The Codex run's data handler and its run folder note, beside the spawn, as
  Claude Code's are. Ask Conductor's opening question, because `askQuestion` is
  pty-manager.ts's door alone (a take-over types no question). The Codex run
  screen, which pty-manager.ts closes for the module.
- The failed Codex launch's unwinding: it reads the hook file and token the
  launch holds, which `mintCodexHooks` and `keepCodexHooks` hand back.
- Every comparison with a provider name: pty-manager.ts works each out and
  hands the answer in, so the new file holds none. Two such comparisons and one
  default went with the move, so pty-manager.ts's provider-name ceiling is
  lowered (20 to 18 comparisons, 16 to 15 defaults).

**Tests.** `tests/unit/main/launch-bindings.test.ts` calls the module directly;
`tests/unit/main/launch-bindings-launch.test.ts` holds pty-manager.ts to one
call of each binding per launch and per end, at its place. Each was shown to fail
when an unbind is skipped, a bind runs twice, the account capture comes before
the spawn, or the teardown's parts change order.
