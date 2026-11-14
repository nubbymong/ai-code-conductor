# ADR-029: Remote sessions run through a small helper on a device you add once

- Status: Accepted (owner approved on the Agent Canvas, scope of 2.1.3-beta.2).
  The six R1 probes below have not run; each can still stop or reshape its step.
- Date: 2026-11-14
- Related: ADR-009 (adversarial review), ADR-028 (beta cadence),
  `docs/remote/helper-protocol.md` (protocol version 1),
  `docs/remote/helper-threat-model.md`
- Amends, step by step: the SSH statusline live-matrix gate in `AGENTS.md`
  (shrinks at R12, not before)

## Context

A remote session today is one interactive ssh terminal that carries the screen
and all control traffic: the app types a setup line into the remote shell and
reads its answers back out of the terminal output. Every remote feature depends
on what a shell, a prompt, tmux and ConPTY do to those bytes.

That shape has a cost:

- The remote area is about 9,000 lines of app code and about 98 test files;
  about half of `src/main/pty-manager.ts` (7,882 lines) is the SSH branch.
- The SSH statusline has been fixed at least four times and is missing again;
  each fix passed the unit suite, and the failures only show on real hosts.
- The owner decided (2026-11-13) that SSH failures drive a rethink of the
  remote path, not more fixes on it, and that a helper binary, devices added
  first and Rust are all allowed.

## Decision

1. **A host is a device you add once.** A device record holds the target, the
   kind of authentication, the pinned host keys (their only store), the host's
   home folder, what the probe found (OS, architecture, login shell, CLI paths
   and versions, container engine) and the helper version installed. Records
   live under the app's resources folder, trusted only as far as the OS user:
   each carries a MAC from a purpose-bound subkey of the install secret, and a
   stored consent is re-checked against the pinned key and helper hash before
   use (threat model 3.12). Passwords stay in the OS keychain, keyed by device.
   Each target has a random device id naming its folder on the host
   (`~/.aicc/<did>/`), so two app installs, or two devices sharing a home,
   never touch each other's files. A session picks a device, a target on it
   (the host or a named container) and a folder.
2. **A small helper, written in Rust, is bundled with the app** and uploaded
   once per target, after the user agrees on a screen that lists what is placed
   where, that sessions keep running after a disconnect, and how to remove it
   all by hand: when the device is added on the Devices page (R4), or, for a
   device made from a saved SSH config, in a one-time dialog at its first
   connect from R6. Fixed scripts check folder owners and modes before they
   write or run anything. The launcher checks the hash before every helper
   command the app starts (corruption and wrong files, not a hostile root or
   same-user host); commands the CLI or sudo start are not checked. A self-test
   runs after every upload. The host never downloads anything.
3. **One long-lived helper process per session, and no daemon.** From R9 one
   holder per session is the only helper process that outlives a connection.
   Relays live while their ssh connection is open, the MCP process as long as
   the CLI, and the rest for one call. Nothing runs on the host between
   sessions: no service, no autostart, no listening network port, no root
   install, nothing on `PATH`. The helper opens no TCP or UDP socket, only its
   session's Unix-domain socket. The control against a hostile dependency is
   source review of every `Cargo.lock` change; seccomp on Linux and the build
   checks are defence in depth against a helper that opens a socket itself
   (none at run time on macOS in version 1; threat model 3.10).
4. **No Claude token is copied to the host.** From R8 the app writes no app
   secret there. The helper opens no CLI file except one named edit (the
   folder-trust key, from R7) and never sends, logs or keeps a CLI credential.
5. **A second ssh connection per session carries structured messages** (the
   side channel): statusline, hook events, file uploads, Conductor tool calls,
   sudo prompts and session state, as framed messages with strict schemas and
   size limits. Version 1 is specified in `docs/remote/helper-protocol.md`.
