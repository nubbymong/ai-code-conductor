## 2026-11-24 -- A restored tab not on screen keeps the session an update kept for it until it is shown

Plan 2.1.3-beta.17, section B1c (aicc_planning#423), on B1 (#412) and B1b (#419). Windows,
behind the agent sessions' switch. It changes one rule of B1's fragment
(2026-11-24-takeover-kept-agent-session.md, "One no tab takes over within 5 minutes"): the 5
minutes now stop while the session's tab is restored and not yet shown.

- **Found.** vm:B1's extra pass (24 Nov, B1's head 3169ddb0): Resume with the Claude Code tab
  not on screen; at 12:43:03Z its kept session was ended ("its tab did not take it over within
  300000 ms"), and its running turn with it. The cause (lines at fd31052b): App.tsx renders every restored tab's
  TerminalView, a hidden one with `display: none` (App.tsx:1103-1164, :1127), and TerminalView
  waits a frame at a time for a pane with a size (initTerminal, TerminalView.tsx:713-716;
  fitAndSpawn, :1033-1036, aicc_planning#398), so its `pty.spawn` (:1268-1269), and with it the
  take-over (pty-manager.ts:6054, takeOverKeptLaunch), runs only once the tab is shown. The
  5-minute limit (manager.ts KEPT_TAKE_OVER_WAIT_MS) ran from the start all the same. Proven
  red in a unit test on B1b's head fd31052b before any change.
- **Fix.** The renderer tells main which tabs Resume restored (session-persistence.ts
  restoreSavedSessions, `pty:tabsRestored`) and which tab is shown and starts
  (TerminalView's first start, `pty:tabShown`); a close's `pty:kill` says a tab went. Main
  (manager.ts restoredTabs, tabShown and tabClosed, reached through kept-launches.ts as the
  take-over is): a restored tab's kept session has no time limit until the tab is shown; from
  then the 5 minutes run again (its launch may wait at its account picker); a close ends it at
  once. Before Resume (the prompt left open, or Don't open) and for a tab Resume did not
  restore, the limit runs from the start as before. A quit ends it as B1's quit does. A
  Restart's kill is not a close: its tab starts again and takes the session over. Switch off:
  nothing is kept, so nothing changes.
- **Why not the take-over at the restore** (the shape the brief preferred): the take-over binds
  from the tab's launch request (account, Codex lease, Ask, logging: launch-bindings.ts
  KeptTakeOverBinding, from `pty:spawn`'s options), which only the view sends, and the replay
  goes to a view that does not exist yet. Main would have to build the launch itself and hold
  the replay for a view mounted later: not small, and not safe in this beta.
- **Until the tab is shown** (as in B1's gap): Claude Code's hook events queue in its holder
  (at most 256 events and 2 MiB, helper/src/holder.rs HookQueue) and arrive at the take-over;
  a Conductor tool call its CLI makes waits for the take-over; a Codex session's hook events go
  to the Hooks gateway with the last run's credential and are refused, until its take-over
  writes its hook file again.
- **The warning** `[vision-mcp] Rejected unauthenticated request on port 19333 (method=POST
  ua="unknown")` (vm:B1, out/086-log-bad.txt, 12:24:53.852Z, 2.0 s after build 2's process
  started and 19 s before the take-over). Sender: the kept Claude Code CLI's status line bridge
  (statusline.ts:135: node's `http.request`, a POST with no User-Agent), which reads the
  session's status address file (`ccc-status-<tab>.url`) at each status. That file still
  named the last run's address and run credential (an HMAC over the run's own nonce,
  conductor-mcp-server.ts tokenOfForm), which the new run refuses; the bridge then wrote its
  status file instead. The take-over wrote the file again at 12:25:12.999Z (after-on.log).
  The server warns once per port per run, so later refusals were silent. Fixed: the start
  empties that file for each session it keeps for its tab (launch-bindings.ts
  holdKeptLaunchFiles, through kept-launches.ts holdKeptLaunch), so the bridge writes its
  status file with no request; the file stays, so the take-over still writes this run's
  address into it. With hidden tabs now kept for longer, every status in that time would
  otherwise be a refused request.
- Not checked here: the VM line (update mid-turn with the tab hidden for more than 5 minutes,
  then shown), which the orchestrator runs on the frozen head.
