## 2026-11-23 -- Installer: the helper clean-up ends a listed process only while it is still that process

Section B2 of the 2.1.3-beta.16 plan (aicc_planning #400). In `build/installer.nsh`.

- **#400, the helper clean-up (uninstaller pass).** `CccEndUserHelpers` lists each `aicc-helper.exe`
  of this user and what it started (`CccScanProcesses`, up to 8 passes), then ends the list
  (`CccEndListed`). Before, `CccEndListed` reopened each listed pid and checked only that it was
  this user's, so a listed process that ended in between, whose pid Windows had given to another
  process of the same user, would have ended that process instead. Windows reuses a freed pid
  within seconds (measured on the CI runner for beta.15, `2026-11-23-windows-worker-crash-pid-reuse.md`).
  Now the scan lists each process as `pid:start` (its creation time, `CccProcessStart`), and
  `CccEndListed` opens each pid with PROCESS_TERMINATE and PROCESS_QUERY_LIMITED_INFORMATION, holds
  that handle while it checks the user and reads the start through it, and ends the process only
  when the start is the listed one. Another start, or a start that could not be read, ends nothing:
  the process listed is already gone. The app-running check (`CccCloseAppCopies`) already worked
  this way. MODE 1's two "is it in the list" checks read the new list through `CccInPairList`.
- **Tests.** `installer-branding-guard.test.ts` (static, host): `CccEndListed`'s whole body, the
  scan's `pid:start` entries and `CccInPairList`. `installer-nsis-behaviour.test.ts` (Windows CI
  and VM only): a probe of its own runs the real `CccEndListed` over a running stand-in listed with
  a later start (not ended), with no start (not ended), then with its own start (ended). The
  existing helper-ending cases (the helper and what it started) cover the whole chain.
- **Owed.** The VM line on B2's frozen head (an uninstall with a held tab ends the helper and its
  children). ADR-009 pass before stable: installer code that ends processes.
