# ADR-030: One session helper on every machine, and one owner for every job

- Status: Accepted (owner decisions D1 to D20 of 2026-11-15; plan approved on
  the Agent Canvas, 2026-11-15). Only the scope of 2.1.3-beta.4 is approved for
  building. Every later slice comes back one beta at a time, and each of the
  seventeen probes below can still stop or reshape the slice it gates.
- Date: 2026-11-15
- Builds on: ADR-029 (remote sessions run through a device helper),
  `docs/remote/helper-protocol.md` (protocol version 1),
  `docs/remote/helper-threat-model.md`
- Related: ADR-009 (adversarial review), ADR-028 (beta cadence)
- Supersedes in ADR-029: decision 4, decision 10 and the step plan R1 to R14
  (see "What this changes in ADR-029")

## Context

ADR-029 moved remote sessions onto a small helper. It left three things as
they were:

- A local session lives inside the app's main process, so an update, a quit or
  a crash of the app ends it.
- Most features are built twice, once for local sessions and once over SSH,
  and the two drift apart.
- `src/main/pty-manager.ts` (over 8,000 lines) owns the terminal, the launch, the
  status parsing and the SSH branch together, so almost any session change
  pays every gate, the live SSH matrix included.

The owner set the goals of the 2.1.3 line: clear roles per component, a
simpler SDLC, updating the app without restarting sessions, one link for local
and remote sessions that carries every feature, Snap replaced, proper image
and text paste, and services with a measured cost.

## Decision

1. The session helper of ADR-029 holds every session, on This computer as
   well as on remote machines. The app becomes a client of its own sessions.
2. Fourteen components, and every job has exactly one owner (the table below).
3. The owner decisions D1 to D20 below are the design.
4. The work is an ordered list of slices in two halves, local first. Each half
   goes dormant, opt-in, default (the cutover), delete. This ADR names four
   milestones: the local cutover, the local deletion, the remote cutover and
   the remote deletion (the old SSH path is gone).

## What this changes in ADR-029

- **Kept.** One holder process per session; no daemon, no listening network
  port, nothing on `PATH`; consent, upload, hash check and self-test; the fixed
  ssh options and short environment; the default-deny tool list for remote
  sessions; framed messages with strict schemas and size limits; the labelled
  plain terminal as the floor; the review gates.
- **Widened.** The helper also runs on This computer (D1). ADR-029's devices
  are called machines, and This computer is always one of them.
- **Superseded: decision 4** (no Claude token is copied to the host). An
  account with the Token sign-in kind sends its token to the holder inside the
  launch frame, held in memory only (D7). A Standard login account, and a
  machine set to use its own login, still copy nothing.
- **Superseded: decision 10** (Windows hosts wait). Windows hosts are in this
  line (D10).
- **Amended: decision 6.** The terminal's remote command is still the helper,
  run by exec. The helper now starts the CLI through the host's login shell,
  after the saved post-connect command (D8).
- **Amended: decision 7.** Image paste goes through the holder into a
  per-session paste folder (D5), not a one-shot upload before the helper
  exists.
- **Amended: the remote data rule of the helper protocol (Payload
  allow-lists).** When D9 lands, forwarded conversation content passes through
  one checked intake. A remote path is still never opened.
- **Replaced: the step plan R1 to R14**, by the ordered slices of D2. Probes
  P1 to P6 are carried; P6 no longer gates session launch (D8). Eleven probes
  are added.
- **Unchanged.** Codex over SSH stays in the feature queue.

## Components

Rows are numbered so that "does not own" can name the owner.

