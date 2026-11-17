## 2026-11-17 -- Uninstall removes the per-user session helper folder; one installer look (2.1.3-beta.7 section C3)

**Why.** Uninstalling left `%LOCALAPPDATA%\AI Code Conductor\helper` behind:
the app's own copies of the session helper (`<version>-<12 hex>`, with the
bundled ConPTY), a half-made copy (`.new-<12 hex>`), the held sessions'
records (`store`), and two files, `bindings.json` and the crash mark
`app-running.json`. `build/installer.nsh` never named the folder. No
planning ticket existed for it; the beta.7 scope review found it.

- `RemoveUserHelperFolder`, inserted by `customUnInstall` under
  `${IfNot} ${isUpdated}`. An update keeps everything: the new installer
  runs the old uninstaller with `--updated` (electron-builder
  `installUtil.nsh`, `uninstallOldVersion`), and held terminals are meant
  to live through an update. The one exception is Setup started with
  `--delete-app-data`: it passes that flag instead, which asks for the
  app's data to go, so the helper folder goes too.
- It runs on every route of a real uninstall. In the elevated copy of an
  all-users uninstall the user started, it runs in the user's own first
  copy (`UAC_AsUser_Call`). Any other uninstall runs it in its own copy: a
  per-user one, and one started already elevated, which has no first copy
  behind it. electron-builder's own template says Windows Settings, Apps
  can start an all-users uninstall that way (`multiUserUi.nsh`), and an
  administrator prompt does too. If the first copy did not run it, the
  elevated copy does. An uninstall that runs as another account from the
  start (a standard user who typed an administrator's password) reaches
  that account's folder, not the standard user's.
- So it is safe to run as administrator. It never deletes recursively and
  walks only the helper's own layout (`install.ts`, `manager.ts`,
  `helper/src/store.rs`): each folder is checked not to be a link before
  anything in it is touched, files go by name or by a wildcard inside the
  checked `store` (`*.json` and `*.json.*.tmp`, which no short 8.3 name can
  match; `*.tmp` would also take `notes.tmpl`, whose short name ends in
  `.TMP`), and folders go with plain `RMDir`, deepest first, so
  anything the app did not make stays and is noted. It never removes a
  folder that is, or holds, the user's data or resources folder (the
  recorded ones, or the ones `src/main/data-paths.ts` then uses), compared
  canonically, and leaves everything alone when the parent or `helper` is a
  link. Not covered: a hostile program swapping a checked folder for a link
  between the check and the delete; even then only files with those names
  could go.
- It force-ends this user's running `aicc-helper.exe` holders and what each
  one started: at least 8 levels below each holder, and in practice all of
  them (each pass also takes the children of what it found earlier in the
  same pass). The loop stops after 8 passes or a pass that finds nothing
  new. It does so without WMI: a Toolhelp process list, each process's
  owner compared with this copy's own user SID (never another user's, even
  elevated), children taken by parent id only when started after their
  parent, and `TerminateProcess` after the owner is checked again.
  `taskkill` was the first version: over a non-interactive sign-in
  it answers "Access denied" even by PID (WMI), and the VM showed a
  non-elevated uninstall leaving the holder running and its copy behind.
- The details list shows what it did on every route. The clean-up keeps its
  notes in `$9`, which the UAC plugin copies back from the windowless first
  copy with the other registers, and the copy with the window shows them.
- No `/REBOOTOK`: a delete scheduled for the next start runs before anything
  can check the path again, so a link put there meanwhile would be followed.
- `CanonPathPair`'s scratch variables are now declared in both compile
  passes (`customHeader`), since the uninstaller pass compares paths too.
- The uninstaller's Welcome page says held terminals are ended.
- Mac and Linux have no uninstaller, so nothing changes there.

**Tests.** `installer-nsis-behaviour.test.ts` compiles the real macros as
the uninstaller pass does (`BUILD_UNINSTALLER`, the real `customHeader`,
`/WX`) and runs `customUnInstall` over real trees, with junctions and
running stand-ins; the user copy's call is emulated, its detail lines are
logged apart, and its stack is checked. A real installer of the head, built
on the VM, was installed, updated over itself and uninstalled per user (not
elevated) and for all users (started elevated), each with a held terminal
running. Until now CI had no makensis and skipped the probe; the Windows
test parts now fetch electron-builder's own (`scripts/ci/fetch-makensis.mjs`),
and a Windows CI run without one fails. `installer-branding-guard.test.ts`
pins the same macros statically, everywhere. Runs and mutants are in the PR.

**One installer look (aicc_planning#295).** The installer mixed a dark
theme with the light system dialog: Modern UI's `MUI_BGCOLOR` and
`MUI_TEXTCOLOR` colour only the header and the Welcome and Finish pages, the
Data and Resources pages painted themselves dark with `SetCtlColors`, and
the button strip and the Browse buttons stayed stock, since NSIS cannot
recolour those without a skin plugin. Decision (orchestrator default, the
owner said work unaided): keep Windows' stock light dialog on every page and
put the brand in the header bitmap and the sidebar art only. So the colour
defines, `MUI_FORCECLASSICCONTROLS` and every `SetCtlColors` (both folder
pages and the emblem) are gone. The header bitmap and the folder-page
emblem are drawn again on the light grounds they now sit on: white for the
header band, and the dialog face colour for the emblem, whose
`SS_CENTERIMAGE` strip takes the bitmap's corner colour
(`scripts/gen-installer-art.mjs`). The sidebar and the splash keep the dark
brand ground, as a panel. It is its own commit, so it can be dropped.
`installer-branding-guard.test.ts` fails on any colour define (with or
without a `/ifndef` or `/redef` switch), classic controls or `SetCtlColors`,
and on a header or emblem with dark corners; its detector is checked
against every line this removed (13 lines, 11 distinct). Not seen yet: the
look on a real screen. Installers are built only on release branches, so
the screenshots of every page (fresh install, upgrade over beta.6,
uninstall) come from the beta.7 release build, for the owner's sign-off.
