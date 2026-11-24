## 2026-11-24 -- At an update, the hook events a kept Claude Code session makes after the let-go reach the next start

Plan 2.1.3-beta.17, section B1f (aicc_planning#423; vm:B1e's note 2), on B1e (ba559fb5).
Windows, behind the agent sessions' switch. This fragment adds to B1e's
(2026-11-24-takeover-hidden-tab-hooks-status.md), which is not edited.

- **Found (vm:B1e, pass 2).** The two hook events of one Claude Code tool call, made 0.2 s and
  0.28 s after the old app's let-go line and 0.4 s and 0.3 s before its exit, were not in the
  next run's hook record; every event made from the exit on was. Once in six tab-updates.
- **Cause (read in the code at ba559fb5, then red in unit tests there).** The update's let-go
  (manager.ts releaseForUpdate, :1971; helper-pty.ts release, :520-533) closed the session's
  connection with close() (connection.ts :615-620): `end()`, a destroy 1 s later, and the
  connection marked closed, after which it dropped every frame unread (onBytes, :641). The app
  never acks a hook event: the holder counts an event as sent once its write to the attached
  connection succeeds, and drops it from its queue then (helper/src/serve.rs send_waiting,
  :585-594; holder.rs HookQueue::sent, :120-127). On Windows a named pipe has no half-close,
  so after the app's `end()` the holder still had the connection attached, and wrote each new
  event to it, until the app's handle closed. libuv closes a shut-down pipe's handle itself
  once 50 ms pass with nothing read (libuv src/win/pipe.c, `eof_timeout`), but only when the
  event loop turns, and here it did not: at ba559fb5 the update's wait had nothing to wait
  for, and the kill of every PTY and the installer's start (`spawn`, a synchronous
  CreateProcess) run with no turn of the loop between them (update-handlers.ts :338-370). The
  VM's log (after-k.log): let-go 17:46:59.233Z, 'Launching installer...' .279Z, the
  installer's process made .619Z, 'Exiting app for installer...' .665Z, exit .827Z. So the
  handle closed at the exit (update-handlers.ts :377), 0.59 s after the let-go line, before
  the 1 s destroy. Those events left the holder's
  queue and were dropped unread by the old app. An event written just before the let-go and
  not yet read was dropped the same way. The VM line's reading (the old app acked them) is
  right in effect; nothing acks them, they were written to a connection that dropped them.
- **Fix.** A connection that takes hook events lets go with `term.detach` in place of close()
  (connection.ts letGo; helper-pty.ts release). A holder sends no event after its
  `term.detached` answer, and keeps a later one for the next attach (helper-protocol.md
  section 15; serve.rs :1463-1491; every holder that offers `hooks` does this, from #716 on,
  so no helper (Rust) change). Until that answer the connection still reads and reports the
  hook events sent before it, and nothing else (no output, no tool message: as after close()),
  so the old run takes each of those once. The update waits for the answers (endsForUpdate,
  inside app-wiring's existing 1.5 s bound) before it kills the PTYs, and logs one line per
  session: "its holder let go of it for the update, so a hook event it makes from now on waits
  there for the next start", or, with no answer within LET_GO_WAIT_MS (1 s, under the update's
  1.5 s), that its connection is closed and an event before the exit may not reach the next
  start. Only the `term.detached` carrying the detach's id counts as the answer; an `error`
  carrying it is no let-go. None is taken twice: the
  holder sends each event once, and the next start's routes drop a `seq` already seen (B1e).
- **A session kept for its restored tab not shown, at the next update (B1e's keeper, which
  takes hook events).** It was never let go: its keeper took every event until the exit. Its
  keeper now lets go the same way; the session stays kept for the start after. When the update
  does not start (reclaim), it is kept again with the same hook and tool routes, and gets what
  its holder kept meanwhile. A quit that overtakes the update has no keeper to end it through,
  so it ends it by its record (manager.ts shutdown), as it ends a live tab's session the same
  update let go of.
- **Unchanged.** A plain terminal's let-go (no hook events): closed as before, no detach. The
  agent sessions' switch off: no agent session goes through a holder, nothing to let go of. A
  normal quit: every held session is ended (`term.end`), nothing let go of or kept. The take-over
  (B1 to B1e) as before.
- **Takes effect from the first update whose OLD app has it**: the old app does the let-go. An
  update from beta.16 or earlier to beta.17 still has the gap.
- **The other provider (Codex) is not closed here, and cannot be by this means.** Its hook
  events do not go through its holder: the app's forwarder posts each one once to the gateway
  port and token in its hook file, and gives up (scripts/ccc-codex-hook.js :135-150,
  :170-179). Between the let-go and the update's kill the old gateway takes it (the old run's
  record); from the kill the old gateway refuses it (pty-manager.ts :7587-7589); from the exit
  nothing listens; the next run writes a new port and token only 3 s after Resume (B1d) or at
  the take-over. So every such event from the let-go to that rewrite is lost, whichever run
  answers, and "stop taking events at the let-go" only moves which side loses it: nothing
  queues them. Closing it needs a queue between Codex and the next run, the step S16's item 4
  already names (CONTEXT.d/2026-11-19-what-a-held-agent-session-needs.md :109-126: moving
  Codex onto the hook mode, a later S12 step). ADR-030's P20 (a) measured what a hook post
  nobody takes costs Codex: the tool runs as in the control and nothing on screen says a hook
  failed (its hooks are asynchronous), so only the event is lost.
- pty-manager.ts is not touched (7,773 lines).
- Not checked here: the VM line (a real pipe and a real holder), which the orchestrator runs on
  the frozen head; it counts from the new let-go answer line, and reads the time from the
  let-go line to that answer line.
