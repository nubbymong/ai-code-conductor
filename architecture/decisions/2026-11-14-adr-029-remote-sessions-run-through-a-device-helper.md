# ADR-029: Remote sessions run through a small helper on a device you add once

- Status: Accepted (owner approved the remote shape on the Agent Canvas, scope
  of 2.1.3-beta.2, 2026-11-14). The six R1 probes below have not run yet; each
  one can still stop or reshape the step it guards.
- Date: 2026-11-14
- Related: ADR-009 (adversarial review), ADR-028 (beta cadence),
  `docs/remote/helper-protocol.md` (protocol version 1),
  `docs/remote/helper-threat-model.md`
- Amends, step by step: the SSH statusline live-matrix gate in `AGENTS.md`
  (shrinks at R12, not before)

## Context

A remote session today is one interactive ssh terminal that carries the
screen and all control traffic: the app types a setup line into the remote
shell and reads its answers back out of the terminal output. Every remote
feature depends on what a shell, a prompt, tmux and ConPTY do to those bytes.

That shape has a cost:

- The remote area is about 9,000 lines of app code and about 98 test files.
  About half of `src/main/pty-manager.ts` (7,882 lines) is the SSH branch.
- The SSH statusline has been fixed at least four times and is missing again.
  Each fix passed the unit suite; the failures only show on real hosts.
- Every change in that area pays the full CI run, the live SSH matrix on real
  hosts and an adversarial pass, and still ships regressions.
- The owner decided (2026-11-13) that SSH failures drive a rethink of the
  remote path, not more fixes on it, and that a helper binary, devices added
  first and Rust are all allowed.

## Decision

1. **A host is a device you add once.** A device record holds the target, the
   kind of authentication, the pinned host key, what the probe found (OS,
   architecture, login shell, CLI paths and versions, container engine) and the
   helper version installed. Passwords stay in the OS keychain, keyed by
   device. A session picks a device, a target on it (the host or a named
   container) and a folder.
2. **A small helper, written in Rust, is bundled with the app** and uploaded
   once per device, with the user's consent, when the device is added. It is
   installed under the user's home in a folder named by version and content
   hash. It is hash-checked before every session and self-tested after every
   upload. The host never downloads anything.
3. **One helper process per session, and no daemon.** Nothing runs on the host
   between sessions. No service, no autostart, no listening network port, no
   root install, nothing on `PATH`. The helper has no network code at all.
4. **No Claude token is copied to the host.** The app writes no app secret
   there. The helper never reads the host's own CLI credentials.
5. **A second ssh connection per session carries structured messages** (the
   side channel): statusline, hook events, file uploads, Conductor tool calls,
   sudo prompts and session state, as framed messages with strict schemas and
   size limits. Version 1 is specified in `docs/remote/helper-protocol.md`.
6. **The terminal stays a plain ssh terminal.** It carries only what the user
   sees. From R10 its remote command is the helper, run by exec, not a line
   typed into a shell. The app parses nothing out of it.
7. **Image paste becomes a file upload.** The app uploads the image, checks its
   hash on the host and pastes the remote path.
8. **tmux, the reverse tunnel, the typed setup line and terminal-marker
   parsing are removed step by step**, each in the same beta that replaces it
   or the next (see the step plan). No tmux tier is kept.
9. **The floor.** A host that cannot take the helper opens as a clearly
   labelled plain SSH terminal with no extras.
10. **Host platforms.** Linux (x64, arm64, 32-bit ARM) and macOS hosts in this
    plan. Windows hosts wait for R13.

## Consequences

**What goes, and when.**

- R2: the "ask Claude to fetch the screenshot" route for SSH image paste, the
  rule that focus must be outside the terminal, the dead end for plain SSH
  terminals.
- R3: the typed setup line, its success markers, the setup deadline and Skip
  logic, the hidden Windows prototype path.
- R6: both statusline shims, the status URL file on the host, the tunnel POST
  for SSH, the terminal fallbacks for status, the status marker parser, the
  remote usage fetch.
- R4: the SSH and container form inside `SessionDialog.tsx`; per-session host
  details as the source of truth.
- R7: the setup generator and the remote programs held as strings in
  `ssh-shim.ts`, the attention hook parser, `ssh-attention.ts`,
  `ssh-line-buffer.ts`, the need for node on the host.
- R8: the reverse port forward, `ssh-remote-port.ts` and the files the tunnel
  needed on the host.
