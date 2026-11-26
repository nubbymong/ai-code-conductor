# Remote helper protocol, version 1

The messages between the app and the helper on a remote device, and the ssh
commands that carry them, for steps R2 to R11. Decision and step plan:
`architecture/decisions/2026-11-14-adr-029-remote-sessions-run-through-a-device-helper.md`;
threats: `docs/remote/helper-threat-model.md`. **Pending probe Pn** marks what a
probe (ADR) must confirm. R5 fixtures fix field types, lengths and refusals.

## 1 Names and places

- **Device id (`did`).** 32 random lower-case hex characters, made by the app
  install once per target (a host, or a container on it; R2 at a saved SSH
  config's first upload), so installs and devices never share one.
- **Layout.** Everything lives under `~/.aicc/<did>/` (the node id aside,
  section 13); `~/.aicc` holds only `did` folders. In one: `owner`, a marker
  with the `did` and app install id; `helper/<version>-<hash12>/aicc-helper`
  (first 12 hex of its SHA-256; never on `PATH`); `sessions/<sid>/` (0700: spec,
  provider files, socket `s`, `seq`, a bounded spool, the helper log, `holder`
  from R9, `paste/`); `backup/`; and `edits` (section 8). Nothing is written,
  run or deleted in a `did` folder whose marker lacks this install's ids; the
  app never removes another install's folder, it only lists it (section 8).
- **Step 1 as built (2.1.3-beta.17).** Under `~/.aicc/<did>/`: `owner`,
  holding `aicc-owner 1 <did> <install id>`;
  `helper/<version>-<first 12 hex>/aicc-helper` (0700); `helper/.new-<nonce>/`
  for an upload until the app commits or discards it; and `store/` (the
  holders' records, section 15). A remote tab's session id is `rm` and 30 hex
  of a hash of its app id.
- **Session files (2.1.3-beta.18, section 3.2).** Before the hold, the fixed
  `reads` script prints, as hex, up to four host settings files the provider
  names (Claude Code: `~/.claude/settings.json`; the session folder's
  `.claude/settings.json` and `.claude/settings.local.json`; its git checkout
  root's `.claude/settings.local.json`), parsed in the app as data, never
  run. Each is a regular file of at most 256 KiB. The user's own file is read
  as Claude Code reads it, a link followed (a dotfiles link keeps its hooks);
  a project or checkout-root file only when it and every folder on its way
  are no link and the host user's own, not writable by others (by its group
  only when that is the user's own group). A checkout root is used only when
  it is not the session folder, the home folder or a folder above it. After
  the hold, the fixed `files` script writes the launch's `settings.json` (the
  host user's own `~/.claude/settings.json` keys less `mcpServers`, as the
  usual SSH setup's session file carries them, since Claude Code takes a
  top-level `effortLevel` as the session's effort from every settings source
  but the user's own (in ~/.claude/settings.json it is a legacy effort some
  models take), a `--settings` file among them; over them, the status line is the status mode and hooks are the
  host's own, then the hook mode's nine, identical entries once) and, while
  the app serves its tools, `mcp.json` (`conductor` is the relay) into
  `sessions/<sid>/` (folder 0700, files 0600), contents on standard input
  after a `<name>:<size>,...` layout value, each file staged, size-checked
  and moved over its name. Besides the host's own settings, they name the
  helper's path, the store and the session id only. `unsession` removes
  the folder once the holder's record is gone; at a Check, `sweep` removes
  any folder whose holder is gone. Such a session's app connection acks
  `status` and `hooks`, and `mcp` while the app serves its tools, beside
  `local`.
- **Session id (`sid`)**, chosen by the app: `^[A-Za-z0-9][A-Za-z0-9_-]{7,31}$`.
  Every socket bind and connect happens after a `chdir` into the session
  folder, by the name `s`, so a long home never meets the path limit.
- **Host home.** Learned once per target (R2's first upload; from R3 the
  probe): starts with `/`, at most 1,024 bytes of valid UTF-8, no control (Cc)
  or format (Cf) character. Every later path must start with exactly it; a
  different home stops the device until the user checks it again.
- **Machine and boot.** Each session spec holds a boot id (Linux
  `/proc/sys/kernel/random/boot_id`, macOS `kern.bootsessionuuid`) and a
  machine identity: the machine id (Linux `/etc/machine-id`, macOS
  `IOPlatformUUID`; empty or `uninitialized` is none), the host name (macOS
  `scutil --get LocalHostName`; Linux the kernel host name) and the node id
  (section 13), made on every host so clones made before install differ. From
  R6 it also holds the CLI's pid and start time once known (none known reads
  as live, section 13). The app keeps only an app-keyed hash. Identities are
  one machine only when every part matches; the same machine id under another
  host name flags "cloned machine id"; no machine id and no node id is unknown.

## 2 The local ssh command

The app runs one ssh by absolute path, resolved once at start (Windows: the
system OpenSSH unless the user picks another, **pending probe P2**; elsewhere
the first `ssh` on `PATH`), and reads its `ssh -V`.

**Environment.** Every ssh the app starts (terminal included, from R2) and its
askpass and `ProxyCommand` children get an environment from a fixed allow-list,
never the app's own: `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `TERM`
(terminal), `SSH_AUTH_SOCK`, `KRB5CCNAME`, fixed Windows system variables, the
askpass variables, and the device's extra variables (names the user adds for a
`ProxyCommand`, from R2; shown at consent; refused when one holds `KEY`,
`TOKEN`, `SECRET`, `PASS` or `AUTH`). Config `SendEnv` patterns add to the
command line's and cannot be cleared, so this environment is the control.

**Fixed options** (they beat the user's config): all on one-shot execs and the
side channel (R2, R6); on the terminal `-e none` from R2, the rest from R10.

| Options | Why |
| --- | --- |
| `-a -x`, `ForwardAgent=no`, `ForwardX11=no`, `ForwardX11Trusted=no`, `GSSAPIDelegateCredentials=no`, `ClearAllForwardings=yes`, `Tunnel=no`, `PermitLocalCommand=no`, `ControlMaster=no`, `ControlPath=none` | the host gets no local agent, display or Kerberos ticket; the config adds no forward, local command or shared connection |
| `-e none`, `EnableEscapeCommandline=no` (9.2+); `SetEnv=AICC_NONE=1` | no escape sequences, so pasted text cannot add a forward or end the link; ssh keeps the first `SetEnv` it is given, so no config `SetEnv` applies |
| `StrictHostKeyChecking=yes`, `UserKnownHostsFile` and `GlobalKnownHostsFile` both the per-connection file (path rules below), `UpdateHostKeys=no`, `VerifyHostKeyDNS=no`; `KnownHostsCommand=none` (8.5+) | only the app's pin counts, and the host cannot change it |
| `RemoteCommand=none`; `StdinNull=no`, `SessionType=default`, `ForkAfterAuthentication=no` (8.7+); `NumberOfPasswordPrompts=1`, `BatchMode=no` | the command and stdin are the app's; one password try (BatchMode would turn askpass off) |
| `-T` (side channel, one-shot) or `-tt` (terminal); `-p <port> -l <user> -- <target>` | nothing after `--` is an option |

A versioned key is used only from that `ssh -V` on. Before a device's first
connection per app run, `ssh -G` with the set must print every fixed value, a
`hostkeyalias` no other device has, only the dummy `setenv`, and no `sendenv`
pattern matching a built variable but `LANG` and `TERM`, or the device is
refused, naming the key. `ssh -G` cannot show what ssh sends; the CI canary
below carries that claim. The user matches `^[A-Za-z0-9_][A-Za-z0-9._@-]{0,63}$`,
the target (name, address or config alias) `^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$`,
the port 1 to 65535; a value that breaks its pattern stops before ssh starts.

Step 1's execs (2.1.3-beta.17) use, for a key-only host: `-a -x -T -e none`,
BatchMode=yes, ForwardAgent=no, ForwardX11=no, ForwardX11Trusted=no,
GSSAPIDelegateCredentials=no, ClearAllForwardings=yes, Tunnel=no,
PermitLocalCommand=no, ControlMaster=no, ControlPath=none, RemoteCommand=none,
UpdateHostKeys=no, ConnectTimeout=8, ServerAliveInterval=15,
ServerAliveCountMax=3, and, from the ssh -V that knows them,
SetEnv=AICC_NONE=1 (7.8), StdinNull=no, SessionType=default,
ForkAfterAuthentication=no (8.7) and EnableEscapeCommandline=no (9.2); the
environment is an allow-list. The host key is the user's own known_hosts
entry: accept-new on a machine's first connection (Add), as a plain SSH tab
does, and yes on every later exec; the app's own pin store is not built yet.

**Host keys.** The MAC-checked device record (threat model 3.12) is the only
store of a pin. Each ssh gets a 0600 known-hosts file the app writes from it in
its private data folder, with that device's pins only (jump hops included),
deleted when ssh ends; a planted line is never trusted (a test plants one). The
path goes to ssh with forward slashes, in double quotes inside the option (ssh
splits on whitespace, reads a backslash as an escape and expands `%`); one
still holding a backslash, `"` or `%` is refused, naming it. A UNC data folder
(a redirected profile) is not used: the file goes in a local, owner-only folder
with no space. A target's first connection (R2's first upload, or R3's probe)
uses `StrictHostKeyChecking=ask`: the question goes to the user through
askpass, saying whether the user's own known hosts trust that key; nothing
saved is released on it. On a yes the app reads the new line into the record
and MACs it again. A changed key stops the device until the user checks it.

**Jump hosts.** A `ProxyJump` from `ssh -G` becomes the app's own
`ProxyCommand`: the same ssh, options, environment and pins, with `-W %h:%p`.
On Windows each path in it uses forward slashes and is quoted for the command
line, then again for ssh's own splitter; one holding `"`, `%`, `^` or a
backslash is refused, naming it. A user's own `ProxyCommand` is kept, marked
"jump host not pinned by the app". **CI (R2, every app OS):** the sshd job of
ADR step R2 asserts that `ssh -G` prints each fixed value under a hostile
config; that no app variable (a config `SendEnv` naming one included), config
`SetEnv` or askpass variable reaches the sshd (`AcceptEnv *`); and that each odd
known-hosts and `ProxyCommand` path, also nested in a jump host, connects or is
refused as named.

## 3 askpass

ssh asks for passwords, codes and host-key answers through the app's askpass
program (per app OS; OpenSSH 8.4+, else only passphrase-free keys; it says why).

- **How it is reached.** Each ssh gets `SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE=force`
  and `AICC_ASKPASS_TOKEN`, random, bound to that connection and device, for
  its life and at most 4 prompts. The program sends token and prompt over an
  owner-only endpoint (Unix socket or current-user named pipe); it prints the answer.
- **Released without the user:** a saved password, only when the prompt is
  exactly OpenSSH's password prompt built from `ssh -G` (`user`, `hostname`,
  and `hostkeyalias` when set), the connection started pinned, the device has
  no jump host, nothing was released on this connection yet, and the password
  has not failed since the user last entered or confirmed it.
- **Always the user's:** key passphrases, confirm prompts, host-key questions,
  one-time codes, keyboard-interactive prompts (the usual form on macOS, PAM
  and one-time-code hosts) and any other text; a prompt not in one of ssh's
  own local forms shows as cleaned text under "text written by <device>". An
  automatic reconnect shows no dialog and ends as "sign-in needed".
- **A failed release** (ssh ends before a hello or result, or prints
  `Permission denied`) stops release and automatic reconnect until the user acts.

## 4 Remote command lines

Every command the app starts on a host is an exec over ssh, never typed into
a shell. ssh joins the words into one string the login shell parses, so each
item's alphabet (no space, quote, backslash or metacharacter) is checked first.

| Item | Pattern or source |
| --- | --- |
| fixed text | the sub-commands and flags below, and the fixed scripts (sections 13, 14) run as `/bin/sh -c '<script>'` |
| `did`, `sid`; nonce | section 1; 32 lower-case hex characters, new for every exec |
| helper folder; expected hash | `^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?-[0-9a-f]{12}$`; 64 hex. Both only from the app's manifest, never from host data |
| numbers; image name; engine and container (R11) | protocol version, offset, size: decimal integers in range; `paste-<n>.<ext>`; `docker` or `podman`; a container name (for inspect only) `^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`, then the id inspect returned, 64 hex |

No value a host reported (home, tool or CLI path) is put on a command line:
scripts build paths from `$HOME` and find their tools themselves. Script text
holds no single quote, backslash or newline, so POSIX shells, csh, tcsh and
fish pass it to `/bin/sh` unchanged (**pending probe P6** for the last three).
Values come as arguments after the script; content comes on stdin.

| Command, through the launcher (section 13) | Connection | From |
| --- | --- | --- |
| `serve --proto 1 --nonce <n> --session <sid>` | `ssh -T`, the side channel, while connected | R6; superseded by `bridge` in step 1 (one connection per session) |
| `attach --session <sid> --from <offset>` | `ssh -tt`, the terminal, while connected | R9; superseded by `bridge` in step 1 (one connection per session) |
| `bridge --store <store> --session <sid>` | `ssh -T`, the session's one connection (its terminal and its messages), while connected | step 1 (2.1.3-beta.17): copies its standard input to the holder's socket and the socket to its standard output, byte for byte; exit 0 the holder closed, 3 no holder, 2 usage, 1 otherwise |
| `selftest`, `list`, `end --session <sid>`, each `--nonce <n>` | one-shot exec | R6 |

