# Remote helper protocol, version 1

The messages between the app and the helper on a remote device, and the ssh
commands that carry them. The decision and step plan are in
`architecture/decisions/2026-11-14-adr-029-remote-sessions-run-through-a-device-helper.md`;
the threats are in `docs/remote/helper-threat-model.md`.

It covers steps R2 to R11. **Pending probe Pn** marks what a probe (ADR) must
confirm. The R5 message fixtures fix field types and lengths, with one refusal
fixture per error code and per pattern.

## 1 Names and places

- **Device id (`did`).** 32 lower-case hex characters, random, made by the app
  install once per target (a host, or a container on it). R2 makes it for a
  saved SSH config at its first upload; R3 keeps it as the device id. Two app
  installs, or two devices sharing one home folder, never share a `did`.
- **Layout.** Everything lives under `~/.aicc/<did>/`; `~/.aicc` holds nothing
  else. In it: `owner`, a marker with the `did` and app install id;
  `helper/<version>-<hash12>/aicc-helper` (first 12 hex of its SHA-256; never
  on `PATH`); `sessions/<sid>/` (0700: spec, provider files, socket `s`, `seq`,
  a bounded spool, the helper log, `holder` from R9, and `paste/`); and
  `edits`, old values of named edits (section 8). No step writes, runs or
  deletes inside a `did` folder whose marker lacks this install's ids.
- **Session id (`sid`)**, chosen by the app: `^[A-Za-z0-9][A-Za-z0-9_-]{7,31}$`.
  Every socket bind and connect happens after a `chdir` into the session
  folder, by the name `s`, so a long home never meets the path limit.
- **Host home.** Learned once per target (R2's first upload result; from R3
  the probe report): it starts with `/`, is at most 1,024 bytes of valid UTF-8,
  with no control (Cc) or format (Cf) character, so no CR, LF or ESC. It is
  kept as a remote path; every later path must start with exactly it, and a
  different home stops the device until the user checks it again.
- **Machine and boot.** Each session spec holds the machine id (Linux
  `/etc/machine-id`, macOS `IOPlatformUUID`), boot id and host name (display
  only). With no machine id, no session there is ever `stale` (section 7).

## 2 The local ssh command

The app runs one ssh program by absolute path, resolved once at start: on
Windows the system OpenSSH unless the user picks another in Settings,
elsewhere the first `ssh` on the app's `PATH` (**pending probe P2** on
Windows). It reads `ssh -V` at start.

