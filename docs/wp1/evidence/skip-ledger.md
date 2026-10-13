# Skip and flaky ledger

This file is evidence for WP1.65 in `tests/wp1/traceability.json` ("No unexplained failing, skipped, quarantined or flaky test", kind document). It is a reviewed record derived from CI runs. For each skipped, todo or expected-fail test the runs reported, it gives the condition in the test source that causes it, and where the skipped case runs instead.

**Status: retaken at the binding's head, d1525759a7a42d941beeff601af3415fddd8afdd (the 2.1.1 squash merge on beta).** Every condition below is cited at that commit. The first record, from CI run 37134624406 at f4d98918d171ba380833f65defe8b7e678a047ea (2026-10-03), is replaced by this one.

## The runs

- **CI run 38400973974** (`pull_request`, attempt 1, 2026-10-13), the 2.1.1 pull request's final run, at the pull request head 0834df263e40a727e787fc58a799ea552df84196. It ran as GitHub's merge with beta, commit 72639eba01b52aebfde6a8fed05d67db0feadfb8. That merge commit, the pull request head and d1525759a7a42d941beeff601af3415fddd8afdd all have the same tree, 12310fe71f3706f624e3905f8b92f06f099cdc3f, so this run tested the head's files exactly. Jobs read:
  - `Test (windows-2025)` (job 115308203973), `Test (macos-latest)` (job 115308204149) and `Test (ubuntu-latest)` (job 115308204115). Each runs `npx vitest run`, then `npm run test:unit:native`.
  - The six codex-conformance legs (minimum and pinned on each OS), for the two files that run there.
- **Release run 38409628911** (`workflow_dispatch` of `release.yml` on `release/v2.1.1`, channel beta, attempt 1, 2026-10-13), the qualification build, at d1525759a7a42d941beeff601af3415fddd8afdd itself (its `headSha`). Jobs read: `build-windows` (job 115338403395) and `build-linux` (job 115338403757), whose "Run tests" step runs `npx vitest run` (`release.yml` has no native step, and `build-macos` runs no tests).
- **CI run 38409643796** (`workflow_dispatch` of `ci.yml` on `release/v2.1.1` with `codex_rc_version` 0.156.1, attempt 1, 2026-10-13), at d1525759a7a42d941beeff601af3415fddd8afdd: the nine codex-conformance legs (minimum, pinned and release candidate on each OS). A dispatch runs no test matrix.

`docs/wp1/evidence/ci-matrix.md` records the same runs.

### Totals, the logs against this ledger

| Run | OS | vitest files | vitest tests | native (`test:unit:native`) | Explained below |
|---|---|---|---|---|---|
| CI run 38400973974 | Windows | 1,462: 1,457 passed, 5 skipped | 23,013: 22,891 passed, 1 expected fail, 119 skipped, 2 todo | 15 files, 226 passed | 119 skipped, 2 todo, 1 expected fail, 0 native; the 5 skipped files are the 5 rows marked "all" for Windows |
| CI run 38400973974 | macOS | 1,462: 1,449 passed, 13 skipped | 22,970: 22,704 passed, 1 expected fail, 263 skipped, 2 todo | 15 files, 218 passed, 8 skipped | 263 skipped, 2 todo, 1 expected fail, 8 native; 13 skipped files |
| CI run 38400973974 | Linux | 1,462: 1,449 passed, 13 skipped | 22,962: 22,683 passed, 1 expected fail, 276 skipped, 2 todo | 15 files, 218 passed, 8 skipped | 276 skipped, 2 todo, 1 expected fail, 8 native; 13 skipped files |
| Release run 38409628911 | Windows | 1,462: 1,457 passed, 5 skipped | 23,013: 22,891 passed, 1 expected fail, 119 skipped, 2 todo | not run | The same as CI run 38400973974 on Windows, file by file |
| Release run 38409628911 | Linux | 1,462: 1,449 passed, 13 skipped | 22,962: 22,683 passed, 1 expected fail, 276 skipped, 2 todo | not run | The same as CI run 38400973974 on Linux, file by file |

Each codex-conformance leg, the six in CI run 38400973974 and the nine in CI run 38409643796, ran `codex-real-cli-conformance.test.ts` (8 passed, 1 skipped: the placeholder below) and `codex-cli-compat.test.ts` (5 passed, none skipped).

How the counts were read: vitest's default reporter prints, per file, how many cases skipped or are todo (`(N tests | M skipped)`), and marks a file whose cases all skipped with a down arrow. It does not name the skipped cases. Each file's per-OS count was matched to the conditions in its source; the per-file counts sum to the totals above on every OS. The release run's per-file lines were compared with the pull request run's, file by file (1,462 files on each of Windows and Linux): every file's test, skipped and todo count is the same. Where a file has more than one skip condition per OS, the split below is the one the counts allow, not one read from the log (see "Unexplained or to decide").

The test totals differ by OS because a few files register cases only for what the runner has, and these are not skips:
- `tests/unit/main/spawn-claude-no-node.test.ts` (31 cases on Windows, 51 on macOS, 43 on Linux): its real-POSIX-shell block (`describe.skipIf(SHELLS.length === 0)`, line 569) registers 4 cases per shell found among `/bin/sh`, `/bin/bash`, `/bin/zsh`, `/bin/dash` and `/bin/ksh`, and none on Windows (`SHELLS`, line 568). macOS has all five; the Ubuntu runner has sh, bash and dash. Nothing in it skipped on any OS.
- The three PowerShell files below register their cases once per shell, with PowerShell 7 only where `pwsh.exe` is installed (`SHELLS`; on the Windows runner it is): `spawn-claude-launcher-lookup-powershell.test.ts` 88 on Windows and 44 elsewhere, `spawn-claude-agents-powershell.test.ts` 17 and 9, `spawn-claude-picker-node-powershell.test.ts` 23 and 12.

Compared with 2.1.1-beta.3's pull request run (CI run 38348001824, at 0937dfb5578d388349df5c345498d6eb4ca9a6f7), every file's skipped count is the same on every OS: no skip was added or removed between beta.3 and the head.

## Ledger

One row per test file that skipped or holds a todo on any OS (66 files). A dash means nothing skipped on that OS. HQ marks a file whose header carries HOST QUARANTINE.

