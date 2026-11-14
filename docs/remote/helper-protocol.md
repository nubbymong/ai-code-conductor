# Remote helper protocol, version 1

The messages between the app and the helper on a remote device, and the ssh
commands that carry them. The decision and step plan are in
`architecture/decisions/2026-11-14-adr-029-remote-sessions-run-through-a-device-helper.md`;
the threats are in `docs/remote/helper-threat-model.md`.

This spec covers what steps R2 to R11 need. Anything a probe must confirm is
marked **pending probe Pn** (probes are listed in the ADR). The shared message
fixtures (R5) fix exact field types and lengths, and hold one refusal fixture
per error code and per command-line pattern.

## 1 Names and places

- **Device id (`did`).** 32 lower-case hex characters, random, made by the app
  install once per target (a host, or a container on it). R2 makes it for a
  saved SSH config at its first upload; R3 keeps it as the device id. Two app
  installs, or two devices sharing one home folder, never share a `did`.
- **Layout.** Everything lives under `~/.aicc/<did>/`; `~/.aicc` holds nothing
  else. In it: `owner`, a marker with the `did` and the app install id, written
  by the first script that makes the folder; `helper/<version>-<hash12>/aicc-helper`
  (`<hash12>` is the first 12 hex characters of its SHA-256; never on `PATH`);
  `sessions/<sid>/` (0700: the session spec, the provider's files, the socket
  `s`, the `seq` counter, a bounded spool, the helper log, the `askpass`
  wrapper from R11, and `paste/`); and `edits`, the old value of each named
  edit (section 8). No step writes, runs or deletes inside a `did` folder whose
  marker does not hold this install's ids.
- **Session id (`sid`)**, chosen by the app: `^[A-Za-z0-9][A-Za-z0-9_-]{7,31}$`.
  Every socket bind and connect happens after a `chdir` into the session
  folder, by the name `s`, so a long home never meets the path limit.

## 2 The local ssh command

The app runs one ssh program by absolute path, resolved once at start: on
Windows the system OpenSSH unless the user picks another in Settings,
elsewhere the first `ssh` on the app's `PATH` (**pending probe P2** on Windows).

**Fixed options.** Every ssh the app starts carries this set; options on the
command line win over the user's ssh config for these keys. The side channel
and one-shot execs carry it from the step that adds them (R2); the terminal
from R10, when its launch moves to exec.

| Options | Why |
| --- | --- |
| `-a -x`, `ForwardAgent=no`, `ForwardX11=no` | the host never gets the local agent or display |
| `ClearAllForwardings=yes`, `Tunnel=no`, `PermitLocalCommand=no` | no forward and no local command from the user's config |
| `ControlMaster=no`, `ControlPath=none` | no shared connection carrying another connection's settings |
| `StrictHostKeyChecking=yes`, `UserKnownHostsFile=<app file>`, `GlobalKnownHostsFile=<empty app file>`, `UpdateHostKeys=no`, `VerifyHostKeyDNS=no` | only the app's pin counts, and the host cannot change it |
| `NumberOfPasswordPrompts=1`, `BatchMode=no` | one password try; BatchMode would turn askpass off |
| `-T` (side channel, one-shot) or `-tt` (terminal); `-p <port> -l <user> -- <target>` | nothing after `--` is an option |

The user matches `^[A-Za-z0-9_][A-Za-z0-9._@-]{0,63}$`, the target (name,
address or config alias) `^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$`, the port 1 to
65535. A value that breaks its pattern stops before ssh starts.

**Host keys.** The first connection to a target with no pin uses
`StrictHostKeyChecking=ask`: ssh's question, with the fingerprint, goes to the
user through askpass and is never answered by the app, and no saved secret is
released on that connection. A yes writes the key to the app's file; later
connections are strict. This happens at the first step that connects: R2's
first upload, or R3's probe for a device made from a saved config. A changed
key stops every connection to the device until the user checks it again.

