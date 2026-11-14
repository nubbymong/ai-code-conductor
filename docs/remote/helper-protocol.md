# Remote helper protocol, version 1

The messages between the app and the helper on a remote device. The decision
and the step plan are in
`architecture/decisions/2026-11-14-adr-029-remote-sessions-run-through-a-device-helper.md`;
the threats are in `docs/remote/helper-threat-model.md`.

This spec covers only what steps R2 to R11 need. Anything a probe must confirm
is marked **pending probe Pn** (the probes are listed in the ADR).

## 1 Names and places

- The helper binary is `aicc-helper`. On the host it lives at
  `~/.aicc/helper/<version>-<hash12>/aicc-helper`, where `<hash12>` is the
  first 12 hex characters of its SHA-256. It is never on `PATH`.
- Each session has a folder `~/.aicc/sessions/<sid>/` (mode 0700). It holds the
  session spec, the files the provider needs, the local socket, a bounded
  spool, the helper log and a `paste/` folder.
- A session id (`sid`) is chosen by the app: 8 to 64 characters from
  `[A-Za-z0-9_-]`.
- Inside a container (R11) the same layout sits under the container user's
  home.

## 2 How the helper is started

The helper is always started by exec over ssh, as the remote command. Nothing
is typed into a shell. Every command line is fixed text, plus the helper's
absolute path (learned by the probe and checked against a strict pattern),
plus the session id. All other data travels as JSON inside messages, never on
a command line.

| Command | Connection | Used from |
| --- | --- | --- |
| `aicc-helper selftest` | one-shot exec | R6 (provisioning) |
| `aicc-helper serve --proto 1 --nonce <hex32> --session <sid>` | `ssh -T`, the side channel | R6 |
| `aicc-helper attach --session <sid> --from <offset>` | `ssh -tt`, the terminal | R9, R10 |
| `aicc-helper emit --session <sid>` | run by the CLI as its statusline or hook command | R6, R7 |
| `aicc-helper mcp --session <sid>` | run by the CLI as a stdio MCP server | R8 |
| `aicc-helper askpass --session <sid>` | run by sudo as `SUDO_ASKPASS` | R11 |
| `aicc-helper list` | one-shot exec, prints one JSON document | R9 |
| `aicc-helper uninstall` | one-shot exec | R6 (Remove device) |

For a container target the same command is wrapped as
`<engine> exec -i <name> <path> ...` (R11).

`emit`, `mcp` and `askpass` are short-lived. They connect to the session's
local socket and hand their payload to the process that owns it.

Whether an exec sees the same `PATH` and environment as an interactive login
is **pending probe P6**.

## 3 Processes

- **Until R9 (external terminal).** The CLI is still started by today's
  terminal path. `serve` owns the session socket while it is connected. When
  no `serve` is connected, `emit` writes to the spool and exits 0, and the
  next `serve` drains the spool.
- **From R9 (held terminal).** The first `serve` for a session starts one
  holder process for it (`aicc-helper` with an internal `hold` role, never
  started by the app directly). The holder owns the CLI's PTY and the session
  socket. `serve` and `attach` become relays between their ssh connection and
  the holder. When a connection drops, its relay exits; the holder stays.
  Whether the holder outlives logout is **pending probe P3**.
- The holder exits when the session ends, or, for a session marked
  non-detachable, when the terminal closes. There is never more than one
  long-lived helper process per session, and none between sessions.

## 4 Framing

**The hello line.** The first output of `serve` that the app accepts is one
text line:

```
AICC-HELLO <nonce> <json>
```

The app discards everything before it (login banners, rc-file output), up to
64 KiB; past that the connection fails with `no-hello`. The nonce is the one the app put on the command line, so stray
output cannot be mistaken for a hello. The line ends with `\n` and is at most
4 KiB.

**Frames.** After the hello line, both directions carry frames:

| Bytes | Field |
| --- | --- |
| 4 | length of the rest of the frame, unsigned, big-endian |
| 1 | kind: 0 = JSON control message, 1 = raw bytes |
| 4 | channel id, unsigned, big-endian (0 = control) |
| rest | payload |

**Why length-prefixed, not newline-delimited JSON.** File uploads and, later,
terminal bytes are binary. Newline-delimited JSON would need base64, about a
third larger, and a reader that buffers until it finds a newline, with no way
to refuse an oversize message before reading it. With a length prefix the
reader checks the length first and refuses before it allocates. The kind and
channel fields let terminal bytes move onto the side channel later without a
new protocol.

**Size limits (hard).**

| Direction | Kind 0 (JSON) | Kind 1 (raw) |
| --- | --- | --- |
| helper to app | 1 MiB | 64 KiB |
| app to helper | 16 MiB (a Conductor tool result can carry a screenshot) | 64 KiB |

