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
  self-test ends its terminal with `kill()`, which leaves the pseudoconsole
  to the holder's watch thread, and it usually exits before that thread
  runs; a forced end never runs it. The app runs the self-test through
  `execFile`, whose job lets the self-test's children leave it, so nothing
  else ended the host. Measured on the VM (Windows 11, build 22621) with the
  beta.6 helper, before any change: the host was still running 60 s after 3
  of 4 normal self-test ends (and 2 s after both control runs, the other
  normal ends checked), and 5 s after 1 of 12 forced ends caught while the
  terminal was open. The ticket tied the
  leaks to forced app ends; the VM shows a normal end leaks too.
- Holders were checked the same way: 0 of 6 holders ended with
  `taskkill /F` while running a terminal left their host.

**What changed.**
- `insights-runner.ts`: the running /insights terminals are kept in a set
  (runs for different accounts can overlap); every way a run settles removes
  its terminal. `killInsightsPty()` kills them; the quit teardown calls it
  next to `killCliSetupPty`, before `killAllPty`. The terminal's start reads
  the quit hold in the same step as its spawn. The first-start warm-up
  already held a start after the quit; this no longer depends on it.
- Helper, Windows, `selftest` command only: before it starts anything, the
  self-test puts its own process in a new job that ends every process in it
  when its last handle closes, and keeps that handle until it exits. The job
  allows no child to leave it, so the host ends with the self-test, however
  it ends. If the job cannot be made, the self-test still runs and says so
  on standard error. Holders are not put in a job (probe P7). `detach.rs` is
  untouched.

**Test.** `tests/unit/main/insights-quit.test.ts` cuts the quit teardown out
of `index.ts` (shared cutter: `tests/helpers/main-index-cut.ts`) and runs it
against a faked node-pty: 8 of its 11 cases were red before the change (the
other 3 are controls). `helper/tests/windows_orphans.rs` runs the real
self-test, ends it by force while its terminal is open (8 times) and to its
normal end (6 times), and expects nothing it started to outlive it by 5 s;
it is probabilistic. It was pushed before the fix and passed on the CI
runner (Windows Server 2025, build 26100), where the host ended with the
self-test anyway, so the red evidence is the VM's.

**VM acceptance** (WINDOWS_1, build 22621). (a) With the CI-built fixed
helper: 0 of 20 forced ends mid-run and 0 of 9 normal ends left a host;
`conhost.exe` count 1 before and 1 after. (b) The PR head built as an
unpacked app on a staging root: an Insights run started its 120x30 host and
the fake claude, a normal quit then left no app process, no 120x30 host and
no claude, and the app log says `[insights] 1 /insights terminal(s) ended
at quit`.

**Owed before stable.** The ADR-009 adversarial pass on the helper's job
code (process lifetime in the helper), under the owner rule of 2026-11-15
that betas skip it.