| # | Component | Runs | Owns | Does not own | Talks to |
|---|---|---|---|---|---|
| 1 | Core shell | Electron main process | The window and preload IPC; config and session state files; the one service registry (start, stop, health and restart of every service row, routed to the supervisor that holds the process; today's three supervisors stay); start-up and quit order; the updater (check, verify, detach every holder, install, then ask row 3 to re-open tabs and re-attach); the order of steps in the first-run flow and the upgrade assistant | Any PTY or CLI process; helper rows (read-only on Services); tool logic; account rules; paste staging; what a status or hook frame means; what is queued, or how long a session lives, while the app is away | Renderer through preload; core modules by direct call; workers over message ports |
| 2 | Renderer UI | Sandboxed window | Drawing and user input only; reporting the paste key to core | Any state of record; any file or process access; where a session runs; reading a session's screen to decide whether the app may type (moves to rows 3 and 14); the paste decision (row 8) | Core only, through preload |
| 3 | Session client and launch spec builder (new; replaces `pty-manager.ts`) | Module in core | The one list of sessions (live, detached, leftover) and their attach state; finding leftover sessions by asking each machine's helper; the one launch spec (program, arguments, environment, folder, account binding, provider files, the saved post-connect command as a pre-launch step, the lifetime kind); mapping every saved config shape to a launch spec; attach, detach, replay by offset, resize, write; re-opening tabs after an update or crash; `submit`, the one function through which the app itself types into a CLI; handing each incoming frame to its one owner | The PTY, the CLI and the screen (row 4); chunking a large write and the away clock (row 4); what an account is (row 6); what a tool does (row 7); what a frame means (row 13); when a CLI takes typed text (row 14); ssh options and host keys (row 5); conversation content (row 10) | Holders, with protocol frames: a named pipe or Unix socket on This computer, two ssh connections for a remote machine; renderer through core IPC |
| 4 | Session helper (new, Rust) | One holder process per session on the session's machine, the same binary on every system; no daemon, no port. Short-lived modes: statusline, hook, mcp relay, run, capture, list, self-test | The PTY and the CLI process; applying the launch spec exactly; the output ring with offsets; the one screen of record and the last-output time; the session folder and its removal at session end; enforcing the lifetime kind and the away clock; answering list mode; while the app is away, a bounded queue of status and hook events, holding a tool call about 30 seconds, and letting a held permission question fall back to the CLI's own prompt; chunking a large write on whole characters; transfer and paste-folder caps; holding an account token in memory only; forwarding the conversation file; screen grabbing in capture mode | Any decision (which account, sign-in kind or tools; retry or not; what to launch; which lifetime kind; whether a screen is ready; what a paste becomes); any pattern about a CLI's screen text; writing a token to disk or argv; the host's own login; its own install, update or health row (row 5); what conversation content means (row 10) | The session client only (frames); the CLI through its short-lived modes |
| 5 | Machines (new) | Module in core plus a page | One record per machine, This computer always present (OS, shell, CLI paths, pinned host key, helper version and hash, last self-test); installing, checking, re-provisioning and removing the helper on Linux, macOS and Windows hosts; the helper store on This computer; helper health rows; ssh connection settings; the transport over which row 3 asks a machine what is running; the Machines page. It stores three per-machine values for their owners: the tool allow-list (row 7), the "use this host's own login" switch (row 6), the Tokenomics exclusion (row 10) | The session list (row 3; the page shows it and its buttons call row 3); session lifetime (rows 3 and 4); the allow or deny decision; which login a launch uses; what is indexed; launch specs | Local file copy for This computer; fixed-option ssh commands for remote machines |
| 6 | Accounts | Module in core | Accounts managed once for local and remote: the registry; each account's sign-in kind; the token in the OS secure store on the app machine; per-account config folders for Standard login; which login a launch on a given machine uses; usage reads; the one in-use lease per account. It hands row 3 an account binding for a launch | Launching anything; carrying the token to the CLI (rows 3 and 4); a host's own CLI login files; a CLI's environment variable names (row 14); Codex accounts on a remote host until their probe passes | Session client (binding and lease); account web views; data workers for attribution |
| 7 | Tool host (the MCP service) | Inside core, with a real health row | The tool router; which session is offered which tools; the remote default-deny decision and its allow-list rules; the tool entry points | The transport to the CLI and what a call sees while the app is away (row 4); session identity (the holder the call arrived on); the canvas store and the browser (row 12); starting reviewer processes (row 11) | Session client (tool frames); rows 11 and 12 by direct call |
| 8 | Paste and Snap (new module) | Module in core plus the Snap overlay window | Image paste and Snap, local and remote, one path: the decision that the app takes the paste key when the clipboard holds an image; the limits table and the paste-folder cap; delivery by `file.put` to the session's holder, then asking row 3 to insert the returned path; the Snap overlay, the crop, and the macOS screen-recording permission check. Until the old paths are deleted it also runs today's delivery route for sessions still on them | Screen grabbing (row 4); text paste (rows 3 and 4); when and how a CLI takes typed text (row 14); the paste folder on disk and its deletion (row 4); any shared image library; other file kinds, drag and drop, annotation tools, window capture | Helper capture mode as a child process; session client |
| 9 | Watchdog | In-process service in core | Limit, rate-limit and stop-failure detectors per CLI; reset-time parsing; whether and when to retry, and with what text; the sleep state shown to the user | The screen (row 4); whether the screen will take typed text (row 14); typing the retry (row 3); hook transport; other hook events | Session client (screen tail, last-output time, submit); row 13 (StopFailure) |
| 10 | Data workers (session logging, usage index) | Two Electron utility processes, each under its own supervisor | `transcripts.db` and `tokenomics.db`; tailing local transcript files; whether the usage index runs at all and what it excludes; the bounded transcript walks; taking a Token session's conversation before its per-session folder is deleted; the intake of conversation content forwarded from a remote machine (size caps, content checks, its own store) | Session lifecycle; finding the local transcript path (row 13); carrying remote content (rows 3 and 4); deleting a session folder (row 4); storing the per-machine exclusion (row 5); prices and model data | Core over message ports |
| 11 | App-wide services (Sentinel, Insights, cloud agents, reviewers, Ask Conductor, model registry, pull request integration, vendor status) | Modules in core, one service row each | Their own schedule, inputs and results. Each asks for a one-shot run by handing a launch spec to row 3 | Starting processes (helper run mode); account rules (row 6); reading a screen or deciding it is ready (rows 4 and 14); anything per session | Session client; row 13; Accounts; network |
| 12 | App-bound views (canvas store, canvas marker queue, vision browser, browser pane, account web sessions, artifacts viewer) | Core and renderer, tied to Electron | Canvas versions, review notes and their serving; the canvas marker queue, held until the turn boundary; the headless browser and its targets; vision screenshot files, handed to the calling session through row 8's route; web views and their navigation rules | Reach into a session (rows 3 and 7); typing a marker or deciding the prompt is ready (rows 3 and 14); file transfer (row 8) | Tool host by direct call; session client; rows 8 and 13; renderer |
| 13 | Session signals (status and hook consumers) | Module in core. Until the old path is deleted it also owns the hooks gateway utility process | What a status frame and a hook frame mean: statusline data, the attention indicator, the hook event stream and its per-session ring, redaction, permission cards and their answers (This computer only), turn boundaries. It hands the transcript path to row 10, StopFailure to row 9 and the turn boundary to row 12 | How frames arrive or are queued (rows 3 and 4); which fields a CLI's payload keeps (row 14); limit detection and retry (row 9); drawing (row 2) | Session client; rows 9, 10 and 12; renderer through core IPC |
| 14 | Provider packages (Claude, Codex) | Modules in core plus shared pure code | Everything that is knowledge about one CLI: launch arguments, environment variable names, provider files; the managed-launch project gate; which status and hook fields are kept; how to read that CLI's screen for the ready state and how to submit text; whether that CLI attaches an inserted image path like its own paste; the stricter check on a remote-drawn screen; the text of the status strip controls | Sessions, launching or writing (row 3); the screen (row 4); limit detectors and retry (row 9); which account or sign-in kind (row 6); the paste decision (row 8) | Called by rows 3, 6, 8, 9 and 13; no process, no transport |

## Owner decisions

- **D1 Update without restart.** A local session gets a holder too, so the CLI
  never knows the app went away. This is detach and re-attach, not save and
  resume. The holder keeps the PTY, the output and the screen; status and hook
  events queue in it; a held permission question falls back to the CLI's own
  prompt; a tool call waits about 30 seconds for the app, then is answered
  "AI Code Conductor is updating, try again shortly". The window restarts and
  re-attaches with scrollback.
- **D2 Schedule.** An ordered list of slices, judged on progress. Each beta
  takes as many as fit, and the next is re-cut from the measured pace. Order
  is fixed only where it matters: dormant before cutover, cutover before
  deletion, each probe before the build it gates. The owner approves one beta
  at a time.
- **D3 Snap engine.** Our own capture mode in the helper and our own overlay.
  The macOS crash is root-caused first and the engine on macOS follows the
  finding: the current capture library stays if the fault is our wrapper, the
  system framework is used if the library is the crash, and Electron's
  `desktopCapturer` sits behind our overlay if a helper child cannot capture.
  The third-party Snap package is deleted either way.
- **D4 Snap scope.** Whole screen or a rectangle. No annotation tools and no
  window capture.
- **D5 Paste.** Images and text. With an image on the clipboard the app takes
  the paste key, sends the image to the holder's per-session paste folder and
  inserts the path so the CLI attaches it, the same local and remote. A probe
  first checks that Claude Code and Codex attach an inserted path like their
  own paste; a CLI that does not keeps its own paste on This computer. Text
  paste goes through the holder, chunked on whole characters. The paste folder
  is capped and deleted when the session ends, and the shared screenshots
  library goes away. Other file kinds and drag and drop are not in 2.1.3.
- **D6 Remote gains.** Remote sessions get the hook event stream, canvas notes
  at the turn boundary, Watchdog StopFailure, and image paste into plain and
  partner terminals. The event stream is internal plumbing with no page.
- **D7 Accounts.** Managed once in the app, for local and remote. Each account
  has a sign-in kind.
  - Token: a long-lived token from the CLI's own setup-token flow, kept in the
    OS secure store on the app machine and sent to the holder inside the
    launch frame, never in argv and never on the host's disk. The holder gives
    it only to that CLI's environment, with a per-session config folder that
    is deleted at session end. The host's own login is untouched.
  - Standard login: the full sign-in. Locally it binds by a per-account config
    folder instead of moving the home folder, which lifts the macOS
    multi-account limit. Remotely it means the host's own login or a sign-in
    done on that host.
  - A per-machine switch says "use this host's own login".
  - Central Codex accounts on a remote host wait for their own probe. Until it
    passes, Codex there uses the host's sign-in.
  - Token or Standard as the default kind is decided after the probes.
- **D8 SSH post-connect command.** Saved configs are unchanged. The helper
  runs the command in the session's own terminal through the host's login
  shell, then starts the CLI in the same shell, so the folder, the environment
  and any prompt carry over. The button overlay goes. On failure the tab shows
  the error and offers "Open a plain shell".
- **D9 Remote sessions on Logs and Tokenomics.** Included, as the last remote
  slice. The helper forwards the conversation file, and everything a host
  sends is treated as untrusted: size caps, checked content, no remote path
  opened. Per-machine Tokenomics exclusion lands with it.
- **D10 Windows remote hosts.** Included. The same helper, installed under the
  user's local application data folder, provisioned with PowerShell commands
  and launched through the host's sshd. The holder replaces tmux and psmux on
  every system, so Windows hosts gain re-attach. Only a truly unsupported host
  opens as a labelled plain terminal.
- **D11 Tokenomics fixes.** Token counts in the headline row and a tokens or
  cost switch on the chart; an on or off switch in Settings (off means the
  worker is not started, and recorded data is kept); exclusion per account
  now and per machine with D9; the worker's cost measured and shown on its
  Services row; the transcript walks counted, with a test that fails if a
  walk widens.
- **D12 Future seams.** Recorded below, not built. 2.1.4 is a focus release on
  files.
- **D13 Session lifetime.** tmux is not a requirement: the holder detaches on
  every system and a re-attach replays what was missed. Behaviour stays as
  today. A plain SSH session ends when its tab is closed, or when the app has
  been away longer than a grace of 2 minutes, so an update, a crash or a
  network blip does not end it at once and nothing is left running. An SSH
  Persistent session runs until the user ends it. After an update or crash the
  app re-opens its tabs and re-attaches. At start-up and on demand the app
  asks each machine's helper which sessions are running (a short-lived list
  mode, no daemon), and the Machines page shows them with Re-attach and End. A
  host that needs a typed password is asked when the user opens it. A session
  already under tmux at the remote cutover stays on the old path until it
  ends.