A length above the limit, a kind other than 0 or 1, or a JSON payload that
does not parse ends the connection with `error` code `bad-frame`. There is no
resynchronisation after a bad frame. JSON nesting is limited to depth 32.

Whether the exec channel is binary clean on every host role is checked by
`selftest` when the device is provisioned.

## 5 Handshake and versions

The hello JSON carries:

- `proto`: the protocol versions the helper speaks, for example `[1]`.
- `helper`: the helper version (semver) and `sha256` of its own binary
  (information only; the app's check is in section 11).
- `os`, `arch`, and `caps`: the capability names this helper supports beyond
  the frozen core.
- `session`: the session id, and whether the session already exists
  (`new` or `existing`).

The app answers with `hello.ack` `{proto, caps}`: the version it chose and the
capabilities it will use. Then normal messages flow.

**On a mismatch:**

- No common protocol version: the app sends `error` `proto-mismatch`, closes,
  marks the device as needing an update, re-provisions its bundled helper and
  tries once more.
- A common version but an older helper: a new session is never started on it;
  the app re-provisions first. An existing session started under the older
  helper is still listed, attached and ended through the frozen core.
- A newer helper than the app knows: the app uses the highest common version
  and the capabilities it knows.

**The frozen core** never changes within version 1: `hello.ack`,
`session.list`, `session.attach`, `session.end`, `ping`, `pong`, `error`. A
session left under an older helper can always be found, attached and ended.

**Rules for change.** New messages or fields are added only behind a new
capability name announced in the hello. Changing or removing a message, or
changing the frame layout, makes version 2. The app speaks the current and the
previous version. Helpers are installed side by side by version, and an old
helper folder is removed only when `list` shows no live session using it.

## 6 Messages

Every control message is a JSON object with a type `t`. Requests carry an
`id`; a reply carries `re` with the request's id. Messages marked "event" have
neither and carry a `seq` instead (section 7).

| Type | Sent by | Reply | Purpose | Step |
| --- | --- | --- | --- | --- |
| `hello.ack` | app | none | chosen version and capabilities | R6 |
| `ping` / `pong` | either / the other | `pong` | heartbeat | R6 |
| `error` | either | none | a failure with a reason code | R6 |
| `probe` | app | `probe.report` | what the host has | R6 |
| `status` | helper | event | one statusline update | R6 |
| `session.prepare` | app | `session.prepared` | write the session's files | R7 |
| `event` | helper | event | one hook event | R7 |
| `file.put` | app | `file.stored` | upload one file | R7 |
| `mcp.open` / `mcp.close` | helper | none | an MCP stream starts or ends | R8 |
| `mcp` | either | none | one MCP message on a stream | R8 |
| `session.start` | app | `session.started` | start the CLI under the holder | R9 |
| `session.attach` | app | `session.attached` | resume after a reconnect | R6 |
| `session.detach` | app | `session.detached` | close relays, keep the session | R9 |
| `session.exit` | helper | event | the CLI exited | R9 |
| `session.end` | app | `session.ended` | stop the session, remove its folder | R6 |
| `session.list` | app | `session.list.result` | sessions on this device | R9 |
| `sudo.ask` | helper | `sudo.answer` or `sudo.decline` | sudo needs a password | R11 |

The helper never sends a request the app has to obey. The app never sends a
message that runs an arbitrary command or reads an arbitrary file: there is
no such message.

**`probe.report`.** OS, kernel, architecture, login shell, home folder, each
CLI found (name, absolute path, version), container engines, sudo mode, and
the self-test result. R3 runs before the helper ships: its bootstrap script
prints the same JSON document over a one-shot exec, so the app has one
validator for both.

**`status`.** `{seq, payload}`, where `payload` is the provider's statusline
JSON exactly as the CLI gave it to `emit`, at most 64 KiB. The helper does not
interpret it. The app reads it with the provider's own statusline parser.

**`session.prepare`.** `{id, files, edits, env, argv, cwd, mode}`. `files` are
written only inside the session folder, by name from a fixed set the provider
declares. `edits` are named edits the helper knows (for example the CLI's
folder-trust entry), never a path and content supplied by the app. `mode` is
`external` (until R9) or `held`. The reply lists one result per file and edit,
with an error code and text when a write failed.

**`file.put`.** `{id, name, size, sha256}`, then `size` bytes as kind 1
frames on a channel id equal to the request id. `name` is chosen by the app
and must match `paste-<n>.<ext>` with `<ext>` from a fixed image list. The file
goes only to the session's `paste/` folder, at most 20 MiB each and 100 MiB per
session. The reply `file.stored` is `{re, path, sha256}`; the app checks that
`path` is exactly the expected folder plus `name`, and that the hash matches.
R2 uploads by a one-shot exec before the helper exists, with the same folder
and name rules. Whether the CLI turns the pasted path into an attachment is
**pending probe P4**.

**`mcp.open`, `mcp`, `mcp.close`.** `mcp.open` is `{stream}` when the CLI starts
`aicc-helper mcp`; `mcp` is `{stream, message}` with one JSON-RPC message; the
app hands it to the Conductor MCP server as the session the side channel
belongs to. A message never names a session: identity is the channel.

**`session.start`.** `{id, cols, rows}`. The holder starts the argv from the
prepared spec. Resize after that travels by the normal ssh window change on
the terminal connection.

**`session.attach`.** `{id, since_seq, term_offset}`. The helper replays
spooled events with a higher `seq`, then the last status, then goes live. The
reply `session.attached` says whether the holder's output ring still reaches
`term_offset` (from R9); the terminal connection then resumes from that byte
offset (`attach --from <offset>`).

**`session.exit`.** `{seq, code, signal}`. **`session.end`** stops the
process tree, removes the session folder and replies `session.ended`.

**`sudo.ask`.** `{id, layer}`, where `layer` names the configured container
target. `sudo.answer` is `{re, secret}`; `sudo.decline` is `{re}`. Only one
`sudo.ask` may be open per session. Whether sudo accepts an askpass answer
without a terminal is **pending probe P5**.

**`error`.** `{re?, code, text}`. `text` is plain text of at most 512
characters. Codes: `bad-frame`, `too-large`, `unknown-type`, `bad-field`,
`proto-mismatch`, `no-hello`, `not-found`, `busy`, `io`, `timeout`, `denied`,
`hash-mismatch`, `not-connected`, `internal`.

## 7 Ids and ordering

- Request ids are integers chosen by the sender, unique per connection. App
  requests use even numbers, helper requests odd numbers, so they never clash.
- Every request gets exactly one reply: its result, or `error` with `re`.
- Events carry `seq`, an integer that rises by one per event within a session
  and survives reconnects (the holder or the spool keeps it). The app drops an
  event whose `seq` it has already seen.
- Frames on one connection are handled in order. There is no ordering between
  the side channel and the terminal connection.

## 8 Timeouts

| What | Limit | On expiry |
| --- | --- | --- |
| hello after the exec starts | 20 s (pending probe P6 for slow logins) | `no-hello`, connection closed |
| a reply to a request | 10 s | `timeout`, request failed |
| `session.prepare` | 30 s | `timeout` |
| a gap between chunks of `file.put` | 30 s | `timeout`, partial file removed |
| heartbeat | app sends `ping` every 15 s | no `pong` in 45 s: link treated as dropped |
| helper with no frame from the app | 60 s | the relay exits; the holder stays |
| an MCP tool call | the tool's own limit, at most 10 min | `timeout` to the CLI |
| `sudo.ask` waiting for the user | 120 s | the askpass call fails; sudo reports it |

## 9 A dropped connection

- The holder (from R9) keeps the CLI running. Until R9, the CLI's terminal is
  the old path and is not affected by the side channel dropping.
- While no `serve` is connected: `emit` writes to the spool (the last status
  and the last 50 events) and exits 0; an MCP call gets `not-connected`; a
  `sudo.ask` fails at once.
- The app reconnects with back-off (1, 2, 4, 8, 16, then every 30 s), runs
  `serve` again for the same session and sends `session.attach` with the last
  `seq` it saw.
- A host reboot ends the session. The app offers the CLI's own resume by
  conversation id and says which of the two happened.

## 10 Strict validation on the app side

The host is untrusted input. The app:

- reads the length first and refuses an oversize frame before reading it;
- checks every control message against a strict schema per type: unknown
  types and unknown fields are refused, every string has a maximum length,
  numbers are finite integers in range, ids and names come from small
  alphabets;
- treats a message type that the negotiated version and capabilities do not
  allow as `unknown-type` and closes the connection;
- never uses a path from the host to open, write or run anything on the local
  machine; a returned path is only compared with the expected one and pasted;
- shows host text (error text, CLI versions, prompts) as plain text, with
  control characters removed;
- limits the rate of `status` and `event` messages per session (the excess is
  dropped and counted in the log);
- logs message types, sizes and reason codes, never `sudo.answer`, file bytes,
  MCP payloads or statusline payloads.

The helper applies the same limits to what the app sends.

## 11 Hash check and self-test

- Before every session the app runs a fixed one-shot exec that hashes the
  installed binary with the host's own tool (recorded by the R3 probe) and
  compares the result with the manifest inside the app. A mismatch means
  `hash-mismatch`: no session starts and the device offers re-provisioning.
- After every upload the app runs `aicc-helper selftest`: it creates a session
  folder and socket in a scratch location, opens a PTY, echoes a binary block
  through the exec channel and removes what it made.
