# Remote helper threat model

The threats to the remote helper design in
`architecture/decisions/2026-11-14-adr-029-remote-sessions-run-through-a-device-helper.md`
and the protocol in `docs/remote/helper-protocol.md`. It covers the new design
only. Section numbers like "protocol 13" point into the protocol.

## 1 Assets

- **The local machine and the app:** the Conductor tools (browser, canvas,
  file transfer), local files, the local network, the device records, and the
  secrets in the OS keychain (ssh passwords, saved sudo passwords) and in the
  user's ssh agent.
- **The user's account on the remote host:** its files, and the CLI's own
  credentials there. The helper opens no CLI file except the one named edit
  (protocol 8), and never sends, logs or keeps a credential.
- **Session content:** code, prompts, statusline data, uploaded screenshots.
- **The helper binary's integrity** on every device it is installed on.
- **The user's consent:** what is installed on a host, and when.

## 2 Trust boundaries

| Party | Trust |
| --- | --- |
| The app (signed, installed by the user) and the local machine | Trusted. |
| The ssh transport (the system OpenSSH, fixed options, a pinned host key) | Trusted for privacy and integrity once the key is pinned (3.8). |
| The remote host | Untrusted input. The user agreed to run the helper there; nothing it sends is believed without checks. |
| Other users on the remote host | Untrusted. They must not reach the user's helper, files or sessions. |
| The remote CLI | Partly trusted: the user's own agent, but it acts on model output and may be steered by what it reads. It reaches the local machine only through the remote allow-list (3.5). Like any process of that user, it can reach the user's other sessions on the same device. |

**Accepted boundary.** Another process running as the same user on the host
can reach that user's session sockets and files on that device: the same reach
the user's own shell has. No design that runs as the user can do better
without root.

**Out of scope, and what is still claimed.** A host controlled by root or by
the same user can do anything that user can, including answering the hash
check falsely; the design does not defend the remote account against it. It
does claim that such a host cannot run a program on the local machine, read or
write local files, or reach the local network, except through the tools on the
remote allow-list (3.5) and the terminal view (3.3); cannot take the local ssh
agent or another device's secrets (3.8); and cannot reach a session on another
device unless the two share one home folder (3.4). Each claim holds from the
step in 2.1, not before.

### 2.1 When each guarantee holds

| Guarantee | Enforced by | True from |
| --- | --- | --- |
| Host folders per device id; clean-up and removal only behind this install's marker | fixed scripts, app | R2 |
| Fixed ssh options and app-pinned host keys on one-shot execs and the side channel | app | R2 (execs), R6 (side channel) |
| The same on the terminal connection (no agent, pinned key) | app | R10 |
| Saved ssh passwords only through askpass, under its release rules | app | R2 (execs), R10 (terminal) |
| Status and event payloads filtered; no host path used or stored as a local path | app | R6 (status), R7 (events) |
| A session's identity comes from its connection alone | app | R6, kept through R8 and after |
| No CLI token or app secret on the host; no forwarded port | app | R8 |
| Remote tool allow-list; inline-only canvas; no local render roots | app (Conductor server) | R8 |
| The helper opens no TCP or UDP socket | build checks; seccomp on Linux | R5 |
| Nothing typed into a shell | app | R3 (setup), R10 (launch), R11 (sudo) |
| No tmux; the terminal is not parsed | app | R9; R11 |
| sudo release rules (3.7) | app, helper | R11 |

Between R2 and R11 the old terminal path runs beside the new parts. Each
step's adversarial pass covers everything live in that beta, old and new. A
rollback returns to the earlier beta's rows. Every row has a negative test in
its step; the R5 fixtures hold one per refusal.

## 3 Threats and mitigations

### 3.1 A tampered or replaced helper binary

- The helper ships inside the signed app; a manifest compiled into the app
  holds the hash of every released helper. The host never downloads it.
- The fixed scripts (protocol 13) check owner, mode and links of every folder
  from `$HOME` down and set 0700 themselves before any write or exec, outside
  the binary they guard. Files are written fresh and renamed, never overwritten.
- The launcher execs the helper only on a hash match, and the app checks the
  printed hash again. This catches corruption, partial uploads, wrong files and
  changes by other users past the folder modes; not root or the same user
  (section 2). `emit`, `mcp` and `askpass` are not hash-checked.
- The macOS helper (and the Windows one at R13) is signed with the app's
  certificates. Linux helpers rely on the manifest.

### 3.2 Downgrade

- New sessions start only on the bundled helper, at the folder name from the
  manifest; the hello's `helper` field is information only. The previous
  helper may also attach, older ones only `list` and `end`. A hello offering
  only older protocols is refused and the device waits for the user.
- Automatic re-placement: at most once per target per app run, with a notice,
  never because of a host's version list.

### 3.3 A malicious or compromised host sending crafted messages

- Length checked before reading, hard size and depth limits, no compression,
  a strict schema per type. Budgets per connection on messages, bytes, MCP
  streams and calls, refusals and log lines (protocol 12); a bad frame or
  repeated refusals close, with no automatic reconnect.
