# Service overhead harness (Windows test VM)

What each part of the app costs, idle and busy, with 1, 10 and 25 sessions: per process CPU, memory,
handles and I/O, the main process broken down by service, and the renderer's own figures. It measures
the **installed** app on the test VM, on a README staging root, never on anyone's own machine and
never on the VM user's own app data. Nothing here ships: `package.json` `build.files` names the few
scripts the app needs, and this folder is not one of them.

The numbers are relative, not absolute. The VM runs the app in session 0 (started from SSH), which
forces DOM terminals (`--dom-terminals`) and software GL, so renderer and GPU figures do not match a
desktop with WebGL terminals. The fake Claude CLI is not Claude Code: it writes its status file every
2 s and sends no hook events. Defender is on, but the VM does not reproduce a desktop's file churn;
I/O operations per second is the proxy (read and write operations, pipes and sockets included).

## The parts

| File | Does |
| --- | --- |
| `run-matrix.cjs` | Runs the grid on the VM and leaves every reading in one folder. |
| `gen-sessions.cjs` | Writes N Claude sessions into the staging session state, the fake CLIs' `mode` (idle or busy), and one service off for an ablation. |
| `load-sidecar.cjs` | While busy, appends one transcript line per session every 5 s, so Tokenomics and session logging have work. |
| `sample-processes.ps1` | Every 5 s: CPU time, private bytes, working set, handles, threads and I/O counts per process (Win32_Process). Read-only. |
| `cdp-sample.cjs` | The app window over CDP (raw WebSocket, no Playwright): Performance metrics over one held session, a renderer CPU profile, the `prefers-reduced-motion` A/B, the Services rows, and the Resume press at start-up. |
| `main-inspector.cjs` | The main process over its Node inspector: event loop use, `app.getAppMetrics()` (it names each service worker by the serviceName it was forked with; their command lines are identical), which process draws which window, the live timers, and a main CPU profile. |
| `service-map.json` | Which main-process code is which service, by function name or the top-level function or class it sits in (main is bundled but not minified). |
| `report.cjs` | Turns a results folder into `report.md` and `report.json`. Runs anywhere. |
| `lib/aggregate.cjs`, `lib/classify-process.cjs` | The arithmetic and the process roles. Unit-tested on any machine (`tests/unit/scripts/perf-*.test.ts`). |

It reuses the README staging (`scripts/readme-shots/stage`): `seed.js` makes the throwaway root,
`launch.js` starts the installed app on it with `--remote-debugging-port` and `--inspect` in an
isolated environment, and `fake-claude.js` draws the sessions. `fake-claude.js` reads the `mode`
`gen-sessions.cjs` writes (no mode: busy, as the README pipeline always had it).

## The grid

For each N in 1, 10 and 25: write the sessions, start the app, press Resume, settle 5 min, measure an
idle window of 3 min; switch the fake CLIs to busy and start the transcript writer, settle 90 s,
measure a busy window of 3 min; stop the app. At N=25 each window is followed by a 60 s renderer and
main CPU profile and a 2 x 60 s reduced-motion A/B. Then four ablation runs at N=25 busy: all services
on, then Tokenomics, session logging and the hooks gateway each switched off. About 80 minutes.
`--dry-run` prints the plan and its length; every number is an option (see the top of `run-matrix.cjs`).

Between runs the app is stopped with `launch.js stop`, and the next run waits until no app process is
left and ports 9333 and 9229 are free. It stops processes the run left only when they carry the staging
root on their command line and started during the run; if the ports do not free up it stops the whole
grid rather than measure on top of a leftover. It refuses to start while any app instance runs.

## Running it

On the VM, in a checkout with `node_modules` (`npm ci`) at the commit to run, with the build to
measure installed. Start it through WMI so it (and the app) run outside the SSH session's job:

```
# a .ps1 on the VM, run with Invoke-CimMethod Win32_Process Create (as the README staging's VM runs do):
$env:CCC_STAGE_ROOT = '<a new, empty folder>'
Set-Location <checkout>
node scripts\perf\run-matrix.cjs --prepare --app-version <installed version> *> <log file>
```

`--prepare` seeds the root as the README pipeline does (seed, first start and stop, re-seed, all with
`--dom-terminals`). Results land in `<root>\perf-out\<time>`; `run.log` there shows progress. Then:

```
node scripts\perf\report.cjs <root>\perf-out\<time>
```

Afterwards undo the staging as the README pipeline does: `seed.js --restore` (it removes the marked
`C:\dev` project folders), then delete the root.

## What the report holds

- CPU per process for every window (mean, % of one core), with app and terminal totals, sessions live,
  main event loop busy share and renderer main thread busy share (CDP task time).
- Each window in detail: CPU mean and p95, private MB, I/O ops/s, handles and threads per process; the
  renderer's layouts and style recalculations per second, heap and DOM size; the Services rows (state,
  events per second, the Tokenomics row's own CPU figure).
- The main process by service from its CPU profile (with the frames it could not attribute), and the
  renderer profile's top functions.
- The reduced-motion A/B: renderer and GPU CPU with the always-on sidebar animations running and
  stopped.
- The ablations: app CPU with each service off against all on.
- The repeating timers in main, with their periods.