- R9: `ssh-tmux.ts`, `ssh-tmux-stage.ts`, `ssh-tmux-push.ts`,
  `tmux-archive-cache.ts`, the tmux code in `pty-manager.ts`, the wheel-scroll
  and liveness code.
- R10: the SSH bring-up block (prompt patterns, typed passwords, the launch
  line builder), the flow states in `SshFlowOverlay.tsx`,
  `ssh-partner-folder.ts`.
- R11: the container entry guard, typed post-commands and sudo typing, the
  rest of the SSH branch in `pty-manager.ts` (about 3,860 lines in total), the
  Claude-shaped SSH provider interface, the last marker parsers.
- R12: most of the remote test files, the per-host live packs, the read of
  old per-session SSH fields.

**Old beside new.** Old per-session SSH fields are still read until R12, so a
rollback to an earlier beta keeps working. The old SSH branch shrinks at each
step instead of going in one change.

**Risks.**

- A new toolchain (Rust) and its dependencies enter the release pipeline.
  Signing and cross-building times on the existing runners are not yet known.
- A new signed binary is uploaded to other machines. Antivirus on a host may
  flag it. (This matters most for Windows hosts at R13.)
- Two connections per session. On a Windows app machine, where ssh connection
  sharing is not available, a one-time code is asked for twice.
- Replaying output into a terminal of a different size can garble the first
  screen after a reattach. The holder replays at the recorded size, then the
  resize makes the CLI redraw.
- A host reboot ends a session; recovery is the CLI's own resume by
  conversation id. Hosts with no helper build drop to the plain terminal.
- Six behaviours are unproven until the R1 probes run.

**What still needs real hosts.** The live matrix, the R1 probes, and about 24
hours of real-host time across R1 to R12. Unit tests run the real helper as a
local child process (vitest and Rust tests, on all three CI systems) and a CI
sshd job covers exec lines and askpass. Neither replaces a real host.

**Review gates.**

- Every R step that ships code takes the ADR-009 adversarial pass: it touches
  IPC and preload, ssh arguments, credentials, the Conductor MCP server, or the
  new shipped binary. The helper's source, its build and its hash manifest
  join the ADR-009 path table when they land (R5).
- R1 records a design-stage adversarial pass on the protocol spec and the
  threat model before R5 starts. Status: not yet run.
- The SSH statusline live-matrix gate in `AGENTS.md` stays in force, unchanged,
  for every step that touches its blast radius. From R6 the new remote files
  join that radius. The gate shrinks only at R12, to about 8 rows per helper
  release, and only once the new path has passed the full existing matrix
  once (by the end of R11).

## Alternatives considered

The remote design study scored three shapes out of 40.

- **A per-user daemon that also carries the terminal (31 of 40).** Not chosen:
  it bets everything at once, with a shared daemon that must survive upgrades
  without stranding sessions and the terminal moved off the proven ssh path.
  Its frame format (a kind and a channel id from the start) is kept, so the
  terminal can move onto the side channel later if Windows hosts need it.
- **Nothing installed on the host (26 of 40).** Not chosen: the cheapest, but
  it keeps tmux, the reverse tunnel and the remote usage fetch, which are the
  parts the owner asked to rethink, and it weakens persistence on hosts
  without tmux. Its ordering (image paste first, by plain upload) and resume
  by conversation id are kept.
- **Keep patching today's path.** Not chosen: the owner decided against it,
  and each fix pays the same cost and leaves the same shared stream in place.
  Most of that code is deleted by this plan rather than tidied.
- **An in-process SSH library.** Not chosen: it loses the user's ssh config,
  agent and jump hosts. It stays the fallback if probe P2 fails. (**Go**
  instead of Rust was not chosen either: the owner chose Rust.)

## Step plan

The order is the build order. Each line is one step; most are two betas.

- **R1** Design gate and statusline diagnosis: this ADR, the protocol spec, the
  threat model and the six probes. Docs only. A statusline cause outside the
  remote path gets its own small beta before R2.
- **R2** Image paste and Snap over SSH by file upload, before any helper: a
  one-shot ssh exec with exit code and error text, saved passwords through
  askpass, a CI sshd job.
- **R3** Probe the host and run setup over exec with a real result per file.
  Device records are made from saved SSH configs. The typed setup line goes.