- No message makes the app run a program, open a URL, or read or write a local
  file, except `mcp` messages within the remote allow-list (3.5).
- Payloads pass a per-provider field allow-list (protocol 8). Host paths are
  their own type: shown, compared or pasted, never opened, never given to
  transcript, resume or usage code, never stored as a local path.
- Host text, everywhere it is shown (the window, OS notifications), has control
  and format characters removed, bidi and zero-width ones included.
- A message cannot name a session. The app routes each side channel to the one
  session it opened, and a hello naming another `sid` fails.
- The terminal connection is not parsed (from R11). For a remote terminal the
  app enables no feature that writes the local clipboard or opens a link
  without a click, and shows window titles as cleaned host text.

### 3.4 Other users and shared homes

- No listening port of any kind, on the network or on loopback.
- `~/.aicc` and everything under it is 0700, files 0600 (the binary 0700),
  checked and set by the fixed scripts; the helper sets umask 077 and checks
  again. A home that is `/`, a link, or writable by others is refused. Nothing
  is written to a shared temporary folder.
- The session socket sits in its 0700 folder; the socket's owner checks the
  peer's user id on every connection and refuses any other user.
- **Shared homes.** Each device id has its own marked folder, so clean-up,
  listing and removal never cross devices or installs. A home shared by several
  machines (network, or mounted into a container) is still one account's
  files, and any of them can change the others'. The probe records the home's
  filesystem type; on a network home the consent screen says so and no saved
  sudo password is released automatically.

### 3.5 Conductor tools reached from the host

- The caller is the host, not only the CLI: any process that can reach the
  session socket can call the session's tools.
- **Default deny.** A remote session gets only the Conductor tools on the
  remote allow-list, whatever route a call takes; others are not listed and
  are refused. Per-session switches apply on top. A new tool stays off for
  remote sessions until it joins the list with argument rules and an
  adversarial pass. The exact list is a fixture shipped at R8.
- **The rule.** No tool that returns data from the local machine or the local
  network unless the list allows it, with argument rules per tool. Version 1:

| Class of tool | For a remote session |
| --- | --- |
| Reading the app's screenshot or other local folders | not allowed (remote images arrive by upload, R2 and R7) |
| Script evaluation in the session's browser | not allowed |
| Opening a page in the session's browser | `http` and `https` only; no loopback, link-local, private, unique-local or own-machine address, checked on the resolved address of every request and redirect by that browser's request filter |
| Reading or driving the open page | that session's browser only, under the same filter |
| Showing on the canvas | inline content only: no local path, no local URL, and no local render root registered |
| Canvas review notes | that session's own canvas only |
| Local accounts, other sessions, local files or settings | not allowed |

- **Identity.** The session comes from the side channel alone; a message that
  names a session is refused. R8's tests cover a call naming another session,
  a canvas render naming a local path or folder (no render root may appear),
  and navigation to loopback and private addresses; each must be refused.
- **Same-user reach.** A process running as the user on the host can open
  another live session's socket on that device and call tools under that
  session's allow-list and switches (the accepted boundary).

### 3.6 Uploaded files

- The app picks the name from a fixed pattern; the file cannot follow a link
  or replace one (protocol 13). Only into `paste/`, 20 MiB each, 100 MiB per
  session, hash-checked; a partial upload is removed. `paste/` goes with the
  session (3.9) and the device, and from R2 the paste notice says so.

### 3.7 sudo answers

- sudo is answered through `SUDO_ASKPASS`, set to the session's `askpass`
  wrapper, which asks the app over the side channel. Nothing is typed.
- The app accepts `sudo.ask` only while a container launch it started for that
  session waits, only for that target, one at a time; otherwise `denied`. The
  helper also checks, as a best effort, that the asking process descends from
  the sudo it started.
- **A saved sudo password** is released without a click only on a launch the
  user started (opening the session, or Retry), once for that action, counted
  when sent. Never on an automatic reconnect, a second question in the same
  launch, or a network-home device: those go to the user. Each release shows a
  notice naming device and target. A host compromised at the user's level can
  collect it then, as it could a password typed into sudo; these rules stop it
  choosing the moment.
- The answer travels once, in one `sudo.answer`. The helper decodes it into a
  zeroising secret type with no debug or display form, wipes the frame buffer,
  writes it only to the askpass pipe, and runs `serve` and `askpass` with core
  dumps off. The app keeps it only in the keychain and in memory until
  collected; neither side logs it. A test searches core, log and spool for a
  canary secret.
- Whether this works without a terminal is pending probe P5.

### 3.8 The local ssh command, passwords and host keys

- Every ssh the app starts carries the fixed options (protocol 2), which
  override the user's config: no agent, X11 or port forwarding, no local
  command, no shared connection, one password try, only the app's pins.
- Passwords reach ssh only through the app's askpass, by a single-use token
  bound to one connection and its device (protocol 3). Only that device's exact
  password prompt, on a pinned connection with no jump host, gets a saved
  password, once, and never again after a failure until the user acts. Every
  other prompt goes to the user, so a prompt the host writes cannot pull
  another device's secret. The host's ssh server receives the password, as
  with any password login. The app saves a password only in a keychain backed
  by a real secret store. (Pending probe P2 on Windows.)
