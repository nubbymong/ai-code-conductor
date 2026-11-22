## 2026-11-22 -- A closed session's settings file is removed, at the quit and at the next start (aicc_planning#385)

Measured first (beta.14 C1.4, the published beta.13 on the test VM): a quit
with Close sessions and a Claude Code tab open left its three per-session
files (settings, MCP config, status URL file), untouched since the launch.
The quit's wait for /exit ran out ("Graceful exit timeout ..., force
killing"). The next start removed the MCP and status files and rewrote the
settings file from 3,496 to 462 bytes (hooks taken out), with no log line.
Closing a tab left no file in any of the 18 measured launches.

Root cause: a session's per-session files were removed only by its exit
handler (finishSession, unbindLaunchFiles in pty-manager.ts). The quit's forced
kill (gracefulExitPty's timeout) and killAllPty (the quit's teardown, an
update, the last window closed on macOS) end the process, but the app exits
before node-pty reports that end, so the handler never ran. The start-up sweep
(cleanupStaleHookEntries) then only took the hooks out and kept the file.

Fix: the forced kill and killAllPty remove the session's files at once
(unbindLaunchFiles; the exit's own removal later finds none), with no net line
in pty-manager.ts (7,773). A Codex launch is left to its exit, as killPty
leaves it: it writes none of the three files, and the record that its hooks
are Codex's must outlive the kill (P3.10 round 1 B1, round 2 R8), so a hook
already on its way never reaches Claude's account attribution or transcript
binder. The start-up sweeps remove a stale
settings-<sid>.json only when a local launch of this install wrote it: the id
has the app's shape (24 hex characters) and the file runs this install's
status line bridge for that id, or the session helper's hook mode for that
id's holder. Any other file (a user's own, an older leftover, one an SSH
session from another computer wrote) keeps the old handling. The always-run
sweep (cleanupStaleMcpConfigs) applies the same removal, so it also happens
with the hooks switched off. One log line says what each sweep removed.
