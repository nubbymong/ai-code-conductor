## 2026-11-18 -- The vision browser starts without the app's open handles, and ends on every way the app exits

Plan 2.1.3-beta.8, section C2.

- **A start mode in the helper (Windows).** `aicc-helper start [--hide] --cwd <folder> -- <program>
  [args...]` (helper/src/start.rs; protocol section 15, "Starting a program"; threat model 3.13)
  starts one program by the absolute path given, with handle inheritance off and no standard
  handles, prints `{"pid":<n>,"created":"<t>"}` and exits without waiting. `created` is the form
  the app's verified end checks (`Win32_Process.CreationDate.ToFileTimeUtc()`, to the
  microsecond), read from the process handle the start returned. It refuses a relative or bare
  name, a batch file, and a name Windows would open as another (the holder's own checks, plus a
  trailing dot or space); on macOS and Linux it refuses. The process start is the holder's own
  code, moved from detach.rs into winproc.rs (`create_process`) so both share it. A handle list
  is for a start that passes a handle on; this one passes none, so inheritance is simply off.
- **The vision browser through it.** On Windows, when the installed helper is there
  (resources/helper) and the browser was found at a full path, vision-manager.ts starts the
  browser through that mode (execFile, hidden, 10 s), in the browser's own folder, with its
  arguments unchanged. It is then tracked by the pid and creation time the helper printed, and
  every end checks both at that moment: the awaited `endVerified` at a relaunch and a stop, and
  the new synchronous `endVerifiedSync` at quit and on a hard exit. It is never ended by its pid
  alone. A stop keeps the browser tracked until its check answers, so a quit that comes first
  still ends it. Without the helper, after a failed start, or with a browser found only by its
  bare name, the launch is the spawn it was, with one log line. macOS and Linux are unchanged.
- **Every way the app exits.** src/main/hard-exit.ts holds what every `app.exit` path runs
  first; today that is ending the vision browser (`killSpawnedBrowser`, synchronous and
  idempotent). The update install calls it just before `app.exit(0)`, once the installer has
  started. The SIGTERM handler's body moved into `exitOnSigterm` (flush the sessions, flush the
  indexing gaps, the teardown, exit), which index.ts calls; a step that throws no longer skips
  the exit. quitTeardown is unchanged.
- **Not changed.** The browser's arguments and profile folder, the scan for a browser left from
  an earlier run, the update installer's own start, and the sign-in browser.
- **Tests.** helper/tests/start.rs (Windows: a pipe end the helper is given is closed while the
  started program runs, with a control child that keeps it open; the printed line names the
  program and the creation time Win32_Process reports; refusals). New
  tests/unit/main/vision-manager-start-mode.test.ts and tests/unit/main/hard-exit.test.ts;
  tests/unit/main/update-handlers.test.ts checks the end comes just before `app.exit` on the
  install path. tests/unit/main/spawn-site-inventory.json lists the new start site.
- **Owed.** The VM check at the release smoke. ADR-009 pass before stable (aicc_planning #320
  list): process creation in the helper, and the updater's exit path.
