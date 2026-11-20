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
| Host folders per device id; clean-up and removal only behind this install's marker, another install's folder read-only to the app; sessions `elsewhere` or `unknown` never ended or removed by the app, an `unmanaged` or `orphaned` one only on the user's explicit end, shown by the CLI's stopped state (protocol 7); removal reads a session as dead only on positive proof | fixed scripts, app | R2; states R6, R9 |
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

Until R12 the old path runs beside the new; each step's pass covers both, a
rollback returns to the earlier beta's rows, and every row has a negative test.

## 3 Threats and mitigations

### 3.1 A tampered or replaced helper binary

- The helper ships inside the signed app with a compiled-in manifest of every
  released helper's hash; the host never downloads it. The launcher execs only
  on a hash match, which the app checks again. This catches corruption, wrong
  files and changes by other users past the folder modes; not root or the same
  user (section 2). `emit`, `mcp` and `askpass` are not hash-checked. macOS
  helpers are signed (Windows at R13); Linux relies on the manifest.
- **This computer (2.1.3-beta.6, plain and partner terminals).** There is no
  host and no manifest here: the compiled-in hash manifest in the point above
  is for remote machines, and on This computer the trust anchor is the signed install
  plus the hash check below: the helper installed with the signed app
  (`resources/helper/`, signed with the app on Windows and macOS; the release
  workflow checks the helper's own signature, signer and timestamp on Windows,
  and its signature, team and hardened runtime on macOS).
  The app copies it into a per-user folder outside the install folder (so an
  update can replace the installed file while holders run from the copy), in a
  folder named for its version and hash. Before every run of the copy (each
  `hold`, `list` and `selftest`) the app hashes the copy and compares it with
  the installed file's SHA-256, taken at start; a mismatch is copied again
  once, and a second mismatch marks the helper failed and starts nothing
  through it. A holder's hello must name the nonce from its record, and the
  app writes nothing to the endpoint before that hello has been read. This
  catches a corrupted or swapped copy; like the remote case it does not stop
  the same user, who can already run any program as themselves.
- **The bundled ConPTY on This computer (from 2.1.3-beta.7, the launch field
  `conpty`).** A launch may ask a holder on Windows for the bundled ConPTY.
  The holder then loads `conpty.dll` only from the `conpty` folder beside its
  own program file, by its full path, never from a path in a message: with
  `LoadLibraryExW` and `LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR` plus
  `LOAD_LIBRARY_SEARCH_SYSTEM32`, so only that folder and System32 are
  searched for what it needs, and with critical-error dialogs off for the
  load. The folder and both files (the DLL and the `OpenConsole.exe` it
  starts) must be plain, not a link, a junction or another reparse point,
  and the holder keeps all three open from that check until the
  pseudoconsole is made, so within the holder nothing can swap them between
  its check and its use. Files can still be added to the folder, which is
  searched for what the DLL needs; only the same user can do that, as below.
  A DLL that is missing, does not load or lacks one of
  its three calls is answered `io`, and nothing starts; one that lacks a call
  is unloaded again. The app's install code can put node-pty's two files from
  the signed install into that folder of the per-user copy, hash node-pty's
  files when it does, and check the copies against those hashes before each
  use, as for the helper: a mismatch is copied again once, and a second
  mismatch makes only the bundled ConPTY unavailable. The app does not use
  this yet. The app's check and the holder's load happen in two processes,
  so the same user can swap the files between them. Like the helper's own
  check, this catches a corrupted or swapped copy but does not stop the same
  user, who can already run any program as themselves.
- **An exact command line on This computer (from 2.1.3-beta.7, the launch
  field `line`).** `line` changes what a program reads, never which program
  starts: `CreateProcessW` starts `argv[0]` by that exact path with no
  search, and `line` is refused with a batch file there, which Windows would
  start through cmd.exe. That check reads the name Windows opens: with
  `line`, a name with a part made only of dots and spaces (such as `.` or
  `..`, which Windows resolves first) or a trailing separator is refused,
  and the holder checks once more on the full name `GetFullPathNameW` makes,
  as Rust's own `Command` does. A command interpreter runs what its line
  says, so `line` gives nothing `argv` could not already say; like `argv`,
  it comes only from the same user's app.
