# Packaged smoke: the signed 2.1.1 release build (WP1.63)

This file is the evidence for WP1.63: a clean install of the signed release build outside any checkout, the Codex CLI
found and classed, a session on a managed account's own `CODEX_HOME`, and a clean Quit. It covers Windows, macOS and
Linux.

**Status: partly recorded.** The Windows smoke and the macOS signature checks are recorded below. The rest is in
PENDING blocks: the Windows checks in an interactive logon and the packaged upgrade, the macOS install and first launch
by the owner on the macOS test user, and the Linux run. WP1.63 stays `planned` until every part is recorded. No part
of it is expected to be unavailable: it would be only if a host part could not be taken, on an owner decision.

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

### Windows: still owed

> **PENDING: the console check in an interactive standard-user logon.** The owner signs in to the standard test account
> at the VM's console and runs a staged script. It starts a browser the way 2.1.0's Vision did, runs the app's own
> browser query (`WINDOWS_BROWSERS_SCRIPT` at the head; `src/main/vision-browser-owner.ts` is unchanged from
> 2.1.1-beta.3), and records the logon's token, the query's exit code and whether the browser is listed, and the exit
> code of the same `taskkill` call the app makes at Quit. It passes on an interactive token, a query that exits 0 and
> the browser listed. Not run yet.

> **PENDING: the window buttons.** On the setup page and on the Allow Multi Spawn page of the packaged build, each of
> minimise, maximise and restore, and close, clicked by the owner. Not run yet.

> **PENDING: the packaged upgrade from 2.1.0 on Windows.** 2.1.0 installed and run once, then the qualification
> installer run over it by double-click: one uninstall entry, a valid uninstaller, equal hashes of the seeded files,
> profiles start, the Codex question, the What's New heading, the app's scripts rewritten, and Vision. Being run by the
> packaged-build lane; not recorded yet.

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