- **D14 Existing users and configs.** Every saved config shape maps to the new
  path automatically, with nothing re-entered, and the mapping is tested
  against real shapes. No screen is removed before its replacement is live and
  the default. The old path stays one click away through each cutover.
- **D15 Release spacing.** Each half goes dormant, opt-in, default, delete. A
  cutover and its deletion are at least one beta apart, with at least 2 days
  of daily use and no regression in between. Soak time is separate from
  building pace.
- **D16 Upgrade assistant.** On the first start after updating to 2.1.3
  stable, an assistant walks an existing user through what changed: the
  Machines page built from their saved SSH configs, consent to install the
  helper per host, sign-in kinds, the new Snap and paste. It can be skipped
  and re-opened from Settings, and it is built near the end.
- **D17 Shorter first run.** Before stable, first-run setup and the guided
  tour are cut to the essentials: one flow for new users, the assistant for
  upgraders, sharing steps where sensible.
- **D18 Service overhead.** Every always-running service (usage index, logging
  index, hooks gateway, Watchdog, statusline watcher, PTY integrity monitor,
  Sentinel, model registry) is measured idle and busy, the worst are
  optimised, and each shows its measured cost on its Services row. Tokenomics
  is a service like any other: off means nothing runs, on catches up from
  where it stopped, and a manual Rescan reads everything again. A walk depth
  changes only if the measurement shows it helps.
