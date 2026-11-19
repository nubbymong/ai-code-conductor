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
machine, not in CI, from an administrator session (it reads Defender's
exclusions to confirm Defender is as shipped), with the signed per-user copy
of the installed app's helper:

```powershell
.\p16-windows-hook-cost.ps1 -Helper "$env:LOCALAPPDATA\AI Code Conductor\helper\<version>-<12 hex>\aicc-helper.exe" -Store "$env:TEMP\p16-store" -Claude <path to claude.exe>
```

It watches how `claude.exe` starts a command hook (step 0), holds one empty
session in a throwaway store, then starts `aicc-helper list` behind that same
launcher 300 times at 2 a second and 50 times back to back, counting the wall
time and the CPU time of every process in each chain. Beside the verdict it
reads the CPU of Defender's own process, the holder and the whole machine,
times one first start of a fresh copy of the helper, and times a loopback
HTTP POST for reference, taken the way the hooks gateway takes it (a new
connection each time, the token checked, the body parsed). The pass line is
in the script's header and was fixed before measuring; only the plan's
schedule gives a verdict, and any other is a check run. It refuses a helper
that is not the installed app's signed per-user copy, a store folder that
already exists (or whose parent does not), an output folder inside the
store, a path the launcher's shell would change, a schedule that would
outlast the holder's 600-second away clock, and a missing node. It cleans up its
holder and the store it made in a `finally` block, then looks for anything
of its own still running. The last line is `P16 RESULT: PASS`, `FAIL -
<reasons>`, `CHECK RUN - <...>` or `COULD NOT RUN - <reason>` (exit 0, 1, 3
or 2), with `; clean-up incomplete: <what>` added (and exit 2) when
something was left or could not be checked. The raw runs are
`p16-runs.csv`, and the result files write personal paths as placeholders.
The answer is in ADR-030 after the P7 result.

# Probe P18: how do Claude Code and Codex start a tool server on Windows?

`p18-windows-tool-server-start.ps1` (ADR-030, probe table; it gates tools
through the helper, S15). The helper's relay mode is a program a CLI starts as
a tool server over standard input and output; this probe registers a stand-in
for it (`p18-stand-in.cjs`, run by a copy of the machine's own `node.exe`) with
each CLI's own add command and records how the CLI starts it and ends it. Run
it on the Windows test machine, not in CI, from an administrator session (it
follows processes with WMI's process start and stop events):

```powershell
.\p18-windows-tool-server-start.ps1 -ClaudePath <path to claude.exe> -CodexPath <path to codex.exe> -OutDir <folder>
```

Each CLI runs in a fresh environment with every per-user folder in the probe's
own temporary folder, no account and no API key; nothing leaves the machine
(Codex's model provider is a local stand-in that refuses every request). For
each CLI it runs the CLI's connection check three times with the stand-in in a
folder with no space in its path, once from a folder with one, and once more
with the stand-in holding its first request while the CLI is ended from
outside, and lists what is left 2 s and 10 s after each end. The pass line is
in the script's header and was fixed before measuring. It cleans up in a
`finally` block, each process stopped only after its name and start time are
checked. The last line is `P18 RESULT: Claude Code <...>; Codex <...>` (PASS,
FAIL, CANNOT MEASURE, CHECK RUN or NOT RUN for each), and the record is
`p18-result.json`, with personal paths written as placeholders. The answer is
in ADR-030 after the P16 result.
