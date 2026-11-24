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
own temporary folder (TEMP must be a path with no space; it refuses one that
has), no account and no API key; every API address it sets is on this machine
(Codex's model provider is a local stand-in that refuses every request). For
each CLI it runs the CLI's connection check (for Codex, a `codex exec` run whose
turn is refused) three times with the stand-in in a folder with no space in its
path, once from a folder with one, and once more with the stand-in holding its
first request while the CLI is ended from outside, and lists what is left 2 s
and 10 s after each end. The pass line is in the script's header and was fixed
before measuring. It cleans up in a `finally` block, each process stopped only
after its name and start time are checked. The last line is
`P18 RESULT: Claude Code <...>; Codex <...>` (PASS,
FAIL, CANNOT MEASURE, CHECK RUN or NOT RUN for each) or `P18 RESULT: COULD NOT
RUN - <reason>`, with `; clean-up incomplete: <what>` added (and exit 2) when
something was left; the exit codes are in the script's header. The record is
`p18-result.json`, with personal paths written as placeholders. The answer is
in ADR-030 after the P16 result.

# Probe P19: after a re-attach that starts mid-stream, does a resize make the CLI redraw?

`p19-record.cjs` (ADR-030, probe table; it decides whether the holder must
repaint a terminal on attach, S13). A held terminal whose ring no longer holds
its first byte is replayed from the middle of its output; this probe measures
whether a resize then makes Claude Code and Codex draw their whole screen
again. It runs each program on a terminal of 120 by 40 with node-pty (on
Windows on node-pty's bundled ConPTY and on the system's, `--conpty both`),
in a fresh environment with every per-user folder in its own temporary folder,
no account and no key of anyone's. Each CLI is pointed at
`p19-model-stand-in.cjs`, a server on a loopback port that streams one fixed
reply of 300 lines, so it reaches its prompt and runs one turn without a
sign-in. `p19-scenarios.json` holds the keys typed, the marks and the reply.
Run it on the Windows test machine from a checkout of the repository (its
node_modules give node-pty and @xterm/headless at the versions package.json
names; it refuses any other):

```powershell
node p19-record.cjs run --root <checkout> --out <folder> --claude <path to claude.exe> --codex <path to codex.exe> --conpty both
```

In CI the `probe-p19` job of ci.yml runs it on windows-2025, macos-latest and
ubuntu-latest, only on a dispatch that names it:
`gh workflow run ci.yml --ref <branch> -f probe_p19=true`.

At each mark (a CLI's first screen, its ready prompt, the middle of the reply,
after the reply; the shell after 300 lines of output) it makes a second
terminal fed only the last 64 KiB (or the second half when there is less),
cut at a byte as the ring cuts, and compares its rows with a terminal fed
everything, 2 s after each of three steps: nothing, a resize to the same size
(what the app sends after an attach today), and a nudge (one row shorter, then
back 300 ms later). The decision lines are in the script's header and were
fixed before measuring. It cleans up in `finally` blocks: a process counts as
its own only when it started after its parent, and each is stopped only after
its name and start time are checked. The last line is
`P19 RESULT: ...` with a verdict per CLI (REPAINTS, DOES NOT REPAINT, CANNOT
MEASURE, NO VERDICT or CHECK RUN; per ConPTY on Windows; naming any state that
was already equal before any resize) or `P19 RESULT: COULD
NOT RUN - <reason>`, with `; clean-up incomplete: <what>` added (and exit 2)
when something was left. The recordings (every chunk with its offset and time)
and `p19-result.json` go to `--out`; the result writes personal paths as
placeholders, and both name the probe code by the sha256 of its three files.
The answer is in ADR-030 after the P18 result.

## P19, second run (plan 2.1.3-beta.12, section A2)

The same probe, asked three more things; the decision lines are in the
script's header, written before measuring.

- **The modes.** At each mark and after each step it also records, for both
  terminals, what xterm.js says of the terminal's modes: the screen in use and
  every field of its `modes` (bracketed paste, mouse reporting, application
  cursor keys, the application keypad, focus reporting and the rest). Each
  mode gets KEPT, LOST or NO VERDICT per CLI, per system and per ConPTY.
