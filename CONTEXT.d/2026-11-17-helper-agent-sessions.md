## 2026-11-17 -- Local Claude Code and Codex sessions through the session helper, off by default (2.1.3-beta.7 section A3)

**What.** A second setting, Settings, General, Terminal, "Claude Code and
Codex sessions through the session helper" (`agentSessionsThroughHelper`),
off by default. With it on, a local agent session starts inside a holder of
the session helper instead of straight under the app. Either setting brings
the helper up; each carries only its own kind of terminal.

**How the launch stays the same.** pty-manager.ts changes its two agent
spawn calls with no net lines: the Claude Code shell spawn and the Codex
spawn inside `spawnCodexPty` now call `spawnAgentPty({ sessionId, kind },
...)` with exactly the arguments they had. With the setting off, that is
node-pty's own spawn with those same arguments. With it on, the manager
sends the same program, arguments, folder and environment in the launch
frame. Claude Code still gets its shell and its typed launch line, so hooks,
the status line, `--mcp-config`, `--plugin-dir`, the resume picker, the
Watchdog, the colour answers and the `/exit` at a normal quit work through
HelperPty's own onData and write, as they do for a plain terminal. A Codex
npm launcher line (one string for cmd.exe) goes as the launch's `line`,
built exactly as node-pty builds its command line (a test checks the port
against node-pty's own `argsToCommandLine`), with the program alone in
`argv`. node-pty's bundled ConPTY becomes `conpty: "bundled"`: the manager
now asks `installHelperCopy` for node-pty's `conpty` folder
(`bundledConptySource`), and checks the copy (`checkedConpty`) before each
such launch. When that copy is not there, the session starts the usual way
on node-pty's own bundled ConPTY. When node-pty then fails there, it is
started on the system ConPTY and `bundledConptyFailed` is called, as
pty-manager's own fallback does. Off Windows, `checkLaunch` refuses both
fields, so such a launch starts the usual way.

**Ids.** An agent session's held id is `ag` and 30 hex characters, hashed from
the provider and the tab's app id (`heldAgentSessionId`). A plain terminal's
id is `pt` and 30 hex characters. A start after a crash tells the two apart
by the id alone (`heldIdKind`). The Machines page gets the provider back by
hashing the record's label with each provider id. The manager, protocol and
wiring code name no provider.

**After a crash (plan s11, Q1 default).** A held agent session is ended at
the next start and never offered to its tab again. Its hooks secret and MCP
token were the crashed run's alone, so its tab resumes the conversation the
usual way. A plain terminal is still kept for its tab. With both settings off,
the manager is still made at start-up when the running mark
(`app-running.json`) is there, carrying nothing new, to end those sessions.
In that case a plain terminal the crash left held is still kept for its tab,
as one is when its setting is switched off during a run; only agent sessions
are ended.

**No second CLI on one conversation (Copilot review).** The first cut waited
at most 5 s for that end and let a failed end clear the way, so a tab could
start its CLI while the old one still ran. Now an agent session starts only
once no earlier holder of its id runs (`clearAgent`): a crash's, a Restart's,
or one that did not end when asked. A holder that does not answer is asked
again every 2 s until the helper's own listing no longer has it (the listing
checks the process and its endpoint, and a reused process id by its start
time), or, when the helper cannot list, until no process has its id. It
waits until no earlier holder of its id runs, at most that holder's away
clock (capped at 5 minutes) plus 10 s; after that it starts nothing and the
tab says why, and the next start for that tab asks again. With the setting
on the wait happens in `hold()`. Otherwise it happens through a HelperPty
whose hold waits and then hands over to the usual start (or to the "nothing
started" terminal).

**Second review (PR #705), what changed.**
- A start the tab ends while it waits (a Restart, a close, a quit) now
  starts nothing: `hold()` checks, after its last wait and just before
  `hold --detach`, whether its terminal still wants starting. Before, both
  the ended start and the next one went on to `hold --detach` once the clear
  settled, and the ended one could end the next one's freshly launched CLI.
  This applies to plain terminals too: one still starting at a quit starts no
  holder at all. A clear that is still pending when a newer end of the same
  id begins now waits for that end as well.
- An agent session a normal quit could not end in time (the quit sends the
  end and waits 1.5 s at most) is ended at the next start before its tab
  starts its CLI again. Start-up makes the manager when the store has an
  agent session's record, whatever the settings say (`agentRecordsIn`), and
  `start()` begins those ends at once on the normal path too, as on the crash
  path, so a tab restored at once waits for them.
- The usual-way terminal under a HelperPty is now guarded (P3.15): the PTY
  manager guards the object its spawn answered, the HelperPty, which
  node-pty's sockets are not on, so the node-pty terminal a HelperPty falls
  back to was never guarded. A "write EAGAIN" on its input after Ctrl+C ended
  Codex on the bundled ConPTY would have quit the app. Plain terminals had the
  same gap since beta.6. The grace and the line it shows moved into
  `pty-input-guard.ts`, shared with the PTY manager.
- A start that may start nothing is logged as that ("nothing is started for
  this tab, because ..."), never as a start the usual way
  (`NothingStartedError`).
- Machines: an agent row reads "Being ended" when no tab of this run shows
  it, and its End asks "End this Claude Code session? Its CLI stops. Its tab
  can resume the conversation." with the button "End session". A row counts
  as its tab's only through the holder that terminal started, not through a
  new start waiting under the same id.
- The holder's Ctrl+C call is checked, made once per holder process, and
  made before anything is created: when it fails, the launch fails, and the
  app starts that terminal the usual way.
- One process-liveness check (`src/main/process-alive.ts`) for the PTY
  manager and the helper, and one provider-name map in the renderer
  (`src/renderer/provider-names.ts`) for the Machines page, the usage page,
  the footer, the Memory page and the new agent dialog.
- pty-manager.ts is now 8,352 lines (the process check and the guard's
  constants moved out), and `PTY_MANAGER_LINE_CAP` is lowered to that. Its
  SSH branch is unchanged.

**Ctrl+C in a held terminal (found on the VM).** A normal quit types Escape,
Ctrl-C and /exit into each agent session. With the setting off, the Codex
resume picker ended at the Ctrl-C (exit 0xC000013A, STATUS_CONTROL_C_EXIT).
Through the helper it ignored it, and the quit waited the full 5 s before it
was ended. The cause is in the holder, and it has been there since beta.6 for
every held terminal. `hold --detach` starts the holder with
CREATE_NEW_PROCESS_GROUP (detach.rs), which turns Ctrl+C off for that
process, and a process hands that on to every process it starts. So a program
in a held terminal ignored the Ctrl+C its terminal sends, for example a native
command running in a held PowerShell. The holder now turns Ctrl+C back on
(`SetConsoleCtrlHandler(NULL, FALSE)`) before it starts the program. It has
no console itself (DETACHED_PROCESS), so no Ctrl+C reaches it. A Windows test
(`a_held_program_gets_the_ctrl_c_its_terminal_sends`) runs
`timeout /t 60 /nobreak` and expects a typed Ctrl+C to end it at once. macOS
and Linux are not affected: the child has its own session and terminal, and
nothing ignores SIGINT.

**Machines.** The kinds are Claude Code and Codex, under the tab's name, with
End only. Main refuses a Re-attach of one too. The Services count includes
them. The page's "off" sentence now names the place ("Settings, General,
under Terminal") rather than one of the two switches.

**Windows whole-tree end (plan s11, Q2 default).** Kept. Ending a held session
ends every program it started, even one in a window of its own, and the
switch's note says so.

**Gates.** The WP1 legacy-Codex ledger has four `added` rows for tests and
one for `src/renderer/provider-names.ts`. The Machines page's row went in the
second review, since the page no longer names a provider. The committed
manifest was regenerated. The spawn-site inventory lost the two
`pty.spawn(spawnCmd` sites of pty-manager.ts and gained a third
`pty.spawn(file` site in the manager.

**Owed before stable.** The ADR-009 adversarial pass on the PTY argument
construction and the agent launch through the helper (with A1's handle list
and A2's DLL load and launch fields), and on the holder's Ctrl+C change to
its process creation. Under the owner rule of 2026-11-15, betas skip it.