- **macOS entitlements of the shipped helper.** electron-builder signs every
  Mach-O in the bundle with `entitlementsInherit`, which is the app's own
  `build/entitlements.mac.plist`: allow-jit, allow-unsigned-executable-memory,
  allow-dyld-environment-variables, network.client, network.server and
  files.user-selected.read-write. The helper needs none of them, and
  electron-builder has no per-file entitlements, so the helper carries the
  app's set. Signing the helper on its own with no entitlements is a follow-up.
  What it opens is a same-user concern (section 2): the app starts the helper
  with a short, fixed environment (`HELPER_ENV_NAMES` in
  `src/main/session-helper/manager.ts`), and the helper's own source has no
  network code (checked by the Helper job).

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
  remote CLI session ids are remote-only types: never a local path or map key,
  never given to local transcript, resume, usage or canvas code; a remote
  resume runs on the host.
- A message cannot name a session: identity comes from the connection alone, and
  a hello naming another `sid` fails. Host text has control and format characters
  removed wherever it is shown.
- **The terminal view.** Not parsed (from R11). For a remote terminal the app
  neither reads nor writes the local clipboard (no OSC 52) and cleans window
  titles. Links open only on a click, only `http` or `https` after
  normalisation, through one checked open path, showing the real target when an
  OSC 8 link's text differs (tested with `file:` and UNC links).

### 3.4 Other users, shared homes and containers

- `~/.aicc` and everything under it is 0700, files 0600 (the binary 0700),
  checked and set by the fixed scripts from `$HOME` down; the helper sets umask
  077 and checks again. A home that is `/`, a link, or writable by its group or
  by others, or that sits under an ancestor writable by either, is refused; no
  group is exempt, since another account can be a member, even of a group named
  like the user. The only file outside the home is the node id, in a user-owned
  0700 folder checked the same way, holding nothing secret (protocol 13).
- The helper listens on no port, network or loopback. The session socket sits
  in its 0700 folder; its owner checks the peer's user id on every connection.
- **Shared homes.** Each device id has its own marked folder, so clean-up and
  removal never cross devices or installs; other folders are only listed (3.9).
- **Containers.** The facts come from the host's fixed script running the
  engine's inspect (protocol 14), never from the container, whose own report
  can only add "shared". A target is **shared** if it has: a bind whose source
  is under or equal to the host home, the runtime folder or `~/.aicc`, an
  ancestor of the home or runtime folder, an engine socket (any Unix socket, or
  anything under `/run` or `/var/run`), or `/proc`, `/sys` or `/dev` or below
  one; a host PID, IPC, user, network, UTS or cgroup namespace; `Privileged`; a
  non-empty `CapAdd` or `CapDrop`; a `SecurityOpt` other than the engine
  default; or a non-empty `Devices`. Sources are compared by real path and by
  device and inode, against `$HOME` and each of its ancestors. Facts are read
  again at every placement and user-started launch, and every exec names the
  inspected container id. A changed mount list or id, a missing field, a failed
  parse or a detection that has not answered counts as shared; a user confirm
  clears only a change, never a list match. On shared, the consent screen says
  so and no saved sudo password is released automatically (3.7).
- **Machines sharing a home.** Each spec names its machine identity (machine
  id, host name, node id) and boot (protocol 1). The app never ends or removes
  a session on another or an unknown machine; the removal script refuses while
  one exists, naming the host to use, with the exits in protocol 13. Clones
  identical in all three parts are not told apart. An `unmanaged` folder, or an
  `orphaned` one (holder gone, CLI not shown stopped), is kept, never resumed
  over, until a new boot or a confirmed `end` makes it `stale` (protocol 7).

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
  local path registers no render root. R8: a remote canvas render registers no
  render root and takes its identity from the side channel; a script-added
  resource hint makes no connection; and each of these is refused: a call naming
  another session; `file:`, `view-source:file:`, `chrome://version`,
  `data:text/html`, `javascript:`, `blob:` and a page-initiated `file:`
  navigation; a name resolving to loopback; rebinding; `0.0.0.0`; `100.x`; a
  redirect chain; a system proxy; WebRTC; a download; a deny-listed name.

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
  only on a user action; an `orphaned` one is offered "reattach or end". A
  detached session ends at its maximum lifetime (7 days by default, per
  device). From R4 the Devices page lists the `~/.aicc` folders of other
  installs read-only, with by-hand removal steps; the app never writes to or
  deletes one, even on a confirm (protocol 1, 13).
