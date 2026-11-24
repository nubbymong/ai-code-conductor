## 2026-11-24 -- A restored tab not on screen: its kept session's tool calls are served, and one whose CLI ends is ended

Plan 2.1.3-beta.17, section B1d (aicc_planning#423, the three findings of B1c's review), on
B1c. Windows, behind the agent sessions' switch. This fragment supersedes the "Until the tab
is shown" bullet of B1c's fragment (2026-11-24-takeover-hidden-tab-keeps-session.md), which is
not edited (CONTEXT.d/README.md: never edit another entry's fragment).

- **Found** (B1c's review, from the code). With B1c a restored tab can stay unseen for a long
  time, and until its take-over: (1) every Conductor tool call its kept CLI made was held 30 s
  by its relay and then answered "AI Code Conductor is updating, try again shortly"
  (helper/src/relay.rs HOLD and UPDATING; helper-protocol.md, "The relay while away"); (2) a
  kept Codex session's hook events were refused by the Hooks gateway (they carry the last
  run's token) and lost; (3) a kept session whose CLI ended by itself stayed recorded with no
  limit, so the shown tab's take-over failed and the tab said to restart it.
- **Tool calls (1).** Resume's message carries each restored local agent tab's configured
  folder (`pty:tabsRestored`: `{ id, cwd? }`, the folder at most 4096 characters, from the
  app's window only). 3 s after Resume (manager.ts UNSEEN_SERVE_AFTER_MS), a kept session
  whose tab is still not shown is served. launch-bindings.ts serveKeptLaunchUnseen, only while
  the tool host is serving, makes the tool host's record of the session with no credential
  and the review and canvas registrations (the canvas roots from the tab's configured folder,
  resolved as a launch's is), by the way that provider's sessions start; nothing of the
  account, the telemetry, the logging run or the conversation. Then a keeper that takes tool
  streams replaces the keeper holding the session, once that one is up, and the holder gives
  it the tool streams it kept: each is served under the tab's id, and Claude Code is told its
  tool list may have changed. A tab shown within the 3 s (the one on screen at Resume) is
  taken over without being served first.
- **Codex hook events (2).** In the same step, a Codex session with a kept hook folder, with
  the Hooks gateway on and listening, has its hook file written again with a new token (the
  take-over's own writer, now shared). Neither the file nor a hooked mark is recorded, so no
  hook event claims a transcript before the take-over; a file that is not written leaves no
  token. The attention source maps a session holding a Codex token with no PTY here as a
  Codex one (index.ts, launch-bindings.ts holdsCodexGatewayToken), so an approval it asks
  for raises its tab's dot.
- **A CLI that ends (3).** A keeper that reads the CLI's exit, or that attaches to a program
  that is already over (`term.attached` with `running: false`), ends the session kept for
  its tab, with its record and files. The tab, once shown, resumes its conversation in a new
  CLI by itself.
- **The take-over and the ends.** The take-over is unchanged: its spawn's teardown (killPty)
  clears what the serving bound, ends the tool host's side of the streams (the holder keeps
  them for the next attach) and drops the serving token, and the take-over binds them again.
  A session kept no longer in any other way (its tab closed, the 5 minutes after its tab was
  shown, its CLI ended, its holder not reached, End on the Machines page, a quit) has what the
  serving bound removed (unserveKeptLaunch), never what a launch of its tab bound since.
- **At the take-over.** A tool call in flight when a served session's tab is shown and takes
  it over is answered "This tool connection has ended." (connection.ts
  TOOL_STREAM_SENTENCES.ended: the take-over's teardown ends the tool host's side of the
  stream first), and a retry works at once.
- **As B1 defines it, unchanged.** A call is held 30 s by the relay and then answered "AI
  Code Conductor is updating, try again shortly": from the start until 3 s after Resume (the
  app is restarting then); while the tool host is not serving; for a session whose tab was
  shown within those 3 s, until its take-over (its launch may wait at its account picker, 5
  minutes at most); and for one whose tab Resume did not restore, until its 5-minute limit
  ends it. Claude Code's hook events still wait in its holder until the take-over (at most
  256 events and 2 MiB).
- pty-manager.ts stays at 7,773 lines: two names added to an existing line of its launch
  bindings' ports.
- Not checked here: the VM line, which the orchestrator runs on the frozen head.