- **D19 Quit.** Quitting types `/exit` only into a session where the app
  started the CLI. Every other tab is closed, which detaches. A session the
  app wrapped in its own tmux session (SSH Persistent) is detached on quit,
  never sent `/exit`, whoever started the CLI in it: D13 and Q9 keep it
  running.
- **D20 Sessions the app did not start.** No new option. Attaching to a tmux
  session started elsewhere already works as a Terminal only SSH config whose
  post-connect command is the attach command. On the helper path the same
  config becomes a launch spec whose only step is that command. App features
  inside such a session (statusline, account, usage, attention, tools) are not
  pursued.

## Parity table

One line per feature: what it is today, and what it is once both halves have
cut over.

| Feature | Today, local | Today, remote | Target |
|---|---|---|---|
| Terminal output, input, resize, scrollback | The PTY is a child of the main process | ssh in a PTY; with persistence on, tmux owns the screen | The holder owns the PTY; raw frames with offsets; replay on attach |
| Text paste | Chunked in main, whole characters kept | The same writer, into the ssh PTY | A write through the holder, which chunks on whole characters |
| CLI launch | Claude: a shell, then a typed launch line. Codex: a direct start | A typed setup line, then a typed launch line | One launch spec applied by the holder; nothing typed |
| Saved session configs | Local, account binding and Codex shapes | SSH with a post-connect field and a persistent option; containers and sudo | Every saved shape maps to a launch spec, nothing re-entered (D14) |
| Statusline | A Node bridge posts to a loopback port, with a file fallback | A Node shim over a reverse forward, with a terminal-marker fallback | The helper's statusline mode sends a status frame; row 13 owns what it means |
| Hook event stream and attention indicator | The CLI makes an HTTP call per hook to a gateway in its own utility process | No hook event stream; attention by a marker a small remote hook writes to the terminal | Hook frames. Local keeps the full payload. Remote keeps hook name, tool name, notification text and a short error-kind label on StopFailure, and gets the stream for the first time (D6) |
| Permission answers from the app | The gateway holds the response until the user answers | None | `hook.ask` and `hook.answer` on This computer; the CLI's own prompt while the app is away, and always on a remote machine |
| Sleep indicator | Only when the Watchdog is on | The same | The holder reports the last-output time; core shows the state |
| Watchdog: limit detection and automatic retry | Off by default; a headless terminal in main per watched session | A stricter send check for a remote-drawn screen; no StopFailure | Core detectors read the holder's screen; retry through `submit`; the stricter check stays for every remote machine; StopFailure on remote too (D6) |
| Conductor tools | HTTP on a loopback port with a per-session token | The same server through the reverse forward | A stdio relay in the helper; remote calls pass the default-deny list; a call made while the app is away is held about 30 seconds, then answered "updating" (D1) |
| Vision screenshots | The tool writes a file into the shared screenshots folder | The same file, fetched by the host transfer tool | Handed to the calling session's paste folder: same cap, deleted with the session |
| Canvas review markers | Claude: the renderer's terminal reads the prompt and types. Codex: a second headless pane in main | Claude: the same renderer typing, with no turn boundary | The marker queue calls `submit`; it works with no window attached; the turn boundary comes from hook frames on both (D6) |
| Codex composer submit | A headless pane in main for every local Codex session | Not applicable | The composer rule reads the holder's screen; the pane is deleted |
| Status strip controls (Compact, model, effort) | Typed by the renderer after it reads its own terminal | The same (not checked separately for SSH) | The control calls `submit` against the holder's screen |
| Canvas rendering of project files | The project folder and the session worktree | None; inline content only | Unchanged (declared exception 3) |
| Image paste | Focus outside the terminal: the app saves the image and types the path. Focus in the terminal: the CLI pastes it itself | Claude: a prompt asking the agent to call a tool. Plain and partner terminals: a hint only | D5: the app takes the key wherever the focus is; identical local and remote, for every session kind |
| Snap | A third-party overlay and native add-on; rectangle and window capture | The same capture, then the tool prompt route | The helper's capture mode and our overlay; whole screen or a rectangle (D3, D4); delivered as an image paste |
| Recent images and storyboard | Recent lists the newest files of the shared folder; a storyboard names files for the agent to fetch | The same | Per session only (parked question Q6) |
| Other file kinds and drag and drop | None | None | Not in 2.1.3 (D5) |
| Partner terminal | A second shell PTY in main | A second ssh terminal that types a `cd` line | A second holder in the session's folder on the same machine; image paste reaches it (D6) |
| Ask Conductor hand-off | A one-shot help session on the app machine | Not applicable | A launch spec and `submit`, on the app machine only |
| Session logging | Claude and Codex sessions | Never | Local unchanged. Remote: the helper forwards the conversation file to row 10's checked intake (D9) |
| Usage index (Tokenomics) | Cost-only headline and chart; always on; no exclusions | None | Token counts and a tokens or cost switch; on or off in Settings; exclusion per account; counted walks (D11). Remote sessions and exclusion per machine with D9 |
| Persistence, resume and update | Nothing survives the main process | A tmux ladder on POSIX hosts; Windows hosts have no re-attach | The holder survives an update, a crash and a dropped link on every system; replay by offset; tabs re-open and re-attach; the CLI's own resume only after a machine restart |
| Session lifetime and leftover sessions | A session ends with the app | A plain SSH session ends with its tab; a persistent one offers Leave running under tmux | D13: the 2-minute grace, SSH Persistent until ended, list mode at start-up and on demand, Re-attach and End on Machines |
| Containers and sudo | Not applicable | A typed entry command and a typed sudo password | Container entry as a helper step; sudo through askpass frames |
| SSH post-connect command | Not applicable | A saved command typed after connect, behind an overlay of buttons | D8: run through the login shell in the session's terminal, then the CLI in the same shell; the overlay is removed |
| Remote host kinds | Not applicable | Live packs for Linux and macOS hosts and a prototype Windows path | The helper on Linux (x64, arm64, 32-bit ARM), macOS and Windows hosts (D10); anything else is a labelled plain terminal |
| App accounts | Windows and Linux, by moving the home folder; off on macOS | The host's own login | D7: Token or Standard login per account; remote by Token in the launch frame, or the host's own login by the per-machine switch |
| Codex sessions | Yes | Refused | Remote Codex stays in the feature queue (declared exception 2) |
| Plain terminal | A shell PTY in main | An ssh terminal | The holder; an unsupported host opens as a labelled plain terminal |
| First-run setup terminal | Its own PTY in the setup handlers | Not applicable | Through the helper, or the one PTY the app keeps (declared exception 10) |

