# Packaged smoke: the signed 2.1.1 release build (WP1.63)

This file is the evidence for WP1.63: a clean install of the signed release build outside any checkout, the Codex CLI
found and classed, a session on a managed account's own `CODEX_HOME`, and a clean Quit. It covers Windows, macOS and
Linux.

**Status: partly recorded.** Recorded below: the Windows smoke, the Windows upgrade from 2.1.0, and the macOS signature
checks. In the upgrade, Vision did not start, and only the console check can say whether that happens outside the
agent's logon. The rest is in PENDING blocks: the Windows checks in an interactive logon, the macOS install and first
launch by the owner on the macOS test user, and the Linux run. WP1.63 stays `planned` until every part is recorded. No
part of it is expected to be unavailable: it would be only if a host part could not be taken, on an owner decision.

boundHead: d1525759a7a42d941beeff601af3415fddd8afdd (PR #644's squash merge on `beta`; `release/v2.1.1` points at it).

## The build under test

- Release run 38409628911 (`release.yml` on `release/v2.1.1`, channel beta, `skip_vt=false`) concluded success.
  It published the prerelease tag `v2.1.1-beta`, which points at boundHead.
- Windows installer `AI-Code-Conductor-2.1.1.exe`, 194103848 bytes.
  - SHA-256 `da72adf4e5d9f175c9a3e8c1b58f8e4234f9be5f9acc2eeef7a4b64a0e6f5952`.
  - That hash matches the release's `CHECKSUMS.txt` and GitHub's asset digest, both on the downloading host and on the
    test machine.
- Authenticode: Valid. The signer thumbprint is `00EC0DEE208F91785D253C0731E28249C68053FD`, the same certificate as
  2.1.0, with an SSL.com timestamp. File and product version are 2.1.1.

## Windows (agent, 2026-10-13)

**Where it ran.**
- The Windows test VM (Windows 11, x64), in a standard (non-administrator) local account.
- Before the install, that account had nothing of the app: 0 uninstall entries (per-user and per-machine), no install,
  data or settings folder, no app registry key, and no `~/.claude`, `~/.claude.json` or `~/.codex`.

**CLIs on the account's PATH.** These were the only Claude Code and Codex the app could find:
- **Codex 0.155.1**, the pinned version: the `codex.exe` that the npm package `@openai/codex-win32-x64` ships, SHA-256
  `eba0f32c976667cb9298efafd98513e823eeda7b576a03ec658bb8be8d336316`.
- **A stand-in Claude Code**, `claude.cmd` running a Node script.
  - It answers `--version` with `2.1.296 (Claude Code)`.
  - It records every start (argv, folder, and the names of `CCC_*` variables), then waits.
  - It signs in to nothing.

**No real sign-in.** The one Codex account was signed in with a fake API key through the app's own "Use an API key"
step. Its model was the loopback fake model, named in that account folder's `config.toml` (a test-harness file, as
`tests/e2e/codex-real-launch.spec.ts` writes it).

**How it was driven.**
- The installer was started the double-click way, with no arguments.
- Its wizard was driven by pressing only the forward buttons (Next, Install, Finish). No choice was changed.
- The app was then started with a loopback DevTools port and driven over it.
- Each step was taken from a user's route: the setup and onboarding pages' own buttons, and Settings > Accounts >
  Add Codex account. Sessions were started from saved configs, and the app was closed with the title bar's close.

