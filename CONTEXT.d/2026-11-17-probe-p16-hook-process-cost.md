## 2026-11-17 -- Probe P16: one helper process per hook event on Windows (pass)

ADR-030 probe P16 asks what starting one helper process per hook event costs
on Windows. It gates hooks through the holder (S12, beta 8 sections A3 and
A4); a FAIL would have meant declared exception 11. Section A1 of the
2.1.3-beta.8 plan. No product code changed.

**Pass line, set by the plan before measuring** (ADR-030 gives none): with
Defender real-time protection on, p95 wall time at most 150 ms, longest at
most 750 ms, mean CPU at most 50 ms per event, no failed run in 350. The CPU
is that of the hook chain's own processes, as the plan wrote it.

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
  was counted. From run 7 the probe also reads, beside the verdict, the CPU of
  Defender's own process, the holder, the probe's own process and the whole
  machine (from the processors' idle cycles), each per event and net of idle.
- The helper was the signed per-user copy of 2.1.3-beta.7 installed on the
  test machine (sha256 7a099cd8..., Authenticode valid). The beta.7 release
  was published at 23:13Z on 2026-11-17, during the session: runs 1 to 3 came
  before it, runs 4 to 7 after. The helper inside the published Windows
  installer (whose sha256 matches the release's own digest) has the same
  sha256, and so does the installed app's bundled copy; from run 7 the probe
  checks the second itself.

**Result: PASS**, in all seven full runs (350 runs each, 0 failed; runs 6 and
7 on 2026-11-18):

| Run (script sha256) | p95 wall | longest | mean CPU | Defender CPU per event |
|---|---|---|---|---|
| 1 (13ba3577) | 33.98 ms | 39.57 ms | 27.57 ms | 18.8 ms |
| 2 (4a2d8714) | 35.45 ms | 39.80 ms | 28.15 ms | 18.9 ms |
| 3 (15e0e229) | 36.98 ms | 48.07 ms | 28.80 ms | 19.5 ms |
| 4 (26e6f38d) | 37.19 ms | 42.25 ms | 29.61 ms | 20.0 ms |
| 5 (bc511bfa) | 38.21 ms | 50.78 ms | 29.60 ms | 19.9 ms |
| 6 (86320988) | 38.61 ms | 41.28 ms | 29.91 ms | 20.0 ms |
| 7 (a1ded564, committed) | 37.66 ms | 45.44 ms | 29.62 ms | 20.1 ms |

In run 7 the chain's mean CPU (29.6 ms, what the pass line counts) splits
as: the helper 3.3 ms, Git's launcher 6.7 ms, the console host 8.1 ms, Git's
bash 11.5 ms. Outside the chain, per event and net of idle: Defender's own
process 20.1 ms, the probe's thread starting the launcher 0.7 ms, the holder
0.1 ms, and the whole machine 55.9 ms (every process and the kernel, the
probe's own 3.1 ms of bookkeeping included). So the chain passes the CPU
line, and an event costs this machine about 53 to 56 ms of CPU in all, over
50 ms if all of it were counted; whether it should be is a question for the
owner, raised by the orchestrator. Run 6's "chain plus Defender, about 50
ms" left out the starting program, the holder, csrss and the kernel.
Reference: today's HTTP hook POST took 0.70 ms mean, 0.92 ms p95, and 1.0 ms
of CPU, client and server, against a baseline on the same 150-second
schedule (run 6's 1.1 ms was an upper estimate: its baseline lasted under a
second). A fresh copy of the helper in a new folder took 105 ms on its first
start, against about 35 ms warm. The figures crept up by about 2 ms of CPU
from run 1 to run 6, over an hour and a half on a host that was also running
other work; every run is far inside the line.

Runs 2 to 7 exist because review found gaps in the script's own checks, not
in what it measures: a store folder made by someone else, or an output folder
inside the store, could be removed at the end, or a refused output folder
written to; a run whose CPU sum missed a process could still pass; a slow
schedule could outlast the holder; a Defender exclusion did not fail the
verdict, the exclusion check missed folder, wildcard, full-path and
extension rules over the chain's programs and the probe's own program, and
an unreadable exclusion list could still give a PASS; a chain writing more
than one pipe holds would stall; and the verdict compared rounded values,
accepted any schedule and any validly signed helper, lost the step 2 result
when step 3 failed, and kept a clean-up failure off its last line. The WP1
legacy-Codex gate also refused one environment variable name in the new
file. Run 7 is the committed script. Only the output reading (read during
the run from run 4), the failure rules (a process without a cycle count
fails a run, from run 2), and from run 7 the readings outside the chain and
step 3's baseline changed; no run of any full run had a process without a
cycle count, and the pass line never changed.

**Decisions made while building the probe, before the measured run:**
- CPU is taken two ways: CPU cycles per process, converted at the machine's
  measured cycle rate, and the job's own user and kernel time. Windows charges
  the second in clock ticks of about 15.6 ms and under-counts short bursts on
  idle processors (3 to 7 ms mean against 28 to 30 ms from cycles). The pass
  line is judged on the larger of the two means. This rule was fixed after
  three 10-run harness checks, which found the tick figure reading near zero,
  and before the first 350-run measurement; the pass line itself never moved.
  The cycle rate is the fastest of five 100 ms loops (being descheduled can
  only lower a loop's rate); run 7's five rates were within 0.03 percent of
  each other.
- Harness checks and earlier runs used the same helper, so Defender had
  already scanned it: a first start of a new version's bytes after an update
  is not in these numbers. Run 7's fresh copy (the same bytes in a new
  folder) is the nearest reference. The max line exists for that case.
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
