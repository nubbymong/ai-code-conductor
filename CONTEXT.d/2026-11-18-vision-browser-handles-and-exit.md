## 2026-11-18 -- The vision browser starts without the app's open handles, and ends on every way the app exits

Plan 2.1.3-beta.8, section C2.

- **A start mode in the helper (Windows).** `aicc-helper start [--hide] --cwd <folder> -- <program>
  [args...]` (helper/src/start.rs; protocol section 15, "Starting a program"; threat model 3.13)
  starts one program by the drive-absolute path given, with handle inheritance off and no
  standard handles, prints `{"pid":<n>,"created":"<t>"}` and exits without waiting. The program
  is created suspended, its creation time is read from the process handle the start returned,
  and only then does it run, so an error always means nothing ran. `created` is the form the
  app's verified end checks (`Win32_Process.CreationDate.ToFileTimeUtc()`, to the microsecond).
  It refuses a relative or bare name, a share, a batch file, and a name Windows would open as
  another (the holder's own checks, plus a trailing dot or space); on macOS and Linux it
  refuses. The process start is the holder's own code, moved from detach.rs into winproc.rs
  (`create_process`) so both share it. A handle list is for a start that passes a handle on;
  this one passes none, so inheritance is simply off.
- **An end mode beside it (Windows).** `aicc-helper end --pid <n> --created <t>` (protocol 15,
  "Ending a program it started") ends that process and the processes under it only while the
  pid has that creation time, holding the process open from the check to the end, and prints
  `ended` or `left`. A process counts as under its parent only when it was made between the
  parent and the read of the process list (the system time is read just before that read, and a
  listed pid can pass to a new process only after it), so a listed pid that passes to a new
  process before it is opened is not ended. It reads the process list itself (no PowerShell, no
  WMI), so it answers in milliseconds. The review found the first design's quit-time end (a
  PowerShell CIM query on the main thread, bounded at 5 s) too slow for an exit, and able to
  time out and leave the browser running on a busy machine; this replaces it.
- **The vision browser through them.** On Windows, when the installed helper is there
  (resources/helper) and the browser was found at a full path, vision-manager.ts starts the
  browser through the start mode (execFile, hidden, 10 s), in the browser's own folder, with its
  arguments unchanged. It is tracked by the pid and creation time the helper printed and ended
  only by both: through the helper's end mode, synchronously at quit and on the two hard exits,
  awaited at a stop and a relaunch; the PowerShell end only when the helper has gone. A pid no
  process has costs nothing. An end that cannot tell is logged and keeps the browser tracked
  (after a stop, until the quit; at a relaunch the next start replaces it, and the scan by
  profile before that start ends it). Two seconds after a start, one look logs a browser that
  has already exited and stops tracking it. Without the helper, after a start that started
  nothing (the helper exited 1 or 2, Windows could not load it, such as without the Visual C++
  runtime, or it could not be run), or with a browser found only by its bare name, the launch
  is the spawn it was, with one log line. A start that may have started
  the browser without saying so (a timeout, a crash, an answer that cannot be read) is not
  followed by a second start: the launch fails with one log line. macOS and Linux are unchanged.
- **Every way the app exits.** src/main/hard-exit.ts holds what the two `app.exit` paths that
  skip the quit teardown run first: the update install and SIGTERM. Today that is ending the
  vision browser (`killSpawnedBrowser`, synchronous and idempotent). The update install calls it
  just before `app.exit(0)`, once the installer has started. The SIGTERM handler's body moved
  into `exitOnSigterm` (flush the sessions, flush the indexing gaps, the teardown, exit), which
  index.ts calls; a step that throws is logged and no longer skips the exit. The two other
  `app.exit` calls need none of it: the start-up failure to register providers comes before
  vision starts, and the session helper's quit hold comes after the quit teardown has run.
  quitTeardown is unchanged.
- **Not changed.** The browser's arguments and profile folder, the scan for a browser left from
  an earlier run, the update installer's own start, and the sign-in browser.
- **Tests.** helper/tests/start.rs (Windows: a pipe end the helper is given is closed while the
  started program runs, with a control child that keeps it open; the printed line names the
  program and the creation time Win32_Process reports, over 8 starts; `end` leaves a process
  under another creation time and ends it under its own, and ends the process under it too;
  refusals). New tests/unit/main/vision-manager-start-mode.test.ts and
  tests/unit/main/hard-exit.test.ts; tests/unit/main/vision-browser-owner.test.ts covers
  `endVerifiedSync` and the helper-backed ends directly; tests/unit/main/update-handlers.test.ts
  checks the end comes just before `app.exit` on the install path.
  tests/unit/main/spawn-site-inventory.json lists the new start site.
- **Owed.** The VM check at the release smoke. ADR-009 pass before stable (aicc_planning #320
  list): process creation and process ending in the helper, and the updater's exit path.
