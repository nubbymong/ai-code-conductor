## 2026-11-17 -- Session helper launch fields for Windows: an exact command line (`line`) and the bundled ConPTY (`conpty`) (2.1.3-beta.7 section A2)

**Name.** The plan calls this "protocol change 2". It is not ADR-030's
change 2 (Capture mode), and it is not in ADR-030's list of fifteen protocol
changes at all, so the repository names it by its fields: the launch fields
`line` and `conpty`.

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
  the program reads. `CreateProcessW` starts the program at `argv[0]`
  (`lpApplicationName`), by that exact path with no search, and with `line`,
  `argv` holds the program alone. `line` is only the text that program
  reads: a command interpreter runs what its line says, so `line` gives
  nothing `argv` could not already say. It is never given to a batch file
  (.bat or .cmd, any case, trailing dots and spaces dropped), which Windows
  would start through cmd.exe. That rule reads the name Windows opens: with
  `line`, a name ending in `\` or `/`, or with a part made only of dots and
  spaces (`.`, `..`), is refused first, since Windows resolves those parts
  before it opens the file (`C:\x\tool.cmd\.` and `C:\x\tool.cmd\sub\..`
  open `tool.cmd`). The holder also checks the full name `GetFullPathNameW`
  makes, as Rust's own `Command` does. It is 1 to 32766 UTF-16 units with no NUL
  (`CreateProcessW` takes 32767 with the NUL that ends it): longer is
  `too-large`, the rest `bad-field`. `conpty: "bundled"` (any other value is
  `bad-field`) runs the terminal on the `conpty.dll` in a `conpty` folder
  beside the helper's own program file, which starts the `OpenConsole.exe`
  beside it.
- The holder opens that folder and both files first, refuses any that is not
  plain (a link, a junction or another reparse point), and keeps all three
  open until the pseudoconsole is made: neither file can be written, renamed
  or removed, and the folder cannot be renamed or removed, between the check
  and the pseudoconsole's making; files can still be added to the folder.
  It loads the DLL by its full path, never a path from a
  frame, with `LoadLibraryExW` and `LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR` plus
  `LOAD_LIBRARY_SEARCH_SYSTEM32`, critical-error dialogs off for the load. It
  makes three of node-pty's calls: `ConptyCreatePseudoConsole`,
  `ConptyResizePseudoConsole` and `ConptyClosePseudoConsole`. node-pty also
  calls `ConptyReleasePseudoConsole` after the start; the holder does not,
  so when the program exits the holder closes the pseudoconsole, as it does
  on Windows' own ConPTY. A missing or failing DLL answers `io` with nothing
  made or started, a DLL without the three calls is unloaded again, and a
  later launch may try again. A failed pseudoconsole call is named as it was
  made (`the bundled ConPTY's ConptyCreatePseudoConsole failed`).
- `src/main/session-helper/protocol.ts`: `LaunchSpec.line` and
  `LaunchSpec.conpty`, `LAUNCH_LIMITS.lineUnits`, and `checkLaunch` applies
  the holder's rules in the holder's order. `helper-pty.ts` sends both fields
  in the launch frame when a spec gives them.
- `src/main/session-helper/install.ts`: `installHelperCopy` takes an optional
  `conptySource` (node-pty's `conpty` folder, found by `bundledConptySource`
  through bundled-conpty.ts's `nodePtyConptyDir`, the same lookup the app's
  own bundled node-pty spawn uses). On Windows it copies conpty.dll and
  OpenConsole.exe into `<version folder>/conpty` through a staging folder
  inside the version folder, removed again when a copy fails, and records
  their SHA-256 from node-pty's files at start. The result carries the
  source, and the manager's helper recopy passes it again, so a recopy of
  the version folder keeps the bundled ConPTY. `checkedConpty` is the check
  before every use: a mismatch is copied again once (checks at the same
  moment share one copy), and a second mismatch makes only the bundled
  ConPTY unavailable. A copy a running session holds is not waited for: the
  bundled ConPTY is unavailable at once, and a later check copies it again.
  Missing files make only the bundled ConPTY unavailable. The helper is
  never failed by any of it.
- Nothing sends the new fields yet, and the manager is given no
  `conptySource`, so nothing is copied: with every switch off, and with the
  plain-terminal switch on, nothing changes. For section A3: pass
  `conptySource: bundledConptySource()` at the manager's first
  `installHelperCopy` (`install()`); the recopy in `checkedExe` already
  passes the source the first copy recorded. Call `checkedConpty` before
  each bundled launch.
- Threat model 3.1 records the DLL load, the held files, the copy check and
  the gap between the app's check and the holder's load (two processes: it
  does not stop the same user), and what `line` can and cannot do.

**Test.** Shared vectors in `helper/fixtures/local.json` (8 valid and 24
invalid with `line` or `conpty`, the 32766-unit edge and one past it in
characters outside the Basic Multilingual Plane, batch files, names Windows
opens as another (a trailing `\` or `/`, a `.` or `..` part, parts of dots
and spaces, a `\\.\` device path), plain names whose parts only start with
dots, a `\\?\` path and a share, and macOS and
Linux twins of the vectors refused on every OS; `line_units`), read by
`helper/tests/fixtures.rs`, the reference reader in
`tests/unit/scripts/helper-fixtures.test.ts` and
`tests/unit/main/session-helper-protocol.test.ts`. Rust request and pty
tests for both OS families, a test of the holder's full-name check, and a
`hold.rs` test that the holder's second check runs before anything starts
(including run.cmd named as `run.cmd\.` and `run.cmd\sub\..`, which Windows
would otherwise start through cmd.exe). Windows transport tests: `line` running
cmd.exe `/s /c` on a .cmd file in a folder with a space prints exactly its
words and the same words as an argument list are mangled; the program
started is argv[0], not the line's first word (a line whose first word
names no file still runs cmd.exe); each way the bundled ConPTY is unusable
gives its own reason (no folder, a junction for the folder, a folder named
conpty.dll or OpenConsole.exe, a loadable DLL with no OpenConsole.exe, files
that do not load, and a loadable DLL without the calls, which is then
unloaded), starts nothing, and a later launch starts. TS tests for the
launch frame, the install copy, the recopy keeping the source, a failed
copy, a copy in use, missing files and the folder names the holder uses. The
bundled ConPTY itself loading and running cannot be tested in CI: the Helper
jobs have no node-pty, so no conpty.dll. It was checked on the Windows test
VM instead, with the CI-built helper and node-pty's two files from the
installed 2.1.3-beta.6: sessions on the bundled ConPTY launch, take input,
resize and end with the folder and files held during the start; and a
program that exits by itself on it (`echo done & exit 3`) is reported as
`term.exit` code 3 about 20 ms after its exit, with `done` replayed and its
OpenConsole.exe gone at once, as on Windows' own ConPTY. Not calling
`ConptyReleasePseudoConsole` costs nothing there.

**Owed before stable.** The ADR-009 adversarial pass on this change (the DLL
load and the new launch fields), under the owner rule of 2026-11-15 that
betas skip it.
