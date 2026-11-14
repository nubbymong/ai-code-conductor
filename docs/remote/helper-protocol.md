# Remote helper protocol, version 1

The messages between the app and the helper on a remote device. The decision
and the step plan are in
`architecture/decisions/2026-11-14-adr-029-remote-sessions-run-through-a-device-helper.md`;
the threats are in `docs/remote/helper-threat-model.md`.

This spec covers only what steps R2 to R11 need. Anything a probe must confirm
is marked **pending probe Pn** (the probes are listed in the ADR). The shared
message fixtures (R5) fix exact field types and maximum lengths.

## 1 Names and places

- The helper binary is `aicc-helper`. On the host it lives at
  `~/.aicc/helper/<version>-<hash12>/aicc-helper`, where `<hash12>` is the
  first 12 hex characters of its SHA-256. It is never on `PATH`.
- Each session has a folder `~/.aicc/sessions/<sid>/` (mode 0700). It holds the
  session spec, the provider's files, the local socket, the `seq` counter, a
  bounded spool, the helper log, the `askpass` wrapper (R11) and `paste/`.
- A session id (`sid`) is chosen by the app: 8 to 64 characters from
  `[A-Za-z0-9_-]`.

## 2 Command lines

Every remote command is started by exec over ssh. Nothing is typed into a
shell. A command line holds only the items below, each checked against its
pattern before ssh starts. All other data travels as JSON inside messages.

| Item | Pattern or source |
| --- | --- |
| fixed text | the sub-commands and flags below, `sudo -A`, and the fixed scripts of sections 11 and 12, run as `/bin/sh -c '<script>'` |
| helper path | `<home>/.aicc/helper/<version>-<hash12>/aicc-helper`; `<home>` from the probe report, matching `^/[A-Za-z0-9._/-]+$` with no `..` part |
| session id, nonce | section 1; 32 lower-case hex characters, new for every exec |
| numbers | protocol version, byte offset, byte size: decimal integers in range |
| image name | `paste-<n>.<ext>` (section 6) |
| engine (R11) | `docker` or `podman` |
| container name (R11) | `^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$` |
| askpass (R11) | `SUDO_ASKPASS=<home>/.aicc/sessions/<sid>/askpass` |

A fixed script gets its values as separate arguments after the script, never
pasted into the script text. Whether every login shell runs that form, and
whether an exec sees the same `PATH` as an interactive login, is **pending
probe P6**.

| Command | Connection | Lives | From |
| --- | --- | --- | --- |
| `serve --proto 1 --nonce <n> --session <sid>` | `ssh -T`, the side channel | while connected | R6 |
| `attach --session <sid> --from <offset>` | `ssh -tt`, the terminal | while connected | R9 |
| `emit --session <sid>` | the CLI's statusline or hook command | one call | R6, R7 |
| `mcp --session <sid>` | the CLI's stdio MCP server | as long as the CLI | R8 |
| `askpass --session <sid> <prompt>` | the session's `askpass` wrapper | one call | R11 |
| `selftest`, `list`, `uninstall`, each `--nonce <n>` | one-shot exec | one call | R6 |

Each command is the helper path followed by the words shown. The
`<prompt>` of `askpass` comes from sudo on the host, not from the app, and is
not forwarded.

## 3 Processes

- **Until R9 (external terminal).** The CLI is still started by today's
  terminal path. `serve` owns the session socket while it is connected. With
  no `serve` connected, `emit` writes to the spool and exits 0; the next
  `serve` drains it. `emit` never creates a session folder.
- **From R9 (held terminal).** The first `serve` for a session starts one
  holder (`aicc-helper` in an internal `hold` role). The holder owns the CLI's
  PTY, the session socket and the `seq` counter. `serve` and `attach` become
  relays between their ssh connection and the holder. Whether the holder
  outlives logout is **pending probe P3**.
