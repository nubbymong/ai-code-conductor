# Remote helper threat model

The threats to the remote helper design in
`architecture/decisions/2026-11-14-adr-029-remote-sessions-run-through-a-device-helper.md`
and the protocol in `docs/remote/helper-protocol.md`. It covers the new design
only.

## 1 Assets

- **The local machine and the app:** the Conductor tools (browser, canvas,
  file transfer), local files, and the secrets in the OS keychain (ssh
  passwords, sudo passwords, keys the user's ssh agent holds).
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
| The remote CLI | Partly trusted. It is the user's own agent, but it acts on model output and may be steered by content it reads, so what it can reach is limited to its session. |

**Accepted boundary.** Another process running as the same user on the host
can reach that user's session socket and files. That is the same reach the
user's own shell has, and no design that runs as the user can do better
without root. It is recorded here as accepted.

**Out of scope.** A host already controlled by root, or by the same user, can
do anything that user can, including answering the hash check falsely. The
design does not claim to defend the remote account against such a host. It
does claim that such a host still cannot make the app run code, read local
files, or reach another session.

## 3 Threats and mitigations

### 3.1 A tampered or replaced helper binary

- The helper ships inside the signed app with a hash manifest compiled into
  the app. The host never downloads it.
- Installed side by side under `~/.aicc/helper/<version>-<hash12>/`, owner-only
  (folders 0700, the binary 0700). The helper refuses to run if its folder or
  any parent under `~/.aicc` is writable by another user or owned by another
  user.
- Before every session the installed binary is hashed and compared with the
  manifest. A mismatch stops the session and offers re-provisioning.
- The Windows and macOS helpers are signed with the app's certificates.

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
- No message makes the app run a program, open a URL in the system browser,
  read a local file, or write a local file at a path the host chose.
- Paths from the host are only compared with the expected path and pasted
  into the session's own terminal.
- Host text is shown as plain text with control characters removed.
- Rate limits on `status` and `event`; a flood is dropped and counted.
- Identity is the channel. A message cannot name another session, and the app
  routes each side channel to the one session it opened it for.
- The terminal connection is not parsed. Its bytes go to the terminal view as
  any ssh terminal's do.

### 3.4 Other users on a shared host

- No listening port of any kind, on the network or on loopback.
- `~/.aicc` and every folder under it are 0700; files are 0600 (the binary
  0700). The helper sets a umask of 077 at start and checks ownership and mode
  before it uses a folder.
- The session socket sits in the 0700 session folder. The holder checks the
  peer's user id on every connection and refuses any other user.
- Nothing is written to a shared temporary folder.

### 3.5 Conductor tools exposed to the remote CLI

- The remote CLI reaches the Conductor tools only through `aicc-helper mcp`
  and the side channel. There is no token on the host and no forwarded port.
- The session is known from the channel. A remote session gets the same tools,
  the same per-session tool switches and the same authorisation a local
  session has. Nothing more.
- A tool call cannot address another session or another device.
- A per-device switch for which tools a device may call is queued after the
  freeze; until then the per-session switches apply.

### 3.6 Uploaded files

- The file name is chosen by the app from a fixed pattern; the helper refuses
  any other name and opens the file so that it cannot follow a link or replace
  an existing file.
- Files go only to the session's `paste/` folder, 20 MiB each, 100 MiB per
  session, and are checked against the hash the app sent.
- A partial upload is removed. The `paste/` folder is removed when the session
  ends and when the device is removed.
- The user is told that a pasted image stays on the host until the session
  ends.

### 3.7 sudo answers

- sudo is answered through `SUDO_ASKPASS` set to `aicc-helper askpass`, which
  asks the app over the side channel. Nothing is typed into a terminal.
- The app shows which device and which container target is asking. Only one
  question may be open per session, and only for a configured container
  target.
- The answer travels once, in one `sudo.answer` message. The helper passes it
  to sudo and clears it from memory. It is never written to disk and never
  logged on either side.
- Whether this works without a terminal is pending probe P5.

### 3.8 ssh passwords and host keys

- ssh passwords stay in the OS keychain and reach ssh only through the app's
  askpass program. They never reach the host as data. (Pending probe P2 on
  Windows.)
- The host key is shown and pinned when the device is added, in a
  `known_hosts` file the app owns. A changed key stops every session on that
  device until the user verifies it again.

### 3.9 Consent and removal

- The helper is installed only when the user adds a device and agrees, after
  a screen that lists what will be placed on the host and where.
- Updates of a provisioned device are automatic, with a one-line notice.
- Remove device runs `aicc-helper uninstall`, which deletes `~/.aicc`, then
  checks with a separate exec that it is gone. It also removes the pinned host
  key and the keychain entries for that device.
- If the host cannot be reached, the device is marked as removed here, and the
  app shows the folder that may remain on the host.
- The helper changes nothing outside `~/.aicc` except the named edits a
  provider declares (for example the CLI's folder-trust entry), each listed in
  the device report.

### 3.10 Supply chain of the Rust build

- A pinned toolchain (`rust-toolchain.toml`) and a committed `Cargo.lock`;
  every build uses `--locked`.
- `cargo-deny` and `cargo-audit` in CI, with a short allow-list of crates.
- A check that the helper has no network code: a lint forbids `std::net` and
  every crate on a network deny-list, and a second check reads the built
  binary's imported symbols for name resolution and network connect calls.
- Built in CI from the tagged commit, on the runners that build the app. The
  Linux builds are built twice and the hashes compared; the macOS and Windows
  builds are compared before signing.
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
