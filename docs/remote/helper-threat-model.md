# Remote helper threat model

The threats to the remote helper design in
`architecture/decisions/2026-11-14-adr-029-remote-sessions-run-through-a-device-helper.md`
and the protocol in `docs/remote/helper-protocol.md`. It covers the new design
only. Section numbers like "protocol 13" point into the protocol.

## 1 Assets

- **The local machine and the app:** the Conductor tools (browser, canvas,
  file transfer), local files, the local network, the user's signed-in web
  sessions, the device records, and the secrets in the OS keychain (ssh
  passwords, saved sudo passwords), the user's ssh agent and Kerberos tickets.
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
| A container target | Less trusted than its host, even under the same user name (3.4). |
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
agent, a Kerberos ticket, the app's environment or another device's secrets
(3.8); and cannot reach a session on another device unless the two share one
home folder (3.4). Each claim holds from the step in 2.1, not before.

### 2.1 When each guarantee holds

| Guarantee | Enforced by | True from |
| --- | --- | --- |
| Host folders per device id; clean-up and removal only behind this install's marker | fixed scripts, app | R2 |
| Fixed ssh options, minimal environment and app-pinned keys on one-shot execs and the side channel | app | R2 (execs), R6 (side channel) |
| Terminal ssh: `-e none` and the minimal environment | app | R2 |
| Terminal ssh: the rest of the fixed options | app | R10 |
| Saved ssh passwords only through askpass, under its release rules | app | R2 (execs), R10 (terminal) |
| Host home recorded once; the only pasted host text is a checked upload path | app | R2 |
| Remote terminal: no clipboard write; links `http` or `https` only, on a click | app | R2 |
| Remote allow-list: tools list filtered, argument rules, no local render roots, remote-session flag | app (Conductor server) | R2 (route before R8), R8 (side channel) |
| Browser tools for a remote session: filtering proxy, throwaway context | app | R8 (refused before) |
| Device records under a MAC; consent re-checked against pin and hash | app | R3 |
| Payloads filtered; host paths and CLI session ids typed remote-only | app | R6 (status), R7 (events) |
| A session's identity comes from its connection alone | app | R6, kept through R8 and after |
| Budgets per connection; consent per target with a hash of the agreed list | app, helper | R6 |
| One closed named edit outside `~/.aicc` | helper | R7 |
| No CLI token or app secret on the host; no forwarded port | app | R8 |
| The helper opens no TCP or UDP socket | dependency review; build checks; seccomp on Linux | R5 |
| Nothing typed into a shell | app | R3 (setup), R10 (launch), R11 (sudo) |
| No tmux; the terminal is not parsed | app | R9; R11 |
| sudo release rules (3.7); shared homes found by file identity (3.4) | app, helper | R11 |

Between R2 and R11 the old terminal path runs beside the new parts. Each
step's adversarial pass covers everything live in that beta, old and new. A
rollback returns to the earlier beta's rows. Every row has a negative test in
its step; the R5 fixtures hold one per refusal.

## 3 Threats and mitigations

### 3.1 A tampered or replaced helper binary

- The helper ships inside the signed app with a compiled-in manifest of every
  released helper's hash; the host never downloads it. The fixed scripts
  check every folder from `$HOME` down before any write or exec (protocol 13).
- The launcher execs only on a hash match, which the app checks again. This
  catches corruption, partial uploads, wrong files and changes by other users
  past the folder modes; not root or the same user (section 2). `emit`, `mcp`
  and `askpass` are not hash-checked. The macOS helper (and Windows at R13) is
  signed; Linux helpers rely on the manifest.

### 3.2 Downgrade

- New sessions start only on the bundled helper; the hello's `helper` field is
  information only. A live session keeps the helper its spec names, if the
  manifest knows its hash (protocol 7). A hello offering only older protocols
  is refused. Re-placement happens at most once per target per app run, with a
  notice, never because of a host's version list.

### 3.3 A malicious or compromised host sending crafted messages

- Length checked first, hard size and depth limits, no compression, a strict
  schema per type, budgets (protocol 12). Malformed input closes with no
  automatic reconnect; `denied` and `busy` are only rate-limited.
