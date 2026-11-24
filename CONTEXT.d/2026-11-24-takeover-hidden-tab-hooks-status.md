## 2026-11-24 -- A restored tab not on screen: its kept session's hook events reach it at once, and its hook record is kept at the take-over

Plan 2.1.3-beta.17, section B1e (aicc_planning#423; vm:B1d's notes on the record and on
Claude Code's approval question), on B1d. Windows, behind the agent sessions' switch. This
fragment supersedes, where it says otherwise, two bullets of B1d's fragment
(2026-11-24-takeover-hidden-tab-serves-tools.md): "As B1 defines it, unchanged" (its last
sentence, on Claude Code's hook events) and "The take-over and the ends" (on the serving
token), and with them the hook sentence of B1c's "Until the tab is shown" bullet
(2026-11-24-takeover-hidden-tab-keeps-session.md). Those fragments are not edited
(CONTEXT.d/README.md).

- **Found (measured first, red in unit tests on B1d's head ab995f72).** (1) A kept Claude
  Code session's hook events waited in its holder until the take-over (helper/src/holder.rs
  HookQueue, 256 events and 2 MiB, the oldest dropped): while its tab was not shown it got
  no attention mark when its turn ended or when Claude Code stopped at its own approval
  question, and a turn hidden long enough lost its oldest events. (2) At a Codex take-over
  the tab's hook record started again: the take-over's kill (pty-manager.ts endLiveRun)
  unregistered the token the session was served with, and unregistering a token also drops
  the events the Hooks gateway holds for that session (hooks-gateway.ts and
  hooks-gateway-proxy.ts unregisterSession). Seen too: closing such a hidden tab left it
  marked as a Codex session (its kill cleared the serving mark first, so the end that
  followed dropped nothing). (3) Not a gap, and not changed: with its status line address
  file emptied (B1c), the kept Claude Code CLI's status line writes its status file
  (statusline.ts), and the app's watcher passes any session's status file to its tab
  (statusline-watcher.ts processFile; tests/unit/statusline-session-binding.test.ts), so the
  model, context and cost do reach the hidden tab. Writing this run's address at the
  serving would only move that onto the POST, and a status read before an end would then be
  one refused request with a warning.
- **The transcript.** A hook event and a status line both hand their transcript path to one
  route (pty-manager.ts routeHookTranscriptPath, through index.ts routeTranscriptPath). That
  route now does nothing for a session the helper keeps for its tab and the tab has not
  taken over (kept-launches.ts keptForItsTab, answered by the manager's waitsForTakeOver):
  no conversation noted, no account attribution, no transcript binder. Before this, the
  status file's ticks bound the transcript before the take-over's logging run. The take-over
  binds its logging run and transcript by the saved conversation first, as B1 does, and the
  next hook event or status after it binds the transcript its CLI names.
- **Hook events (1).** From the same wait after Resume as B1d's serving (3 s), the keeper
  of a kept Claude Code session acks `hooks` (manager.ts serveUnseen, hookRoute's `unseen`),
  whether or not its tool calls are served, so its holder hands it the events it queued and
  each new one at once (helper-protocol.md section 15: events go to the attached connection
  that acked `hooks`). They reach the tab's attention mark, notifications and hook record as
  any held session's do. The take-over's hook route goes on from the last `seq` the keeper
  took: the holder sends an event to one attach only (and one whose send failed to the next),
  and the app drops a `seq` it has seen, so none is taken twice and none is lost across the
  hand-over. The take-over does not end that record; an end with no take-over (the tab
  closed, its CLI ended, the limit, a quit, End) ends it and takes nothing more. No helper
  (Rust) change: a holder from 2.1.3-beta.8 on does this. A tab shown within the 3 s, and
  the switch off, are unchanged.
- **Codex's record (2).** The kill before a launch of the tab leaves the token of a session
  served while its tab was not shown (launch-bindings.ts keepServedToken); the take-over
  writes its own over it (codexTakeOver), so the gateway keeps the events it took for the
  tab. When the take-over writes no hook file again (the Hooks gateway not listening), when
  the tab's launch is not a take-over (another account), or when the session ends (a close
  kills first, then ends it), that token goes (settleServedToken), before a launch mints its
  own.
- pty-manager.ts: eight existing lines changed (two conditions, their comments, and two
  names added to its launch bindings' import), none added. 7,773 lines on B1d's head, 7,741
  on the beta.17 aggregate.
- VM line (vm:B1e, WINDOWS_1, two unsigned builds on the real update path) passed on the
  frozen head ba559fb5. Hidden Claude Code tabs: every hook event made while hidden reached
  the app's record once (50 of 50, 34 of 34, 48 of 48); the attention mark showed at the
  approval question and about a minute after a turn ended; no transcript was bound before
  the take-over. Two events of one tool call made between the old app's let-go and its exit
  (once in six tab-updates) did not reach the new run: that is the update's hand-over, not
  B1e, and lane B1f takes it. A
  hidden Codex tab's Stop stayed in its record after the take-over. The status reached the
  hidden tab through its status file, and the address file stayed empty until the
  take-over, as item (3) says.