6. **The terminal stays a plain ssh terminal.** It carries only what the user
   sees. From R10 its remote command is the helper, run by exec, not a line
   typed into a shell. The app parses nothing out of it.
7. **Image paste becomes a file upload.** The app uploads the image, checks its
   hash on the host and pastes the remote path, only after the path matches the
   home recorded once for the device and the expected folder.
8. **tmux, the reverse tunnel, the typed setup line and terminal-marker parsing
   are removed step by step**, each in the same beta that replaces it or the
   next (see the step plan). No tmux tier is kept.
9. **The floor.** A host that cannot take the helper opens as a clearly
   labelled plain SSH terminal with no extras.
10. **Host platforms.** Linux (x64, arm64, 32-bit ARM; static musl builds) and
    macOS hosts in this plan. Windows hosts wait for R13.
11. **The app fixes its own ssh options and environment.** Every ssh it starts
    turns off agent, X11 and port forwarding, credential delegation, config
    `SetEnv`, escape sequences, local commands and shared connections, puts
    `--` before a checked target, and trusts only the device record's pins
    (jump hops included) through a per-connection known-hosts file. It and its
    askpass and `ProxyCommand` children get a short allow-listed environment
    plus the device's named extra variables, never the app's own. Saved
    passwords go only through askpass, under release rules bound to the
    connection (protocol 2 and 3).
12. **Remote sessions get a default-deny tool list, from R2.** A remote session
    reaches only the Conductor tools on the remote allow-list, with argument
    rules per tool. Its browser tools open `http` and `https` only, through an
    app-run filtering proxy in a throwaway context (threat model 3.5).

## Consequences

**What goes, and when.**

- R2: the "ask Claude to fetch the screenshot" route for SSH image paste, the
  rule that focus must be outside the terminal, the dead end for plain SSH
  terminals; for SSH sessions, tools outside the remote allow-list (browser
  tools until R8) and container image paste (until R11), both in the changelog
  and as known issues.
- R3: the typed setup line, its success markers, the setup deadline and Skip
  logic, the hidden Windows prototype path.
- R6: both statusline shims, the host's status URL file, the SSH tunnel POST,
  terminal status fallbacks, the status marker parser, the remote usage fetch.
- R4: the SSH and container form inside `SessionDialog.tsx`; per-session host
  details as the source of truth.
- R7: the setup generator and the remote programs held as strings in
  `ssh-shim.ts`, the attention hook parser, `ssh-attention.ts`,
  `ssh-line-buffer.ts`, the need for node on the host.
- R8: the reverse port forward, `ssh-remote-port.ts` and the tunnel's host files.
- R9: `ssh-tmux.ts`, `ssh-tmux-stage.ts`, `ssh-tmux-push.ts`,
  `tmux-archive-cache.ts`, the tmux code in `pty-manager.ts`, the wheel-scroll
  and liveness code.
- R10: the SSH bring-up block (prompt patterns, typed passwords, the launch
  line builder), flow states in `SshFlowOverlay.tsx`, `ssh-partner-folder.ts`.
- R11: the container entry guard, typed post-commands and sudo typing, the rest
  of the SSH branch in `pty-manager.ts` (about 3,860 lines in total), the
  Claude-shaped SSH provider interface, the last marker parsers.
- R12: most remote test files, per-host live packs, the old per-session SSH fields.

**Old beside new.** Old per-session SSH fields are still read until R12, so a
rollback to an earlier beta keeps working. Each saved secret is stored once,
under a key both generations read; Remove device deletes it and any copy under
an older key. Each guarantee holds from the step threat model 2.1 names.

**Risks.**

- A new toolchain (Rust) and its dependencies enter the release pipeline.
  Signing and cross-building times on the existing runners are not yet known.
- A new binary (signed on macOS, and on Windows at R13) is uploaded to other
  machines. Antivirus on a host may flag it, most of all on Windows hosts.
