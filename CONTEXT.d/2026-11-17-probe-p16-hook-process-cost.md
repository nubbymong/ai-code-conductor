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

**Result: PASS**, in all six full runs (350 runs each, 0 failed; run 6 just
after midnight UTC, on 2026-11-18):

| Run (script sha256) | p95 wall | longest | mean CPU | Defender CPU per event |
|---|---|---|---|---|
| 1 (13ba3577) | 33.98 ms | 39.57 ms | 27.57 ms | 18.8 ms |
| 2 (4a2d8714) | 35.45 ms | 39.80 ms | 28.15 ms | 18.9 ms |
| 3 (15e0e229) | 36.98 ms | 48.07 ms | 28.80 ms | 19.5 ms |
| 4 (26e6f38d) | 37.19 ms | 42.25 ms | 29.61 ms | 20.0 ms |
| 5 (bc511bfa) | 38.21 ms | 50.78 ms | 29.60 ms | 19.9 ms |
| 6 (86320988, committed) | 38.61 ms | 41.28 ms | 29.91 ms | 20.0 ms |

In run 6 the mean CPU splits as: the helper 3.4 ms, Git's launcher 6.7 ms,
the console host 8.2 ms, Git's bash 11.6 ms. Defender's own process is
outside the chain (reported beside the verdict, not in the pass line; chain
and Defender together are about 50 ms, right at the CPU line). Reference:
today's HTTP hook POST took 0.66 ms mean, 0.87 ms p95, and about 1.1 ms of
CPU (client and server). The figures crept up by about 2 ms of CPU from run
1 to run 6, over an hour and a half on a host that was also running other
work; every run is far inside the line.

Runs 2 to 6 exist because review found gaps in the script's own checks, not
in what it measures: a store folder made by someone else, or an output folder
inside the store, could be removed at the end, or a refused output folder
written to; a run whose CPU sum missed a process could still pass; a slow
schedule could outlast the holder; a Defender exclusion did not fail the
verdict, the exclusion check missed folder, wildcard, full-path and
extension rules over the chain's programs, and an unreadable exclusion list
could still give a PASS; and a chain writing more than one pipe holds would
stall. The WP1 legacy-Codex gate also refused one environment variable name
in the new file. Run 6 is the committed script.
The way the chain is started, timed and counted, and the pass line, did not
change between runs.

**Decisions made while building the probe, before the measured run:**
- CPU is taken two ways: CPU cycles per process, converted at the machine's
  measured cycle rate, and the job's own user and kernel time. Windows charges
  the second in clock ticks of about 15.6 ms and under-counts short bursts on
  idle processors (4 to 6 ms mean against 28 to 30 ms from cycles). The pass line is
  judged on the larger of the two means. This rule was fixed after three
  10-run harness checks, which found the tick figure reading near zero, and
  before the first 350-run measurement; the pass line itself never moved.
- Harness checks and earlier runs used the same helper, so Defender had
  already scanned it: a first start after an update (a new, unscanned
  per-user copy) is not in these numbers. The max line exists for that case.
- `list` takes the store lock only for a stale record, so the stand-in does
  not take it for the live holder; the hook mode in A3 may. One lock is a
  file open and a lock call, small next to the process starts measured here.
- `list` also cannot prove the hello's nonce check completed: on a read error
  it keeps a running holder's record. No run came near the 2 to 3 second
  connect and hello deadlines, and the helper's CPU per run has no low
  outliers; the hook mode in A3 reports its handshake itself.
- The probe's fresh environment is built from an allow-list and sets HOME,
  USERPROFILE, APPDATA, LOCALAPPDATA, CLAUDE_CONFIG_DIR and TEMP; any other
  CLI home falls back to its default under that HOME. The file names no other
  CLI's home variable, because `helper/` is outside every WP1 legacy-Codex
  scope and an unscoped file may not mention that CLI at all.

**For A3 and A4:** the hook command runs under Git Bash, so it is written with
forward slashes and quoted paths, for example
`"C:/Users/<user>/AppData/Local/AI Code Conductor/helper/<version>-<hex>/aicc-helper.exe" hook ...`.
Most of the cost is Git Bash and its console host, which Claude Code chooses,
not the helper. One fast machine was measured (a desktop CPU); slower machines
cost more.
