## 2026-11-24 -- The next start takes over the agent session an update kept running (S16 steps 5 and 6)

Plan 2.1.3-beta.17, section B1 (aicc_planning#412): B1.1 Claude Code, B1.2 Codex. Windows,
behind the agent sessions' switch (off by default). Step 4 (beta.14) already let an update
keep a held agent session's CLI running and record it; until now the next start ended it and
the tab resumed the conversation in a new CLI.

- **Start.** When the running mark says "update", the switch is on, a take-over is wired for
  the provider (app-wiring.ts gives Claude Code's and Codex's), the holder's record is in the
  store and the tab is in the saved file the start restores from, the record is kept for its
  tab (manager.ts keptAtStart): a keeper stops the holder's away clock, and the record and the
  session's files stay, so the start-up sweeps pass them by. Any other record is ended as
  before, with one log line saying why. One no tab takes over within 5 minutes (the resume
  prompt left open, or a tab waiting at its account picker), one whose holder the start cannot
  reach, one whose tab starts a new CLI, and one a quit overtakes, are ended, and their record
  and files go.
- **Take-over.** pty-manager.ts asks once, before the provider branches
  (launch-bindings.ts takeOverKeptLaunch, one entry; the file stays at its 7,773-line cap: the
  failed-launch file removal moved into launch-bindings.ts, and the two Codex raw writers
  into one function the take-over shares). For a kept session nothing is spawned, written
  or typed: the helper shows the holder's terminal in the tab as a plain terminal's take-over
  does (replay, its terminal queries not answered again, the redraw after a replay from the
  middle), and its hook events and tool streams go to this run from the attach. The record
  now carries the folder the CLI was launched in and its ConPTY.
- **Bindings made again.** Both: the tool host's record with no credential, the run folder,
  the logging run. A session not indexed (logging off in Settings or in its config, or the
  notice not yet seen) has its not-indexed windows (indexing-gaps.ts) open from the time the
  update let go of it, from its record, never later than now (now when the record does not
  say), so what its CLI wrote while no app ran is not indexed later. Claude Code: the status
  line's address file only where the launch wrote
  one, the account capture, the review and canvas registrations, the transcript bind by the
  saved conversation from the recorded folder. Codex: its hook file written again in its
  kept folder with this run's port and a token minted for it (kept-hooks.ts), the lease, the
  conversation, the pane and colour answers (only live queries: the replay's are taken out),
  the telemetry claiming the saved conversation by id, and the registrations. A kept hook
  file not written again (the Hooks gateway off or not listening, the write refused) has its
  folder removed at once: it names the last run's port and token.
- **Accounts.** Only on the account its tab's launch is prepared on: a Codex launch's lease,
  or the account a Claude Code launch names (Settings, Accounts, "Ask each time" may pick
  another for a restored tab). On another account the launch goes on and ends the kept
  session first: a Claude Code session runs on the account it names or not at all.
- **Failures.** A take-over whose bindings throw ends its CLI and removes the session's files
  and its kept hook folder, as a failed launch does (no exit handler would). One that cannot
  attach says so in its tab, exits 1 and starts nothing in its place.
- **Step 6.** A tool stream given back on the take-over's first connection is served with
  `notifications/tools/list_changed` for Claude Code only (probe P20 (c)); Codex does not
  list again, and keeps the tool list it started with.
- Not checked here: the real update path and the two-build VM line (step 8), which the
  orchestrator runs on the frozen head.