**Environment.** Every ssh the app starts (terminal included, from R2) and its
askpass and `ProxyCommand` children get a fixed allow-list, never the app's own
environment: `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `TERM` (terminal),
`SSH_AUTH_SOCK`, `KRB5CCNAME`, Windows system variables (a fixed list) and the
askpass variables. No command-line option can clear a config `SendEnv`.

**Fixed options.** Every ssh the app starts carries this set; command-line
options win over the user's config for these keys. One-shot execs and the side
channel carry all of it (R2, R6); the terminal carries `-e none` from R2 and the
rest from R10, when its launch moves to exec.

| Options | Why |
| --- | --- |
| `-a -x`, `ForwardAgent=no`, `ForwardX11=no`, `ForwardX11Trusted=no`, `GSSAPIDelegateCredentials=no` | the host never gets the local agent, display or a Kerberos ticket |
| `ClearAllForwardings=yes`, `Tunnel=no`, `PermitLocalCommand=no`, `ControlMaster=no`, `ControlPath=none` | no forward, local command or shared connection from the user's config |
| `-e none`; `EnableEscapeCommandline=no` (9.2+) | no escape sequences: pasted text cannot add a forward or end the link |
| `SendEnv -*`, `SetEnv` cleared | nothing from the config adds variables (the environment above is the control) |
| `StrictHostKeyChecking=yes`, `UserKnownHostsFile=<app file>`, `GlobalKnownHostsFile=<empty app file>`, `UpdateHostKeys=no`, `VerifyHostKeyDNS=no`; `KnownHostsCommand=none` (8.5+) | only the app's pin counts, and the host cannot change it |
| `RemoteCommand=none`, `StdinNull=no`; `SessionType=default`, `ForkAfterAuthentication=no` (8.7+) | the command and stdin are the app's |
| `NumberOfPasswordPrompts=1`, `BatchMode=no` | one password try; BatchMode would turn askpass off |
| `-T` (side channel, one-shot) or `-tt` (terminal); `-p <port> -l <user> -- <target>` | nothing after `--` is an option |

A versioned key is added from that `ssh -V` on; an older client cannot honour
it from the config either. Before a device's first connection per app run,
`ssh -G` with the set must print every fixed value and a `hostkeyalias` no
other device has, or the device is refused, naming the key.

The user matches `^[A-Za-z0-9_][A-Za-z0-9._@-]{0,63}$`, the target (name,
address or config alias) `^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$`, the port 1 to
65535. A value that breaks its pattern stops before ssh starts.

**Host keys.** The first connection to a target with no pin (R2's first
upload, or R3's probe) uses `StrictHostKeyChecking=ask`: ssh's question goes to
the user through askpass, never answered by the app, saying whether the user's
own known hosts (`ssh -G` `userknownhostsfile`, `ssh-keygen -F`) trust that
key; nothing saved is released on it. A yes writes the key to the app's file.
A changed key stops the device until the user checks it.

**Jump hosts.** A `ProxyJump` from `ssh -G` is replaced by the app's own
`ProxyCommand` running the same ssh, options and environment with `-W %h:%p`,
so every hop is pinned in the app's file. A user's own `ProxyCommand` is kept
and the device marked "jump host not pinned by the app". The user's config
still supplies identity files, host name, port, user and ciphers. A CI sshd
job (R2) sets every fixed key to its unsafe value in a hostile config, asserts
from `ssh -G` that each prints the fixed value, and plants `SendEnv` and
`SetEnv` canaries the test sshd (`AcceptEnv *`) must not receive.

## 3 askpass

ssh asks for passwords, codes and host-key answers through the app's askpass
program, one executable per app OS. It needs OpenSSH 8.4 or later; an older
client connects only with keys that need no passphrase, and says why.

- **How it is reached.** Each ssh gets `SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE=force`
  and `AICC_ASKPASS_TOKEN`, a random value bound to that connection and device,
  valid for its life and at most 4 prompts. The program sends token and prompt
  over an owner-only local endpoint (Unix socket or current-user named pipe),
  prints the answer and exits. No secret is on a command line; the token is a
  bearer value in ssh's environment, worth nothing beyond the rules below.
- **Released without the user:** a saved password, only when the prompt is
  exactly OpenSSH's password prompt built from `ssh -G` (`user`, `hostname`,
  and `hostkeyalias` when set), the connection started pinned, the device has
  no jump host, nothing was released on this connection yet, and the password
  has not failed since the user last entered or confirmed it.
- **Always the user's:** key passphrases, confirm prompts, host-key questions,
  one-time codes and other text; a prompt not in one of ssh's own local forms
  shows as cleaned text under "text written by <device>". During an automatic
  reconnect it shows no dialog and ends the reconnect as "sign-in needed".
- **A failed release** (ssh ends before a hello or result, or prints
  `Permission denied`) marks the saved password failed: no release until the
  user acts, and no automatic reconnect (section 11).

## 4 Remote command lines

Every command the app starts on a host is an exec over ssh; nothing is typed
into a shell. ssh joins the words after the target into one string the login
shell parses, so safety rests on each item's alphabet: no space, quote,
backslash or shell metacharacter, checked before ssh starts.

| Item | Pattern or source |
| --- | --- |
| fixed text | the sub-commands and flags below, and the fixed scripts (sections 13, 14) run as `/bin/sh -c '<script>'` |
| `did`, `sid`; nonce | section 1; 32 lower-case hex characters, new for every exec |
| helper folder; expected hash | `^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?-[0-9a-f]{12}$`; 64 hex. Both only from the app's manifest, never from host data |
| numbers; image name | protocol version, offset, size: decimal integers in range; `paste-<n>.<ext>` |
| engine; container (R11) | `docker` or `podman`; `^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$` |

No value a host reported (home, tool or CLI path) is put on a command line:
scripts build paths from `$HOME` and find their tools themselves. Script text
holds no single quote, backslash or newline, so POSIX shells, csh, tcsh and
fish pass it to `/bin/sh` unchanged (**pending probe P6** for the last three).
Values come as arguments after the script; content comes on stdin.

| Command, through the launcher (section 13) | Connection | From |
| --- | --- | --- |
| `serve --proto 1 --nonce <n> --session <sid>` | `ssh -T`, the side channel, while connected | R6 |
| `attach --session <sid> --from <offset>` | `ssh -tt`, the terminal, while connected | R9 |
| `selftest`, `list`, `end --session <sid>`, each `--nonce <n>` | one-shot exec | R6 |

`emit` (the CLI's statusline and hook command, R6 and R7), `mcp` (the CLI's
stdio MCP server, R8) and `askpass` (the sudo wrapper, R11), each with
`--session <sid>`, are started on the host by the CLI or sudo. The prompt sudo
passes to `askpass` is not forwarded.

## 5 Processes

- Until R9 the old terminal path starts the CLI and `serve` owns the socket
  while connected; with none, `emit` spools and exits 0 (it never makes a
  session folder). From R9 the first `serve` starts one holder (an internal
  `hold` role) owning the CLI's PTY, the socket and `seq`, which writes
  `holder` (machine id, boot id, pid, start time); `serve` and `attach` relay
  to it. Outliving logout is **pending probe P3**.
- Only the holder outlives a connection; `mcp` lives as long as the CLI, the
  rest for one call. The holder exits when the session ends, a non-detachable
  terminal closes, or a detached session reaches its maximum lifetime (threat
  model 3.9). The newest `serve` or `attach` takes the slot; the older gets
  `replaced` and exits (another app instance shows "taken over").

## 6 Framing

**Marked lines.** The app reads only these lines, `<nonce>` being the exec's:

```
AICC-HASH <nonce> <state> <hex>   (the launcher, section 13)
AICC-HELLO <nonce> <json>         (serve)
AICC-RESULT <nonce> <json>        (every one-shot exec and fixed script)
```

Only the first `AICC-HASH` counts; a second one, or a hello with none before
it, fails the exec. Earlier output (banners, rc files) is discarded up to
64 KiB, then the exec fails with `no-hello`. A hello line is at most 4 KiB, a
result line 1 MiB. A zero exit with no result line is a failure.

**Frames.** After the hello: 4 bytes length of the rest (unsigned, big-endian),
1 byte kind (0 = JSON control, 1 = raw bytes), 4 bytes channel id (0 =
control), then the payload. The reader refuses an oversize length before it
allocates. Hard limits: JSON 1 MiB helper to app and 16 MiB app to helper (a
tool result can carry a screenshot); raw 64 KiB both ways; JSON depth 32.
`selftest` checks the exec channel is binary clean.

## 7 Handshake and versions

The hello carries `proto` (versions spoken, e.g. `[1]`), `helper` (version and
`sha256`, information only), `os`, `arch`, `caps`, and `session`: its `sid`
and a state: `new`; `live` (a holder answers); `stale` (this machine's id, and
a new boot or no holder answering); `elsewhere` (another machine's id). A hello
with another `sid` or a broken schema fails as `no-hello`; unknown hello fields
are ignored. The app answers `hello.ack` `{proto, caps}`.

**Mismatch.** No common version: `proto-mismatch`, close, the device waits for
the user (never a re-provision on a host's version list). An older helper gets
no new session until re-provisioned; a newer one, the highest common version.

**Frozen core** (never changes within version 1): the hello with `proto`,
`helper` and `session`; the hash line; the `serve` and `attach` command lines;
`hello.ack`, `probe`, `session.list`, `session.attach`, `session.end`, `ping`,
`pong`, `error`. The `list` and `end` command lines, their result lines and
the removal script never change in any version. Relay-to-holder messages and
session folder files carry their own format version, frozen the same way.

**Rules for change.** New messages or fields only behind a new capability;
changing or removing a message, or the frame layout, makes version 2. The app
speaks the current and previous version. The manifest holds every released
helper's hash. New sessions start only on the bundled one; a live session is
served through the helper folder its spec names for its whole life, so an
upgrade strands none. A fixed script removes an old helper folder only when
`list` shows no live session naming it.

## 8 Messages

Every control message is a JSON object with a type `t`. Requests carry an
`id`; a reply carries `re`; events carry a `seq` (section 9).

| Type | Sent by | Reply | Fields and purpose | Cap, step |
| --- | --- | --- | --- | --- |
| `hello.ack` | app | none | chosen version and capabilities | core, R6 |
| `ping` / `pong` | either | `pong` | heartbeat | core, R6 |
| `error` | either | none | `{re?, code, text}`, text at most 512 characters | core, R6 |
| `probe` | app | `probe.report` | what the host has (below) | core, R6 |
| `session.attach` | app | `session.attached` | `{id, since_seq}`; reply `{re, ring_start, ring_end}` | core, R6 |
| `session.end` | app | `session.ended` | stop this session (TERM, KILL after 5 s), remove its folder | core, R6 |
| `session.list` | app | `session.list.result` | up to 256 `{sid, state, helper, mode, started}`, this `did` only | core, R6 |
| `status` | helper | event | `{seq, payload}`, one statusline update | `status`, R6 |
| `session.prepare` | app | `session.prepared` | `{id, files, edits, env, argv, cwd, mode}`; one result per file and edit | `hooks`, R7 |
| `event` | helper | event | `{seq, kind, payload}`, one hook event | `hooks`, R7 |
| `file.put` | app | `file.stored` | upload one file (below) | `files`, R7 |
| `mcp.open`, `mcp`, `mcp.close` | helper (`mcp` either) | none | `{stream}`; `mcp` adds one JSON-RPC `message` | `mcp`, R8 |
| `session.start` | app | `session.started` | `{id, cols, rows}`; reply `{re, pid}` | `held`, R9 |
| `session.detach` | app | `session.detached` | close relays, keep the session | `held`, R9 |
| `session.exit` | helper | event | `{seq, code, signal}` | `held`, R9 |
| `sudo.ask` | helper | `sudo.answer` / `sudo.decline` | `{id, layer}`; answer `{re, secret}` | `sudo`, R11 |

**Sessions come from the connection.** No host-to-app message carries a
session id the app acts on; each side channel serves the one session it was
opened for, and `session.end` ends that one. Ending a session found by
`session.list` takes a one-shot `end`. This holds from R6, through R8, and
after.

**What the helper may ask and run.** Its requests (`sudo.ask`, `mcp`) are
questions the app may refuse; none makes the app run, open or write anything.
It starts only its own spec's `argv`, on `session.start`; there is no general
exec or file-read request. `argv[0]` is a CLI path from the probe report or the
login shell; `cwd` is absolute; `env` names come from the provider's fixed list,
none holding `KEY`, `TOKEN`, `SECRET`, `PASS` or `AUTH`; `files` go only into the
session folder, by declared names; `edits` name rows of the closed table below;
`mode` is `external` or `held`.

- `probe.report`: OS, kernel, architecture, userland bitness and ARM version,
  login shell, home (section 1) and its filesystem type, the device and inode
  numbers of `$HOME` and `~/.aicc`, machine id, boot id, host name, the hash
  tool found, each CLI (name, absolute path, version), container engines,
  sudo mode, self-test result; for a container target (R11), its mounts. R3's
  bootstrap prints the same document, one validator.
- `file.put` `{id, name, size, sha256}`, then `size` bytes as kind 1 frames on
  channel = request id. `name` is `paste-<n>.<ext>`, `<ext>` from a fixed image
  list; only into `paste/`, 20 MiB each, 100 MiB per session. `file.stored`
  `{re, path, sha256}` must give `path` exactly the recorded home plus
  `/.aicc/<did>/sessions/<sid>/paste/<name>`, and the hash. Attachment by
  pasted path is **pending probe P4**.
- `mcp`: the app hands each message to the Conductor MCP server as the session
  the side channel belongs to, limited to the remote allow-list (threat model
  3.5). `layer` in `sudo.ask` names the configured container target.

**Payload allow-lists.** `status` and `event` payloads (at most 64 KiB) keep
only the fields the provider declares per kind, typed as number, label (at most
128 characters, cleaned as in section 12), remote path or remote CLI session
id; the decoder drops the rest first. A remote path is a display string, never
opened, given to transcript, resume or usage code, or stored as a local path.
A remote CLI session id is a typed `{did, id}`, `id` a canonical UUID
(8-4-4-4-12 lower-case hex, never starting with `-`), kept only in remote-only
fields: never in one that local transcript, resume, relocation, usage or canvas
code reads, never a local map key. A fixture sends a local conversation's id
and asserts no local transcript code runs. Usage shows under the device
record's account. Version 1, Claude Code (names fixed by the R5 fixtures):

- `status`: model id and name; context used, size and percentage; cost and
  duration totals; CLI version; the remote CLI session id; remote paths `cwd`,
  `transcript_path` and the workspace folders.
- `event`: hook name, the remote CLI session id, notification text (a label of
  at most 1,024 characters), tool name. Prompts, tool inputs and results
  dropped.

**Named edits (closed list, from R7).** One row: `claude-folder-trust` sets
`projects["<cwd>"].hasTrustDialogAccepted` to `true` in the CLI's config file
(`~/.claude.json`, or under `CLAUDE_CONFIG_DIR` when set) for exactly the `cwd`
the user chose. It turns off the CLI's trust prompt there; the consent screen
says so. The helper touches no other field, changes bytes only inside that
value (or inserts that key), writes a new file with the same mode, and renames
it over the old one only if the old one is unchanged just before (else `io`;
a writer in that last moment can still lose one update). A golden-file test
covers fake secrets, integers past 2^53, unicode escapes, key order, CRLF, no
final newline and a concurrent writer. The old value goes to `edits`. Probe P4
confirms file and key; a CLI flag, if one exists, replaces the row. A new row
needs its own adversarial pass.

**Error codes.**

| Code | Meaning | Closes |
| --- | --- | --- |
| `bad-frame` | length over the limit or under 5, unknown kind, bad or too-deep JSON, raw bytes with no open transfer | yes |
| `unknown-type` | a type the version and capabilities do not allow | yes |
| `proto-mismatch`, `no-hello`, `hash-mismatch` | sections 7, 6, 13 | yes |
| `replaced` | a newer connection took the session | yes |
| `bad-field`, `too-large` | a field breaks its schema; a size rule is broken | no (budget, section 12) |
| `busy` | one already open, a budget full, or already started | no |
| `not-found`, `not-connected`, `denied`, `timeout`, `io`, `internal` | as named | no |

## 9 Ids and ordering

Request ids are unique per connection (app even, helper odd); each request gets
one reply, its result or `error` with `re`. Each event takes its session's next
`seq` (until R9 from the `seq` file under an exclusive lock, then from the
holder), which survives reconnects. The spool keeps the last status and 50
other events; `session.attach` replays those above `since_seq`, and the app
drops a `seq` it has seen. A gap is logged and, if a hook event was lost, noted
on the session. Side channel and terminal are not ordered with each other.

## 10 Timeouts

| What | Limit | On expiry |
| --- | --- | --- |
| hello; a one-shot exec | 20 s; 60 s, from ssh start, paused while an askpass prompt is open | `no-hello`; ssh stopped, exec failed |
| a reply; `probe`, `session.prepare`, `session.start`, `session.end` | 10 s; 30 s | `timeout` |
| `file.put` | 30 s between chunks; reply 10 s after the last | `timeout`, partial file removed |
| heartbeat | `ping` every 15 s | no `pong` in 45 s: link dropped |
| helper with no frame from the app | 60 s | the relay exits; the holder stays |
| an MCP tool call | the tool's limit, at most 10 min | `timeout` to the CLI |
| `sudo.ask` waiting for the user | 120 s | askpass fails; sudo reports it |

## 11 A dropped connection

- The holder (from R9) keeps the CLI running. With no `serve`: `emit` spools,
  an MCP call gets `not-connected`, a `sudo.ask` fails at once.
- **Automatic reconnect** (`serve`, then `session.attach` with the last `seq`)
  only after a link drop (no `pong` in 45 s, or ssh ending after a hello):
  back-off 1, 2, 4, 8, 16 s, at most 5 tries, and 5 more when the app machine
  wakes or its network returns; then it waits for the user. Never after an
  authentication failure, a prompt it may not answer (section 3), a host-key
  question or change, `hash-mismatch`, `proto-mismatch`, `replaced`,
  `bad-frame`, `unknown-type` or a close for malformed input. A one-time-code
  device never reconnects by itself. A reconnect is never a launch the user
  started (threat model 3.7).
- **Terminal reattach (R9).** The holder keeps a 2 MiB output ring. The app
  clears the view and runs `attach --from <ring_start>`, which writes a
  terminal reset, replays at the recorded size and goes live; the resize after
  makes the CLI redraw. If the ring no longer reaches the start, the app says so.
- `stale`: the app offers the CLI's resume, then removes the folder only if its
  own record holds the session. `elsewhere`: shown with the other machine's
  host name; never ended by the app, and `end` refuses it (threat model 3.9).

## 12 Strict validation and budgets

The host is untrusted input. The app decodes frames off its main thread;
checks every control message against a strict schema per type (unknown types
and fields refused, hello fields excepted; bounded strings; finite integers in
range; ids from small alphabets); never uses a host path locally or stores one
where it expects a local path; shows host text (errors, versions, prompts,
notifications, labels) as plain text with control (Cc) and format (Cf)
characters removed, bidi and zero-width included, capped, in the window and OS
notifications alike; and logs types, sizes and codes only, never secrets, file
bytes, MCP or statusline payloads, at most 100 deduplicated lines a minute per
connection. The only host-derived text it types into a terminal is an upload
path equal to the recorded home plus the expected folder and name (a refusal
fixture holds a home with CR, ESC and a leading `~`).

**Budgets per connection** (the helper applies the same to the app):

| What | Limit | On breach |
| --- | --- | --- |
| messages, helper to app | 200 a second, bursts of 400 | dropped and counted; close after 10 s over |
| `status`, `event` | 10 a second per session | dropped and counted |
| bytes, helper to app | 8 MiB a second | close |
| MCP streams; MCP calls in flight | 4; 8 | `busy` |
| `bad-field`, `too-large` replies (malformed input) | 20 in 60 s | close, no automatic reconnect |
| `denied`, `busy` replies | 5 a second, bursts of 20 | dropped and counted; never a close |
| ssh stderr, stdout after a result line | 64 KiB kept | the rest discarded and counted |

A close for message or byte rate shows a banner and keeps automatic reconnect.

## 13 Fixed scripts

**Folder checks first.** Before any write or exec, every fixed script checks
that `$HOME` is an absolute real folder (not a link), owned by the user, not
`/`, not writable by others; that `~/.aicc`, `~/.aicc/<did>` and each folder it
uses below are real folders owned by the user, which it sets to 0700 itself;
and that the marker holds this install's ids. Owner and mode come from
`ls -ldn` against `id -u` and `id -g`; a group may write only when it is the
user's primary group and `id -gn` equals `id -un`. Tested under dash, bash,
busybox sh and macOS sh. A failure prints a refusal as `AICC-RESULT`. The check
runs outside the binary it guards (what the hash shows: threat model 3.1).

- **Launcher.** Starts every helper command the app runs. Arguments: `did`,
  helper folder, expected hash, nonce, the command's words. It finds the hash
  tool itself with `command -v` (`sha256sum`, `shasum -a 256`,
  `openssl dgst -sha256`, in that order; the hex is the last field of the
  output; with none, the device runs at the floor), prints
  `AICC-HASH <nonce> <state> <hex>` (`ok`, `mismatch`, `missing`, `no-tool`,
  `tool-failed`) and execs only on `ok`. The app compares the hex with its
  manifest again before `hello.ack`. It runs on every start, reconnects
  included, at no extra connection.
- **Install** (R6 and re-provision). Arguments: `did`, helper folder, size,
  expected hash, nonce; the binary on stdin. Umask 077. It removes this `did`'s
  `helper/.new-*` and `selftest-*` leftovers, writes the marker if the folder
  is new, makes `helper/.new-<nonce>` with a plain `mkdir`, reads exactly
  `<size>` bytes there (`head -c`, then a size check), hashes, sets 0700, and
  renames it to the helper folder only if that name does not exist (one with a
  wrong hash is removed first). Then a self-test in `selftest-<nonce>/`:
  session folder, socket, PTY and a binary echo, then removed.
- **`list`, `end`, removal.** `list` covers this `did` only. `end` signals a
  holder only on the spec's own machine, after the socket's peer pid and its
  start time match `holder`; otherwise it signals and removes nothing. The
  removal script (also at the floor; needs no helper) refuses while a `holder`
  line names a live process on this machine and boot, unless the app passes
  the user's confirmed choice to end it; it deletes `~/.aicc/<did>` when the
  marker matches, then `~/.aicc` if empty.
- **R2 upload.** `/bin/sh -c '<upload script>' aicc <did> <sid> <name> <size>
  <nonce>`, image (at most 20 MiB) on stdin. With the folder checks down to
  `paste/`, it refuses at 100 MiB in `paste/`, reads exactly `<size>` bytes to a
  temporary file, hashes it, links it to `<name>` with a plain `ln` (fails if
  the name exists; no hard links is a named refusal), removes the temporary
  name, and prints `AICC-RESULT` with `path`, `sha256`, `tool`. Until R7 each
  upload is one ssh connection. **R2 session end** (`aicc <did> <sid> <nonce>`)
  removes that session's folder and this `did`'s paste files over 7 days old;
  from R6 the clean-up rule (threat model 3.9) replaces it.
- **R3 probe and setup.** The probe prints `probe.report` as `AICC-RESULT`.
  Setup sends each file on stdin (a Windows command line caps near 32 KiB), at
  most 256 KiB a file and 1 MiB a run. Outside `~/.aicc` it writes only files
  the provider declares under the CLI's config folder, each checked absent or a
  user-owned regular file (not a link), written fresh, renamed, and recorded
  with its hash for Remove device.
- **R6 wiring.** R6 points the CLI's statusline command at
  `<helper folder>/aicc-helper emit --session <sid>` through the per-session
  settings the launch already builds; from R7 `session.prepare` writes them.

## 14 Containers (R11)

- **Placing.** Each container target has its own `did` and consent. A one-shot
  `<engine> exec -i <name>` runs the install script, binary on stdin, into the
  container user's `~/.aicc/<did>/`, with the same checks, hash and self-test.
  A recreated container (`missing`) is placed again at most once per target per
  app run, with a notice. The side channel is `<engine> exec -i <name>` around
  the launcher, with `sudo -A` in front when the engine needs sudo.
- **Shared homes.** At placement the app compares the device and inode numbers
  of `$HOME` and `~/.aicc` on the host and inside the container, and reads the
  container's mounts for one covering the host home. A match is treated like a
  network home (threat model 3.4).
- **sudo.** The app first starts a host-side `serve` owning the host session
  folder and socket. The `askpass` wrapper (a 0700 `/bin/sh` file that execs
  the helper's `askpass` with sudo's prompt) and a hash-checked helper copy it
  runs sit in a fresh private folder outside the home (under
  `$XDG_RUNTIME_DIR`), checked as not visible from the container; with none,
  no saved sudo password is released. The fixed script sets `SUDO_ASKPASS` to
  it inside `/bin/sh`, so every sudo question reaches the app through the
  host-side `serve`. Three connections in all.
- **Removal** runs the removal script in every configured running container; a
  stopped one is listed as possibly holding a copy. **Pending probe P5:** sudo
  by askpass with no terminal, `/bin/sh` plus a writable home in a container,
  and a container sharing the host home.
