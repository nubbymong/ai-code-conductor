# Packaged smoke: the signed 2.1.1 release build (WP1.63)

This file is the evidence for WP1.63: a clean install of the signed release build outside any checkout, the Codex CLI
found and classed, a session on a managed account's own `CODEX_HOME`, and a clean Quit. It covers Windows, macOS and
Linux.

**Status: recorded.** Recorded below: the Windows smoke, the Windows upgrade from 2.1.0, the Windows checks of the
owner's sitting (2026-10-14: the console check, which settles the upgrade's Vision row for an interactive logon, and
the window buttons), the macOS signature checks, and the Linux run (2026-10-14: a clean run of the AppImage, then the
upgrade from 2.1.0 and the rollback to it). The owner's run on the macOS test user (install, first launch, Codex,
upgrade and rollback) was not run, on the owner's ruling: that part of WP1.63 is unavailable, and WP1.63 reads
`unavailable` on `docs/wp1/owner-decisions-2026-10-13.md#UA8`.

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
| Quit leaves no Vision Chrome | **NOT MET in the agent's logon; the cause is proven to be that logon.** See the note below. 2.1.0 leaves its Vision Chrome after every quit (the Vision row of "Upgrade from 2.1.0" below), so this is not a regression against 2.1.0. |

**Note on the Vision Chrome at Quit.**
- **What happened.** At both quits in this account, the Vision browser 2.1.1 had started on port 9222 kept running.
  The log shows `[vision] Stopped VisionManager`, then a 5 s main-loop stall, and no `[vision] Ended the app-started
  browser` line.
- **Why.** 2.1.1 ends its own browser with `taskkill /PID <pid> /T /F` (`vision-browser-owner.ts`
  `taskkillOwnChild`). `taskkill` is WMI-based, and WMI denies it to this non-administrator NETWORK-token logon (the
  agent's SSH logon into this account). Run by hand in the same logon, on the same verified pid, `taskkill` answered
  `ERROR: Access denied` after 5124 ms, which matches the stall.
- **How the browser was ended.** It was ended by its verified pid (name, start time, the only listener on 9222) with
  `Stop-Process`.
- **The same build in other logons.**
  - In an administrator's logon, where WMI answers, a byte-identical copy of this install (equal exe and `app.asar`
    hashes) logged `[vision] Ended the app-started browser (pid …)` at each of four quits. No Chrome and no listener
    on 9222, 19333 or 19334 was left.
  - In an interactive console logon, with the app not elevated: not observed. At the owner's sitting the test copy's
    own Vision browser never opened its port, for a harness cause (below), and its quit was not checked for a
    leftover browser.

### Upgrade from 2.1.0 (agent, 2026-10-13)

**Where and how it ran.** The same Windows test VM, the same standard account, the same job runner and wizard driver.
Before this part, the clean-install copy above was removed with its own uninstaller (`/currentuser /S`, Valid,
exit 0). The account was then restored to its state before the lane, with a matching state report.

**Setup.** In this order:
1. Signed 2.1.0 was installed with `/S`. Its wizard's own data-folder values were written to the registry first,
   because a silent install skips those pages.
2. Fixture data was seeded by file before 2.1.0 ran (fictional, never a real sign-in):
   - two configs: a local Claude config on the primary account, and an SSH config to a documentation address;
   - stand-in credentials for the primary Claude account and for Codex;
   - a saved Claude Code transcript;
   - settings as a 2.1.0 user has them (Codex off, no answer to the Codex question).
3. 2.1.0 was run once. At that run it created the second Claude profile itself, through its own IPC. It was then quit.
4. After 2.1.0 quit, the second profile's stand-in credentials and a third config, a local Claude config bound to that
   profile, were written by file.
   - So 2.1.0 never read that profile's identity. In 2.1.1 the account list shows no address for it and labels it
     "setup incomplete".
   - Its credential state still reads signed in, and its session card names its account.
   - This comes from the fixture, not from the app.
