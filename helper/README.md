# helper/ - the session helper (dormant skeleton)

The Rust program that will hold a terminal session on every machine (ADR-029,
ADR-030). **Nothing here ships.** It is not in the installer, the app does not
start it, and no setting turns it on. It is a top-level folder on purpose, not
under `src/` or `resources/`, so no packaging glob picks it up
(`tests/unit/scripts/helper-not-shipped.test.ts` fails if one ever does).

The protocol it follows is `docs/remote/helper-protocol.md`; the rules for its
build are in `docs/remote/helper-threat-model.md` 3.10.

## What is in it

| Part | File | What it does |
| --- | --- | --- |
| Frame codec | `src/frame.rs` | 4-byte big-endian length, kind byte (JSON or raw), 4-byte channel id, payload; size limits checked before anything is allocated |
| JSON | `src/json.rs` | A small reader and writer (depth limit 32), so there is no JSON crate |
| Hello | `src/hello.rs` | `AICC-HELLO <nonce> <json>`, `hello.ack`, version choice, `error`, `AICC-RESULT` lines |
| Output ring | `src/ring.rs` | Bytes at fixed offsets, a 2 MiB window, replay from an offset, "too short" reported |
| Terminal | `src/pty/` | openpty on Unix, ConPTY on Windows |
| Holder | `src/holder.rs` | Holds one terminal and child; attach, detach, re-attach with replay; the newest attach replaces the older |
| Self-test | `src/selftest.rs` | Codec, hello, ring and a terminal round trip, one `AICC-RESULT` line |
| Probe transport | `src/dirhold.rs`, `src/detach.rs` | `hold`, `attach`, `end` through files in a folder, so a probe can attach from another process. A stand-in for the local socket or named pipe, which is a later slice |
| Fake CLI | `src/bin/aicc-fake-cli.rs` | A stand-in provider CLI for tests and probes |
| Fixtures | `fixtures/*.json` | Frame, hello and limit vectors read by the Rust tests and by `tests/unit/scripts/helper-fixtures.test.ts` |

Not in it yet: signing, the hash manifest, seccomp, the local socket or named
pipe, the event spool and `since_seq`, `serve`, `emit`, `mcp`, and anything the
app calls. Those are later slices.

## Commands

```text
aicc-helper version
aicc-helper hello --nonce <32 hex> --session <sid> [--state new] [--sha256 <64 hex>]
aicc-helper selftest [--nonce <32 hex>]
aicc-helper hold --dir <folder> --session <sid> [--detach] -- <program> [args...]
aicc-helper attach --dir <folder> [--from <offset>] [--send <text>] [--wait-ms N]
aicc-helper end --dir <folder>
```

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