| Check | Result |
|---|---|
| Clean install, wizard | **PASS.** The pages ran in this order: Welcome, Data folder (the default under `%LOCALAPPDATA%`), Resources folder, "Only for me" (preselected; "Fresh install for current user only."), Install location (`%LOCALAPPDATA%\Programs\AI Code Conductor`), Install, Finish with "Run AI Code Conductor" checked. It took 52 s. |
| Per-user or per-machine | **Per-user.** There is one uninstall entry, in HKCU only, `0210f08e-15d0-5073-901d-684e27f31b7d`, with `UninstallString ... /currentuser`. Nothing is under Program Files or in HKLM. |
| Version | **PASS.** The exe ProductVersion is 2.1.1.0 and the uninstall entry's DisplayVersion is 2.1.1. The installed `AI Code Conductor.exe` and `Uninstall AI Code Conductor.exe` are both Authenticode Valid, with the same thumbprint. The footer reads `v2.1.1`, and the app log says `current: v2.1.1, channel: stable`, then "Up to date". `app.asar` SHA-256 is `8013c70e2f03884fed5c5e42994a218ae7a95ca1adab2226e4cf82f8f9ae5a35`. |
| First start | **PASS.** The first start was the installer's own restart. The Claude CLI setup page (with the stand-in) came first. Then the onboarding walked in its fresh-install form: Skip & Continue, Let's go, skip the showcase, Both on the assistants page, the command bar, Find Claude, Compatibility ("Continue anyway"), Accounts, Set up Codex ("Skip for now"), GitHub, Status line, Built-in tools, Transparency, "Skip to the app". The workbench was reached. The app log has no `[ERROR]` line. |
| Codex detected, with its version class | **PASS.** Set up Codex read "Codex 0.155.1 found ✓ Version supported". The app's own discovery gives `discoveryState: found, version: 0.155.1, compatibility: supported`. Settings > Accounts > Providers reads "Codex 0.155.1 - ready". |
| A managed account's session runs on its own `CODEX_HOME` | **PASS.** The steps: Add Codex account > Use an API key (fake key) > named "P5 fake-key realm". This made `<resources>\codex-realms\realm-6cf7afd6…`, with `auth.json` and `log\codex-login.log`, and the account read "API key, Default, Signed in". A Codex config on that account was then started. `codex.exe` 0.155.1 started at 07:55:44.29 (VM time). Codex's own state files (`state_5.sqlite`, `logs_2.sqlite`, `goals_1.sqlite`, `installation_id`, `version.json`) appeared in that account folder from 07:55:44.6. `~/.codex` stayed absent. The app's start and launch did not change the folder's `config.toml` (323 B, unchanged). |
| A Claude session starts (stand-in) | **PASS.** A Claude config started the stand-in in the project folder, with `--model opus --settings <app settings file> --mcp-config <app MCP file> --plugin-dir <resources>\canvas-plugin`, and `CCC_CLAUDE_BIN` and `CCC_CONFIG_DIR` set. |
| Settings opens | **PASS.** The Settings page opened as a tab; Accounts shows the Codex and Claude Code provider rows and "Add Codex account". |
| Quit leaves no process | **PASS for the app, Codex and the stand-in.** Close with the two sessions open showed "Close the app" ("You have 2 active sessions..."); "Close sessions" was chosen. 15 s later there were 0 `AI Code Conductor` processes, 0 `codex.exe` and 0 stand-in processes, and ports 19333 and 19334 were free. The app log has one `[WARN] [pty] input to session ... failed (EAGAIN); it takes no more input` at that close. |
| Quit leaves no Vision Chrome | **NOT MET in the agent's logon; the cause is proven to be that logon.** See the note below. 2.1.0 leaves its Vision Chrome after every quit (2.1.0 behaviour, recorded in the 2.1.0-to-beta.3 upgrade check), so this is not a regression against 2.1.0. |

**Note on the Vision Chrome at Quit.**
- **What happened.** At both quits in this account, the Vision browser 2.1.1 had started on port 9222 kept running.
  The log shows `[vision] Stopped VisionManager`, then a 5 s main-loop stall, and no `[vision] Ended the app-started
  browser` line.
- **Why.** 2.1.1 ends its own browser with `taskkill /PID <pid> /T /F` (`vision-browser-owner.ts`
  `taskkillOwnChild`). `taskkill` is WMI-based, and this account's agent logon is an SSH logon with a NETWORK token,
  which WMI denies. Run by hand in the same logon, on the same verified pid, `taskkill` answered `ERROR: Access
  denied` after 5124 ms, which matches the stall.