5. Every data and credential file was then hashed.
6. The qualification installer was started the double-click way, and its wizard was walked with the forward buttons
   only.

| Check | Result |
|---|---|
| Wizard over 2.1.0 | **PASS.** The pages: Welcome ("If an earlier version is installed, Setup updates it and keeps your data and resources folders"); Data folder and Resources folder, with the existing values preselected; "Only for me" preselected, with "There is already a per-user installation ... Will reinstall/upgrade"; the install location unchanged; Install; Finish with "Run AI Code Conductor" checked. 66 s. |
| One uninstall entry (HKCU and HKLM, both views) | **PASS.** 1, in HKCU (`0210f08e-15d0-5073-901d-684e27f31b7d`, DisplayVersion 2.1.1); none in HKLM. |
| Uninstaller | **PASS.** `Uninstall AI Code Conductor.exe` is version 2.1.1 and Authenticode Valid, with the same signer thumbprint. The app exe is 2.1.1.0 and Valid. Its `app.asar` has the same SHA-256 as the clean install's. |
| Data and credentials kept | **PASS.** All 17 user-data and credential files have equal SHA-256 before and after: the three stand-in credential files in the account's home, the transcript, `configs.json`, `profiles.json`, `window-state.json` and its backup, `command-bar-ui.json`, both profiles' credential and identity files, and the first-run Claude config backup. No file was removed. These changed, as the migration and use write them: `settings.json`, `app-meta.json`, `usage-tracking.json` and `github-config.json`; the help docs (`app-knowledge.md`, `ask-conductor-skill.md` and `ask-conductor-skill-portable.md`); the picker scripts ("Scripts rewritten", below); and the two app databases' journal files (`-shm` and `-wal`; `tokenomics.db` and `transcripts.db` themselves are equal). |
| Profiles start | **PASS.** Each local Claude config was started from the Saved tab. The account dialog preselected the primary account for the first config and the bound profile for the second, and each was started with Launch. Each session card names its own profile's account. The stand-in Claude Code recorded both starts in the project folder. Both profiles read signed in: each one's credential state, as the app reads it, has its address and an expiry, and no "credentials missing". The agent's reader drops every token field, so this says nothing about a refresh token. For the second profile, the account address the app keeps for the profile (`accountEmail`) is empty, as step 4 of the setup explains; the address in its credential state (`oauthEmail`) is there. |
| The one-time Codex question | **PASS.** "Do you use Codex?" was shown once, after What's New and the GitHub notice. Its text: "Codex now has accounts of its own in this app. Choose again: your earlier Codex setting does not carry over." It was answered with "No, I don't use Codex". It was not asked again at a later start, nor after the install chain (`rollback.md`). |
| What's New heading | **Shown. The exact words:** the heading is **"What's new since 2.1.0"**. Under it: "13 things worth knowing, in one line each, and 5 of them have a page of their own, just behind this one." The first section is "CODEX, A FULL ASSISTANT". It was dismissed with "Skip the showcase". The heading names the release the user came from. The release plan's upgrade check read "the heading names the running release". **PASS on the owner's ruling of 2026-10-14:** the heading is correct, and for 2.1.1 the check's heading clause reads "What's new since <from-version>" (`docs/wp1/owner-decisions-2026-10-13.md#WN1`). |
| Scripts rewritten | **PASS.** At the first start of the qualification build, the shipped scripts were rewritten to its bytes: `resume-picker.js` (32841 to 71063 B), `codex-resume-picker.js` (6673 to 9173 B) and `lib/codex-resume-picker-lib.js` (8335 to 38551 B). `ccc-codex-hook.js` (7525 B) and `ccc-codex-hook.cmd` (400 B) were added. `claude-multi-statusline.js` (8003 B) is byte-equal, so it was not rewritten, by design. |
| Vision | **NOT STARTED in this logon. In an interactive logon, with the app not elevated, the console check passed (below): the same build ended a leftover browser of 2.1.0's shape and started Vision.** 2.1.0's Vision Chrome (started at its run, on port 9222) survived its quit, as 2.1.0 always does. At each start of the qualification build, the log has `The check of the browsers on port 9222 did not answer; nothing is ended`, then `[ERROR] [vision] Vision was not started at boot: the vision browser's debug port 9222 is in use`. The check is a CIM process query, which this non-administrator NETWORK-token logon (the agent's SSH logon) is denied. The console check below answered for an interactive logon with the app not elevated: there the same build ended the old browser and started Vision. In this logon type it does differ from 2.1.0, which attaches to its leftover browser and starts Vision (`rollback.md`, "Vision"). `release-qualification.md` section 3 lists it as known limitation 11. The old Chrome was then ended by its verified pid (name, start time within 5 ms, the only listener on 9222), and all 9 of its processes ended. |
| Quit | **PASS for the app.** "Close sessions" left no app process. |

### Windows: the owner's sitting (2026-10-14)

**Where and how.** The owner, at the console of the Windows test VM, in the VM's administrator test account (an
interactive logon), from 00:16 to 01:05 UTC. The app ran without elevation. It was the test copy that
`real-cli-matrix.md` describes ("The owner's sitting"): a hash-equal copy of the install above, started by a launcher
with its own data folder, its own home folder (`USERPROFILE`, `HOME` and `CODEX_HOME`) and a loopback DevTools port.
The agent read the app's state over that port and, for the window buttons, injected mouse events into the page through
it.

