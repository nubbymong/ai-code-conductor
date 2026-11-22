# ADR-030: One session helper on every machine, and one owner for every job

- Status: Accepted (owner decisions D1 to D20 of 2026-11-15; plan approved on
  the Agent Canvas, 2026-11-15). Only the scope of 2.1.3-beta.4 is approved for
  building. Every later slice comes back one beta at a time, and each of the
  twenty probes below can still stop or reshape the slice it gates.
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
| 13 | Session signals (status and hook consumers) | Module in core. Until the old path is deleted it also owns the hooks gateway utility process | What a status frame and a hook frame mean: statusline data, the attention indicator, the hook event stream and its per-session ring, redaction, turn boundaries. It answers no permission: the app answers none today (the parity table's "Permission answers from the app"), and answering one, on This computer only, would need protocol change 3 first. It hands the transcript path to row 10, StopFailure to row 9 and the turn boundary to row 12 | How frames arrive or are queued (rows 3 and 4); which fields a CLI's payload keeps (row 14); limit detection and retry (row 9); drawing (row 2) | Session client; rows 9, 10 and 12; renderer through core IPC |
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
| Permission answers from the app | None: the CLI's own prompt decides. The gateway answers every PreToolUse at once, and its hold for an answer is dormant: nothing in src sets `gateActive` (hooks-gateway.ts:472-477, :491-496), `resolveResponder` (permission-responders.ts:28) has no caller, and the per-session settings register no `PermissionRequest` | None | None planned: the CLI's own prompt, local and remote, the app away or not. `hook.ask` and `hook.answer` (protocol change 3) only if the app answers permissions again |
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
   Needed only if the app answers permissions again: it answers none today
   (the parity table), and S16 does not need it (P20).
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
4. The remote hook payload is cut down, so a permission answer from the app
   could only be for This computer; the app gives none today (the parity
   table). A remote session asks in its own terminal.
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
  a Rust toolchain and signing, twenty probes on real machines, two session
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
| P18 | On Windows, how do Claude Code and Codex start a tool server over standard input and output, and is it gone when the CLI ends? | Tools through the helper (S15) | The relay's start is planned again for that CLI, whose sessions keep today's loopback route to the tools until then |
| P19 | After a re-attach that starts in the middle of a session's output, does a resize make Claude Code and Codex redraw their screen, on Windows, macOS and Linux? | What a mid-stream re-attach does, and what the holder's screen is for (S13) | On that system the holder repaints the terminal on attach from its own screen, with the holder screen's next step and before S16's second half and S25 there |
| P20 | Once the app run that started a CLI is gone: what do Claude Code's http PreToolUse hook and Codex's hook forwarder do when the endpoint refuses, answers 401 or 404, or never answers; does Claude Code read its `--settings` hooks or its `--mcp-config` again while it runs; does each CLI list its tools again on `notifications/tools/list_changed`? | S16's second half: steps 2, 4 and 6 (CONTEXT.d/2026-11-19-what-a-held-agent-session-needs.md) | PreToolUse goes through the hook mode (step 2) before step 4 keeps that CLI's session; a take-over writes nothing into a file the CLI reads only once; step 6 is dropped for a CLI that does not list again, and its held session keeps the tool list it started with |

P12 result (2026-11-15): a Token session runs and keeps its usage figures;
Remote Control and extra-usage credits need a Standard login; which kind is
the default is decided before the accounts slice.

P3 and P6 result (2026-11-21, a Linux host with key sign-in: Ubuntu 24.04 with systemd,
bash as its login shell; the static Linux helper, aicc-helper 0.1.0, the
`helper-linux-musl` artifact of the Helper dispatch on f3080a34, run 44948601556; the
probe runs on the test PC and starts nothing there but ssh and scp): P3 HOLDS, on the line
`helper/probes/README.md` wrote before measuring. P6 is SAME on that file's line, which
compares the exec with a login shell started with `-l`, and a no-go on ADR-029's own go
line for P6, which compares the exec with the user's interactive login shell: the P6
fallback applies on this host (below). P3: six ssh sessions each
started a holder with `hold --detach` and logged out as the command ended, three with a
terminal (`ssh -tt`) and three without (`ssh -T`, an exec). A new connection found every
holder alive, by its pid and its own command line, 10 to 11.4 s and 60 to 61.4 s after its
own logout: 3 of 3 runs of each form. Each holder was still in the scope of the login that
started it (`session-<n>.scope`); nothing moved it out. The host's logind has
KillUserProcesses off and KillExcludeUsers empty, and the user has Linger on. So this host
does not clean up at logout. Not measured: a host with user-process cleanup on, the case
ADR-029's host role names, and anything past 60 s (ADR-029's go line says five minutes).
Remote sessions through the helper are unblocked on a host with these settings; a host
with cleanup on stays open until one is measured, and the "no re-attach" label is not
needed for the kind measured. P6: the exec's PATH was
`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin`,
and the login shell started from it with `-l` (the probe's reading of D8's "through the
host's login shell"; D8 does not say whether that shell is interactive) had the same
entries in the same order;
node was `/usr/bin/node` in both, and claude and codex were found in neither. The login
shell started with `-il` (recorded only) had one more entry in front, `~/.npm-global/bin`,
and found Claude Code there. So on this host the CLI sits on a path only an interactive
shell sets, which neither an exec nor `-l` reads: a start by `-l` does not find it, and its
path has to come from a lookup through `-il`, the route ADR-029's P6 fallback names. Why
the entry shows only with `-i` was not looked into. Not measured: zsh, csh, tcsh or fish
as the login shell, a `.bashrc` that returns early for a shell that is not interactive,
macOS, a password host, a home mounted `noexec`. Rocky Linux 10: not run. Its one connect,
limited to 8 s, failed at the address on file and the probe recorded "host off", a label it
also gave a refused connection and a name that does not resolve, so whether the host was
off is not known; owed to beta.14, where the same probe runs on it, changed only in that a
refused connection and an unknown name now have labels of their own. The
host that answered was left as found: every holder ended, the probe's temporary folder
deleted, and `/tmp/aicc-<uid>`, which was not there before, not there after; nothing was
made on the other. The probe is `helper/probes/p3-p6-linux.cjs`.

P7 result (2026-11-15, Windows test machine, the skeleton holder from #685 and a silent
install of 2.1.3-beta.4): yes. A detached holder is not in a job object, and it and its
console child survive the app process tree being ended and the installer running; a
new process re-attaches, types, and replays from an offset. One condition: the helper
must run from a per-user folder outside the install folder, because the installer
removes the install folder's files (run from there, the holder survived but its program
file was gone, so nothing could attach again). Local sessions through the holder (S6)
are unblocked on Windows on that condition.

