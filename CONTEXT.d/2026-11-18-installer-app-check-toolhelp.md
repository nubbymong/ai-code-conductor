## 2026-11-18 -- The installer closes only this user's copy of the app from the folder it installs to, without tasklist or taskkill

Plan 2.1.3-beta.8, section C3 (aicc_planning #319).

- **What changed.** `customCheckAppRunning` (build/installer.nsh), which electron-builder inserts
  in both passes (the top of the install section, and the uninstaller's `un.checkAppRunning`),
  no longer runs `tasklist` and a bare `taskkill /im`. Over a non-interactive sign-in (SSH, a
  scheduled task) both answer "Access denied", so the old check found and closed nothing there;
  and an elevated run's `taskkill /im` asked every signed-in user's copy to close. The
  `KillIfRunning` macro is gone.
- **What counts as this install's copy.** Two new macros beside `CccScanProcesses`:
  `CccScanAppCopies` takes one Toolhelp snapshot and keeps a process only when its image name
  is one of the app's own three (the current one and the two from before the rename), it runs
  as this copy's own user (`CccProcessIsMine`, the SID read as `CccEndUserHelpers` reads it),
  and its program file, as `QueryFullProcessImageNameW` reports it, is `$INSTDIR\<name>`. Each
  candidate is held open from before its user check until its start time is read, so the user,
  the file and the start time are one process's. In the installer pass the folder of the
  install this run replaces counts too: the one its uninstall record names in `SHELL_CONTEXT`,
  the record `uninstallOldVersion` runs next (or, for a legacy tree, the one the commit point
  drops before the sweep removes that tree). That is where a pre-rename build still runs under
  its old name. Not `$cccLegacyUninstaller`: `customInit` falls back to the other hives for it,
  as the sweep's proof of ownership, so on a per-user run it can name an all-users install this
  run never touches (a Copilot review point on the PR). Paths go through `CanonPathPair`, so
  case, a forward slash or an 8.3 name makes no difference. Anything else with the same name is
  left running and written to the details log with the true reason: it could not be opened, it
  is another user's, its program file could not be read, or it runs from another folder.
  `CccProcessIsMine` now answers 1 (this user's), 0 (another user's) or 2 (not known: the
  process or its token could not be read); every older caller tests for 1, so the helper
  clean-up acts exactly as before. No other image name is looked at, so `aicc-helper.exe` and
  the terminals it holds keep running through an install.
- **How they close.** `CccCloseAppCopies` lists the top-level windows those processes own as
  `window:pid`. Before each `WM_CLOSE` it checks that the pid, held open, still has the start
  time the first look recorded, and then, last of all, that the window is still that pid's. It
  writes how many windows it asked, or that none could be reached. It waits up to 5 s, looking
  again every 250 ms. Then:
  - In a run someone can see (not silent), a copy that was asked to close and is still open is
    probably asking whether to save its sessions (the app's close dialog). Nothing is ended:
    the box asks the user to answer it and Retry, and the app closes at once on the second
    `WM_CLOSE`. Before this, the copy was ended 5 s after the dialog appeared, losing the answer
    and the app's own teardown (a review finding on the PR).
  - Otherwise (a silent run, or no copy that was asked is still open) it calls
    `TerminateProcess` on each first-found copy that the last look still saw, through a handle
    held open while it checks that the process is still this user's with the same start time
    (`CccProcessStart`), so a pid that passed to another process is never ended. Each outcome
    is logged: ended, could not be ended, could not be opened, or no longer the same process.
    It then looks for up to 2 s more.
  - Over a remote or scheduled sign-in the installer runs on another desktop and cannot see the
    app's windows, so nothing is asked: the copy is ended after the 5 s wait. The log then reads
    "No window of AI Code Conductor could be reached from here ..." and then "Ended process N,
    which did not close within 5 seconds." That is the expected result for the release smoke,
    not a failure.
  - A last look writes what is still running and answers in `$R0`: 0 none, 1 still running,
    2 could not be checked. It saves and restores every other register.
- **A copy whose user cannot be read.** When the installer is not elevated, a process from this
  install's folder whose user cannot be read (most likely this user's copy started as
  administrator) counts as still running at the last look: it is never asked to close or ended,
  and the box appears. An elevated installer can read the user of every copy this user started,
  so there such a process is another user's and keeps running, as another user's copy does.
  Whether a non-elevated installer can open this user's elevated copy at all is not known on
  this PC: that is a release-smoke route on the VM. If it cannot, the copy is not seen.
- **The boxes and the stop.** If a copy is still running, the Retry and Cancel box says so and
  names no single image name (the details log says which process is left). Retry runs the whole
  check again (it used to carry on without looking). If the check could not run at all (this
  copy's own user, or the running programs, could not be read), an OK and Cancel box asks
  whether to carry on; before, the run went on as if nothing were running. A silent run answers
  Cancel to both (`/SD IDCANCEL`), as electron-builder's own check does: an unanswered box
  would hold a remote or scheduled install forever. A run that stops writes why ("... so
  nothing was installed" or "... removed"), calls `CccRestoreInstallLocation` in the installer
  pass, and exits with code 2 (`SetErrorLevel 2`), so a remote install that installed nothing
  does not look like a success. "No copy ... is running" is written only after a check that ran.
- **Not covered.** On an all-users run that is already elevated (no UAC), `uninstallOldVersion`
  also runs the per-user record in HKCU; a copy running from that per-user folder is not closed
  by this check, and that install's own uninstaller then checks for it. A legacy-named copy
  running from one of the sibling folders the rename sweep removes (`RemoveLegacyInstall`, once
  `ProveLegacyInstallRoot` proves it) is not closed either when no uninstall record in this hive
  names that folder: the plan named "the legacy folder the installer already resolves", and the
  check takes this hive's record because `customInit`'s capture can name another hive's install;
  the sweep then cannot remove that copy's files. The elevated inner instance of an all-users
  install that elevates through UAC skips `CHECK_APP_RUNNING` altogether (installSection.nsh),
  as before; a planning ticket records it.
- **-WX.** The new macros declare no `Var` and no `Function`; in both passes they use only
  `CanonPathPair`'s scratch, which `customHeader` declares in both. The replaced install's
  record (`$cccRecordUninstaller`, through `CccGetInQuotes`) and the cancel restore are used in
  the installer pass only. Both labels in the hook are jumped to in both passes. The uninstaller
  pass compiles with /WX in the probe; the installer pass is first compiled with -WX by the
  release PR's package job.
- **Tests.** installer-branding-guard.test.ts: no line runs tasklist, taskkill, WMI or
  PowerShell, and the scan, close, gate, end, last-look, box and register rules above are
  pinned. installer-nsis-behaviour.test.ts (CI and VM only): the real macros run in both passes
  (the uninstaller pass with /WX) against running stand-ins under the app's names: a copy with a
  window closes itself on `WM_CLOSE`, one without a window is ended after the wait, and a
  same-named copy in another folder, an `aicc-helper.exe` in the install folder, an install only
  another hive records and (in the uninstaller pass) the replaced install's copy keep running.
  In a run someone can see, a copy that stays open when asked is not ended, nor is anything
  else, and the box stops the run (both passes). In a silent run a copy that stays open is
  ended, and a copy started after the first look stops the run: Cancel puts back the saved
  install location and the exit code is 2. Another user's copy and this user's elevated copy
  cannot be made on a CI runner: those, a remote silent install, an elevated uninstall beside a
  second user's copy and an install beside a held terminal are the release smoke's, on the VM.
  Retry, and an interactive install with sessions open, need a desktop: the owner's steps.
