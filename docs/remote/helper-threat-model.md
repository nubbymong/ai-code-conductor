# Remote helper threat model

The threats to the remote helper design in
`architecture/decisions/2026-11-14-adr-029-remote-sessions-run-through-a-device-helper.md`
and the protocol in `docs/remote/helper-protocol.md`. It covers the new design
only. Section numbers like "protocol 13" point into the protocol.

## 1 Assets

- **The local machine and the app:** the Conductor tools (browser, canvas,
  file transfer), local files, the local network and clipboard, the user's
  signed-in web sessions, the device records, the secrets in the OS keychain
  (ssh and saved sudo passwords), the user's ssh agent and Kerberos tickets.
- **The user's account on the remote host:** its files, and the CLI's own
  credentials there. The helper opens no CLI file except the one named edit
  (protocol 8), and never sends, logs or keeps a credential.
- **Also:** session content (code, prompts, statusline data, uploaded
  screenshots), the helper binary's integrity on every device, and the user's
  consent (what is installed on a host, and when).

## 2 Trust boundaries

| Party | Trust |
| --- | --- |
| The app (signed, installed by the user) and the local machine | Trusted. |
| The ssh transport (the system OpenSSH, fixed options, a pinned host key) | Trusted for privacy and integrity once the key is pinned (3.8). |
| The remote host | Untrusted input. The user agreed to run the helper there; nothing it sends is believed without checks. |
| Other users on the remote host | Untrusted. They must not reach the user's helper, files or sessions. |
| A container target | Less trusted than its host, even under the same user name. Facts that decide trust come from the host side, never from the container (3.4). |
| The remote CLI | Partly trusted: the user's own agent, but it acts on model output and may be steered by what it reads. It reaches the local machine only through the remote allow-list (3.5). Like any process of that user, it can reach the user's other sessions on the same device. |

**Accepted boundary.** Another process running as the same user on the host
can reach that user's session sockets and files on that device, as the user's
own shell can. No design that runs as the user can do better without root.

**Out of scope, and what is still claimed.** A host controlled by root or by
the same user can do anything that user can, including answering the hash
check falsely. The design still claims that such a host cannot run a program
on the local machine, read or write local files, or reach the local network,
except through the remote allow-list (3.5) and the terminal view (3.3); cannot
take the local ssh agent, a Kerberos ticket, the app's environment or another
device's secrets (3.8); and cannot reach a session on another device unless
the two share one home folder (3.4). Each claim holds from its step in 2.1.

### 2.1 When each guarantee holds

| Guarantee | Enforced by | True from |
| --- | --- | --- |
| Host folders per device id; clean-up and removal only behind this install's marker; `unmanaged`, `elsewhere` and `unknown` sessions never ended or removed by the app | fixed scripts, app | R2; states R6 |
| Fixed ssh options, minimal environment and per-connection pins; on a terminal `-e none` and the environment first, the rest later | app | R2 (execs), R6 (side channel); terminal R2, R10 |
| Saved ssh passwords only through askpass, under its release rules | app | R2 (execs), R10 (terminal) |
| Host home recorded once; the only pasted host text is a checked upload path; remote terminal: no clipboard read or write, links `http` or `https` only, on a click | app | R2 |
| Remote allow-list: tools list filtered, argument rules, no local render roots, inline canvas content under the egress-confined policy, remote-session flag | app (Conductor server) | R2 (route before R8), R8 (side channel) |
| Browser tools for a remote session: `http` and `https` only, filtering proxy, throwaway context | app | R8 (refused before) |
| Device records under a MAC, the only store of host-key pins; consent re-checked against pin and hash | app | R2 (pins), R3 (records) |
| Budgets per connection; consent per target with a hash of the agreed list | app, helper | R6 |
| Payloads filtered; host paths and CLI session ids typed remote-only; remote resume runs on the host | app | R6 (status), R7 (events) |
| A session's identity comes from its connection alone | app | R6, kept through R8 and after |
| One closed named edit outside `~/.aicc`; no CLI token or app secret on the host and no forwarded port | helper; app | R7; R8 |
| The helper opens no TCP or UDP socket | dependency review; build checks; seccomp on Linux | R5 (checks, helper dark), R6 (shipped roles), R9 (holder) |
| Nothing typed into a shell; no tmux; the terminal is not parsed | app | R3 (setup), R9 (no tmux), R10 (launch), R11 (sudo, no parsing) |
| sudo release rules (3.7); shared homes found from the host side (3.4) | app, helper | R11 |

