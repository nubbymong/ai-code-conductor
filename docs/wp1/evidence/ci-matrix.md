# CI matrix: per-OS evidence

This file is evidence for WP1.30 (`docs/wp1/evidence/ci-matrix.md`), and the CI half of rows 59 and 60 of the WP2 completion plan (P4.8: Linux in the test matrix, real-CLI conformance; OD20 D5 and D7, WP1.71).

WP1.30 says the Windows ACL and Unix mode tests must run on each OS runner, so its evidence is the CI matrix run, not a local run. The real-CLI conformance runs are also row 2's detection evidence per OS (P4.10).

**Status: retaken at the binding's head, d1525759a7a42d941beeff601af3415fddd8afdd (the 2.1.1 squash merge on beta; `release/v2.1.1` points at it).** Three runs are recorded under "Results at the binding's head": the 2.1.1 pull request's final CI run (CI run 38400973974, all three OSes, on a merge ref whose tree is the head's tree), the qualification release run (release run 38409628911, Windows and Linux, at the head itself), and the conformance dispatch with a release candidate (CI run 38409643796, at the head itself). The first green run of the whole workflow, CI run 37134624406, and the prove-red dispatch, CI run 37155296304, are kept below under "Earlier runs" as history; they are not the record.

## What runs

Workflow: `.github/workflows/ci.yml`. On a pull request both jobs need the `ci-run` label; every push to `main` runs them.

### The test matrix (`Test (<os>)`)

- Runners: `windows-2025`, `macos-latest`, `ubuntu-latest`.
- Steps per runner:
  - `npm ci --ignore-scripts`, then the Electron binary;
  - on macOS and Linux, node-pty and better-sqlite3 rebuilt from source (Windows uses the shipped N-API prebuilds);
  - `npm run typecheck`;
  - the WP1 ledger's bound commit fetched (`scripts/wp1/fetch-ledger-commit.mjs`);
  - `npx vitest run`, the whole suite, which includes WP1.30's tests: `tests/wp1/codex-realm-folders.test.ts`, `tests/wp1/codex-realm-isolation.test.ts`, and, since 2026-10-13, the owner-only folder rule's tests `tests/unit/providers/codex/realm-folders-owner-only-wiring.test.ts`, `tests/unit/main/owner-only-folders-real.test.ts` (the real Windows rights) and `tests/unit/main/owner-only-folders-native.test.ts` (the Constrained Language Mode route, on an in-memory fake); ADR-026, settled point 5. `tests/wp1/realm-paths.test.ts` is no longer a WP1.30 file: it has no ACL or mode case;
  - `npm run test:unit:native` (better-sqlite3 under Electron-as-Node);
  - `npm run build`.
- Linux was non-blocking (`continue-on-error` on the job) until its first green run, CI run 37134624406 (below). The commit that recorded that run removed the line, so a Linux failure now fails the run like any other. PR 4's package gate 7 needs Windows, macOS and Linux green at the final head.
- The suite last ran on Linux in `release.yml` (`build-linux`, release run 35534211954, beta of 2026-09-20: 898 test files passed, 3 skipped; 11,164 tests). The WP2 stack's tests had not run on Linux before P4.8.

### The real-CLI conformance job (`Codex CLI <version class> (<os>)`)

- Runners: `windows-2025`, `macos-latest`, `ubuntu-latest`.
- Versions:
  - every run checks the minimum and the pinned version, read from `src/main/providers/codex/cli-contract.ts` (`CODEX_MIN_SUPPORTED_VERSION` 0.153.4, `CODEX_PINNED_CLI_VERSION` 0.155.1);
  - the release-candidate version is checked only when the workflow is dispatched with `codex_rc_version` (release level, D7). PR runs have no such input.
