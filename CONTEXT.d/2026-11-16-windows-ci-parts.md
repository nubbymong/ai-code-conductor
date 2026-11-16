## 2026-11-16 -- Windows CI in four parts (2.1.3-beta.6, section D)

**Why.** The Windows Test job set every PR's CI time: a median of 26.1 minutes
over the last five green runs on beta PRs (runs 43778146494, 43775300077,
43758077932, 43757508805, 43754810501), of which the unit suite was 24.2
minutes and everything else about two. The target (ADR-030, SDLC numbers) is
15 minutes or less.

**What the measurement found.** One file set the floor:
`tests/unit/main/spawn-claude-launcher-lookup-powershell.test.ts` took 12 to 17
minutes on its own (738 to 1,007 s in three logs), because each of the 40
Windows PowerShell 5.1 cases it runs takes 18 to 30 s on the runner (its
PowerShell 7 cases take under half a second). vitest splits a run into parts by file only, so no
number of parts could bring Windows under 15 minutes while that stayed one
file. The four PowerShell files together were about 1,560 s of the 2,514 s of
summed file time.

**What changed.**
- `ci.yml`: the `test` matrix is macOS and Linux only, unchanged otherwise.
  Windows runs `test-windows-part` (four parts, `vitest run --shard=i/4`, the
  count being the matrix size) and `test-windows-build` (typecheck, native
  tests, build, and the release/* installer once) side by side. The job named
  `Test (windows-2025)` needs them, starts with `always()`, and passes only when
  each ended `success` (`scripts/ci/all-parts-passed.mjs`): failed, cancelled,
  timed out or skipped is red. It ends with the `Tested tree` step, so the
  required check names and the beta release's green-CI reuse are unchanged.
  Each part's summary lists its 15 slowest files
  (`scripts/ci/slow-test-files.mjs`, from vitest's own JSON reporter).
- The launcher lookup file is split into a shared harness and four files, one
  route each (part 1 also holds the session folder checks). Same cases, same
  names; the harness picks a route's part by its index, so a new route cannot
  be left out. The four files are in the host-quarantine `headerRequired` list,
  since they start processes only through the harness.
- Four parts: the split by path hash put the heaviest part at about 1,090 s of
  summed file time, mostly PowerShell files that run side by side on the
  runner's workers. Three parts left one near 15 minutes; five or six barely
  moved the heaviest part and cost more Windows runners per run.

**Not changed.** release.yml (it reads `TEST_JOB_RE` names and the `Tested
tree` step, both kept), the Helper job, macOS and Linux. The beta release still
runs the Windows suite in one job when it cannot reuse CI.

**Open.** Each Windows PowerShell 5.1 start costs 18 to 30 s on the runner and
is most of the Windows suite's time. That looks like the per-process module
analysis a fresh profile folder forces; speeding it up is a test-harness change
for its own ticket, not this one.