| File | Windows | macOS | Linux | Why it skips (from the source at the head) | Where the skipped cases run |
|---|---|---|---|---|---|
| `tests/integration/codex-cli-compat.test.ts` (HQ) | 6 (all) | 6 (all) | 6 (all) | Needs a `codex` on PATH (`haveCodex`, line 63). Without one, `maybeIt` is `it.skip` (line 64) for the 5 flag-drift cases, and a placeholder `it.skip` is registered (lines 112-113). The Test jobs install no Codex. | The codex-conformance job: 5 passed on each of the 15 legs at the head; the placeholder is not registered there |
| `tests/integration/codex-real-cli-conformance.test.ts` (HQ) | 9 (all) | 9 (all) | 9 (all) | Needs `CCC_CODEX_CONFORMANCE_BIN` (`LIVE`, line 54). `describe.skipIf(!LIVE)` (line 115) holds the 8 checks; `describe.skipIf(LIVE)` holds a placeholder `it.skip` (lines 257-258). Only the codex-conformance job sets the variable. | The codex-conformance job: 8 passed on each of the 15 legs; the placeholder is skipped there too (1 per leg), by design |
| `tests/integration/hooks/real-claude.test.ts` (HQ) | 1 (all) | 1 (all) | 1 (all) | Opt-in. Needs `RUN_REAL_CLAUDE_HOOKS_TEST=1`, a `claude` on PATH and that claude's `--settings` flag (lines 42-45). It spends API tokens, and the comment over it (lines 30-40) calls its assertion environmentally flaky. No CI job sets the variable. | No CI or VM run found. The comment calls it "useful before cutting a beta release" |
| `tests/unit/account-profiles-canonical.test.ts` (HQ) | 1 | - | - | POSIX mode bits: `posixIt` is `it.skip` on win32 (line 33). The case checks that the credential file is 0o600. | macOS and Linux Test jobs |
| `tests/unit/account-web-browser-fallback.test.ts` | - | 1 | 1 | Windows only: `it.runIf(process.platform === 'win32')` (line 142). With no plain system folder to name taskkill from, no taskkill starts. | Windows |
| `tests/unit/atomic-write-secure.test.ts` (HQ) | 2 | - | - | `it.runIf(process.platform !== 'win32')` (lines 146, 154). The cases check 0600 over a loose-moded file, and that O_EXCL rejects a planted symlink. | macOS, Linux |
| `tests/unit/claude-backup.test.ts` (HQ) | 1 | - | - | `it.runIf(process.platform !== 'win32')` (line 177). The case checks that the backed-up credential copy is 0600. | macOS, Linux |
| `tests/unit/config-secret-permissions.test.ts` (HQ) | 3 | - | - | `it.runIf(IS_POSIX)` (lines 89, 96, 124; `IS_POSIX` line 55). The cases check 0600 and 0700 modes. | macOS, Linux |
| `tests/unit/console-bleed-verification.test.ts` | 1 | 1 | 1 | `it.skip` (line 90) under `describe('MANUAL: ...')` (line 77): a placeholder. The real-exe check is run by hand with `scripts/verify-console-bleed.mjs`, from a real terminal. | No CI or VM run found; manual only |
| `tests/unit/github/codex-rollout-loader-swap.test.ts` (HQ) | - | 1 | 1 | Windows only: `it.runIf(process.platform === 'win32')` (line 103). The case reads an input spelled in another case. | Windows |
| `tests/unit/harden-dir-acl-windows.test.ts` (HQ) | 4 | 13 | 13 | `IS_WINDOWS` is at line 45. On macOS and Linux the three Windows blocks are skipped: `describe.runIf(IS_WINDOWS)` at line 441 (10 cases: two `it.each` pairs at lines 442 and 511, and 6 single cases), line 632 (2 cases) and line 737 (1 case). On Windows: the off-Windows block (`describe.runIf(!IS_WINDOWS)`, line 772, 1 case), and the three cases of the blocks at lines 632 and 737, which skip themselves when their folder variable is not set (`ctx.skip` at lines 635 and 659: `CCC_ACL_FOREIGN_OWNED_DIR`; line 740: `CCC_ACL_FOREIGN_OWNED_EXPLICIT_DIR`). Those folders are made by an elevated helper on a VM; no CI job sets them. | Each OS half runs on the other OS or OSes. The three VM cases: no CI run; they run on a VM with the helper-made folders (none at the head is recorded here) |
| `tests/unit/hooks/session-hooks-inherit-scope-links.test.ts` (HQ) | 3 | - | - | `it.runIf(POSIX)` (lines 87, 106, 131; `POSIX` line 24): settings files and `.claude` folders that are symbolic links. | macOS, Linux |
| `tests/unit/hooks/session-hooks-inherit-scope.test.ts` | - | 4 | 4 | `it.runIf(!POSIX)` (lines 131, 143, 179, 213; `POSIX` line 36): the Windows folder rules (the home in another case, a drive root, another drive, a linked worktree). | Windows |
| `tests/unit/logging/transcript-discovery.test.ts` (HQ) | - | 1 | 1 | Windows only: `it.skipIf(process.platform !== 'win32')` (line 530), a real junction. On Windows it would also skip on a temp volume that cannot hold a junction (line 548); it did not. | Windows |
| `tests/unit/main/account-profiles-owner-only-credentials.test.ts` (HQ) | - | 1 | - | `notMac` is `it.skip` on darwin (line 913), for one case (line 914): a review launch in a profile is refused with the sign-in folders' words. On macOS a profile's review launch takes the Mac route instead (`profileRealmLaunch`, `src/main/account-profiles.ts:3546-3558`, which checks the normal sign-in, not the folders). | Windows, Linux |
| `tests/unit/main/agents-env-launch.test.ts` | - | 1 | 1 | Windows only: `it.runIf(process.platform === 'win32')` (line 342). | Windows |
| `tests/unit/main/ask-launch-folder.test.ts` | - | - | 2 | `it.skipIf(!CASELESS)` (lines 245, 252). `CASELESS` (line 235) is true where the temp folder's volume ignores letter case: Windows, and macOS's default volume. Linux's is case-sensitive. | Windows, macOS |
| `tests/unit/main/canvas-plugin.test.ts` (HQ) | 1 | - | - | `it.runIf(IS_POSIX)` (line 354; `IS_POSIX` line 58). The case checks that a symlinked owned file is refused. | macOS, Linux |
| `tests/unit/main/claude-cli-version.test.ts` (HQ) | - | 6 | 6 | Windows only: `describe.runIf(process.platform === 'win32')` (line 331), 6 cases. They need a real Windows PATH entry, npm's shim and cmd.exe. | Windows |
| `tests/unit/main/clipboard-file-copy.test.ts` | - | 4 | 11 | `describe.runIf(win32 or darwin)` at line 81 (6 cases) and line 124 (1 case); `describe.runIf(win32)` at line 133 (4 cases: shares, pipes and the device namespaces). Copied files are read on Windows and macOS only; the case at line 167 checks that Linux reads none. macOS 4 = the Windows block; Linux 11 = all three blocks. | Windows (all 11), macOS (7). Linux has no such path, by design |
| `tests/unit/main/clipboard-file.test.ts` | 2 | 4 | 4 | `describe.runIf(onWindows)` (line 111, 4 cases) and `describe.runIf(!onWindows)` (line 134, 2 cases; `onWindows` line 10): the URI list decoded as the running OS decodes it. The rules for each OS also run on every OS (lines 87, 128). | Each block on its own OS |
| `tests/unit/main/codex-name-sidecar.test.ts` (HQ) | - | 1 | 1 | Windows only: `it.runIf(process.platform === 'win32')` (line 144). | Windows |
| `tests/unit/main/container-entry-shell-compat.test.ts` (HQ) | 5 | 3 | 4 | A missing shell skips its cases by name (`have`, line 29): the five host shells (lines 63-64; bash, sh, dash, zsh, fish at line 33), the 3 x 2 container pairs by outer shell (lines 77-80; outer sh, dash, busybox at line 34), and two `sh` cases (lines 91, 97). Two more cases depend on whether the runner's shell reads startup files first (`preSourcesStartup`, line 118): `sh -c` and `dash -c` skip where that shell reads `BASH_ENV`/`ENV` before its body (line 135), and the negative control skips where `bash -c` does not (line 148). The splits the counts allow: macOS 3 = fish (1) + busybox (2); Linux 4 = zsh and fish (2) + busybox (2); Windows 5 = zsh and fish (2) + busybox (2) + one startup-file case (line 135 or 148). | zsh runs on macOS. The fish and busybox cases: no CI or VM run found. The file names the live SSH matrix as their cover (line 16) |
| `tests/unit/main/first-start-boot-probe.test.ts` | - | 2 (all) | 2 (all) | Windows only: `describe.runIf(process.platform === 'win32')` (line 64), 2 cases: the boot version probe awaits the warm-up of claude.exe (ADR-025). | Windows |
| `tests/unit/main/first-start-setup-terminal.test.ts` | - | 6 (all) | 6 (all) | Windows only: `describe.runIf(process.platform === 'win32')` (line 61), 6 cases (ADR-025). | Windows |
| `tests/unit/main/first-start-wiring.test.ts` | - | 2 | 2 | Windows only: `describe.runIf(process.platform === 'win32')` (line 72), 2 cases: the Codex package's warm-up (ADR-025). | Windows |
| `tests/unit/main/harden-dir-acl-fallback.test.ts` | - | 16 | 16 | Windows only: `describe.runIf(process.platform === 'win32')` (line 185), 16 cases (two `it.each` pairs at lines 276 and 382, and 12 single cases): the icacls fallback against a simulated rights table. | Windows |
| `tests/unit/main/insights-codex-links.test.ts` (HQ) | 1 | - | - | The FIFO case skips on win32 (`ctx.skip`, line 146): Windows has no FIFOs. The two file-link cases skip only without the right to make a file link (lines 129, 169); they ran. | macOS, Linux |
| `tests/unit/main/installer-nsis-behaviour.test.ts` (HQ) | 13 | 13 | 13 | Needs makensis: `describe.skipIf(!MAKENSIS)` (line 402), 11 cases plus a loop of 2 (lines 579-583). `findMakensis` (line 76) returns null off Windows (line 77). On Windows it looks only at `MAKENSIS`, electron-builder's NSIS cache and an NSIS install (lines 78-89), and the windows-2025 runner had none of them when the tests ran: `ci.yml` packages only on `release/*` branches, after the tests, and `release.yml`'s build-windows also runs vitest before electron-builder. The two availability cases (lines 95, 108) ran and passed. | No CI or VM run found. It runs only on a Windows machine that has makensis, such as one where electron-builder has packaged the app |
| `tests/unit/main/owner-only-folders-default-rule.test.ts` | - | 6 (all) | 6 (all) | Windows only: `describe.runIf(process.platform === 'win32')` (line 168), 6 cases: the app's rule under Constrained Language Mode. | Windows |
| `tests/unit/main/owner-only-folders-real.test.ts` (HQ) | 3 | 35 (all) | 35 (all) | Every block is `describe.runIf(IS_WIN)` (lines 142, 235, 592, 705, 742, 751, 781; `IS_WIN` line 45). On Windows the three cases of "a folder made under a parent that gives this user Modify alone" (lines 706, 718, 730) skip themselves on an elevated process (`MODIFY_ONLY_SKIP`, line 668: an elevated process has full control under a second drive's root). The CI Windows runner is elevated. The cases that need elevation (`NEEDS_ELEVATION`, line 120) ran. | Windows Test job (32 passed). The three cases: no CI run; they run where the app does, not elevated (a VM run; none at the head is recorded here) |
| `tests/unit/main/owner-only-folders.test.ts` (HQ) | 1 | - | - | `describe.runIf(process.platform !== 'win32')` (line 316), one case: `secureFoldersPosix` 0700. | macOS, Linux |
| `tests/unit/main/per-session-mcp-secret-mode.test.ts` (HQ) | 2 | - | - | `it.runIf(IS_POSIX)` (lines 99, 106; `IS_POSIX` line 68). | macOS, Linux |
| `tests/unit/main/profile-id.test.ts` (HQ) | - | 1 | 1 | Windows only: `it.runIf(process.platform === 'win32')` (line 124), an 8.3 short name. | Windows |
| `tests/unit/main/pty-agents-env.test.ts` | - | 1 | 1 | Windows only: `it.runIf(WIN)` (line 212): templates too long for npm's launcher. | Windows |
| `tests/unit/main/pty-launch-session-id.test.ts` | - | 1 | 1 | Windows only: `it.runIf(WIN)` (line 143). | Windows |
| `tests/unit/main/review-files-real.test.ts` (HQ) | 5 | 1 | - | `it.skipIf(IS_WIN)` on 4 cases (lines 114, 121, 136, 156: a named pipe, and three races on links and second names, POSIX). `it.runIf(process.platform === 'linux')` on 1 case (line 172: a folder made a link around the open). Windows 5 = 4 + 1; macOS 1 = the Linux-only case. The file-link and device cases skip only without the right to make the link (lines 87, 99); they ran. | macOS and Linux (the 4); Linux (the 1) |
| `tests/unit/main/script-deploy-links.test.ts` (HQ) | 6 | 1 | 1 | `describe.skipIf(process.platform === 'win32')` (line 169), 6 cases on real POSIX files (a write handle, a symlink, an unchanged copy, a FIFO, a device link, a loose mode). Off Windows the Windows directory-symlink case skips itself (line 151); on Windows it would also skip without the right to make one (line 158); it did not. | macOS, Linux (the 6); Windows (the 1) |
| `tests/unit/main/script-folders-real.test.ts` (HQ) | 1 | 3 | 3 | `describe.runIf(IS_WIN)` (line 66, 3 cases) and `describe.skipIf(IS_WIN)` (line 105, 1 case). | Each block on its own OS |
| `tests/unit/main/session-hooks-writer-secret-mode.test.ts` (HQ) | 1 | - | - | `it.runIf(IS_POSIX)` (line 79; `IS_POSIX` line 54). | macOS, Linux |
| `tests/unit/main/setup-terminal-quit-teardown.test.ts` | - | 1 | 1 | Windows only: `describe.runIf(process.platform === 'win32')` (line 260), 1 case: a quit while the first start is being prepared (ADR-025). | Windows |
| `tests/unit/main/spawn-claude-agents-powershell.test.ts` (HQ) | - | 9 (all) | 9 (all) | Windows only: `describe.runIf(onWindows)` (line 195; `onWindows` line 48 needs win32 and Windows PowerShell). 8 cases per shell (lines 198, 205, 215, in loops) and one control (line 231). | Windows (17 passed, two shells) |
| `tests/unit/main/spawn-claude-launcher-lookup-powershell.test.ts` (HQ) | 8 | 44 (all) | 44 (all) | Windows only: `describe.runIf(onWindows)` (lines 111, 149; `onWindows` line 47). Per shell: 4 routes x 5 profiles x 2 cases (lines 129, 138) and 2 x 2 cases (lines 180, 187), 44; two shells on Windows, 88. On Windows the control `it.runIf(discriminates)` (line 138) skips for the one profile that cannot tell the two lines apart (`PROFILES`, line 96: the quoted, padded relative folder): 4 routes x 2 shells = 8. | Windows (80 passed). The 8 controls have nothing to show, by design |
| `tests/unit/main/spawn-claude-picker-node-powershell.test.ts` (HQ) | - | 12 (all) | 12 (all) | Windows only: `describe.runIf(onWindows)` (lines 103, 127; `onWindows` line 45). | Windows (23 passed, two shells) |
| `tests/unit/main/spawn-claude-user-args-powershell.test.ts` (HQ) | - | 2 (all) | 2 (all) | Windows only: `describe.runIf(onWindows)` (line 98; `onWindows` line 23): Windows PowerShell 5.1. | Windows |
| `tests/unit/main/ssh-end-remote-shell-compat.test.ts` (HQ) | 18 (all) | 3 | 8 | POSIX only: three `describe.skipIf(!POSIX)` blocks (lines 145, 195, 211; `POSIX` line 50). The line runs on the SSH host, and the runner's Git Bash cannot stand in for it (line 34). Within the blocks, a missing shell skips its cases by name (`have`, line 86): each host shell (bash, sh, dash, zsh, fish; line 54) gates 3 cases (lines 149, 162, 201), each csh shell (tcsh, csh; line 55) gates 1 (line 179), and `sh` gates 1 more (line 212). The counts allow one split each: macOS 3 = one host shell missing (fish: macOS ships the other four); Linux 8 = two host shells missing, 6 cases (zsh and fish; Ubuntu has bash, sh and dash), plus tcsh and csh, 2 cases. | zsh, tcsh and csh run on macOS. The fish cases: no CI or VM run found |
| `tests/unit/native/tokenomics-reindex-accounts.native.test.ts` (HQ; native run) | - | 8 | 8 | Windows only: the "by its 8.3 short name" base (lines 209-221) is null off Windows (line 212), and `baseOr` skips (line 228). That base covers 4 cases x 2 folder orders = 8. | Windows native run (226 passed) |
| `tests/unit/providers/claude/statusline-deploy.test.ts` | 2 | - | - | `it.skipIf(process.platform === 'win32')` (lines 160, 234): POSIX modes of the deployed copy and its folder. | macOS, Linux |
| `tests/unit/providers/codex/conversation-carry.test.ts` (HQ) | - | 1 | 1 | Windows only: `ctx.skip()` off win32 (line 1005), an 8.3 short-named resources folder. On Windows it would also skip on a volume without short names (line 1012); the file-link case (line 233) skips without the right to make a file link (line 239). Neither happened. | Windows |
| `tests/unit/providers/codex/hook-wrapper-start-folder.test.ts` (HQ) | - | 2 (all) | 2 (all) | Windows only: `describe.runIf(IS_WIN)` (line 57), a loop of 2. The cases run the `.cmd` wrapper under cmd.exe. | Windows Test job (2 passed) |
| `tests/unit/providers/codex/hooks.test.ts` | 1 | - | - | `it.runIf(process.platform !== 'win32')` (line 563). The case checks that a launch applies 0700 to the prepared root again. | macOS, Linux |
| `tests/unit/providers/codex/resume-picker-deploy.test.ts` | 1 | - | - | `it.skipIf(process.platform === 'win32')` (line 124): every copy is this user's only (POSIX modes). | macOS, Linux |
| `tests/unit/providers/codex/resume-picker-lib-links.test.ts` (HQ) | - | 2 | 2 | Windows only: `describe.runIf(process.platform === 'win32')` (line 158), 2 cases: a junction that names its folder by volume. | Windows |
| `tests/unit/providers/codex/spawn-hooks.test.ts` | - | 6 | 6 | Windows only: `it.runIf(process.platform === 'win32')` (lines 211, 290, 357, 378, 394, 428): the npm `.cmd` shim route. Three of them also skip on a Windows host whose scripts folder has no plain-word path (lines 382, 400, 432); they did not. | Windows |
| `tests/unit/providers/codex/telemetry-exact-claim.test.ts` (HQ) | - | 1 | 1 | Windows only: `it.runIf(process.platform === 'win32')` (line 251). The junction and file-link case skips only on EPERM (lines 181, 195); it did not. | Windows |
| `tests/unit/pty-ask-git-ceiling.test.ts` | 1 | - | - | `it.skipIf(process.platform === 'win32')` (line 259): a git the user may not run (POSIX modes). | macOS, Linux |
| `tests/unit/renderer/commandbar-menus.test.tsx` | 2 todo | 2 todo | 2 todo | `it.todo` (lines 666, 812): two menu items that are not built (see below). | Not tests of anything that exists |
| `tests/unit/scripts/codex-hook-forwarder.test.ts` (HQ) | 1 | 1 | 1 | The proxy case (line 261) skips when a request on a shared agent given `proxyEnv` does not reach the stand-in proxy, that is, on a Node without environment proxies (line 289). The comment names Node 24 (lines 275-276). CI runs Node 20.20.2, so this case skips on every OS. The file-link case skips only without the right to make a file link (line 209); the Windows runner made file links in other files at the head (for example the file-link cases of `insights-codex-links.test.ts` ran), so Windows' one skip is the proxy case too. | No CI or VM run found for the proxy case |
| `tests/unit/scripts/codex-resume-picker-worktrees.test.ts` | 1 | - | - | `ctx.skip()` on win32 (line 228). The case checks that the pick file's mode is 0600. | macOS, Linux |
| `tests/unit/scripts/readme-stage.test.ts` (HQ) | - | 10 | 10 | Windows only: `it.runIf(process.platform === 'win32')` on a loop of 7 cases (line 324) and 3 single cases (lines 329, 335, 339): staging roots refused by their Windows spelling. On Windows the case at line 339 also skips where the volume makes no short names (line 346); it did not. | Windows |
| `tests/unit/scripts/resume-picker-gated-real-path.test.ts` | 1 | 2 | 1 | Two conditions. (a) `it.runIf(process.platform === 'win32')` (line 175): on this machine's own disk, Windows. (b) The case "on this machine's own disk, when its temp folder tells two such names apart" (line 140) skips itself where the temp volume holds one folder under both names (EEXIST, line 150): Windows' and macOS's default volumes. Windows 1 = (b); macOS 2 = (a) + (b); Linux 1 = (a). The simulated case-sensitive and case-insensitive disks run on every OS (lines 106-132, 162). | (a) Windows; (b) Linux |
| `tests/unit/sentinel-live.test.ts` | 2 (all) | 2 (all) | 2 (all) | Opt-in: `describe.skipIf(!process.env.CCC_LIVE_SENTINEL_TEST)` (line 30). The cases run the real `claude -p`. No CI job sets the variable. | No CI or VM run found |
| `tests/unit/test-isolation/home-guard.test.ts` | 4 | 14 | 15 | Four conditions. (a) Node features Node 20.20.2 lacks, skipped on every OS: `fs.mkdtempDisposableSync` (line 288), `fs.promises.mkdtempDisposable` (line 325) and `process.execve` (line 378). (b) `it.runIf(!WIN)` (line 209): the XDG folders, not Windows. (c) Windows only: `it.runIf(WIN)` on a UNC working folder (line 476), a home variable spelled in another case (line 493), a child env without TEMP (line 606); `it.runIf(WIN && ...)` on HOMEDRIVE and HOMEPATH (line 511) and on 8.3 short names (line 1203); and 6 of the path spellings (`it.runIf(applies)`, line 458; the list at lines 443-455: mixed separators, a trailing dot and space, the two device prefixes, a stream suffix, a UNC path). (d) The "another case" spelling applies where the volume folds case (`FOLDS`, line 55: Windows or macOS). Windows 4 = (a) 3 + (b) 1; macOS 14 = (a) 3 + (c) 11; Linux 15 = (a) 3 + (c) 11 + (d) 1. | (b) and (d) run on the other OSes; (c) on Windows. (a): no CI or VM run found; they run only on a Node that has those functions |
| `tests/wp1/authority-manifest.test.ts` (HQ) | 1 | 1 | 1 | `it.skipIf(binary === null)` (line 863). Regenerating the manifest needs the pinned claude binary (`pinnedBinary`, line 64): `CLAUDE_BINARY`, or the pinned version under `~/.local/share/claude/versions/`. The comment says "Never run by CI: CI has no Claude binary" (line 867). | No CI or VM run found; a maintainer's regeneration run |
| `tests/wp1/codex-realm-isolation.test.ts` (HQ) | 1 | 2 | 2 | Windows only: `it.runIf(IS_WIN)` (line 233), a junction to a volume-GUID path, and `describe.runIf(IS_WIN)` (line 263), one case (line 266): a resources folder that gives this user Modify alone. On Windows that case skips itself on an elevated process (line 268); the CI runner is elevated. | The junction case: Windows. The Modify-alone case: no CI run; it runs where the app does, not elevated (a VM run; none at the head is recorded here) |
| `tests/wp1/managed-launch.test.ts` (HQ) | 5 | 3 | 3 | `it.skipIf(process.platform === 'win32')` on 5 cases (lines 1965, 2038, 2406, 2708, 2817: git pointer short reads, a torn pointer, the walk to the git root, a checkout's local settings reached through a link, a FIFO). `it.runIf(process.platform === 'win32')` on 3 cases (lines 2053, 2419, 2437: a trailing dot or space, the loopback admin share, an extended-length path). The admin-share case also skips where the share is unreadable (line 2433); it ran on Windows. | Each set runs on the other OS or OSes |

### The expected fail

`tests/unit/test-isolation/home-guard.test.ts`, line 770: `it.fails('a refusal the code under test swallows still fails its test (shared afterEach)')`. It runs on every OS and must fail: it proves that a home-guard refusal the code under test catches still fails the test through the shared `afterEach`. Vitest counts it as "1 expected fail" on each OS; it did fail, as designed, on all five Test steps.

## Quarantine

Quarantine here means HOST QUARANTINE: a file whose header carries that marker is never run on the owner's workstation; it runs in CI and on the VM. The marker is not a skip condition. `vitest.config.ts` collects `tests/unit`, `tests/integration` and `tests/wp1` and excludes only `*.native.test.*`, which `vitest.native.config.ts` collects for the native run.

At the head, 166 test files carry the marker in their header (`tests/wp1/legacy-codex-ledger.json` also contains it, in its notes on these files; it is a data file, not a test). Every one of the 166 was collected and run in the Test job on all three OSes of CI run 38400973974, and in the release run's Windows and Linux test steps (the native one in the pull request run only):
- 41 of them skipped something on some OS. Each is a row of the ledger above, marked HQ, with its condition and where the skipped cases run.
- The other 125 skipped nothing on any OS. They are listed here with their counts in the pull request run's Test jobs; the release run's Windows and Linux counts are the same.

This record covers CI only; no VM run is recorded here.

| File | Test job, Windows / macOS / Linux |
|---|---|
| `tests/unit/account-home-mirror.test.ts` | 4 passed on each OS |
| `tests/unit/account-profiles-capture.test.ts` | 4 passed on each OS |
| `tests/unit/account-profiles-claudemd.test.ts` | 7 passed on each OS |
| `tests/unit/account-profiles-credential-sharing.test.ts` | 14 passed on each OS |
| `tests/unit/account-profiles-global-credential-sync.test.ts` | 8 passed on each OS |
| `tests/unit/account-profiles-headless-home.test.ts` | 6 passed on each OS |
| `tests/unit/account-profiles-heal-names.test.ts` | 4 passed on each OS |
| `tests/unit/account-profiles-migrate-canonical.test.ts` | 2 passed on each OS |
| `tests/unit/account-profiles-orphan-repair.test.ts` | 5 passed on each OS |
| `tests/unit/account-profiles-primary.test.ts` | 3 passed on each OS |
| `tests/unit/account-profiles-self-junction.test.ts` | 6 passed on each OS |
| `tests/unit/account-profiles.test.ts` | 13 passed on each OS |
| `tests/unit/claude-backup-copy-flags.test.ts` | 3 passed on each OS |
| `tests/unit/claude-headless-real-argv.test.ts` | 1 passed on each OS |
| `tests/unit/claude-identity-copy-links.test.ts` | 3 passed on each OS |
| `tests/unit/config-manager-atomic.test.ts` | 4 passed on each OS |
| `tests/unit/config-manager-unlistable-dir.test.ts` | 1 passed on each OS |
| `tests/unit/config-renderer-boundary.test.ts` | 6 passed on each OS |
| `tests/unit/config-save-ssh-credential-invalidation.test.ts` | 27 passed on each OS |
| `tests/unit/credential-dir-hardening.test.ts` | 7 passed on each OS |
| `tests/unit/credential-file-mode-hardening.test.ts` | 12 passed on each OS |
| `tests/unit/credential-writer-fail-closed.test.ts` | 4 passed on each OS |
| `tests/unit/first-run-accounts.test.ts` | 8 passed on each OS |
| `tests/unit/github/codex-rollout-loader.test.ts` | 7 passed on each OS |
| `tests/unit/hooks/boot-cleanup.test.ts` | 10 passed on each OS |
| `tests/unit/hooks/session-hooks-writer.test.ts` | 13 passed on each OS |
| `tests/unit/main/account-folders-links-real.test.ts` | 4 passed on each OS |
| `tests/unit/main/canvas-adoption.test.ts` | 27 passed on each OS |
| `tests/unit/main/canvas-artifact-lifecycle.test.ts` | 11 passed on each OS |
| `tests/unit/main/canvas-audit-stamps.test.ts` | 21 passed on each OS |
| `tests/unit/main/canvas-binding-survives-account-switch.test.ts` | 7 passed on each OS |
| `tests/unit/main/canvas-c1-state-machine.test.ts` | 17 passed on each OS |
| `tests/unit/main/canvas-chat-pick.test.ts` | 16 passed on each OS |
| `tests/unit/main/canvas-closeout-store.test.ts` | 65 passed on each OS |
| `tests/unit/main/canvas-completion.test.ts` | 34 passed on each OS |
| `tests/unit/main/canvas-content-egress.test.ts` | 224 passed on each OS |
| `tests/unit/main/canvas-delete-confinement.native.test.ts` | 5 passed on each OS |
| `tests/unit/main/canvas-distroot-confinement.test.ts` | 16 passed on each OS |
| `tests/unit/main/canvas-draft-ready.test.ts` | 12 passed on each OS |
| `tests/unit/main/canvas-evidence-ipc.test.ts` | 29 passed on each OS |
| `tests/unit/main/canvas-evidence-store.test.ts` | 36 passed on each OS |
| `tests/unit/main/canvas-library-banding.test.ts` | 5 passed on each OS |
| `tests/unit/main/canvas-library-open-own.test.ts` | 19 passed on each OS |
| `tests/unit/main/canvas-library-rows.test.ts` | 36 passed on each OS |
| `tests/unit/main/canvas-library.test.ts` | 16 passed on each OS |
| `tests/unit/main/canvas-note-images.test.ts` | 28 passed on each OS |
| `tests/unit/main/canvas-note-variants.test.ts` | 12 passed on each OS |
| `tests/unit/main/canvas-plan-mode.test.ts` | 17 passed on each OS |
| `tests/unit/main/canvas-plugin-link-safety.test.ts` | 2 passed on each OS |
| `tests/unit/main/canvas-record-provenance.test.ts` | 9 passed on each OS |
| `tests/unit/main/canvas-resume-debt-r10.test.ts` | 10 passed on each OS |
| `tests/unit/main/canvas-review-after-completion.test.ts` | 4 passed on each OS |
| `tests/unit/main/canvas-review-counts-readonly.test.ts` | 6 passed on each OS |
| `tests/unit/main/canvas-review-store.test.ts` | 33 passed on each OS |
| `tests/unit/main/canvas-root-provenance.test.ts` | 5 passed on each OS |
| `tests/unit/main/canvas-root-scoping.test.ts` | 15 passed on each OS |
| `tests/unit/main/canvas-served-file-guards.test.ts` | 13 passed on each OS |
| `tests/unit/main/canvas-session-link.test.ts` | 52 passed on each OS |
| `tests/unit/main/canvas-settled-machine.test.ts` | 47 passed on each OS |
| `tests/unit/main/canvas-show-intent.test.ts` | 14 passed on each OS |
| `tests/unit/main/canvas-store-fail-closed.test.ts` | 2 passed on each OS |
| `tests/unit/main/canvas-subject.test.ts` | 24 passed on each OS |
| `tests/unit/main/canvas-worktree-root.test.ts` | 14 passed on each OS |
| `tests/unit/main/ccc-ux-protocol.test.ts` | 35 passed on each OS |
| `tests/unit/main/claude-account-identity-only-restore-r4.test.ts` | 10 passed on each OS |
| `tests/unit/main/claude-account-rotation-r2.test.ts` | 4 passed on each OS |
| `tests/unit/main/claude-account-rotation-restore-e2e.test.ts` | 1 passed on each OS |
| `tests/unit/main/codex-realm-skills-links.test.ts` | 6 passed on each OS |
| `tests/unit/main/codex-realm-skills-race-links.test.ts` | 4 passed on each OS |
| `tests/unit/main/codex-user-skills-links.test.ts` | 7 passed on each OS |
| `tests/unit/main/codex-user-skills-race-links.test.ts` | 2 passed on each OS |
| `tests/unit/main/conductor-mcp-auth-redos.test.ts` | 31 passed on each OS |
| `tests/unit/main/conductor-mcp-auth.test.ts` | 15 passed on each OS |
| `tests/unit/main/conductor-mcp-session-binding.test.ts` | 12 passed on each OS |
| `tests/unit/main/config-manager-read-failures.test.ts` | 5 passed on each OS |
| `tests/unit/main/github-update-repo-rename.test.ts` | 9 passed on each OS |
| `tests/unit/main/github-update-staging-dir.test.ts` | 33 passed on each OS |
| `tests/unit/main/help-workspace-git-stop.test.ts` | 4 passed on each OS |
| `tests/unit/main/help-workspace-rebuild-links.test.ts` | 3 passed on each OS |
| `tests/unit/main/install-folder-path-links-real.test.ts` | 2 passed on each OS |
| `tests/unit/main/managed-launch-picker-siblings-links.test.ts` | 2 passed on each OS |
| `tests/unit/main/per-session-settings-canvas-allow.test.ts` | 6 passed on each OS |
| `tests/unit/main/per-session-settings-mcp-rewrite.test.ts` | 9 passed on each OS |
| `tests/unit/main/per-session-settings-statusline.test.ts` | 10 passed on each OS |
| `tests/unit/main/persist-latch.test.ts` | 37 passed on each OS |
| `tests/unit/main/pty-codex-logs.test.ts` | 58 passed on each OS |
| `tests/unit/main/pty-managed-deferral-carries-launch.test.ts` | 7 passed on each OS |
| `tests/unit/main/pty-mcp-provider-revive.test.ts` | 7 passed on each OS |
| `tests/unit/main/pty-spawn-waits-for-refresh.test.ts` | 18 passed on each OS |
| `tests/unit/main/safe-file-read.test.ts` | 13 passed on each OS |
| `tests/unit/main/secret-ref-shell-parse.test.ts` | 29 passed on each OS |
| `tests/unit/main/sentinel-analysis-folders-links.test.ts` | 3 passed on each OS |
| `tests/unit/main/ssh-liveness-r8.test.ts` | 16 passed on each OS |
| `tests/unit/memory-path-symlink.test.ts` | 4 passed on each OS |
| `tests/unit/pr600-r10-force-ui.test.tsx` | 1 passed on each OS |
| `tests/unit/pr600-r3-fresh-wait.test.ts` | 10 passed on each OS |
| `tests/unit/providers/codex/conversation-carry-folders.test.ts` | 3 passed on each OS |
| `tests/unit/providers/codex/hooks-links.test.ts` | 6 passed on each OS |
| `tests/unit/providers/codex/models-scratch-home.test.ts` | 4 passed on each OS |
| `tests/unit/providers/codex/rollout-lookup.test.ts` | 24 passed on each OS |
| `tests/unit/providers/codex/spawn-resume.test.ts` | 11 passed on each OS |
| `tests/unit/providers/codex/telemetry-bounded-reads.test.ts` | 9 passed on each OS |
| `tests/unit/providers/codex/telemetry-claim-anywhere.test.ts` | 45 passed on each OS |
| `tests/unit/providers/provider-entry-routing.test.ts` | 6 passed on each OS |
| `tests/unit/pty-buffered-write-ordering.test.ts` | 5 passed on each OS |
| `tests/unit/pty-session-home-spawn.test.ts` | 4 passed on each OS |
| `tests/unit/pty-shell-only-profile-hold.test.ts` | 5 passed on each OS |
| `tests/unit/pty-stale-exit-notification.test.ts` | 2 passed on each OS |
| `tests/unit/resources-dir-hardening.test.ts` | 3 passed on each OS |
| `tests/unit/scripts/codex-resume-picker-links.test.ts` | 5 passed on each OS |
| `tests/unit/scripts/codex-resume-picker-names.test.ts` | 5 passed on each OS |
| `tests/unit/scripts/readme-stage-links.test.ts` | 4 passed on each OS |
| `tests/unit/scripts/resume-picker-gated-links.test.ts` | 6 passed on each OS |
| `tests/unit/scripts/resume-picker.test.ts` | 62 passed on each OS |
| `tests/unit/session-guard-designated-worktree.test.ts` | 12 passed on each OS |
| `tests/unit/session-state-github.test.ts` | 3 passed on each OS |
| `tests/unit/session-state-read-failure.test.ts` | 9 passed on each OS |
| `tests/unit/ssh-spawn-records-mcp-credential.test.ts` | 2 passed on each OS |
| `tests/unit/statusline-local-bridge-delivery.test.ts` | 5 passed on each OS |
| `tests/unit/test-isolation/home-guard-links.test.ts` | 7 passed on each OS |
| `tests/unit/tokenomics/tokenomics-carried-history-once.test.ts` | 1 passed on each OS |
| `tests/wp1/claude-characterization.test.ts` | 19 passed on each OS |
| `tests/wp1/fake-cli.test.ts` | 26 passed on each OS |
| `tests/wp1/registry-fs-port.test.ts` | 13 passed on each OS |
| `tests/wp1/review-profile-home.test.ts` | 5 passed on each OS |

## Unexplained or to decide

- Nothing the counts leave unexplained. On every OS, every file's skip and todo count matches a condition at the head, and the per-OS totals match the logs.
- Cases that run in no CI job, with no VM run at the head recorded here:
  - `tests/unit/main/installer-nsis-behaviour.test.ts`, 13 cases. No runner has makensis when the tests run. They run only on a Windows machine that has it.
  - The four Windows cases that need a process that is not elevated: the three "Modify alone" cases of `tests/unit/main/owner-only-folders-real.test.ts` and the one of `tests/wp1/codex-realm-isolation.test.ts`. The CI Windows runner is elevated.
  - The three VM cases of `tests/unit/harden-dir-acl-windows.test.ts`, which need folders an elevated helper makes (`CCC_ACL_FOREIGN_OWNED_DIR`, `CCC_ACL_FOREIGN_OWNED_EXPLICIT_DIR`).
  - `tests/integration/hooks/real-claude.test.ts`, 1 case, and `tests/unit/sentinel-live.test.ts`, 2 cases: opt-in; they run the real `claude` and spend tokens.
  - `tests/unit/console-bleed-verification.test.ts`, 1 case: a manual placeholder for `scripts/verify-console-bleed.mjs`. No run of that script is recorded.
  - `tests/wp1/authority-manifest.test.ts`, 1 case: manifest regeneration against the pinned claude binary.
  - The Node-feature cases: `tests/unit/scripts/codex-hook-forwarder.test.ts`'s proxy case (environment proxies), and three cases of `tests/unit/test-isolation/home-guard.test.ts` (`fs.mkdtempDisposableSync`, `fs.promises.mkdtempDisposable`, `process.execve`). CI runs Node 20.20.2, which has none of them.
  - The fish cases of `tests/unit/main/ssh-end-remote-shell-compat.test.ts` (3) and `tests/unit/main/container-entry-shell-compat.test.ts` (1), and the busybox cases of the second file (2). As the counts read, no runner has fish or busybox. The second file names the live SSH matrix as their cover (line 16), and that matrix is a manual gate.
- Read from the counts, not the log:
  - the split of the two shell-compatibility files;
  - in `tests/unit/main/container-entry-shell-compat.test.ts` on Windows, which startup-file case skipped (line 135 or 148);
  - which of `tests/unit/scripts/codex-hook-forwarder.test.ts`'s two conditional cases skipped on Windows (the proxy case, by the reasoning in its row).

  The default reporter does not name skipped cases. To decide, as at the first record: should the candidate run publish a per-case report (a JSON or JUnit reporter, uploaded as the run's artifact), so this record is read rather than inferred?
- The 2 todo cases, `tests/unit/renderer/commandbar-menus.test.tsx`:
  - line 666: "Collapse band", which the band menu does not offer yet;
  - line 812: "Move left/right on a Core tool", which `CoreToolMenu` draws only when the bar passes `onMove`.

  Both are marked D9 optional and test nothing that exists. To decide: build them, or drop the todos.

## Flaky

No test failed in any of the runs recorded here, so they record no flaky test:
- the three Test jobs of CI run 38400973974 and the two test steps of release run 38409628911 show no failed test and no `(retry xN)` marker;
- every codex-conformance leg of CI runs 38400973974 and 38409643796 passed on its first attempt;
- earlier CI runs on the same pull request were cancelled when a newer run started, and none of them had a failed Test job or conformance leg.

Retry is not configured, so a flaky test cannot pass unseen:
- `vitest.config.ts` and `vitest.native.config.ts` set no `retry`;
- in `ci.yml` and `release.yml`, neither `npx vitest run` nor `npm run test:unit:native` (`scripts/run-native-tests.mjs`) passes `--retry`.

Two flaky tests are known from earlier runs and tracked in the private tracker. Both are unchanged at the head, and both passed on every OS in every run recorded here:

| Tracker | Test | What made it fail before | At the head | In these runs |
|---|---|---|---|---|
| Private tracker #187 | `tests/unit/main/account-log-folders.test.ts`, the name rule's growth check (line 227: four times the path must take under eight times as long, best of 3 runs at each size, with a 1 ms floor under the smaller time) | One macOS Test job on an earlier pull request measured 3.54 ms, then 30.09 ms: a ratio of 8.5 against 8. A re-run of that job passed. A ratio of small times is sensitive to a loaded runner | Unchanged since the test came in (the case at line 210, the check at line 227) | 37 passed on Windows, macOS and Linux (CI run 38400973974) and on Windows and Linux (release run 38409628911) |
| Private tracker #210 | Six Conductor MCP server files in `tests/unit/main/` start the real server on a random fixed port, `NNN00 + Math.floor(Math.random() * 1000)`, with no retry: `conductor-mcp-sse-timeout` (29000, line 52), `-provider-binding` (30000, line 61), `-review-switches` (31000, line 63), `-codex-browser` (32000, line 54), `-token-epoch` (33000, line 45), `-ended-session` (36000, line 37) | Linux's outgoing-port range starts at 32768, so the 33000 and 36000 ranges, and the top of the 32000 range, can land on a port an outgoing socket already holds. One Linux Test job on an earlier pull request failed `conductor-mcp-token-epoch.test.ts` with `EADDRINUSE`; a re-run passed. Windows and macOS start that range at 49152 | Unchanged | All six passed on every OS of CI run 38400973974 (1, 31, 6, 14, 7 and 4 cases) and on Windows and Linux in release run 38409628911 |

Neither is a skip, and neither is fixed: each can still fail a run without a code change, most likely on a loaded macOS runner (#187) or on Linux (#210). A red Test job that names one of them is to be read as that flake and re-run once; any other failure is not.