**Jump hosts.** Command-line options do not reach jump hosts from the user's
config. When `ssh -G` shows a `ProxyJump`, the app replaces it with its own
`ProxyCommand` that runs the same ssh with the same fixed set and `-W %h:%p`,
hop by hop, so every hop is pinned in the app's file. A `ProxyCommand` from the
user's config is kept and the device is marked "jump host not pinned by the
app". The user's config still supplies everything else (identity files, real
host name, port, user, ciphers). A CI sshd job checks with `ssh -G` and a
hostile config (agent forwarding, a remote forward, a local command,
`ControlMaster auto`) that the effective values are the fixed ones.

## 3 askpass

ssh asks for passwords, codes and host-key answers through the app's askpass
program: one real executable per app OS, inside the app.

- **How it is reached.** Each ssh gets `SSH_ASKPASS` (that program),
  `SSH_ASKPASS_REQUIRE=force` and `AICC_ASKPASS_TOKEN`, a random single-use
  value bound in the app to that connection and its device. The program sends
  the token and ssh's prompt over an owner-only local endpoint (a Unix socket
  in an owner-only folder, or a named pipe for the current user), prints the
  answer and exits. No secret is on a command line or in the environment.
  Programs the user's own config starts (a `ProxyCommand`) inherit the token.
- **Released without the user:** a saved password, only when the prompt is
  exactly OpenSSH's password prompt for the device's configured user and
  target, the connection started pinned, the device has no jump host, nothing
  was released on this connection yet, and the password has not failed since
  the user last entered or confirmed it.
- **Always the user's:** key passphrases, confirm prompts
  (`SSH_ASKPASS_PROMPT=confirm`), host-key questions, one-time codes and any
  other text, shown as cleaned host text (section 12) labelled with the device.
- **A failed release.** If ssh ends before a hello or result after a release,
  or prints `Permission denied`, the saved password is marked failed: no
  release until the user acts, and no automatic reconnect (section 11).

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

The home folder never appears on a command line: fixed scripts build paths
from `$HOME`. Script text holds no single quote, backslash or newline, so POSIX
shells, csh, tcsh and fish pass it to `/bin/sh` unchanged (**pending probe P6**
for the last three). Values come as arguments after the script, never inside.

| Command, through the launcher (section 13) | Connection | From |
| --- | --- | --- |
| `serve --proto 1 --nonce <n> --session <sid>` | `ssh -T`, the side channel, while connected | R6 |
| `attach --session <sid> --from <offset>` | `ssh -tt`, the terminal, while connected | R9 |
| `selftest`, `list`, `end --session <sid>`, each `--nonce <n>` | one-shot exec | R6 |

`emit` (the CLI's statusline and hook command, R6 and R7), `mcp` (the CLI's
stdio MCP server, R8) and `askpass` (the sudo wrapper, R11), each with
`--session <sid>`, are started on the host by the CLI or sudo, at paths the
helper writes itself. The prompt sudo passes to `askpass` is not forwarded.

## 5 Processes

- Until R9 the CLI is started by the old terminal path and `serve` owns the
  socket while connected; with none, `emit` spools and exits 0 (it never
  creates a session folder). From R9 the first `serve` starts one holder (an
  internal `hold` role) that owns the CLI's PTY, the socket and `seq`; `serve`
  and `attach` relay to it. Outliving logout is **pending probe P3**.