- Each version is installed with `npm install --global --prefix <its own folder> --ignore-scripts` from the published `@openai/codex` package, into an npm cache of its own (not the one the job saves). The package and its platform packages declare no install scripts (0.153.4 and 0.155.1, read from the registry on 2026-10-03), so none is needed; a release whose CLI needed one would fail the job, not pass it. The checkout keeps no token on disk (`persist-credentials: false`), and the job holds no secrets.
- Every run of the CLI gets a fresh, empty `CODEX_HOME`, and there is no sign-in and no request that needs the network:
  - the suite makes one per run: its own runs, the app's version check (discovery's version home) and the model list (its scratch home);
  - the `codex --version` PATH check and the flag-drift suite each get one made just before them (`codex-conformance-ci.mjs homes`);
  - a step records the runner's own `~/.codex` (absent, or every folder and every other entry's path, size and modified time) before the CLI is installed, and the job's last step fails if it changed, so a run that used it cannot pass unseen. If the record step did not run, the last step fails saying the record is missing, not that the home was used. The picture and the comparison (`tests/integration/codex-own-home.mjs`) are proven to fail on each change on every run of the suite (`tests/integration/codex-own-home.test.ts`).
- Checks (`tests/integration/codex-real-cli-conformance.test.ts`, P3.1's no-sign-in checks):
  1. detection: the app's discovery proves the installed CLI through its real runner (on Windows the npm shim through cmd.exe), with its version and class; the app's own PATH resolution finds the same file;
  2. every flag of the command lines the app runs is defined (on an option line of its own, not only mentioned in prose) by the real help of the subcommand it names, each such help exits 0, and its `Usage:` line names that subcommand: a dropped subcommand that exits 0 with the top-level help (as 0.155.1's `mcp-server --help` does) fails, which matters for `logout` and `app-server`, whose command lines pass no flag;
  3. the model list (`codex debug models --bundled`) through the app's own reader is covered by `resources/model-registry.json`, and for the minimum and pinned versions it equals the recorded list. It is a case of its own, so a red detection never hides it, and coverage and the recorded list are two soft checks, both reported in one run;
  4. `codex features list` names every feature the analysis run turns off;
  5. help: P3.1's captures are made again, uploaded as the run's artifact, and compared with the normalised fixtures in `tests/fixtures/codex/cli/<version>/help/` as the run's OS reads them. The fixtures were captured on Windows; the differences reviewed for macOS and Linux (below) are accepted by name and nothing else (`REVIEWED_HELP_DIFFERENCES` in `tests/integration/codex-conformance-lib.ts`): each names its OS, versions, captures and the one fixture line it changes, and one whose line the fixture no longer holds exactly once fails. The run's own Codex home and temporary folder are compared as names (`<RUN_HOME>`, `<RUN_TMPDIR>`), since the Linux stderr line names them. It is asserted: `CCC_CODEX_HELP_ASSERT` is `1` in the workflow since the review below (P4.10); before that the comparison was reported only, as in the run recorded here.
- Then the flag-drift suite (`tests/integration/codex-cli-compat.test.ts`) runs against the same install. A step first proves `codex --version` on PATH prints the installed version, so that suite cannot pass by skipping.
- The pure comparisons are proven to fail on a deliberately wrong fixture on every run of the suite (`tests/integration/codex-conformance-lib.test.ts`).
- Each check of the suite is also shown red once in CI: a dispatch with `conformance_prove_red` (and no release candidate) runs it against a deliberately wrong expectation. Every leg must go red naming:
  - detection, both cases (a wrong version);
  - flags (a flag no help defines, and for each command line a subcommand its help does not name);
  - the model list, both soft checks (a registry without the first listed model; the recorded list with an extra id);
  - features (a feature no list names);
  - help (each fixture with its last line dropped), asserted in that run.
- Not shown red by that dispatch: the PATH check step, the flag-drift suite (`codex-cli-compat.test.ts`, which predates P4.8 and has no prove-red input), the runner's own home check (its comparison is shown red by `codex-own-home.test.ts` instead), and an rc leg's help (no fixture exists for a release candidate).

## Results at the binding's head

The binding's head is d1525759a7a42d941beeff601af3415fddd8afdd, tree 12310fe71f3706f624e3905f8b92f06f099cdc3f. Its only parent is 28ec75df2abdbd14afcf774c51c5ec7083928b21 (2.1.1-beta.3).

### The runs and the trees they tested

| Run | Event and ref | Commit run | Tree | Same tree as the head? |
|---|---|---|---|---|
| CI run 38400973974, attempt 1, 2026-10-13 (the 2.1.1 pull request's final run; conclusion success) | `pull_request`, the pull request's merge ref | 72639eba01b52aebfde6a8fed05d67db0feadfb8, GitHub's merge of the pull request head 0834df263e40a727e787fc58a799ea552df84196 into 28ec75df2abdbd14afcf774c51c5ec7083928b21 (each Test job's checkout fetched exactly this commit) | 12310fe71f3706f624e3905f8b92f06f099cdc3f | Yes. The pull request head 0834df263e40a727e787fc58a799ea552df84196 also has tree 12310fe71f3706f624e3905f8b92f06f099cdc3f, and the squash merge kept it |
| Release run 38409628911, attempt 1, 2026-10-13 (the qualification build, channel beta; conclusion success) | `workflow_dispatch` on `release/v2.1.1` | d1525759a7a42d941beeff601af3415fddd8afdd (the run's `headSha`; each job's checkout fetched exactly this commit). It tagged `v2.1.1-beta` on this commit, as a prerelease | 12310fe71f3706f624e3905f8b92f06f099cdc3f | It is the head |
| CI run 38409643796, attempt 1, 2026-10-13 (the conformance dispatch, `codex_rc_version` = 0.156.1; conclusion success) | `workflow_dispatch` on `release/v2.1.1` | d1525759a7a42d941beeff601af3415fddd8afdd | 12310fe71f3706f624e3905f8b92f06f099cdc3f | It is the head |

`release.yml` runs the suite on Windows and Linux only, so macOS has no test run at the exact commit; its evidence is the pull request run, whose tree is the head's tree. The release run's "Run tests" steps ran with `WP1_PHASE` empty (a beta-channel run), so the traceability gate ran at the manifest's own phase, `gate0`; the candidate-phase check is the stable run's, not this one's. A `workflow_dispatch` of `ci.yml` runs only the conformance and changelog jobs: in CI run 38409643796 the test matrix, the SSH multi-session smoke and the Desktop test gate were skipped by design, and Changelog in sync passed.

### Test matrix

Runners: `windows-2025` (image windows-2025-vs2026, version 20260925.250.1), `macos-latest` (image macos-26-arm64, version 20260907.0351.1), `ubuntu-latest` (image ubuntu-24.04, version 20261004.327.1). Node 20.20.2 on every job. The same images ran both runs.

| Run | Job | Windows | macOS | Linux |
|---|---|---|---|---|
| CI run 38400973974 | `Test (<os>)`: Windows job 115308203973, macOS job 115308204149, Linux job 115308204115 | Green. Typecheck; vitest 1,462 files (1,457 passed, 5 skipped), 23,013 tests (22,891 passed, 1 expected fail, 119 skipped, 2 todo); native 15 files, 226 tests passed; build | Green. Typecheck; vitest 1,462 files (1,449 passed, 13 skipped), 22,970 tests (22,704 passed, 1 expected fail, 263 skipped, 2 todo); native 15 files, 218 passed, 8 skipped; build | Green. Typecheck; vitest 1,462 files (1,449 passed, 13 skipped), 22,962 tests (22,683 passed, 1 expected fail, 276 skipped, 2 todo); native 15 files, 218 passed, 8 skipped; build |
| Release run 38409628911 | `build-windows` job 115338403395, `build-linux` job 115338403757 ("Run tests": `npx vitest run`; no native step in `release.yml`) | Green. vitest 1,462 files (1,457 passed, 5 skipped), 23,013 tests (22,891 passed, 1 expected fail, 119 skipped, 2 todo); then the signed build | Not run by `release.yml` (`build-macos` job 115338403613 builds, signs and notarizes only) | Green. vitest 1,462 files (1,449 passed, 13 skipped), 22,962 tests (22,683 passed, 1 expected fail, 276 skipped, 2 todo); then the build |

Every file's line in the release run's Windows and Linux logs (its test count, skipped count and todo count) is the same as in the pull request run's Windows and Linux logs: 1,462 files compared on each OS, no difference. No test failed in any of the five Test steps, and no `(retry xN)` marker appears in any log. Each skipped and todo case, and the expected fail, is explained in `docs/wp1/evidence/skip-ledger.md`, which records the same runs.

Every other job of CI run 38400973974 passed: the six conformance legs (below), the SSH multi-session smoke (job 115308203849), Changelog in sync (job 115308203952) and the Desktop test gate (job 115308204001). Earlier CI runs on the same pull request were cancelled when a newer run started; none of them had a failed Test job or conformance leg (their Desktop test gate failed, as it does until the owner applies the label).

### WP1.30's files on each OS

WP1.30's tests are `tests/wp1/codex-realm-folders.test.ts` and `tests/wp1/codex-realm-isolation.test.ts`, and the three owner-only folder rule files its reason names: `tests/unit/providers/codex/realm-folders-owner-only-wiring.test.ts` (the app's own composition), `tests/unit/main/owner-only-folders-real.test.ts` (the real rights on the Windows runner, Constrained Language Mode included) and `tests/unit/main/owner-only-folders-native.test.ts` (that mode's route against an in-memory fake).

| File | Windows: CI run 38400973974 / release run 38409628911 | macOS: CI run 38400973974 | Linux: CI run 38400973974 / release run 38409628911 |
|---|---|---|---|
| `tests/wp1/codex-realm-folders.test.ts` | 126 passed / 126 passed | 126 passed | 126 passed / 126 passed |
| `tests/wp1/codex-realm-isolation.test.ts` (HOST QUARANTINE) | 8 passed, 1 skipped / the same | 7 passed, 2 skipped | 7 passed, 2 skipped / the same |
| `tests/unit/providers/codex/realm-folders-owner-only-wiring.test.ts` | 3 passed / 3 passed | 3 passed | 3 passed / 3 passed |
| `tests/unit/main/owner-only-folders-real.test.ts` (HOST QUARANTINE) | 32 passed, 3 skipped / the same | 35 skipped (Windows only) | 35 skipped (Windows only) / the same |
| `tests/unit/main/owner-only-folders-native.test.ts` | 53 passed / 53 passed | 53 passed | 53 passed / 53 passed |

The skips, from the source at the head:
- `codex-realm-isolation.test.ts`: on Windows, the one case of "a resources folder that gives this user Modify alone (a second drive's root, O6)" (`describe.runIf(IS_WIN)`, line 263) skips itself on an elevated process (line 268: an elevated process has full control under a second drive's root). The CI Windows runner is elevated. On macOS and Linux that case and the Windows-only junction case (`it.runIf(IS_WIN)`, line 233) are skipped.
- `owner-only-folders-real.test.ts`: every block is `describe.runIf(IS_WIN)` (lines 142, 235, 592, 705, 742, 751, 781), so the whole file is skipped on macOS and Linux. On Windows the three cases of "a folder made under a parent that gives this user Modify alone" (lines 706, 718, 730) skip themselves on an elevated process (`MODIFY_ONLY_SKIP`, line 668). The cases that need elevation to give a folder to another account (`NEEDS_ELEVATION`, line 120) all ran.

So on every OS runner the POSIX mode cases and the Windows rights cases ran where they apply, with this limit: the four Windows cases that need a process that is not elevated (three in `owner-only-folders-real.test.ts`, one in `codex-realm-isolation.test.ts`) cannot run on the elevated CI runner, and no CI job runs them. Before 2.1.1-beta.2 the Windows half was deferred while the shared ACL primitive was investigated (private tracker #103); ADR-026, settled point 5.

`tests/wp1/realm-paths.test.ts` (13 passed on each OS and run) is no longer a WP1.30 file: it has no ACL or mode case. The two files WP1.30 lists as current tests, `tests/unit/harden-dir-acl-windows.test.ts` and `tests/unit/credential-file-mode-hardening.test.ts`, ran too: `harden-dir-acl-windows.test.ts` 38 cases on each OS (4 skipped on Windows, 13 on macOS, 13 on Linux) and `credential-file-mode-hardening.test.ts` 12 passed on each OS; the skips are in the skip ledger.

### Real-CLI conformance at the head

Versions: the minimum 0.153.4 and the pinned 0.155.1 (from `src/main/providers/codex/cli-contract.ts` at the head), and the release candidate 0.156.1, given to the dispatch as `codex_rc_version`. Each leg installed its version from the published `@openai/codex` package (`npm install --global --prefix <its own folder> --ignore-scripts`) and ran with `CCC_CODEX_HELP_ASSERT` = 1 and no prove-red input.

| Run | OS | Version class | Version | Job | Detection | Flags | Model list | Features | Help against the fixtures | Flag-drift suite | Own home untouched |
|---|---|---|---|---|---|---|---|---|---|---|---|
| CI run 38409643796 | Windows (win32-x64) | minimum | 0.153.4 | 115338273353 | Both cases found, version 0.153.4, supported; PATH resolution finds the install (`codex.cmd`) | Every flag defined, each in its subcommand's own help | 6 ids (gpt-6-astra, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.2), equal to the recorded list; covered by the registry | 135 listed; the 12 turned off all named | 15 of 15 the same (asserted) | 5 passed | Yes: absent before the install and after the last run |
| CI run 38409643796 | Windows (win32-x64) | pinned | 0.155.1 | 115338273682 | Both cases found, version 0.155.1, supported; `codex.cmd` | Every flag defined | 5 ids (no gpt-5.2), equal to the recorded list; covered | 141 listed; the 12 all named | 15 of 15 the same (asserted) | 5 passed | Yes |
| CI run 38409643796 | Windows (win32-x64) | rc | 0.156.1 | 115338273366 | Both cases found, version 0.156.1, supported; `codex.cmd` | Every flag defined | 7 ids (gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5); covered by the registry; no recorded list for 0.156.1 | 148 listed; the 12 all named | 15 captured; no fixture exists for 0.156.1, so none was compared (the suite's line reads "0 differ") | 5 passed | Yes |
| CI run 38409643796 | macOS (darwin-arm64) | minimum | 0.153.4 | 115338273648 | Both cases found, version 0.153.4, supported; PATH resolution finds the install (`codex.js`, the npm bin link) | Every flag defined | 6 ids, equal to the recorded list; covered | 135 listed; the 12 all named | 15 of 15 the same, with the reviewed macOS differences applied (asserted) | 5 passed | Yes |
| CI run 38409643796 | macOS (darwin-arm64) | pinned | 0.155.1 | 115338273913 | Both cases found, version 0.155.1, supported; `codex.js` | Every flag defined | 5 ids, equal to the recorded list; covered | 141 listed; the 12 all named | 15 of 15 the same, reviewed differences applied (asserted) | 5 passed | Yes |
| CI run 38409643796 | macOS (darwin-arm64) | rc | 0.156.1 | 115338273271 | Both cases found, version 0.156.1, supported; `codex.js` | Every flag defined | 7 ids; covered; no recorded list for 0.156.1 | 148 listed; the 12 all named | 15 captured; no fixture for 0.156.1, none compared | 5 passed | Yes |
| CI run 38409643796 | Linux (linux-x64) | minimum | 0.153.4 | 115338273156 | Both cases found, version 0.153.4, supported; `codex.js` | Every flag defined | 6 ids, equal to the recorded list; covered | 135 listed; the 12 all named | 15 of 15 the same, with the reviewed Linux differences applied (asserted) | 5 passed | Yes |
| CI run 38409643796 | Linux (linux-x64) | pinned | 0.155.1 | 115338273110 | Both cases found, version 0.155.1, supported; `codex.js` | Every flag defined | 5 ids, equal to the recorded list; covered | 141 listed; the 12 all named | 15 of 15 the same, reviewed differences applied (asserted) | 5 passed | Yes |
| CI run 38409643796 | Linux (linux-x64) | rc | 0.156.1 | 115338273142 | Both cases found, version 0.156.1, supported; `codex.js` | Every flag defined | 7 ids; covered; no recorded list for 0.156.1 | 148 listed; the 12 all named | 15 captured; no fixture for 0.156.1, none compared | 5 passed | Yes |
| CI run 38400973974 | Windows | minimum / pinned | 0.153.4 / 0.155.1 | 115308204067 / 115308204138 | The same as the dispatch's minimum and pinned legs on this OS | The same | The same | The same | 15 of 15 the same (asserted) | 5 passed | Yes |
| CI run 38400973974 | macOS | minimum / pinned | 0.153.4 / 0.155.1 | 115308204162 / 115308204098 | The same | The same | The same | The same | 15 of 15 the same, reviewed differences applied (asserted) | 5 passed | Yes |
| CI run 38400973974 | Linux | minimum / pinned | 0.153.4 / 0.155.1 | 115308204111 / 115308204085 | The same | The same | The same | The same | 15 of 15 the same, reviewed differences applied (asserted) | 5 passed | Yes |

Each leg ran its `codex --version` PATH check first (it printed exactly `codex-cli <version>`), then the suite (8 passed; the one skipped case is the placeholder for a run with no CLI given), then the flag-drift suite (5 passed, none skipped), then the check that the runner's own `~/.codex` is as it was before the CLI was installed (absent on every leg). On every leg each model the CLI lists is in the registry ("missing none"); the registry entries a version does not list (gpt-6-sol and gpt-6-luna on 0.153.4 and 0.155.1; gpt-5.2 on 0.155.1 and 0.156.1) are reported, as designed, and fail nothing. The help captures, the comparison and the run report are the dispatch's artifacts `codex-conformance-<os>-<version class>` (kept until 2026-11-12).

## Earlier runs

These runs predate the binding's head. They are kept as history and as the review of the help differences; they are not the record.

### Test matrix, CI run 37134624406 (2026-10-03)

| Run | Commit | Windows | macOS | Linux | WP1.30 files on each OS |
|---|---|---|---|---|---|
| CI run 37134624406 (`pull_request`, attempt 1, 2026-10-03) | f4d98918d171ba380833f65defe8b7e678a047ea, run as GitHub's merge with beta (6a07c3fb74a255266b04234482323760bb9a6da1) | Green. Typecheck; vitest 1,189 files (1,184 passed, 5 skipped), 17,391 tests (17,313 passed, 76 skipped, 2 todo); native 14 files, 225 tests passed; build | Green. Typecheck; vitest 1,189 files (1,183 passed, 6 skipped), 17,391 tests (17,315 passed, 74 skipped, 2 todo); native 14 files, 217 passed, 8 skipped; build | Green, the WP2 stack's first Linux run. Typecheck; vitest 1,189 files (1,182 passed, 7 skipped), 17,391 tests (17,307 passed, 82 skipped, 2 todo); native 14 files, 217 passed, 8 skipped (the first `test:unit:native` run on Linux); build | Each passed on all three: `realm-paths.test.ts` 13 tests (then cited for WP1.30; no longer, since it has no ACL or mode case), `codex-realm-folders.test.ts` 118, `codex-realm-isolation.test.ts` 8 (its one Windows-only case, a junction to a volume-GUID path, skipped on macOS and Linux). This run predates the owner-only folder rule's tests; the retake at the binding's head reports them |

How the run was read: `continue-on-error` on a job hides a red job behind a green run, so the Linux job was read step by step (`gh api .../actions/jobs/111236523243`): every step from the checkout to the build succeeded, and the vitest and native summaries above are from its log. The run's overall conclusion is `failure` only because of the Desktop test gate job, which waits for the owner's attestation (#309); every Test job, every conformance leg, Changelog in sync and the SSH multi-session smoke passed. The first run on the branch, at 956df1a3, was red on macOS and Linux in tests only (fixed in beee8507 and 7fd211ed).

### Real-CLI conformance, CI run 37134624406

| Run | Commit | OS | Version class | Version | Detection | Flags | Model list | Features | Help against the fixtures | Flag-drift suite | Own home untouched |
|---|---|---|---|---|---|---|---|---|---|---|---|
| CI run 37134624406 | f4d98918 | Windows (`windows-2025`, win32-x64; job 111236523268) | minimum | 0.153.4 | Both cases found, version 0.153.4, supported; PATH resolution finds the install (`codex.cmd`) | Every flag defined on an option line of its subcommand's own help; each help exits 0 and its Usage line names the subcommand | equal to the recorded list (6 ids, gpt-5.2 among them); covered by the registry | 135 listed; the 12 turned off all named | 15 of 15 the same (reported, not asserted, in this run) | 5 passed, none skipped | Yes: absent before the install and after the last run |
| CI run 37134624406 | f4d98918 | Windows (`windows-2025`, win32-x64; job 111236523322) | pinned | 0.155.1 | Both cases found, version 0.155.1, supported; PATH resolution finds the install (`codex.cmd`) | Every flag defined on an option line of its subcommand's own help; each help exits 0 and its Usage line names the subcommand | equal to the recorded list (5 ids, no gpt-5.2); covered by the registry | 141 listed; the 12 turned off all named | 15 of 15 the same (reported, not asserted, in this run) | 5 passed, none skipped | Yes: absent before the install and after the last run |
| CI run 37134624406 | f4d98918 | macOS (`macos-latest`, darwin-arm64; job 111236523255) | minimum | 0.153.4 | Both cases found, version 0.153.4, supported; PATH resolution finds the install (`codex.js` (the npm bin link)) | Every flag defined on an option line of its subcommand's own help; each help exits 0 and its Usage line names the subcommand | equal to the recorded list (6 ids); covered | 135 listed; the 12 turned off all named | 13 the same; 2 differ (`features-list`, `sandbox-help`), reviewed below (reported, not asserted, in this run) | 5 passed, none skipped | Yes: absent before the install and after the last run |
| CI run 37134624406 | f4d98918 | macOS (`macos-latest`, darwin-arm64; job 111236523295) | pinned | 0.155.1 | Both cases found, version 0.155.1, supported; PATH resolution finds the install (`codex.js` (the npm bin link)) | Every flag defined on an option line of its subcommand's own help; each help exits 0 and its Usage line names the subcommand | equal to the recorded list (5 ids); covered | 141 listed; the 12 turned off all named | 13 the same; 2 differ (`features-list`, `sandbox-help`), reviewed below (reported, not asserted, in this run) | 5 passed, none skipped | Yes: absent before the install and after the last run |
| CI run 37134624406 | f4d98918 | Linux (`ubuntu-latest`, linux-x64; job 111236523262) | minimum | 0.153.4 | Both cases found, version 0.153.4, supported; PATH resolution finds the install (`codex.js` (the npm bin link)) | Every flag defined on an option line of its subcommand's own help; each help exits 0 and its Usage line names the subcommand | equal to the recorded list (6 ids); covered | 135 listed; the 12 turned off all named | 15 differ, every one by the stderr line reviewed below; `help`, `features-list` and `sandbox-help` also in stdout (reported, not asserted, in this run) | 5 passed, none skipped | Yes: absent before the install and after the last run |
| CI run 37134624406 | f4d98918 | Linux (`ubuntu-latest`, linux-x64; job 111236523240) | pinned | 0.155.1 | Both cases found, version 0.155.1, supported; PATH resolution finds the install (`codex.js` (the npm bin link)) | Every flag defined on an option line of its subcommand's own help; each help exits 0 and its Usage line names the subcommand | equal to the recorded list (5 ids); covered | 141 listed; the 12 turned off all named | 15 differ, every one by the stderr line reviewed below; `help`, `mcp-server-help`, `features-list` and `sandbox-help` also in stdout (reported, not asserted, in this run) | 5 passed, none skipped | Yes: absent before the install and after the last run |

Each leg ran its `codex --version` PATH check first (it printed exactly `codex-cli <version>`), then the suite (8 passed; the one skipped case is the placeholder for a run with no CLI given). The runs are also row 2's detection evidence per OS (P4.10). The help captures, the comparison and the run report are the run's artifacts `codex-conformance-<os>-<version class>` (kept until 2026-11-02).

### Shown red once (dispatch with `conformance_prove_red`)

| Run | Commit | Result | Checks that failed, as they must |
|---|---|---|---|
| CI run 37155296304 (`workflow_dispatch` with `conformance_prove_red`, attempt 1, 2026-10-03) | 90fa404835c34693ecbd510a64cbfe3926227e15 | Red, as designed: all six legs failed (minimum: Windows job 111297349544, macOS 111297349528, Linux 111297349568; pinned: Windows 111297349517, macOS 111297349627, Linux 111297349576). The test matrix, the SSH smoke and the Desktop test gate were skipped; Changelog in sync passed | On every leg, 6 of the suite's 9 cases failed, 2 passed and 1 was skipped: detection, both cases (a wrong version); the model list, its case reporting both soft checks; the flags; the features; the help (each fixture with its last line dropped) |

### Help captures reviewed

For each OS, the help comparison is reviewed from the run's artifact (`codex-conformance-<os>-<version class>`: `help/*.txt`, `help-compare.md`, `report.md`) before it is asserted. The differences found, and whether each is an OS difference or a fixture to refresh, are recorded here.

At the binding's head, every minimum and pinned leg compared the same with exactly these reviewed differences applied, and the comparison was asserted (above). No new difference appeared, and no fixture was refreshed.

| OS | Run | Version | Captures that differ | Decision |
|---|---|---|---|---|
| Windows | CI run 37134624406 | 0.153.4, 0.155.1 | None | Nothing to decide: the fixtures were captured on Windows (the test VM, P3.1) and the CI captures match them byte for byte |
| macOS | CI run 37134624406 | 0.153.4, 0.155.1 | `features-list`: `secret_auth_storage` reads `false` (Windows: `true`). `sandbox-help`: the command argument runs "under seatbelt" (Windows: "under Windows restricted token sandbox"), and two options follow `--include-managed-config` that Windows does not have, `--allow-unix-socket <ALLOW_UNIX_SOCKETS>` and `--log-denials` (8 lines with their blank lines) | OS differences: a feature's default on this platform, and the platform's own sandbox. Neither touches a flag the app passes (the flags check passed). No fixture to refresh |
| Linux | CI run 37134624406 | 0.153.4, 0.155.1 | `help` (and on 0.155.1 `mcp-server-help`, which prints the top-level help): no `app` line ("Launch the Desktop app (opens the app installer if missing)"). `features-list`: `secret_auth_storage` reads `false`. `sandbox-help`: "under the Linux sandbox". Every capture's stderr: one line, `WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir "<RUN_TMPDIR>" (codex_home: AbsolutePathBuf("<RUN_HOME>"))`, with this run's temporary folder and Codex home in place of the two names | OS differences: Codex offers no Desktop app on Linux (the app runs `app-server`, never `app`), the feature default and the platform's sandbox. The stderr line is the run's set-up, not the help. Codex refuses, on every OS, to make its PATH helper binaries when its canonical home starts with the temporary folder as `std::env::temp_dir()` spells it (`codex-rs/arg0/src/lib.rs:345-350`, then the warning at :189, at rust-v0.155.1 and rust-v0.153.4), and the suite makes its fresh homes in the temporary folder. Only Linux prints it because only there do the two spellings agree: on macOS the canonical home is under `/private/var` while `TMPDIR` reads `/var`, and on Windows the canonical home carries the verbatim `\\?\` prefix. Exit codes and stdout are unaffected, and the app's discovery and model list, which also run in temporary homes, passed. If a macOS or Windows runner ever spells the two alike, its legs print the same line and fail closed. No fixture to refresh |

Every difference above was read in the captures themselves (`help/<name>.txt` against the fixture, line by line, not only the first difference `help-compare.md` names). None is a change in a command line the app runs, and none is a fixture to refresh. The comparison now accepts exactly these differences on their OS and nothing else; applied to this run's 90 captures (six legs, 15 each), every one compares the same, and with prove-red's fixture (its last stdout line dropped) every one is red. `codex-conformance-lib.test.ts` holds the same on captures made from the fixtures by hand, and shows any other difference, one on another OS, a reviewed one missing or a warning naming another home still fails.
