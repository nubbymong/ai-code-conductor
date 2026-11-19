## 2026-11-19 -- Channel messages and the quit keys go through the session input module

Section A2 of the 2.1.3-beta.9 plan (ADR-030 slice S14, part 2; A1 made the
module). A refactor with one narrowing the plan asked for, below.

**What moved.** From pty-manager.ts into `src/main/session-input/index.ts`:
- `pasteEnvelope` is the old `pastePty`: a channel message as a Tier 1 paste.
  With it moved its per-session queues (at most 16 waiting; one more drops the
  oldest waiting and counts it) and `writeEnvelopeChunked`, the 256-byte, 12 ms
  chunked writer with no duplicate guard. That writer writes to the session's
  terminal process itself, read through the ports' `run`, and stops when that
  process is no longer the session's. channel-bus.ts imports it from the
  module. `cancelPastes` is the two lines of cleanupSessionResources that stop
  a session's queue.
- `sendExitKeys(sessionId, proc)` is the three quit keys: Escape at once,
  Ctrl-C at 100 ms, then /exit and Enter at 300 ms. gracefulExitPty keeps its
  exit listener, its timeout, the tmux detach and the close of a terminal whose
  CLI the app did not start, and calls sendExitKeys where it typed the keys.

**The narrowing.** Each quit key is now written only while `proc` is still the
session's terminal process. Beta asked only whether the session still had a
terminal, so a terminal replaced by a new run during the quit still got Ctrl-C
and /exit, into a process that was being ended. Which sessions get the keys is
unchanged.

**The ratchet.** session-input-ownership.test.ts's allow-list lost
pty-manager.ts's writeEnvelopeChunked and gracefulExitPty entries and
channel-bus.ts's entry. It was red on exactly those three sites until the
move. A new check holds sendExitKeys to pty-manager.ts, since it skips the
quit's own checks, as askQuestion skips the Ask check. pty-manager.ts went
from 8,228 lines (beta after #724) to 8,187 and its cap was lowered to match.
scripts/perf/service-map.json names pasteEnvelope and sendExitKeys in place of
pastePty.

**Tests.** session-input.test.ts gained the paste and quit tests. The paste
tests and the quit tests through gracefulExitPty were run first on beta,
against pastePty and gracefulExitPty: all held but the replaced-terminal quit
case, as above. Then they were pointed at the module and held, with two direct
sendExitKeys tests added. Each of these mutants turned a test red: keys typed
into a tmux-persistent session; an envelope through writePty's duplicate
guard; an envelope deduped by its text; the queue bound at 17 and at 15; an
envelope's writer with no identity check; quit keys checked by presence only;
Ctrl-C at 150 ms.

**Owed.** The live SSH matrix at the release PR: an SSH session where the app
started the CLI gets the quit keys from the new place, bytes unchanged. An
ADR-009 pass before stable (aicc_planning #320 list): an envelope reaching a
respawned terminal, and quit keys into a session the app did not start or a
tmux-persistent one.