- **How the browser was ended.** It was ended by its verified pid (name, start time, the only listener on 9222) with
  `Stop-Process`.
- **The same build in other logons.**
  - In an administrator's logon, where WMI answers, a byte-identical copy of this install (equal exe and `app.asar`
    hashes) logged `[vision] Ended the app-started browser (pid …)` at each of four quits. No Chrome and no listener
    on 9222, 19333 or 19334 was left.
  - In an interactive standard-user console logon (the user's real case): PENDING, below.

### Upgrade from 2.1.0 (agent, 2026-10-13)

**Where and how it ran.** The same Windows test VM, the same standard account, the same job runner and wizard driver.
Before this part, the clean-install copy above was removed with its own uninstaller (`/currentuser /S`, Valid,
exit 0). The account was then restored to its state before the lane, with a matching state report.

**Setup.**
- Signed 2.1.0 was installed with `/S`. Its wizard's own data-folder values were written to the registry first,
  because a silent install skips those pages.
- Fixture data was seeded by file (fictional, never a real sign-in):
  - three configs: a local Claude config on the primary account, a local Claude config bound to a second profile,
    and an SSH config to a documentation address;
  - stand-in credentials for the primary Claude account and for Codex;
  - a saved Claude Code transcript;
  - settings as a 2.1.0 user has them (Codex off, no answer to the Codex question).
- The second Claude profile was created by 2.1.0 itself, through its own IPC. Its stand-in credentials were written by
  file after 2.1.0 quit.
  - So 2.1.0 never read that profile's identity. In 2.1.1 the account list shows no address for it and labels it
    "setup incomplete".
  - Its credential state still reads signed in, and its session card names its account.
  - This comes from the fixture, not from the app.
- 2.1.0 was run once and quit. Every data and credential file was then hashed.
- The qualification installer was started the double-click way, and its wizard was walked with the forward buttons
  only.

| Check | Result |
|---|---|
| Wizard over 2.1.0 | **PASS.** The pages: Welcome ("If an earlier version is installed, Setup updates it and keeps your data and resources folders"); Data folder and Resources folder, with the existing values preselected; "Only for me" preselected, with "There is already a per-user installation ... Will reinstall/upgrade"; the install location unchanged; Install; Finish with "Run AI Code Conductor" checked. 66 s. |
| One uninstall entry (HKCU and HKLM, both views) | **PASS.** 1, in HKCU (`0210f08e-15d0-5073-901d-684e27f31b7d`, DisplayVersion 2.1.1); none in HKLM. |
| Uninstaller | **PASS.** `Uninstall AI Code Conductor.exe` is version 2.1.1 and Authenticode Valid, with the same signer thumbprint. The app exe is 2.1.1.0 and Valid. Its `app.asar` has the same SHA-256 as the clean install's. |
| Data and credentials kept | **PASS.** All 17 user-data and credential files have equal SHA-256 before and after: the three stand-in credential files in the account's home, the transcript, `configs.json`, `profiles.json`, `window-state.json` and its backup, `command-bar-ui.json`, both profiles' credential and identity files, and the first-run Claude config backup. No file was removed. These changed, as the migration and use write them: `settings.json`, `app-meta.json`, `usage-tracking.json` and `github-config.json`; the help docs (`app-knowledge.md`, `ask-conductor-skill.md` and `ask-conductor-skill-portable.md`); the picker scripts ("Scripts rewritten", below); and the two app databases' journal files (`-shm` and `-wal`; `tokenomics.db` and `transcripts.db` themselves are equal). |
| Profiles start | **PASS.** Each local Claude config was started from the Saved tab. The account dialog preselected the primary account for the first config and the bound profile for the second, and each was started with Launch. Each session card names its own profile's account. The stand-in Claude Code recorded both starts in the project folder. Both profiles read signed in: each has its address, expiry and refresh token, and no "credentials missing". |
| The one-time Codex question | **PASS.** "Do you use Codex?" was shown once, after What's New and the GitHub notice. Its text: "Codex now has accounts of its own in this app. Choose again: your earlier Codex setting does not carry over." It was answered with "No, I don't use Codex". It was not asked again at a later start, nor after the install chain (`rollback.md`). |
| What's New heading | **Shown. The exact words:** the heading is **"What's new since 2.1.0"**. Under it: "13 things worth knowing, in one line each, and 5 of them have a page of their own, just behind this one." The first section is "CODEX, A FULL ASSISTANT". It was dismissed with "Skip the showcase". The heading names the release the user came from. The release plan's upgrade check reads "the heading names the running release". Which wording is the check's criterion is a ruling owed at go (`release-qualification.md` section 3.10). Changing the wording needs a new binding head. |
| Scripts rewritten | **PASS.** At the first start of the qualification build, the shipped scripts were rewritten to its bytes: `resume-picker.js` (32841 to 71063 B), `codex-resume-picker.js` (6673 to 9173 B) and `lib/codex-resume-picker-lib.js` (8335 to 38551 B). `ccc-codex-hook.js` (7525 B) and `ccc-codex-hook.cmd` (400 B) were added. `claude-multi-statusline.js` (8003 B) is byte-equal, so it was not rewritten, by design. |
| Vision | **NOT STARTED in this logon. Open: the console check below decides the user's case, and it has not run.** 2.1.0's Vision Chrome (started at its run, on port 9222) survived its quit, as 2.1.0 always does. At each start of the qualification build, the log has `The check of the browsers on port 9222 did not answer; nothing is ended`, then `[ERROR] [vision] Vision was not started at boot: the vision browser's debug port 9222 is in use`. The check is a CIM process query, and this SSH logon's NETWORK token is denied it. Whether the app ends or adopts the old browser in an interactive standard-user logon is the console check's question; it needs the owner at the VM console. Until it runs, this is neither shown to be a regression against 2.1.0 nor shown not to be one. The old Chrome was then ended by its verified pid (name, start time within 5 ms, the only listener on 9222), and all 9 of its processes ended. |
| Quit | **PASS for the app.** "Close sessions" left no app process. |

### Windows: still owed

> **PENDING: the console check in an interactive standard-user logon.** The owner signs in to the standard test account
> at the VM's console and runs a staged script. It starts a browser the way 2.1.0's Vision did, runs the app's own
> browser query (`WINDOWS_BROWSERS_SCRIPT` at the head; `src/main/vision-browser-owner.ts` is unchanged from
> 2.1.1-beta.3), and records the logon's token, the query's exit code and whether the browser is listed, and the exit
> code of the same `taskkill` call the app makes at Quit. It passes on an interactive token, a query that exits 0 and
> the browser listed. It also decides the Vision row of the upgrade from 2.1.0 above. Not run yet.

> **PENDING: the window buttons.** On the setup page and on the Allow Multi Spawn page of the packaged build, each of
> minimise, maximise and restore, and close, clicked by the owner. Not run yet.

## macOS

### Signature, notarization and Gatekeeper (agent, 2026-10-13)

**The build and where it ran.**
- `AICodeConductor-2.1.1-macos13.dmg`, SHA-256 `262cc39c0aca5dff04d41539b004b8aa3222df6e5626f291d0090d18fa4a6c0a`.
  That equals its line in the release's `CHECKSUMS.txt`, and `CHECKSUMS.txt` (SHA-256
  `9c15213fc5e8043e9ec64ddf8f2d226bc2d31652929517ae106956f45a7c427c`) is identical on the downloading host and on the
  Mac.