- **Lifetimes.** The holder is the only helper process that outlives a
  connection. Relays live while their ssh connection is open; `mcp` lives as
  long as the CLI; `emit`, `askpass` and one-shot commands live for one call.
  The holder exits when the session ends or, for a non-detachable session,
  when the terminal closes. Nothing runs between sessions.
- **The newest connection wins.** When a `serve` or `attach` starts for a
  session that already has one, the new one takes the socket or the holder's
  slot; the older one is sent `error` `replaced` and exits. This is the normal
  case after a silent link drop. A second app instance on the same session
  takes it over the same way; the first shows "taken over" and does not
  reconnect by itself.

## 4 Framing

**Marked lines.** The app reads only lines of these forms from an exec, where
`<nonce>` is the one on that exec's command line:

```
AICC-HASH <nonce> <hex or none>   (before serve, section 11)
AICC-HELLO <nonce> <json>         (serve)
AICC-RESULT <nonce> <json>        (every one-shot exec)
```

Everything before them (login banners, rc-file output) is discarded, up to
64 KiB; past that the exec fails with `no-hello`. A hello line is at most
4 KiB, a result line at most 1 MiB. A one-shot exec's exit code is recorded
too; a zero exit with no result line is a failure.

**Frames.** After the hello line, both directions carry frames:

| Bytes | Field |
| --- | --- |
| 4 | length of the rest of the frame, unsigned, big-endian |
| 1 | kind: 0 = JSON control message, 1 = raw bytes |
| 4 | channel id, unsigned, big-endian (0 = control) |
| rest | payload |

**Why length-prefixed.** Uploads and, later, terminal bytes are binary.
Newline-delimited JSON would need base64 and a reader that buffers until a
newline. With a length prefix the reader refuses an oversize frame before it
allocates. The kind and channel fields let terminal bytes move onto the side
channel later without a new protocol.

**Size limits (hard).**

| Direction | Kind 0 (JSON) | Kind 1 (raw) |
| --- | --- | --- |
| helper to app | 1 MiB | 64 KiB |
| app to helper | 16 MiB (a Conductor tool result can carry a screenshot) | 64 KiB |

JSON nesting is limited to depth 32. `selftest` checks that the exec channel
is binary clean when the device is provisioned.

## 5 Handshake and versions

The hello JSON carries `proto` (the versions the helper speaks, for example
`[1]`), `helper` (version and the `sha256` of its own binary, information
only), `os`, `arch`, `caps` (capability names beyond the frozen core) and
`session` (`sid` and a state: `new`; `live`, a holder or CLI is running;
`stale`, the folder exists but nothing runs, for example after a reboot). The
app ignores hello fields it does not know, so a newer helper can add some.

The app answers `hello.ack` `{proto, caps}`: the version it chose and the
capabilities it will use.

**On a mismatch.** No common version: `error` `proto-mismatch`, close, mark the
device as needing an update, re-provision and try once more. An older helper
with a common version: no new session starts on it until it is re-provisioned.
A newer helper: the app uses the highest common version and the capabilities
it knows.

**The frozen core** never changes within version 1: the hello line with its
`proto`, `helper` and `session` fields; the `serve` and `attach` command lines;
and the messages `hello.ack`, `probe`, `session.list`, `session.attach`,
`session.end`, `ping`, `pong`, `error`. The `list` and `uninstall` command lines and their
result lines never change in any version. So a session under a supported
helper (the current or previous version) can be found, attached and ended,
and the sessions of any older helper can still be listed and removed.

**Version 1 capabilities:** `status`, `hooks`, `files`, `mcp`, `held`, `sudo`
(see the table in section 6).

**Rules for change.** New messages or fields are added only behind a new
capability name. Changing or removing a message, or the frame layout, makes
version 2. The app speaks the current and the previous version. Helpers sit
side by side by version; an old helper folder is removed only when `list`
shows no live session using it.

## 6 Messages

Every control message is a JSON object with a type `t`. Requests carry an
`id`; a reply carries `re`. Events carry a `seq` instead (section 7).