- Two connections per session (side channel and terminal), three for a
  container that needs sudo. Connection sharing is off on every app OS, so a
  one-time-code host asks for a code once per connection: at every session
  start, at provisioning, and at R2 for each image upload until R7. Such a
  device never reconnects by itself.
- Saved passwords need OpenSSH 8.4 or later on the app machine; an older client
  connects only with keys that need no passphrase, and says so.
- Agent forwarding is off on the app's connections. A user who relied on it in
  a remote terminal loses it from R10 unless R4 adds a per-device choice.
- The minimal environment drops variables a user's own `ProxyCommand` may need
  (cloud CLI profiles, proxy settings) from R2. The per-device extra variables
  list is the way back; the release notes say so.
- A reattach into a terminal of another size can garble the first screen; the
  holder replays at the recorded size, then the resize makes the CLI redraw.
- A host reboot ends a session. The next connection sees it as `stale` (same
  machine, new boot, which beats `unmanaged`) and offers the CLI's own resume,
  run on the host by conversation id. A folder on the old path (same boot, not
  ended) stays `unmanaged` and is left alone. Hosts with no helper build drop
  to the plain terminal.

**What still needs real hosts.** The live matrix, the R1 probes and about 24
hours of real-host time across R1 to R12; local tests and CI do not replace it.

**Review gates.**

- Every R step that ships code takes the ADR-009 adversarial pass: it touches
  IPC and preload, ssh arguments, credentials, the Conductor MCP server, or the
  new shipped binary. The helper's source, its build and its hash manifest join
  the ADR-009 path table when they land (R5), and so does any change to the
  helper's `Cargo.lock` or `deny.toml`, of any size.
- Design-stage adversarial pass: four fix rounds and a minors pass; the final
  result is recorded in the PR.
- The SSH statusline live-matrix gate in `AGENTS.md` stays in force, unchanged,
  for every step that touches its blast radius. From R6 the new remote files
  join that radius. The gate shrinks only at R12, to about 8 rows per helper
  release, and only once the new path has passed the full existing matrix once
  (by the end of R11).

## Alternatives considered

The remote design study scored three shapes out of 40.

- **A per-user daemon that also carries the terminal (31 of 40).** Not chosen:
  it bets everything at once, on one shared process per user that every upgrade
  must replace under live sessions. Here each session keeps the helper version
  that started it, and the app keeps the previous protocol until no such
  session can be left (protocol 7), so an upgrade strands nothing. The daemon's
  frame format is kept, so the terminal can move onto the side channel later
  if Windows hosts need it.
- **Nothing installed on the host (26 of 40).** Not chosen: it keeps tmux, the
  reverse tunnel and the remote usage fetch, the parts the owner asked to
  rethink. Its ordering (image paste first) and conversation-id resume are kept.
- **Keep patching today's path.** Not chosen: the owner decided against it.
- **An in-process SSH library.** Not chosen: it loses the user's ssh config,
  agent and jump hosts; it stays the fallback if probe P2 fails. (**Go** instead
  of Rust was not chosen either: the owner chose Rust.)

## Step plan

The order is the build order. Each line is one step; most are two betas.

- **R1** Design gate and statusline diagnosis: this ADR, the protocol spec, the
  threat model and the six probes. Docs only (probe P1 says where a cause
  outside the remote path goes).
- **R2** Image paste and Snap over SSH by file upload, before any helper: a
  one-shot ssh exec with exit code and error text, the fixed ssh options and
  minimal environment, the host key pinned at the first upload, the home
  recorded once, the device-id folder and its marker, saved passwords through
  askpass, per-device extra variables, pins only in the device record, a CI
  sshd job (every app OS) with a hostile config, environment canaries and
  known-hosts paths with a space, a non-ASCII character, doubled backslashes or
  a UNC form, also nested in a jump host's `ProxyCommand`. Every terminal ssh
  the app starts gets `-e none` and the minimal environment. **The remote
  allow-list ships here** for SSH sessions on the route they use before R8: a
  fixture file names each tool, its class and its argument rule; the Conductor
  server marks each SSH session remote, lists and runs only fixture tools,
  applies the argument rules, and registers no local render roots for it. A
  test: every registered tool is in the fixture or refused.
