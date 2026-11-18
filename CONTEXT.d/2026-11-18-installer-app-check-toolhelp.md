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
  left running and written to the details log with the reason. No other image name is looked
  at, so `aicc-helper.exe` and the terminals it holds keep running through an install.
- **How they close.** `CccCloseAppCopies` lists the top-level windows those processes own as
  `window:pid`, and just before each `WM_CLOSE` checks that the window is still that pid's and
  that the pid, held open, still has the start time the first look recorded. It waits up to 5 s
  while it looks again every 250 ms, then calls `TerminateProcess` on each first-found copy
  that is still running, through a handle held open while it checks that the process is still
  this user's with the same start time (`CccProcessStart`), so a pid that passed to another
  process is never ended. It then looks for up to 2 s more and answers in `$R0`; it saves and
  restores every other register.
- **Not covered.** On an all-users run that is already elevated (no UAC), `uninstallOldVersion`
  also runs the per-user record in HKCU; a copy running from that per-user folder is not closed
  by this check, and that install's own uninstaller then checks for it. The elevated inner
  instance of an all-users install skips `CHECK_APP_RUNNING` altogether, as before.
- **The box stays.** If a copy is still running (one started as administrator, for example),
  the Retry and Cancel box is shown as before. Retry now runs the whole check again (it used to
  carry on without looking), and Cancel still calls `CccRestoreInstallLocation` in the installer
  pass. A silent run answers Cancel (`/SD IDCANCEL`), as electron-builder's own check does: an
  unanswered box would hold a remote or scheduled install forever.
- **-WX.** The new macros declare no `Var` and no `Function`; in both passes they use only
  `CanonPathPair`'s scratch, which `customHeader` declares in both. The replaced install's
  record (`$cccRecordUninstaller`, through `CccGetInQuotes`) and the cancel restore are used in
  the installer pass only.
- **Tests.** installer-branding-guard.test.ts: no line runs tasklist, taskkill, WMI or
  PowerShell (red before at :716, :720 and :733), and the scan, close, end and register rules
  above are pinned. installer-nsis-behaviour.test.ts (CI and VM only): the real macros run in
  both passes (the uninstaller pass with /WX) against running stand-ins under the app's names:
  a copy with a window closes itself on `WM_CLOSE`, one without a window is ended after the
  wait, and a same-named copy in another folder, an `aicc-helper.exe` in the install folder, an
  install only another hive records and (in the uninstaller pass) the replaced install's copy
  keep running. Seven mutants each went red on the VM. Another user's copy cannot
  be made on a CI runner: that, a remote silent install, an elevated uninstall beside a second
  user's copy and an install beside a held terminal are the release smoke's, on the VM.
