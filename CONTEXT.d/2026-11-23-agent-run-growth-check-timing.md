## 2026-11-23 -- The agent-run growth check times both sides of its comparison together

beta.15 aggregate (PR #757). The growth check in
`tests/unit/providers/codex/agent-run.test.ts` ("a long unterminated stderr line is handed on in
time linear in its length") failed once on macOS: CI run 45123495761, head ca6fa712, Test
(macos-latest), "zzzzzzzzzzzz: 2.8 ms, then 28.3 ms" against a bound of 8. Commit 5a70436e gave
the long line up to ten runs. The owner rejected that as not a root cause. This entry replaces it.

- **History.** The last 300 CI runs (2026-11-19 to 2026-11-23) had 72 failed Test jobs. The 39 of
  them that ran tests were read: this was the check's only failure. The code under test
  (`src/main/providers/codex/agent-run.ts`) has not changed since 2.1.1.
- **What was measured** (diag run 45139414585, macos-latest; 1,920 trials of the old check, each
  of the four shapes, in two full suites, alone, and alone beside three busy loops). Per run: wall
  time, the process's CPU time, the GC events inside the timed window, and a fixed reference
  workload.
  - Not the code: alone, the worst ratio was 5.7. The usual ratio is 2.8 to 3.6.
  - Not JIT warm-up: the first trial in each fresh process was never the worst (worst 5.35 and
    4.75, against 7.27 and 7.64 for later trials).
  - Not garbage collection: no major GC fell inside any of the 23,040 timed long-line runs. The
    minor GCs inside a window come from the read's own allocation. A forced GC before each run
    did not lower the worst ratio.
  - The runner: 3 CPUs, 2 vitest workers, load average 15 to 27 through the suite. For long-line
    runs, wall time exceeded CPU time by up to 19 ms (p99), and CPU time itself rose two to three
    times in slow stretches, so a check on CPU time would not have been immune either (it reached
    6.37). 75% to 80% of the slow long-line runs had a slow short-line neighbour: a slow stretch
    lasts longer than one read. In the full suite the old check reached 7.27 and 7.64 of its 8.
- **The cause.** The old check timed three short reads first and three long reads after. It
  compared two stretches of time, and failed when a slow stretch began between them.
- **Also found.** The failure message named a shape by its first 12 characters, and three of the
  four shapes start with 12 `z`. So the run that failed does not say which shape it was.
- **The fix** (test only). Each long read is timed next to four short reads timed together (the
  same amount of text), the two taking turns to go first, and the check is on the median of nine
  pairs. Per character the long line must cost under twice what the short one does: the old
  bound (four times the line in under eight times the time), unchanged. Each shape has a name in
  the messages. 5a70436e's retry loop is gone.
- **Proof** (diag run 45142569425, the fixed check verbatim, repeated). Real code: 1,200 of 1,200
  repeats passed (macOS full suite twice, macOS alone, macOS beside three busy loops, ubuntu full
  suite, Windows alone; 200 each). The highest median was 1.40 of 2. Single pairs reached 7.4,
  and the median absorbed them. With a quadratic search in `cutAtSpace` (a full `lastIndexOf`
  every 64th character, 5a70436e's mutant): 80 of 80 repeats failed on macOS alone (lowest median
  5.92), 80 of 80 in the macOS full suite (lowest median 5.82; agent-run.test.ts itself failed
  there too, "no space"), and 3 of 3 on a Windows PC (medians 5.35 to 5.60).
- **Not proven.** What slowed the runner at that moment: the other vitest worker, macOS background
  work, or the host under the virtual machine. Only that the process ran slower in stretches
  longer than one read, and that the new check was not moved by it in 1,200 repeats.
- No vitest or CI configuration changed.
