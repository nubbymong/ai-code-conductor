## 2026-11-17 -- Probe P16: one helper process per hook event on Windows (pass)

ADR-030 probe P16 asks what starting one helper process per hook event costs
on Windows. It gates hooks through the holder (S12, beta 8 sections A3 and
A4); a FAIL would have meant declared exception 11. Section A1 of the
2.1.3-beta.8 plan. No product code changed.

**Pass line, set by the plan before measuring** (ADR-030 gives none): with
Defender real-time protection on, p95 wall time at most 150 ms, longest at
most 750 ms, mean CPU at most 50 ms per event, no failed run in 350.

**Method** (`helper/probes/p16-windows-hook-cost.ps1`, run on the Windows test
machine over SSH):
- Step 0 ran the machine's claude.exe (2.1.296) once with `--settings` whose
  SessionStart hook recorded its own parent chain, in a fresh environment with
  a placeholder API key and the API address on a closed local port (no account
  used, nothing sent off the machine). Seen the same way twice by hand and in
  every run of the script:
  `"C:\Program Files\Git\bin\bash.exe" -c "<command>"` starts
  `usr\bin\bash.exe -c "<command>"`, which starts the command; the event JSON
  arrives on standard input; and a console host (conhost.exe) starts under the
  launcher, so claude gives the launcher a hidden console of its own.
- Step 2 started `aicc-helper list --store <store>` behind that launcher, with
  a console of its own as claude does, against one empty holder in a throwaway
  store. Each run was started suspended in a job object, so every process in
  the chain (four: Git's launcher, the console host, Git's bash, the helper)
  was counted.
- The helper was the signed per-user copy of the 2.1.3-beta.7 build installed
  on the test machine (sha256 7a099cd8..., the same file as the install
  folder's bundled helper). The beta.7 release was not yet published when this
  ran (its macOS notarisation was being retried); its Windows build was the
  one installed.

**Result: PASS.** 350 runs, 0 failed. p95 wall 33.98 ms, longest 39.57 ms,
mean wall 32.58 ms. Mean CPU 27.57 ms per event: the helper about 3.1 ms,
Git's launcher 6.2 ms, the console host 7.7 ms, Git's bash 10.6 ms. Defender's
own process added 18.8 ms of CPU per event outside the chain (reported beside
the verdict, not in the pass line; chain and Defender together are about
46 ms). Reference: today's HTTP hook POST took 0.69 ms mean, 0.91 ms p95, and
about 1.1 ms of CPU (client and server).

**Decisions made while building the probe, before the measured run:**
- CPU is taken two ways: CPU cycles per process, converted at the machine's
  measured cycle rate, and the job's own user and kernel time. Windows charges
  the second in clock ticks of about 15.6 ms and under-counts short bursts on
  idle processors (4.5 ms mean against 27.6 ms from cycles). The pass line is
  judged on the larger of the two means. This rule was fixed after three
  10-run harness checks, which found the tick figure reading near zero, and
  before the one 350-run measurement; the pass line itself never moved.
- The 350-run measurement is the first and only full run of the final script
  (sha256 13ba3577...). The harness checks used the same helper, so Defender
  had already scanned it: a first start after an update (a new, unscanned
  per-user copy) is not in these numbers. The max line exists for that case.
- `list` takes the store lock only for a stale record, so the stand-in does
  not take it for the live holder; the hook mode in A3 may. One lock is a
  file open and a lock call, small next to the process starts measured here.

**For A3 and A4:** the hook command runs under Git Bash, so it is written with
forward slashes and quoted paths, for example
`"C:/Users/<user>/AppData/Local/AI Code Conductor/helper/<version>-<hex>/aicc-helper.exe" hook ...`.
Most of the cost is Git Bash and its console host, which Claude Code chooses,
not the helper. One fast machine was measured (a desktop CPU); slower machines
cost more.
