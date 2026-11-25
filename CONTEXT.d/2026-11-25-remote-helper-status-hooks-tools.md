## 2026-11-25 -- remote: a helper tab gets its status line, hook events and the Conductor's tools (3.2a, 3.2b)

2.1.3-beta.18 section 3.2 (aicc_planning#431), on section 2's group. Built in
two steps: 3.2a against section 3.1's helper contract, with a fake holder in
the unit tests; 3.2b merged 3.1's reviewed head (19331daf) and runs the real
helper in remote-helper-e2e (below).

The session's own files. Before the hold, one fixed exec (`reads`,
remote-helper/scripts.ts) prints the host files the provider names
(`hostReads`) as hex: for Claude Code, `~/.claude/settings.json`, the session
folder's `.claude/settings.json` and `.claude/settings.local.json`, and the git
checkout root's `.claude/settings.local.json`, each only a plain file of the
host user's own, not a link, not writable by others (group only when it is the
user's own group), at most 256 KiB; a file that is there and not taken is
logged once. The session folder and the checkout root count only when they are
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
tab's session with no credential (recordHeldToolSession, serveToolStream). A
status or event seq already taken is not delivered twice. The image hold-back
of beta.17 is gone: the tab has the image fetch tool.

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