- The checks ran on the macOS test Mac (macOS 27.0.1, arm64, which meets 13 or later).
- The DMG was mounted read-only, and the 2.1.0 DMG was checked the same way as the baseline.
- No app was launched and nothing was installed.

| Check | 2.1.1 | 2.1.0 (baseline) |
|---|---|---|
| `spctl -a -t exec -vv` on the app | accepted, `source=Notarized Developer ID` | the same |
| `xcrun stapler validate` on the app | the ticket is stapled and validates | the same |
| `codesign --verify --deep --strict -vv` on the app | valid on disk; satisfies its Designated Requirement | the same |
| Signing team | the same team as 2.1.0 | - |
| Hardened runtime (`flags=0x10000(runtime)`), arm64, the same 6 entitlements | yes | yes |
| `xcrun stapler validate` on the DMG | "does not have a ticket stapled" (exit 65) | the same |
| DMG signed | no (`build.dmg.sign: false`, at boundHead and at 2.1.0) | no |
| `hdiutil verify` on the DMG | passes | passes |
| CFBundleShortVersionString / CFBundleVersion | 2.1.1 / 2.1.1 | 2.1.0 / 2.1.0 |
| LSMinimumSystemVersion | 13.0 | 12.0 |
| CFBundleIdentifier | `com.claudeconductor.app` | the same |

