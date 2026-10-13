## 2026-10-11 -- quitting the app stops the Claude Code setup terminal (2.1.1-beta.3)

- **Problem:** the first-run Claude Code setup terminal (`cliSetupPty` in
  `src/main/ipc/setup-handlers.ts`) is main's own, outside pty-manager, so
  `killAllPty` in the quit teardown never reached it. Only the setup screen's
  own ways out (Skip for now, Finish, Exit, and the strip's Close, which runs
  Exit) stopped it, through `setup:killCliSetup`. Alt+F4, the taskbar close and
  Cmd+Q went to the quit without that stop and left the terminal to process
  exit; on macOS the red button left it running behind the Dock icon, where it
  still counted as Claude Code in use. Raised by the
  takeover-window-controls change.
- **Fix:** `killCliSetupPty()` exported from setup-handlers: it bumps the start
  counter (a start still in its first-start warm-up, ADR-025, then starts
  nothing), kills a running terminal once, and drops it. Safe with none
  running and safe twice. `setup:killCliSetup` now calls it (same behaviour as
  before). `src/main/index.ts` calls it in the quit teardown just before
  `killAllPty()`, and in the macOS `window-all-closed` sweep just before
  `killAllPty` (the order is explained below). No new IPC channel,
  no preload change.
- **Scope:** the stop runs on the paths that go through the app's
  `before-quit` teardown (Alt+F4, the taskbar, Quit, Cmd+Q) and the macOS
  sweep. SIGTERM, a crash and the exit that installs an update
  (`ipc/update-handlers.ts`: `killAllPty`, then `app.exit`) do not pass
  `before-quit`, so the stop does not run there, and the setup terminal is
  left to process exit as before.
- **Order and slot:** the stop runs just before `killAllPty()`
  in the teardown and in the sweep, so a throw in `killAllPty` cannot skip it
  (the stop itself cannot throw). And a setup terminal's exit drops it from
  the slot only while the slot still holds that terminal: before, an earlier
  terminal's late exit (node-pty reports it after the kill) cleared the slot
  even when a newer terminal was in it, and the stop could then not reach the
  newer one. The sweep made that sequence possible in theory on macOS (red
  button, Dock reopen, a new setup terminal before the old exit lands).
- **Left for a ticket (not reachable in normal
  use, no change here):** a new start assigns over a terminal that is still
  running instead of ending it first (the setup terminal screen has no Back
  or Restart, so the renderer never asks twice); a replaced terminal's own
  output, exit and 500 ms `claude` keystroke still go to the shared
  `__cli_setup__` channel and the current slot; and the start number is taken
  after the lazy `provider-launch-gate` import, so a stop during that import
  would not cancel the start (the module is already loaded, so the import
  settles before a quit can run).
- **ADR-009:** touches `src/main/ipc/**`, so the ADR-009 security review
  covers it.
- **Tests:** `tests/unit/main/setup-terminal-quit-teardown.test.ts` cuts the
  quit teardown and the window-all-closed callback out of index.ts (as
  app-lifecycle-wiring does) and runs them against the real kill on the real
  setup-handlers module (PTY faked). `app-lifecycle-wiring.test.ts` now checks
  the sweep calls both kills. The cases of a throwing `killAllPty` in the
  teardown and in the sweep, and of an earlier terminal's late exit, fail
  against the first version of this change. `tests/wp1/claude-characterization.test.ts` also drives
  `setup:killCliSetup` and runs on CI and the VM only (host quarantine).
- **Owed on the VM:** on the Claude Code setup screen (CLI installed, setup
  terminal running) close the app with Alt+F4, and again from the taskbar:
  no setup terminal process is left behind (no orphan claude or conhost
  child). macOS: the red button on that screen, then Activity Monitor shows no
  claude child of the app while it stays in the Dock.