- Only the holder outlives a connection; `mcp` lives as long as the CLI, the
  rest for one call. The holder exits when the session ends, a non-detachable
  terminal closes, or a detached session reaches its maximum lifetime (threat
  model 3.9). The newest `serve` or `attach` takes the socket or slot; the
  older gets `error` `replaced` and exits (another app instance shows "taken
  over").

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
allocates; the kind and channel let terminal bytes move here later. Hard
limits: JSON 1 MiB helper to app and 16 MiB app to helper (a tool result can
carry a screenshot); raw 64 KiB both ways; JSON depth 32. `selftest` checks the
exec channel is binary clean.

## 7 Handshake and versions

The hello carries `proto` (versions spoken, e.g. `[1]`), `helper` (version and
`sha256`, information only), `os`, `arch`, `caps`, and `session`: its `sid`
and a state. States: `new`; `live`; `stale` (folder exists, nothing runs, and
the host's boot id matches the spec's); `elsewhere` (the spec was written on
another machine sharing this home). A hello whose `sid` differs from the
command line's, or that breaks its schema, fails as `no-hello`. Unknown hello
fields are ignored. The app answers `hello.ack` `{proto, caps}`.

**Mismatch.** No common version: `proto-mismatch`, close, the device waits for
the user (never a re-provision on a host's version list). An older helper gets
no new session until re-provisioned; a newer one, the highest common version.

**Frozen core** (never changes within version 1): the hello with `proto`,
`helper` and `session`; the hash line; the `serve` and `attach` command lines;
`hello.ack`, `probe`, `session.list`, `session.attach`, `session.end`, `ping`,
`pong`, `error`. The `list` and `end` command lines, their result lines and
the removal script never change in any version.

**Rules for change.** New messages or fields only behind a new capability.
Changing or removing a message, or the frame layout, makes version 2. The app
speaks the current and previous version. The manifest holds the hash of every
released helper: the bundled one runs everything, the previous one may also
`attach`, older ones only `list` and `end`. An old helper folder is removed
only when `list` shows no live session on it.

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
It starts only its own session spec's `argv`, only on `session.start`; there is
no general exec or file-read request. `argv[0]` is a CLI path from the probe
report or, for a plain terminal or partner shell, the login shell; `cwd` is
absolute; `env` names come from the provider's fixed list, and the schema
refuses any name holding `KEY`, `TOKEN`, `SECRET`, `PASS` or `AUTH`. `files` are
written only inside the session folder, by names the provider declares;
`edits` name rows of the closed table below; `mode` is `external` or `held`.

- `probe.report`: OS, kernel, architecture, userland bitness and ARM version,
  login shell, home folder and its filesystem type, the hash tool's absolute
  path, each CLI (name, absolute path, version), container engines, sudo mode,
  self-test result. R3's bootstrap prints the same document, one validator.
- `file.put` `{id, name, size, sha256}`, then `size` bytes as kind 1 frames on
  channel = request id. `name` is `paste-<n>.<ext>`, `<ext>` from a fixed image
  list; only into `paste/`, 20 MiB each, 100 MiB per session. The app checks
  `file.stored` `{re, path, sha256}`: `path` exactly the expected folder plus
  `name`, and the hash. Attachment by pasted path is **pending probe P4**.
- `mcp`: the app hands each message to the Conductor MCP server as the session
  the side channel belongs to, limited to the remote allow-list (threat model
  3.5). `layer` in `sudo.ask` names the configured container target.

**Payload allow-lists.** `status` and `event` payloads (at most 64 KiB) are not
opaque. Each provider declares the fields it keeps per kind, typed as number,
label (at most 128 characters, cleaned as in section 12) or remote path; the
decoder drops all else before other code sees it. A remote path is a display
string of its own type: never opened, never given to transcript discovery,
resume or usage filing, never stored where the app expects a local path. Usage
figures show under the account the device record names, never one a payload
picks. Version 1, Claude Code (exact names fixed by the R5 fixtures):

- `status`: model id and name; context used, size and percentage; cost and
  duration totals; CLI version; the CLI's session id (`^[A-Za-z0-9-]{1,64}$`);
  remote paths `cwd`, `transcript_path` and the workspace folders.
- `event`: hook name, the CLI's session id, notification text (a label of at
  most 1,024 characters), tool name. Prompts, tool inputs and results dropped.

**Named edits (closed list).** One row: `claude-folder-trust` sets
`projects["<cwd>"].hasTrustDialogAccepted` to `true` in `~/.claude.json` for the
session's `cwd`. The helper opens that file only for this edit and parses it
only to change that key; it never logs, keeps or sends any other field. It
writes a new file beside it with the same mode, renames it over the old one,
and stops with `io` if the file changed between read and rename. Other fields
keep value and order (a golden-file test with fake account and key fields
proves it). The old value goes to `edits` for Remove device. File and key are
confirmed by probe P4; if the CLI has a supported flag for this, R7 uses it and
the list is empty. A new row needs its own adversarial pass.

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
exactly one reply, its result or `error` with `re`. Each event takes its
session's next `seq` (until R9 from the `seq` file under an exclusive lock,
then from the holder), which survives reconnects. The spool keeps the last
status and 50 other events; `session.attach` replays those above `since_seq` in
order, and the app drops a `seq` it has seen. A gap is logged with its count
and, if a hook event was lost, noted on the session. Frames on one connection
are handled in order; side channel and terminal are not ordered.

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
  only after a link drop (no `pong` in 45 s, or ssh
  ending after a hello): back-off 1, 2, 4, 8, 16 s, at most 5 tries, and 5 more
  when the app machine wakes or its network returns; then it waits for the
  user. Never after an authentication failure, a host-key question or change,
  `hash-mismatch`, `proto-mismatch`, `replaced`, `bad-frame`, `unknown-type` or
  a budget close. A device that asks for a one-time code never reconnects by
  itself. A reconnect is never a launch the user started (threat model 3.7).