| Type | Sent by | Reply | Purpose | Cap | Step |
| --- | --- | --- | --- | --- | --- |
| `hello.ack` | app | none | chosen version and capabilities | core | R6 |
| `ping` / `pong` | either | `pong` | heartbeat | core | R6 |
| `error` | either | none | a failure with a code | core | R6 |
| `probe` | app | `probe.report` | what the host has | core | R6 |
| `session.attach` | app | `session.attached` | resume after a reconnect | core | R6 |
| `session.end` | app | `session.ended` | stop the session, remove its folder | core | R6 |
| `session.list` | app | `session.list.result` | sessions on this device | core | R6 |
| `status` | helper | event | one statusline update | `status` | R6 |
| `session.prepare` | app | `session.prepared` | write the session's files | `hooks` | R7 |
| `event` | helper | event | one hook event | `hooks` | R7 |
| `file.put` | app | `file.stored` | upload one file | `files` | R7 |
| `mcp.open`, `mcp`, `mcp.close` | helper (`mcp`: either) | none | MCP streams | `mcp` | R8 |
| `session.start` | app | `session.started` | start the CLI under the holder | `held` | R9 |
| `session.detach` | app | `session.detached` | close relays, keep the session | `held` | R9 |
| `session.exit` | helper | event | the CLI exited | `held` | R9 |
| `sudo.ask` | helper | `sudo.answer` or `sudo.decline` | sudo needs a password | `sudo` | R11 |

**What the helper may run.** The helper never sends a request the app has to
obey. It starts only the `argv` of its own session's spec, and only on
`session.start`; there is no general exec or file-read request. `argv[0]` must
be a CLI path from the device's probe report or, for a plain terminal, the
login shell from that report; `cwd` must be absolute; `env` names come from a
fixed list the provider declares.

**Fields.**

- `probe.report`: OS, kernel, architecture, login shell, home folder, the hash
  tool, each CLI found (name, absolute path, version), container engines, sudo
  mode, self-test result. R3's bootstrap script prints the same document as a
  result line, so the app has one validator for both.
- `status` `{seq, payload}`: the provider's statusline JSON exactly as the CLI
  gave it to `emit`, at most 64 KiB, read by the provider's own parser.
- `event` `{seq, kind, payload}`: `kind` from the provider's hook names,
  `payload` the hook JSON, at most 64 KiB.
- `session.prepare` `{id, files, edits, env, argv, cwd, mode}`: `files` are
  written only inside the session folder, by name from a set the provider
  declares; `edits` are named edits the helper knows (for example the CLI's
  folder-trust entry), never a path and content from the app; `mode` is
  `external` or `held`. `session.prepared` `{re, results}` has one result per
  file and edit, with a code and text on failure.
- `file.put` `{id, name, size, sha256}`, then `size` bytes as kind 1 frames on
  a channel id equal to the request id. `name` matches `paste-<n>.<ext>`, `<n>`
  decimal, `<ext>` from a fixed image list. The file goes only to the
  session's `paste/` folder: at most 20 MiB each and 100 MiB per session.
  `file.stored` `{re, path, sha256}`; the app checks that `path` is exactly the
  expected folder plus `name` and that the hash matches. Whether the CLI turns
  a pasted path into an attachment is **pending probe P4**.
- `mcp.open` `{stream}` when the CLI starts `mcp`; `mcp` `{stream, message}`
  with one JSON-RPC message; `mcp.close` `{stream}`. The app hands each message
  to the Conductor MCP server as the session the side channel belongs to. A
  message never names a session.
- `session.start` `{id, cols, rows}`; `session.started` `{re, pid}`. Resize
  then travels as the ssh window change on the terminal connection. A plain
  terminal or partner shell (R10) is a session whose `argv` is the login shell,
  prepared and started the same way.
- `session.attach` `{id, since_seq}`; `session.attached` `{re, ring_start,
  ring_end}` (from R9; section 9). `session.detached` and `session.ended` are
  `{re}`. `session.list.result` `{re, sessions}`, at most 256 entries of
  `{sid, state, helper, mode, started}`.