## Protocol changes

Fifteen changes to protocol version 1. Each is written into
`docs/remote/helper-protocol.md` by the slice that first uses it, inside that
slice's adversarial pass.

1. **Local transport.** A named pipe or Unix socket on This computer.
2. **Capture mode.** A command-line mode on This computer only; display frames
   only.
3. **Held-hook reply.** `hook.ask` and `hook.answer`, on This computer only.
4. **Local hook and status payloads.** The full payload on This computer; the
   remote keep-list is unchanged except for change 13.
5. **Screen reads.** `screen.tail` and `screen.read`, both read-only.
6. **One-shot run mode**, beside `external` and `held`.
7. **`file.put` on This computer.** The per-session cap and the removal of the
   paste folder at session end apply locally too.
8. **Large writes.** The holder chunks a write on whole characters.
9. **Away behaviour.** A bounded queue for status and hook events; the mcp
   relay holds a call about 30 seconds, then answers the fixed updating
   message; a held permission falls back to the CLI's own prompt.
10. **Launch through the login shell**, with the saved post-connect command as
    a pre-launch step in the session's terminal. This widens "it starts only
    its spec's argv" to a fixed wrapper around the login shell; the command
    text is the user's own saved text, shown on the consent screen.
11. **Account secret slot.** One secret-typed field in the launch frame:
    memory only, never argv, never disk, given only to that CLI's environment.
