## 2026-11-24 -- The helper's bridge mode, and the Windows installer carries the static Linux helper

**Remote step 1, the helper half (2.1.3-beta.17 A1, aicc_planning#410).** The
app side (A2) needs two things from the helper before it can add a Linux
machine and run a Claude Code SSH tab through a holder there: a file to upload,
and a way to reach a holder's socket over one `ssh -T` exec.

**The bridge.** `aicc-helper bridge --store <folder> --session <sid>` (macOS
and Linux; Windows exits 1) reads the session's record, connects to its
endpoint with the transport's checks, and copies standard input to the
connection and the connection to standard output, byte for byte. It never
reads or writes a frame: the app checks the hello's nonce and speaks protocol
section 15 end to end, as over a local connection. Standard input ending
closes its half (`shutdown_write`, new on the Unix transport); the holder keeps
the session and closes its own half, and the bridge exits 0. Exits: 0 the
holder closed, 3 no holder (no record, its process gone, nothing on its
endpoint), 2 usage, 1 otherwise. The holder's bytes go through a queue of up to
64 MiB to standard output, so a slow ssh link never trips the holder's 5 s
write limit during a replay (the holder drops a connection that does not take
a write in 5 s).

**What the installer carries.** release.yml's new `helper-linux` job builds the
static musl helper with the Helper job's three steps word for word (plus the
glibc debug build the static check compares against); `build-windows` needs
it, downloads it to `helper/target/helper-linux-musl/` and runs
`scripts/write-helper-manifest.mjs`, which writes
`{"v":1,"files":[{"path":"linux-x64/aicc-helper","version":...,"sha256":...}]}`
before packaging. The manifest lists the Linux helper only, because
electron-builder signs `aicc-helper.exe` in the packaged folder (its bytes
change after any hash written earlier); the ELF file is never signed, so its
hash holds. `verify-bundled-helper.mjs` now checks the packaged Linux helper is
a static x86-64 ELF program (the Helper job's readelf rule, read in JS) and
that the manifest's shape, version and hash match, and refuses one that names
the Windows helper.

**Found in the code, not in the plan.** ci.yml's release/* Windows test
installer also runs `verify:helper`, so it would have failed at the next
promotion PR without the Linux helper. It moved out of the Build and native
tests job into `release-windows-installer`, which needs a new
`release-helper-linux` job: the Test (windows-2025) chain never waits for a
Linux build (no job it waits on may have a `needs`). Its artifact is named
`helper-linux-musl-installer`, because the Helper job may upload
`helper-linux-musl` in the same run. A local or VM Windows package now needs
the head's `helper-linux-musl` artifact at `helper/target/helper-linux-musl/`
before `npm run package:win`.

**Red first.** The Rust tests ran on throwaway branches through the Helper job:
the new `helper/tests/bridge.rs` on the code before the bridge, and the bridge
with a copy one way only; both deleted once read.