- **R5** The helper lands dark: a Rust project with a pinned toolchain, CI
  builds for every host target, signing, a hash manifest, shared message
  fixtures. Not bundled; no behaviour change.
- **R5.1** Message recorder and replay: the live harness saves side-channel
  messages from real-host runs, with secrets and host names replaced; CI
  replays them.
- **R6** The helper ships; the statusline moves to the side channel. The
  helper is bundled, uploaded with consent, hash-checked and self-tested.
- **R4** The Devices page (add, check, re-provision, report, remove, host key
  shown and pinned), then the session dialog picks a device. Mockup approved
  on the Agent Canvas first.
- **R7** Setup, hooks and file transfer through the helper. SSH sessions get
  attention events on every host OS.
- **R8** Conductor tools over the side channel. The reverse port forward goes.
- **R9** The helper replaces tmux on Linux and macOS hosts: the CLI survives a
  dropped link or an app restart, and missed output is replayed.
- **R10** Host sessions launch by exec, with the helper as the terminal's
  command. Passwords go only through askpass. The riskiest step.
- **R11** Containers and sudo on the helper; the SSH branch leaves
  `pty-manager.ts`.
- **R12** Gate reset and cleanup: the live gate becomes about 8 rows per helper
  release, `AGENTS.md` is rewritten to match, help texts are swept, the
  user-facing surface sweep is recorded.
- **R13** (queued, after the freeze) Windows hosts: a Windows helper build with
  signing and a named-pipe side channel.
- **R14** (queued, after the freeze) Codex over SSH, using the host's own Codex
  login.

## R1 probes

Each probe runs on a real host before the step it guards is built. None needs
code from this plan; each is a short manual check whose result is recorded
here. Status for all six: **not run (waiting for the owner, Q2: which host
shows the missing statusline, and permission to probe hosts).**

**P1 The cause of the missing statusline.**
- Proves: where the status stops on its way from the remote CLI to the app.
- How: on the host where the statusline is missing, read the statusline shim's
  own trace log (`~/.claude/conductor-shim.log`) for the session's lines. On
  the same app build, start a local session and check its statusline.
- Go: a cause is named. If it is in the remote path, R3 and R6 replace that
  mechanism and the result is recorded against them.
- No-go: the local session is missing its statusline too. The cause is outside
  the remote path and gets its own small beta before R2.
- Host role: the host that shows the fault (owner to name), plus the local
  machine.

**P2 Saved passwords through askpass with Windows `ssh.exe`.**
- Proves: Windows OpenSSH calls an app-supplied askpass program for a password
  and for a one-time code, with no console prompt.
- Go: both prompts are answered by the askpass program, from a non-interactive
  start, and the connection opens.
- No-go: password devices need another answer (an in-process SSH library for
  those devices only), decided before R2's askpass part is built.
- Host role: a password-auth host, reached from the Windows app machine.

**P3 A helper process outliving logout.**
- Proves: a process started by an exec over ssh keeps running after that
  connection closes and the user has no other login.
- Go: the process is alive five minutes later, without root and without any
  setting the user would have to change.
- No-go: on that host role sessions stay non-detachable and are labelled so;
  R9's persistence claim is reduced for it.
- Host role: a Linux host with tmux (systemd with user-process cleanup on), a
  macOS host.

**P4 Claude Code accepting a pasted remote image path.**
- Proves: pasting the absolute path of an image file on the host into a remote
  Claude Code session makes it an image attachment.
- Go: the image is attached, both on the host and inside a container.
- No-go: R2 is rescoped before it is built.
- Host role: a Linux host with tmux, a container host.

**P5 sudo answered without a terminal.**
- Proves: a container engine command that needs sudo can be answered through
  an askpass program from a non-terminal exec, once, with nothing echoed.
- Go: the command runs with the answer given once, and nothing is written to
  disk.
- No-go: sudo for that host role stays on the old path until another design;
  R11 is rescoped.
- Host role: a container host where the engine needs sudo.

**P6 A launch by exec gets the same PATH as an interactive login.**
- Proves: a command run by exec over ssh finds the same CLI paths and the same
  environment as the user's interactive login shell.
- Go: the same `PATH` and the same CLI paths, for bash and zsh.
- No-go: the probe records absolute CLI paths through one interactive login
  when the device is added, the launch uses those paths, and R10 is sized
  again.
- Host role: a Linux host with tmux, a macOS host, a password-auth host.
