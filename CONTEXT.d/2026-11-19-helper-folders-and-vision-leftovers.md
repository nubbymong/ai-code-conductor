## 2026-11-19 -- Start-up keeps the helper folder a held terminal runs from, and ends the vision browser the last run left

Plan 2.1.3-beta.9, section C2 (#322, #329; #326 not built).

- **#322, the helper folders.** A holder's record names its helper version, not its folder, and
  the helper version is not bumped with every change, so after an update a held terminal can run
  from another build of the version the new app runs. Start-up used to drop the current version
  from the versions it keeps (session-helper/manager.ts), so that build's folder was removed (or,
  on Windows, tried and refused while the holder ran). It now passes every version a listed or
  live holder reports, the current one included, and removeOldVersionFolders keeps every folder
  of those versions; staging folders and unlisted versions still go. A spare folder of a kept
  version goes at a later start, once no holder reports that version. The keep-by-version code in
  install.ts was already right when given the version; the fault was only the caller's filter.
- **#329, the reason.** An end of a browser the helper started that cannot tell now says why:
  no answer within its bound, the exit status (in hex for a Windows status), or the signal, then
  the first 200 characters of its standard error made safe for a log line (stripSpoofableText).
  The end functions answer `{ answer, reason }` (EndResult); the awaited and synchronous runners
  now read standard error so a failure carries it.
- **#329, the record.** When the helper starts the vision browser, its pid and creation time go
  to `vision-started.json` in the user data folder (atomic write); a dev or E2E run uses its own
  data root instead, since a dev run shares the user data folder with an installed app on the same
  computer and must never end that app's browser (found in the PR's review). An end that answers `ended` or
  `left` removes it, unless it names a later browser by then; one that cannot tell keeps it. At
  start-up (index.ts, beside the legacy-marker clean-up) and before each launch's scan by profile,
  the recorded browser is ended through the helper's end mode alone, by that pid and creation
  time: never by pid alone, no PowerShell, no WMI. A record that is not a plain file of at most
  256 bytes holding exactly a pid and a creation time of digits is removed and ends nothing. The
  start-up end and a launch's share one run.
- **#329, the cause (C1, measured on the VM as a user without WMI access).** The helper's end mode
  works for that user (ended, in 14 to 17 ms, 6 of 6 rounds). The quit failed only when the
  helper beside the app was missing (an all-users uninstall can remove it while another user's
  copy runs): the end then fell back to the PowerShell end, which asks WMI, waited about 5 s on
  the main process, answered unknown and left the browser running. Now the end uses the helper
  beside the app, else the per-user copy the session helper put in place and checked this run
  (install.ts checkedHelperCopySync, its SHA-256 read again first). With neither, the quit runs
  nothing and answers at once, and the record lets the next start end the browser. The awaited
  PowerShell end stays only for a stop and a relaunch, which hold nothing up.
- **#326 not built.** C1 found no browser child still running 5 s after the root was ended from
  outside (0 of 14, 3 of 3 runs; none already at 0.5 s), so the end mode is unchanged.
- **Docs.** Protocol section 15 ("Ending a program it started") and threat model 3.13 each gain
  what the record is and where the end mode runs from.
- **Tests.** session-helper-install (keep by version, the checked copy), session-helper-manager
  (start-up keeps the other build's folder a listed holder's version names), vision-browser-owner
  (reasons, the end through the helper alone, the runners' standard error), and
  vision-manager-start-mode (the record written, removed and kept; the start-up end; pid reuse; a
  record that does not read; the copy used when the helper beside the app is gone; nothing run
  with neither). The spawn-site inventory's two reasons for the ownership checks name the copy.
- **Owed.** VM checks at the release smoke (#329 as the user without WMI access; #322 through the
  update from beta.8 with a held plain terminal). An ADR-009 pass before stable for the record a
  next start acts on: a planted or stale record, pid reuse, and the helper path.