Until R12 the old path runs beside the new; each step's adversarial pass covers
both, a rollback returns to the earlier beta's rows, and every row has a
negative test in its step.

## 3 Threats and mitigations

### 3.1 A tampered or replaced helper binary

- The helper ships inside the signed app with a compiled-in manifest of every
  released helper's hash; the host never downloads it. The launcher execs only
  on a hash match, which the app checks again. This catches corruption, wrong
  files and changes by other users past the folder modes; not root or the same
  user (section 2). `emit`, `mcp` and `askpass` are not hash-checked. macOS
  helpers are signed (Windows at R13); Linux relies on the manifest.

### 3.2 Downgrade

- New sessions start only on the bundled helper; the hello's `helper` field is
  information only. A live session keeps the helper its spec names, if the
  manifest knows its hash (protocol 7). A hello offering only older protocols
  is refused. Re-placement is at most once per target per app run, with a
  notice, never because of a host's version list.

### 3.3 A malicious or compromised host sending crafted messages

- Length checked first, hard size and depth limits, no compression, a strict
  schema per type, budgets (protocol 12). Malformed input closes with no
  automatic reconnect; `denied` and `busy` are only rate-limited. No message
  makes the app run a program, open a URL, or read or write a local file,
  except `mcp` messages within the remote allow-list (3.5).
- Payloads pass a per-provider field allow-list (protocol 8). Host paths and
  remote CLI session ids are their own types, never given to local transcript,
  resume, relocation, usage or canvas code, never a local path or map key;
  resuming a remote conversation runs on the host by that id.
- A message cannot name a session; each side channel serves the one session
  it opened, and a hello naming another `sid` fails. Host text has control and
  format characters removed wherever it is shown.
- **The terminal view.** Not parsed (from R11). For a remote terminal the app
  neither reads nor writes the local clipboard (no OSC 52 either way) and
  cleans window titles. Links open only on a click, only `http` or `https`
  after normalisation, through the main process's one checked open path,
  showing the real target when an OSC 8 link's text differs (a test uses a
  `file:` and a UNC link).

### 3.4 Other users, shared homes and containers

- `~/.aicc` and everything under it is 0700, files 0600 (the binary 0700),
  checked and set by the fixed scripts from `$HOME` down; the helper sets umask
  077 and checks again. A home that is `/`, a link, or writable by others is
  refused. The only file outside the home is the node id, in a user-owned 0700
  folder checked the same way, holding nothing secret (protocol 13).
- The helper listens on no port, network or loopback. The session socket sits
  in its 0700 folder; its owner checks the peer's user id on every connection.
- **Shared homes.** Each device id has its own marked folder, so clean-up,
  listing and removal never cross devices or installs.
- **Containers.** The facts come from the host's fixed script running the
  engine's inspect (protocol 14), never from the container, whose own report
  can only add "shared". A target is **shared** if it has: a bind whose source
  is the host home, the runtime folder or an ancestor of either, lies under the
  runtime folder or `~/.aicc`, is an engine socket, or is `/proc`, `/sys` or
  `/dev` or below one; a host PID, IPC, user, network, UTS or cgroup
  namespace; privileged mode; `CapAdd` of SYS_ADMIN, SYS_PTRACE or SYS_MODULE;
  unconfined `SecurityOpt`; or any device. Facts are read again at every
  placement and user-started launch; a changed mount list, a missing field, a
  failed parse or a detection that has not answered (it never needs a saved
  sudo password) counts as shared. On shared, the consent screen says so and
  no saved sudo password is released automatically (3.7).