- **Terminal reattach (R9).** The holder keeps a 2 MiB output ring. The app
  clears the view and runs `attach --from <ring_start>`, which writes a
  terminal reset, replays at the recorded size and goes live; the resize after
  makes the CLI redraw. If the ring no longer reaches the start, the app says so.
- `stale`: the app ends the session only if its own record holds it, and
  offers the CLI's resume by conversation id. `elsewhere`: shown, never ended
  by the app on its own (threat model 3.9).

## 12 Strict validation and budgets

The host is untrusted input. The app decodes side-channel frames off its main
thread; refuses an oversize length before reading; checks every control
message against a strict schema per type (unknown types and fields refused,
hello fields excepted; bounded strings; finite integers in range; ids from
small alphabets); never uses a host path to open, write or run anything
locally, nor stores one where it later expects a local path (a returned upload
path is only compared and pasted); shows host text (errors, CLI versions,
prompts, notifications, payload labels) as plain text with control (Cc) and
format (Cf) characters removed, bidi and zero-width ones included, capped in
length, in the window and in OS notifications alike; and logs types, sizes and
codes only, never `sudo.answer`, file bytes, MCP or statusline payloads, with
log lines deduplicated and capped at 100 a minute per connection.

**Budgets per connection** (the helper applies the same to the app):

| What | Limit | On breach |
| --- | --- | --- |
| messages, helper to app | 200 a second, bursts of 400 | dropped and counted; close after 10 s over |
| `status`, `event` | 10 a second per session | dropped and counted |
| bytes, helper to app | 8 MiB a second | close |
| MCP streams; MCP calls in flight | 4; 8 | `busy` |
| `bad-field`, `denied`, `too-large`, `busy` replies | 20 in 60 s | close, no automatic reconnect |
| ssh stderr, stdout after a result line | 64 KiB kept | the rest discarded and counted |

## 13 Fixed scripts

