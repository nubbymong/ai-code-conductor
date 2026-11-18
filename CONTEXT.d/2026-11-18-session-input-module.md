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
ports with it when it loads (`setSessionInputPorts`, once: a second call
throws): write (writePty), run (the session's current PTY), tmuxWrapped,
isCodexSession and isCodexAskSession. The Codex run screen is reached through
the provider registry, by one `codexRunScreen` the module exports and
pty-manager now imports for its pane's open, feed, resize and close.
index.ts wires the Watchdog's send and write and the canvas queue's write to
the module; pty-handlers.ts takes `handOffAskQuestion` from it; pty-manager's
Ask launch calls `askQuestion`, which skips the Ask check and so is held to
pty-manager by the ratchet. A Claude Code marker is the one the module does
not type: claude-marker-typing.ts holds it and the renderer types it at
main's request. pty-manager.ts lost 107 lines and its cap is now 8,245.

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

The review of 3e36f4f8 showed new typing could still come in unseen, so the
check now also follows destructuring (renamed, nested, with a default, in a
parameter, from a require or a dynamic import, `ptyProcess`, `runScreen`,
`write` and `submit` included), constructor parameter properties, template
literal keys, node-pty required or imported at run time, lists and maps of
PTY handles, indexed types (`X['runScreen']`), a PTY manager namespace handed
on whole, and writeCliSetupPty (pty-manager's writePty hands it the
first-run terminal's keys). It also holds the module's own shape: no file it
loads, at any depth, is pty-manager; the registration is one statement of
pty-manager itself; and askQuestion is reached from pty-manager only. No live
site used the new shapes, so the allow-list changed only by writePty's
second site.

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
- Comments in canvas-marker-queue.ts and claude-marker-typing.ts named
  pty-manager's writeCanvasMarkerLine, and the perf harness's service map
  (scripts/perf/service-map.json) named writeSubmittedLine. The review fixes
  reword the comments (comment-only; neither file's rules changed) and give
  the map submitLine and typeKeys, though all three files are outside the
  plan's file list.

**Tests.** New: session-input.test.ts and session-input-ssh.test.ts, written
against pty-manager's functions first and green there (15 tests and 3; the
16th, askQuestion's own, needs the export the module added), then pointed at
the module and kept green. Mutants run: the leave key dropped, the
leave key added to a session that is not wrapped, a Claude Code marker bound
to any later run, and an Ask question written raw with Enter. Each turned a
test red. The review fixes added: a second registration throws (red before
the fix); each door throws before any registration, in a fresh copy of the
module (a silent no-op port turned it red); and, in one run against the
old checker, 40 red ownership self-tests (37 shapes it must flag, 2 it
wrongly flagged, 1 count), with 4 more clean cases already clean there.
Six more shapes and one more clean case were written with the new checker
and never ran against the old one, and three cases from that run were
reworded after it (two wrapped in an async function, one given a call).
The check's new module-shape tests were each turned red by a mutant: the
registration moved into a function, a file the module loads importing
pty-manager, and index.ts importing askQuestion.

**Owed.** The leave key moved out of pty-manager.ts (an SSH blast-radius
file), so the live SSH matrix runs once, at the release PR. An ADR-009 pass
is owed before stable.