- No message makes the app run a program, open a URL, or read or write a local
  file, except `mcp` messages within the remote allow-list (3.5).
- Payloads pass a per-provider field allow-list (protocol 8). Host paths and
  remote CLI session ids are their own types, never given to local transcript,
  resume, relocation, usage or canvas code, never a local path or map key.
- Host text has control and format characters removed wherever it is shown.
- A message cannot name a session; each side channel serves the one session
  it opened, and a hello naming another `sid` fails.
- **The terminal view.** Not parsed (from R11). For a remote terminal the app
  writes nothing to the local clipboard and cleans window titles. Links open
  only on a click, only `http` or `https` after normalisation, through the
  main process's one checked open path, showing the real target when an OSC 8
  link's text differs (a test uses a `file:` and a UNC link). The only host
  text typed into a terminal is a checked upload path, under `-e none`.

### 3.4 Other users and shared homes

- The helper listens on no port of any kind, network or loopback. The old
  path's forwarded port goes at R8 (2.1).
- `~/.aicc` and everything under it is 0700, files 0600 (the binary 0700),
  checked and set by the fixed scripts; the helper sets umask 077 and checks
  again. A home that is `/`, a link, or writable by others is refused. Nothing
  is written to a shared temporary folder.
- The session socket sits in its 0700 folder; the socket's owner checks the
  peer's user id on every connection and refuses any other user.
- **Shared homes.** Each device id has its own marked folder, so clean-up,
  listing and removal never cross devices or installs. A home shared by
  machines, or bind-mounted into a container, is still one account's files,
  each side able to change the others'. Containers are found by file identity
  (device and inode of `$HOME` and `~/.aicc`, and the container's mounts;
  protocol 14), not filesystem type, which stays a signal for network homes.
  On a match the consent screen says so and no saved sudo password is released
  automatically; the host-side sudo wrapper sits outside the home.
- **Machines sharing a home.** Each spec names its machine and boot. Another
  machine's session is `elsewhere`, never ended by the app; `end` signals only
  a holder confirmed through its socket peer (protocol 13).

### 3.5 Conductor tools reached from the host

- The caller is the host, not only the CLI: any process that can reach the
  session socket can call the session's tools.
- **Default deny, from R2.** The Conductor server marks every SSH session
  remote, and a remote session gets only the tools on the remote allow-list,
  one list on every route (before R8 and on the side channel). Others are
  neither listed nor run. Per-session switches apply on top. A new tool joins
  only with argument rules and an adversarial pass. The list is an R2 fixture.
- **The rule.** No tool returns data from the local machine or the local
  network unless the list allows it, with argument rules per tool. Version 1:

| Class of tool | For a remote session |
| --- | --- |
| Reading the app's screenshot or other local folders | not allowed (remote images arrive by upload, R2 and R7) |
| Script evaluation in a browser | not allowed |
| Opening, reading or driving a page | from R8 only, in that session's own browser context, through the filtering proxy below |
| Showing on the canvas | inline content only: no local path, no local URL, and no local render root registered |
| Canvas review notes | that session's own canvas only |
| Local accounts, other sessions, local files or settings | not allowed |

- **The browser.** All of a remote session's browser traffic goes through an
  app-run filtering proxy that resolves each name itself, connects to the
  address it checked (so rebinding cannot swap it) and refuses by that
  address. It never chains to a system or PAC proxy, and loopback is not
  bypassed. Non-proxied WebRTC UDP and QUIC are off; each redirect is a new
  request through the proxy. Denied: `0.0.0.0/8` and `::`; loopback; private
  and unique-local; link-local; `100.64.0.0/10`; IPv4-mapped and NAT64 forms;
  multicast and broadcast; benchmark `198.18.0.0/15`; reserved `240.0.0.0/4`;
  the app machine's own addresses; names ending in `.local`.
- **Context.** Each remote session gets an isolated, throwaway browser context
  with an empty profile, shared with no local session or signed-in partition.
  If one cannot be made, the call is refused; there is no shared fallback.
  Downloads, file choosers, permission requests and windows outside it are
  refused.
