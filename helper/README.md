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
app side is `src/main/session-helper/`. Nothing else here ships. It is a top-level folder on purpose, not under `src/` or `resources/`,
so no packaging glob picks it up (`tests/unit/scripts/helper-packaging.test.ts`
fails if anything but the release program would, and
`scripts/verify-bundled-helper.mjs` checks the packaged copy).

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
| Local transport | `src/transport/` | One endpoint per holder that only this user can reach: a named pipe on Windows, a Unix socket in a private folder elsewhere |
| Holder process | `src/serve.rs`, `src/request.rs`, `src/detach.rs` | `hold`: the hello, the `term.*` messages, the away clock; started detached so it outlives the app |
| Records and list | `src/store.rs`, `src/client.rs`, `src/pids.rs` | Each holder's record in the store folder; `list` finds every session and removes stale records |
| Self-test | `src/selftest.rs` | Codec, hello, ring, a terminal round trip and a round trip over the local transport, one `AICC-RESULT` line; it closes its terminal before it moves on, and on Windows it runs in a job object when one can be made, so nothing it starts (its terminal's `conhost.exe` included) outlives it |
| Fake CLI | `src/bin/aicc-fake-cli.rs` | A stand-in provider CLI for tests and probes |
| Fixtures | `fixtures/*.json` | Frame, hello, limit and local transport vectors read by the Rust tests and by `tests/unit/scripts/helper-fixtures.test.ts` |

The local transport is protocol section 15. The release build ships in the
installers (`resources/helper/`), signed with the app on Windows and macOS.
Not in it yet: the hash manifest, seccomp, the event spool and `since_seq`, the
remote `serve`, `emit` and `mcp`. Those are later slices. The app side for
This computer is in `src/main/session-helper/`.

## Commands

```text
aicc-helper version
aicc-helper hello --nonce <32 hex> --session <sid> [--state new] [--sha256 <64 hex>]
aicc-helper selftest [--nonce <32 hex>]
aicc-helper hold --store <folder> --session <sid> [--label <text>] [--away <seconds>] [--ring-bytes <n>] [--detach]
aicc-helper list --store <folder>
aicc-helper hook --store <folder> --session <sid>
```

`hold --detach` prints the holder's record as one JSON line once the holder
listens; the app then connects to the record's endpoint, launches the program
with `term.launch` and attaches with `term.attach`. `list` prints every session
in the store, as protocol section 15 describes. `hook` is a Claude Code command
hook: it passes the event on its standard input to the session's holder,
always exits 0 and prints nothing (nothing in the app uses it yet).

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

On Windows the helper carries its own C runtime (since 2.1.3-beta.8), so it
starts on a PC without Microsoft's Visual C++ runtime. `.cargo/config.toml` in
this folder adds `-C target-feature=+crt-static` to Windows MSVC builds only.
cargo reads that file only when it runs in this folder or below, so run every
cargo command from `helper/`, as CI and the release workflow do. A `RUSTFLAGS`
or `CARGO_ENCODED_RUSTFLAGS` variable replaces the setting, so do not set one.
To check a built program, from the repository root (it only reads the file, so
it works on any OS):

```text
node scripts/check-pe-imports.mjs helper/target/release/aicc-helper.exe
```

It fails if the program imports a C runtime DLL (`VCRUNTIME140.dll`,
`api-ms-win-crt-*` and the like). CI runs it after the Windows release build in
the `Helper (windows-2025)` job, and `release.yml` runs it before the Windows
installer is signed and packaged.

## Dependencies

Every one is pinned with an exact `=x.y.z`. `libc` on Unix, `windows-sys` on
Windows, nothing else: no async runtime, no JSON crate, no TLS or HTTP crate.
The lock file is expected to hold 12 packages: the helper, `libc`, `windows-sys`,
`windows-targets` and its eight per-target crates. The first CI run prints the
real number; CI fails above 24 (under 25, the helper included). A new crate is
its own security review item.