- `session.exit` `{seq, code, signal}`. `session.end` stops the process tree
  (TERM, then KILL after 5 s) and removes the session folder.
- `sudo.ask` `{id, layer}`, `layer` naming the configured container target;
  `sudo.answer` `{re, secret}`; `sudo.decline` `{re}`.
- `error` `{re?, code, text}`, `text` plain, at most 512 characters.

**Error codes.**

| Code | Meaning | Closes |
| --- | --- | --- |
| `bad-frame` | length over the limit or under 5, unknown kind, JSON that does not parse or is too deep, raw bytes on a channel with no open transfer | yes |
| `unknown-type` | a type the negotiated version and capabilities do not allow | yes |
| `proto-mismatch`, `no-hello` | section 5; section 4 | yes |
| `hash-mismatch` | section 11 | yes |
| `replaced` | a newer connection took the session (section 3) | yes |
| `bad-field` | a field breaks its schema | no |
| `too-large` | a well-formed request breaks a size rule (file, session total) | no |
| `busy` | one is already open (`sudo.ask`), or the session is already started | no |
| `not-found`, `not-connected`, `denied`, `timeout`, `io`, `internal` | as named | no |

## 7 Ids and ordering

- Request ids are unique per connection: the app uses even numbers, the helper
  odd. Every request gets exactly one reply: its result, or `error` with `re`.
- Every event (`status`, `event`, `session.exit`) takes the next `seq` of its
  session. Until R9 the counter is the `seq` file, updated under an exclusive
  file lock by whichever process records the event; from R9 only the holder
  writes it. It survives reconnects.
- The spool keeps the last status and the last 50 other events. On
  `session.attach` the helper replays what it holds above `since_seq`, strictly
  in `seq` order, then goes live. The app drops a `seq` it has already seen.
- A gap in `seq` means events were dropped (the spool or the rate limit). The
  app logs the count and, if a hook event was lost, notes on the session that
  some activity while disconnected was not kept.
- Frames on one connection are handled in order. There is no ordering between
  the side channel and the terminal connection.

## 8 Timeouts

| What | Limit | On expiry |
| --- | --- | --- |
| hello | 20 s, timed from ssh start but paused while an askpass prompt (password, one-time code, host key) is open | `no-hello`, closed |
| a one-shot exec | 60 s, paused the same way | ssh is stopped, the exec failed |
| a reply to a request | 10 s, unless listed below | `timeout` |
| `probe`, `session.prepare`, `session.start`, `session.end` | 30 s | `timeout` |
| `file.put` | 30 s between chunks; the reply 10 s after the last | `timeout`, partial file removed |
| heartbeat | app sends `ping` every 15 s | no `pong` in 45 s: link dropped |
| helper with no frame from the app | 60 s | the relay exits; the holder stays |
| an MCP tool call | the tool's own limit, at most 10 min | `timeout` to the CLI |
| `sudo.ask` waiting for the user | 120 s | askpass fails; sudo reports it |

## 9 A dropped connection

- The holder (from R9) keeps the CLI running. Until R9 the CLI's terminal is
  the old path and is not affected by the side channel dropping.
- With no `serve` connected: `emit` spools and exits 0; an MCP call gets
  `not-connected`; a `sudo.ask` fails at once.
- The app reconnects with back-off (1, 2, 4, 8, 16, then every 30 s), runs
  `serve` again and sends `session.attach` with the last `seq` it saw.
- **Terminal reattach (R9).** The holder keeps a 2 MiB output ring per
  session. `session.attached` gives the byte offsets it still holds. The app
  clears the terminal view and runs `attach --from <ring_start>`. `attach`
  first writes a terminal reset, which clears any rc-file output from view,
  then replays the ring at the recorded size and goes live; the resize after
  that makes the CLI redraw. If the ring no longer reaches the session's
  start, the app notes that older output was not kept.
- A hello with state `stale` (for example after a reboot): the app ends the
  session and offers the CLI's own resume by conversation id.