- **Identity.** From R8 the session comes from the side channel alone; a
  message that names a session is refused.
- **Tests.** R2: a remote tools list holds only the allow-list; a canvas
  render naming a local path registers no render root. R8: a call naming
  another session; a name resolving to loopback; rebinding; `0.0.0.0`; a
  `100.x` address; a redirect chain; a system proxy; WebRTC; a download. Each
  is refused.
- **Same-user reach.** A process running as the user on the host can open
  another live session's socket on that device and call tools under that
  session's allow-list and switches (the accepted boundary).

### 3.6 Uploaded files

- The app picks the name from a fixed pattern; the file cannot follow or
  replace a link (protocol 13). Only into `paste/`, 20 MiB each, 100 MiB per
  session, hash-checked, partial uploads removed; the returned path must equal
  the recorded home plus the expected folder before it is pasted. `paste/`
  goes with the session and the device, and the paste notice says so.

### 3.7 sudo answers

- sudo asks through `SUDO_ASKPASS`, the session's `askpass` wrapper, which asks
  the app over the side channel. The app accepts `sudo.ask` only while a
  container launch it started for that session waits, for that target, one at
  a time; otherwise `denied`. The helper also checks, best effort, that the
  asker descends from the sudo it started.
- **A saved sudo password** is released without a click only on a launch the
  user started (opening the session, or Retry), once for that action, counted
  when sent. Never on an automatic reconnect, a second question in the same
  launch, or a shared-home device (3.4): those go to the user. Each release
  shows a notice naming device and target. A host compromised at the user's
  level can collect it then, as it could a password typed into sudo; these
  rules stop it choosing the moment.
- The answer travels once, in one `sudo.answer`, into a zeroising secret type
  with no display form; the frame buffer is wiped, it goes only to the askpass
  pipe, and `serve` and `askpass` run with core dumps off. Neither side logs
  it; a test searches core, log and spool for a canary secret.
- Whether this works without a terminal is pending probe P5.

### 3.8 The local ssh command, passwords and host keys

- Every ssh the app starts carries the fixed options and the minimal
  environment (protocol 2): no agent, X11, port forwarding or Kerberos
  delegation, no sent environment or escape sequences, no local command or
  shared connection, one password try, only the app's pins, checked with
  `ssh -G`. No app secret can leave through the user's `SendEnv`; a CI canary
  proves it.
- Passwords reach ssh only through askpass (protocol 3): only the device's
  exact password prompt on a pinned connection with no jump host gets a saved
  password, once, never again after a failure until the user acts. Other
  prompts go to the user labelled as the device's text, never during an
  automatic reconnect. Passwords are saved only in a real secret store
  (pending probe P2 on Windows).
- Host keys are pinned per device in the app's own file from the first step
  that connects; that first connection asks the user and releases nothing.
  Jump hops are pinned too. A changed key stops the device. Authentication
  failures stop automatic reconnects, so a stale password cannot lock the
  remote account.

### 3.9 Consent, removal and clean-up

- R2 and R3 place no helper. R2 writes only pasted images and the marker under
  `~/.aicc/<did>/`; outside `~/.aicc`, R3's setup writes only the files it
  records in the device record (protocol 13).
- The helper is placed only after the user agrees (ADR decision 2) on a screen
  that also names the folder-trust edit in plain words. Consent is per target;
  the record keeps a hash of the agreed list, and an update that changes it
  asks again.
- **Clean-up.** `session.list` covers this device id only. For a `stale`
  session the app offers the CLI's resume, then removes the folder only if its
  own record holds it. A live session it has no record of appears in the
  device report and ends only on a user action; an `elsewhere` one only from
  its own machine. A detached session ends at its maximum lifetime (7 days by
  default, per device). From R4 the Devices page lists `~/.aicc` folders
  whose marker names another install, and removes one only after a confirm.