The DMG being unsigned and unstapled is a configuration choice that is unchanged since 2.1.0. It is not a
regression. The app inside it is signed, notarized and stapled.

### First launch, Codex, upgrade and rollback (the owner)

> **PENDING: the owner's run on the macOS test user (a standard account; its earlier app data is moved aside first, nothing deleted).** The DMG
> above, with the quarantine flag a browser download carries, so Gatekeeper's first-launch check is met: the app
> dragged into the home folder's Applications folder and opened (Open if asked, no override); "Use Codex only" at setup
> with Codex 0.155.1 on the user's PATH; the owner's ChatGPT sign-in; a Codex session and one prompt; sign out. Then
> 2.1.0 set up with Claude Code only, 2.1.1 over it (What's New, setup kept), and 2.1.0 over that again (setup still
> there), with hashes of the app's data folder after each step. Not run yet.

## Linux

### Staging (agent, 2026-10-13)

- The Linux test host: Rocky Linux 10.2, x86_64. A fresh standard test user was made for the run, with no app data.
- `AI-Code-Conductor-2.1.1-linux-x86_64.AppImage`, SHA-256
  `7be0348a24a11fe58d90a75aa4594b9a31d6a24839f3e8714d68d5b64b5f952b`. That equals its line in the release's
  `CHECKSUMS.txt` and GitHub's asset digest, and `CHECKSUMS.txt` is identical on the downloading host and on the
  test host. The 2.1.0 AppImage was staged the same way, from its own release.
- Codex 0.155.1 from the npm platform package (no installer; its sha512 and sha1 equal the registry's), and the
  stand-in Claude Code (`2.1.296 (Claude Code)`), first on the test user's PATH. A throwaway `CODEX_HOME` was signed
  in with a fake API key (file store).
- **Known issue (not a regression): FUSE 2 is missing.** The test host has `fuse-libs` (`libfuse.so.2`) and
  `fuse3` (`fusermount3`) installed, but not the FUSE 2 `fuse` package, so there is no `fusermount`. Both AppImages,
  2.1.1 and 2.1.0, fail to mount the same way ("fuse: failed to exec fusermount: No such file or directory", then "Cannot
  mount AppImage, please check your FUSE setup"). Both use the same AppImage runtime, linked against
  `libfuse.so.2`. The run below therefore starts both versions with `--appimage-extract-and-run`, and records that it
  did. `README.md` (Requirements) and `release-qualification.md` section 3 carry the known issue.

> **PENDING: the run in the test user's graphical session.** After the owner logs the test user in once at the
> console: a clean run of 2.1.1 (the window opens, typing works, Settings opens, Codex is detected and classed, a
> session on a managed account runs on its own `CODEX_HOME`, Quit is clean); then the data moved aside, 2.1.0 run with
> seeded fixtures, 2.1.1 on the same data (hashes, What's New, a profile starts) and 2.1.0 again (rollback). Then the
> test user is removed. Not run yet.
