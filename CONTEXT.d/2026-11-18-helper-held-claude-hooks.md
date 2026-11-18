## 2026-11-18 -- Claude Code sessions held by the session helper send their hooks through it (off by default)

Section A4 of the 2.1.3-beta.8 plan (ADR-030 slice S12). Only with Settings,
General, Terminal, "Claude Code and Codex sessions through the session helper"
(agentSessionsThroughHelper) on, which stays off by default, and only for a
Claude Code session whose holder offers the `hooks` capability (A3).

**What changed.**
- The per-session settings file is written for the hooks gateway as before,
  by the PTY manager in the same synchronous run as the spawn call
  (pty-manager.ts: spawnAgentPty, then writeLocalSessionSettings and
  injectHooks, no await between them), so always before the holder answers
  `term.launched`. Once the holder answers it, and before the attach sends
  the launch line, the manager switches the file in place
  (session-hooks-writer.ts `switchHooksToHelper`) if the hooks gateway is on
  and listening then: the app's own entries of the eight events other than
  PreToolUse become one command hook, the helper's hook mode
  (`buildHelperHooksBlock`), and PreToolUse stays on the gateway exactly as
  written (the gateway holds it open for the permission gate). Inherited
  hooks and the rest of the file are kept. The gateway token stays
  registered.
- The command is quoted for the launcher Claude Code uses: on Windows Git for
  Windows' `bash.exe -c` (probe P16, step 0), with each path's backslashes
  made forward slashes and each path one single-quoted word; /bin/sh
  elsewhere, single-quoted. A path with a double quote or a control
  character, a Windows path that is not a drive path, or a session id that
  breaks the helper's own pattern (protocol.ts `SID_RE`) keeps the session on
  the gateway, with one log line. So does a holder without `hooks`, a gateway
  that is off or not listening at the launch, a file with no gateway hooks of
  the session, or a failed write.
- protocol.ts reads an `event` frame strictly (its fields only, `seq` from 1,
  `kind` one of the nine and the payload's `hook_event_name`, payload at most
  65,280 bytes, message at most 64 KiB), and the connection acks `hooks` only
  when it wants hook events and the hello offers them. The connection drops
  any JSON frame off channel 0, reads an `event` before its reply lookup (so
  one carrying a `re` answers no request), and reports an event only when it
  acked `hooks`: that is the one guard. The manager drops a `seq` it has
  seen, on this connection or an earlier one, and any PreToolUse, and hands
  the rest to the session signals module under the tab's id.
- session-signals/hooks.ts `helperHookEvent` does for such an event what the
  gateway does for its own: the transcript path through
  sanitiseTranscriptPath (before redaction), then the feed entry from the
  gateway's own builder (hooks-gateway.ts `feedEntryOf`, which the gateway's
  ingest now uses too: the redaction, the bounding and the summary), a
  per-session ring of 1000, HOOKS_EVENT (and HOOKS_DROPPED once) to the
  window, then the same consumers. `lost` is logged once per session.
- An event is taken only while the gateway the module is bound to reports on
  and listening, read at each event (`helperHooksTaken`), so intake follows
  the gateway's real state: a toggle whose start gave up waiting for the
  child's bind (4 s) is followed by the bind later, with no toggle, and the
  never-started gateway of a boot with the hooks switch saved off takes
  none. The switch going off drops no ring: the gateway the app runs (the
  proxy in main) keeps its own at a stop, so the history read keeps both;
  a session's end drops both.
- The feed history read (HOOKS_GET_BUFFER) returns the gateway's ring as
  before, unless the session has helper events: then both rings, in the order
  the events reached main (an arrival count the module keeps for both
  transports, not their timestamps), the newest 1000.

**Decisions taken while building.**
- The history read merges the two rings instead of returning the helper ring
  alone (the plan's wording): the session's PreToolUse events are still in
  the gateway's ring, and returning only the helper's would drop them from
  the feed after a reload.
- The hooks dependency is keyed by provider id (`hooks: { claude: ... }`),
  so the manager looks the provider up instead of comparing its name
  (tests/unit/architecture/provider-name-ratchet.test.ts).
- The command hook carries `timeout: 10` (seconds). The hook mode ends within
  2 s; this bounds a launcher that hangs instead of Claude Code's default.
- An apostrophe in a path (a user folder such as O'Brien) is quoted as
  `'\''` rather than refused. The only backslash in the Windows command is
  that one, and it is not before a double quote, so Claude Code's own quoting
  of the command for bash.exe leaves it as it is. A test runs the command
  through the real launcher in CI on all three systems
  (tests/unit/hooks/session-hooks-helper-command-shell.test.ts, CI and VM
  only).
- Outside the plan's file list, each forced by the change:
  src/main/session-helper/helper-pty.ts (a `launched` step in the driver,
  between `term.launched` and the attach), src/main/session-helper/app-wiring.ts
  (the wiring), src/main/session-signals/index.ts and one line of
  src/main/index.ts (the window's emit for the module's own feed),
  src/main/hooks/hooks-gateway.ts (`feedEntryOf`: the ingest's entry
  building moved into one exported function, no change in it),
  docs/remote/helper-protocol.md section 15 (the app now acks `hooks`), and
  the pinned index.ts call in tests/unit/main/session-signals-hooks.test.ts.
- The writer tests for the quoting run in a new host-safe file
  (tests/unit/hooks/session-hooks-helper-block.test.ts) with the secure write
  swapped for a plain one; session-hooks-writer.test.ts is CI only, and it
  gained the one case that uses the real secure write.

**Owed.** ADR-009 pass before stable (aicc_planning #320 list): a command
line built into the CLI's settings, a new frame crossing into main, and an
IPC handler change. Release surface for the release PR: a changelog line and
the app-knowledge paragraph on the agent-sessions switch.
