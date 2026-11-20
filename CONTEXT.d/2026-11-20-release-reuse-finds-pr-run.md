## 2026-11-20 -- A beta release finds its release PR's green CI run directly

Plan 2.1.3-beta.10, the cut's SDLC fix (`aicc_planning#361`).

- **The miss.** In the 2.1.3-beta.9 release (run 44624973440, 22:04Z on 19 Nov), the reuse step
  printed "No reuse: no green ci.yml run for a commit with tree
  213b24cdb8e871e32e60a9a5c61cd1233c716249". The release PR (#728) had a green pull_request run on
  its head ca0dfe1b, whose tree is exactly 213b24cd: run 44469921465. Some 26 other commits had
  green runs that day, so it sat outside the 30-commit window, and the Windows suite ran in full
  again.
- **The fix.** scripts/ci/reuse-green-ci.mjs now looks the run up directly before the window. The
  release commit on beta is the squash merge of its PR, so GitHub lists that PR for the commit with
  the commit as its merge commit (open PRs whose branch already holds the commit are listed too;
  their merge commit is another one). The green ci.yml runs on the PR's head are read with
  `head_sha=`. A run there counts only under the rules the window already applied, through the
  same functions, now factored out: commitTree (same tree), listGreenRuns (green, ci.yml, a PR or
  a push, not a fork) and proveCommitRuns (every PR of the commit into beta or main, each OS's Test
  job green with a green "Tested tree" step, the job-list bounds). The window is unchanged and runs
  when the direct path finds nothing; one log line says why. A failed read in the direct path
  never refuses the release: it sends the search on to the window. The log says which path found
  the run: "Reuse: run <id> (the release PR's own run, PR <n>) ...".
- **The release commit** is the checked-out commit (`git rev-parse HEAD^{commit}`), or `--sha`.
  The job already had pull-requests: read; release.yml is unchanged.
- **Checked live, read-only.** Run locally against GitHub for the beta.9 release commit f4915c0b,
  the direct path printed "Reuse: run 44469921465 (the release PR's own run, PR 728) passed the
  suite on Windows, macOS and Linux for tree 213b24cd...". With a commit that has no PR, the
  window ran and refused exactly as beta.9's release did.
- **Tests.** tests/unit/scripts/reuse-green-ci.test.ts has five new tests: the direct path reuses
  a run 40 commits back where the window finds nothing; a PR head with another tree, a run without
  the green "Tested tree" step (and each other shape the window refuses), and a commit with no PR
  or a PR into another branch each fall back to the window; a failed PR-list read (an error
  answer, a throw, not a list) leaves the window's answer as before. All five failed on the base
  script, and each of five mutants of the new code (no head tree check, no proof, no base check, no
  merge-commit check, no catch) failed at least one of them.