**The console check: PASS in the app.**
- The owner first ran the staged probe in an elevated PowerShell. The app's browser query answered in the interactive
  token: exit 0, in 1411 ms. The probe's own verdict line read FAIL, for two faults of the probe, not of the app:
  Windows PowerShell 5.1 unwrapped a one-entry JSON array, so the probe could not parse its count; and Chrome replaced
  the probe's launcher process when it relaunched itself without elevation, so the probe could not tell whether its
  browser was listed.
- The probe left a browser on port 9222 shaped like the one 2.1.0's Vision leaves: started with 2.1.0's Vision
  arguments, its profile folder (`chrome-debug-9222`) in the account's temporary folder, and not elevated, so an app
  that is not elevated may end it.
- The test copy, not elevated, then started. Its log has, at 2026-10-14T00:21:23.537Z, `[vision] Ending the app's
  vision browser left from an earlier run (pid …) on port 9222`; it launched its own browser and logged `Global vision
  started`. So in an interactive logon the qualification build recognises a leftover browser of 2.1.0's shape as its
  own, ends it and starts Vision. This settles the Vision row of the upgrade from 2.1.0 above for that logon.

**The test copy's own Vision browser did not connect, for a harness cause, proven.**
- After that start, the test copy's own Vision browser never opened its debugging port, through 4 automatic
  relaunches.
- The owner then ran a second staged script, not elevated. It started Chrome 155.0.8059.40 with the app's exact
  arguments on spare ports, three ways:
  - A, a fresh profile in the account's normal environment: listening after 507 ms;
  - B, a fresh profile with the test copy's environment (`USERPROFILE` and `HOME` set to the launcher's home folder):
    never listening, and Chrome printed "DevTools remote debugging requires a non-default data directory";
  - C, a copy of the existing Vision profile, in the normal environment: listening after 516 ms.
- So the cause is the launcher's home-folder override, not the app and not the profile. A normal install sets no such
  override: the clean install above logged `[vision] CDP root connected to chrome on port 9222` 30 s after it launched
  its browser (in the agent's logon). `release-qualification.md` section 3 records this as known limitation 14.

**The window buttons: PASS for each button's action.** The plan had the owner click each button. Instead the agent
clicked them: mouse events injected into the page through the loopback DevTools port (`Input.dispatchMouseEvent`), not
the operating system's mouse. After each minimise the owner restored the window from the taskbar. A shortcut started
the copy on its setup page, and at a second launch on the Multi Spawn page.

Before each click, the page's own hit test (`document.elementFromPoint` at the button's centre) returned the button.
That test and the injected events stay inside the page: neither goes through the window's own hit test, so neither can
see a drag region of the window lying over a button. This check therefore does not rule out a drag region over a
button. What it shows is that each button's action worked. The Linux run's typing, also injected through the DevTools
port, has the same kind of limit (below).

