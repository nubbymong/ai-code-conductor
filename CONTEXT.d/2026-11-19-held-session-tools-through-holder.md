## 2026-11-19 -- A held Claude Code or Codex session reaches the Conductor tools through its holder, behind the switch

Plan 2.1.3-beta.11, section B2 (aicc_planning#344). The second half of ADR-030 slice S15's second
step, on B1's tool host (`serveToolStream`). A behaviour change only with "Claude Code and Codex
sessions through the session helper" on, which is off by default; with it off nothing changes.

- **The wiring** (session-helper/app-wiring.ts): the manager now gets tool functions for Claude Code
  and Codex. Each serves a stream through `serveToolStream` and says the tool host is serving while
  the Conductor tools' server has a port. Claude Code's switch is its MCP config file; Codex's is
  its launch, asked of the Codex package through the provider registry (`heldToolLaunch`).
- **Claude Code** (hooks/per-session-settings.ts `switchMcpConfigToHelper`): once the holder has
  launched the session and before its launch line is typed (Claude Code reads the file when that
  line starts it), the file's `conductor` entry becomes `{type: stdio, command: <helper copy>,
  args: [mcp, --store, <folder>, --session, <sid>]}`. Only a file holding the app's own loopback
  entry for that session is switched; every other key keeps its place and text. It writes through
  the same owner-only writer and answers `switched`, `no-conductor`, `unsafe-path` or
  `not-written`, as `switchHooksToHelper` does. The hooks' switch and the tools' switch run each
  on their own: one that fails or throws does not stop the other.
- **Codex** (providers/codex/held-tool-launch.ts, new): the builder's three loopback entries (the
  address, the switch, the credential variable) are replaced in place by `command` and `args` as
  TOML strings; the timeout, the approvals, the user's own arguments and the environment stay. The
  manager asks only for the launch the holder runs, between the holder's hello and `term.launch`,
  through one new optional driver hook in helper-pty.ts (`launchArgs`); the usual start it falls
  back to keeps the spawn's own arguments. Launch shapes: Claude Code, Codex started directly, and
  the resume list handing its flags to codex.exe are switched; an npm launcher's cmd.exe line, and
  the resume list handing its flags to one, are switched only when cmd.exe's existing quoting rule
  (`codexCmdExeTarget`) carries the relay's arguments, and that rule refuses a space. The installed
  app's helper folder has one ("AI Code Conductor"), so on an installed Windows app 3 of the 5
  shapes are switched and the 2 npm launcher shapes keep the loopback route, with their log line.
  The rule is not widened.
- **Streams only for a switched session.** The manager serves a holder's `mcp.open` only once that
  session's CLI was pointed at the relay; before that, or for a session that was not, the stream
  is closed on the app's side with a log line. B1's manager tests now give a stand-in switch.
- **When a session is not switched** it keeps the loopback route and one log line says why: its
  holder offers no `mcp`, the helper copy is not known, the tool host is not serving, the file
  holds no app entry or cannot be written, a path cannot be given exactly, a cmd.exe line cannot
  carry the relay, or the helper would refuse the relay form. No log line names the helper's or
  the store's path. The loopback server, its credential and a Codex launch's credential variable
  stay as they were.
- **Departures from the plan's file list.** helper-pty.ts gains the one driver hook above (no other
  section touches it). providers/types.ts and providers/codex/index.ts carry the new optional
  provider method, because the dependency-boundary rules (R4 deep imports, R7 reachability) do not
  let app-wiring.ts import a module inside the Codex package. The writer's test is a new host-safe
  file (tests/unit/main/per-session-settings-mcp-relay.test.ts), since the existing per-session
  settings tests are HOST QUARANTINE; session-helper-app-wiring.test.ts gains the new wiring's case.
- **Known limit, until the next step:** when the app's connection to a session's holder drops and
  comes back, that session's tool server has ended; the CLI must start it again (in Claude Code,
  /mcp) or the session is restarted. It ships behind the off switch, with a known-issues entry in
  the release PR.
- **Owed:** the VM check at the release smoke (the plan's section B2 VM line), and an ADR-009 pass
  before stable (aicc_planning #320 list).
