# Rollback: the installed app keeps Claude usable (WP1.31)

This file is the evidence WP1.31 ("Rollback to the pre-WP1 beta preserves existing Claude account usability") cites in
`tests/wp1/traceability.json`. Its automated half is `tests/wp1/rollback-reupgrade.test.ts`, which runs in CI at the
head below (`ci-matrix.md`). This file records the same thing on installed builds.

Every check here is taken at d1525759a7a42d941beeff601af3415fddd8afdd, the squash merge of PR #644 on beta and the commit
`release/v2.1.1` points at (tree `12310fe71f3706f624e3905f8b92f06f099cdc3f`), on its qualification build `v2.1.1-beta`
(release run 38409628911), installed from its signed installer, never through the in-app updater (the updater ranks
this build below 2.1.1-beta.3, so it never offers it to a beta-channel install).

**Status: recorded on Windows, except two profile starts.** The install chain below ran on the Windows test VM.
- The rollback to 2.1.0 (a release with no WP1 change) and the re-upgrade from it passed every check.
- At the 2.1.1-beta.2 and 2.1.1-beta.1 steps every other check passed, but the profile starts were not confirmed
  (note 1).
- WP1.31 stays `planned` until those two starts are confirmed.

The rollback rehearsal of a release on GitHub is a different check; it is a known limitation in
`release-qualification.md` section 3.

## The builds

All five installers were checked against their release's `CHECKSUMS.txt`. Each is Authenticode Valid, with signer
thumbprint `00EC0DEE208F91785D253C0731E28249C68053FD` and an SSL.com timestamp.

| Build | Installer | SHA-256 |
|---|---|---|
| 2.1.0 (stable) | `AI-Code-Conductor-2.1.0.exe` | `dccbd244c916eeb74d98ed722a6330418e1e27eac2e8feb3768b40db8c8f0041` |
| 2.1.1-beta.1 | `AI-Code-Conductor-2.1.1-beta.1.exe` | `379ac216baae55181388ef1ba9f08615ef73f033d32ea76d624db08aac36f47e` |
| 2.1.1-beta.2 | `AI-Code-Conductor-2.1.1-beta.2.exe` | `1b2b60be0d6bb4ea1a3b6a1d605c43d3bc3366a0e8a883aca9fe51d300a74a84` |
| 2.1.1, the qualification build (release `v2.1.1-beta`, run 38409628911) | `AI-Code-Conductor-2.1.1.exe` | `da72adf4e5d9f175c9a3e8c1b58f8e4234f9be5f9acc2eeef7a4b64a0e6f5952` |

## Windows (agent, 2026-10-13)

**Where it ran.** The Windows test VM (Windows 11, x64), in a standard (non-administrator) local account. The agent
worked over key SSH, through a job runner, so each installer and the app it starts share one logon session. That logon
has a NETWORK token (see "Vision" below).

**The starting point.** The chain started from the upgrade from 2.1.0 (`packaged-smoke.md`, "Upgrade from 2.1.0"):
- 2.1.0 was installed with `/S`. Its wizard's own data-folder values were written first, because a silent install
  skips those pages.
- Fixture data was seeded, and 2.1.0 was run once.
- The qualification installer was then run over it with its wizard.

The chain ran on that same data.

**Fixture data (fictional, never a real sign-in).**
- Three configs: a local Claude config on the primary account, a local Claude config bound to a second account
  profile, and an SSH config to a documentation address.
- Two Claude account profiles. The primary one is the computer's own Claude sign-in. The second was created by 2.1.0
  itself, through its own IPC. Both carry stand-in credential files, with fictional token strings and
  `example.invalid` addresses.
- A stand-in Codex `auth.json` in the account's home, and a saved Claude Code transcript.
- Settings as a 2.1.0 user has them: Codex off, and no answer to the 2.1.1 Codex question.

**CLIs on the PATH.**
- A stand-in Claude Code: `claude.cmd` running a Node script. It answers `--version` with 2.1.296, records each start,
  and signs in to nothing.
- Codex 0.155.1.

