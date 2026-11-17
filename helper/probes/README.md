# Probe P7: does the holder survive the app and the installer?

The question (ADR-030, probe table): on Windows, does a detached holder, and the
terminal child it holds, keep running when the app quits and when the installer
runs silently over the app? The answer decides how beta 6 starts the helper
holding local sessions. It is run by the session on the Windows VM, not on the
owner's own session, and not in CI.

## What you need

1. The `helper-windows` artifact from the `Helper (windows-2025)` CI job of the
   branch under test. It holds `aicc-helper.exe` and `aicc-fake-cli.exe`
   (and a copy of the script). Unpack it into a folder of its own.
2. An installer of the app (the `.exe` from a release candidate build), and the
   app already installed on the VM, so the installer runs over it.
3. A session of the kind the app is installed from (elevated for a per-machine
   install).

## Run it

```powershell
.\p7-windows-survival.ps1 -HelperDir C:\p7\helper-windows -Installer C:\p7\Setup.exe
```

Useful options: `-InstallerArgs` (default `/S`, silent for NSIS), `-PlaceUnder`
(copy the programs into a folder, for example one inside the app's install
folder, and run them from there), `-KeepHolder` (leave the holder up at the end).

## What it does and reports

1. A hidden stand-in "app" starts the holder with `hold --detach` and stays up.
2. It records the holder and the child (pid and start time) and whether the
   holder is in a job object, then attaches once and sees the fake CLI banner.
3. It kills the stand-in app's whole process tree. **Reported:** holder alive,
   child alive.
4. It runs the installer silently and waits. **Reported:** installer exit code,
   holder alive, child alive.
5. A new process attaches from the offset it last saw, types a line, and reads
   the answer; another attaches from offset 0. **Reported:** live input works,
   replay works.
6. It ends the holder and checks nothing it started is left running.

The last line is `P7 RESULT: PASS` or `P7 RESULT: FAIL - <reasons>`. The full
record is `p7-result.json` in the work folder it prints. Exit code 0 pass, 1
fail, 2 could not run.

## Reading the answer

- **Holder or child did not survive the app quitting:** the helper must start
  outside the app's process tree or job (the holder already asks to leave its
  job; if the job forbids that, `holder_in_job` is true and the start must change).
- **They survived the app but not the installer:** the installer ends them, or
  replaces a file they run from; try `-PlaceUnder` with and without the install
  folder, and record which.
- **Everything survived but replay failed:** a ring or transport problem, not a
  survival problem; it does not change the answer to P7.

The probe uses the skeleton's file-based transport, not the real local
transport, so it answers the survival and replay question only. Record the
result in ADR-030's probe table.

## Status: answered, and superseded

P7 ran on 2026-11-15 against the 2.1.3-beta.5 skeleton; the answer is in
ADR-030's probe table. In beta 6 the local transport (protocol section 15)
replaced the file-based one, and the `hold --dir`, `attach` and `end` commands
this script drives are gone. To run it again, use the `helper-windows` artifact
of a 2.1.3-beta.5 build. Survival over the new transport is covered by
`tests/probe_transport.rs` in CI, short of the installer step.

# Probe P16: what does one helper process per hook event cost on Windows?

`p16-windows-hook-cost.ps1` (ADR-030, probe table; it gates hooks through the
holder, and a FAIL means declared exception 11). Run it on the Windows test
machine, not in CI, with the signed per-user copy of an installed beta and
Defender as shipped:

```powershell
.\p16-windows-hook-cost.ps1 -Helper "$env:LOCALAPPDATA\AI Code Conductor\helper\<version>-<12 hex>\aicc-helper.exe" -Store "$env:TEMP\p16-store" -Claude <path to claude.exe>
```

It watches how `claude.exe` starts a command hook (step 0), holds one empty
session in a throwaway store, then starts `aicc-helper list` behind that same
launcher 300 times at 2 a second and 50 times back to back, counting the wall
time and the CPU time of every process in each chain; a loopback HTTP POST is
timed beside it for reference. The pass line is in the script's header and was
fixed before measuring. It refuses a store folder that already exists and a
helper that is not validly signed, and cleans up its holder and store in a
`finally` block. The last line is `P16 RESULT: PASS` or `P16 RESULT: FAIL -
<reasons>`; the raw runs are `p16-runs.csv`. The answer is in ADR-030 after
the P7 result.
