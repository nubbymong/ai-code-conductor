## 2026-11-18 -- The Windows session helper carries its own C runtime

Section C4 of the 2.1.3-beta.8 plan (aicc_planning #325), added on the owner's
word. Told that the helper needs Microsoft's Visual C++ runtime, the owner
wrote "We need to handle this in the installer then". It is handled in what the
installer ships rather than by adding the Visual C++ redistributable to it: the
redistributable installs machine-wide and needs admin rights, which the
per-user install does not have, and a static build removes the need outright.

**The problem.** `aicc-helper.exe` was built for `x86_64-pc-windows-msvc` with
Rust's default dynamic C runtime. CI's build of it (run 44279423407, artifact
`helper-windows`) imports `VCRUNTIME140.dll` and five `api-ms-win-crt-*` DLLs.
On a PC without the Visual C++ runtime, Windows stops it before `main`
(0xC0000135): holders, `selftest`, `list` and the hook mode all fail, and the
app quietly runs without the helper. The `api-ms-win-crt-*` DLLs are the
Universal C runtime, part of Windows 10 and later; `VCRUNTIME140.dll` is the
one a fresh Windows lacks. It dates from the first shipped helper
(2.1.3-beta.6), so released betas have it too.

**What changed.**
- `helper/.cargo/config.toml` adds `-C target-feature=+crt-static` for
  `cfg(all(windows, target_env = "msvc"))` only. macOS and Linux builds do not
  change. No new crate; Cargo.lock does not change.
- Why `helper/` and not the repo root: every cargo command in ci.yml and
  release.yml already runs with `working-directory: helper`, cargo reads
  `.cargo/config.toml` from the current folder upwards, and a file under
  `helper/` makes the Helper job build (scripts/ci/helper-scope.mjs).
- `scripts/check-pe-imports.mjs` reads a program's import and delay-load
  tables (it never runs the program) and fails on any C runtime DLL. It runs
  after the Windows release build in the Helper job, after the release/* test
  installer's helper build in ci.yml, and in release.yml's `build-windows`
  before signing and packaging.
- `tests/unit/scripts/check-pe-imports.test.ts` covers the parser on in-memory
  PE32 and PE32+ images and pins the wiring: each Windows build is followed by
  the check, every cargo command runs in `helper/`, and no workflow sets
  `RUSTFLAGS` or `CARGO_ENCODED_RUSTFLAGS` (either would replace the config's
  flags).

**Seen along the way.** The bundled `conpty.dll` and `OpenConsole.exe` from
node-pty import only the Universal C runtime (`api-ms-win-crt-*`), not
`VCRUNTIME140.dll`, so the helper's ConPTY path does not bring the Visual C++
runtime back.

**Owed.** The release PR adds a changelog line: "the session helper no longer
needs the Visual C++ runtime on Windows".
