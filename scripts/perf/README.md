# Service overhead harness (Windows test VM)

What each part of the app costs, idle and busy, with 1, 10 and 25 sessions: per process CPU, memory,
handles and I/O, the main process broken down by service, and the renderer's own figures. It measures
the **installed** app on the test VM, on a README staging root, never on anyone's own machine and
never on the VM user's own app data. Nothing here ships: `package.json` `build.files` names the few
scripts the app needs, and this folder is not one of them.

It runs only on the test VM: `run-matrix.cjs` refuses unless the machine is a Hyper-V guest
(Win32_ComputerSystem model "Virtual Machine") and `CCC_PERF_TEST_VM=1` is set, so a desktop that sets
the variable by mistake is still refused. After each start it checks that both debug ports are held
by the app `launch.js` started (pid, executable and start time from its record), and the standalone
`cdp-sample.cjs` and `main-inspector.cjs` commands make the same check before they attach.

The numbers are relative, not absolute. The VM runs the app in session 0 (started from SSH), which
forces DOM terminals (`--dom-terminals`) and software GL, so renderer and GPU figures do not match a
desktop with WebGL terminals. The fake Claude CLI is not Claude Code: it writes its status file every
2 s and sends no hook events. Defender is on, but the VM does not reproduce a desktop's file churn;
I/O operations per second is the proxy (read and write operations, pipes and sockets included).

CPU comes from each process's cycle count. Windows charges a process's user and kernel time at the
clock tick (15.6 ms), so a process that runs in short bursts woken by timers is undercounted: on the
VM the app window's renderer read 1.2 % from those times while its main thread alone was measured
3.7 % busy (CDP task time). The sampler also reads every process's cycle count (QueryProcessCycleTime,
through PowerShell's Add-Type: nothing is installed), and the counter's rate, measured on a spinning
thread when the sampler starts. Every mean and p95 comes from the cycles. The report marks a cell
that does not: `a` for the app's own figure (`app.getAppMetrics()` between the window's two
snapshots), `w` for Windows' tick-charged time, a lower bound. Both are also shown beside the cycle
figure in each window's own table.

## The parts

| File | Does |
| --- | --- |
| `run-matrix.cjs` | Runs the grid on the VM and leaves every reading in one folder. |
| `gen-sessions.cjs` | Writes N Claude sessions into the staging session state, the fake CLIs' `mode` (idle or busy), and one service off for an ablation. On its first run it keeps the seeded transcripts and databases, and it puts them back before every run, so no run starts from files an earlier run grew. |
| `load-sidecar.cjs` | While busy, appends one transcript line per session every 5 s, so Tokenomics and session logging have work. It ends with the runner. |
| `sample-processes.ps1` | Every 5 s: CPU cycles, CPU time, private bytes, working set, handles, threads and I/O counts per process (Win32_Process and QueryProcessCycleTime). Read-only. |
| `cdp-sample.cjs` | The app window over CDP (raw WebSocket, no Playwright): Performance metrics over one held session, a renderer CPU profile, the `prefers-reduced-motion` A/B/A, the Services rows, and the Resume press at start-up. |
| `main-inspector.cjs` | The main process over its Node inspector: `app.getAppMetrics()` (it names each service worker by the serviceName it was forked with; their command lines are identical), which process draws which window, a main CPU profile, and the bundle's files for naming its frames. Electron runs Node's loop inside its own, so `performance.eventLoopUtilization()` reads zero in main; the profile's busy share is the main JS thread figure. |
| `service-map.json` | Which main-process code is which service, by function name or the top-level function or class it sits in (main is bundled into `out/main/index.js` and chunks, but not minified). One row per Services registry row that runs in main, plus the other main-process work by name. |
| `report.cjs` | Turns one or more results folders into `report.md` and `report.json`. Runs anywhere. |
| `lib/aggregate.cjs`, `lib/classify-process.cjs`, `lib/guard.cjs` | The arithmetic, the process roles, and where the harness may run. Unit-tested on any machine (`tests/unit/scripts/perf-*.test.ts`). |

It reuses the README staging (`scripts/readme-shots/stage`): `seed.js` makes the throwaway root,
`launch.js` starts the installed app on it with `--remote-debugging-port` and `--inspect` in an
isolated environment, and `fake-claude.js` draws the sessions. `fake-claude.js` reads the `mode`
`gen-sessions.cjs` writes (through `fake-mode.js`); with no mode in its `fake-stage.json`, as in the
README pipeline, it runs exactly as it did before the harness.

## The grid

For each N in 1, 10 and 25: write the sessions, start the app, press Resume and open each session once
(a resumed tab starts its terminal only when it is first opened), wait until N session CLIs run,
settle 5 min, measure an idle window of 3 min; switch the fake CLIs to busy and start the transcript
writer, settle 5 min, measure a busy window of 3 min; stop the app. At N=25 each window is followed
by a 60 s renderer and main CPU profile, then (after a 15 s gap) a reduced-motion A/B/A of 3 x 60 s:
as is, with `prefers-reduced-motion: reduce`, and as is again, so drift shows as a difference between
the two as-is parts. Then five ablation runs at N=25 busy: all services on, Tokenomics, session
logging and the hooks gateway each switched off, and all on again. The two all-on windows give the
noise each saving is read against. About 115 minutes. `--dry-run` prints the plan and its length;
every number is an option (see the top of `run-matrix.cjs`).