**How each step ran.**
1. The installer was started the double-click way, with no arguments. Its wizard was driven by pressing only the
   forward buttons (Next, Install, Finish); no choice was changed. Every wizard preselected the existing data and
   resources folders and "Only for me". Each said "There is already a per-user installation ... Will
   reinstall/upgrade".
2. The instance the installer started was closed with the window's close message.
3. The app was started with a loopback DevTools port. Its start pages were answered with their own skip buttons.
4. Both local Claude configs were started from the Saved tab. The account dialog was answered with the account it
   preselected.
5. The app was closed with the title bar's close and "Close sessions".
6. The registry, the uninstall entries, the installed files and every data and credential file were hashed (never
   read). The hashes were compared with those taken before the first upgrade.

### Results

| Step | Installed over | Launches, version shown | One uninstall entry (HKCU + HKLM) | Uninstaller | Both profiles read signed in | Both profiles start | User data and credentials |
|---|---|---|---|---|---|---|---|
| 0. The qualification build | 2.1.0 | yes, `v2.1.1` | 1, HKCU, DisplayVersion 2.1.1 | 2.1.1, Valid | yes | **yes** | 17 of 17 equal |
| 1. 2.1.1-beta.2 | the qualification build | yes, `v2.1.1-beta.2` | 1, HKCU, 2.1.1-beta.2 | 2.1.1-beta.2, Valid | yes | not confirmed (note 1) | 17 of 17 equal |
| 2. The qualification build | 2.1.1-beta.2 | yes, `v2.1.1` | 1, HKCU, 2.1.1 | 2.1.1, Valid | yes | **yes** | 17 of 17 equal |
| 3. 2.1.1-beta.1 | the qualification build | yes, `v2.1.1-beta.1` | 1, HKCU, 2.1.1-beta.1 | 2.1.1-beta.1, Valid | yes | not confirmed (note 1) | 17 of 17 equal |
| 4. 2.1.0 | 2.1.1-beta.1 | yes, `v2.1.0` | 1, HKCU, 2.1.0 | 2.1.0, Valid | yes | **yes** | 17 of 17 equal |
| 5. The qualification build | 2.1.0 | yes, `v2.1.1` | 1, HKCU, 2.1.1 | 2.1.1, Valid | yes | **yes** (second launch, note 2) | 17 of 17 equal |

- **"Read signed in"** means that each profile's credential state, as the app reads it, has its account address, an
  expiry and a refresh token, and no "credentials missing". The primary profile also has no identity mismatch.
- **"Start"** means that the session card names the profile's account, and that the stand-in Claude Code recorded one
  start for each config in the project folder.
- **"User data and credentials"** covers 17 files, each with an equal SHA-256 at every step. No file was removed at
  any step. The 17 are:
  - the 3 credential files in the account's home (Claude credentials, `.claude.json`, Codex `auth.json`);
  - the saved transcript;
  - `configs.json`, `profiles.json`, `window-state.json` and its dated backup, and `command-bar-ui.json`;
  - both profiles' credential and identity files (4 for the primary, 2 for the second);
  - the first-run Claude config backup (2 files).
- **The exe ProductVersion** is 2.1.1.0 for every 2.1.1 build (2.1.1-beta.1, 2.1.1-beta.2 and the qualification
  build) and 2.1.0.0 for 2.1.0. The uninstall entry's DisplayVersion and the footer tell the builds apart.

**What changes between builds, by design.** These files differed from the hashes taken before the first upgrade, as
each build's migration and use write them:
- `settings.json` and `usage-tracking.json`, at every step, 2.1.0's included.
- `app-meta.json`, at every step except 2.1.0's.
- `github-config.json`, at steps 0 to 3 and after step 5's second launch.
- The help docs (`app-knowledge.md`, `ask-conductor-skill.md` and `ask-conductor-skill-portable.md`), at every 2.1.1
  step (at the 2.1.1-beta.1 step, the first and the last of them).
- The two app databases' journal files (`-shm` and `-wal`), at every step. The databases themselves
  (`tokenomics.db` and `transcripts.db`) stayed equal.