- **Machines sharing a home.** Each spec names its machine identity (machine
  id, host name, node id) and boot (protocol 1). The app never ends or removes
  a session on another or an unknown machine; the removal script refuses while
  one exists, naming the host to use, with the exits in protocol 13. Clones
  identical in all three parts are not told apart. An `unmanaged` folder is
  kept until a new boot or a confirmed `end` makes it `stale` (protocol 7).

### 3.5 Conductor tools reached from the host

- The caller is the host, not only the CLI: any process that can reach the
  session socket, the user's other processes on that device included (the
  accepted boundary), can call the session's tools under its allow-list.
- **Default deny, from R2.** The Conductor server marks every SSH session
  remote, and a remote session gets only the tools on the remote allow-list,
  one list on every route (before R8 and on the side channel). The list is a
  fixture file naming each tool, its class and its argument rule; a registered
  tool not in it is neither listed nor run. Per-session switches apply on top.
  A new tool joins only with a fixture row, argument rules and an adversarial
  pass. From R8 the session comes from the side channel alone; a message that
  names one is refused. No tool returns local-machine or local-network data
  unless the list allows it. Version 1 classes:

| Class of tool | For a remote session |
| --- | --- |
| Reading the app's screenshot or other local folders; script evaluation in a browser; local accounts, other sessions, local files or settings | not allowed (remote images arrive by upload, R2 and R7) |
| Opening, reading or driving a page (every navigate or open tool, the in-app browser's included) | from R8 only, in that session's own browser context, through the filtering proxy below. After URL normalisation the scheme is `http` or `https` only; any other (`file`, `chrome`, `view-source`, `data`, `javascript`, `blob`, `filesystem`, `about` other than `about:blank`) is refused before the browser sees it, and page-initiated navigations to them are refused in the remote context |
| Showing on the canvas; its review notes | inline content only: no local path, no local URL, no local render root; served only under the egress-confined design policy (connections only to the app, WebRTC blocked, DNS prefetch off, resource hints stripped, including ones a script adds); review notes on that session's own canvas only |

- **The browser.** All of a remote session's browser traffic goes through an
  app-run filtering proxy that resolves each name itself, connects to the
  address it checked (so rebinding cannot swap it) and refuses by that
  address. It never chains to a system or PAC proxy, and loopback is not
  bypassed. Non-proxied WebRTC UDP and QUIC are off; each redirect is a new
  request through the proxy. Denied: `0.0.0.0/8` and `::`; loopback; private
  and unique-local; link-local; `100.64.0.0/10`; IPv4-mapped and NAT64 forms;
  multicast and broadcast; benchmark `198.18.0.0/15`; reserved `240.0.0.0/4`;
  the app machine's own addresses; names ending in `.local`; and a per-device
  deny list of names and ranges the user edits. **Its limit:** it cannot tell
  an internal service on a public or VPN-routed address, or a name the user's
  corporate or split DNS resolves; the consent text says so.
- **Context.** Each remote session gets an isolated, throwaway, empty browser
  context, shared with no local session or signed-in partition, or the call is
  refused. Downloads, file choosers, permissions and other windows are refused.
- **Tests.** R2: every registered tool is in the fixture or refused, and a
  remote tools list holds only the fixture's tools; a canvas render naming a
  local path registers no render root. R8: a remote canvas
  render registers no render root and takes its identity from the side
  channel; a script-added resource hint makes no connection; and each of these
  is refused: a call naming another session; `file:`, `view-source:file:`,
  `chrome://version`, `data:text/html`, `javascript:`, `blob:` and a
  page-initiated `file:` navigation; a name resolving to loopback; rebinding;
  `0.0.0.0`; `100.x`; a redirect chain; a system proxy; WebRTC; a download; a
  name on the device deny list.

### 3.6 Uploaded files

- The app picks the name; the file cannot follow or replace a link; caps, hash
  check and partial-file removal apply; the path must equal the recorded home
  plus the expected folder before it is pasted (protocol 8, 13). `paste/` goes
  with the session and the device, and the paste notice says so.

### 3.7 sudo answers

- sudo asks through `SUDO_ASKPASS`, the session's `askpass` wrapper (outside
  every mount source, protocol 14), which asks the app over the side channel.
  The app accepts `sudo.ask` only while a container launch it started for that
  session waits, for that target, one at a time; otherwise `denied`. The helper
  also checks, best effort, that the asker descends from the sudo it started.
