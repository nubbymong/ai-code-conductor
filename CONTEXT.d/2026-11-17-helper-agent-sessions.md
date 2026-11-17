## 2026-11-17 -- Local Claude Code and Codex sessions through the session helper, off by default (2.1.3-beta.7 section A3)

**What.** A second setting, Settings, General, Terminal, "Claude Code and
Codex sessions through the session helper" (`agentSessionsThroughHelper`),
off by default. With it on, a local agent session starts inside a holder of
the session helper instead of straight under the app. Either setting brings
the helper up; each carries only its own kind of terminal.

**How the launch stays the same.** pty-manager.ts changes only its two agent
spawn calls, with no net lines (it stays at its 8,367-line cap): the Claude
Code shell spawn and the Codex spawn inside `spawnCodexPty` now call
`spawnAgentPty({ sessionId, kind }, ...)` with exactly the arguments they had.
With the setting off, that is node-pty's own spawn with those same arguments.
With it on, the manager sends the same program, arguments, folder and
environment in the launch frame. Claude Code still gets its shell and its
typed launch line, so hooks, the status line, `--mcp-config`, `--plugin-dir`,
the resume picker, the Watchdog, the colour answers and the `/exit` at a
normal quit work through HelperPty's own onData and write, as they do for a
plain terminal. A Codex npm launcher line (one string for cmd.exe) goes as the
launch's `line`, built exactly as node-pty builds its command line (a test
checks the port against node-pty's own `argsToCommandLine`), with the program
alone in `argv`. node-pty's bundled ConPTY becomes `conpty: "bundled"`: the
manager now asks `installHelperCopy` for node-pty's `conpty` folder
(`bundledConptySource`), and checks the copy (`checkedConpty`) before each
such launch. When that copy is not there, the session starts the usual way on
node-pty's own bundled ConPTY. When node-pty then fails there, it is started
on the system ConPTY and `bundledConptyFailed` is called, as pty-manager's own
fallback does. Off Windows, `checkLaunch` refuses both fields, so such a
launch starts the usual way.

**Ids.** An agent session's held id is `ag` and 30 hex characters, hashed from
the provider and the tab's app id (`heldAgentSessionId`). A plain terminal's
id is `pt` and 30 hex characters. A start after a crash tells the two apart
by the id alone (`heldIdKind`). The Machines page gets the provider back by
hashing the record's label with each provider id. The manager, protocol and
wiring code name no provider.

**After a crash (plan s11, Q1 default).** A held agent session is ended at
the next start and never offered to its tab again. Its hooks secret and MCP
token were the crashed run's alone, so its tab resumes the conversation the
usual way. The end is registered among the manager's endings, so a tab that
starts again meanwhile waits for it, at most 5 s. With the setting on, the
wait happens through `hold()`. Otherwise it happens through a HelperPty whose
hold waits and then hands over to the usual start. A plain terminal is still
kept for its tab. With both settings off, the manager is still made at
start-up when the running mark (`app-running.json`) is there, carrying
nothing new, to end those sessions.

**Machines.** The kinds are Claude Code and Codex, under the tab's name, with
End only. Main refuses a Re-attach of one too. The Services count includes
them. The page's "off" sentence now names the place ("Settings, General,
under Terminal") rather than one of the two switches.

**Windows whole-tree end (plan s11, Q2 default).** Kept. Ending a held session
ends every program it started, even one in a window of its own, and the
switch's note says so.

**Gates.** The WP1 legacy-Codex ledger gained five `added` rows (the Machines
page and four tests), and the committed manifest was regenerated. The
spawn-site inventory lost the two `pty.spawn(spawnCmd` sites of pty-manager.ts
and gained a third `pty.spawn(file` site in the manager.

**Owed before stable.** The ADR-009 adversarial pass on the PTY argument
construction and the agent launch through the helper (with A1's handle list
and A2's DLL load and launch fields). Under the owner rule of 2026-11-15,
betas skip it.