12. **Conversation forward.** A new frame kind that carries conversation file
    content from a host to one checked intake. A remote path is still never
    opened.
13. **Remote hook keep-list.** One added field: a short error-kind label on
    StopFailure, cleaned and capped like the other labels.
14. **Session lifetime.** The launch spec carries a lifetime kind and the
    holder runs the away clock; list mode is used on This computer too.
15. **Host platforms.** Windows hosts, with the user's local application data
    folder as the install root, PowerShell one-shot commands and a named pipe
    on the host. Not a frame change; numbered so a reference to it is exact.

## Declared exceptions

"Every feature, local and remote" holds with these exceptions.

1. Accounts. A Token account works on any machine. A Standard login account is
   not carried to a remote host. Claude Code Remote Control and extra-usage
   credits need Standard login (probe P12, result under Probes). Codex on a remote host uses the
   host's sign-in until probe P14 passes. If probe P17 fails, Standard login
   keeps the home move on Windows and Linux, so two binding methods remain.
2. Codex over SSH stays in the feature queue.
3. Canvas rendering of a remote machine's project files waits for a canvas
   source seam. Remote canvas content is inline only.
4. The remote hook payload is cut down, so permission answers from the app are
   for This computer only. A remote session asks in its own terminal.
5. A truly unsupported host (for example FreeBSD), or a host that refuses the
   upload, opens as a labelled plain terminal with no features.
6. Paste covers images and text only. If probe P11 fails for one CLI, that CLI
   keeps its own paste on This computer.
7. Snap is whole screen or a rectangle. Linux capture stays experimental. The
   old engine stays one click away on Windows and Linux until the old Snap
   package is deleted.
8. Update. The window restarts; sessions do not. A session in the middle of a
   task may see one tool call wait about 30 seconds or be answered "updating",
   and one permission question in its own terminal. A plain session ends if
   the app stays away longer than the 2-minute grace.
9. App-bound views (row 12) have no Services rows of their own in this line.
10. The first-run setup terminal may remain the one PTY the app owns. This is
    settled no later than the shorter first-run flow (D17).
11. Hooks on This computer, only if probe P16 fails: the HTTP hook gateway and
    its utility process stay, hook events fired while the app is away are lost
    instead of queued, and one loopback listener remains.
12. A session already under tmux at the remote cutover stays on the old path
    until it ends (parked question Q10).
13. The shared screenshots folder lives until the remote deletion, because the
    old remote route uses it until then. Helper sessions never write to it.

## SDLC targets

A check that prints these numbers on every PR is its own slice, after beta 4.
Values for today were read from the code where a file is named, and are
otherwise carried from earlier measurement.