- **A saved sudo password** is released without a click only on a launch the
  user started (opening the session, or Retry), once for that action, counted
  when sent; never on an automatic reconnect, a second question in the same
  launch, or a shared target (3.4). Each release shows a notice naming device
  and target. A host compromised at the user's level can collect it then, as
  it could a typed sudo password; these rules stop it choosing the moment.
- The answer travels once, in one `sudo.answer`, into a zeroising secret type
  with no display form; the frame buffer is wiped, it goes only to the askpass
  pipe, and `serve` and `askpass` run with core dumps off. Neither side logs
  it; a test searches core, log and spool for a canary secret. Working without
  a terminal is pending probe P5.

### 3.8 The local ssh command, passwords and host keys

- Every ssh the app starts carries the fixed options and the minimal
  environment, checked with `ssh -G` (protocol 2); a CI canary proves no app
  variable, config `SetEnv` or askpass variable reaches the host. A user's
  `ProxyCommand` gets only the device's extra variables, none secret-named.
- Saved passwords go only through askpass, under its release rules (protocol
  3), kept only in a real secret store (pending probe P2 on Windows);
  keyboard-interactive prompts and all other host text go to the user, never
  during an automatic reconnect.
- The MAC-checked device record is the only store of a host-key pin; each ssh
  gets a per-connection known-hosts file written from it and deleted after, so
  a planted line is never trusted. The first connection asks the user and
  releases nothing; jump hops are pinned too; a changed key stops the device,
  an authentication failure its automatic reconnects.

### 3.9 Consent, removal and clean-up

- R2 and R3 place no helper. R2 writes only pasted images and the marker under
  `~/.aicc/<did>/`; outside `~/.aicc`, R3's setup writes only the files it
  records in the device record, backing up any it replaces (protocol 13).
- The helper is placed only after the user agrees (ADR decision 2) on a screen
  that also names the folder-trust edit in plain words. Consent is per target;
  the record keeps a hash of the agreed list, and a change asks again.
- **Clean-up.** The app itself acts only on `stale` sessions (protocol 7): it
  offers remote resume, then removes the folder only if its own record holds
  it. A live session it has no record of appears in the device report and ends
  only on a user action. A detached session ends at its maximum lifetime (7
  days by default, per device). From R4 the Devices page lists `~/.aicc`
  folders of other installs and removes one on a confirm.
- **Remove device** (from R4; R3 and R6 ship with the consent screen's by-hand
  removal steps) ends the sessions the user chose, restores each named edit
  (at the floor it shows the edit to undo), puts back R3's backups and removes
  R3's files, runs the removal script (protocol 13), checks the folder is gone,
  and removes copies in running containers, the device record with its pins
  and the device's saved secrets, any copy under an older key included. An
  unreachable host is marked removed, with the command to clean it by hand.

### 3.10 Supply chain of the Rust build

- Pinned toolchain, committed `Cargo.lock`, `--locked`, vendored sources built
  `--offline`, the crates.io registry only (no git or path dependencies); CI
  actions pinned by commit, images by digest. `cargo-deny` allow-lists crates,
  build scripts and procedural macros and limits features on socket-capable
  crates; `cargo-audit` runs in CI. Budget: under 25 crates, no async runtime,
  no TLS or HTTP crate; a new crate is its own ADR-009 item.
