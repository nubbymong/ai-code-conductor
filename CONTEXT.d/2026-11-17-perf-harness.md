## 2026-11-17 -- Service overhead harness for the Windows test VM (2.1.3-beta.7, plan section B1)

**What.** `scripts/perf/` measures what each part of the app costs on the test VM, idle and busy, with 1, 10 and 25 sessions, against the installed build on a README staging root (started from SSH through WMI, so in session 0, with `--dom-terminals`). `run-matrix.cjs` runs the grid and the ablations (Tokenomics, session logging and the hooks gateway each switched off at N=25 busy); `report.cjs` turns a results folder into the per-service tables. Nothing here is packaged. `scripts/readme-shots/stage/fake-claude.js` now reads a `mode` (idle or busy) and a `copies` map from its `fake-stage.json`; with neither it behaves as before, so the README pipeline is unchanged.

**Decisions, from the first VM runs.**
- Windows charges a process's CPU time at the 15.6 ms clock tick, so a process that runs in short timer-driven bursts is undercounted: the app window's renderer read 1.2 % of a core from Win32_Process while its main thread alone was measured 3.7 % busy over CDP, and main 0.04 % where `app.getAppMetrics()` read 1.1 %. The mean CPU of the app's own processes therefore comes from the app's figure between each window's two snapshots; Windows' samples give the other processes, every p95, memory, handles and I/O.
- Electron runs Node's loop inside its own, so `performance.eventLoopUtilization()` reads zero in main. Main's busy share comes from its CPU profile instead. Node lists no repeating timers through `_getActiveHandles`, so there is no timer inventory; the profile attributes timer callbacks.
- A resumed tab starts its terminal only when it is first opened, so Resume alone starts one session whatever N is. The runner opens each card once and measures only once N fake CLI processes run for it.
- Main is bundled into `out/main/index.js` and chunks, neither minified nor source-mapped. `service-map.json` attributes a frame by its own name or by the top-level function or class it sits in, read from the bundle's files; at N=25 idle 92 % of main's busy time was attributed.
- Raw CDP over Node's own WebSocket, not Playwright: nothing to install on the VM, and no domain switched on beyond the ones a reading needs.
- Copies of the seeded sessions draw their template's scenario, but their status names their own transcript, so session logging and usage attribution follow N files, not one (an early run bound every copy to the same file and was thrown away).

**Baseline, installed 2.1.3-beta.6** (VM: 12 logical CPUs, 8 GB, software GL; % of one core; 3-minute windows):
- N=25 busy: app 43.6 % (40.9 % in the second, ablation-reference window): renderer 30.1, main 7.5, GPU 4.6, Tokenomics worker 0.65, session logging worker 0.48, hooks gateway worker 0.05. Renderer main thread 19.9 % busy (CDP task time).
- N=25 idle: app 7.1 % (renderer 5.1, main 1.2, GPU 0.5). N=10: 3.0 idle, 22.0 busy. N=1: 1.2 idle, 11.9 busy.
- Ablations at N=25 busy, app total saved against all on: Tokenomics 1.1, session logging 2.3, hooks 0.1 points; the two all-on windows differ by 2.7, so only logging is clearly above the noise.
- The renderer is the cost. Its top self-time function at N=25 busy is `formatResetTime` (8.1 ms per second of about 191 ms busy). Main's thread was 1.4 % busy: statusline 2.7, Tokenomics (main side) 2.7 and terminal I/O 2.6 ms per second.
- `prefers-reduced-motion` A/B at N=25 busy: renderer main thread 17.8 to 13.7 % busy, style recalculations 35 to 25 per second, GPU 5.2 to 3.1 % (Windows' figure; this run predates the A/B's own app snapshots). At idle it changes nothing measurable.
- Tokenomics (#302 acceptance: under 5 % of one core with 20+ working sessions): 0.59 to 0.73 % across the four N=25 busy windows with it on, the Services row's own figure agreeing (0.54 to 0.81 %). The VM's transcript tree is 64 files, not a desktop's thousands, and the fake CLI is not Claude Code.

**Not comparable to a desktop.** Session 0 forces DOM terminals and software GL, so renderer and GPU figures are not the owner's WebGL figures; read the numbers as relative between windows.

**Not in this change.** The fixes the numbers point at belong to B2 and B3 (statusline tick churn, hidden-terminal writes).