- Host keys are pinned per device in the app's own file from the first step
  that connects (R2 or R3); that first connection asks the user and releases
  nothing. Jump hops are pinned through the app's own `ProxyCommand`. A changed
  key stops the device until the user checks it. Authentication failures stop
  automatic reconnects (protocol 11), so a stale password cannot lock the
  remote account.

### 3.9 Consent, removal and clean-up

- R2 and R3 place no helper. R2 writes only pasted images and the marker under
  `~/.aicc/<did>/`; R3 writes the files the setup already writes and records
  each in the device record.
- The helper is placed only after the user agrees on a screen listing what is
  placed where, that sessions keep running after a disconnect until ended, and
  the command that removes it all by hand (R4; for a saved-config device, a
  one-time dialog at first connect from R6). Consent is per target. The record
  keeps a hash of the agreed list; an update that changes it asks again, others
  are automatic with a one-line notice.
- **Clean-up.** On every side-channel start `session.list` covers this device
  id only. The app ends by itself only a `stale` session its own record holds
  (after offering the CLI's resume). A live session it has no record of, and
  any `elsewhere` one, appears in the device report and ends only on a user
  action. A detached session ends at its maximum lifetime (7 days by default,
  set per device), recorded in the report.
- **Remove device** ends the sessions the user chose, restores each named
  edit, removes the files R3 recorded, and runs the removal script (protocol
  13; also for a device at the floor or with no helper), then checks the folder
  is gone. It removes copies in running containers, the pinned key unless
  another device of this install uses the same host and port, and every saved
  secret for the device under every key either app generation used. An
  unreachable host is marked removed, with the command to clean it by hand.
- Outside `~/.aicc` the helper changes only the one closed named edit.

### 3.10 Supply chain of the Rust build

- Pinned toolchain, committed `Cargo.lock`, `--locked`, vendored sources built
  `--offline`; CI actions pinned by commit, images by digest. `cargo-deny` with
  an allow-list of crates, feature limits on socket-capable ones, and an
  allow-list for build scripts and procedural macros; `cargo-audit` in CI.
- **No TCP or UDP sockets**: the helper's only socket is its session's
  Unix-domain socket; that is what the checks show and all that is claimed.
  Linux: a seccomp filter (no-new-privileges) in every role allows `socket`
  and `socketpair` only for Unix-domain sockets, applied by the holder right
  after it starts the CLI. Every OS: a lint on the helper's own source forbids
  `std::net`, raw sockets and name lookups outside one local-socket module, and
  a symbol check of the built binary (static musl on Linux) refuses lookup and
  internet-socket functions; on macOS these two are the guard. A CI run under a
  system-call trace fails on any internet socket or lookup. A permanent canary
  (a test-only feature opening an internet socket) must turn all of them red
  on every run; the same planted-change test covers `cargo-deny`, `cargo-audit`
  and the build comparison. Programs the helper starts are not covered.
- Reproducible builds (fixed `SOURCE_DATE_EPOCH`, path remapping, fixed build
  path): Linux built twice and compared; macOS compared before signing, with
  the post-signing hash in the manifest. Fuzzing of frame, marked-line and
  message decoders on both sides. Source, build and manifest join the ADR-009
  path table at R5; Rust is reviewed by a separate agent with a Rust brief.

### 3.11 Logging and recordings

- The helper log sits in the session folder, owner-only, capped at 1 MiB and
  removed with the session. Neither side logs secrets, file bytes, MCP payloads
  or statusline payloads; logs carry types, sizes, ids and reason codes.
- **Recordings (R5.1)** are redacted by message type and field before reaching
  disk: an allow-list of fields is kept; secrets, raw frames, MCP bodies and
  payload strings become a typed placeholder with their length; an unknown type
  stops the recorder. They are written outside the repository and a human views
  every one, re-records included, before commit. Recorded runs use a fake sudo
  and test accounts. CI scans the fixtures for secrets and hosts-file values,
  and a test checks a planted sudo password and screenshot never appear.

### 3.12 Device records on the local machine

- Device records (target, pinned host key, consent and install state, the
  probe report) live under the app's resources folder. They are trusted as far
  as the OS user is: the design protects them only against a lower-privilege
  process planting or changing them, not against software running as the user.
- Each record carries a MAC under a subkey derived, for this purpose only,
  from a per-install secret the app keeps in the OS keychain. A record whose
  MAC fails is treated as absent, and the user must check the device again.
- A stored consent flag is never trusted alone: before placing or starting
  anything, the app confirms it covers the pinned key, the helper hash and the
  placement list in use, or asks again. No record field the app treats as a
  local path ever holds a path the host supplied.

## 4 Review

- Every R step that ships code takes the ADR-009 adversarial pass, scoped to
  the old and new parts live in that beta (2.1).
- Design-stage adversarial pass: round 1 found 1 blocker and about 22 majors;
  applied in this revision; round 2 result recorded in the PR.