- **R3** Probe the host and run setup over exec with a real result per file
  (protocol 13), backing up any user file it replaces. Device records are made
  from saved SSH configs, with the key pinned at the probe. The typed setup
  line goes. Until R4 removal is the consent screen's by-hand steps.
- **R5** The helper lands dark: a Rust project with a pinned toolchain, CI
  builds for every host target in a job with no secrets or network, signing in
  a separate job, a hash manifest, audited and vendored crates.io-only
  dependencies within the crate budget (threat model 3.10), shared message
  fixtures with a refusal per error code and pattern, seccomp and the network
  checks with their canaries. Not bundled; no behaviour change.
- **R5.1** Message recorder and replay: the live harness saves side-channel
  messages from real-host runs, redacted by message type and field, written
  outside the repository and viewed by a human before commit; CI replays them.
- **R6** The helper ships; the statusline moves to the side channel. It is
  bundled, uploaded with consent, hash-checked and self-tested. Folders the old
  path still runs are `unmanaged` and survive a reconnect with folder, spool
  and `seq` kept; a host reboot makes one `stale` (both tested). Removal tests:
  two nodes on one home, Remove on B refuses and names A; Remove also refuses
  for a live same-machine `unmanaged` session, an unreadable `ps` or a missing
  pid record; an `end` that does nothing is reported as not ended.
- **R4** The Devices page (add, check, re-provision, report, remove, host key
  shown and pinned, leftover `~/.aicc` folders of other installs), then the
  session dialog picks a device. Mockup approved on the Agent Canvas first; it
  decides whether the terminal may forward the agent per device (default off).
- **R7** Setup, hooks and file transfer through the helper. SSH sessions get
  attention events on every host OS.
- **R8** Conductor tools over the side channel, under the same remote
  allow-list as R2. A remote session registers no local render roots: what it
  shows is inline content, and its identity comes from the side channel alone.
  The browser rows open, `http` and `https` only, through the filtering proxy
  and a throwaway context per session. Tests cover the render-root and
  identity rule and each browser row (threat model 3.5). The reverse port
  forward goes.
- **R9** The helper replaces tmux on Linux and macOS hosts: the CLI survives a
  dropped link or an app restart, and missed output is replayed. Tests: the CLI
  keeps its network and sudo while `serve` has neither (protocol 5); two
  concurrent starts leave one CLI; a live R8-era session survives the update,
  a reconnect and a rollback, folder, spool and `seq` kept, no resume offered;
  a held session whose CLI exits on the same boot becomes `stale`, not
  `unmanaged`, and is cleaned or offered resume.
- **R10** Host sessions launch by exec, with the helper as the terminal's
  command. Passwords go only through askpass. The riskiest step.