| Page | Buttons present (the page's own hit test at each is the button) | Results |
|---|---|---|
| Setup page ("Claude CLI Setup") | Minimize, Maximize, Close | Maximize: maximised false to true. Restore: true to false. Minimize: the page went from visible to hidden, with the window on the taskbar; the owner clicked the taskbar icon, and it was visible again and focused. Close: the page stopped answering, the DevTools port and port 19333 stopped listening, and no app process was left. |
| Multi Spawn page ("Enable Multi Spawn") | Minimize, Restore, Close (it opened maximised, so Maximize reads Restore) | Restore: maximised true to false. Minimize: visible to hidden; restored from the taskbar by the owner. Maximize: false to true. Close: the page stopped answering, no app process was left, and the DevTools port and ports 19333 and 19334 were free. |

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

### First launch, Codex, upgrade and rollback (the owner): not run

The owner's run on the macOS test user (a standard account) was planned: the DMG above, with the quarantine flag a
browser download carries, dragged into the home folder's Applications folder and opened; "Use Codex only" at setup with
Codex 0.155.1 on the user's PATH; the owner's ChatGPT sign-in; a Codex session and one prompt; sign out; then 2.1.0 set
up with Claude Code only, 2.1.1 over it (What's New, setup kept), and 2.1.0 over that again (setup still there), with
hashes of the app's data folder after each step. The agent had staged it, and it could have been taken.

It was not run, on the owner's ruling of 2026-10-14: the owner's short path left the macOS sitting out
(`docs/wp1/owner-decisions-2026-10-13.md#SP1`), and this host part of WP1.63 is unavailable on
`docs/wp1/owner-decisions-2026-10-13.md#UA8`. On macOS, the DMG's signature, notarization and Gatekeeper checks above
are what was taken.

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

### The run in the test user's graphical session (agent, 2026-10-14)

**Where and how it ran.**
- The owner logged the test user in once at the console. The agent then worked inside that user's own graphical
  session (GNOME on Wayland), over key SSH as that user, from 01:10 to 01:34 UTC. It started no session of its own,
  used no administrator rights, and changed no login, lock or password setting.
- The CLIs were the ones staged above: Codex 0.155.1 and the stand-in Claude Code. No real sign-in: the Codex account
  was signed in with a fake API key.
- The AppImage's SHA-256 was checked before every start. The app was started with a loopback DevTools port and driven
  over it, by a client running on the test host itself.

**How it differs from the plan.** Every difference comes from the test host's state, none from the build:
- **FUSE 2.** Every start, of both versions, used `--appimage-extract-and-run` (above). The AppImage removed its
  extraction folder at every quit.
- **The locked screen.** GNOME's idle lock had locked the session after the owner left the console, before the run
  began. The agent did not unlock it and changed no lock setting. While the screen is locked, the Wayland compositor
  gives the window no frames, so the terminal view never mounts and no session can start. So:
  - the first clean run used native Wayland. It covers the window, the first run, Settings, Codex and Claude Code
    found, the Codex account, and Quit;
  - the sessions and the typing, and every start in the upgrade and the rollback, ran on X11 through Xwayland
    (`--ozone-platform=x11`), where frames run. Both versions used it for the upgrade and the rollback, so that
    comparison is like for like.
- **Typing was injected through the DevTools port**, not typed on a keyboard: `Input.insertText` into a Settings field,
  and key events into a session's terminal. This proves the path from the page to the session's terminal. It does not
  exercise the desktop's own keyboard path, and typing into a terminal under native Wayland was not tested.
- **No screenshots.** A locked screen gives nothing to capture. The window evidence is DevTools reads of the page.
- **The test user was not removed.** That needs administrator rights, which the run did not use. Its files from the
  run were moved aside instead ("State left", below).

#### A clean run of 2.1.1

| Check | Result |
|---|---|
| Window | **PASS** (native Wayland). The page loads and is visible, 1280 by 768 inside; the GPU process runs on Wayland; Electron 44.5.1; the footer reads `v2.1.1`. |
| First run | **PASS.** The storage folders page (its defaults under `~/.ai-code-conductor`; Continue), Claude CLI Setup, the onboarding with both assistants chosen, then the workbench and the tour. On Claude CLI Setup, "Skip & Continue" stayed disabled for about 80 s, so the walk used "Skip for now" (see the observations). |
| Codex detected, with its version class | **PASS.** Set up Codex read "Codex 0.155.1 found" and "Version supported"; Settings > Accounts reads "Codex 0.155.1 - ready". |
| Claude Code detected | **PASS.** The stand-in, found through a login shell (`command -v claude`): "Claude Code 2.1.296 - ready". |
| Settings opens | **PASS.** The Settings tab opened, with Accounts. A value typed into Local Machine Name (injected, above) read back. |
| A managed account's session runs on its own `CODEX_HOME` | **PASS** (Xwayland). Add Codex account > Use an API key (fake key) made the account's own folder under `codex-realms/`, with `auth.json` (mode 600). A Codex config on that account, added by file while the app was closed, started Codex 0.155.1 with `CODEX_HOME` set to that folder and the project as its working folder, both read from the process. Codex's state files appeared in that folder, and `~/.codex` was never created. |
| A Claude session starts (stand-in) | **PASS** (Xwayland). The stand-in started in the project folder with the app's `--settings`, `--mcp-config` and `--plugin-dir` arguments and `CCC_CONFIG_DIR` set. Ctrl+C sent to its terminal ended it; the stand-in ends only on that byte or at the end of its input, so the keys reached the session. |
| Quit leaves no process | **PASS.** Three quits. Two showed "You have 2 active sessions..." and were answered "Close sessions", but neither had two live sessions: on the locked screen the first had none, and in the second only Codex was live (Ctrl+C had ended the stand-in). A quit with two live sessions is in the upgrade below. After each quit: no app, Codex, stand-in or browser process; ports 9222, 19333 and 19334 free; the extraction folder removed. |
| Vision | **PASS.** The app started a headless Chromium on loopback port 9222, connected to it, and ended it at every quit (`[vision] Ended the app-started browser`). 2.1.0 also ends it. |

#### The upgrade from 2.1.0, then the rollback to it (on the same data)

**Setup.**
1. The clean run's data was moved aside.
2. A 2.1.0 user was seeded by file (fictional, never a real sign-in): 2.1.0's settings and app data; two configs, a
   local Claude config and an SSH config to a documentation address, never started; a saved transcript; stand-in Claude
   credentials and `.claude.json`; and a stand-in Codex `auth.json` in the home folder.
3. 2.1.0 was run once. It walked its storage page, Claude CLI Setup and the GitHub notice; a setting was changed
   through Settings; and 2.1.0 created a second Claude account profile through its own IPC. It was then quit.
4. The second profile's stand-in credentials and a third config, bound to it, were written by file, and every file
   was hashed.

An AppImage is not installed: each step starts that version's AppImage on the same data folder. So there is no
installer, uninstall entry or uninstaller to check, as there is on Windows.

| Check | 2.1.1 on 2.1.0's data | 2.1.0 again (rollback) |
|---|---|---|
| Starts, version shown | **PASS.** Footer `v2.1.1` | **PASS.** Footer `v2.1.0` |
| What's New | **PASS** on the owner's ruling (`docs/wp1/owner-decisions-2026-10-13.md#WN1`): "What's new since 2.1.0", with "13 things worth knowing, in one line each, and 5 of them have a page of their own, just behind this one.", the same words as on Windows | Its own "What's new in 2.1" |
| The one-time Codex question | **PASS.** After What's New and the GitHub notice, "Do you use Codex?" was shown once and answered No: the same order as on Windows | Not asked (2.1.0 has no such question) |
| Both profiles read signed in, all three configs listed | **PASS.** Each profile's credential state has its address and no "credentials missing". The second profile reads "(setup incomplete)" in the account list, as on Windows (a fixture effect, "Upgrade from 2.1.0" above) | **PASS** |
| Both profiles start | **PASS.** The Start session dialog preselected each config's own account. The stand-in started in the project with each profile's own folder as its home, and each session card names its profile's account | **PASS.** Each with its own folder as its home |
| User data and credentials | **PASS.** No file was removed. Byte-equal: the stand-in Claude credentials and `.claude.json`, the Codex `auth.json`, the transcript, `configs.json`, `window-state.json`, and the second profile's credentials and `.claude.json` | **PASS.** The same files are still byte-equal with those before the upgrade. The only path removed is a Codex temp lock, which Codex itself rotates |
| Quit | **PASS.** With two live sessions: "Gracefully exiting 2 sessions ... All sessions exited", and no process left | **PASS.** The same |

The hashes are SHA-256 (the first 16 hex digits) with the size, taken before the upgrade, after it and after the
rollback.

**What changes between versions, by design.**
- 2.1.1 rewrites `settings.json`, `app-meta.json`, `github-config.json`, `usage-tracking.json`, the help docs, the
  databases' journal files and the logs, and the shell history in both profile folders changes. It rewrites the 3
  resume-picker scripts to its own bytes.
- 2.1.1 adds its Codex hook scripts (`ccc-codex-hook.js` and `.cmd`), `providers/registry.json`,
  `conductor-secret.json`, `openai-model-pricing.json`, `help/AGENTS.md` and `help/.git`, the `canvas-plugin` folder
  (2.1.0 also builds it when it starts a session), and the second profile's `identity` copies of its sign-in files.
- On the rollback, 2.1.0 puts back its own picker scripts, help, app data and `github-config.json`. It leaves 2.1.1's
  added files in place, and the canvas plugin they share has the same bytes in both. `settings.json` keeps 2.1.1's
  rewrite, and 2.1.0 runs on it.

#### Observations (neither severe nor a regression against 2.1.0)

- On Claude CLI Setup, "Skip & Continue" waits for the page's own setup terminal to start. On the locked screen that
  terminal never started, so the button stayed disabled. 2.1.0 has the same rule. On Windows the button was enabled.
- Both versions log `Error occurred in handler for 'sentinel:getState': No handler registered` once in every run, and
  Node's DEP0190 warning (a shell with arguments) in one run of each. `gh` is not installed on the test host, and the
  app logs that its check of it failed.
- The runs created these in the test user's home folder: `~/.config/claude-conductor` (Electron's user data folder,
  named after the package name, which stays frozen), `~/.config/chromium` (crash reports of Vision's Chromium),
  `~/.local/share/pki`, an empty `~/.local/share/applications/mimeapps.list` and `~/.cache/fontconfig`. The last three
  appeared at the first start of 2.1.1; whether 2.1.0 alone makes them was not seen, because they were still there
  when 2.1.0 ran.
- Vision's Chromium leaves small singleton folders and files in `/tmp` (`org.chromium.Chromium.*`). 2.1.0 leaves the
  same.
- Claude CLI Setup runs `claude` in a login shell, and that shell adds a line to the test user's shell history. 2.1.0
  does the same.

**State left.** Every file of the run was moved aside, by its literal path. The test user's `~/.config`,
`~/.local/share` and `~/.cache` then listed the same entries as before the run; no process or port of the run was
left; and both AppImages' hashes were unchanged. Not cleared: Vision's `/tmp` singleton folders and files, which need
their own removal (removing the test user does not clear `/tmp`), and the shell-history lines, which go when the test
user is removed. The graphical session stayed logged in: it was never unlocked or logged out.