- **Codex's other screens.** A short turn of its own (30 lines in 1.5 s, the
  stand-in's second reply; once the screen is full Codex redraws it for each
  new line, about 6 KB, so 40 lines were over the cap), recorded in the
  middle of the reply with no resize and measured after it; a draft typed
  while that turn runs (the queue hint); a config that rebinds the shortcuts
  key to F6; and two attempts of up to 60 s each: the agents form of the
  hint row (`← for agents`, the default composer in Codex 0.170.0) and a
  warning count on the hint row (a config with an MCP server that cannot
  start). A record-only screen is recorded to its mark and 300 ms on. The
  queue, rebound-key, agents and warning launches run once each; the short
  turn runs three times, like the first run's launches.
  `P19 SIZES` says which recordings would be over the screen corpus's cap of
  256 KiB.
- **C7's recording hold.** C7's recording hold (2.1.3-beta.17,
  aicc_planning#371) ran the same recorder with `c7-scenarios.json`: every
  launch with the warning launch's config, a draft typed at the idle composer,
  a wrapped draft, a paste and a draft after a reply.
- **The console hosts, on Windows.** After each program's end its console
  hosts are counted 1, 2, 5, 10, 30 and 60 s after node-pty reported the exit,
  before anything of that run is stopped, while the next run goes on.
  `P19 CONSOLE HOSTS` reads ENDS BY ITSELF, STAYS or IN BETWEEN per ConPTY.

Codex 0.170.0 in CI is a dispatch that gives the version as well; the
Codex conformance job then runs its extra leg for that version too:
`gh workflow run ci.yml --ref <branch> -f probe_p19=true -f codex_rc_version=0.170.0`.

One more row, on the test machine only: Codex without `--no-daemon`, so with
its background server, in the same elevated SSH session (RUNS A TURN or
FAILS with what the screen showed). It runs only when named:
`--only claude,codex,shell,codex-daemon`.

Thirty-three of this run's recordings are in the screen corpus
(`helper/fixtures/screens/`, checked by `tests/unit/shared/screen-corpus.test.ts`,
where the program `codex170` is Codex 0.170.0 and `codex` is 0.157.1). Each is
run 1 of its launch up to its state's `mark-end` line: every line before it, in
order, without the `exit` line and earlier `mark-end` lines, a mark keeping only
its state; the chunks decoded as one UTF-8 stream (a character split across two
reads joins the second) and each offset counted over that text. The Windows ones
are the test machine's, the others GitHub's runners'. Which ones were kept is
the plan's order of keeping, listed in the test with what was left out. The
answer is in ADR-030 after the P19 result ("P19, second run").

# Probe P20: what do Claude Code and Codex do once the app run that started them is gone?

`p20-probe.cjs` (ADR-030, probe table; it gates S16's second half, steps 2, 4
and 6). Three questions, each the CLI's own behaviour, not the app's:

- **(a) A hook endpoint that is gone.** Claude Code's http PreToolUse hook (the
  entry `buildHooksBlock` writes) and Codex's hook forwarder
  (`scripts/ccc-codex-hook.cmd` and `.js`, given by `-c` as the app gives it)
  against an endpoint that refuses the connection, answers 401, answers 404
  (what the hooks gateway answers a session it does not know) or never
  answers, beside a control that answers 200 `{}`.
- **(b) Files read again.** Whether Claude Code reads its `--settings` hooks
  again (the PreToolUse URL changed in the file between two turns) or its
  `--mcp-config` again (its tool server ended, the file now names another,
  then `/mcp` and Reconnect).
- **(c) The tool list.** Whether each CLI sends `tools/list` again after
  `notifications/tools/list_changed`, and names the added tool in its next
  turn.

Each CLI runs on node-pty (on Windows on node-pty's bundled ConPTY), in a fresh
environment with every per-user folder in the probe's own temporary folder, no
account and no key of anyone's. `p20-model-stand-in.cjs`, served from the probe
on a loopback port, answers a turn with a tool call that reads a file in the
run's folder (Claude Code's Read; Codex's shell tool, with approvals off in its
own config), so a hook runs before a real tool. `p20-tool-server.cjs` is the
stand-in `conductor` tool server; it declares `listChanged`, as the app's tool
host does, and adds a tool when the probe asks. Run it on the Windows test
machine from a checkout of the repository (its node_modules give node-pty and
@xterm/headless at the versions package.json names; it refuses any other):

