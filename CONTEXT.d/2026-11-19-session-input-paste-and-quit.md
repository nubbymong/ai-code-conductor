## 2026-11-19 -- Channel messages and the quit keys go through the session input module

Section A2 of the 2.1.3-beta.9 plan (ADR-030 slice S14, part 2; A1 made the
module). A refactor with one narrowing the plan asked for and one fix from
review, both below.

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

**A failed key write.** Review found that the quit keys, on beta and after the
move, had no try/catch. A process that has died before its exit is told is
still the session's, and a key written to it can throw: out of a timer (main's
global handler logs an EPIPE or EIO and rethrows any other error), or, for the
Escape, out of gracefulExitPty,
whose promise then failed and took gracefulExitAllPty's with it. Each key's
write is now caught and dropped, as the envelope writer's slices already were
(R-010). No byte, order or timing changed: the next key is still tried at its
time, and the quit's exit listener or timeout ends it.

**The ratchet.** session-input-ownership.test.ts's allow-list lost
pty-manager.ts's writeEnvelopeChunked and gracefulExitPty entries and
channel-bus.ts's entry. It was red on exactly those three sites until the
move. A new check holds sendExitKeys to pty-manager.ts, since it skips the
quit's own checks, as askQuestion skips the Ask check. pty-manager.ts went
from 8,228 lines (beta after #724) to 8,187 and its cap was lowered to match.
scripts/perf/service-map.json names pasteEnvelope in place of pastePty and
adds sendExitKeys.

**Tests.** session-input.test.ts gained the paste and quit tests. The paste
tests and the quit tests through gracefulExitPty were run first on beta,
against pastePty and gracefulExitPty: all held but the replaced-terminal quit
case, as above. Then they were pointed at the module and held, with two direct
sendExitKeys tests added. Each of these mutants, run once against one file,
turned that file red. In tests/unit/pty-manager-ssh-tmux.test.ts: keys typed
into a tmux-persistent session. In tests/unit/main/session-input.test.ts: an
envelope through writePty's duplicate guard; an envelope deduped by its text;
the queue bound at 17 and at 15; an envelope's writer with no identity check;
quit keys checked by presence only; Ctrl-C at 150 ms. The identity-check and
presence-only mutants were re-run on the fixed replacement tests (906506c3).
In review, two failed-write tests were added to session-input.test.ts and the
fake clock of its before-registration test was moved ahead of sendExitKeys.
One run on 906506c3's code, with one mutant added (a key scheduled before the
port check), was red on exactly three tests: the two failed-write tests and
the before-registration test. With the fix in and the mutant out, the file
was green.

**Owed.** The live SSH matrix at the release PR: an SSH session where the app
started the CLI gets the quit keys from the new place, bytes unchanged. An
ADR-009 pass before stable (aicc_planning #320 list): an envelope reaching a
respawned terminal, and quit keys into a session the app did not start or a
tmux-persistent one.