P16 result (2026-11-18, Windows test machine, Defender real-time protection on as
shipped, the signed helper of 2.1.3-beta.7 from its per-user copy, the same file as in
the published installer): pass, on the pass line as the plan wrote it, which counts the
CPU of the hook chain's own processes. Claude Code 2.1.296 starts a command hook through
Git for Windows: `bin\bash.exe -c "<command>"` starts `usr\bin\bash.exe`, which starts
the command, and the launcher gets a console of its own, so one event is four
processes. `aicc-helper list` behind that launcher, standing in for one hook event (all
a hook mode does but send one frame), ran 350 times (300 at 2 a second, 50 back to back)
with no failure: p95 wall time 36.4 ms, longest 41.8 ms, mean CPU 29.1 ms per event,
against a pass line of 150 ms, 750 ms and 50 ms set before measuring (nine earlier full
runs gave the same picture). The helper is about 3 ms of that CPU; Git Bash and its
console host are the rest. Outside the chain, per event and net of idle, Defender's own
process used 20.1 ms, the program starting the launcher 0.7 ms and the holder 0.1 ms,
which with the chain is already 50.0 ms; counted from the processors' idle cycles, the
whole machine spent 57.2 ms per event (55.2 to 55.9 ms in the three runs before), the
probe's own process (3.2 ms, the starter's 0.7 ms among it) included. So the chain
passes the CPU line, and an event costs this machine about 53 to 57 ms of CPU in all.
Defender had already scanned the helper before the measured runs (here, as for a held
session, the holder started from the same file first); a fresh copy in a new folder took
112 ms on its first start, and a first start of a new version's bytes, which every
update brings, was not measured. The stand-in is `list`, not the hook mode. Today's HTTP
hook, for reference, taken as the gateway takes it (a new connection for each POST, the
token checked, the body parsed; not what the gateway then does with the event), takes
about 1.0 ms of wall time and 1.5 ms of CPU per POST, client and server. One fast
desktop CPU was measured (`helper/probes/p16-windows-hook-cost.ps1`). Hooks through the
holder (S12) are unblocked on the machine measured; the hook command must be written for
Git Bash (forward slashes, quoted paths).

