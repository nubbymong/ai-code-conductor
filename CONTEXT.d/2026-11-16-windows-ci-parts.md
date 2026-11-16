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
PowerShell 7 cases take under half a second). vitest splits a run into parts
by file only, so no number of parts could bring Windows under 15 minutes while
that stayed one file. The four PowerShell files together were about 1,560 s of
the 2,514 s of summed file time.

**What changed.**
- `ci.yml`: the `test` matrix is macOS and Linux only, unchanged otherwise.
  Windows runs `test-windows-part` (four parts, `vitest run --shard=i/4`, the
  count being the matrix size) and `test-windows-build` (typecheck, native
  tests, build, and the release/* installer once) side by side. The job named
  `Test (windows-2025)` needs them, starts with `always()`, and passes only
  when each ended `success` (`scripts/ci/all-parts-passed.mjs`): failed,
  cancelled, timed out or skipped is red. `always()` also starts it in a run
  cancelled as a whole, where it fails, so a Windows run that did not finish
  never reads as passed; the red check left on a commit that a newer push
  replaced is harmless (run 43784523959 shows it). It ends with the
  `Tested tree` step, so the required check names and the beta release's
  green-CI reuse are unchanged. It is a matrix of one named
  `Test (${{ matrix.os }})`: the first push gave it a plain name, and a label
  change then reported a skipped `Test (windows-2025)`, which GitHub counts
  as passed. A matrix job skipped as a whole reports its name unexpanded
  instead. The build job is a matrix of one for the same reason: not
  required, but its skipped copy showed over its earlier pass. Each part's
  summary lists its 15 slowest files (`scripts/ci/slow-test-files.mjs`, from
  vitest's own JSON reporter).
- Timeouts are new: 30 minutes on each part and on the build job, 10 on
  `Test (windows-2025)`. The old Windows job had none (GitHub's default is six
  hours); a part takes under 10 minutes (4.9 to 9.0 on the runs of the final
  design), so 30 is more than three times the slowest. A part that times out
  fails the check.
- On a release/* PR the installer is now packaged, checked and uploaded by
  `test-windows-build`, which runs beside the unit parts and does not wait for
  them. So an installer artifact can exist on a red run; before, the steps ran
  only after the unit tests had passed in the same job. `Test (windows-2025)`
  is what says whether the tree passed.
- The Windows jobs do not set up Python (nothing on Windows compiles native
  code: `npm ci --ignore-scripts`, no rebuild, electron-builder with
  `--config.npmRebuild=false`), and every checkout of the test jobs, macOS
  and Linux included, drops the token from disk (`persist-credentials:
  false`): the scope reads local git and the WP1 ledger fetch reads the
  public origin.
- The launcher lookup file is split into a shared harness and four files, one
  route each (part 1 also holds the session folder checks). Same cases, same
  names; the harness picks a route's part by its index
  (`tests/helpers/items-of-part.ts`). That keeps a new route in CI only while
  the four files call parts 1 to 4 of 4, once each, so
  `spawn-claude-launcher-lookup-parts.test.ts` checks that host-safe, reading
  the files as text. The four files are in the host-quarantine
  `headerRequired` list, since they start processes only through the harness.
- Four parts: the split by path hash put the heaviest part at about 1,090 s of
  summed file time, mostly PowerShell files that run side by side on the
  runner's workers. Three parts left one near 15 minutes; five or six barely
  moved the heaviest part and cost more Windows runners per run.
- The split is weighted. In the first two runs vitest's hash split gave one
  part five of the nine slow PowerShell files and another none: 12.0 minutes
  against 3.1 on the same run, and 7.2 on the run before with the same files.
  vitest.config.ts now names a sequencer for `--shard` runs:
  `scripts/ci/shard-by-weight.mjs` places the nine files, heaviest first, each
  on the part with the least weight so far, and splits every other file
  exactly as vitest does. A file renamed or added is a light file, still in
  exactly one part; a test proves the parts cover the suite once each for one
  to eight parts, and that the light split matches vitest's file for file.
  Only `--shard` runs use it, and only the Windows CI parts pass `--shard`:
  release.yml runs the suite whole.
- The weights. The first table was the mean of the two hash-split runs, and
  its sums per part (435 / 425 / 464 / 421 s) were a plan, not a measurement:
  run 43793925573 measured 438 / 561 / 547 / 537 s of slow-file time per part.
  The split launcher files took 27 to 50 percent longer than their weights
  (418 s measured against 279 for the first, 268 to 273 against 201 to 211
  for the others).
  The table now holds that run's own times (418, 360, 274, 273, 269, 268, 89,
  78 and 55 s), which plan 496 / 504 / 542 / 542 s. The next run (43798392240)
  measured 416 / 374 / 332 / 653 s: the same files vary by up to 40 percent
  from run to run (the agents file took 274 s, then 165), so the plan is only
  as good as the runner allows, and each part's summary shows the drift.
- Inside a split run the heavy files also start first. The first weighted run
  (43788398848) placed them as planned but still took 11.7 minutes in part 2:
  vitest with no cache starts the largest files first, the split launcher
  files are a few lines each, and the first of them started 316 s into the
  suite and ran 314 s more. A run that is not split keeps vitest's order.

**Not changed.** release.yml (it reads `TEST_JOB_RE` names and the `Tested
tree` step, both kept), the Helper job, and what macOS and Linux run. The beta
release still runs the Windows suite in one job when it cannot reuse CI.
ADR-028 now says the Windows suite took about half an hour in one job until
this change.

**Open.** Each Windows PowerShell 5.1 start costs 18 to 30 s on the runner and
is most of the Windows suite's time. That looks like the per-process module
analysis a fresh profile folder forces; speeding it up is a test-harness change
for its own ticket, not this one.