The CLI or sudo starts `emit` (statusline and hook command, R6, R7), `mcp`
(stdio MCP server, R8) and `askpass` (sudo wrapper, R11), each with
`--session <sid>`. The prompt sudo passes to `askpass` is not forwarded.

Remote step 1 (2.1.3-beta.17, `src/main/remote-helper/scripts.ts`): each exec
is `/bin/sh -c '<fixed script>' aicc <values>`; the script text holds no
quote, backslash or line end. Results come as `AICC-RESULT <nonce> <key>
<value>` word lines, ending with `AICC-RESULT <nonce> end ok|refused
<reason>`, and the launcher prints `AICC-HASH <nonce>
ok|mismatch|missing|no-tool <hex>` before it runs the helper. Anything an rc
file prints before those lines is dropped, up to 64 KiB. The section 15
frames of one session ride one `ssh -T` bridge exec, not a `-tt` terminal plus
a side connection (ADR-030 protocol change 16).

## 5 Processes

- Until R9 the old terminal path starts the CLI and `serve` owns the socket
  while connected; with none, `emit` spools and exits 0 (it never makes a
  session folder). From R9 one holder owns the CLI's PTY, the socket and
  `seq`, keeps `holder` locked for life; `serve` and `attach` relay to it.
- **Who starts the holder (R9).** Before it installs its filter or reads a
  frame, `serve` starts a spawner: the same verified binary run again,
  unfiltered, reading only one fixed byte from a pipe. On `session.start`
  `serve` writes that byte; the spawner starts a holder in a new session
  (`setsid`) without testing for one, and exits with `serve`. The holder first
  takes the exclusive lock on `holder` and exits if it cannot, so concurrent
  starts leave one holder and one CLI. It then writes `holder` (machine
  identity, boot id, pid, start time), reads only its spec and start size,
  starts the CLI, records the CLI's pid and start time in the spec, and
  installs its filter before it reads any socket (threat model 3.10).
  Outliving logout: probe P3 held for 60 s on a Linux host that does not clean up at
  logout (ADR-030); **pending probe P3** for a host that does and for ADR-029's other P3
  host roles (macOS, a container host). Rocky Linux 10 (2026-11-23): P3 held for
  60 s in 3 of 3 runs of each form, on a second host that does not clean up at logout
  (KillUserProcesses no, Linger yes).
- Only the holder outlives a connection; `mcp` lives as long as the CLI, the
  rest for one call. The holder exits when the session ends, a non-detachable
  terminal closes, or a detached session reaches its maximum lifetime.
- **Two relay slots.** The holder has a control slot (`serve`) and a terminal
  slot (`attach`). The newest connection of a role takes its slot; the older of
  that role gets `replaced` and exits (another app instance shows "taken over").
  A `serve` never replaces an `attach`, so status, hooks and MCP keep flowing
  while the terminal is open (test: ADR R9).

## 6 Framing

**Marked lines.** The app reads only these lines, `<nonce>` being the exec's:

```
AICC-HASH <nonce> <state> <hex>   (the launcher, section 13)
AICC-HELLO <nonce> <json>         (serve)
AICC-RESULT <nonce> <json>        (every one-shot exec and fixed script)
```

Only the first `AICC-HASH` counts; a second one, or a hello with none before
it, fails the exec. Earlier output (banners, rc files) is discarded up to
64 KiB, then `no-hello`. A hello line is at most 4 KiB, a result line 1 MiB; a
zero exit with no result line is a failure.

**Frames.** After the hello: 4 bytes length of the rest (unsigned, big-endian),
1 byte kind (0 = JSON control, 1 = raw bytes), 4 bytes channel id (0 =
control), then the payload. The reader refuses an oversize length before it
allocates. Hard limits: JSON 1 MiB helper to app and 16 MiB app to helper (a
tool result can carry a screenshot); raw 64 KiB both ways; JSON depth 32.

## 7 Handshake and versions

The hello carries `proto` (versions spoken), `helper` (version and `sha256`,
information only), `os`, `arch`, `caps`, and `session`: its `sid` and a state.
A hello with another `sid` or a broken schema fails as `no-hello`; unknown
hello fields are ignored. The app answers `hello.ack` `{proto, caps}`. States:

| State | When | What the app does |
| --- | --- | --- |
| `new`; `live` (R9) | no folder yet; a `held` session whose holder answers | starts it; attaches |
| `unmanaged` | a folder on this machine and boot, not ended, whose spec `mode` is `external` or absent, or any spec while the running app predates holders (a rollback); the old path keeps the CLI. On an app that speaks holders a `held` spec is never `unmanaged` | keeps it, never offers resume, never removes it; it leaves this state only through a new boot, a confirmed end (see `stale`; never a closed tab or detach) or a user action (tests: ADR R6, R9) |
| `stale` | this machine identity and a new boot (another boot id, begun after the session started); or a confirmed end, the CLI's stopped state shown by section 13's pid and start-time test, never a result line alone (for an `unmanaged` session the app's end is the old path's own kill plus `session.end`; a no-op `end` is not an end); or, from R9, a `held` spec with no holder answering, the `holder` lock free and the CLI provably stopped (section 13's test on its recorded pid and start time): each beats `unmanaged` | offers remote resume (section 8), then removes the folder only if its own record holds it |
| `orphaned` (R9) | a `held` spec on this machine and boot whose holder does not answer, not `stale`: the `holder` lock is held or cannot be tested, or the CLI's record shows it live, is missing or cannot be read (a CLI can outlive its holder by ignoring hangup) | keeps it; never offers resume, never starts a holder over it, never removes it; offers "reattach or end": reattach asks the holder again and repeats the test (a stopped CLI makes it `stale`); end is the confirmed end above |
| `elsewhere`; `unknown` | another machine identity, or a boot begun before the session; no identity | never ended or removed by the app, and `end` refuses them; section 13 gives them an exit for removal |

**Mismatch.** No common version: `proto-mismatch`, close, the device waits for
the user (never a re-provision on a host's version list). An older helper gets
no new session until re-provisioned; a newer one, the highest common version.
**Frozen core** (never changes within version 1): the hello (`proto`,
`helper`, `session`), the hash line, the `serve` and `attach` command lines and
every `core` message in section 8. The `list` and `end` command lines, results
and the removal script never change in any version; relay-to-holder messages
and session folder files carry their own format version, frozen likewise.

**Rules for change.** New messages or fields only behind a new capability;
changing or removing a message or the frame layout makes version 2. The app
speaks the current and previous version, keeping N-1 until no session begun on
it can still be within its maximum lifetime. New sessions start only on the
bundled helper (the manifest holds every released hash); a live one keeps the
helper folder its spec names, and a fixed script removes an old helper folder
only when `list` shows no live session naming it.

## 8 Messages

Every control message is a JSON object with a type `t`. Requests carry an
`id`; a reply carries `re`; events carry a `seq` (section 9).

| Type | Sent by | Reply | Fields and purpose | Cap, step |
| --- | --- | --- | --- | --- |
| `hello.ack`; `ping` / `pong` | app; either | none; `pong` | chosen version and capabilities; heartbeat | core, R6 |
| `error` | either | none | `{re?, code, text}`, text at most 512 characters | core, R6 |
| `probe` | app | `probe.report` | what the host has (below) | core, R6 |
| `session.attach` | app | `session.attached` | `{id, since_seq}`; reply `{re, ring_start, ring_end}` | core, R6 |
| `session.end` | app | `session.ended` | stop this session (TERM, KILL after 5 s); its folder goes only once the CLI's stopped state is shown (section 7) | core, R6 |
| `session.list` | app | `session.list.result` | up to 256 `{sid, state, helper, mode, started}`, this `did` only | core, R6 |
| `status`; `event` | helper | event | `{seq, payload}`, one statusline update; `{seq, kind, payload}`, one hook event | `status`, R6; `hooks`, R7 (not the local `hooks` of section 15) |
| `session.prepare` | app | `session.prepared` | `{id, files, edits, env, argv, cwd, mode}`; one result per file and edit | `hooks`, R7 |
| `file.put` | app | `file.stored` | upload one file (below) | `files`, R7 |
| `mcp.open`, `mcp`, `mcp.close` | helper (`mcp` either) | none | `{stream}`; `mcp` adds one JSON-RPC `message` | `mcp`, R8 |
| `session.start`; `session.detach` | app | `session.started`; `session.detached` | `{id, cols, rows}`, reply `{re, pid}`; close relays, keep the session | `held`, R9 |
| `session.exit` | helper | event | `{seq, code, signal}` | `held`, R9 |
| `sudo.ask` | helper | `sudo.answer` / `sudo.decline` | `{id, layer}`; answer `{re, secret}` | `sudo`, R11 |

**Sessions come from the connection** (R6, through R8, and after). No
host-to-app message carries a session id the app acts on; each side channel
serves the one session it was opened for, and `session.end` ends that one. A
session found by `session.list` is ended by a one-shot `end`.

**What the helper may ask and run.** Its requests (`sudo.ask`, `mcp`) are
questions the app may refuse; none makes the app run, open or write anything.
It starts only its spec's `argv`, on `session.start`; no general exec or
file-read request exists. `argv[0]` is a CLI path from the probe report or login
shell; `cwd` is absolute; `env` names come from the provider's fixed list, none
secret-named (section 2); `files` go only into the session folder by declared
names; `edits` name rows of the closed list below; `mode` is `external` or `held`.

- `probe.report`: OS, kernel, architecture, userland bitness and ARM version,
  login shell, home (section 1) and its filesystem type, the device and inode
  numbers of `$HOME` and `~/.aicc`, machine identity, boot id, the hash tool
  found, each CLI (name, absolute path, version), container engines, sudo
  mode, the names and ages of other `~/.aicc` entries (listed, never opened),
  self-test result (one validator, R3 included); a container's trust facts
  come from the host (section 14).
- `file.put` `{id, name, size, sha256}`, then `size` bytes as kind 1 frames on
  channel = request id. `name` is `paste-<n>.<ext>`, `<ext>` from a fixed image
  list; only into `paste/`, 20 MiB each, 100 MiB per session. `file.stored`
  `{re, path, sha256}` must give `path` exactly the recorded home plus
  `/.aicc/<did>/sessions/<sid>/paste/<name>`, and the hash. Attachment by
  pasted path is **pending probe P4**.
- `mcp` goes to the Conductor MCP server as the side channel's session, under
  the remote allow-list (threat model 3.5), no local render root, inline
  content only. `sudo.ask` `layer` names the target.

**Payload allow-lists.** `status` and `event` payloads (at most 64 KiB) keep
only the fields the provider declares per kind, typed as number, label (at most
128 characters, cleaned as in section 12), remote path or remote CLI session
id; the decoder drops the rest first. A remote path is display text, never
opened, given to transcript, resume or usage code, or stored as a local path.
A remote CLI session id is a typed `{did, id}` (`id` a canonical lower-case
UUID, never starting with `-`) in remote-only fields, never read by local
transcript, resume, relocation, usage or canvas code, never a local map key.
**Remote resume** is its own path: the `{did, id}` goes only into that device's
`session.prepare` `argv` (before R7, the old path's remote launch line) as its
own word after the CLI's resume flag, and runs on the host. A fixture sends a
local conversation's id; no local resume or transcript code runs. Usage shows
under the device record's account. Version 1, Claude Code (R5 fixtures):
`status` keeps model id and name; context used, size and percentage; cost and
duration totals; CLI version; the remote CLI session id; remote paths `cwd`,
`transcript_path` and the workspace folders. `event` keeps hook name, the
remote CLI session id, notification text (a label of at most 1,024
characters) and tool name; prompts, tool inputs and results are dropped.
As built (2.1.3-beta.18, section 3.2; providers/claude/remote-launch.ts
CLAUDE_STATUS_KEEP and CLAUDE_HOOK_KEEP), `status` keeps `model.id`,
`model.display_name`, `context_window.used_percentage`,
`remaining_percentage`, `context_window_size` and
`current_usage.input_tokens`, `output_tokens`,
`cache_creation_input_tokens` and `cache_read_input_tokens`,
`cost.total_cost_usd`, `total_duration_ms`, `total_lines_added` and
`total_lines_removed`, `version`, `session_id`, `cwd`, `transcript_path`,
`workspace.current_dir` and `workspace.project_dir`, and `used_percentage`
and `resets_at` of `rate_limits.five_hour` and `rate_limits.seven_day`.
`event` keeps `hook_event_name`, `session_id`, `message`,
`notification_type`, `tool_name`, `transcript_path`, `agent_id`,
`effort.level`, `error`, `reason`, `error_type` and `source`. A kept value
is a string of at most 4,096 characters, a finite number or a boolean;
anything else is dropped. A status is delivered under the tab's own id,
never a session id from the payload. Its strings are then bounded at 256
characters (statusline-watcher.ts STATUS_STRING_MAX).

**Named edits (closed list, from R7).** One row: `claude-folder-trust` sets
`projects["<cwd>"].hasTrustDialogAccepted` to `true` in the CLI's config file
(`~/.claude.json`, or under `CLAUDE_CONFIG_DIR`) for exactly the `cwd` the user
chose, turning off the CLI's trust prompt there. The helper changes bytes only
inside that value (or inserts that key), writes a new file with the same mode,
and renames it over the old one only if that is unchanged just before (else
`io`; a writer in that last moment can still lose one update). A golden-file
test covers fake secrets, integers past 2^53, unicode escapes, key order, CRLF,
no final newline and a concurrent writer. The old value goes to `edits`. Probe
P4 confirms file and key (a CLI flag, if one exists, replaces the row); a new
row needs its own adversarial pass.

| Error code | Meaning | Closes |
| --- | --- | --- |
| `bad-frame`; `unknown-type` | length over the limit or under 5, unknown kind, bad or too-deep JSON, raw bytes with no open transfer; a type the version and capabilities do not allow | yes |
| `proto-mismatch`, `no-hello`, `hash-mismatch`; `replaced` | sections 7, 6, 13; a newer connection of the same role took its slot (section 5) | yes |
| `bad-field`, `too-large` | a field breaks its schema; a size rule is broken | no (budget, section 12) |
| `busy`; `not-found`, `not-connected`, `denied`, `timeout`, `io`, `internal` | one already open, a budget full, or already started; as named | no |

## 9 Ids and ordering

Request ids are unique per connection (app even, helper odd); each request gets
one reply, its result or `error` with `re`. Each event takes its session's next
`seq` (until R9 from the `seq` file under a lock, then from the holder), which
survives reconnects. The spool keeps the last status and 50 other events;
`session.attach` replays those above `since_seq`, and the app drops a `seq` it
has seen; a gap is logged, and noted on the session if a hook event was lost.

## 10 Timeouts

| What | Limit | On expiry |
| --- | --- | --- |
| hello; a one-shot exec | 20 s; 60 s, from ssh start, paused while an askpass prompt is open | `no-hello`; ssh stopped, exec failed |
| a reply; `probe`, `session.prepare`, `session.start`, `session.end` | 10 s; 30 s | `timeout` |
| `file.put` | 30 s between chunks; reply 10 s after the last | `timeout`, partial file removed |
| heartbeat; helper with no frame from the app | `ping` every 15 s; 60 s | no `pong` in 45 s: link dropped; the relay exits, the holder stays |
| an MCP tool call | the tool's limit, at most 10 min | `timeout` to the CLI |
| `sudo.ask` waiting for the user | 120 s | askpass fails; sudo reports it |

## 11 A dropped connection

- The holder (from R9) keeps the CLI running. With no `serve`: `emit` spools,
  an MCP call gets `not-connected`, a `sudo.ask` fails at once.
- **Automatic reconnect** only after a link drop (no `pong` in 45 s, or ssh
  ending after a hello): `serve`, then `session.attach` with the last `seq`;
  back-off 1, 2, 4, 8, 16 s, 5 tries, 5 more on wake or network return; then
  it waits for the user. Never after an authentication failure, a prompt it may
  not answer (section 3), a host-key question or change, `hash-mismatch`,
  `proto-mismatch`, `replaced`, `bad-frame`, `unknown-type` or malformed
  input, nor for a one-time-code device. It is never a user-started launch.
- **Terminal reattach (R9).** From a 2 MiB output ring the holder replays
  what follows the offset the app attaches from: the byte after the last one
  it showed, or 0 for a terminal it takes over. When the ring no longer holds
  that offset, the holder answers from `ring_start` with `truncated` true
  (section 15, Attach). What
  the app on This computer does then (2.1.3-beta.12): it does not clear the
  view or reset the terminal. It holds the replay until it reaches
  `ring_end`, over a dropped connection too (the attach again, with no new
  gap, holds its own replay to its `ring_end`), and at most until the
  terminal ends or 2 s pass. A take-over on a holder that offers the screen
  reads (section 15) also keeps the replay, cut or whole, until the tab is at
  the holder's size, at most 3 s after it read that size, and sends the holder
  no size meanwhile (2.1.3-beta.13). When the tab does not get there within
  those 3 s (its window changed size between the two runs), from
  2.1.3-beta.15 the app tells the tab the holder's size and the replay's
  length just before the replay. The tab writes the replay at the holder's
  size and is then fitted to its own, and the holder hears the tab's size
  only after that fit, or 3 s after the replay if the tab gives none. A
  replay that turns out to have nothing to show sends the tab's size when it
  comes due. The replay is shown in one piece: the cancel
  character, the attribute reset and one line of its own, "[Earlier output
  of this terminal is no longer held, so it is not shown.]", then only the
  last of the replay that the tab's scrollback keeps (10,000 lines less a
  screen and that line's own rows, cut at the start of a line, or inside a
  line that alone takes as many or more, or that only empty rows follow; for
  a replay written at the holder's size into a narrower tab, fewer, since each
  row rewraps into up to ceil(holder columns / (tab columns less 1)) rows at
  the fit), so that line is not pushed out of reach. With the tab at the
  holder's size, or the replay written at that size (2.1.3-beta.15), and
  nothing shown before (2.1.3-beta.13), that line is written on the row above
  the tab's last row and the kept text starts on the last row, where the
  console's cursor was; one clear of the scrollback (CSI 3 J), put in at the
  start of a row a line feed made, then drops the empty rows that were above
  that line once they have left the screen, so that line is the tab's first
  row. What the part left out did to the
  terminal goes across the cut: the alternate screen, left before that line
  (and before the attribute reset) whenever that part switched to it or from
  it, and the input modes it set.
  Rows are counted as xterm.js counts them; what a program draws on the
  alternate screen takes none, and the cut never lands there. Once the
  replay is shown and the program still runs, it asks the program to redraw
  (probe P19): on the console built into Windows by one resize at the tab's
  own size (that console draws its whole screen again on any resize, from its
  own top row, and at the same size moves no row under a shell at its prompt;
  from 2.1.3-beta.15 the tab writes the paint after a size it sent where it
  holds the lines, when they match:
  src/renderer/components/terminal/consoleRepaint.ts); on node-pty's
  bundled ConPTY, macOS and Linux by a resize one row shorter and, 300 ms
  later, back to the tab's size. A replay still coming in at the 2 s cap shows
  what had arrived, and the rest follows untrimmed: the one case where that
  line can still go out of reach. The screen in use and the input modes the
  program set before `ring_start` are not restored yet.

## 12 Strict validation and budgets

The host is untrusted input. The app decodes frames off its main thread and
checks each control message against a strict schema per type (unknown types
and fields refused, hello fields excepted; bounded strings; finite integers in
range; ids from small alphabets). A host-supplied path is never used locally
or stored in a field the app treats as a local path. Host text (errors,
versions, prompts, notifications, labels) shows as capped plain text with
control (Cc) and format (Cf) characters removed, bidi and zero-width included,
in the window and OS notifications. The only host-derived text typed into a
terminal is an upload path equal to the recorded home plus the expected folder
and name (a fixture: a home with CR, ESC and a leading `~`).

**Budgets per connection** (the helper applies the same to the app):

| What | Limit | On breach |
| --- | --- | --- |
| messages, helper to app; `status`, `event` | 200 a second, bursts of 400; 10 a second per session | dropped and counted; for messages, close after 10 s over (banner; reconnect kept) |
| bytes, helper to app | 8 MiB a second | close (banner; reconnect kept) |
| MCP streams; MCP calls in flight | 4; 8 | `busy` |
| `bad-field`, `too-large` replies (malformed input); `denied`, `busy` replies | 20 in 60 s; 5 a second, bursts of 20 | close, no automatic reconnect; dropped and counted, never a close |
| ssh stderr, stdout after a result line | 64 KiB kept | the rest discarded and counted |

## 13 Fixed scripts

**Folder checks first.** Before any write or exec, every fixed script checks
that `$HOME` is an absolute real folder (not a link, not `/`), owned by the
user, and that neither it nor any ancestor of its real path is writable by its
group or by others (an ancestor is owned by the user or root); that `~/.aicc`,
`~/.aicc/<did>` and each folder below it uses are real folders owned by the
user, set to 0700; and that the marker holds this install's ids. Owner and mode
come from `ls -ldn` against `id -u`; no group is exempt, not even one named
like the user, as another account can be a member. A failure prints a refusal
naming the folder and mode as `AICC-RESULT`, and the device stays at the floor.
Tested under dash, bash, busybox sh and macOS sh (fixtures: ADR step R2).

- **Launcher.** Starts every helper command (`did`, helper folder, expected
  hash, nonce, command words). It finds `sha256sum`, `shasum -a 256` or
  `openssl dgst -sha256` with `command -v`, in that order (none: the floor).
  The hex is the first field (the last for `openssl`) and exactly 64 lower-case
  hex characters, else `tool-failed` (tested: GNU, busybox, macOS, OpenSSL 1.1
  and 3). It prints the `AICC-HASH` line (state `ok`, `mismatch`, `missing`,
  `no-tool` or `tool-failed`) and execs only on `ok`, on every start; the app
  checks the hex against its manifest again before `hello.ack`.
- **Install** (R6 and re-provision; `did`, helper folder, size, expected
  hash, nonce; the binary on stdin; umask 077). It takes a lock (`mkdir
  helper/.lock`, cleared after 15 minutes), removes this `did`'s `helper/.new-*`
  and `selftest-*` leftovers older than 15 minutes, writes the marker if the
  folder is new, makes `helper/.new-<nonce>` with a plain `mkdir`, reads
  exactly `<size>` bytes (`head -c`, else `dd`; then a size check), hashes,
  sets 0700, and renames it to the helper folder only if that name does not
  exist (a wrong-hash one is removed first). A self-test in `selftest-<nonce>/`
  (session folder, socket, PTY, binary echo) follows.
- **`end` and removal.** `end` signals a holder only on the spec's own
  machine, after the socket's peer pid and start time match `holder` (for an
  `orphaned` session, the CLI's recorded pid and start time); else it does
  nothing, and the result says not ended (section 7). The removal script (also
  at the floor) refuses while any session is not provably dead, by pid and
  start time (`/proc` or `ps`), never a lock. **Provably dead** needs
  positive proof: this machine's identity, and a new boot (section 7), or the
  same boot, a recorded pid and start time (the CLI's in the spec; from R9 the
  holder's in `holder`) and a successful read showing each recorded pid absent
  or with another start time. A missing record, an unreadable `/proc` or `ps`,
  or a start-time format mismatch reads as live. A `sessions/<sid>/` folder
  with no spec is no session. A session on another machine counts as live, the
  result naming that host, and goes only on the user's confirm naming it; on an
  unknown machine, only on the user's confirm that no other machine shares this
  home; on this machine, only on the user's confirmed end. It then deletes
  `~/.aicc/<did>`, the node id, and `~/.aicc` if empty (tests: ADR R6, R9, R11).
- **Node id.** The install script makes `/var/tmp/aicc-<uid>/node-<did>` if
  absent (random 32 hex; the folder checked like `~/.aicc`, 0700), outside any
  shared home; if that fails, there is none. A lost one makes old sessions
  `elsewhere`; the exit above clears them.
- **R2 upload** (one ssh connection each until R7). `/bin/sh -c '<upload
  script>' aicc <did> <sid> <name> <size> <nonce>`, image (at most 20 MiB) on
  stdin. With the folder checks down to `paste/`, it refuses at 100 MiB there,
  reads exactly `<size>` bytes to a temporary file, hashes it, links it to
  `<name>` with a plain `ln` (fails if the name exists; no hard links is a
  named refusal) and prints `AICC-RESULT` with `path`, `sha256`, `tool`. **R2
  session end** (`aicc <did> <sid> <nonce>`) removes that session's folder and
  this `did`'s paste files over 7 days old; from R6 threat model 3.9 rules.
- **R3 probe and setup.** The probe prints `probe.report` as `AICC-RESULT`.
  Setup sends each file on stdin (at most 256 KiB a file, 1 MiB a run). Outside
  `~/.aicc` it writes only files the provider declares under the CLI's config
  folder, each absent or a user-owned regular file (not a link); one already
  there goes to a recorded backup in `backup/`, which Remove device puts back.
  Each is written fresh, renamed, and recorded with its hash.
- **R6 wiring.** Per-session settings (R7: `session.prepare`) set the statusline
  command to `"$HOME"/.aicc/<did>/helper/<folder>/aicc-helper emit --session <sid>`,
  `$HOME` quoted, only checked values added (fixture: a home with a space).

## 14 Containers (R11)

- **Placing.** Each container target has its own `did` and consent. A one-shot
  `<engine> exec -i <id>` (the id inspect returned, below) runs the install
  script, binary on stdin, into the container user's `~/.aicc/<did>/`, with the
  same checks, hash and self-test; a recreated one (`missing`) at most once per
  target per app run, with a notice. The side channel is `<engine> exec -i
  <id>` around the launcher, with `sudo -A` in front when the engine needs sudo.
- **Shared homes, from the host side.** At placement and at every user-started
  launch before any release, the host's fixed script runs `<engine> inspect
  --type container <name>` and applies the shared list (threat model 3.4),
  comparing each mount source by real path and by device and inode against
  `$HOME` and each of its ancestors. The app keeps the container id and a hash
  of the mount list; every exec names that id. Changes, gaps, parse failures
  and confirms follow threat model 3.4. Detection never needs a saved sudo
  password: it runs without sudo or under one typed at that launch; until
  then, shared.
- **sudo.** The app first starts a host-side `serve` owning the host session
  folder and socket. The `askpass` wrapper (a 0700 `/bin/sh` file that execs
  the helper's `askpass`) and a hash-checked helper copy sit in a fresh private
  folder in the runtime folder, outside every mount source the inspect listed
  (none: no saved sudo password is released). The fixed script sets
  `SUDO_ASKPASS` to it, so every sudo question reaches the host-side `serve`.
- **Removal** runs the removal script in every configured running container; a
  stopped one is listed as maybe holding a copy. **Pending probe P5.**

## 15 Local transport (protocol change 1)

The same helper holds terminals on the user's own computer, so a local session
outlives an app crash (ADR-030). There is no ssh and no daemon: one holder
process per session, each on its own endpoint, started by the app and found
again through a record it writes. Frames (section 6), the hello (section 7),
`ping`, `error` and the error codes are those of version 1; the `local`
capability adds the messages below. Fixtures: `helper/fixtures/local.json`.

**Starting a holder.** The app runs

```
aicc-helper hold --store <folder> --session <sid> [--label <text>] [--away <seconds> | --until-ended] [--ring-bytes <n>] --detach
```

and reads one line from stdout: the holder's record (below). Exit 0 means the
holder is running and listening. Exit 3 means a holder for that session is
already running; it is left alone, and the app connects to it. Anything else
failed, with a message on stderr, within 15 s; a holder that fails before it
is ready says why, and `--detach` passes that on. `hold` without `--detach`
exits the same way. `--away` is 1 to 86400 seconds, default 120;
`--until-ended` (from 2.1.3-beta.19, protocol change 14) is given in place of
`--away`, never beside it (exit 2), and starts a holder with no away clock
(below); `--ring-bytes` 1 KiB to 64 MiB, default 2 MiB; a label is at most 128
characters, none of them a control character. Each option is given at most
once; an unknown one fails. `--detach` makes the store folder if it is missing
(and checks it, as below), then starts the holder in it, with the store named
by its full path, so the holder keeps no folder of the app's open. The holder
keeps none of the app's handles either: on Windows it is started with a
handle list that names only its standard error pipe, and on macOS and Linux it
closes every descriptor from 3 up as it starts.

The holder runs in a new session (Unix `setsid`). On Windows it runs as a
detached process outside the app's job when that job lets a process leave it;
a job that does not keeps the holder inside it, and the holder then ends when
the job does (`--detach` says so in a note on stderr). Nothing else tells the
app whether a holder outlived it: list mode at start-up is the check.

**Starting a program (Windows only).** The app starts the vision browser with

```
aicc-helper start [--hide] --cwd <folder> -- <program> [args...]
```

The program is started by the exact path given, which `CreateProcessW` is
handed as the program, so nothing is searched for; the arguments after it are
quoted as the holder quotes a launch's `argv`. It runs as a detached process
in a process group of its own, in `<folder>`, with its window hidden under
`--hide`, and it inherits no handle: inheritance is off and its standard
input, output and error are nothing. The helper is given every handle the app
lets a child inherit, as any child of the app is, but it exits at once. The
program and the folder must each be a drive-absolute path (`C:\...` or
`C:/...`; a share, a rooted path such as `\x` and a name with only a drive are
refused). The program must not be a batch file, and must not be a name Windows
opens as another (a part of dots alone, a trailing separator, a trailing dot
or space). It takes at most 256 arguments of at most 8192 characters, the
folder is at most 4096 characters, and none of them may hold a NUL character.
The program is created suspended; its creation time is read from the process
handle the start returned, and only then does it run. On success the helper
prints one line, `{"pid":<n>,"created":"<t>"}`, and exits 0 without waiting for
the program. `created` is the program's creation time as
`Win32_Process.CreationDate.ToFileTimeUtc()` gives it (steps of 100 ns since
1601, UTC, to the microsecond), so the app ends that process later only while
its pid still has that creation time. A program it refuses, or one that cannot
be started, exits 1 with a message on stderr, and nothing has run: a creation
time that cannot be read ends a program that has not run yet. A command line
it cannot read exits 2. On macOS and Linux the mode exits 1. The app runs it
from the install folder (`resources/helper`): it does not outlive the app, so
it needs no per-user copy.

**Ending a program it started (Windows only).** The app ends that program with

```
aicc-helper end --pid <n> --created <t>
```

`<n>` is a pid of up to 10 digits, above 0, and `<t>` a creation time of 1 to
20 digits in the form `start` prints; each is given once and nothing else is
taken. The helper opens that process and holds it open from its check to its
end, so the pid cannot pass to another process in between. When the pid still
has that creation time and the process still runs, the helper ends it and every
process under it, prints `ended` and exits 0. The processes under it come from
one read of the process list, and the helper reads the system time just before
that read. A process counts as under its parent only when it was made no
earlier than the parent and no later than that time: one made earlier names a
parent id that has since passed to another process, and one made later may have
taken a listed pid after the list was read. A pid is freed and passed on only
after the list is read, so a process that takes one is always made after that
time; one made while the list is read is left out too, and keeps running. A
list it cannot read in full (the snapshot fails, or reading an entry fails with
any error but the end of the list) ends nothing: a list read in part would
leave processes under it running once it is gone. The processes under it are
ended once it is gone, also when it exits by itself after the check, and it
prints `ended` only when none of the processes it checked still runs. An end
that fails waits for the process to exit before it counts: Windows refuses to
end a process whose own exit is under way, but marks it exited only once that
exit is done. One that exits within the wait exited by itself; one that runs
past it still runs. The wait is one bound for the whole end, one second in all
however many ends fail, so such an end answers up to a second later; an end
that succeeds waits for nothing. When no process has that pid, the one that has
it was made at another time, or it had already exited when it was checked, it
ends nothing, prints `left` and exits 0. It exits 1 with a message on stderr in
three cases, and the app then keeps the program tracked. When it cannot tell
(the process cannot be opened or read, or the process list cannot be read), it
ends nothing. When the process still runs and cannot be ended, it ends nothing.
When a process under it cannot be ended and may still run, it ends the rest. A
command line it cannot read exits 2. It reads the process list and each
process's times itself, with no PowerShell and no WMI, so it answers in
milliseconds: the app uses it on the exits that cannot wait (quit, an update
install, SIGTERM) as well as at a stop and a relaunch. From 2.1.3-beta.9 the
app also records the pid and creation time `start` printed in
`vision-started.json` in its user data folder (a dev or test run's own data
folder instead) until an end answers `ended` or
`left`, and at its next start, and before each launch of the vision browser, it
ends the program that record names through this mode alone. It runs the mode
from the install folder, or, when that file is gone (an uninstall for all users
can remove it while the app runs), from the per-user copy the session helper
put in place in that run, whose SHA-256 it checks again first; with neither it
runs nothing and keeps the record. On macOS and Linux the mode exits 1.

**Console hosts a run left (Windows only, from 2.1.3-beta.9).** Each terminal
tab of the app is a pseudoconsole, and Windows starts its console host
(`conhost.exe`, or node-pty's bundled `OpenConsole.exe` for a tab that asks for
it) as a child of the app's main process. When the app is ended from outside,
nothing closes the pseudoconsole, and on some Windows builds the host keeps
running until sign-out. So the app records its own pid and creation time at
start-up (`app-run.json` in its user data folder, a dev or test run's own data
folder instead, as for `vision-started.json`;
`src/main/console-host-leftovers.ts`) and at the next start runs, once,

```
aicc-helper console-hosts [--pid <n> --created <t>]
```

with that record, `<n>` and `<t>` as for `end`. The helper reads its own
creation time, then the process list once, and ends each process that is named
`conhost.exe` (its program file Windows' own `System32\conhost.exe`) or
`OpenConsole.exe` (a file of that name), is listed with `<n>` as its parent,
was made in a later microsecond than `<t>` and before both the helper's own
creation time and the creation time of any process that has `<n>` now, and
runs as the helper's own user. Each is held open from its check to its end, so
its pid cannot pass on in between. A pid passes on only once its process has
gone, so a process made after the pid's new owner names that owner as its
parent, not the run before. It ends nothing when `<n>` still has `<t>` and that
process still runs, when the process that has `<n>` now cannot be opened or
read (its creation time, or whether it still runs), or when `<t>` is before
Windows last started (with a minute's slack). It also names the process that
started it, its parent in the same list, made before it, for the app to
record: it prints one line, `{"pid":<n>,"created":"<t>","ended":<k>}`, and
exits 0, with a note for the app's log on stderr when it ended nothing for one
of those reasons or could not end a host. It exits 1 with a message, ending
nothing, when it cannot read its own creation time or its own user, the process
list, the process that started it, or the system folder (where Windows' own
`conhost.exe` is); the app then does not record that run. It exits 2 on a
command line it cannot read. No PowerShell and no WMI. On macOS and Linux the
mode exits 1. The app runs it from the install folder, as it runs `start` and
`end`.

**A terminal's console host after its program has ended (Windows only, from
2.1.3-beta.14).** On Windows' own ConPTY a terminal's console host ends only
when its pseudoconsole is closed. node-pty (1.2.0-beta.15) drops the
pseudoconsole, unclosed, as soon as the program exits, so the host would run
until the app quits. node-pty's bundled ConPTY ends its host with the program
and is left alone. So the app times each terminal it starts on Windows' own
ConPTY: Date.now() just before and just after node-pty's spawn, widened by
50 ms on each side, because that clock can run up to one Windows clock tick
behind the clock Windows stamps creation times with
(`src/main/console-host-end.ts`). Once node-pty reports the program's exit, and
no sooner than 6 s plus that 50 ms after the start, the app runs, once,

```
aicc-helper end-console-host --made-from <t> --made-to <t>
```

with `<t>` in steps of 100 ns since 1601 (UTC). `--made-to` is not included,
and it is at most ten seconds after `--made-from`. The helper reads its own
creation time, then the process list once, and ends each process that meets all
of these: it is named `conhost.exe` and its program file is Windows' own
`System32\conhost.exe`; it is listed with the process that started the helper
as its parent; it was made in that time, after that process and before the
helper; it still runs, as the helper's own user; it was made at least 6 s
before the helper (node-pty gives a program 5 s to start in its pseudoconsole,
and until then a running terminal's host has no program); and it is the console
host of no process that still runs (each listed process's
`ProcessConsoleHostProcess`; a process with no console can answer its maker's
pid, which only ever keeps a host). The widened time can hold the host of a
terminal started just before or after. What keeps a running terminal's host is
those last two rules, not the time. Two terminals started within about 50 ms of
each other whose programs have both ended get both hosts ended. Each host is
held open from its check to its end. It ends nothing when no process meets all
of that, or when a process that still runs, and could be opened, cannot be read
for its console host (a process that cannot be opened is not read). It prints
the line `console-hosts` prints, naming the process that started it, with
`ended` how many it ended, and exits 0. It writes a note on stderr when it kept
a host for one of those reasons or could not end one. It exits 1, ending
nothing, when it cannot read its own creation time or its own user, the process
list, the process that started it, or the system folder. It exits 2 on a
command line it cannot read, a time longer than ten seconds included. No
PowerShell and no WMI. On macOS and Linux the mode exits 1. The app runs it from
the install folder, as it runs `console-hosts`.

**Capturing the displays (Windows only, from 2.1.3-beta.14).** Protocol change
2 (ADR-030): a command-line mode on This computer only, display pictures only,
for Snap (D3, D4). From 2.1.3-beta.16 the app runs it for Snap on Windows,
where the new Snap is the default (`src/main/snap/`), with a 2 s bound after
which it ends the helper through its own handle; probe P21 measured it first
(ADR-030, Probes).

```
aicc-helper capture --out <folder>
```

`<folder>` is an absolute path to a folder that is there already; `--out` is
given once and nothing else is taken. The mode makes itself aware of each
display's own scale (per-monitor DPI awareness, version 2), so every size is in
physical pixels. It first checks that it can see the screen: its window station
is the one a display shows (a service or an SSH session has none), and the
desktop on the screen is its own (not the sign-in screen, a locked screen or an
elevation prompt). Then it lists the displays, the primary one first and the
rest from the top left, grabs each whole display from the screen and writes it
to `display-<n>.bmp` in the folder, `<n>` from 1: a 32-bit BMP whose rows run
from the bottom, every fourth byte 255. Whole displays only, never a window or
a part of one (the rectangle of D4 is cut by the overlay); at most 16 displays,
each at most 16384 pixels on a side. Each file is made new: a file already
there is never written over, and the run then fails. A run that fails removes
every file it wrote, so it leaves all of them or none. It prints one line,

```
{"displays":[{"file":"display-1.bmp","left":0,"top":0,"width":1920,"height":1080,"dpi":144,"scale":150,"primary":true}]}
```

with each display's bounds on the virtual screen in physical pixels, its
effective DPI and that as a percentage of 96, rounded, and exits 0. It exits 1
with a message on stderr when a grab or a write fails, or `<folder>` is not a
folder that is there; 2 on a command line it does not take; 3 when there is no desktop to
capture (it cannot see the screen, or Windows lists no display), with the
reason on stderr; and 4 on macOS and Linux, where it is not supported yet. It
makes no window, and uses no PowerShell and no WMI. Its window-manager DLLs
(user32, gdi32, shcore) load only when the mode runs; no other mode loads them.

**Endpoint: only this user can connect.** No network socket is opened.

- **Windows:** the named pipe `\\.\pipe\aicc-helper-<sid>-<32 hex>`. Its
  security descriptor is `O:<the user's SID>D:P(A;;GA;;;<the user's SID>)`:
  the current user owns it, and its list has one entry, that user, nothing
  inherited. The owner counts as much as the list, since an owner may always
  change the list. The first instance is made with
  `FILE_FLAG_FIRST_PIPE_INSTANCE` (a name someone else made is never joined)
  and every instance refuses remote clients. The holder keeps an instance
  listening while it can, one that a client came to and left included. A
  later instance takes on the pipe's descriptor, not its own, so the holder
  joins a later instance only if the pipe's owner and its list are the
  user's. The descriptor is the control. The holder never impersonates a
  client. The helper's own client opens the pipe with
  `SECURITY_IDENTIFICATION`; the app's client opens it at the level its
  runtime chooses, which would matter only to a holder that impersonates.
- **macOS and Linux:** the Unix socket `/tmp/aicc-<uid>/<sid>-<16 hex>.sock`,
  at most 75 bytes (a 10-digit user id, a 32-character session id), under the
  104 a socket path may have on macOS. The folder must be a real folder (not a
  link) owned by the user and is set to exactly 0700; the socket is 0600 from
  the moment it exists (it is bound under a umask of 0177). The holder serves
  a connection only when the peer's user id is its own (`SO_PEERCRED` on
  Linux, `getpeereid` on macOS; any other Unix serves none); one that is not is
  closed before a byte is written. The holder marks the socket and its folder
  as used every hour, so a cleaner of `/tmp` (systemd-tmpfiles takes entries
  untouched for 10 days) passes them by; if the socket is taken all the same,
  the holder binds the same name again within a quarter of a second, making
  the folder again with the same checks, and writes its record back if list
  mode removed it meanwhile.
- **What a client checks before it writes anything.** On Unix, with `lstat`
  (no link is followed): the folder is a folder, the user owns it, and its
  mode has no bit for the group or others (`mode & 0o077` is 0); the socket is
  a socket the user owns. The helper's own client also checks the peer's user
  id; the app's client cannot read it, so it relies on the folder and on the
  hello. On both OSes a client then reads the hello line and checks that it
  carries the record's `nonce` and `session` before it sends its first frame;
  a hello that does not marks a stale record, and the client closes without
  writing.

**The record.** `<store>/<sid>.json`, written whole (a temporary
`<sid>.json.<pid>.tmp`, then a rename), 0600 in a 0700 store on Unix. Exactly
these fields, in this order; the record of a holder that runs until it is
ended (from 2.1.3-beta.19) adds `lifetime` right after `away`, and its `away`
is `null`:

| Field | Meaning |
| --- | --- |
| `v` | 1 |
| `session`, `label` | the session id; the label given to `hold` |
| `pid` | the holder's process id |
| `endpoint` | the pipe or socket, of the shape above for this `session` |
| `nonce` | 32 lower-case hex: what the holder's hello carries |
| `helper` | the helper's version |
| `started` | when the holder started, milliseconds since 1970 (UTC) |
| `away` | the away clock, in seconds; `null` for a holder that runs until it is ended |
| `lifetime` | only in an until-ended holder's record: `until-ended` |
| `attached` | whether a connection is attached to the terminal |
| `child` | `waiting` (nothing launched), `running` or `exited` |
| `code` | `null`, then the program's exit code once `child` is `exited` |

Each field's range: `session` matches the session id pattern; `label` as
above; `pid` 1 to 2^32 - 1; `helper` 1 to 64 characters, none a control
character; `started` 0 to 2^53 - 1; `away` 1 to 86400, or `null` beside
`lifetime` `until-ended` (no other mix of the two shapes reads); `code` a whole number
from -2^31 to 2^32 - 1 (a Windows exit code is unsigned). A reader refuses a
record with any other field set, a field of another type or out of range, or
an endpoint that is not its session's. The record says where to connect; only
the hello proves it: the app connects, and the hello must carry the record's
`nonce` and `session`. `child` goes to `running` only from `waiting`, so an
exit recorded first is never written over, and each write of `attached` says
what is true at that moment.

The store's lock file, `<store>/.lock`, is never removed. It is held with the
OS's own file lock while a holder checks for a live holder of its session and
writes its record, while list mode removes a stale record, and while a holder
removes its own. So of two holders started for one session at the same moment
one finds the other's record and live endpoint and exits, and list mode never
removes a record that a new holder wrote in place of the stale one it asked
about.

**List mode.** `aicc-helper list --store <folder>` prints one line,
`{"v":1,"sessions":[...],"removed":<n>,"skipped":<n>}`, fields in that order;
`sessions` holds records, oldest `started` first, then by session id. This is
a local command of its own: it takes no `--nonce` and prints no `AICC-RESULT`
line, and the remote `list --nonce <n>` of section 4 is unchanged. A record
whose holder process is not running, or whose endpoint has nothing on it or
answers without the record's nonce, is stale: it is removed with its socket file
and counted in `removed`, under the store's lock and only if the record is
still the one it found stale. A file named like a record that is not a version
1 record is left alone and counted in `skipped`. A temporary file older than
60 s is removed. A holder that does not answer in time (2 s to connect, 3 s for
the whole hello line) is kept and listed; so is one whose socket takes no more
connections (a full backlog is a timeout, never "nothing there"). On Linux a
refused connection means nothing listens. macOS refuses a connection to a full
queue exactly as one to a socket with nothing on it, so there a refusal is
tried again until the 2 s are up and then counts as no answer. On macOS and
Windows, a record whose endpoint gives no answer is still stale when its
process id now names a process that started more than 60 s after the record's
`started`: a holder starts before it writes its record, so that id has been
given to another process. A holder started for the session treats such a
record the same way, and replaces it. Both OSes stamp a process with the time
it started, and no later change to the clock moves that stamp. macOS gives it
to any user for any process, root's included (the `kern.proc.pid` sysctl, as
`ps` reads it). The 60 s allow for the clock being set back in the moment
between a holder's start and its record. On macOS a process that got the id
within those 60 s is not caught: the record stays listed, and a holder started
for the session exits 3. macOS hands ids out in turn, so that is not likely.
On Windows a crashed holder's pipe is gone, which is already stale. Linux does
not use this rule. It gives a start only as ticks after the boot, and the boot
time moves with every change to the clock, so after the clock is set forward a
live holder could read as started after its own record. It does not need the
rule either: a crashed holder's socket there is refused or missing, and both
are stale. A missing store lists nothing and is not made. An until-ended
holder's record is listed with its `lifetime`.
The app uses list mode at start-up, to attach every held terminal again, and
for the Machines page. From 2.1.3-beta.15 it also runs it once at a start with
both helper settings off, no running mark and no agent record, when the
helper's per-user folder holds a version or staging folder: from the install
folder (a one-shot run, so no copy is made), and every version folder no
listed record's `helper` names goes, with the staging folders; a listing that
fails or does not read removes nothing.

**Reading one field (from 2.1.3-beta.19).** `aicc-helper field --file <path
under home> --key <dotted key>` (macOS and Linux; on Windows it prints
nothing) prints the string at the key and one line end, or nothing, and exits
0; it exits 2 on a command line it does not take. The path is relative to
`HOME`, or absolute inside it, every part a plain name; `HOME` is absolute and
not `/`. The file is opened as Claude Code opens it, a link followed, and must
then be a regular file of the user's own of at most 5 MiB; it is opened
without waiting and checked again once open. The key names object members
from the top, separated by dots: 1 to 16 parts, at most 256 bytes, no control
character; a member named twice on the way gives nothing. The value is a
string of 1 to 1024 bytes with no control character. It writes nothing. The
app's provider package names the file and the key.

**A connection.** The holder first writes its hello line, then a line end:
`caps` is `["core","local"]` in a holder from before hook events,
`["core","local","hooks"]` from 2.1.3-beta.8,
`["core","local","hooks","mcp"]` from 2.1.3-beta.10,
`["core","local","hooks","mcp","away","screen"]` from 2.1.3-beta.12 and
`["core","local","hooks","mcp","away","screen","title"]` from 2.1.3-beta.14 and
`["core","local","hooks","mcp","away","screen","title","status"]` from 2.1.3-beta.18, `session.state` is `new`
before a launch and `live` after. The app's first frame must be a `hello.ack` with
exactly `t`, `proto` and `caps`: `proto` 1, `caps` holding `core` and nothing
the holder did not offer; `local` allows the messages below, `hooks` the hook
events, `mcp` the tool streams, `away`, beside `mcp`, kept tool streams,
`screen` the screen reads and `title`, beside `screen`, the title in them, and
`status` the status line (all below). A first frame that is raw, or
JSON off channel 0, gets `bad-frame`; another type `unknown-type`, another
version `proto-mismatch`, anything else `bad-field`; then the holder closes the
connection. With no `hello.ack` in 10 s it sends `timeout` and
closes; after that, with no frame from the app in 60 s it sends `timeout` and
closes (the app pings every 15 s). Each limit is for the whole frame: one sent
a byte at a time must still be whole in time. A frame's JSON is at most 4 KiB
before the `hello.ack`, at most 64 KiB once the session is launched or a launch
is under way (on a connection that acked `mcp`, which may carry a tool result,
16 MiB then too), and otherwise 16 MiB as section 6 allows: a larger one is
`bad-frame` and a close, refused on its header before its payload is read, and
a payload's buffer grows only as its bytes arrive. At most 16 connections at
once: the next one gets the hello, `busy`, and is closed. When the holder
closes a connection after a last message (an `error`, `term.detached`,
`term.ended`, `term.exit`), it stops writing first, so the app reads that
message and then the end of the stream; the app then closes its end (the
holder cuts the connection 2 s later regardless). A write that has not finished
in 5 s closes the connection; the 5 s are for the whole message, however slowly
the app reads it. A type the connection does not allow gets `unknown-type` and
a close; 20 `bad-field` or `too-large` replies in 60 s are allowed, the next
one closes.

Which errors close the connection here (for the local transport this replaces
the last column of section 8's table):

| Error code | Closes |
| --- | --- |
| `bad-frame`, `unknown-type`, `proto-mismatch`, `replaced` | yes |
| `timeout` | yes: no `hello.ack` in 10 s, or no frame in 60 s |
| `bad-field` | yes for the first frame; otherwise no, within the budget of 20 in 60 s |
| `too-large` | no, within that budget |
| `busy` | yes when 16 connections are served already, the connection fell 256 chunks behind, or no thread could be started to carry its live output; no for typed input not taken, a second launch or a ninth tool stream |
| `not-found`, `not-connected`, `io` | no |

| Type | Reply | Fields and rules |
| --- | --- | --- |
| `term.launch` | `term.launched` `{re, pid}` | `{id, argv, cwd, env, cols, rows}`, `hookKinds` if wanted (from 2.1.3-beta.18), and on Windows `line` and `conpty` if wanted (below); once per holder, then `busy`; a program that does not start gets `io`, and a later launch may try again; while the session is ending, `not-found` |
| `term.attach` | `term.attached` `{re, from, ring_start, ring_end, truncated, running, code?}` | `{id, from}`; then the output from `from` on channel 1, then live output; before a launch, or while the session is ending, `not-found` |
| `term.resize` | `term.resized` `{re}` | `{id, cols, rows}`; only the attached connection, else `not-connected` |
| `term.detach` | `term.detached` `{re}` | `{id}`; only the attached connection, else `not-connected`; the holder then closes the connection and the session keeps running |
| `term.end` | `term.ended` `{re, code?}` | `{id}`; ends the session's whole process tree, removes the record and the endpoint, and the holder exits; a `term.end` from another connection while the session is ending gets its own `term.ended` |
| `term.exit` | none | `{code}`, from the holder to the attached connection, once: after the program's last output, and also when another connection ended the session, which then closes this one |
| `hook.event` | `hook.taken` `{re, seq}` | `{id, kind, payload}`; only on a connection that acked `hooks`, attached or not; while the session is ending, `not-found` (hook events, below) |
| `event` | none | `{seq, kind, payload, lost?}`, from the holder to the attached connection, only if that connection acked `hooks` (hook events, below) |
| `status.set` | `status.taken` `{re, seq}` | `{id, payload}`; only on a connection that acked `status`, attached or not; while the session is ending, `not-found` (the status line, below) |
| `status` | none | `{seq, payload}`, from the holder to each connection that acked `status` beside `local` (the status line, below) |
| `mcp.open` | none | `{stream}`; from a relay that is not attached, for its one stream, and from the holder to the attached connection that acked `mcp`, on the holder's number for it, for a new stream or a kept one it is given; with no such connection, `not-connected`, or `mcp.away` for a relay that acked `away` while the program runs (tool streams, below) |
| `mcp` | none | `{stream, message}`, one JSON-RPC message: from a relay on its stream, and from the attached connection on a stream it was sent `mcp.open` for; each passed to the other side on that side's number; from a relay while its stream is kept, `not-connected` (tool streams, below) |
| `mcp.close` | none | `{stream}`; from a relay, and from the holder to whichever side is still there when the other ends (tool streams, below) |
| `mcp.away` | none | `{stream}`, from the holder to a relay that acked `away`, on the relay's number: no connection takes its stream now, and the stream is kept (kept streams, below) |
| `mcp.back` | none | `{stream}`, from the holder to a relay that acked `away`, on the relay's number: a connection takes its kept stream again (kept streams, below) |
| `screen.read` | `screen.rows` `{re, cols, rows, cursor, modes, title?, cut, lines}` | `{id}`; only on a connection that acked `screen`, attached or not, and never from a relay (`unknown-type`); `title` only on a connection that acked `title` too; before a launch, or while the session is ending, `not-found` (screen reads, below) |
| `screen.tail` | `screen.lines` `{re, cut, lines}` | `{id, count}`, `count` from 1 to 200; as `screen.read` (screen reads, below) |

Ids are even, as in section 9, and at most 2^53 - 1. Every message has exactly
its fields; `code` is present only once the program has exited. The tool
stream messages carry no id: a refusal of one has no `re`.

- **Launch.** `argv` holds 1 to 256 strings of at most 8192 characters, none
  with a NUL character; `argv[0]` is an absolute path (no search of `PATH`).
  `cwd` is an absolute path of at most 4096 characters. `env` is an object of
  strings and is the program's whole environment: nothing of the holder's own
  is added, except `TERM=xterm-256color` on macOS and Linux when `env` has no
  `TERM`. It has at most 1024 entries; a name is 1 to 255 characters with no
  `=` or NUL character, a value at most 32767 characters with no NUL
  character, and two names that differ only in case are refused on every OS.
  `cols` and `rows` are whole numbers from 1 to 1000.
- **Launch on Windows: `line` and `conpty`.** A launch may carry two more
  fields, on Windows only; on macOS and Linux either is `bad-field`, and a
  holder from before them refuses either with `bad-field` too.
  `line` is the exact command line the program reads (`CreateProcessW`'s
  `lpCommandLine`), for a program that reads its line in a way no argument
  list can say, such as `cmd.exe /d /s /c` running an npm `.cmd` file.
  `CreateProcessW` starts the program at `argv[0]`, by that exact path with
  no search (`lpApplicationName`), so with `line`, `argv` holds that program
  alone. `line` is only the text that program reads: a command interpreter
  runs what its line says, so `line` gives nothing `argv` could not already
  say. `argv[0]` may not be a batch file (a name ending in `.bat` or `.cmd`,
  in any case, once trailing dots and spaces are dropped): Windows starts a
  batch file through cmd.exe, which would read the line as commands. The
  name checked must be the name Windows opens, so with `line`, `argv[0]` may
  not end in `\` or `/` or have a part made only of dots and spaces, such as
  `.` or `..`, which Windows resolves before it opens the file
  (`C:\x\tool.cmd\.` opens `C:\x\tool.cmd`; a `\\.\` path is refused too).
  The holder checks these rules once more on the full name Windows makes of
  `argv[0]` (`GetFullPathNameW`). `line` is 1 to 32766 UTF-16 units long
  with no NUL character (Windows takes a command line of at most 32767
  units, counting the NUL that ends it): a longer one is `too-large`; an
  empty one, one with NUL, one that is not a string, one with more than the
  program in `argv`, or one for a batch file or a name Windows would change
  is `bad-field`.
  `conpty` is `"bundled"`, or left out for Windows' own ConPTY; any other
  value is `bad-field`. With it, the terminal runs on the `conpty.dll` in a
  `conpty` folder beside the helper's own program file, which starts the
  `OpenConsole.exe` beside it; no path in a message is ever used. The folder
  and both files must be plain (not a link or another reparse point), and
  the holder keeps all three open from that check until the pseudoconsole is
  made: neither file can be written, renamed or removed, and the folder
  cannot be renamed or removed, between the check and the pseudoconsole's
  making; files can still be added to the folder. It
  loads the library by its full path with `LoadLibraryExW`, searching only
  its folder and System32 for what it needs
  (`LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR` and `LOAD_LIBRARY_SEARCH_SYSTEM32`), and
  makes three of node-pty's calls on it: `ConptyCreatePseudoConsole`,
  `ConptyResizePseudoConsole` and `ConptyClosePseudoConsole`.
  `ConptyReleasePseudoConsole`, which node-pty calls after the start, is not
  made, so a session ends as it does on Windows' own ConPTY: when the program
  exits, the holder closes the pseudoconsole. When the folder or a file is
  missing or not plain, or the library does not load or lacks one of those
  calls, the launch gets `io` and nothing is started; a library that lacks a
  call is unloaded again, and a later launch may try again. The app's install
  code can put node-pty's two files in that folder of its copy of the helper
  and check them against node-pty's own before each use, as it checks the
  helper. The app does not yet send either field or copy those files.
- **Launch: `hookKinds`** (from 2.1.3-beta.18). A launch may declare the hook
  kinds its session takes: an array of at most 16 plain words, each 1 to 64
  ASCII letters or digits, none given twice; an empty array is a session that
  takes none. More than 16 words, or a word over 64 characters, is
  `too-large`; any other break of that shape is `bad-field`. A holder launched
  with it takes a `hook.event` of those kinds only (another kind is
  `bad-field`); one launched without it, and a holder not yet launched, takes
  the nine, as before. A holder from before 2.1.3-beta.18 refuses the field
  with `bad-field`; a holder whose hello offers `status` takes it.
- **Attach.** `from` is an offset in the output, as in section 11: past
  `ring_end` is `bad-field`; older than the ring holds is answered from
  `ring_start` with `truncated` true. The app on This computer then holds the
  replay to its end and shows a line of its own saying earlier output is not
  shown, then the last of the replay that the tab keeps, with the screen and
  input modes the part it leaves out set, and, while the
  program runs, asks it to redraw by a resize at the tab's size on the
  console built into Windows, else one row shorter and back (section 11);
  it does not yet restore the screen in use or the
  input modes set before `ring_start`. Typed input goes to the holder as raw
  frames on channel 1, accepted only from the attached connection: raw bytes on
  any other connection or channel are `bad-frame` and a close. Typed input is
  queued for the program and never waited on: while at most 64 frames of typed
  input wait (the program has stopped reading), more gets `busy` and is not
  taken. The program must never see input with a gap in it, so once one frame
  is refused, every later raw frame on that connection is refused too, each
  with a `busy` of its own, in order, until the app's next `ping`. The app
  keeps each raw frame to at most 64 KiB, sends a `ping` after every 16 frames
  or 1 MiB of typed input, and waits for its `pong` before it sends more.
  When the `pong` comes, the number of `busy` replies before it is the number
  of frames not taken, the last ones before the `ping`: the app sends them
  again. When the stream ends before the `pong`, the app cannot tell which of
  those frames were taken (a `busy` just before the end may be the one a
  connection that fell behind gets, below, not a refusal of input). It sends
  none of them again, so nothing is ever typed twice, and attaches again from
  the last offset it saw: the replay shows what reached the program. A newer
  attach, from any connection, takes the terminal: the older
  connection gets `replaced` and is closed. An attach again on the same
  connection drops what was still queued for the earlier one: after its reply
  comes only the output from its `from`. Nothing live follows `term.detached`
  or `term.ended`. A connection that falls 256 chunks behind the output gets
  `busy` and is closed; it attaches again from the last offset it saw. After
  the program has exited an attach still replays, with `running` false and
  `code`, and nothing live follows.
- **The whole tree.** On Windows the program starts suspended inside a job
  object that ends every process in it when the job closes, so its children
  are ended with it, even if the holder itself is killed. On macOS and Linux it
  leads a new session and process group; ending sends hangup to that group and
  to every other process in the session (a shell puts each job in a group of
  its own), and kill after 2 s. A process that left the session itself (a
  daemon that called setsid) is not reached, as a closed terminal would not
  reach it. Once the program has been reaped and nothing is left in its
  session (or all of it was sent a kill), the holder sends that session no
  signal again: its id may by then name another process. When the program
  exits on its own, the rest of its tree is ended the same way; that is a
  choice, so that no process is left running with no terminal and no holder
  to reach it. The holder stays, so the app can read the last output and the
  exit code: it waits up to 2 s for the output that is still coming before it
  reports the exit.
- **The away clock.** With no connection attached, the holder ends its session
  after `away` seconds, counted from its start, from each detach and from each
  attached connection that drops. An attach stops the clock. The clock and an
  attach or a launch are settled under one lock, so an attach at the moment the
  clock runs out either stops it or gets `not-found`, never `term.attached` and
  then the end. A holder that ends this way removes its record and its
  endpoint, as `term.end` does.
- **Until it is ended (from 2.1.3-beta.19, protocol change 14).** A holder
  started with `--until-ended` has no away clock. With nobody attached it ends
  once its program has exited; until an app has attached for the first time,
  no sooner than the default 120 s after its start, and one never launched
  ends at that time too. An app attached at the exit is told (`term.exit`),
  and the holder ends when that app lets go. It also ends at `term.end`, or
  with the machine. While nobody is attached it keeps the newest status,
  queues hook events and keeps a relay's stream, as any holder does. Every
  clock is monotonic, never the wall clock.

**Hook events (capability `hooks`, from 2.1.3-beta.8).** This local `hooks` is
only `hook.event` and `event` on a holder's own endpoint; the remote `hooks`
of section 8 (R7) is a separate capability that also carries
`session.prepare`. A Claude Code session's hooks can reach the app through its
holder instead of the hooks gateway. A holder from 2.1.3-beta.8 offers `hooks`
in its hello. The app acks `["core","local","hooks"]` only on the connections
of a Claude Code session, or (from 2.1.3-beta.18) a Codex session, it started
through the holder (the agent sessions' setting, off by default), and only
when the hello offers `hooks`; every other connection acks `["core","local"]`
and is never sent a hook event. For such a Claude Code session, while the
hooks gateway is on and listening, the app switches the session's settings
file to the hook mode for every injected event, `PreToolUse` included (from
2.1.3-beta.14; before it `PreToolUse` stayed on the hooks gateway), once the
holder answers `term.launched` and before the attach sends the launch line; a
holder without `hooks` leaves the session on the gateway.

From 2.1.3-beta.18 a held Codex session's hooks go through its holder too.
Codex runs one hook command for every session, and keys its trust on the
command's text, so the app switches no file. The launch its holder runs
carries `hookKinds` (`SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `PermissionRequest`, `Stop`) and, in its environment,
`AICC_HELPER_PATH` (the helper copy), `AICC_HELPER_STORE` and
`AICC_HELPER_SESSION`. These are sent only to a holder that offers `hooks` and
`status`. The app's forwarder (`scripts/ccc-codex-hook.js`) runs
`<AICC_HELPER_PATH> hook` with the event on its standard input, only when that
path's real path is this user's helper copy as the app lays it out (no link at
any level the app made, one name), the store is that helper folder's `store`
and the session has the helper's shape; otherwise it does nothing. A Codex
session that is not held keeps its hook file and the gateway.