**Folder checks first.** Before any write or exec, every fixed script checks
that `$HOME` is an absolute path to a real folder (not a link), owned by the
user, not `/`, and not writable by others (by its group only when that is the
user's private group); that `~/.aicc`, `~/.aicc/<did>` and each folder below it
that it uses are real folders owned by the user, which it then sets to 0700
itself (never trusting `mkdir -m` on an existing folder); and that the marker
holds this install's ids. On a failure it prints a refusal as `AICC-RESULT`.
The check runs in the script, outside the binary it guards.

- **Launcher.** Starts every helper command the app runs. Arguments: `did`,
  helper folder, expected hash, nonce, the command's words. It hashes the
  binary with the probe's hash tool by absolute path (the first of
  `sha256sum`, `shasum -a 256`, `openssl dgst -sha256`; with none, the device
  runs at the floor), prints `AICC-HASH <nonce> <state> <hex>` (`ok`,
  `mismatch`, `missing`, `no-tool`, `tool-failed`) and execs only on `ok`. The
  app compares the hex with its manifest again before `hello.ack`. It runs on
  every start, reconnects included, at no extra connection.
- **What the hash check shows:** corruption, a partial upload, a wrong file,
  or a change by another user that got past the folder modes. Nothing against
  root or the same user, who can answer it falsely (threat model, section 2);
  only folder modes close the window between hash and exec. `emit`, `mcp` and
  `askpass` are started by the CLI or sudo, already as the user, unchecked.
- **Install** (R6 and re-provision). Arguments: `did`, helper folder, size,
  expected hash, nonce; the binary on stdin. Umask 077. It writes the marker if
  the `did` folder is new, makes `helper/.new-<nonce>` with a plain `mkdir`
  (fails if it exists), reads exactly `<size>` bytes there (`head -c`, then a
  size check), hashes, sets 0700, and renames the folder to the helper folder
  only if that name does not exist; one with a wrong hash is removed first.
  Nothing is overwritten in place, so a signed macOS binary is always new.
- **Self-test** after every install: `selftest-<nonce>/` with a session folder,
  socket, PTY and a binary echo, then removed (the next install sweeps leftovers).
- **`list`, `end`, removal.** `list` covers this `did` only; `end` stops one
  session's process tree and removes its folder. The removal script (Remove
  device, also at the floor or before any helper) deletes `~/.aicc/<did>` when
  its marker matches, then `~/.aicc` only if empty. It needs no helper.
- **R2 upload.** `/bin/sh -c '<upload script>' aicc <did> <sid> <name> <size>
  <nonce>`, image on stdin, after the app checks 20 MiB. With the folder checks
  from `$HOME` down to `paste/`, it refuses when `paste/` holds 100 MiB, reads
  exactly `<size>` bytes into a temporary file, hashes it, links it to `<name>`
  with a plain `ln` (fails if the name exists), removes the temporary name, and
  prints `AICC-RESULT` with `path`, `sha256`, `tool`. Until R7 each upload is
  one ssh connection.
- **R2 session end** (`aicc <did> <sid> <nonce>`) removes that session's folder
  and any paste file under this `did` modified over 7 days ago; never another
  `did`. From R6 the clean-up rule (threat model 3.9) replaces it.

## 14 Containers (R11)

- **Placing.** Each container target has its own `did` and consent. A one-shot
  exec runs `<engine> exec -i <name>` with the install script and the binary on
  stdin, into the container user's `~/.aicc/<did>/`, with the same checks, hash
  and self-test through the engine. A recreated container (launcher says
  `missing`) is placed again at most once per target per app run, with a notice.
- **Side channel.** `<engine> exec -i <name>` wraps the launcher, with
  `sudo -A` in front when the engine needs sudo.
- **sudo.** The app first starts a host-side `serve` for the session, owning
  the host session folder, its socket and the `askpass` wrapper the helper
  writes (a 0700 `/bin/sh` file that execs the helper's `askpass` with sudo's
  prompt). The fixed script sets `SUDO_ASKPASS` to it inside `/bin/sh`, so every
  sudo question, including one asked before the container's `serve` exists,
  reaches the app through the host-side `serve`. Three connections in all.
- **Removal** runs the removal script in every configured running container; a
  stopped one is listed as possibly holding a copy. **Pending probe P5:** sudo
  by askpass with no terminal, and `/bin/sh` plus a writable home in a container.