- **R11** Containers and sudo on the helper, with shared-home detection read
  from the host side (the engine's inspect) at every launch; the SSH branch
  leaves `pty-manager.ts`. A test: a container with no machine id keeps its
  node id over an engine restart.
- **R12** Gate reset and cleanup: the live gate becomes about 8 rows per helper
  release, `AGENTS.md` is rewritten to match, help texts are swept, the
  user-facing surface sweep is recorded.
- **R14, R13** (feature queue, each starts when the owner says) Codex over SSH
  with the host's own Codex login; Windows hosts, with a signed Windows helper
  build and a named-pipe side channel.

## R1 probes

Each probe is a short manual check on a real host, run before the step it
guards is built; its result is recorded here. Status for all six: **not run
(owner, Q2: which host shows the fault, and permission to probe hosts).**

**P1 The cause of the missing statusline.**
- Proves: where the status stops on its way from the remote CLI to the app.
- How: on the host where the statusline is missing (owner to name), read the
  shim's own trace log (`~/.claude/conductor-shim.log`) for the session's
  lines; on the same app build, check a local session's statusline.
- Go: a cause is named. If it is in the remote path, R3 and R6 replace that
  mechanism and the result is recorded against them.
- No-go: the local session is missing its statusline too. The cause is outside
  the remote path and gets its own small beta before R2.
- No cause found, local session fine: unproven; R3 and R6 still replace it.

**P2 Saved passwords through askpass with Windows `ssh.exe`.**
- Proves: the ssh program the app runs (named, with its version) calls the
  app's askpass program for a password and a one-time code, with no console
  prompt, from an install and a known-hosts path with a space and a non-ASCII
  user name (also a UNC data folder), and through the app's own `ProxyCommand`.
  Also recorded: what a macOS sshd sends (keyboard-interactive goes to the user).
- Go: both are answered from a non-interactive start and the connection opens;
  a keyboard-interactive prompt with other text, a confirm prompt and a
  jump-host prompt each reach the user and release nothing.
- No-go: password devices need another answer (an in-process SSH library for
  those devices only), decided before R2's askpass part is built.
- Host role: a password-auth host, a macOS host and a jump host, from the
  Windows app machine.

**P3 A helper process outliving logout.**
- Proves: a process started by an exec over ssh keeps running after that
  connection closes and the user has no other login; three connections per
  session for several sessions stay within the server's connection limits.
- Go: alive five minutes later, without root or a setting the user must change.
- No-go: on that host role sessions stay non-detachable and are labelled so;
  R9's persistence claim is reduced for it.
- Host role: a Linux host with tmux (systemd with user-process cleanup on), a
  macOS host, a container host (a process after the engine client exits).

**P4 Claude Code accepting a pasted remote image path.**
- Proves: pasting the absolute path of an image file on the host into a remote
  Claude Code session makes it an image attachment. Also records the file and
  key where the CLI keeps folder trust, or a supported flag that replaces the
  named edit.
- Go: the image is attached on a Linux host with tmux (guards R2) and inside a
  container (guards R11).
- No-go: R2 is rescoped before it is built.

**P5 sudo answered without a terminal.**
- Proves: a container engine command that needs sudo can be answered through an
  askpass program from a non-terminal exec, once, with nothing echoed, and
  framing through `sudo -A <engine> exec -i` stays binary clean; the container
  has `/bin/sh` and a writable home for its user. Also tried: a wrong answer
  and sudo's retry, `requiretty`, `!visiblepw`, a container that shares the
  host's home, distrobox and toolbox defaults, and a container that lies in its
  own report (the host-side inspect must still say shared). Each reads shared:
  an engine-socket bind (`docker.sock`, `containerd.sock`), `SYS_ADMIN`,
  `DAC_READ_SEARCH`, `CapAdd ALL`, a device, host networking, a recreated
  container with a changed mount list, a home reached through a symlink, a
  bind-mount alias of the home or an ancestor.
- Go: the command runs with the answer given once; nothing is written to disk.
- No-go: sudo on a container host whose engine needs it stays on the old path
  until another design; R11 is rescoped.

**P6 A launch by exec gets the same PATH as an interactive login.**
- Proves: a command run by exec over ssh finds the same CLI paths and the same
  environment as the user's interactive login shell, and the fixed scripts run
  unchanged under each login shell.
- Go: the same `PATH` and CLI paths for bash and zsh, including a `.bashrc`
  that returns early for non-interactive shells; csh, tcsh and fish pass the
  scripts through; a home mounted `noexec` is detected.
- No-go: the probe records absolute CLI paths through one login run by exec
  (`$SHELL -ilc`) when the device is added, and R10 is sized again. Either way
  the comparison is repeated per device at provisioning, else recorded paths
  or the floor.
- Host role: a Linux host with tmux, a macOS host, a password-auth host.
