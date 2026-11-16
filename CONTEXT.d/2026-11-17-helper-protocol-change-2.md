## 2026-11-17 -- Session helper protocol change 2: an exact Windows command line and the bundled ConPTY (2.1.3-beta.7 section A2)

**Why.** Section A3 runs agent sessions through the session helper. One of
them starts on Windows as a single cmd.exe command line (an npm .cmd
launcher run with `cmd.exe /d /v:off /s /c "..."`), which node-pty takes as
one verbatim string, and on node-pty's bundled ConPTY, because the system
ConPTY repaints a full-screen program in place and keeps no scrollback. The
holder could do neither: `term.launch` took only an argument list
(`helper/src/request.rs`, exactly seven fields), and the holder only used the
system `CreatePseudoConsole` (`helper/src/pty/windows.rs`).

**What changed.**
- Protocol section 15 gains two optional `term.launch` fields, Windows only;
  on macOS and Linux either is `bad-field`. `line` is the exact command line
  `CreateProcessW` gives the program. The program is still `argv[0]`, passed
  as `lpApplicationName`, so no word of the line can choose another program,
  and with `line`, `argv` holds the program alone. It is 1 to 32767
  characters with no NUL: longer is `too-large`, the rest `bad-field`.
  `conpty: "bundled"` (any other value is `bad-field`) runs the terminal on
  the `conpty.dll` in a `conpty` folder beside the helper's own program file,
  which starts the `OpenConsole.exe` beside it.
- The holder loads that DLL by its full path, never a path from a frame, with
  `LoadLibraryExW` and `LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR` plus
  `LOAD_LIBRARY_SEARCH_SYSTEM32`, critical-error dialogs off for the load. It
  makes node-pty's calls: `ConptyCreatePseudoConsole`,
  `ConptyResizePseudoConsole` and `ConptyClosePseudoConsole`. Both files must
  be plain files (OpenConsole.exe is checked too: without it the DLL would
  quietly use the system console host). The load comes first, so a missing
  or failing DLL answers `io` with nothing made or started, and a later
  launch may try again. `ConptyReleasePseudoConsole` is not called, so a
  session ends the same way on both ConPTYs.
- `src/main/session-helper/protocol.ts`: `LaunchSpec.line` and
  `LaunchSpec.conpty`, `LAUNCH_LIMITS.lineChars`, and `checkLaunch` applies
  the holder's rules in the holder's order.
- `src/main/session-helper/install.ts`: `installHelperCopy` takes an optional
  `conptySource` (node-pty's `conpty` folder, found by `bundledConptySource`
  with bundled-conpty.ts's `findNodePtyLibDir`, `nativeModuleDirs` and
  `asarUnpackedPath`). On Windows it copies conpty.dll and OpenConsole.exe
  into `<version folder>/conpty` through a staging folder, as the helper is
  copied, and records their SHA-256 from node-pty's files at start.
  `checkedConpty` is the check before every use: a mismatch is copied again
  once (checks at the same moment share one copy), and a second mismatch
  makes only the bundled ConPTY unavailable. Missing files do the same. The
  helper is never failed by any of it.
- Nothing sends the new fields yet, and the manager passes no
  `conptySource`, so nothing is copied: with every switch off, and with the
  plain-terminal switch on, nothing changes. Section A3 passes
  `bundledConptySource()` and calls `checkedConpty` before each bundled
  launch.
- Threat model 3.1 records the DLL load and the copy check.

**Test.** Shared vectors in `helper/fixtures/local.json` (3 valid, 9 invalid,
and `line_chars`), read by `helper/tests/fixtures.rs`, the reference reader in
`tests/unit/scripts/helper-fixtures.test.ts` and
`tests/unit/main/session-helper-protocol.test.ts`. Rust request tests for
both OS families. Windows transport tests: `line` running cmd.exe `/s /c` on
a .cmd file in a folder with a space prints exactly its words and the same
words as an argument list are mangled; with no usable conpty.dll beside a
copy of the holder (none, the DLL without OpenConsole.exe, files that do not
load) a bundled launch answers `io`, starts nothing, and a later launch
starts. TS install tests for the copy, the recopy, a lasting mismatch,
missing files and the folder name the holder uses. The bundled ConPTY itself
loading and running cannot be tested in CI: the Helper jobs have no
node-pty, so no conpty.dll.

**Owed before stable.** The ADR-009 adversarial pass on this change (the DLL
load and the new launch fields), under the owner rule of 2026-11-15 that
betas skip it.
