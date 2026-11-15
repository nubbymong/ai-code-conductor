## 2026-11-15 -- Account and session fixes for 2.1.3-beta.5 (planning #307: B2, B3, B4, B13, B14, B16)

One branch, six small fixes from the #307 lead list. None is in the SSH launch path, so no live SSH matrix is owed.

### A Mac session on a Claude account other than the primary one is refused (B3)

**Problem.** On macOS the Claude CLI finds its login through `$HOME`, and the app leaves `HOME` at the real home there (the profile homes mirror dot-entries only, never `~/Library`). A session started on a profile other than the primary one therefore ran as the Mac's own sign-in under the other account's name. Only the reviewer path refused it (`profileReviewRefusal`).

**Change.** `withProfileHome` (`src/main/account-profiles.ts`) refuses the launch first thing, before anything is composed, when the platform is macOS and the profile its home belongs to is not the primary one. The rule is shared with the reviewer's through one private function (`macNotPrimary`) and the platform is an argument (`profileLaunchRefusal`, and a fourth argument of `withProfileHome`), so it tests on any OS. The refusal is thrown with the managed-launch marker, so the existing deferred-spawn failure line writes it into the tab: "On a Mac, a Claude session can only run on your normal Claude sign-in, so this account cannot start it. Switch the tab to your primary account and start it again."

When the app cannot tell which account is the primary one (profiles.json unreadable, or no primary recorded) the launch is refused with its own sentence rather than let through. A home that is not under the profiles root has no account to judge and is left alone.

### An account switched off never launches, wherever its id arrives (B4)

**Problem.** Only the account picker hid an inactive account. The main process resolved any id whose folder existed (`pty-manager.ts`, the local launch), so a restored tab or a saved session that named an account switched off since still started on it.

**Change.** `inactiveAccountRefusal` (`account-profiles.ts`) reads the saved list and answers a sentence when the account is there and switched off (the primary account is always active, as `isAccountActive` says). The local Claude launch asks it as soon as the id resolves, before the refresh wait and the project-settings check, and throws it: "The Claude account "<name>" is switched off, so this session did not start on it. Use Switch Account in the tab's right-click menu to move it to another account, or switch "<name>" back on in Settings, Accounts." A restored tab shows it through the same line as the missing-account sentence. A plain terminal tab names no session and is not refused. An account that is not in the list keeps the missing-account sentence. The check sits in the local region, outside the SSH branch.

### A Codex session in a symlinked folder gets its status line and usage (B2)

**Problem.** The claim of a new Codex rollout compared the folder the rollout records with the folder the session was started in as plain strings (`telemetry.ts`). A session started in a symlinked folder has the link's name, while the rollout can record the real folder, so no rollout was ever claimed and the Codex tab stayed empty.

**Change.** The exact spelling is still tried first. A second look compares the two by real path (`sameFolderByRealPath` in `rollout-lookup.ts`, case-folded on Windows as the existing directory compare is), at the claim and at the rival check, so two launches in one real folder still contest one rollout. A folder that cannot be resolved never matches. Whether Codex records the real or the link path is not known; the rule accepts either.

### Git and npm config kept elsewhere is seen in managed sessions (B14)

**Problem.** Every managed launch pinned `GIT_CONFIG_GLOBAL` to `~/.gitconfig`. Git ignores its XDG file (`$XDG_CONFIG_HOME/git/config`, `~/.config/git/config`) whenever that variable is set, so a config kept only there was invisible in a managed session.

**Change.** `sharedConfigPins` (`account-profiles.ts`) pins `GIT_CONFIG_GLOBAL` only when `~/.gitconfig` exists and no XDG git config does; with neither, only the XDG one, or both, the variable is left alone and git reads what a normal terminal reads. `npm_config_userconfig` is pinned only when `~/.npmrc` exists. A pure function over an existence check, tested with a temp home. Where both git files exist, git now reads both, as in a normal terminal, which differs from the old single-file rule.

### Elevated shells on macOS and Linux keep the protective variables (B13)

**Problem.** An elevated terminal tab starts through `sudo`, whose default `env_reset` drops `CLAUDE_CODE_DISABLE_MOUSE` and its siblings, so a hand-run `claude` inside it took the mouse again.

**Change.** The tab now runs `sudo env NAME=value ... <shell> -l` (`elevatedKeptVariables` in `providers/claude/spawn.ts`) for the four non-secret protective variables, only those that are set and only plain values. No secret value is on the command line, where `ps` shows it; a secret command in an elevated tab still expands empty, as before. When the user opted out of all four the command is the old `sudo <shell> -l`. Windows (gsudo) is unchanged.

### Known issue: no tmux copy for 32-bit ARM and FreeBSD hosts (B16)

`src/shared/app-knowledge.ts` has a known-issues entry: those hosts run an SSH Persistent session without tmux persistence unless tmux is installed from the host's packages, and the session resumes with `--continue`. No code change: there is no upstream binary to pin.

### Tests

New: `tests/unit/account-launch-refusals.test.ts` (B3 rule and its enforcement, B4 sentence, B14 matrix with a temp home), `tests/unit/main/pty-inactive-account-refused.test.ts` (the real `spawnPty` refuses an inactive account and starts nothing), `tests/unit/providers/codex/telemetry-symlinked-folder.test.ts` (claim by real path, real-path answers stood in so it runs anywhere), `tests/unit/providers/codex/telemetry-symlink-real.test.ts` (a real symlink, POSIX only, CI and VM), `tests/unit/providers/claude/elevated-shell-kept-variables.test.ts`, and a case in `tests/unit/shared/app-knowledge.test.ts`. Changed: the three sudo expectations in the Claude launch tests, and the three tests that expected the git and npm pin unconditionally (`pty-spawn-env`, `managed-launch`, `claude-characterization`).

### Not in this change

Resume of a Codex conversation started in a symlinked folder still compares by the exact spelling (`sameDirectory` in the resume lookup). Windows junction behaviour of the real-path compare is untested. A macOS session that is refused does not fall back to the primary account: it stops with the sentence, as every other refusal does.