P18 result (2026-11-19, Windows test machine, Claude Code 2.1.328 and Codex 0.157.1, each
with no account signed in and no API key, in a fresh environment whose home, app data and
config folders were in the probe's own temporary folder): pass for both, on the line the
beta 10 plan wrote before measuring, in two measured runs (the second with the script as of
e7bcfcd6, after review fixes that change neither what it measures nor its verdict on these
runs). Each CLI's own add command (`claude mcp add --scope user`, `codex mcp add`) stored
the program's path as given, a path with a space included, and each CLI started the program
as its own direct child: no shell between them, the path and arguments as given, its input,
output and error output as pipes, and the CLI's working folder as its own. Each start also
made a console host for the program (a console of its own; whether it has a window was not
checked), as P16 found for a hook's launcher. In 8 of 8 runs per CLI (in each measured run,
three from a folder with no space in its path and one with), the stand-in answered its
first request 19 to 25 ms after node's clock started in it (its load before that is not
counted; 185 to 198 ms after Claude Code started, 157 to 296 ms after Codex did), against a
line of 5 s. Claude Code sends `server/discover` before `initialize` (the stand-in refused
it as unknown, and Claude Code went on); Codex sends `initialize` first, and in the two
check runs before the measured ones it began its turn within a second while `initialize`
was still unanswered. The two end the program differently. At a normal end Claude Code
closes the program's input and the program ends itself, 9 to 20 ms before the CLI exits; at
Codex's end the program is ended without end of input (none seen in 8 of 8 runs; exit
status 1, as a forced end gives, in the 7 whose end the process trace caught; which process
ended it was not recorded). With the CLI ended from outside (Stop-Process on the CLI alone,
while the stand-in held its first request), another process ended the program within 2 s
for both (exit status 0, no end of input seen, in each measured run). That fits a job
object that ends its processes when the CLI goes, which was not checked directly, since the
probe's own SSH session runs in a job. In 20 of 20 runs, nothing of the run (CLI, program
or console host) was still running 2 s after the CLI's end. Claude Code passes the program
its whole environment and adds its own variables; Codex passed only 17 of the variables it
was given (APPDATA, COMSPEC, LOCALAPPDATA, PATH, PATHEXT, PROGRAMDATA, PROGRAMFILES,
PROGRAMFILES(X86), PROGRAMW6432, SYSTEMDRIVE, SYSTEMROOT, TEMP, TMP, USERDOMAIN, USERNAME,
USERPROFILE, WINDIR), without HOME or CODEX_HOME, so the relay must take what it needs from
its command line, as `--store` and `--session` do. For S15: the relay can be a plain
program the CLI starts by its full path; it cannot count on end of input to send
`mcp.close` (only Claude Code's normal end gives one), so the holder takes a relay
connection that drops as a closed stream; and each relay has a console host of its own
while it runs. Limits: the stand-in is a node script, not the helper; Claude Code was
measured through its connection check (`claude mcp list`) and Codex through a `codex exec`
whose turn a local model stand-in refused, not through an interactive session; one machine.
The probe is `helper/probes/p18-windows-tool-server-start.ps1`. The check of a real tool
call through the relay, with signed-in CLIs, is owed at the step that wires it.

P19 result (2026-11-19, Claude Code 2.1.328 and Codex 0.157.1, each with no account and a
made-up key, pointed at a stand-in model on a loopback port that streams one reply of 300
lines, in a fresh environment, on a terminal of 120 by 40; the Windows test machine, build
22621, on node-pty's bundled ConPTY and on the system's; GitHub's windows-2025 (build
26100, both ConPTYs), macos-latest and ubuntu-latest runners in CI run 44533910780; 3 runs
per state): REPAINTS for both CLIs on all three systems, on the line the beta 11 plan
wrote before measuring. At every state each CLI reached (its first screen with no account,
its ready prompt, the middle of its reply, after the reply), and every state was reached
in 3 of 3 runs, a terminal fed only the last 64 KiB of the output (or its second half when
there was less), cut at a byte, showed the same rows as one fed everything after a nudge:
the PTY one row shorter, then back 300 ms later. In every run they were already equal at
the first sample, 250 ms after the size was back. Before any resize the rows differed (1
to 32 of the 40) at every state but these, where they were already equal and the nudge had
nothing to put right: Claude Code after its reply (on every system), Codex's first screen
on macOS and Linux, and Claude Code in the middle of its reply under the system ConPTY (in
3 of 3 runs on the test machine, 2 of 3 on the runner). Claude Code's whole output stayed
under 64 KiB at every state but after its reply on macOS and Linux, so its replays were the
second half of the output. A same-size resize, what the app
sends after an attach today, is not enough on the bundled ConPTY, macOS or Linux: at a
still screen the CLI wrote nothing after it, and it matched only where nothing was needed.
On the system ConPTY it is enough at every state, on both builds: the console host built
into Windows draws the whole screen again on any resize. Both CLIs draw their session on
the alternate screen (Claude Code from its prompt on, Codex from its first screen), and
the switch comes before the cut, so the re-attached terminal stayed on the normal screen
with the right rows, on every system but the test machine's system ConPTY, whose console
host passes no alternate screen through (the runner's build 26100 does). The default
shell, a row with no verdict, showed the same rows before any resize, but 30 to 49 of its
last 200 lines differed: lines the cut lost stay lost. What it means, as the plan fixed
before measuring: a mid-stream re-attach can rely on the CLI's own repaint after a nudge,
on every system measured; the holder's screen is for the readers; the nudge and the
"output is missing" notice are planned for beta 12 in `helper-pty.ts`, and no repaint
message is added to the protocol. The step that plans the nudge also decides how the
re-attached terminal gets back to the screen the CLI is on. Not measured: the holder's own
PTY code (it makes the same system calls; on Windows a session's launch field picks the
ConPTY), the app's real attach path, a signed-in account's screens, Codex with its
background server on Windows and macOS (the counted runs gave it `--no-daemon`: 0.157.1
refuses that server in an elevated session, which the test machine's SSH session and the
Windows runner are, and on macOS the server's socket path under the runner's temporary
folder is too long; the earlier dispatch on 0c49af32, run 44532520348, ran Codex with its
server on ubuntu-latest and read REPAINTS there too, 3 of 3 at every state), and any size
but 120 by 40. The probe is `helper/probes/p19-record.cjs`.

P19, second run (2026-11-19 to 20, plan 2.1.3-beta.12 A2; the question is P19's own, so it has
no number of its own). Claude Code 2.1.328, Codex 0.157.1 and Codex 0.170.0, with no account
and the same stand-in model, at 120 by 40; CI runs 44636688885 (Codex 0.157.1) and 44636706580
(Codex 0.170.0) on windows-2025 (both ConPTYs), macos-latest and ubuntu-latest, and one reading
per version on the Windows test machine, build 22621, on both ConPTYs; 3 runs per state. The
decision lines were fixed before measuring and are in the probe's header. The modes, as
xterm.js reports them for each pane, two seconds after the nudge (KEPT when the panes agree in
3 of 3 runs at every state reached, LOST when they differ in 2 of 3 or more at some state). On
Linux, macOS, the Windows runner (both ConPTYs) and the test machine's bundled ConPTY: Claude
Code LOSES the screen in use, bracketed paste and focus reporting, and KEEPS mouse reporting
(it sets it again when it redraws) and the rest; Codex, both versions, LOSES the screen in use,
bracketed paste, mouse reporting and focus reporting, and KEEPS the rest. The rest is
application cursor keys, application keypad, insert, origin, reverse wraparound and
synchronized output (off throughout) and wraparound (on). On the test machine's system
ConPTY, which passes no alternate screen through, the screen in use reads KEPT for both CLIs
and Codex's focus reporting reads KEPT (pane 1 never has either on there); bracketed paste is
LOST for both, focus reporting LOST for Claude Code, mouse reporting LOST for Codex and KEPT
for Claude Code. Not in xterm.js's
modes, so not measured: the mouse encoding and whether the cursor is shown. What it means, as
fixed before measuring: the screen in use and bracketed paste (both CLIs) and mouse reporting
(Codex) are LOST and the app's terminal acts on them, so they are restored from the holder's
screen in the step that first shows an agent session again from the middle (S16's second
half), and `screen.read` carries them from the holder screen's step on; focus reporting is
LOST and not in that step's list of modes, so that step decides it; nothing changes in the
re-attach fix. Codex 0.170.0's rows: REPAINTS on Linux, macOS and both Windows ConPTYs, on the
runner and on the test machine, 3 of 3 at its first screen, its ready prompt, the middle and
the end of the long reply and the end of a short one; a same-size resize was enough at every
state on the system ConPTY and at none elsewhere; Codex 0.157.1 and Claude Code read REPAINTS
again. Console hosts, counted 1, 2, 5, 10, 30 and 60 s after node-pty reported the program's
exit, before anything was stopped: on the system ConPTY, STAYS. The pseudo console's
conhost.exe, a child of the process that opened the PTY, was still running at 60 s in 21 of 22
runs in each runner dispatch and in 22 of 23 and 13 of 14 runs on the test machine, though
node-pty's kill ran right after each exit; the one run without one in each was the only run
whose program the kill ended. On the bundled ConPTY, ENDS BY ITSELF (no host of the probe's at
any time). The app gives the system ConPTY to Claude Code sessions and plain terminals, so a
session that ends there leaves its console host running; that is on beta 13's bug track
(aicc_planning#363; the kill is in `pty-manager.ts`). Codex started with its background server
(no `--no-daemon`) in the test machine's elevated SSH session: 0.157.1 FAILS on both ConPTYs,
printing "Error: start the Windows daemon from a non-elevated terminal; shared clients must
not inherit administrator privileges" and exiting with code 1 before its composer; 0.170.0
RUNS A TURN on both and leaves no server process. What a Codex tab does when the app itself
runs elevated is aicc_planning#364, sized for beta 13. The hint rows (the row under Codex's
footer; a left arrow, a warning sign and a middle dot are written here as `<left arrow>`,
`<warning sign>` and `.`): for 0.170.0 all four RECORDED: its ready row is `<left arrow> for
agents . ? for shortcuts` (the agents form is drawn by default), the queue hint `tab to queue
message` while a draft waits during a turn, `<left arrow> for agents . f6 for shortcuts` with
the shortcuts key rebound, and `<warning sign> 1 warning . f2 to view` at the right of the row
with a tool server that cannot start. For 0.157.1 the queue hint, the rebound row (`f6 for
shortcuts`) and the warning were RECORDED and the agents form NOT REACHED (60 s waited on every
system; 0.157.1 draws no agents form). From the first prompt sent on, both versions also draw
`<warning sign> 1 warning . f2 to view` at the right of the hint row, in every launch that
sends one (what it warns of was not read), and Codex 0.170.0 adds the thread's title to its
footer, which wraps to a second row when its working folder and title do not fit in the 120
columns (in these runs on macOS and Windows, whose temporary folders are longer than Linux's;
not on Linux). The screen corpus gains 33 recordings from these runs (each under 256 KiB,
2,972,596 bytes of recordings in all, under 3 MiB; none cut): Codex 0.170.0's ready, mid-reply and
after-reply on all four systems; each hint row reached, of both versions, on the bundled
ConPTY and macOS; Codex 0.157.1's mid-reply and after-reply on three systems and its mid-reply
on Linux. The mid-reply and hint row recordings are record only (to 300 ms after the mark).
As these runs left the corpus, Codex's screen reader read all 33 unrecognised: it took one row
under the footer, exactly `? for shortcuts`, and each of them ends in another row. No mid-reply
or queue-hint screen holds an `esc to interrupt` row, the reader's only sign of busy: Codex drew
its working row once, right after Enter, and not while the reply streamed. The reader fix in the
same beta (aicc_planning#357, plan 2.1.3-beta.12 C3) reads 12 of the 33; the other 21, a footer
wrapped onto two rows (8) or a warning count at the right of the hint row (13), still read
unrecognised and are listed in the corpus test as known misreads. Not measured: a signed-in account's
screens (whether a real model gives the warning, or a hint row A2 could not reach without an
account), the holder's own PTY code, the app's real attach path, any size but 120 by 40.

P20 result (2026-11-21, plan 2.1.3-beta.13 C1, the Windows test machine, build 22621, on
node-pty's bundled ConPTY; Claude Code 2.1.328, Codex 0.157.1 and Codex 0.171.0, the newest
tested release; each with no account and a made-up key, in a fresh environment, pointed at a
stand-in model on a loopback port that answers a turn with a tool call reading a file in the
run's folder; 3 runs per case, the runs of a case side by side). The decision lines were fixed
before measuring and are in the probe's header. (a) Both CLIs RUN THE TOOL whatever the hook
endpoint does. Claude Code's http PreToolUse, in the entry the app writes: a refused
connection, a 401 and a 404 (what the gateway answers a session it does not know) each cost
0.1 to 0.2 s, as the control's 200 `{}` does, and the session's terminal shows
"PreToolUse:Read hook failed" with "HTTP 404 from <the hook URL>" ("HTTP 401", and "HTTP
undefined" for the refused connection) at the tool call. An endpoint that never answers holds
the tool call 600 s (599,994 to 599,997 ms in 3 of 3 runs: Claude Code's own limit, since the
app gives the hook no timeout), then the tool runs, and no line names the hook. Codex, both
versions, through the app's forwarder: the tool runs 0.3 to 0.4 s after the call in every
case, as in the control, and nothing on screen says a hook failed; the forwarder delivered
SessionStart, UserPromptSubmit, PreToolUse, PostToolUse and Stop with the session's token.
Against an endpoint that never answers, every request was closed 15 to 473 ms after it came,
before the forwarder's own 2 s limit. That is the probe ending the run, not Codex: in every
run the five requests closed within 12 ms of each other and 546 to 565 ms before the CLI's
exit, whatever the time since the turn's Stop event (15 to 148 ms), and the probe ends a run
with two Ctrl+C 500 ms apart (the time of the first was not recorded). How long a request that
is never answered is held while the session goes on was not measured; the forwarder's own
limit is 2 s and the hook's timeout 10 s. What it means, as fixed before measuring: after an
update, a held Claude Code
session's PreToolUse on the gateway loses only the event, so step 2 of S16's second half (the
hook mode) is a default, not a gate on step 4; its cost until then is the "hook failed" lines,
one per tool call; a gateway that hangs stalls each tool call 10 minutes (recorded, no gate);
Codex is as S16's list expected (its hooks are asynchronous, item 4 there). (b) Claude Code READS ONCE, both files. With the
PreToolUse URL changed in its `--settings` file (a temporary file renamed over it, as the app
writes it), the next turn's hook reached the old URL in 3 of 3 runs, about 3.8 s after the
change, and nothing was shown. With its tool server ended and its `--mcp-config` naming
another, `/mcp` and Reconnect started the old one again in 3 of 3 runs ("Reconnected to
conductor."), and nothing started a server before `/mcp` in the 5 s waited. So a take-over
cannot give a running Claude Code a new gateway port or secret through its settings file:
PreToolUse reaches a new run through the hook mode (step 2), or only while the new gateway has
the old port and takes the session's old secret again (the second way in item 3 of S16's
list); and the relay command a
session starts with must stay valid for the CLI's life, as S15 built it (it names the store and
the session, not the app run). (c) Claude Code LISTS AGAIN: `tools/list` came 1 to 4 ms after
the notification, and the next turn named the added tool, in 3 of 3 runs. Codex, both
versions, DOES NOT LIST AGAIN: no `tools/list` after the notification, and the next turn named
only the first tool, in 3 of 3 runs each. So step 6 sends `notifications/tools/list_changed`
to Claude Code only; a held Codex session keeps the tool list it started with until it starts
again. The app answers no permission today (the parity table), so S16 needs no protocol
change 3. Not measured: a signed-in account and a real model, the app's own gateway and launch
path (the probe writes the same entries), a settings file written in place, Claude Code's other
hook events, macOS and Linux, Codex below 0.157.1 (the tested range starts at 0.153.4). The
probe is `helper/probes/p20-probe.cjs`.

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
