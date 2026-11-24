## 2026-11-24 -- The next start takes over the Claude Code session an update kept running (S16 steps 5 and 6)

Plan 2.1.3-beta.17, section B1.1 (aicc_planning#412). Windows, behind the agent sessions'
switch (off by default). Step 4 (beta.14) already let an update keep a held agent session's
CLI running and record it; until now the next start ended it and the tab resumed the
conversation in a new CLI.

- **Start.** When the running mark says "update", the switch is on, a take-over is wired for
  the provider (app-wiring.ts gives Claude Code's), the holder's record is in the store and
  the tab is in the saved file the start restores from, the record is kept for its tab
  (manager.ts keptAtStart): a keeper stops the holder's away clock, and the record and the
  session's files stay, so the start-up sweeps pass them by. Any other record is ended as
  before, with one log line saying why. One no tab takes over within 5 minutes, one whose tab
  starts a new CLI, and one a quit overtakes, are ended, and their record and files go.
- **Take-over.** pty-manager.ts asks once, before the provider branches
  (launch-bindings.ts takeOverKeptLaunch, one entry; the file is 7,769 lines against its
  7,773 cap, the failed-launch file removal moved into launch-bindings.ts). For a kept
  session nothing is spawned, written or typed: the helper shows the holder's terminal in
  the tab as a plain terminal's take-over does (replay, queries not answered again, the
  redraw after a replay from the middle), and its hook events and tool streams go to this
  run from the attach. The launch's bindings are made again: the tool host's record with no
  credential, the status line's address file only where the launch wrote one, the account
  capture, the review and canvas registrations, the run folder, the logging run and the
  transcript bind by the saved conversation from the folder the CLI was launched in (now in
  the record, with its ConPTY).
- **Step 6.** A tool stream given back on the take-over's first connection is served with
  `notifications/tools/list_changed` for Claude Code only (probe P20 (c)); Codex does not
  list again.
- **Codex (B1.2)** is not in this commit: a kept Codex session is still ended at the start.
- Not checked here: the real update path and the two-build VM line (step 8), which the
  orchestrator runs on the frozen head.
