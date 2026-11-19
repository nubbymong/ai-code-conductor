## 2026-11-19 -- Installer: the stop on a removal waiting for the restart reads the "*1\??\" form

Plan 2.1.3-beta.9, the pre-publish VM smoke of the release PR (#728; aicc_planning #328, route 2).

- What the smoke found (Windows 11 build 22621). After an elevated silent
  all-users uninstall left files to be removed at the next restart, a silent
  all-users install into the same folder, still before the restart, exited 0
  and installed everything, where it should have exited 2 with nothing
  installed. At the restart Windows then removed 8 files of the new copy.
- Cause. That Windows wrote every PendingFileRenameOperations entry with a
  "*1" in front of its "\??\" ("*1\??\C:\Program Files\AI Code Conductor\..."):
  all 14 entries of the folder, in the 32-bit and 64-bit registry views alike,
  and older entries of an NSIS temp folder too. CccPendingRemovalIn took off
  only a leading "!" and a leading "\??\", so no entry in that form ever
  matched. The makensis probes' stand-in entries were all the plain form, so
  CI never saw it.
- Fix. Before an entry is compared, every leading "!" and every leading "*"
  with the digits after it are taken off, in either order, then one "\??\".
  What the "*1" means is not known; the comment says only that Windows 11 was
  seen to write it. Where a rename's "!" goes in that form was not seen, which
  is why either order is read. The plain and "!" forms read as before.
  customCheckAppRunning and customInit's elevated block both reach the list
  only through CccStopOnPendingRemoval, so both get the fix; nothing else in
  the installer reads the list.
- Tests. The probes now run entries in the seen form (a file in the install
  folder, the folder itself, a longer number after the "*", a rename into the
  folder with its "!" on either side of the "*1"), which must stop the run;
  the same form for other folders, a folder whose name only starts the same,
  and a per-user install must not. Seen failing on the old macro in CI run
  44468178846 (Test part 2 of 4, windows-2025: the new stop case, at its
  first entry, went on to the app check) before the fix was pushed.
  installer-branding-guard pins the strip line for line.