| Number | Today | Target |
|---|---|---|
| CI time per PR | Median about 26 minutes; the Windows test job sets it | Windows test job at or under 15 minutes; Rust helper job at or under 10 minutes |
| Files per change | Median 14.5 | Median at or under 10 after the local deletion (observed, not enforced) |
| Gates per change | A change in `pty-manager.ts` owes 14 | At most 13 for a change that leaves the live radius; no file on both the adversarial list and the live radius after the remote deletion |
| Live SSH matrix rows | Six per-host packs under `tests/live` | None for a PR that leaves the radius; a radius of no files at the remote deletion; then about 8 helper rows per helper release, one on a Windows host |
| `src/main/pty-manager.ts` lines | 8,367 on 2026-11-15 (#681 raised it from 8,128 before the check existed; #689 added one line) | Capped at its length on beta when the check was added: `PTY_MANAGER_LINE_CAP` in `scripts/ci/pr-numbers.mjs` is the one source of the number, and the check fails a PR that grows the file past it unless the PR carries the `cap-override` label; lower after the local deletion; gone at the remote deletion, replaced by a session client and launch spec builder of under 2,000 lines together (estimate) |
| Loopback listeners the app opens | 2 | 1 after the local deletion if probe P16 passed; 0 after the remote deletion (1 if P16 failed) |
| Utility processes | 3 | 2 after the local deletion if probe P16 passed |
| Supervisors | 3 (shown through one registry from beta 4) | 2 once the hooks gateway is gone |
| PTY owners in the app | 3 files | 0 or 1 after the remote deletion |
| Native add-ons loaded in main | 2 | 1 once the old Snap package is deleted; 0 or 1 after the remote deletion |
| Headless terminals in main (the Watchdog and the Codex session screen) | 2 | 1 after the local deletion; 0 after the remote deletion |
| Readers of one session's screen | Up to 3 | 1 |
| Installer size | Not printed | Printed from the first build that carries the helper, and again when the Linux and macOS host builds and the Windows host builds are added |

- **Pace.** After each release the next beta is cut from the measured hours
  per slice, not from a calendar. Soak time (D15) is not in those hours.
- **Honest cost.** Until the remote deletion the SDLC is heavier, not lighter:
  a Rust toolchain and signing, seventeen probes on real machines, two session
  paths side by side, and five dedicated adversarial rounds that the decisions
  add (the token on This computer, the token on a remote machine, the remote
  conversation intake, Windows provisioning, the user's own pre-launch
  command).
- **Test-only items.** The frame recorder and CI replay, the latency and
  throughput budget job, the CI sshd rows, the screen fixture comparison and
  the saved-config mapping suite run in CI or on test machines only and ship
  nothing to users.
- **Gates that stay.** Every slice that touches an ADR-009 path takes the
  pass, a default flip included when what it switches on is such a path. A
  docs-only or CI-only slice outside those paths does not, and an unsure case
  fails closed. For beta releases the owner decided on 2026-11-15 that the
  pass may be owed at merge: every owed pass runs in one security round
  before the stable release, and nothing reaches stable with a pass owed.
  The SSH statusline live matrix in `AGENTS.md` stays in force
  for its radius until the remote deletion. A security finding follows the
  embargo rule in `SECURITY.md`; none is described here.

## Probes

Each probe runs before the slice it gates. P1 to P6 keep ADR-029's numbers;
their questions, gates and fallbacks are restated for the slice plan.

| Probe | Question | Gates | If it fails |
|---|---|---|---|
| P1 | Does a helper status frame arrive within 2 seconds on a host where the statusline is missing today? | Remote sessions through the helper | That machine stays on the old path until the cause is found |
| P2 | Do saved passwords pass through askpass with the Windows ssh client? | Adding a remote machine | The in-process SSH library ADR-029 names as the fallback |
| P3 | Does a holder outlive the ssh logout that started it? | Remote sessions through the helper | That host kind is labelled "no re-attach" and resumes by conversation id |
| P4 | Does a CLI on a remote host attach an image from an inserted path? | Remote paste | The host transfer tool stays for remote sessions, through the helper relay |
| P5 | Can sudo be answered without a terminal, through askpass frames? | Containers and sudo | The user answers the sudo prompt in the session's own terminal |
| P6 | Is the `PATH` of an ssh exec the same as the login `PATH`? | One-shot commands only | CLI paths come from a login-shell lookup in the probe report |
| P7 | On Windows, do a detached holder and its console child survive app exit and the installer? | Local sessions through the holder; update without restart | The helper store is excluded from the installer's close step; or the system console host is used |
| P8 | The same survival question on macOS and Linux | Update without restart | On that system an update keeps today's end-and-resume behaviour and says so |
| P9 | Can a signed helper started by the app capture the screen on macOS, and does a denied permission return a clean error? | Snap replaced | Electron's `desktopCapturer` behind our overlay on macOS |
| P10 | What is the root cause of the macOS Snap crash? | The Snap engine on macOS | Build with the current library behind a capture interface and the permission check first; switch engine only on a second crash |
| P11 | Do Claude Code and Codex attach an image from an inserted path like their own paste, as a bracketed paste and as typed text? | Image paste, local and remote | That CLI keeps its own paste locally and the tool route remotely |
| P12 | On a Token session: are the rate limits in the statusline data, what does the usage read answer, and is Remote Control unavailable? | Token sign-in, and the default kind | Token accounts show "usage not available" and Standard login is the default |
| P13 | On macOS, where does Claude Code keep its account file under a per-account config folder, and do keychain entries separate? | Standard login by config folder on macOS | macOS multi-account is delivered by the Token kind only |
| P14 | Can one centrally held Codex sign-in be used on more than one machine? | Central Codex accounts on a remote host | Codex on a remote host uses the host's sign-in |
| P15 | On a Windows host, can a helper started by sshd create a console terminal that outlives the connection, and which shell does sshd give an exec? | Windows remote hosts | The terminal is carried as frames on the side connection; the owner is told before Windows machines become the default |
| P16 | What does starting one helper process per hook event cost on Windows? | Hooks through the holder | Declared exception 11 |
| P17 | On Windows and Linux, does binding a Standard login by config folder separate identity the way moving the home folder does? | Standard login by config folder there | Declared exception 1 |

P12 result (2026-11-15): a Token session runs and keeps its usage figures;
Remote Control and extra-usage credits need a Standard login; which kind is
the default is decided before the accounts slice.

P7 result (2026-11-15, Windows test machine, the skeleton holder from #685 and a silent
install of 2.1.3-beta.4): yes. A detached holder is not in a job object, and it and its
console child survive the app process tree being ended and the installer running; a
new process re-attaches, types, and replays from an offset. One condition: the helper
must run from a per-user folder outside the install folder, because the installer
removes the install folder's files (run from there, the holder survived but its program
file was gone, so nothing could attach again). Local sessions through the holder (S6)
are unblocked on Windows on that condition.