- **Remove device** ends the sessions the user chose, restores each named
  edit (this needs the helper; at the floor the app shows the edit to undo),
  removes the files R3 recorded, runs the removal script (which refuses while
  a holder it was not told to end is alive) and checks the folder is gone. It
  removes copies in running containers, the pinned key unless another device
  uses the same host and port, and the device's saved secrets, including any
  copy under an older key. An unreachable host is marked removed, with the
  command to clean it by hand.
- From R7, outside `~/.aicc` the helper changes only the one closed named edit.

### 3.10 Supply chain of the Rust build

- Pinned toolchain, committed `Cargo.lock`, `--locked`, vendored sources built
  `--offline`; CI actions pinned by commit, images by digest. `cargo-deny` with
  an allow-list of crates, feature limits on socket-capable ones, and an
  allow-list for build scripts and procedural macros; `cargo-audit` in CI.
- **The control against a hostile dependency is source review.** Every
  `Cargo.lock` change is reviewed as a source diff (`cargo-vet` style audits
  per crate version; vendored sources diffed on update), and any `Cargo.lock`
  or `deny.toml` change is an ADR-009 trigger. A name allow-list cannot stop a
  bad new version of an allowed crate, and run-time checks cannot stop code
  that runs before them.
- **No TCP or UDP sockets: defence in depth against an exploited helper.**
  Linux: a seccomp filter (no-new-privileges, audit architecture checked),
  installed first in `main` for every role but the holder, which starts the
  CLI before reading session data and then installs it. It allows `socket` and
  `socketpair` only for Unix-domain sockets and denies the three `io_uring`
  calls, `socketcall` where it exists, and `ptrace`; sockets made before it
  are left to source review. macOS: no run-time enforcement in version 1. Every
  OS: a source lint forbids `std::net`, raw sockets and name lookups outside
  one local-socket module; a symbol check refuses lookup functions (it cannot
  tell Unix from internet sockets); a CI system-call trace runs every role
  with each planted trigger. Two canaries must turn the checks red on every
  run: a plain internet socket, and a raw-syscall one from a pre-`main`
  initialiser, also tried through io_uring. Programs the helper starts are
  not covered.
- Reproducible builds: Linux built twice and compared; macOS compared before
  signing, with the post-signing hash in the manifest. Frame, marked-line and
  message decoders are fuzzed on both sides. Source, build and manifest join
  the ADR-009 path table at R5; Rust gets a separate reviewer with a Rust brief.

### 3.11 Logging and recordings

- The helper log sits in the session folder, owner-only, capped at 1 MiB and
  removed with the session. Neither side logs secrets, file bytes, MCP payloads
  or statusline payloads; logs carry types, sizes, ids and reason codes.
- **Recordings (R5.1)** keep an allow-list of fields per message type; secrets,
  raw frames, MCP bodies and payload strings become typed placeholders, and an
  unknown type stops the recorder. They are written outside the repository and
  viewed by a human before commit. Runs use a fake sudo and test accounts; CI
  scans fixtures for secrets and host values, with a planted-canary test.

### 3.12 Device records on the local machine

- Device records (target, pinned host key, home, consent and install state,
  the probe report) live under the app's resources folder. They are trusted
  as far as the OS user is: the design protects them only against a
  lower-privilege process planting or changing them, not against software
  running as the user.
- Each record carries a MAC under a purpose-bound subkey of a per-install
  secret. The install id and secret are per OS user and machine, in the OS
  secret store, never in the resources folder (which may be synced). With no
  real secret store, records live in an owner-only credential-style file in
  the per-user data folder instead, and passwords are not saved. A record
  whose MAC fails is treated as absent until the user checks the device.
- A stored consent flag is never trusted alone: before placing or starting
  anything, the app confirms it covers the pinned key, helper hash and
  placement list in use, or asks again. No field the app treats as a local
  path ever holds a host-supplied path.

## 4 Review

- Every R step that ships code takes the ADR-009 adversarial pass, scoped to
  the old and new parts live in that beta (2.1).
- Design-stage adversarial pass: two rounds of findings applied in this
  revision (round 1: 1 blocker and about 22 majors; round 2: about 10 majors);
  the final result is recorded in the PR.
