## 2026-11-18 -- One session signals module decides what a hook event or status line means

Section A2 of the 2.1.3-beta.8 plan (ADR-030 component row 13, slice S12). A
refactor with no behaviour change: it moves meaning, not transport. It ships
whether or not the helper hook work (A3, A4) follows.

**What moved.** A new folder, `src/main/session-signals/`:
- `hooks.ts` is now the only subscriber to the hooks gateway in the main
  process. It subscribes once, through `onGateway`, when `startSessionSignals`
  runs at boot, and follows any gateway set after it. Consumers call
  `onHookEvent(cb)` instead of `gw.subscribe(cb)`: the notification rules
  (channel-rules.ts), the effort tracker (effort-tracker.ts), the canvas
  marker queue's turn boundary (the wiring in index.ts), the attention dot
  (attention-source.ts), the Codex conversation claim (index.ts) and the
  Watchdog's StopFailure (watchdog-manager.ts, still subscribing late and
  unsubscribing at teardown). `hookEvent(e, source)` is the entry for any
  transport; the source is only `'gateway'` for now.
- The transcript path the gateway child reports goes from the supervisor
  through `transcriptPath(sid, path, 'gateway')` to main's route, which calls
  `routeHookTranscriptPath` as before.
- `status.ts` holds the status line fan-out, the body of the watcher's old
  `fanOutStatusline` moved line for line as `deliverStatus`, with its two sinks
  (`setTranscriptPathSink`, `setStatuslineUsageSink`). statusline-watcher.ts
  keeps the parsing, the sanitising, the file watch and
  `dispatchSSHStatuslineUpdate`, calls `deliverStatus` at its two call sites,
  and re-exports the two sinks.

**Delivery is unchanged.** The module keeps its consumers in a Set, in the
order they register, and hands each event to a snapshot of it with a
try/catch per consumer: what the gateway's own fan-out did. Registration
order is the boot order of index.ts, the same at 87cb630d and at 3e4a63e9:
rules, effort, canvas turn, attention, claim, then the Watchdog when its
first session starts. The renderer's HOOKS_EVENT feed, the ring buffer and
the redaction stay in the gateway.

**Where the plan's premise did not hold.**
- The plan listed five gateway subscribers. There were six: the effort
  tracker (effort-tracker.ts:120) subscribed too, and it drives the
  subagent check the status fan-out reads. It moved like the others.
- The plan named canvas-marker-queue.ts. The queue's subscription is the
  `subscribe` wiring index.ts hands to `startCanvasMarkerQueue`, so the canvas
  files did not change.
- channel-rules-gateway-order.test.ts pinned, as text, that channel-rules.ts
  calls `onGateway(`. The engine now reaches the gateway through the module,
  so that pin reads the engine and `session-signals/hooks.ts` together; its
  two expectations are unchanged, and one was added (the engine calls
  `onHookEvent(`).

**Edge cases that differ, none reachable in today's start-up.** A consumer
started before any gateway is set now hears one set later (before, only the
rules engine did); a gateway set a second time is now followed by every
consumer (index.ts sets it once); and after a fall-back to the in-process
gateway, the Watchdog's unsubscribe at quit now takes effect (before, it
removed the callback only from the proxy's unused list).

**Tests.** New: session-signals-ownership.test.ts (red on the unchanged
source at the six subscribe sites and the three fan-out lines; a self-test
shows it sees renamed, aliased, typed and destructured gateway handles),
session-signals-hooks.test.ts and session-signals-status.test.ts (written
against statusline-watcher.ts first and green there, then kept green after
the move). Mutants run: two consumers swapped (in index.ts, and in the
module), one consumer dropped (the effort tracker, the claim, the module
skipping one), the subagent strip applied to the raw data. Each turned a test
red.

**Owed.** statusline-watcher.ts is in the SSH blast radius, so the live SSH
matrix runs once at the release PR, as beta.7's A3 did. The status lines a
Codex session's rollout telemetry sends (pty-manager.ts) do not go through
`deliverStatus`; pty-manager.ts was out of scope here.
