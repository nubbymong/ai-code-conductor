## 2026-11-25 -- A full uninstall removes this user's Codex pick folders from the temp folder

Plan 2.1.3-beta.18, section 7.1 (aicc_planning#407, the uninstall half), at origin/beta d0be048e.

- **The premise, read at the base.** beta.17 C4 sweeps the `ccc-codex-pick-*` folders a kill left
  in the temp folder at the app's start only (src/main/index.ts, the Codex provider's
  `sweepLeftoverPickFolders`, spawn.ts `sweepStaleCodexPickFolders`). `customUnInstall`
  (build/installer.nsh) removed the session helper's folder and nothing in the temp folder, so a
  quiet uninstall with no later start left one folder per Codex tab for good.
- **The uninstall step** (build/installer.nsh, `RemoveUserCodexPickFolders`, inserted right after
  `RemoveUserHelperFolder` under the same `${IfNot} ${isUpdated}`): C4's rule less its age bound,
  because by then the uninstaller has closed this install's copies of the app and the helper
  clean-up has ended the terminals it held. A folder directly in the temp folder whose name starts with the
  app's prefix (case counts), a real folder (not a link or junction), holding nothing but plain
  files named `pick.json` or `pick.json.<16 hex>.tmp`: checked again not to be a link, each file
  deleted by its checked name, then a plain `RMDir`. Anything else keeps the whole folder. Never
  `RMDir /r`, a wildcard delete or a delete at the next restart; never on an update.
- **Whose temp folder.** It runs in the copy of the uninstaller the user started, as the helper
  clean-up does (`UAC_AsUser_Call`), and reads the temp folder the way the app's `os.tmpdir()`
  does: `TEMP`, then `TMP`, one trailing backslash dropped (never the one after a drive letter).
  NSIS's own `$TEMP` reads `TMP` first, so a user who set the two apart would have had the wrong
  folder read and the app's folders left (found in the section's review; fixed before the join).
  Only a temp folder inside the running account's own user folder (`$PROFILE`, compared
  canonically) is read; a shared
  one, such as Windows' own temp folder that an uninstall run as the system account gets, is left
  alone, with one note.
- **The details list** gets one line per pick folder removed or left, or one saying there were none,
  after the helper clean-up's lines.
- **Known edge:** a second copy of the app the user runs from elsewhere (a development build) shares
  the temp folder; the pick folder of a session it is running goes too. That session goes on, and a
  later choice in its resume list is not recorded (the list says so).
- **Tests.** `tests/unit/main/installer-branding-guard.test.ts`, 7 new static cases (the guard and
  the order, the user's copy and the notes, the temp folder and the prefix read from spawn.ts, both
  link checks, the content rule with names read from spawn.ts and the picker library, files by name
  and no `RMDir /r`, the registers), and the existing guard case updated for the new line. Red
  against d0be048e's installer.nsh: 8 of 62. Mutants, each red: `RMDir /r` (2), the insert moved
  outside the update guard (2), the first link check made always false (1), the user-folder check
  dropped (2). `tests/unit/main/installer-nsis-behaviour.test.ts` (HOST QUARANTINE, CI's Windows
  parts and the VM only, not run here): the uninstall probe lifts the new macros, its `TEMP` and
  `TMP` reads are two fixture values (a `$TEMP` left in the macros stops the probe), and 9 new
  real-makensis cases cover the app's own folders, the lookalikes, a link and a link inside one, an
  update (two routes), the elevated copy, a temp folder outside the user folder, none to remove,
  `TEMP` before `TMP`, and a trailing backslash. The static temp-folder case asserts no `$TEMP` is
  read and the two reads come `TEMP` then `TMP`: red with the two swapped, and red with
  `StrCpy $R0 "$TEMP"` put back.
- **Not checked here:** the real compile and the probe cases (CI on the aggregate PR); the quiet
  uninstall with a held Codex tab (the section's VM line).
