## 2026-11-26 -- installer test: the why probe's two waits share one bound

2.1.3-beta.19 section 6.4 (aicc_planning#440, item 4). Built on cc36c7f3 as
test/installer-why-probe-bound. Test harness only: build/installer.nsh is
unchanged, no bound was loosened, nothing retries.

- **The defect.** The probe in tests/unit/main/installer-nsis-behaviour.test.ts
  that runs CccWhyNotEnded for real waited up to 30 s for the copy's exit code
  (300 rounds of Sleep 100), then up to 30 s more for the signal that the
  process object is gone. That is 60 s, the same as spawnSync's timeout and the
  case's own. A copy that never exits therefore ended in a spawn timeout with no
  log, and the failure said nothing about why.
- **The fix.** The probe takes one budget from its ini (`budgetMs`, 30000 when
  absent) and measures it with GetTickCount, as the difference of two tick
  counts so the count's wrap and sign do not matter. The exit-code loop ends at
  the budget; the signal wait gets what is left, never less than 0. The log now
  names `left` (what the signal wait was given) beside `exitcode` and
  `signaled`. The existing cases do not name a budget, so they keep 30 s.
- **The new case.** A copy that never exits, with `budgetMs=2000`: the probe
  finishes (done=1) and logs exitcode=259 (still active), left=0 and
  signaled=258 (a wait that timed out). `left=0` is the check that the two waits
  share one bound; there is no wall-clock assert beyond the case's own timeout.
- **A probe that does not finish** now fails with the log it had written, not
  with the spawn error alone.
- **Where it runs.** CI's Windows jobs only (HOST QUARANTINE). It was never run
  on a developer machine: the probe script was compiled with makensis to check
  its syntax, and the red and green runs are the release workflow's dry run on
  the section's branch (see the PR's section note for the run ids).