P16 result (2026-11-17, Windows test machine, the signed helper of 2.1.3-beta.7 from its
per-user copy, Defender real-time protection on): pass. Claude Code 2.1.296 starts a
command hook through Git for Windows: `bin\bash.exe -c "<command>"` starts
`usr\bin\bash.exe`, which starts the command, and the launcher gets a console of its
own, so one event is four processes. `aicc-helper list` behind that launcher, standing
in for one hook event, ran 350 times (300 at 2 a second, 50 back to back) with no
failure: p95 wall time 34.0 ms, longest 39.6 ms, mean CPU 27.6 ms per event, against a
pass line of 150 ms, 750 ms and 50 ms set before measuring. The helper is about 3 ms of
that CPU; Git Bash and its console host are the rest. Defender's own process adds about
19 ms of CPU per event outside the chain. Today's HTTP hook, for reference, takes about
0.7 ms and 1.1 ms of CPU per POST. Measured on one fast machine (`helper/probes/p16-windows-hook-cost.ps1`).
Hooks through the holder (S12) are unblocked on Windows; the hook command must be
written for Git Bash (forward slashes, quoted paths).

## Parked questions

None blocks beta 4. Each default stands until the owner is asked, before the
slice named.

- **Q6** What replaces the shared screenshots folder for Recent images,
  storyboards and vision screenshots? Default: per session only, deleted when
  the session ends. (Before local image paste.)
- **Q7** Is Codex on remote machines part of 2.1.3? Default: no. The helper is
  the same for every CLI, so it is one provider slice later. (Before remote
  sessions through the helper.)
- **Q8** Does a Token session see the machine's own skills, agents, memory and
  past conversations? Default: yes; only the sign-in is private to the
  session. (Before Token sign-in.)
- **Q9** What does a normal quit do to local sessions, and does the 2-minute
  grace apply after an update or crash? Default: a normal quit ends local and
  plain SSH sessions as today, and SSH Persistent keeps running; after an
  update or crash a local session waits 2 minutes for the app. (Before update
  without restart.)
- **Q10** What does a user see when a tmux session from the old path is still
  running after the build that deletes that path is installed? Default: it
  keeps running; Machines lists it as started by an older version, with End
  and Open as a plain terminal. (Before the remote deletion.)

## Future seams

Recorded here, not built in 2.1.3 (D12).

1. **Browser access to the whole app, and the app's own remote control**,
   through a tunnel service (Cloudflare Tunnel is the one named). The seam: a
   typed message API between UI and core that does not depend on Electron
   IPC; more than one viewer per session; Electron-only UI behind capability
   flags; authentication always in front, and the core never exposed bare.
2. **Canvas plugins.** The seam only.
3. **What 2.1.3 does so the seams stay open, at no extra cost.** Frames
   between core and holder never assume a single viewer. Row 2 holds no state
   of record. Each session keeps the helper version that started it, so the
   helper can later update apart from the app.

**2.1.4 is a focus release on the files the app creates, copies or watches:**
compressing or archiving old transcripts and logs, retention, disk use. The
per-session paste folder (D5) and the counted walks (D11) are the only
file-hygiene items taken into 2.1.3.

## Consequences

- A local session no longer dies with the app, and the app can be updated
  while sessions run.
- One code path serves local and remote sessions, so a feature is built once
  and remote sessions gain what they never had (D6, D9, D10).
- `pty-manager.ts`, tmux and psmux as host requirements, the typed launch
  lines, the shims, the post-connect overlay, the third-party Snap package,
  the shared screenshots folder and the hidden terminals in the main process
  all go by the end of the line.
- Two session paths run side by side until the remote deletion, and the old
  path stays one click away through each cutover (D14, D15).
- A second language (Rust) and a signed helper binary enter the release
  pipeline, on This computer first.
- For the first time the app keeps a long-lived account token in its own
  secure store and sends it to a holder (D7), which is why those slices have
  adversarial rounds of their own.