- **Remove device** (from R4; R3 and R6 ship with the consent screen's by-hand
  removal steps) ends the sessions the user chose, restores each named edit
  (at the floor it shows the edit to undo), puts back R3's backups and removes
  R3's files, runs the removal script (protocol 13), checks its folder is gone,
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
  Not yet in 2.1.3-beta.6: the helper for This computer is built by
  `cargo build --release --locked` inside each release packaging job, before
  that job's signing steps, so electron-builder signs it with the app. That job
  already runs the app's npm install and build, so the helper's pinned crates
  add to code that runs there rather than open a new place. The separate build
  and signing jobs, vendored `--offline` sources and the reproducible-build
  comparison come with the remote helper.
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
  editing them. Each carries a MAC under a purpose-bound subkey of a
  per-install secret, kept per OS user and machine in the OS secret store,
  never in the resources folder (which may be synced). With no real secret
  store, records live in an owner-only credential-style file in the per-user
  data folder and passwords are not saved. A record whose MAC fails is treated
  as absent until the user checks the device.
- A stored consent flag is never trusted alone: before placing or starting
  anything, the app confirms it covers the pinned key, helper hash and
  placement list in use, or asks again. No field the app treats as a local
  path ever holds a host-supplied path.

### 3.13 What a holder on this computer keeps open

- **A holder keeps none of the app's open handles (from 2.1.3-beta.7).** The
  app's starter (`hold --detach`) is given every handle the app lets a child
  inherit, and the holder outlives the app. On Windows the starter starts the
  holder with a handle list naming only the holder's standard error pipe,
  both when the holder leaves the starter's job and when the job keeps it. On
  macOS and Linux the holder closes every descriptor from 3 up before it
  serves: with `close_range` on Linux, else from `/proc/self/fd` or
  `/dev/fd`, else every number up to the higher of its descriptor limits, at
  most 1,048,576 (`helper/src/detach.rs`). Tested by
  `a_detached_holder_keeps_none_of_its_starters_handles`, the in-job start's
  own test, and a test of each way of closing.
- The holder also runs in the store folder, never the app's, so it keeps no
  folder of the app's open (protocol 15).
- **Hook events through a holder (capability `hooks`, from 2.1.3-beta.8).**
  Any process of the same user can post a hook event to a holder
  (`aicc-helper hook`, or a `hook.event` of its own on the endpoint). That is
  the same boundary as today, where any process of the same user can read a
  session's gateway token from its settings file and post to the hooks
  gateway. The holder only numbers an event and passes it on: it runs, opens
  and writes nothing for it, and keeps at most 256 events and 2 MiB while no
  connection takes them. The app treats every hook payload as untrusted text,
  and a transcript path from one passes `sanitiseTranscriptPath` before it is
  used, in the app-side change that sends hooks through the helper (ADR-030
  slice S12). The hook mode reads untrusted input on its standard input, keeps
  at most 4 MiB of it, and never prints or exits other than 0, so nothing it
  reads reaches the CLI's conversation through it.