The app reads each `event` strictly (on channel 0 only, its fields only, `seq`
from 1, `kind` one of the kinds the session's launch declared (`hookKinds`),
or of the nine when it declared none (from 2.1.3-beta.18), and the payload's
`hook_event_name`, the payload at most 65,280 bytes and the message at most
64 KiB), drops a `seq` it has seen (an app before 2.1.3-beta.14 also dropped a
`PreToolUse`), takes none while the hooks gateway is off or not listening, and
treats the payload as untrusted text. Fixtures: the `hooks` part of
`helper/fixtures/local.json`.

- **The hook mode.** A CLI runs, as a command hook,

  ```
  aicc-helper hook --store <folder> --session <sid>
  ```

  and writes the event as JSON on its standard input. Either option may be
  left out (from 2.1.3-beta.18): the store is then read from the variable
  `AICC_HELPER_STORE` and the session from `AICC_HELPER_SESSION`; an option
  given wins over its variable, and a variable that is empty or not Unicode
  counts as left out. The hook mode reads its standard input to the end and
  keeps at most 4 MiB: a larger event is lost. The input must be a JSON
  object, at most 32 levels deep, whose `hook_event_name` is one plain word
  of 1 to 64 ASCII letters or digits (from 2.1.3-beta.18; before it, one of
  the nine kinds the app injects: `PreToolUse`, `PostToolUse`,
  `Notification`, `SessionStart`, `Stop`, `UserPromptSubmit`,
  `SubagentStart`, `SubagentStop` and `StopFailure`): which kinds a session
  takes is its holder's to decide (`hookKinds`, above), and a kind it does
  not take is answered `bad-field` and lost, and that names none of its own
  members twice (the helper would
  read the first, the app's `JSON.parse` the last). A `\u` escape of a code
  unit from D800 to DFFF that is not half of a pair, which Node writes when a
  string is cut inside a pair (a tool's output cut in the middle of an
  emoji), reads as U+FFFD, the replacement character, rather than losing the
  event. It reads the session's record with the store's strict reader and
  connects with the helper's own client, as list mode does: the endpoint's
  checks above, then the hello's `nonce` and `session`. A holder whose hello
  does not offer `hooks` (one from before 2.1.3-beta.8) is sent nothing, not
  even the ack. Otherwise the hook mode sends `hello.ack` with `caps`
  `["core","local","hooks"]` and one `hook.event`, and waits for the reply.
  All of it is done within 2 s of its start. It always exits 0 and never
  writes to standard output or standard error: Claude Code adds what a
  SessionStart or UserPromptSubmit hook prints to the conversation, and an
  exit other than 0 (2 above all) changes what the CLI does. Whatever fails
  (no store, a session id that breaks its pattern, an argument that is not
  Unicode, a record whose holder is gone, `busy`, input whose
  `hook_event_name` is not a plain word, a kind the holder does not take or
  names a member twice, input over 32 levels deep, no reply
  in time) loses that one event, silently. The hook mode writes no file (a
  stale record is left as it is, not removed as list mode removes it) and
  starts no process.
- **The payload** is the event as Claude Code wrote it, sent as compact JSON.
  It is kept as it is when it is at most 48 KiB and at most 31 levels deep
  (the message that carries it is then at most 32). Otherwise `tool_input`
  and `tool_response` become `{"cut": <bytes>}`, the size of what they held
  as JSON, every other string whose JSON (quotes and escapes counted) is
  over 4 KiB is cut, at a character boundary, to its longest beginning that
  is not, and the payload gains `"cut": true` (in place of a `cut` member of
  its own), so a string cut here does not pass for whole. If that is still
  too large or too deep, only `hook_event_name`, `session_id`,
  `transcript_path`, `cwd` and `tool_name` stay, those that are strings,
  with `"cut": true`: about 21 KiB at most. So a `hook.event` from the hook
  mode always fits the 64 KiB a frame may hold once the session is launched.
- **`hook.event`** `{id, kind, payload}`: `kind` a kind the session takes
  (those its launch declared in `hookKinds`, or the nine), `payload` a JSON
  object of at most 65,280 bytes as compact JSON (64 KiB less 256, the
  room the `event` around it needs) that names none of its own members twice
  and whose `hook_event_name` is `kind`. Any connection whose `hello.ack`
  named `hooks` may send it, attached to the terminal or not, within the
  limits above (16 connections, the budget of 20 `bad-field` or `too-large`
  replies in 60 s, the frame's JSON limit). A kind the session does not take; a
  payload that is not an object, names a member twice or whose
  `hook_event_name` is not `kind`; or a field missing, unknown or given
  twice is `bad-field`. A larger payload is `too-large`, before a launch and
  after it, while the frame carrying it is within the frame's JSON limit; a
  frame over that limit (64 KiB once the session is launched) is `bad-frame`
  and a close, as above, whatever it carries. On a connection that did not
  ack `hooks` it is `unknown-type` and a close. The reply is `hook.taken`
  `{re, seq}`. The holder only numbers the event and passes it on: it runs,
  opens and writes nothing for it.
- **`event`** `{seq, kind, payload, lost?}`, from the holder, on channel 0, at
  most 64 KiB of JSON: its payload is at most 65,280 bytes and the rest at
  most 105. Each `hook.event` takes the session's next `seq`, from 1. It goes
  at once to the attached connection if that connection acked `hooks`; a
  connection that did not is never sent one. With no such connection attached,
  events wait in a queue of at most 256 events and 2 MiB of payload, the
  oldest dropped first; the next event sent carries `lost`, the number dropped
  before it, and an event with nothing dropped before it has no `lost`. A
  connection that acked `hooks` gets every waiting event right after its
  `term.attached` reply and replay, before any live output, then each new one
  at once; the waiting events go within 5 s in all, and a connection that does
  not take them in that time is closed while they wait on. No event follows
  `term.detached`, `replaced`, `term.exit`, `term.ended`, or either `busy` an
  attach can end with (the connection fell too far behind, or no thread could
  carry its output): one that comes later waits for the next attach. At an
  app update the app lets go of each connection that acked `hooks` with
  `term.detach`, not a close, and reads the events the holder sent before the
  answer (2.1.3-beta.17, B1f): a Windows named pipe has no half-close, so a
  connection the app only closes stays attached until the app's handle
  closes, and each event written to it meanwhile counts as sent. From
  2.1.3-beta.17 the app's keeper of a session kept for a restored tab not yet
  shown acks `hooks`, so the holder hands it the queue then; the take-over's
  connection gets only what came after. An event
  whose send failed waits for the next attach, and the app drops a `seq` it
  has already seen (section 9). A holder that ends drops its queue.

**The status line (capability `status`, from 2.1.3-beta.18).** A session's
status line can reach the app through its holder. A holder from 2.1.3-beta.18
offers `status`, last in its hello. The holder only numbers a status and
passes the newest on: it runs, opens and writes nothing for one. Fixtures: the
`status` part of `helper/fixtures/local.json`.

- **The status mode.** A CLI runs, as its status line command,
  `aicc-helper status [--store <folder>] [--session <sid>]` (an option left
  out is read as the hook mode reads it) and writes the status as JSON on its
  standard input. The status mode reads that to the end and keeps at most
  4 MiB. It sends the status only when it is one JSON object, at most 31
  levels deep, that names none of its own members twice, of at most 65,280
  bytes as compact JSON; nothing is cut. An escaped lone surrogate reads as
  U+FFFD, as in the hook mode. It reads the session's record and connects as
  the hook mode does; a holder whose hello does not offer `status` is sent
  nothing. Otherwise it sends `hello.ack` with `caps` `["core","status"]` and
  one `status.set`, and waits for the reply. All of it is done within 2 s of
  its start. It always exits 0 and never writes to standard output or
  standard error; whatever fails loses that one update, silently, and the
  next carries the whole status again.
- **`status.set`** `{id, payload}`: `payload` a JSON object of at most 65,280
  bytes as compact JSON that names none of its own members twice. Any
  connection whose `hello.ack` named `status` may send it, attached or not;
  on one that did not it is `unknown-type` and a close. A larger payload is
  `too-large`; one that is not an object or names a member twice, or a field
  missing, unknown or given twice, is `bad-field`. The reply is
  `status.taken` `{re, seq}`; while the session is ending, `not-found`.
- **`status`** `{seq, payload}`, from the holder, on channel 0, at most
  65,332 bytes of JSON. The holder keeps the newest status only, in one slot:
  each `status.set` takes the session's next status `seq`, from 1 (its own
  count, apart from the hook events'), and replaces the one before. It goes
  to each connection whose `hello.ack` named `status` beside `local` (an
  app's connection; one that acked `status` without `local`, as the status
  mode does, posts and is sent none): the newest the holder holds once, right
  after that connection's ack, before anything else it is sent, then each
  newer one, in rounds that begin at least 100 ms apart (10 a second for the
  session, section 12), the newest posted between two rounds going and the
  ones before it not. A connection is never sent a `seq` twice, nor an older
  one after a newer. No status follows `term.detached`, `replaced`,
  `term.exit`, `term.ended`, or either `busy` an attach can end with. The app
  drops a `seq` it has already seen. A holder that ends drops its status.

**Tool streams (capability `mcp`, from 2.1.3-beta.10).** A session's tool
server can be a relay that its CLI starts, carrying the session's tool calls
through its holder to the app, so the Conductor tools no longer depend on a
port of one app run. These are the three messages section 8 names for R8, on
a holder's own endpoint. A holder from 2.1.3-beta.10 offers `mcp` in its
hello. From 2.1.3-beta.11 the app acks it and names the relay to a held
session's CLI, behind the agent sessions' setting ("What the app wires",
below). The holder only numbers a stream
and passes its messages on: it reads no message, and runs, opens and writes
nothing for one. Fixtures: the `mcp` part of `helper/fixtures/local.json`, and
for kept streams (capability `away`, from 2.1.3-beta.12, the tool half of
protocol change 9) its `away` part.

- **The relay mode.** A CLI starts, as a tool server on its standard input
  and output,

  ```
  aicc-helper mcp --store <folder> --session <sid>
  ```

  as its own child, with pipes and no shell. The store and session come from
  the command line alone, never from the environment, which a CLI may pass
  almost none of. The relay reads the session's record with the store's
  strict reader and connects with the helper's own client, as list mode and
  the hook mode do: the endpoint's checks above, then the hello's `nonce` and
  `session`, with 2 s to connect and 2 s for the whole hello line. A holder
  whose hello does not offer `mcp` (one
  from before 2.1.3-beta.10) is sent nothing, not even the ack. Otherwise the
  relay sends `hello.ack` with `caps` `["core","local","mcp"]`, and
  `["core","local","mcp","away"]` when the hello offers `away` (a holder
  from before 2.1.3-beta.12 is sent nothing new), `mcp.open`
  for its one stream, number 1, and a `ping`: the holder answers a
  connection's messages in order, so the `pong` says the open was taken (a
  refusal comes before it), and the relay reads nothing on standard input
  until it comes, 10 s at most. Then it sends each line it reads as one
  `mcp`, and writes the message of each `mcp` the holder sends on that stream
  as one line on standard output, as compact JSON. It passes whatever method
  comes, in the order it came, and waits for no `initialize`. It pings when
  it has sent nothing for 15 s, so the connection is not dropped as idle.
  With `away` acked it holds and answers some calls while the app is away
  (kept streams, below). Standard output is written
  by a thread of its own, so the relay sees the end of its stream even while
  the CLI is not reading; at most 64 MiB of lines wait for the CLI (one more
  and the relay exits 1), and once the holder ends the stream or the
  connection is lost those still waiting have 5 s to go; at the end of its
  input the relay exits at once and drops them.
  A line that is not one JSON object or array (an empty line, text that is
  not JSON, a value more than 31 levels deep, an escaped lone surrogate), or
  whose message is over 1,048,320 bytes as compact JSON, is dropped and the
  next line read; a line over 1 MiB is read to its end and dropped the same
  way. It exits 0 when its standard input ends, after `mcp.close`. It exits 1
  as soon as its stream cannot be had or cannot go on: a command line it does
  not take, no record or no holder, a holder without `mcp`, `not-connected`
  to its open, `busy`, no `pong` to the open in time, an `mcp.close` from the
  holder, any other `error` but `too-large` (and, with `away` acked, but a
  `not-connected` once the stream is had, which refused one message), a CLI
  64 MiB behind, or the connection lost.
  An input that ends at once still exits 1 when the stream was never had.
  Standard output carries only the messages: it
  prints nothing else, writes nothing on standard error and writes no file.
- **`mcp.open`** `{stream}`, from a connection that acked `mcp` and is not
  attached to the terminal, for the one stream it may have open at a time
  (`stream` its own number for it, a whole number from 1 to 2^53 - 1). From
  then on that connection is a relay for the rest of its life: a
  `term.launch`, `term.attach`, `term.resize`, `term.detach` or `term.end`
  from it is `unknown-type` and a close, as raw bytes from it are
  `bad-frame` and a close. An attached connection opens no stream
  (`bad-field`), nor a relay a second one while one is open (`bad-field`).
  The holder numbers each stream itself, from 1, never using a number twice
  in its life, and sends `mcp.open` with its number to the attached
  connection that acked `mcp`. With no such connection attached the answer
  is `not-connected` (a relay that acked `away` has its stream kept instead,
  below); with 8 streams open, kept ones among them, `busy`. Neither refusal
  takes a number.
  Only an attach that carries live output takes tool streams: one that only
  replays a program that has exited takes none, and ends any its connection
  had.
- **`mcp`** `{stream, message}`: `message` is a JSON object (one JSON-RPC
  message) or an array (a batch). From a relay, on its stream, it goes to the
  attached connection on the holder's number; its message is at most
  1,048,320 bytes as compact JSON (1 MiB less 256, the room the `mcp` around
  it needs), or it is `too-large` and nothing is passed on, while the stream
  goes on. From the attached connection, on a stream it was sent `mcp.open`
  for, it goes to that stream's relay on the relay's number; its message is
  at most 16,776,960 bytes (16 MiB less 256), or it is `too-large`. A number
  that is not one of the sender's open streams is `not-found`. Each side
  sees only its own number for a stream, so neither can name another's.
- **`mcp.close`** `{stream}`: from a relay, its stream ends and the attached
  connection is told (`mcp.close`, on the holder's number). A relay whose
  connection goes without it (a CLI's end does not always end its tool
  server's input) ends its stream the same way. The attached connection does
  not send it (`not-found`): its streams end with its attach. When it lets
  go (`term.detach`, a newer attach, `term.exit`, falling behind or no thread
  for its output, a dropped connection) every stream it carried ends and
  each relay is told, on the relay's number, except a stream whose relay
  acked `away`, which is kept (below); it is not told itself, and no tool
  message follows its last word, as no hook event does. A holder that ends
  tells no one: each relay reads the end of its connection.
- **What the app wires (2.1.3-beta.11).** With the agent sessions' setting
  on (it is off by default), each connection of a held agent session acks
  `mcp`, and the session's CLI is given the relay as its `conductor` tool
  server: the helper copy's path, then `mcp --store <folder> --session
  <sid>`. A Claude Code session's per-session MCP config file is switched to
  it once the holder launched the session and before its launch line is
  typed; a CLI that names its tool servers in its launch flags gets it in the
  launch the holder runs instead, in place of the loopback address, its
  switch and its credential variable. The server keeps its name, so the
  tools a session is allowed and their approvals apply unchanged. The app
  serves a stream only for a session it switched, under the tab's id, and
  only while its tool server is started. A session that cannot be switched
  (no `mcp` in its holder's hello, the helper copy not known, the tool
  server not started, no conductor entry of the app's in the file or the
  launch, the file not written, a path that cannot be given exactly, a
  launch through cmd.exe whose quoting rule cannot carry the relay's
  arguments, or a relay form the helper would refuse) keeps the
  loopback route, with one log line. A run of the app's own is never
  switched.
- **Kept streams (capability `away`, from 2.1.3-beta.12).** A holder offers
  `away`, and only a relay acks it, beside `mcp` (without `mcp` it keeps
  nothing). For a stream whose relay acked it, while the session's program
  runs: when the attached connection lets go, the stream is kept with no app
  side and its relay is sent `mcp.away` on its number, in place of
  `mcp.close`; and an `mcp.open` while no connection takes tool streams is
  taken, numbered and kept the same way, and answered `mcp.away` in place of
  `not-connected`. A kept stream counts toward the 8. An `mcp` from its relay
  is `not-connected` and the stream goes on, as is one the holder reads after
  the stream left the app it was with. The next attach that takes tool
  streams (it acked `mcp` and carries live output) is given every kept
  stream: `mcp.open` on the holder's number, as for a new one, in the order
  they were opened, then `mcp.back` to each relay on its number. A stream
  kept just after such an attach took tool streams (the connection it was
  with let go at that moment) is given to it the same way within a quarter
  of a second. A relay that did not ack `away` is served as before. A session keeps nothing past its
  program: once the program has exited each kept stream ends, its relay told
  `mcp.close` within a quarter of a second, and an `mcp.open` before the
  launch or after the exit is `not-connected`, `away` or not. A kept stream
  does not hold the session open: the away clock runs as it does without one.
- **The relay while away.** With `away` acked, of each message it passes the
  relay reads whether it is a call (an object with an `id`, a string or a
  number, and a `method`, a string) and that call's `id` and `method`, and of
  each message from the app whether it is an answer (an object with an `id`
  and no `method`) and its `id`: nothing more, and every message goes on
  exactly as it came. A call passed to the app and not yet answered is
  remembered by its id, 64 at most (past that the oldest is forgotten and
  falls to the CLI's own timeout), and the app's answer clears it, as does a
  cancel (`notifications/cancelled`) the CLI sends for it; a batch
  is no call, so the calls in one are not remembered. Only an id
  that is a string, or a whole number written in plain digits, at most 15 of
  them, is remembered, as only such an id comes back from the app as it went.
  On `mcp.away` each remembered call is answered at once with the fixed
  answer below: it reached an app that is gone, and it is never sent a second
  time, as a tool call may not be safe to repeat; an answer the app sends to
  one all the same is dropped. From then on a call read from the CLI is held,
  not sent: at most 32 calls and 4 MiB of them (as compact JSON) wait, and a
  call past either is answered at once. Each held call has 30 s, then gets the
  fixed answer and is dropped (4 s in a build with debug assertions, the one
  the helper's tests run; the installers carry the release build). Anything
  else read meanwhile is dropped, except a cancel
  (`notifications/cancelled`) of a held call, which drops that call with no
  answer. A batch (an array) is answered at once, with one array of the fixed
  answer to each call in it, and never held. On `mcp.back` the held calls go
  to the holder in the order they came, and then everything is as before. The
  fixed answer has ADR-030 D1's words. To `tools/call` it is a result the
  model reads,
  `{"jsonrpc":"2.0","id":<id>,"result":{"content":[{"type":"text","text":"AI Code Conductor is updating, try again shortly"}],"isError":true}}`;
  to any other call, a JSON-RPC error,
  `{"jsonrpc":"2.0","id":<id>,"error":{"code":-32603,"message":"AI Code Conductor is updating, try again shortly"}}`.
  The relay's exits stay: 0 at the end of its input, 1 when its stream ends
  from the holder's side or the connection is lost.
- **What is not here yet.** A kept stream is given to the next attach of the
  same holder, which within one run of the app is the app again: it attaches
  by itself after a dropped link. From 2.1.3-beta.17 it is given to a new
  run of the app too, after an update on Windows: the update lets a held
  agent session's CLI run on and records it (S16 step 4), the next start
  keeps it for its restored tab, and that tab's attach is given each kept
  stream (step 5); on such a stream the tool host first sends
  `notifications/tools/list_changed` to a CLI that lists its tools again
  (Claude Code; step 6). From 2.1.3-beta.17 (B1d) the next start serves a
  session kept for a restored tab that is not shown yet. 3 s after Resume its
  keeper attaches again with mcp, so the holder gives it the kept streams,
  and the app serves them under the tab's id. The tab's take-over attaches in
  its place later, and the streams are given to it in turn. A call in flight
  at that moment is answered with an error, and a retry works. Elsewhere an
  update ends every agent session, and
  after a crash an agent session is not shown again. A relay that did not ack `away` (its holder does not offer it) whose
  stream ended stays ended: when the app's connection to a session's holder
  drops and comes back, that session's CLI has no tool server until it
  starts one again (in Claude Code, /mcp) or the session is restarted. Nothing tells a
  CLI that its tool list changed after the app came back. The app's side,
  when it sends `mcp`, must keep each message to what the holder reads: JSON
  with no escaped lone surrogate and at most 31 levels deep, or the frame is
  `bad-frame` and its connection is closed.

**Screen reads (capability `screen`, from 2.1.3-beta.12).** Protocol change 5
(ADR-030), written by the slice that first uses it. The holder keeps the
session's screen: every byte of output goes to the ring first, and then to a
screen of the session's size with 200 lines of scrollback, for the session's
whole life, attached or not; a resize resizes both. A connection that acked
`screen` asks about it with two read-only requests, answered from that
screen whether or not the connection is the attached one. Neither attaches,
types, resizes or ends; neither moves an offset, replays anything or changes
which connection is attached; and the holder decides nothing from what a
screen shows (ADR-030 row 4). A relay (a connection that opened a tool
stream) asks for neither: `unknown-type` and a close, as for the terminal
messages. From 2.1.3-beta.13 a plain terminal's connections ack `screen`,
and a take-over asks `screen.read` once, before its attach, for the
holder's size: its replay waits for the tab to be at that size, and from
2.1.3-beta.15 is written at that size when the tab does not get there
(src/main/session-helper/helper-pty.ts). From 2.1.3-beta.14 a held Codex
session's connections ack `screen` and `title`, and the app's composer rule
for that session reads `screen.read` each time it looks, in place of a pane of
its own (src/main/providers/codex/session-screen.ts). From 2.1.3-beta.15 only
a connection that acked both reads it: one that acked `screen` alone (a holder
that offers no `title`) gets main's own pane, since the title's spinner is the
rule's only busy sign while a reply streams. Nothing else in the app asks yet.

- **`screen.read`** `{id}` is answered `screen.rows`: `cols` and `rows`, the
  screen's size; `cursor` `{row, col}`, the cursor's cell from 0 (its column
  is `cols` while a wrap is pending after the last cell was written);
  `modes`; `title`, only on a connection that acked `title` (below); `cut`;
  and `lines`, the rows of the screen in use from its top,
  below any scrollback. Each row is what the app's readers take from a row
  of xterm.js (`readXtermScreen`): `text`, the row's characters (an empty
  cell a space); `typed`, the same with every dim cell blanked; `inverse`,
  the same with every cell that is not inverse blanked (a blanked cell is as
  many spaces as its character has UTF-16 units), each with its trailing
  white space trimmed; `width`, the screen's columns; and `end`, the cell
  just past the last one that is not blank. The modes are fixed words and
  yes or no values, never bytes to pass on: `screen` (`normal` or
  `alternate`), `bracketed_paste`, `application_cursor` (application cursor
  keys), `application_keypad`, `mouse` (`none`, `press`, `press-release`,
  `button-motion` or `any-motion`), `mouse_encoding` (`default`, `utf8` or
  `sgr`) and `cursor_hidden`. No other mode is answered: the screen does not
  keep focus reporting, synchronized output, the keyboard protocols, wrap
  (it always wraps) or insert mode, and keeps origin mode without a way to
  read it.
- **`screen.tail`** `{id, count}`, `count` 1 to 200, is answered
  `screen.lines`: `cut`, and `lines`, the last `count` lines of scrollback
  and screen together, oldest first (fewer when fewer are held; the
  alternate screen has no scrollback). Each line is `text`, its cells up to
  the last one that holds a character (an erased cell holds none, a written
  space does), as the Watchdog's pane gives a line
  (`translateToString(true)`), and `typed`, the line's cells with every dim
  one blanked, its trailing white space trimmed.
- **The title (capability `title`, from 2.1.3-beta.14).** A holder offers
  `title` after `screen`, and it counts only beside `screen`. On a connection
  that acked both, `screen.rows` carries `title`: the window title the
  session's output last set with OSC 0 or OSC 2, as xterm.js takes it
  (everything after the first `;`, a later one replacing it; OSC 1, the icon
  name alone, leaves it), and empty when the output set none. The first C1
  control (U+0080 to U+009F) in the string ends it at ST (U+009C) and drops
  it at any other, keeping the earlier title, as xterm.js does (from
  2.1.3-beta.15); the other control characters are dropped (DEL too, which
  xterm.js keeps, as no title on the wire holds a control character), and it
  is bounded: the screen keeps the first 1 KiB
  of an OSC string and its first 16 parts between `;`s, so a title is cut at
  its fifteenth `;`, and at most 1024 characters of it are kept. It is counted
  before the rows in the one message, so it is never left out. A connection
  that did not ack `title`, and every connection to a holder from before it
  (which does not offer it), get `screen.rows` as before, with no `title`.
  The app refuses a `title` on such a connection, and one that is not text,
  holds a control character or is over 1024 characters. From 2.1.3-beta.14 a
  held Codex session's connections ask for it (its composer rule reads the
  spinner in it); nothing else in the app does.
- **One message.** Each answer is one message within what a frame to the app
  holds (1 MiB of JSON). Rows that do not fit are left out from the top of
  `screen.rows` and from the oldest end of `screen.lines`, and the answer
  says so with `cut` true; `lines` then holds the bottom rows (the first is
  row `rows` less their number) or the newest lines. A screen of a common
  size is never cut; one of 1000 by 1000 wide characters is.
- **Widths.** The screen counts a character's cells by current Unicode, and
  xterm.js 6.0.0 by Unicode 6, so a row holding a character the two count
  differently can differ from the app's own terminal. The rows of the screen
  corpus where they do are named in `helper/tests/screen.rs`.
- **Other differences from xterm.js.** Four more, none of them in the
  screen corpus, so no test compares them. The screen does not draw the
  replacement character (U+FFFD, which is also what a byte that is not UTF-8
  is in the app's terminal), where xterm.js draws it in one cell, so the
  rest of that run of text sits one cell to the left. It has no line drawing
  character set (`ESC ( 0`), so those characters stay the letters they were
  sent as. A change of width cuts or pads each row, where xterm.js can
  wrap the lines of its normal screen again. And the title differs where the
  screen's parser (vte 0.15.0) reads a string otherwise than xterm.js, limits
  of that parser: an OSC 0 or 2 cut short by CAN or SUB still sets the
  title, where xterm.js drops it (the parser tells only whether BEL ended a
  string); U+009D begins no string, outside a string or inside one, where
  xterm.js begins an OSC there; and a string that a C1 control ends in
  xterm.js (ST, U+009C, which sets its title; any other, which drops it)
  ends for the screen only at the next BEL, ESC, CAN or SUB, so the rows can
  differ from that control on (what xterm.js prints or carries out after it
  is not on the screen's rows), and the title U+009C sets comes then. DEL in
  a title is dropped, where xterm.js keeps it (above).
- **The bound.** A CSI parameter above 9999 reaches the screen's parser as
  9999, as main cuts it for its own panes, so a repeat (`CSI n b`) writes at
  most 9999 cells and no other sequence's work grows with its parameter; an
  OSC string is kept to its first 1 KiB, and DCS, SOS, PM and APC strings are
  not kept. A screen whose parser fails is no longer kept: a read then gets
  `io`, and the output, the ring and the attached connection go on.
- Vectors: the `screen` part of `helper/fixtures/local.json`.

**Change.** The `hold` and `list` command lines and their exit codes, the
record and the listing are frozen within version 1; new fields need a new
record version or capability. A message may gain an optional field, as
`term.launch` gained `line` and `conpty` (2.1.3-beta.7): a holder from before
it refuses the field with `bad-field`. The `hook` command line (2.1.3-beta.8)
is frozen with them: its options, its exit status (always 0) and its silence.
From 2.1.3-beta.18 either of its options may be left out and read from
`AICC_HELPER_STORE` and `AICC_HELPER_SESSION`; every command line that worked
before works the same. The `status` command line (2.1.3-beta.18) is frozen the
same way: its options and variables, its exit status (always 0) and its
silence. `term.launch` gained `hookKinds` (2.1.3-beta.18) as it gained `line`
and `conpty`. The `mcp` command line (2.1.3-beta.10) is frozen too: its
options, its exit status (0 at the end of its input, 1 otherwise) and a
standard output that carries only messages. The `capture` command line (2.1.3-beta.14) is frozen from
2.1.3-beta.16, when the app's Snap began to run it (`src/main/snap/`): its
options, its one line and its exit statuses.
