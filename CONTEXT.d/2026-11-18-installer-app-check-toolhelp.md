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
  and its program file, as `QueryFullProcessImageNameW` reports it, is `$INSTDIR\<name>`. In the
  installer pass the folder of the install this run replaces counts too: the uninstaller
  `customInit` recorded (`$cccLegacyUninstaller`, the same proof the rename sweep uses). That
  is where a pre-rename build still runs under its old name, and it is the folder this run
  removes. Paths go through `CanonPathPair`, so case, a forward slash or an 8.3 name makes no
  difference. Anything else with the same name is left running and written to the details log
  with the reason. No other image name is looked at, so `aicc-helper.exe` and the terminals it
  holds keep running through an install.
- **How they close.** `CccCloseAppCopies` posts `WM_CLOSE` to each top-level window those
  processes own (the windows are listed first, then closed), waits up to 5 s while it looks
  again every 250 ms, and then calls `TerminateProcess` on each first-found copy that is still
  running, through a handle held open while it checks that the process is still this user's
  with the same start time (`CccProcessStart`), so a pid that passed to another process is never
  ended. It then looks for up to 2 s more and answers in `$R0`; it saves and restores every other
  register.
- **The box stays.** If a copy is still running (one started as administrator, for example),
  the Retry and Cancel box is shown as before. Retry now runs the whole check again (it used to
  carry on without looking), and Cancel still calls `CccRestoreInstallLocation` in the installer
  pass. A silent run answers Cancel (`/SD IDCANCEL`), as electron-builder's own check does: an
  unanswered box would hold a remote or scheduled install forever.
- **-WX.** The new macros declare no `Var` and no `Function`; in both passes they use only
  `CanonPathPair`'s scratch, which `customHeader` declares in both. The replaced install's
  uninstaller and the cancel restore are used in the installer pass only.
- **Tests.** installer-branding-guard.test.ts: no line runs tasklist, taskkill, WMI or
  PowerShell (red before at :716, :720 and :733), and the scan, close, end and register rules
  above are pinned. installer-nsis-behaviour.test.ts (CI and VM only): the real macros run in
  both passes (the uninstaller pass with /WX) against running stand-ins under the app's names:
  a copy with a window closes itself on `WM_CLOSE`, one without a window is ended after the
  wait, and a same-named copy in another folder, an `aicc-helper.exe` in the install folder and
  (in the uninstaller pass) the replaced install's copy keep running. Another user's copy cannot
  be made on a CI runner: that, a remote silent install, an elevated uninstall beside a second
  user's copy and an install beside a held terminal are the release smoke's, on the VM.
