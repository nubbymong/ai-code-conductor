# helper/ - the session helper

The Rust program that holds a terminal session on every machine (ADR-029,
ADR-030). Since 2.1.3-beta.6 the installer ships one file of it: the release
build (`target/release/aicc-helper`, `.exe` on Windows), which the release
workflow builds before packaging and electron-builder copies to
`resources/helper/`. On This computer the app runs it for plain and partner
terminals when Settings has "Plain terminals through the session helper" on
(off by default); the app side is `src/main/session-helper/`. Nothing else here
ships. It is a top-level folder on purpose, not under `src/` or `resources/`,
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
| Terminal | `src/pty/` | openpty on Unix, ConPTY on Windows; the program's folder and whole environment; a job object on Windows; on Unix an end reaches every process in the child's session |
| Holder | `src/holder.rs` | Holds one terminal and child; attach, detach, re-attach with replay; the newest attach replaces the older; ends the whole process tree |
| Local transport | `src/transport/` | One endpoint per holder that only this user can reach: a named pipe on Windows, a Unix socket in a private folder elsewhere |
| Holder process | `src/serve.rs`, `src/request.rs`, `src/detach.rs` | `hold`: the hello, the `term.*` messages, the away clock; started detached so it outlives the app |
| Records and list | `src/store.rs`, `src/client.rs`, `src/pids.rs` | Each holder's record in the store folder; `list` finds every session and removes stale records |
| Self-test | `src/selftest.rs` | Codec, hello, ring, a terminal round trip and a round trip over the local transport, one `AICC-RESULT` line; on Windows it runs in a job object, so nothing it starts (its terminal's `conhost.exe` included) outlives it |
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
```

`hold --detach` prints the holder's record as one JSON line once the holder
listens; the app then connects to the record's endpoint, launches the program
with `term.launch` and attaches with `term.attach`. `list` prints every session
in the store, as protocol section 15 describes.

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

## Dependencies

Every one is pinned with an exact `=x.y.z`. `libc` on Unix, `windows-sys` on
Windows, nothing else: no async runtime, no JSON crate, no TLS or HTTP crate.
The lock file is expected to hold 12 packages: the helper, `libc`, `windows-sys`,
`windows-targets` and its eight per-target crates. The first CI run prints the
real number; CI fails above 24 (under 25, the helper included). A new crate is
its own security review item.
