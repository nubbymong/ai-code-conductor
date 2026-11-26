# helper/ - the session helper

The Rust program that holds a terminal session on every machine (ADR-029,
ADR-030). Since 2.1.3-beta.6 the installer ships one file of it: the release
build (`target/release/aicc-helper`, `.exe` on Windows), which the release
workflow builds before packaging and electron-builder copies to
`resources/helper/`. On This computer the app runs it for plain and partner
terminals when Settings has "Plain terminals through the session helper" on,
and, since 2.1.3-beta.7, for local Claude Code sessions and the other agent
sessions (each assistant's CLI in its tab) when the agent sessions' switch
below it is on (`agentSessionsThroughHelper`). Both are off by default; the
app side is `src/main/session-helper/`. From 2.1.3-beta.17 the Windows
installer also carries the static Linux build (`resources/helper/linux-x64/aicc-helper`)
and a manifest of its version and SHA-256 (`resources/helper/manifest.json`),
for the app to upload to a Linux machine (remote step 1). Nothing else here
ships. It is a top-level folder on purpose, not under `src/` or `resources/`,
so no packaging glob picks it up (`tests/unit/scripts/helper-packaging.test.ts`
fails if anything but those files would, and
`scripts/verify-bundled-helper.mjs` checks the packaged copies).

The protocol it follows is `docs/remote/helper-protocol.md`; the rules for its
build are in `docs/remote/helper-threat-model.md` 3.10.

## What is in it

| Part | File | What it does |
| --- | --- | --- |
| Frame codec | `src/frame.rs` | 4-byte big-endian length, kind byte (JSON or raw), 4-byte channel id, payload; size limits checked before anything is allocated |
| JSON | `src/json.rs` | A small reader and writer (depth limit 32), so there is no JSON crate |
| Hello | `src/hello.rs` | `AICC-HELLO <nonce> <json>`, `hello.ack`, version choice, `error`, `AICC-RESULT` lines |
| Output ring | `src/ring.rs` | Bytes at fixed offsets, a 2 MiB window, replay from an offset, "too short" reported |
| Terminal | `src/pty/` | openpty on Unix, ConPTY on Windows (Windows' own, or the bundled one from a `conpty` folder beside the helper when a launch asks); the program's folder and whole environment, and on Windows an exact command line when a launch gives one; a job object on Windows; on Unix an end reaches every process in the child's session |
| Holder | `src/holder.rs` | Holds one terminal and child; attach, detach, re-attach with replay; the newest attach replaces the older; ends the whole process tree |
| Screen | `src/screen.rs` | The session's screen (from 2.1.3-beta.12): every byte of output after the ring, at the session's size with 200 lines of scrollback, through the `vt100` crate with a CSI parameter cut to 9999 first; read as the app's readers read xterm.js. `screen.read` and `screen.tail` answer from it, read-only, to a connection that acked `screen` (from 2.1.3-beta.13 a plain terminal's take-over asks `screen.read` once, for the holder's size; from 2.1.3-beta.14 a held Codex session's composer rule reads `screen.read`; nothing else in the app asks yet). It keeps the window title the output last set (OSC 0 or 2; from 2.1.3-beta.15 the first C1 control in the string ends it at U+009C and drops it at any other, as xterm.js does; the other control characters dropped; bounded), which `screen.read` answers only to a connection that acked `title` too (from 2.1.3-beta.14; a held Codex session's connections ask for it) |
| Local transport | `src/transport/` | One endpoint per holder that only this user can reach: a named pipe on Windows, a Unix socket in a private folder elsewhere |
| Holder process | `src/serve.rs`, `src/request.rs`, `src/detach.rs` | `hold`: the hello, the `term.*` messages, the away clock, or none with `--until-ended` (from 2.1.3-beta.19); started detached so it outlives the app; on macOS and Linux it marks its socket and folder as used every hour and binds its socket again if a cleaner of /tmp takes it |
| Records and list | `src/store.rs`, `src/client.rs`, `src/pids.rs` | Each holder's record in the store folder, in one of two shapes (a clock holder's, or an until-ended holder's); `list` finds every session and removes stale records |
| Field mode | `src/field.rs` | macOS and Linux (from 2.1.3-beta.19). `field`: one string from a JSON file in the user's home folder, the file and the key given by the app's provider package, or nothing; exit 0 either way |
| Start and end mode | `src/start.rs`, `src/winproc.rs` | Windows only. `start`: one program, by a drive-absolute path (never searched for, never a batch file), with no inherited handles, created suspended until its creation time is read; prints its pid and creation time and exits. `end`: ends that program and the processes under it, only while its pid still has that creation time, holding it open from the check to the end; prints `ended` or `left`. The app starts and ends the vision browser this way |
| Console hosts | `src/consoles.rs` | Windows only. `console-hosts`: at the app's start, ends the console hosts the run before left when it was ended from outside (only that run's, by parent, creation time, user and program file), and names the process that started it for the app to record. `end-console-host` (from 2.1.3-beta.14): while the app runs, ends each console host of its terminals on Windows' own ConPTY that was made in the time it is given, is 6 s old or more, and is the console host of no running process. Each holds a host open from its check to its end |
| Capture mode | `src/capture.rs` | Windows only (from 2.1.3-beta.14; macOS and Linux exit 4, not supported). `capture --out <folder>`: one 32-bit BMP of each whole display in physical pixels, each file made new, and one JSON line of each display's bounds and scale; exit 3 when it cannot see the screen (an SSH session, a locked screen). For Snap (ADR-030 D3, D4): from 2.1.3-beta.16 the app runs it for the new Snap on Windows, the default (`src/main/snap/`), with a 2 s bound; probe P21 measured it first |
| Tool relay | `src/relay.rs` | `mcp`: a session's tool server as its CLI starts one. It carries one JSON-RPC message a line between its standard input and output and the session's holder, which passes them to the attached connection that acked `mcp` (from 2.1.3-beta.10; from 2.1.3-beta.11 a held session's CLI starts it, behind the agent sessions' switch). With a holder that offers `away` (from 2.1.3-beta.12) its stream is kept while the app is away: a call made meanwhile waits up to 30 s, then gets the fixed "updating" answer, and a call the app had when it went is answered at once and never sent again |
| Bridge | `src/bridge.rs` | macOS and Linux only (from 2.1.3-beta.17, remote step 1). `bridge`: one connection to a session's holder carried over its standard input and output, byte for byte, as the app reaches a holder on another machine through one `ssh -T` exec; what the holder sends is queued for standard output (64 MiB at most) so a slow link never makes the holder wait |
| Self-test | `src/selftest.rs` | Codec, hello, ring, a terminal round trip and a round trip over the local transport, one `AICC-RESULT` line; it closes its terminal before it moves on, and on Windows it runs in a job object when one can be made, so nothing it starts (its terminal's `conhost.exe` included) outlives it |
| Fake CLI | `src/bin/aicc-fake-cli.rs` | A stand-in provider CLI for tests and probes |
| Fixtures | `fixtures/*.json` | Frame, hello, limit and local transport vectors read by the Rust tests and by `tests/unit/scripts/helper-fixtures.test.ts` |

The local transport is protocol section 15. The release build ships in the
installers (`resources/helper/`), signed with the app on Windows and macOS; the
Windows installer also carries the static Linux build and its hash manifest
(from 2.1.3-beta.17). Not in it yet: seccomp, the event spool and `since_seq`,
`emit` and the remote `mcp` (the local `mcp` relay is in). Those are later
slices. A holder on another machine is reached through `bridge` (below). The
app side for This computer is in `src/main/session-helper/`.

## Commands

```text
aicc-helper version
aicc-helper hello --nonce <32 hex> --session <sid> [--state new] [--sha256 <64 hex>]
aicc-helper selftest [--nonce <32 hex>]
aicc-helper hold --store <folder> --session <sid> [--label <text>] [--away <seconds> | --until-ended] [--ring-bytes <n>] [--detach]
aicc-helper list --store <folder>
aicc-helper field --file <path under home> --key <dotted key>      (macOS and Linux)
aicc-helper hook [--store <folder>] [--session <sid>]               (each left out: AICC_HELPER_STORE, AICC_HELPER_SESSION)
aicc-helper status [--store <folder>] [--session <sid>]             (the same)
aicc-helper mcp --store <folder> --session <sid>
aicc-helper bridge --store <folder> --session <sid>                (macOS and Linux only)
aicc-helper start [--hide] --cwd <folder> -- <program> [args...]   (Windows only)
aicc-helper end --pid <n> --created <t>                            (Windows only)
aicc-helper console-hosts [--pid <n> --created <t>]                (Windows only)
aicc-helper end-console-host --made-from <t> --made-to <t>         (Windows only)
aicc-helper capture --out <folder>                                 (Windows only)
```

`hold --detach` prints the holder's record as one JSON line once the holder
listens; the app then connects to the record's endpoint, launches the program
with `term.launch` and attaches with `term.attach`. With `--until-ended`
(from 2.1.3-beta.19; not with `--away`) the holder has no away clock: with
nobody attached it ends once its program has exited; until an app has
attached for the first time, no sooner than the default 120 s after its
start. It also ends at `term.end`, or with the machine. Its record has
`"away":null` and `"lifetime":"until-ended"` after it, and a clock holder's
record is as before. `list` prints every session in the store, as protocol
section 15 describes, an until-ended one with its `lifetime`. `field` (macOS
and Linux, from 2.1.3-beta.19) prints the string at `--key` (object members
named from the top, separated by dots) of the JSON file `--file` names, a
path relative to `HOME` or absolute inside it, and one line end; or nothing.
It follows a link, then reads only a regular file of the user's own of at most
5 MiB, and prints only a string of 1 to 1024 bytes with no control
character. It exits 0 either way, 2 on a command line it does not take, and
prints nothing on Windows (`src/field.rs`). `hook` is a CLI's command
hook: it passes the event on its standard input to the session's holder,
always exits 0 and prints nothing (from 2.1.3-beta.8 a held Claude Code session
runs it, behind the agent sessions' switch with the HTTP Hooks Gateway on). Its
own check of the event's kind is the kind's shape (one plain word of at most 64
ASCII letters or digits); which kinds a session takes is its holder's, from the
`hookKinds` its launch declared, or the nine the app injects into a Claude Code
session when it declared none (from 2.1.3-beta.18). `status` is a CLI's status
line command, the same way (from 2.1.3-beta.18): it passes the status on its
standard input, one JSON object of at most 65,280 bytes as compact JSON, to
the session's holder as `status.set`, always exits 0 within 2 s and prints nothing; the
holder keeps the newest and sends it to each connection that acked `status`
beside `local` (the app's), at most 10 a second. `hook` and `status` take the store and the session from
`AICC_HELPER_STORE` and `AICC_HELPER_SESSION` when the options leave them out. `mcp`
is a tool server a CLI starts: standard output carries only the messages its
stream brings and the answers it gives in the app's place while the app is away,
and it exits 0 only when its standard input ends (from 2.1.3-beta.11 a held
session's CLI starts it, behind the agent sessions' switch). In the debug build
`cargo test` runs, a held call waits 4 s instead of 30 s, and a holder marks
its socket and folder as used every 2 s instead of every hour, so the tests
can wait one out. `bridge` (macOS and Linux, from 2.1.3-beta.17) carries one
connection to a session's holder over its own standard input and output,
byte for byte, so the app reaches a holder on another machine through one
`ssh -T` exec and speaks the protocol to it end to end; it never reads or
writes a frame itself. It reads the session's record and connects with the
same checks as any client (the socket's folder and owner, the peer's user id).
When its standard input ends it closes its half of the connection, and the
holder keeps the session, as for any connection that goes. It exits 0 when the
holder closes the connection, 3 with no holder for the session (no record, its
process gone, or nothing on its endpoint), 2 on a usage error, and 1 otherwise
and on Windows (`src/bridge.rs`). `start` prints
`{"pid":<n>,"created":"<t>"}` and exits without waiting for the program; `end`
prints `ended` or `left` (protocol section 15, "Starting a program" and "Ending
a program it started"). `console-hosts` and `end-console-host` print
`{"pid":<n>,"created":"<t>","ended":<k>}`, naming the process that started
them, with `ended` how many console hosts they ended ("Console hosts a run
left" and "A terminal's console host after its program has ended").
`capture` writes `display-<n>.bmp` into the folder and prints
`{"displays":[...]}`; it exits 3 when there is no desktop to capture and 4 off
Windows ("Capturing the displays").

## Building and testing

The pinned toolchain is in `rust-toolchain.toml`. CI is the `Helper (os)` job in
`.github/workflows/ci.yml` (Windows, macOS, Linux). Locally, with that toolchain:

```text
cargo build --locked
cargo test --locked
```

`Cargo.lock` is committed and every build uses `--locked`. If it is missing, the
CI job generates one, uploads it as the `helper-cargo-lock` artifact and fails
with a message to commit it.

A helper/ change that waits on another one not yet merged is built on a pushed
branch cut from the other change's reviewed head: `gh workflow run ci.yml --ref
<branch> -f helper=true` runs the three Helper jobs there (and, as every
dispatch does, the CLI conformance checks). Its pull request opens once, after
the other change has merged and the branch has been moved onto beta.

On Windows the helper carries its own C runtime (since 2.1.3-beta.8), so it
starts on a PC without Microsoft's Visual C++ runtime. `.cargo/config.toml` in
this folder adds `-C target-feature=+crt-static` to Windows MSVC builds only.
It also delay-loads the window-manager DLLs (user32, gdi32 and shcore's API set,
since 2.1.3-beta.14): only the capture mode calls them, so they load when that
mode runs and no other mode loads them at its start.
cargo reads that file only when it runs in this folder or below, so run every
cargo command from `helper/`, as CI and the release workflow do. A `RUSTFLAGS`
or `CARGO_ENCODED_RUSTFLAGS` variable replaces the setting, so do not set one.
To check a built program, from the repository root (it only reads the file, so
it works on any OS):

```text
node scripts/check-pe-imports.mjs helper/target/release/aicc-helper.exe
```

It fails if the program imports a C runtime DLL (`VCRUNTIME140.dll`,
`api-ms-win-crt-*` and the like), imports a window-manager DLL at load time
rather than delay-loading it, names no DLL at all, or is not x64. CI runs it
after the Windows release build in the Helper job, before the release/* test
installer is packaged, and `release.yml` runs it before the Windows installer is
signed and packaged. `npm run verify:helper`, which every package script and
packaging job runs, applies the same rules to the packaged, signed copy.

On Linux the Helper job also builds the release helper for
`x86_64-unknown-linux-musl`, a static program that runs on any x86-64 Linux
whatever its glibc, checks with `readelf` that it names no program interpreter
and no shared library, and uploads it as the `helper-linux-musl` artifact. It
was first for the remote probes P3 and P6 (`probes/README.md`). From
2.1.3-beta.17 the Windows installer carries it: `release.yml`'s `helper-linux`
job builds it with the same three steps, `build-windows` puts it at
`target/helper-linux-musl/aicc-helper`, and `node scripts/write-helper-manifest.mjs`
writes `target/helper-manifest/manifest.json` before packaging. The manifest
lists the Linux file only, as `{"v":1,"files":[{"path":"linux-x64/aicc-helper","version":"<this crate's>","sha256":"<64 hex>"}]}`
with the path relative to `resources/helper/`: electron-builder signs
`aicc-helper.exe` in the package, which changes its bytes after any hash
written before. A Windows package made on a VM or a dev PC takes the file from
the head's `helper-linux-musl` artifact the same way; without it, the manifest
step and `npm run verify:helper` fail.

## Dependencies

Every one is pinned with an exact `=x.y.z`. `libc` on Unix, `windows-sys` on
Windows, and on every system `vt100` for the holder's screen (from
2.1.3-beta.12, without its default `std` feature), nothing else: no async
runtime, no JSON crate, no TLS or HTTP crate. The lock file holds 18 packages:
the helper, `libc`, `windows-sys`, `windows-targets` and its eight per-target
crates, and `vt100` with the five it brings (`vte`, `unicode-width`, `itoa`,
`arrayvec`, `memchr`; threat model 3.10 lists each, its licence and what was
read). CI prints the number and fails above 24 (under 25, the helper
included). A new crate is its own security review item.
