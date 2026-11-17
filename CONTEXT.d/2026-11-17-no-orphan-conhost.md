## 2026-11-17 -- No conhost left behind by the self-test or an Insights run (aicc_planning#317, 2.1.3-beta.7 section C2)

**Why.** The beta.6 VM smoke found headless `conhost.exe` processes left
running with no parent: three at 80x24 (the session helper's self-test) and
one at 120x30 (an Insights run that was in progress at a normal quit).
(aicc_planning#317)

- Insights: the /insights terminal (`spawnClaudeInsights`) is main's own
  node-pty terminal, outside pty-manager. The quit teardown ended the setup
  terminal, headless runs, cloud agents and every pty-manager terminal, but
  nothing reached this one. Proven from the code.
- Self-test: `CreatePseudoConsole` starts the terminal's host as a child of
  the self-test, and only `ClosePseudoConsole` ends it on purpose. The
  self-test ended its terminal with `kill()`, which leaves the pseudoconsole
  to the holder's watch thread, and it often exited before that thread ran;
  a forced end never runs it. The app runs the self-test through `execFile`,
  whose job lets the self-test's children leave it, so nothing else ended
  the host.
- Measured by hand on the VM (Windows 11, build 22621) with the beta.6
  helper, before any change. Forced ends caught while the terminal was open:
  1 of 12 left the host running (still there 5 s after the end; the script's
  cleanup then stopped it). Normal ends: 4 of 5 left it. Three of those were
  in a run of 4 normal ends and still there 60 s later; the fourth was the
  one control run of the forced-end script, checked 2 s after its end. The
  ticket tied the leaks to forced app ends; the VM shows a normal end leaks
  too.
- Holders were checked the same way: 0 of 6 holders ended with
  `taskkill /F` while running a terminal left their host.

**What changed.**
- `insights-runner.ts`: each running /insights terminal is kept with what
  ends it (runs for different accounts can overlap); every way a run settles
  removes it. `killInsightsPty()` sends each a kill; the quit teardown calls
  it next to `killCliSetupPty`, before `killAllPty`. On Windows, node-pty
  holds the kill of a terminal that has shown no output yet until its first
  output, so the log line says the kill was sent. The run of a terminal
  ended this way is never answered, as a start the quit hold stops is not:
  nothing of it is archived or carried on, whatever exit code the killed
  terminal reports, and the next start records it as "Interrupted by app
  restart". The terminal's start reads the quit hold in the same step as its
  spawn.
- Helper, Windows, `selftest` command only: before it starts anything, the
  self-test puts its own process in a new job that ends every process in it
  when its last handle closes, and keeps that handle until it exits. The job
  allows no child to leave it, so the host ends with the self-test, however
  it ends. If the job cannot be made, the self-test still runs and says so
  on standard error; the app now keeps that note in its log line for the
  self-test (it never changes the result). Holders are not put in a job
  (probe P7). `detach.rs` is untouched.
- Helper, every OS: the self-test now ends its terminal with `Holder::end`
  (`selftest::end_terminal`), which closes it and waits until it has closed,
  so the host does not depend on the job on a normal end.
- `helper/Cargo.toml`: the ToolHelp feature the test needs is on a Windows
  dev-dependency entry, so the release build does not have it. Same pinned
  crate; `Cargo.lock` is unchanged.
- Not changed: on macOS, closing the last window (the app stays in the Dock)
  does not end an Insights report. Like a headless run or a cloud agent, it
  is a background job that finishes on its own time limit, and its run
  stays readable when the window opens again. A quit ends it.

**Test.**
- `tests/unit/main/insights-quit.test.ts` cuts the quit teardown out of
  `index.ts` (shared cutter: `tests/helpers/main-index-cut.ts`) and runs it
  against a faked node-pty. Against the beta source, 8 of its first 11
  cases were red. Against head c574ea98, 3 were red: the kill line, a run
  ended at quit left unanswered and recorded by the next start, and a killed
  terminal that reports exit code 0. `tests/unit/main/session-helper-manager.test.ts`
  has one new case for the note in the log line, red against c574ea98.
  Those runs were local, through the locked runner.
- `helper/tests/windows_orphans.rs` (Windows only) runs the real self-test.
  For each forced end it suspends every thread of the self-test's host as
  soon as the host is seen, then ends the self-test by force: a suspended
  host cannot end by itself on any build, so only the job can end it. It
  needs 5 such ends in at most 30 tries, and fails if fewer land. It also
  runs 6 normal ends, and fails on a self-test note that it ran without its
  job. Nothing the self-test started may outlive it by 5 s.
- The first form of that test (it waited for a host to stay by chance) was
  never seen red: on the CI runner (Windows Server 2025, build 26100) the
  host ended with the unfixed self-test anyway. The form above was seen red
  in CI run 44000642626 (head d3eed3a7, the job call taken out): 5 of 5
  forced ends landed and each left its host running.
- `helper/tests/hold.rs` `the_self_test_closes_its_terminal_before_it_moves_on`:
  once `end_terminal` returns, the child's exit is known, which the holder
  records only after it has closed the terminal. Seen red on all three
  Helper runners in CI run 44001006211 (head d5c67d54, `end_terminal` still
  `kill()`).

**VM acceptance** (WINDOWS_1, build 22621), run on head 25fac78b, before the
review fixes above. (a) With the CI-built helper that has the job: 0 of 20
forced ends mid-run and 0 of 9 normal ends (8, and the control run) left a
host; `conhost.exe` count 1 before and 1 after. (b) That head built as an
unpacked app on a staging root: an Insights run started its 120x30 host and
the fake claude, a normal quit then left no app process, no 120x30 host and
no claude, and the app log said `[insights] 1 /insights terminal(s) ended
at quit` (the line now reads `kill sent to 1 /insights terminal(s) at
quit`). The review fixes were not run on the VM again; CI covers them.

**Owed before stable.** The ADR-009 adversarial pass on the helper's job
code (process lifetime in the helper), under the owner rule of 2026-11-15
that betas skip it.