- The shipped picker scripts are rewritten to each build's own bytes. For example, `resume-picker.js` is 32841 B under
  2.1.0 and 71063 B under the qualification build. `claude-multi-statusline.js` is byte-equal across all of them.
- The qualification build adds `ccc-codex-hook.js` and `.cmd`, `providers/registry.json`,
  `openai-model-pricing.json`, `conductor-secret.json`, the `canvas-plugin` skills and `help/AGENTS.md`. 2.1.0 leaves
  them in place and ignores them.
- When a profile first starts, 2.1.1 adds an `identity` copy of its sign-in files inside that profile's folder, as
  2.1.0 already does for the primary profile.

**What each start showed.**
- **Step 1 (2.1.1-beta.2):** its own "What's new in 2.1" showcase.
- **Step 2 (the qualification build):** no What's New. Its "What's new since 2.1.0" had been dismissed at step 0, and
  the 2.1.1-beta.2 showcase was not dismissed.
- **Step 3 (2.1.1-beta.1)** and **step 4 (2.1.0):** each showed its own showcase once. This is cosmetic.
- **Step 5 (the qualification build):**
  - "What's new since 2.1.0", with "12 things worth knowing". Step 0 had 13: the line shown only until the Codex
    question is answered dropped out.
  - The one-time Codex question was **not asked again**. The answer given at step 0 survived 2.1.1-beta.1 and 2.1.0
    writing the settings file.

**Note 1. 2.1.1-beta.2 and 2.1.1-beta.1: the profile starts were not observed.**
- The config cards appeared, but the stand-in recorded no Claude start within about 12 s.
- At both steps the page had not settled when the agent's start-page walk ran. At 2.1.1-beta.2 its What's New was
  still up, and the walk did not recognise it.
- These two steps were not run again: the lane's time ran out. They are past prereleases, not the build under test.
  Both builds read both profiles as signed in, and no data changed.

**Note 2. Step 5's first launch did not start the sessions, for the same reason.**
- The walk ran while the page still read "LOADING".
- The app was relaunched, and the walk waited for the page: What's New, then the GitHub notice, then the workbench.
  Both configs then started on their own accounts, and the stand-in recorded both starts.

**Vision.** Two builds logged `[ERROR] [vision] Vision was not started at boot: the vision browser's debug port 9222
is in use`: the qualification build, at every start of steps 0, 2 and 5, and 2.1.1-beta.2, at its later launch at step 1.
- **The builds that did not log it.** 2.1.1-beta.1 (step 3) and 2.1.0 (step 4) connected to the leftover browser on
  9222 and started Vision, at each of their starts. The instance that 2.1.1-beta.2's installer started at step 1 found
  9222 free, launched its own browser and started Vision.
- **The leftover browser.** A Chrome on 9222 that an earlier build had started was still running:
  - At step 0, 2.1.0's own Vision Chrome, which 2.1.0 leaves after every quit. It was ended before step 1.
  - From step 1 on, the one that 2.1.1-beta.2's installer-started instance launched. Its close could not end it in this
    logon: `taskkill` is denied to this non-administrator NETWORK-token logon (`release-qualification.md` section 3,
    known limitation 7).
- **Why the qualification build and 2.1.1-beta.2 did not start Vision.** Each first asks Windows (CIM) which process
  owns 9222. In this logon CIM answers "Access denied", so the app logs `The check of the browsers on port 9222 did not
  answer; nothing is ended` and does not start Vision. 2.1.1-beta.1 and 2.1.0 logged no such check.
- **The interactive standard-user case** is the console check in `packaged-smoke.md`. It has not run: it needs the
  owner at the VM console.
- Each leftover Chrome was ended by its verified pid (name, start time, and the only listener on 9222).

**State left.** After the chain, the app's own uninstaller ran (`/currentuser /S`, Valid, exit 0). The account was
then restored to its state before the lane, and the state report matched the pre-lane report line for line.

> **PENDING: the rollback legs on macOS and Linux (support, not WP1.31's record).** On the macOS test user and on the
> Linux test host: 2.1.0, then the qualification build over it, then 2.1.0 again, with the setup still there and the
> app's data folder hashed after each step (`packaged-smoke.md`). Not run yet.