```powershell
node p20-probe.cjs run --root <checkout> --out <folder> --forwarder <checkout>\scripts --claude <path to claude.exe> --codex <path to codex.exe>
```

`--only` takes case names or prefixes (`claude-a`, `codex-c`, `claude-b-mcp`),
`--runs` the runs per case (3 for a verdict) and `--cap-s` how long a turn may
wait on an endpoint that never answers (720). The runs of one case run side by
side; the cases one after the other. A CLI's (a) lines are checked against its
control only when `<cli>-a-ok` is among the cases run: `--only` without it
prints them with no control, and they are then not plan verdicts. The decision
lines are in the script's header and were fixed before measuring. It cleans
up after each case and at
its end: a process counts as its own only when it started after its parent,
and each is stopped only after its name and start time are checked. The last
lines are `P20 (a)`, `P20 (b)`, `P20 (c)` and `P20 RESULT: ...`, or
`P20 RESULT: COULD NOT RUN - <reason>`, with `; clean-up incomplete: <what>`
added (and exit 2) when something was left. The record is `p20-result.json`,
with personal paths written as placeholders and the probe code named by the
sha256 of its three files. The answer is in ADR-030 after the P19 results.

# Probe P21: can the helper's capture mode capture each display on Windows?

`p21-capture.cjs` with `p21-windows.ps1` (ADR-030, probe table; it gates Snap
on Windows, S8). It runs on the Windows test machine, and its console half also
in CI (see below), with the helper of a green
`Helper (windows-2025)` job (the `helper-windows` artifact) and measures
`aicc-helper capture` (protocol section 15, "Capturing the displays") from two
places: the signed-in user's console session, where Snap would run it, and an
SSH session, which has no desktop. A console run is started by a scheduled task
that runs only while that user is signed in, not elevated; the probe signs
nobody in, so the console session must be signed in already (on 2026-11-22 the
test machine's auto sign-in had signed nobody in); the task is removed in every
case. For each run it
records the exit code, the time from the start of the process to its exit, the
message, the line and, for each display the line names, the picture's header,
length and whether every pixel is black, against what Windows lists itself
(each display's mode and DPI, read by PowerShell). The pictures are read and
deleted at once; none is kept.

```powershell
node p21-capture.cjs console --helper <aicc-helper.exe> --out <folder> --label console-100
node p21-capture.cjs console-scale --out <folder> --label set-125 --set 125
node p21-capture.cjs console --helper <aicc-helper.exe> --out <folder> --label console-125
node p21-capture.cjs console-scale --out <folder> --label set-back --set 100
node p21-capture.cjs measure --helper <aicc-helper.exe> --out <folder> --label ssh --session ssh
node p21-capture.cjs verdict --out <folder> --console console-100,console-125 --ssh ssh
```

`console-scale` sets the primary display's scale in the console session with
the display configuration call the Settings page makes, so no sign-out is
needed; the last `console-scale` above puts the scale found back (nothing puts
it back by itself, so a run that stops before that step leaves the new scale).
The decision lines are in the
script's header and were fixed before measuring: per scale, CAPTURES when 3 of
3 console runs exit 0 within 2 s and write every display Windows lists, at its
size and DPI, as a picture that is not all black; from the SSH session, FAILS
CLEANLY when 3 of 3 runs exit 3 ("no desktop") within 10 s with a message and
leave no file. When no second scale can be set, the line says why; mixed
scaling is measured only with two displays. The last lines are `P21 CONSOLE
<label>`, `P21 SSH`, `P21 SCALES`, `P21 MIXED SCALING` and `P21 RESULT: ...`,
or `P21 RESULT: COULD NOT RUN - <reason>`; each reading is `p21-<label>.json`
in the output folder. `console` stops with COULD NOT RUN when its task has not
started 15 s after it was started, as when nobody is signed in on the console.

In CI the `probe-p21` job of ci.yml takes the console reading on windows-2025,
in the runner's own session, with a helper it builds there and checks its
imports, only on a dispatch that names it:
`gh workflow run ci.yml --ref <branch> -f probe_p21=true`. It runs
`measure --session console`, then `verdict --ssh-not-run <why>`, so its SSH
line reads `P21 SSH: NOT RUN - <why>`; the readings are uploaded as
`probe-p21-windows-2025`. It is green whenever the probe ran to its end,
whatever the verdict says, and red only when it could not run or the program
it built fails the import check.

The answer is in ADR-030 after the P20 result. From the SSH session (the
Windows test machine, 2026-11-22): FAILS CLEANLY (3 of 3 runs exited 3 in 13 to
61 ms, no file left). From a session with a desktop (the GitHub Windows runner,
2026-11-23, CI run 45091643024): CAPTURES (3 of 3 runs, 50 to 62 ms, one
display of 1024 by 768 at 100%). Not measured: the test machine's own console
(nobody was signed in there), a session that is not elevated, Windows 11, a
second scale, mixed scaling.

# Probe P11: does a CLI attach an image from an inserted path like its own paste?

`p11-probe.cjs` with `p11-model-stand-in.cjs` (ADR-030, probe table; it gates
image paste through an inserted path, S17 and D5). It runs Claude Code and Codex
on node-pty (on Windows on node-pty's bundled ConPTY, as the app gives a local
session), in a fresh environment with every per-user folder in the probe's own
temporary folder, no account and no key of anyone's. Each CLI is pointed at the
stand-in model, served from the probe on a loopback port. The stand-in records
whether the turn carries an image and which picture it is: by its SHA-256, or by
its width and height when a CLI encodes it again. The picture's bytes are never
kept. Codex runs with `--no-daemon` and the model gpt-5.5, with its update check
off. Run it on the Windows test machine from a checkout of the repository (its
node_modules give node-pty and @xterm/headless at the versions package.json
names; it refuses any other):

```powershell
node p11-probe.cjs run --root <checkout> --out <folder> --claude <path to claude.exe> --codex <path to codex.exe>
```

`--only claude` or `--only codex` runs one CLI (a run of Codex alone prints the
X1.2 line with Claude Code as not run), `--forms` runs a subset of the forms,
and `--runs` sets the runs per form (3 for a verdict). The picture is a 96 by 64
JPEG kept in the script. It is written as Snap names one into the app's default
screenshots folder under the run's own local app data, a path with spaces. Two
forms get a verdict, 3 runs each: `paste` (the path as a bracketed paste, then a
space and the sentence 1.5 s later, then Enter 0.7 s after that) and `typed`
(today's form: the sentence and the path as one write, then Enter). Two more run
once each, with no verdict: `paste-plain` (a path with no space) and
`paste-quoted` (the path in double quotes). The decision lines are in the
script's header and were fixed before measuring: ATTACHES when the turn carried
the picture in 3 of 3 runs, NOT when it reached the model with no image in 3 of
3, CANNOT MEASURE when no turn came in 3 of 3, otherwise NO VERDICT. It cleans up
after each run and at its end. A process counts as its own only when it started
after its parent, and each is stopped only after its name and start time are
checked. The last lines are `P11 Claude Code ...`, `P11 Codex ...`,
`P11 FOR X1.2: ...` and `P11 RESULT: ...`, or
`P11 RESULT: COULD NOT RUN - <reason>`. When something was left,
`; clean-up incomplete: <what>` is added and the exit code is 2. The record is
`p11-result.json`, with personal paths written as placeholders and the probe
code named by the sha256 of its two files.

The answer is in ADR-030 after the P21 results. On the Windows test machine
(2026-11-23; Claude Code 2.1.330, Codex 0.157.1), both CLIs ATTACH the path as a
bracketed paste and do NOT attach it as typed text, 3 of 3 runs each.

C6 (2.1.3-beta.17) read Codex's side on P11's stand-in with a scratch copy of
this probe's run code (no build): the placeholder showed 251 to 314 ms after
the paste (8 of 8); Ctrl+U takes the placeholder and its picture back (4 of 4);
one Backspace does not (ADR-030, the C6 reading).

# Probes P3 and P6: does a holder outlive the ssh logout, and is an exec's PATH the login PATH?

`p3-p6-linux.cjs` (ADR-030, probe table; P3 gates remote sessions through the
helper, P6 one-shot commands only). It runs on the test PC against remote Linux
hosts, and the only programs it starts are ssh and scp. It needs the static
Linux helper: the `helper-linux-musl` artifact of the `Helper (ubuntu-latest)`
CI job, which a dispatch with `helper` set builds on any pushed branch.

```text
node helper/probes/p3-p6-linux.cjs --hosts <hosts.local.json> --helper <folder>/aicc-helper --out <folder>
```

The hosts are the `linuxKey` and `linuxRockyKey` slots of
`tests/live/hosts.local.json`, read by name inside the script. Of each slot only
the host and the user are read; sign-in is by key only (BatchMode), and the
console shows only the host and the user. A host that does not answer one 8 s
connect is NOT RUN (host off). A refused connection or a name that does not
resolve: NOT RUN, with which. On each host the probe makes a temporary folder,
copies the helper there and checks its SHA-256, then:

- **P3.** Six ssh sessions, each starting a holder with `hold --detach` and
  logging out as its command ends: three with a terminal (`ssh -tt`, the way a
  session's terminal starts it) and three without (`ssh -T`, an exec). 10 s and
  60 s after the last logout, a new connection checks each holder by its pid
  and its own command line. It records each holder's cgroup, logind's
  KillUserProcesses and KillExcludeUsers, and the user's Linger.
- **P6.** One exec reads its own PATH, then the PATH of the user's login shell
  started from it with `-l` (the probe's reading of D8's "through the host's
  login shell"; D8 does not say whether that shell is interactive) and with
  `-il` (recorded only), and what `command -v` finds for claude, codex and
  node in each.

Then it ends each holder (only a process with its own command line), deletes
what it made one name at a time (no recursive delete), and checks that nothing
is left. It removes `/tmp/aicc-<uid>` only if that folder was not there before.

Decision lines (written before measuring):

- **P3 HOLDS** on a host when the holder is alive 60 s after the logout that
  started it in 3 of 3 runs of each form. **DOES NOT HOLD** when a holder is
  gone at 60 s in any run. **CANNOT MEASURE** when a form has fewer than 3
  runs whose holder started, or a check could not be read. Fallback (ADR-030):
  that host kind is labelled "no re-attach" and resumes by conversation id.
- **P6 SAME** on a host when the exec's PATH and the login shell's PATH hold
  the same entries in the same order once repeats are dropped, and claude,
  codex and node each resolve to the same file (or to none) in both.
  **DIFFERS** otherwise, with what differs. Fallback (ADR-030): CLI paths come
  from a login-shell lookup in the probe report.

The record is `p3-p6-result.json` in the output folder, with the home folder
written as `~` and the user name as `<user>`. Exit 0: every host was measured
or not run; 1: a host was not left as found; 2: the probe could not run. The
answers are in ADR-030 after the P12 result ("P3 and P6 result", 2026-11-21):
P3 HOLDS on the Linux host with key sign-in (a host with logind
cleanup on was not measured). P6 is SAME there on the line above, which compares the
exec with `-l`; `claude` was found only by `-il`, so against the user's interactive
login shell, the comparison ADR-029's P6 names, that host differs and the P6 fallback
applies on it. The Rocky Linux 10 host was NOT RUN on 2026-11-21 (its one connect failed;
recorded as host off). Rocky Linux 10: not run; its one 8 s connect failed on 2026-11-22
(host off); owed to beta.15. Rocky Linux 10 was measured on 2026-11-23
(plan 2.1.3-beta.15 C7): P3 HOLDS, alive at 60 s in 3 of 3 runs of each form
(KillUserProcesses no, Linger yes, so a host with cleanup on is still not measured), and
P6 SAME, with the exec, `-l` and `-il` alike and claude found by all three.
