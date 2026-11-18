## 2026-11-18 -- Status line steps guarded, hooks unsubscribe across the fall-back, ssh.exe looked for off the main thread

Section C3 of the 2.1.3-beta.9 plan: planning #324, #323 and #310 item 5.

**#324, the status line fan-out.** `session-signals/status.ts` `deliverStatus`
guarded its three sinks (the transcript binder, the usage figure, Sentinel)
but not the two steps before them: the window send and the Claude provider's
`deliverStatusline`. A throw in either stopped the rest. Each now has its own
try/catch, as the sinks do, with no log line, as the sinks have none. Nothing
changes when nothing throws. SSH status lines pass through here too.

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
(a pure move first; pty-manager.ts is 17 lines shorter, cap 8335). On Windows
every SSH start (a session, its End exec, the liveness probe) walked PATH for
ssh.exe on the main thread, so a folder on a share that does not answer froze
the app. Now:
- `lookForSshProgram` walks PATH off the event loop through the shared
  `findOnWindowsPathAsync` (no file test of its own) and keeps the full path
  found, for the PATH and the PATH refresh count it was made under. One look
  at a time per key; only the newest look may keep its answer; a look that
  finds none drops what was kept for its key.
- It starts once at start, from `registerPtyHandlers` (ipc/pty-handlers.ts),
  and again after each PATH refresh, from `refreshWindowsPath`
  (windows-path-refresh.ts), but only once the start has happened.
- `sshProgram` reads the kept answer when there is one for this PATH and
  count; else it walks in place exactly as before and keeps nothing. No SSH
  start waits for the look. A start that reads an answer older than 60 s
  (`SSH_PROGRAM_RECHECK_MS`) still runs it and starts a new look for the
  starts after it.

Decisions taken here:
- The plan said the warm-up starts "where gsudo's does". gsudo's look has no
  start-up warm-up: it starts on the first elevated terminal, held in
  pty:spawn. index.ts was not to be touched, and `startClaudeAtBoot` and
  `refreshWindowsPath` are both driven by tests that count every walk, so the
  start-up call went to `registerPtyHandlers` (the module where gsudo's look
  is started, run once at start), and the call after a refresh is a no-op
  until that start call has run.
- The kept answer has no expiry that would send a start back to the walk in
  place: an answer that expired after a minute would leave most SSH starts
  walking on the main thread again. The 60 s new look instead bounds how
  long a changed ssh.exe goes unseen to one start.
- A walk in place keeps no answer, so unit tests that drive SSH starts with a
  fake file system behave exactly as before.

Tests: `session-signals-status.test.ts` (+4, all red before the guard),
`hooks-gateway-proxy-failopen.test.ts` (+5, 2 red before the fix, 3 pin the
behaviour that stays), `ssh-program-lookup.test.ts` (+16 for the kept
answer), `pty-spawn-launch-lookups-held.test.ts` (+1, the start-up call).
Eight mutants of the lookup and its two call sites each turned at least one
of these red.

Owed: the live SSH matrix at the release PR (status lines pass through
status.ts; sshProgram decides the SSH program). An ADR-009 pass before stable
for the #310 part (a program lookup decides what is launched): attack a kept
answer after PATH changes, a stale answer, and the look's key.