- **Tool streams through a holder (capability `mcp`, from 2.1.3-beta.10).**
  The relay (`aicc-helper mcp`, protocol 15, "Tool streams") carries a
  session's tool calls between its CLI and the connection attached to the
  session's terminal. From 2.1.3-beta.11 the app names it to a held
  session's CLI, which starts it, behind a switch (the next item). What a relay may do: open one stream
  at a time, at most 8 in a session, and pass JSON-RPC messages on it to the
  attached connection that acked `mcp`, at most 1,048,320 bytes each, and get
  that connection's answers. What it may not: use the terminal (a launch,
  attach, resize, detach or end from a connection that opened a stream is
  refused and the connection closed; typed bytes from it are refused too),
  reach another session (a holder serves one session, and the app connection
  is that holder's own), or name another relay's stream (each side sees only
  its own number for a stream). The holder passes a message on and nothing
  more: it runs, opens and writes nothing for it. Any process of the same user
  can connect to the endpoint and open a stream, so it can reach whatever the
  app answers on one; that is the boundary there is today, where any process
  of the same user can read a session's settings or launch flags and reach the
  Conductor server. So the step that wires a session's tools to a relay keeps
  3.5's rule for a stream: the session a call acts for comes from the stream
  (the holder it came through) alone, never from a message, a message that
  names another session is refused, and the session's own allow-list and
  switches apply. The relay trusts a holder only once its hello carries the
  record's nonce and session, so a process that took the endpoint's name first
  is sent nothing. A connection that acked `mcp` may send frames of up to 16
  MiB, as any connection may before a launch: 16 connections at most. Two
  limits for that step to settle: a tool message to a relay is written from
  the attached connection's own thread, so a relay that does not read holds
  that connection's other messages for up to 5 s (the write's limit, after
  which the relay's connection is closed); and the app must send only JSON the
  holder reads (no escaped lone surrogate, at most 31 levels inside the
  message), or the frame is `bad-frame` and the app's connection is closed.
  Tested in `helper/tests/relay.rs`:
  `a_connection_that_opened_a_tool_stream_never_uses_the_terminal`,
  `a_relays_message_over_what_the_app_takes_is_too_large_and_its_stream_goes_on`,
  `a_session_has_at_most_its_bound_of_tool_streams_and_a_closed_one_makes_room`,
  `with_no_stream_to_have_the_relay_exits_1_at_once_and_prints_nothing` (an
  app connection that did not ack `mcp` is passed nothing) and
  `a_holder_from_before_tool_streams_is_sent_nothing`. An adversarial pass of
  it is owed to the security round before 2.1 stable (aicc_planning #320).
- **A held session's Conductor tools through its holder (from 2.1.3-beta.11,
  behind the agent sessions' setting, off by default).** With the setting on,
  a held Claude Code session's per-session MCP config file, and the launch of
  a held session whose CLI names its tool servers in its launch flags, name a
  program to start as the session's `conductor` tool server: the helper copy,
  by its path, with `mcp --store <folder> --session <sid>`, in place of the
  loopback address and credential. Those two paths go only into that session's
  own file, written owner-only by the writer that wrote the credential it
  replaces, or into its own launch, and never into a log line. The app serves
  a stream only for a session it switched, under the tab's id (the holder it
  came through, as above), so the tool set is the one that session's record
  gives. A session that cannot be switched keeps the loopback route, with one
  log line saying why, and the loopback server and its credential stay for it,
  for SSH sessions, for sessions that are not held, and for the status line. A
  launch through cmd.exe takes the relay only when cmd.exe's quoting rule
  carries its arguments unchanged; the rule is not widened, so a path with a
  space (the installed app's folder) keeps such a launch on the loopback
  route. An adversarial pass is owed to the same security round: the path
  written into the file, an argument that changes what that CLI starts, a
  session switched while its holder is another session's, and a fall-back that
  leaves a session with no tools and no word.
- **A program the helper starts for the app keeps none of the app's handles
  (from 2.1.3-beta.8, Windows).** `aicc-helper start` (protocol 15, "Starting
  a program") starts the program the app names, by the drive-absolute path it
  is given, with inheritance off and no standard handles, so nothing the app had
  open reaches it; the helper itself exits at once. The mode gives the app no
  new power: the app can already start any program it names, and this only
  starts one holding fewer handles. It never searches PATH, and it refuses a
  batch file and a name Windows would open as another, so the file it starts
  is the file named. It prints the program's pid and creation time, and the
  app ends the program only while that pid still has that creation time. The
  app starts only the vision browser through it, from the browser's own
  folder. Tested by `the_program_it_starts_keeps_none_of_the_starters_handles`
  (with a control that inherits the same pipe end, so the test can fail) and
  `it_says_which_process_it_started_in_the_form_the_app_checks`
  (`helper/tests/start.rs`).
- **The helper ends only the program it started, and only while its pid has its
  creation time (from 2.1.3-beta.8, Windows).** `aicc-helper end` (protocol 15,
  "Ending a program it started") is given a pid and a creation time, both plain
  digits. It opens that process and holds it open from the check to the end, so
  the pid cannot pass to another process in between, and ends it and the
  processes under it only while the pid has that creation time; a process made
  earlier than its parent, or after the system time the helper reads just
  before it reads the process list, is not taken to be under it. A listed pid
  can pass to a new process only after the list is read, so that process is
  never taken to be under it. It gives the app no new power: the app can
  already end any process of its user (`taskkill`). It reads the process list
  itself, with no PowerShell and no WMI, so an exit that cannot wait gets an
  answer in milliseconds, a second more at most when an end fails (it waits
  that long, in all, for a process it could not end to finish exiting). Tested
  by `it_ends_what_it_started_only_while_the_pid_has_that_start_time` (another
  creation time leaves the process running) and
  `it_ends_the_processes_under_it_too` (`helper/tests/start.rs`).
- **At the app's start, the helper ends only the console hosts the run before
  left (from 2.1.3-beta.9, Windows).** `aicc-helper console-hosts` (protocol
  15, "Console hosts a run left") is given the pid and creation time the app
  recorded for its run before, both plain digits from a file in the user's own
  data folder (a dev or test run's own data folder instead, as for
  `vision-started.json`). It ends a process only when it is a console host by
  name and by program file, runs as the helper's own user, is listed with that
  pid as its parent, and was made after that creation time and before both the
  helper's own and that of whatever process has the pid now; it holds each open
  from its check to its end. It ends nothing while that pid still has that
  creation time. It gives the app no new power: the app can already end any
  process of its user. What it rests on is the identity of the run before, and
  two limits of it are owed to the security round before 2.1 stable
  (aicc_planning #320): only the process that has the pid now bounds what
  counts, so a process that took the pid and has exited too is not seen; and
  the record is a file any program of the same user can write, as that program
  could end the user's processes itself. The first, as a case: the run before
  dies, a console program of the same user gets its pid and starts its own
  `conhost.exe`, then exits while a child keeps that console (a batch file that
  runs `start /b server` and ends, say). Nothing has the pid now, so the bound
  is the helper's own start, and that host (made after the record, before the
  helper, by the same user, from Windows' own program file) is ended: the child
  loses its console. Tested in `helper/tests/console_hosts.rs` by
  `it_ends_the_console_host_a_run_ended_from_outside_left_and_nothing_else` (a
  run that still runs, a record naming a pid another run has now, and a record
  of another start end nothing; a run's own host is ended and another run's is
  not),
  `a_record_whose_pid_another_process_took_after_its_run_had_gone_ends_nothing`
  and `a_record_from_before_windows_last_started_ends_nothing`, and the bounds
  by the unit tests in `helper/src/consoles.rs`.
- **A record names the program the next start ends (from 2.1.3-beta.9,
  Windows).** The app writes the pid and creation time `start` printed to
  `vision-started.json` in its user data folder (a dev or test run's own data
  folder instead, so a dev run never ends an installed app's browser), and at
  its next start, and before each launch of the vision browser, ends that pid
  through `aicc-helper end` only while it has that creation time. The
  record is read strictly (a plain file of at most 256 bytes holding exactly a
  pid and a creation time of digits); one that does not read is removed and
  ends nothing. A process of the same user that writes it can make the next
  start end a process of that user with exactly that pid and creation time,
  which it could already end itself. When the helper in the install folder is
  gone, the app runs the session helper's per-user copy only after reading its
  SHA-256 again (3.1). Tested in `tests/unit/main/vision-manager-start-mode.test.ts`.

## 4 Review

- Every R step that ships code takes the ADR-009 adversarial pass, scoped to
  the old and new parts live in that beta (2.1).
- Design-stage adversarial pass and the PR review's comments are applied; the
  final result is recorded in the PR.
