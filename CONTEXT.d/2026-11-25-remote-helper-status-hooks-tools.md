## 2026-11-25 -- remote: a helper tab gets its status line, hook events and the Conductor's tools (3.2a, 3.2b)

2.1.3-beta.18 section 3.2 (aicc_planning#431), on section 2's group. Built in
two steps: 3.2a against section 3.1's helper contract, with a fake holder in
the unit tests; 3.2b merged 3.1's reviewed head (19331daf) and runs the real
helper in remote-helper-e2e (below).

The session's own files. Before the hold, one fixed exec (`reads`,
remote-helper/scripts.ts) prints the host files the provider names
(`hostReads`) as hex: for Claude Code, `~/.claude/settings.json`, the session
folder's `.claude/settings.json` and `.claude/settings.local.json`, and the git
checkout root's `.claude/settings.local.json`, each a regular file of at most
256 KiB. The user's own file is read as Claude Code reads it, a link followed,
so a dotfiles link (stow, chezmoi, Home Manager) keeps its hooks in the
session's settings; a project file only when it and every folder on its way
are no link and the host user's own, not writable by others (group only when
it is the user's own group). A file that is there and not taken is logged
once. The session folder and the checkout root count only when they are
not the home folder or above it; the root follows the usual SSH setup's rule.
The provider's launch is asked again with what was read (its program,
arguments and variables must not change). After the hold, one exec (`files`)
writes the launch's files into `~/.aicc/<did>/sessions/<sid>/` (0700),
contents on standard input: Claude's `settings.json` (statusLine = the helper's
status mode; hooks = the host's own in Claude Code's order, then the hook
mode's nine, identical entries once) and, while the app serves its tools,
`mcp.json` (conductor = the helper's relay). The CLI gets `--settings` and
`--mcp-config` first on its line. They name the helper's path, its store and
the session id only. The folder goes once the holder ended (`unsession`); a
Check removes any whose holder is gone (`sweep`, after list mode).

The routing (remote-helper/signals.ts). The tab's connections ack `status`
(new: protocol.ts STATUS_CAP, readStatusFrame; connection.ts `status` option
and event), `hooks` and `mcp`. A status is cut to the launch's `statusKeep`,
mapped by the provider (`statusLine`, a new optional member of the group), and
delivered for the tab's own id through statusline-watcher.ts
dispatchHelperStatus (no transcript path, no usage buckets). A hook event is
cut to `hookKeep` and goes to helperHookEvent with `remote` (its transcript
path stays display text, never the binder's). A tool stream is served as the
tab's session with no credential (recordHeldToolSession, serveToolStream),
through the same links a held session on this computer uses
(session-helper/tool-links.ts, moved out of manager.ts so both share one
copy). A status or event seq already taken is not delivered twice. Once the
holder ended, the tab's hook state goes (RemoteSignalDeps.ended,
endHelperHooks), as a held session's does, before its folder is removed: a
Restart reuses the tab's id, and its Hooks feed starts empty with its overflow
and lost-event notices armed again. The image hold-back of beta.17 is gone:
the tab has the image fetch tool.

Off by default, unchanged when off: pty-manager.ts untouched; the usual-path
tests now run with the app's side plugged in and assert it is never asked.
Group shape changes (types.ts): `RemoteHelperCommands.folder`,
`RemoteLaunchOptions.tools`, `ProviderRemoteLaunch.statusLine`.

The real helper (3.2b). remote-helper-e2e builds the helper from helper/,
which is 3.1's reviewed tree byte for byte; the binary it built has the
SHA-256 of 3.1's helper-linux-musl artifact (Helper run 45570181579),
365a78ea...e1ac. Its live file now runs, on the host, the commands a tab's own
settings.json and mcp.json name, as Claude Code runs them: the status mode and
the hook mode with the JSON on standard input, and the relay as a tool
server. Each reaches the app's side once (a status strip, a hook sink and a
tool host with no Electron). Then the link's ssh is killed and its new link
held back (a gated runner) until the holder's record says it is not
attached; two statuses, two hook events and a call from a tool server
started in the cut (a batch the relay answers at once while the app is away
shows it holds the call) arrive once the tab is back: the newest status only,
the events once each in order, the call answered by the app. All three cross
again after, and two tabs at once each get only their own. Green on db4e4bf3
(run 45580498626, retries 0); red with helper/ put back to its tree before
3.1 ("aicc-helper: unknown command status", run 45580902430, a throwaway
branch since deleted).

The review's fix round (2f7968f8, 82b8a030). A tab's hook state is ended at
its end (above). The tool stream links are one copy (tool-links.ts). The
user's own settings file is read as Claude Code reads it (above). The live
file now runs against a real shell what only fake answers reached before: a
project file open to others (mode), one over the bound (size) and, by sudo
on the runner, another user's (owner), each not read with one log line; a
tab in the home folder reads no project or checkout file, and on the runner
the account's ~/.claude/settings.json, made a link for the step and put back
after, is read first; a running tab's end removal answers `held`; a Check
sweeps one folder whose holder is gone and keeps the running tab's; each
tab's hook state ends once. Green on 82b8a030 (run 45587703224, 13 of 13,
retries 0). Red with the round's two fixes reverted and the owner, mode,
size and held answers mutated (run 45587798588: those six steps red), and
with the home folder guard and the sweep's record check mutated (run
45587864235: those two steps red); throwaway branches since deleted.

The final-head review's minors. The unit test of skipped files no longer
answers a link for the user's own file, which the reads script never sends
now; that read is skipped for its size, and the link case is a project
file's (red with `link` taken out of HOST_READ_SKIPS: that line reads
`unknown`). The screenshot menu loses its unused tab-type prop; the menu is
rendered nowhere in src, which predates this section and goes to its own
lane. Two comment fixes in types.ts and session-hooks-writer.ts.
