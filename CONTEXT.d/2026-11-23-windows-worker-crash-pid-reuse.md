## 2026-11-23 -- "Worker exited unexpectedly" on Windows part 2: tests ended pids Windows had given to vitest workers

Windows part 2 of the unit suite failed with "Worker exited unexpectedly" twice: run 45046712982
(beta.14 aggregate; home-guard.test.ts never reported) and run 45123495761 (beta.15 aggregate,
PR #757; reauth-staging.test.ts never reported). In the last 300 CI runs (2026-11-19 to 23) part 2
ran its tests 82 to 86 times; these two are the only "Worker exited unexpectedly" in any test job
(105 failed or cancelled test jobs with a log, every one searched; 81 more were cancelled before a
step ran).

- **The cause.** installer-nsis-behaviour.test.ts ended the processes it had started by their bare
  pid whenever the pid still answered: three afterAll hooks, endAll, endHeld. The probes end most of
  those processes themselves, and Windows gives a freed pid to a new process within seconds. The
  suite runs with `pool: 'forks'`, one new node.exe worker per file (about one a second in part 2),
  so a freed pid can belong to a vitest worker running another file by the time the hook runs.
  `process.kill(pid)` then ends that worker, and vitest reports it as "Worker exited unexpectedly"
  (vitest 4.1.12 raises it on the fork's `exit` event while it runs a file).
- **Measured on the Windows runner** (diag branch, part 2 as CI runs it, the old kill code with each
  kill logged, vitest's main process logging each worker's pid, files and exit code):
  - Run 45140445533 (18 part-2 runs): freed probe pids were held 3 to 21 s later by node.exe,
    conhost.exe and powershell.exe; the old uninstall afterAll ended a conhost.exe that way once. A
    pid a probe stand-in had used was later a vitest worker's.
  - Run 45144695065 (18 more, the freed pids watched every 100 ms): five times a pid freed by a
    probe stand-in (ccc-probe-helper.exe, aicc-helper.exe, ccc-probe-app.exe) was held 7 to 63 s
    later by a live vitest worker while the installer file still ran (once more for a short-lived
    node process the file started). Ending each such pid as the old code did gave "Worker exited
    unexpectedly" 7 to 19 ms later, all six times: exit code 1, no signal, the worker's file
    unreported. The old kill sites ended a WmiPrvSE.exe that held a freed pid.
  - Every other worker exit in the 36 runs (14,934) was vitest's own stop (SIGTERM, or code 0).
- **The two CI failures fit it.** Both were in part 2, the only part with the installer file. The
  crashed worker had started seconds before (reauth-staging at 06:23:40.6, home-guard at 17:00:27.1,
  each when the file before it in that worker slot finished) and died before the next file took the
  slot, 31 to 44 s into the installer file, where its uninstall afterAll ends every pid it started.
  reauth-staging.test.ts starts no process; neither log has an out-of-memory or fatal error line.
  The CI logs carry no pid, so which pid was ended in those two runs is inferred from this timing.
- **The fix** (tests and a test helper only). `tests/helpers/started-processes.ts`: a process a test
  spawned is ended through its ChildProcess (Node ends it through its handle, and Windows gives no
  other process the pid while the handle is open) and read as running through it; a process a test
  knows only by a pid read from a file, and wrote itself, ends itself once a stop file exists; one it
  did not write is ended only while its pid still runs that image, and never node.exe. Commit
  5bb0889e had moved the installer file to handles for spawned processes (kept) and to a
  program-path check for pid-only ones, which cannot tell a node.exe from a vitest worker; those now
  use stop files. The same class is fixed in fake-cli.test.ts (a node.exe helper and a ping.exe
  "browser") and claude-cli-version.test.ts (a hung node.exe CLI).
- **Kept from recurring.** started-processes.test.ts checks that no file under tests/unit, tests/wp1,
  tests/integration or tests/helpers calls `process.kill` with a signal other than 0 outside the
  helper (red before the fix on the three sites; five helper mutants each red).
