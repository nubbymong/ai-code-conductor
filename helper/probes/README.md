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

The probe uses the skeleton's file-based transport (`src/dirhold.rs`), not the
real local transport, so it answers the survival and replay question only.
Record the result in ADR-030's probe table.
