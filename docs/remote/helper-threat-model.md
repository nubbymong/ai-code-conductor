# Remote helper threat model

The threats to the remote helper design in
`architecture/decisions/2026-11-14-adr-029-remote-sessions-run-through-a-device-helper.md`
and the protocol in `docs/remote/helper-protocol.md`. It covers the new design
only.

## 1 Assets

- **The local machine and the app:** the Conductor tools (browser, canvas,
  screenshots, file transfer), local files, and the secrets in the OS keychain
  (ssh passwords, saved sudo passwords, keys the user's ssh agent holds).
- **The user's account on the remote host:** its files, and the CLI's own
  credentials there, which the helper never reads.
- **Session content:** code, prompts, statusline data, uploaded screenshots.
- **The helper binary's integrity** on every device it is installed on.
- **The user's consent:** what is installed on a host, and when.

## 2 Trust boundaries

| Party | Trust |
| --- | --- |
| The app (signed, installed by the user) | Trusted. |
| The local machine | Trusted. |
| The ssh transport (the system OpenSSH, with a pinned host key) | Trusted for privacy and integrity once the host key is pinned. |
| The remote host | Untrusted input. The user has agreed to run the helper there, but nothing the host sends is believed without checks. |
| Other users on the remote host | Untrusted. They must not reach the user's helper, files or sessions. |
| The remote CLI | Partly trusted. It is the user's own agent, but it acts on model output and may be steered by content it reads. It reaches the local machine only through its session's Conductor tools (3.5). Like any process of that user, it can also reach the user's other sessions on the same device (accepted boundary below). |

**Accepted boundary.** Another process running as the same user on the host
can reach that user's session sockets and files, on that device. That is the
same reach the user's own shell has, and no design that runs as the user can
do better without root. It is recorded here as accepted.

**Out of scope.** A host already controlled by root, or by the same user, can
do anything that user can, including answering the hash check falsely. The
design does not claim to defend the remote account against such a host. It
does claim that such a host cannot run a program on the local machine, or read
or write local files, except through the Conductor tools its sessions are
allowed to call (3.5), and cannot reach a session on another device.

## 3 Threats and mitigations

### 3.1 A tampered or replaced helper binary

- The helper ships inside the signed app with a hash manifest compiled into
  the app. The host never downloads it.
- Installed side by side under `~/.aicc/helper/<version>-<hash12>/`, owner-only
  (folders 0700, the binary 0700). The helper refuses to run if its folder or
  any parent under `~/.aicc` is writable by another user or owned by another
  user.
- Every side-channel start hashes the installed binary and compares it with
  the manifest. A mismatch stops the session and offers re-provisioning.
- The macOS helper (and the Windows helper at R13) is signed with the app's
  certificates. Linux helpers rely on the hash manifest.

### 3.2 Downgrade

- The app starts new sessions only on the helper version it bundles, at the
  versioned path it chose, after the hash check. A host cannot point the app
  at another binary.
- An older helper is used only through the frozen core, to list, attach and
  end a session that started under it.
- The app speaks the current and the previous protocol version only. A hello
  offering only older versions is refused with `proto-mismatch`.

### 3.3 A malicious or compromised host sending crafted messages

- Frame length is checked before reading; hard size limits per direction and
  kind; JSON depth limited; no compression, so no expansion attacks.
- A strict schema per message type: unknown types and fields refused, strings
  bounded, ids from small alphabets. A bad frame closes the connection.
- Apart from `mcp` messages, which reach the Conductor tools (3.5), no message
  makes the app run a program, open a URL, read a local file, or write a local
  file at a path the host chose.
- Paths from the host are only compared with the expected path and pasted
  into the session's own terminal.
- Host text is shown as plain text with control characters removed.
- Rate limits on `status` and `event`; a flood is dropped and counted.
- A message cannot name a session. The app routes each side channel to the
  one session it opened it for.
- The terminal connection is not parsed. Its bytes go to the terminal view as
  any ssh terminal's do.

### 3.4 Other users on a shared host

- No listening port of any kind, on the network or on loopback.
- `~/.aicc` and every folder under it are 0700; files are 0600 (the binary
  0700). The helper sets a umask of 077 at start and checks ownership and mode
  before it uses a folder.
- The session socket sits in the 0700 session folder. The socket's owner
  checks the peer's user id on every connection and refuses any other user.
- Nothing is written to a shared temporary folder.

### 3.5 Conductor tools reached from the host

- The caller is the host, not only the CLI. `mcp` messages are sent by the
  helper on the host, so any process that can reach the session socket (the
  CLI, or a compromised host) can call the session's tools. There is no token
  on the host and no forwarded port.
- Tools that return local data: screenshots from the app's screenshots
  folder; page text, page source and screenshots from the session's browser;
  the canvas and its review notes. Tools that act locally: driving that
  browser (open a page, click, type, scroll), which reaches any site the
  browser can; rendering on the canvas. Every result is sent to the host.
- A remote session gets the same tools, the same per-session tool switches
  and the same authorisation a local session has, nothing more. Until the
  per-device switch lands (queued after the freeze), the per-session switches
  are the only control.
- A message cannot name another session, and a side channel serves one
  session only. But a process on the host running as the user can open
  another live session's socket on the same device and call tools under that
  session's switches (the accepted boundary in section 2). No session on
  another device can be reached.

### 3.6 Uploaded files

- The file name is chosen by the app from a fixed pattern; the helper refuses
  any other name and opens the file so that it cannot follow a link or replace
  an existing file.
- Files go only to the session's `paste/` folder, 20 MiB each, 100 MiB per
  session, and are checked against the hash the app sent.
- A partial upload is removed. The `paste/` folder is removed when the session
  ends, by the clean-up rule in 3.9, and when the device is removed.
- The user is told that a pasted image stays on the host until the session
  ends.

### 3.7 sudo answers

- sudo is answered through `SUDO_ASKPASS`, set to the session's `askpass`
  wrapper, which asks the app over the side channel. Nothing is typed into a
  terminal.
- The app accepts `sudo.ask` only while it waits on a container launch it
  started for that session, and only for that container target. At any other
  time it refuses with `denied` and logs it. Only one question may be open per
  session.
- The app shows which device and which container target is asking. A sudo
  password the user saved is released without a click only under the rule
  above, once per launch. A host compromised at the user's level can collect
  it at that moment, as it could collect a password typed into sudo there. A
  user who does not accept that does not save it and answers each time.
- The answer travels once, in one `sudo.answer` message. The helper passes it
  to sudo and clears it from memory. It is never written to disk on the host
  and never logged on either side. Locally it is held only in the OS keychain,
  and only when the user saves it.
- Whether this works without a terminal is pending probe P5.

### 3.8 ssh passwords and host keys

- ssh passwords stay in the OS keychain and reach ssh only through the app's
  askpass program. They are never typed into the terminal and never passed to
  the helper. With password authentication the host's ssh server receives the
  password, as with any ssh login. (Pending probe P2 on Windows.)
- The host key is shown as a fingerprint and pinned when the user agrees to
  the consent screen (3.9), in a `known_hosts` file the app owns. A changed key
  stops every session on that device until the user verifies it again.

### 3.9 Consent, removal and clean-up

- R2 and R3 place no helper and no program. R2 writes only pasted images under
  `~/.aicc/sessions/<sid>/paste/`; R3 writes only the files the setup already
  writes.
- The helper is placed only after the user agrees on a screen that lists what
  will be placed on the host and where, including container targets. On the
  Devices page (R4) that screen is part of adding a device. A device made from
  a saved SSH config at R3 gets the same screen as a one-time dialog at its
  first connect from R6, and has no helper and no pinned key until then.
- Updates of a provisioned device are automatic, with a one-line notice.
- `uninstall` refuses with `busy` while `list` shows a live session. The app
  then offers to end those sessions, ends each with `session.end`, and runs it
  again. It deletes `~/.aicc` and the copies in running containers; a separate
  exec checks the folder is gone. The app also removes the pinned host key and
  the keychain entries for that device.
- If the host cannot be reached, the device is marked as removed here, and the
  app shows the folder that may remain on the host.
- On every side-channel start the app sends `session.list` and ends every
  session it no longer knows and every `stale` one (after offering the CLI's
  resume). So pasted images, spools and logs left by a crash or a host reboot
  do not stay.
- The helper changes nothing outside `~/.aicc` except the named edits a
  provider declares (for example the CLI's folder-trust entry), each listed in
  the device report.

### 3.10 Supply chain of the Rust build

- A pinned toolchain (`rust-toolchain.toml`) and a committed `Cargo.lock`;
  every build uses `--locked`.
- `cargo-deny` and `cargo-audit` in CI, with a short allow-list of crates.
- No network code, checked two ways. A lint forbids `std::net`, raw socket
  calls and every crate on a network deny-list, except in one local-socket
  module that may create only Unix-domain sockets. A CI run of the real helper
  (self-test and the message fixtures) under a system-call trace fails on any
  socket of an internet family or any name lookup. Both checks are shown to
  fail on a planted change before they are trusted.
- Built in CI from the tagged commit, on the runners that build the app. The
  Linux builds are built twice and the hashes compared; the macOS builds are
  compared before signing.
- Fuzzing of the frame and message decoder on both sides.
- The helper's source, build and manifest join the ADR-009 path table at R5.
  Rust is reviewed by a separate agent with a Rust brief.

### 3.11 Logging

- The helper log sits in the session folder, owner-only, capped at 1 MiB and
  removed with the session.
- Neither side logs secrets, file bytes, MCP payloads or statusline payloads.
  Logs carry message types, sizes, ids and reason codes.
- Live-harness recordings (R5.1) replace secrets and host names as they are
  recorded, and a scrub test fails if a value from the hosts file appears.

## 4 Review

- Every R step that ships code takes the ADR-009 adversarial pass.
- R1 records a design-stage adversarial pass on this file and the protocol
  spec before R5 starts. Status: not yet run.