## 10 Strict validation on the app side

The host is untrusted input. The app:

- reads the length first and refuses an oversize frame before reading it;
- checks every control message against a strict schema per type: unknown
  types and fields are refused (hello fields excepted, section 5), strings
  are bounded, numbers are finite integers in range, ids and names come from
  small alphabets;
- never uses a path from the host to open, write or run anything on the local
  machine; a returned path is only compared with the expected one and pasted;
- shows host text (error text, CLI versions, prompts) as plain text, with
  control characters removed;
- limits the rate of `status` and `event` per session (the excess is dropped
  and counted);
- logs types, sizes and codes, never `sudo.answer`, file bytes, MCP payloads
  or statusline payloads.

The helper applies the same limits to what the app sends.

## 11 Hash check, self-test and one-shot execs

- **Hash check.** The side-channel line is one fixed script with the helper
  path, nonce, protocol and session id as arguments. It hashes the helper,
  prints `AICC-HASH`, then execs `serve`. The app compares the hash with the
  manifest inside the app before it sends `hello.ack`. On a mismatch, or
  `none`, it sends `hash-mismatch`, starts nothing and offers
  re-provisioning. The check runs on every side-channel start, reconnects
  included, at no extra connection.
- **Hash tool.** The first found of `sha256sum`, `shasum -a 256` and
  `openssl dgst -sha256`. From R3 the probe records it and only that tool is
  used.
- **Self-test.** After every upload, `selftest` creates a session folder and
  socket in a scratch folder under `~/.aicc`, opens a PTY, echoes a binary
  block through the exec channel and removes what it made.
- **Connections.** A session uses two: the side channel and the terminal.
  One-shot execs run for provisioning, Remove device and, at R2, each upload
  and session end.
- **R2 upload by exec.** Before the helper exists the app runs
  `/bin/sh -c '<upload script>' aicc <sid> <name> <size> <nonce>` with the
  image on stdin, after checking the 20 MiB limit. The script sets umask 077,
  creates the session's `paste/` folder (refusing a link or another owner),
  reads at most `<size>` bytes into a new temporary file there, refuses a
  short read, hashes it, renames it to `<name>` without replacing a file, and
  prints `AICC-RESULT` with `path`, `sha256` and `tool`. The app checks path
  and hash as for `file.put`. Until R7 moves uploads onto the side channel,
  each upload is one ssh connection.
- **R2 session end.** `/bin/sh -c '<end script>' aicc <sid> <nonce>` removes
  that session's folder (refusing an empty id) and any session folder with no
  socket that has not changed for 7 days, so a crash leaves nothing for long.
  From R6 the clean-up rule in the threat model (3.9) replaces this.

## 12 Containers (R11)

- **Placing the helper.** A one-shot exec on the host runs `<engine> exec -i
  <name>` with a fixed install script and the binary on stdin. The copy goes
  to the container user's `~/.aicc/helper/`, with the same hash check and
  self-test through the engine.
- **Side channel.** `<engine> exec -i <name>` wraps the side-channel line,
  with `sudo -A` in front when the engine needs sudo.
- **sudo.** When the engine needs sudo, the app first starts a host-side
  `serve` for the session. It owns the host session folder, its socket and
  the `askpass` wrapper: a 0700 `/bin/sh` file that execs `<helper path>
  askpass --session <sid> "$1"`. `SUDO_ASKPASS` names that wrapper, so every
  sudo question, including the one asked before the container's own `serve`
  exists, reaches the app through the host-side `serve`. Such a session has
  three connections.
- **A recreated container** has no helper: its hash line says `none` and the
  app places the helper again. The device's consent screen lists its container
  targets and says copies are placed again when needed.
- **Removal.** Remove device also removes the copy in every configured
  container that is running. A stopped one is listed in the device report as
  possibly holding a copy.
- **Pending probe P5:** sudo answered by an askpass program from an exec
  without a terminal, and whether a container has `/bin/sh` and a writable home
  for its user.