Each window settles 5 minutes, as the plan sets: the busy window follows the idle one on the same
app start, but the transcript writer and the busier CLIs start only then, and the Tokenomics worker
walks every transcript once every 5 minutes. The report estimates for each window whether one of
those walks falls inside it (from the app's start and the walk's fixed period: the app does not
report when a walk ran).

Every number is relative to the run's own windows. To read a difference between two cells, run the
grid twice and give `report.cjs` both folders: the first folder's report then has each cell's mean and
spread across the two runs.

Between runs the app's process tree is recorded, the app is stopped with `launch.js stop`, and
whatever of the tree outlives the stop is ended by pid and start time (console hosts and shells
included). `taskkill /T` exits non-zero when a member of the tree has already ended by the time it is
reached, which every stop on the VM hit; `launch.js stop` treats that as success once the app itself
has ended. The vision browser the app starts is not in its tree: the runner ends it, and anything else
of the run whose command line names the staging root. Each run's report lists what it had to end.
The next run waits until no app process is left and ports 9333 and 9229 are free; if they do not free
up, or cannot be checked, it stops the whole grid rather than measure on top of a leftover. It refuses
to start while any app instance (installed or a development Electron) runs.

## Running it

On the VM, in a checkout with `node_modules` (`npm ci`) at the commit to run, with the build to
measure installed. Start it through WMI from SSH, so it and the app it starts run in session 0,
outside the SSH session's job (an SSH session's processes end with it). Put the run in a `.ps1` on
the VM (placeholders in angle brackets):

```powershell
# <run folder>\perf-run.ps1
$env:PATH = 'C:\Program Files\nodejs;' + $env:PATH
$env:CCC_STAGE_ROOT = '<a new, empty folder>'
$env:CCC_PERF_TEST_VM = '1'
Set-Location '<checkout>'
node scripts\perf\run-matrix.cjs --prepare --app-version <installed version> *> '<run folder>\perf-run.log'
```

and start it from the SSH session:

```powershell
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File <run folder>\perf-run.ps1'; CurrentDirectory = '<run folder>' }
```

It returns at once with the new process's id. Follow the run from SSH with
`Get-Content '<run folder>\perf-run.log' -Tail 20`; the results folder's `run.log` has the same lines.
`--prepare` seeds the root as the README pipeline does (seed, first start and stop, re-seed, all with
`--dom-terminals`). Results land in `<root>\perf-out\<time>` (or `--out`, which must be inside the
root). Then, anywhere:

```
node scripts\perf\report.cjs <results folder> [<second results folder>] [--functions RateLimitBar,handleSelectionChanged]
```

Copy the results folder out of the root before removing it, then undo the staging as the README
pipeline does: `seed.js --restore` (it removes the marked `C:\dev` project folders), then delete the
root.

## What the report holds

- The runs that failed (with their errors) and the planned runs that never started.
- CPU per process for every window (mean, % of one core), with app and terminal totals, the sessions
  running at once, the main JS thread's busy share (CPU profile, where one was taken), the renderer
  main thread's busy share (CDP task time) and whether a Tokenomics walk was expected in the window.
- Each window in detail: CPU mean and p95, the app's own figure and Windows' figure beside them,
  private MB, I/O ops/s, handles and threads per process; the renderer's layouts and style
  recalculations per second, heap and DOM size; the Services rows (state, events per second, the
  Tokenomics row's own CPU figure, files in its last walk at both ends of the window).
- The main process by service from its CPU profile: the whole main process's CPU in the window before
  the profile next to its JS thread's busy share in the profile (and the whole process's CPU while it
  was profiled, which includes the profiler's own sampling), the split of the thread's busy time
  (services, garbage collection, native, not attributed), and the frames it could not attribute. The
  profile covers the JS thread only: the rest of main's CPU (Chromium's browser-process threads for
  I/O, IPC and the thread pool, and any Node worker threads) is not attributed. The renderer
  profile's top functions.
- With `--functions a,b`: each named function's self and inclusive time in every profile. B2 and B3
  judge `RateLimitBar` self time and `handleSelectionChanged` inclusive time in a 90 s renderer
  profile: run the grid with `--profile 90` for those.
- The reduced-motion A/B/A: renderer, GPU and main CPU and the renderer's own figures, each part cut at
  its switches (a part whose page did not take the emulation is marked not valid).
- The ablations: app CPU with each service off against the mean of the all-on windows, and whether
  each saving is larger than the spread between those windows.
- The clean-up between runs: what `launch.js stop` said, and what the runner had to end afterwards.
- With two or more folders: each cell's mean and spread across them.
