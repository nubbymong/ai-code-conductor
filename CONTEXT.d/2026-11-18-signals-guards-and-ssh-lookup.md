## 2026-11-18 -- Status line steps guarded, hooks unsubscribe across the fall-back, ssh.exe looked for off the main thread

Section C3 of the 2.1.3-beta.9 plan: planning #324, #323 and #310 item 5.

**#324, the status line fan-out.** `session-signals/status.ts` `deliverStatus`
guarded its three sinks (the transcript binder, the usage figure, Sentinel)
but not the two steps before them: the window send and the Claude provider's
`deliverStatusline`. A throw in either stopped the rest. Each now has its own
try/catch, as the sinks do. The first throw of each step in a run is logged
once (`[status-fan-out]`, the step and the error's message), so a step that
throws on every tick leaves one line, not one per tick. The three sinks log
nothing, as before. Nothing changes when nothing throws. SSH status lines
pass through here too.

**#323, the hooks proxy fall-back.** `HooksGatewayProxy.failOpen` copied each
subscriber into the in-process gateway and dropped the unsubscribe that
gateway returned. An unsubscribe taken before the fall-back then removed the
callback only from the proxy's own set, which no longer fans out, so the
callback kept hearing every event. failOpen now keeps each copy's
unsubscribe in a map, and the earlier unsubscribe calls it as well as
removing the callback from the set. The fan-out and the gateway are
unchanged; a subscriber added after the fall-back still subscribes straight
to the gateway.

**#310 item 5, which ssh.exe an SSH start runs.** `sshProgram` and
`SSH_NOT_ON_PATH` moved from pty-manager.ts to a new `src/main/ssh-program.ts`
(a pure move first). After the rebase on A1 (#723), pty-manager.ts is 8,228
lines and the cap is 8228. On Windows every SSH start (a session, its End
exec, the liveness probe) walked PATH for ssh.exe on the main thread, so a
folder on a share that does not answer froze the app. Now:
- `lookForSshProgram` walks PATH off the event loop through the shared
  `findOnWindowsPathAsync` (no file test of its own) and keeps the full path
  found, for the PATH and the PATH refresh count it was made under. One look
  at a time per key; only the newest look may keep its answer; a look that
  finds none drops what was kept for its key.
- It starts once at start, from `registerPtyHandlers` (ipc/pty-handlers.ts).
  Once started on Windows it runs again every 60 s
  (`SSH_PROGRAM_RECHECK_MS`, an unref'd timer), after each PATH refresh
  (`refreshWindowsPath`, windows-path-refresh.ts), and when a start finds
  no answer kept.
- `sshProgram` runs the kept answer while it is younger than 120 s
  (`SSH_PROGRAM_KEEP_MS`); one older than 60 s also starts a new look. With
  none kept, or one 120 s old or older, it walks in place exactly as before
  and keeps nothing. No SSH start waits for the look.

Decisions taken here:
- The plan said the warm-up starts "where gsudo's does". gsudo's look has no
  start-up call: it starts at the first elevated terminal (warmGsudo in
  providers/claude/spawn.ts, and gsudoLookAnswered in the pty:spawn
  handler). index.ts was not to be touched, and `startClaudeAtBoot` and
  `refreshWindowsPath` are both driven by tests that count every walk, so
  the start-up call went to `registerPtyHandlers`, which runs once at
  start, and the call after a refresh is a no-op until that start call has
  run.
- Review of PR #724 found that a kept answer with no age limit could run an
  ssh.exe that had been removed or replaced, for the whole run. The answer
  now has a 120 s limit, as gsudo's has a 60 s one, and the look made every
  60 s keeps it fresh, so a start walks in place only when looks stop
  answering. An ssh.exe removed, moved, or newly put in an earlier PATH
  folder is seen within 120 s at most.
- A walk in place keeps no answer, so unit tests that drive SSH starts with a
  fake file system behave exactly as before.

Tests: `session-signals-status.test.ts` (+6), `hooks-gateway-proxy-failopen.test.ts`
(+5: 2 cover the fix and were red before it, 3 are characterisation tests
that were green before it too), `ssh-program-lookup.test.ts` (+22 for the
kept answer, the recheck, the age limit and the look a start begins),
`pty-spawn-launch-lookups-held.test.ts` (+1, the start-up call). 22 mutants
were run, one locked run of one file each, and each turned at least one
named case red; PR #724 lists the cases per mutant.

Owed: the live SSH matrix at the release PR (status lines pass through
status.ts; sshProgram decides the SSH program). An ADR-009 pass before stable
for the #310 part (a program lookup decides what is launched): attack a kept
answer after PATH changes, a stale answer within the 120 s limit, the
recheck, and the look's key. `src/main/ssh-program.ts` is not on the live
SSH matrix's radius list; adding it is left to the orchestrator, as a
separate change.
