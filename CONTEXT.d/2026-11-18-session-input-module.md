## 2026-11-18 -- One session input module types into a session for the app

Section A1 of the 2.1.3-beta.9 plan (ADR-030 component row 3's submit, slice
S14). A refactor: nothing typed, its order or its timing changed, and no
queue, delay or check added.

**What moved.** A new folder, `src/main/session-input/`, holds the one door
through which main types into a session on its own initiative:
- `submitLine` is pty-manager's old `writeSubmittedLine`: the Watchdog's retry
  into a Claude Code session, the tmux leave key first for an SSH Persistent
  session, then the line and Enter through writePty.
- `typeKeys` is the Watchdog's raw Codex keys, through writePty. The
  Watchdog's Codex rule (type, wait, check, Enter or erase) stays in
  watchdog-manager.ts.
- `submitMarker` is the old `writeCanvasMarkerLine`: a Codex session's marker
  through the Codex run screen's submit, a Claude Code session's held by
  claude-marker-typing.ts for the run it was handed for.
- `askQuestion` and `handOffAskQuestion`, with `ASK_READY_WAIT_MS` and the
  dock notices, are the old `deliverAskQuestion` and `handOffAskQuestion`.

The module imports nothing from pty-manager.ts. pty-manager registers five
ports with it when it loads (`setSessionInputPorts`): write (writePty), run
(the session's current PTY), tmuxWrapped, isCodexSession and
isCodexAskSession. The Codex run screen is reached through the provider
registry, as pty-manager reaches it. index.ts wires the Watchdog's send and
write and the canvas queue's write to the module; pty-handlers.ts takes
`handOffAskQuestion` from it; pty-manager's Ask launch calls `askQuestion`.
pty-manager.ts lost 99 lines and its cap is now 8,253.

**The ratchet.** session-input-ownership.test.ts reads every src/main file
and finds each place that types into a session's terminal: the old typing
functions under any name, called or handed on, directly or read from any
object (a namespace import included), a run screen's submit, a write on a PTY
handle (traced by type, by start, by `.ptyProcess`, and by name as a
backstop). Each place outside the module is held to an allow-list by file and
function, with its reason and the slice that removes it; the list can only
shrink. It was red on the unchanged source at index.ts (the three wiring
lines), pty-handlers.ts (the Ask hand-off) and pty-manager.ts (the two run
screen submits and writeSubmittedLine's write).

**Where the plan's premise did not hold.**
- The ports are named isCodexSession and isCodexAskSession, not isCodex and
  isCodexAsk: the WP1 legacy manifest matches the bare word as a provider
  conditional, and the longer names keep that predicate off a new file.
- Two writes the plan did not list are on the allow-list: the End exec's and
  the liveness probe's password answers in pty-manager.ts, each into an ssh
  terminal of its own, not a session's. So is the Codex package's own
  runScreen.submit in providers/codex/index.ts, which hands a submission to
  its pane.
- pty-manager.ts registers the write port with a call of writePty, which the
  allow-list keeps as the module's one writer.
- canvas-marker-claude-gate.test.ts pinned the index.ts wiring as text by the
  old function name. Its check now names submitMarker; what it checks (the
  canvas id handed on) is unchanged.
- The tmux leave key's test is in session-input-ssh.test.ts, not
  session-input.test.ts: the SSH flow needs the real Claude Code provider and
  its own mocks, which the local test's stand-in provider cannot share.
- Comments in canvas-marker-queue.ts and claude-marker-typing.ts still name
  pty-manager's writeCanvasMarkerLine; those files were out of this section's
  scope.

**Tests.** New: session-input.test.ts and session-input-ssh.test.ts, written
against pty-manager's functions first and green there (15 tests and 3; the
16th, askQuestion's own, needs the export the module added), then pointed at
the module and kept green. Mutants run: the leave key dropped, the
leave key added to a session that is not wrapped, a Claude Code marker bound
to any later run, and an Ask question written raw with Enter. Each turned a
test red.

**Owed.** The leave key moved out of pty-manager.ts (an SSH blast-radius
file), so the live SSH matrix runs once, at the release PR. An ADR-009 pass
is owed before stable.