- **Build and signing are apart.** The build job holds no secrets and has no
  network. A separate signing job takes only the finished artifact, checks it
  against the reproducible-build comparison and signs, so no build script or
  procedural macro runs where signing material is.
- **The control against a hostile dependency is source review.** Every
  `Cargo.lock` change is reviewed as a source diff by someone other than its
  author, who records an audit per crate version in the repository's audit
  file (`cargo-vet` style); any `Cargo.lock` or `deny.toml` change is an
  ADR-009 trigger. A name allow-list cannot stop a bad new version of an
  allowed crate, and run-time checks cannot stop code that runs before them.
- **No TCP or UDP sockets: defence in depth against a helper that opens a
  socket itself.** Linux: a seccomp filter (no-new-privileges, audit
  architecture checked) allows `socket` and `socketpair` only for Unix-domain
  sockets and denies the three `io_uring` calls, `socketcall` where it exists,
  and `ptrace`. Children inherit it for good, so every process not on the path
  that starts the CLI installs it first in `main` (`serve`, `attach`, `emit`,
  `mcp`, `askpass`, the one-shot commands); on that path the spawner installs
  none and reads one byte, and the holder installs it right after starting the
  CLI, before reading any socket (protocol 5). An R9 test asserts the CLI child
  can open an internet socket and run sudo while `serve` cannot. The filter
  does not stop code in `serve` that makes the unfiltered spawner start a
  holder, which runs its spec's `argv` before its own filter; source review is
  the control there. macOS: no run-time enforcement in version 1. Every OS: a
  source lint (no `std::net`, raw sockets or name lookups outside one
  local-socket module), a symbol check and a CI system-call trace of every
  role; two canaries (a plain internet socket, and a raw-syscall one from a
  pre-`main` initialiser, also through io_uring) must turn them red on every
  run. Programs the helper starts are not covered.
- Reproducible builds: Linux built twice and compared; macOS compared before
  signing, with the post-signing hash in the manifest. Decoders are fuzzed on
  both sides. Rust gets a separate reviewer with a Rust brief.

### 3.11 Logging and recordings

- The helper log sits in the session folder, owner-only, capped at 1 MiB and
  removed with the session. Neither side logs secrets, file bytes, MCP or
  statusline payloads; logs carry types, sizes, ids and reason codes, at most
  100 deduplicated lines a minute per connection.
- **Recordings (R5.1)** keep an allow-list of fields per message type; secrets,
  raw frames, MCP bodies and payload strings become typed placeholders, and an
  unknown type stops the recorder. They are written outside the repository and
  viewed by a human before commit. Runs use a fake sudo and test accounts; CI
  scans fixtures for secrets and host values, with a planted-canary test.

### 3.12 Device records on the local machine

- Device records (target, pinned host keys, home, consent and install state,
  the probe report) live under the app's resources folder, trusted to the OS
  user and protected only against a lower-privilege process planting or
  changing them. Each carries a MAC under a purpose-bound subkey of a
  per-install secret, kept per OS user and machine in the OS secret store,
  never in the resources folder (which may be synced). With no real secret
  store, records live in an owner-only credential-style file in the per-user
  data folder and passwords are not saved. A record whose MAC fails is treated
  as absent until the user checks the device.
- A stored consent flag is never trusted alone: before placing or starting
  anything, the app confirms it covers the pinned key, helper hash and
  placement list in use, or asks again. No field the app treats as a local
  path ever holds a host-supplied path.

## 4 Review

- Every R step that ships code takes the ADR-009 adversarial pass, scoped to
  the old and new parts live in that beta (2.1).
- Design-stage adversarial pass: four fix rounds; the final result, with
  disputed and deferred items, is recorded in the PR.
