## 2026-11-18 -- Installer: reasons, what an uninstall left, the elevated check; console hosts a killed app left

Plan 2.1.3-beta.9 section C4 (aicc_planning #328, #327, #330).

- #328, the reason. When the app check's end of a copy fails, the details line
  says why (CccWhyNotEnded): it had already exited (its exit code leaves
  STILL_ACTIVE within about half a second; Windows refuses to end a process
  whose own exit is under way), access was denied, or the Windows error number.
  The bare "Could not end process N." is gone.
- #328, what is left. A new customRemoveFiles (uninstaller pass only) runs
  electron-builder's own removal unchanged, held line for line to
  app-builder-lib 26.15.3's uninstaller.nsh by installer-branding-guard.test.ts,
  then CccReportLeftFiles names each file left (at most 50, then a count; a
  link is named, never entered). On an all-users uninstall that is not an
  update, with the folder inside Program Files, the rest is set to go at the
  next restart (RMDir /r /REBOOTOK) and the details say so. Decisions beyond
  the plan's text: not on an update (the new files go into the same folder);
  not outside Program Files (only administrators can write there, so no link
  can be put in the folder's place before the restart); the reboot flag is
  cleared again, so nobody is asked to restart while another user may be using
  the app; the line asks for a restart before installing into the same folder
  again, since a removal set for the restart would also take files installed
  there meanwhile.
- #327. customInit's elevated inner instance (which installSection.nsh never
  gives CHECK_APP_RUNNING) runs the same check and boxes as
  customCheckAppRunning, after the retarget and the suspend, with the
  all-users record's folder as the replaced install's; a stop puts both back.
  The commit point does not move. Owner test only (UAC over SSH cannot run).
- #330. C1 measured the cause on the VM (a whole-app kill left the Claude Code
  tab's system ConPTY host, parent the old main process, 4 of 11 kills). At
  start-up the app runs the session helper's new console-hosts mode once with
  the record of the run before (app-run.json: pid and creation time), and
  records itself from the answer; a clean quit removes the record. The helper
  ends only conhost.exe (System32's) or OpenConsole.exe processes of its own
  user, listed with that pid as parent, made after that run started and before
  both its own start and that of any process that has the pid now; nothing
  while that pid still has its creation time, or for a record from before the
  last boot. OpenConsole.exe (the bundled ConPTY) was not measured: same rule,
  owner test step.
- Tests: installer-branding-guard.test.ts (static, 9 new or changed cases),
  installer-nsis-behaviour.test.ts (makensis probes, Windows CI: the three
  reasons, and the removal report on six folder cases),
  console-host-leftovers.test.ts, helper/tests/console_hosts.rs and the unit
  tests in helper/src/consoles.rs.
- Owed: the VM routes at the release smoke (#328 route 2 and route 1; #330
  with C1's kill steps). ADR-009 pass before stable for the #330 part (a new
  helper mode that ends processes): attack the identity of the run before and
  pid reuse.
