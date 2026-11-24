## 2026-11-24 -- A start sweeps the Codex pick folders a kill left in TEMP; the previous Snap's page closes after its press

Plan 2.1.3-beta.17, section C4 (aicc_planning#407 and #408), at origin/beta e10278e7.

- **#407, the premise read.** Each Codex launch through the resume list makes a `ccc-codex-pick-`
  folder in the temp folder (providers/codex/spawn.ts, the builder) that only the session's watcher
  removes, at the session's end (telemetry.ts, `stop`). A kill, a crash or a quiet uninstall leaves
  it for good; the hook folders have a start-up sweep (hooks.ts sweepStaleCodexHookFolders), the
  pick folders had none.
- **The sweep** (spawn.ts sweepStaleCodexPickFolders, run by the Codex provider's
  `sweepLeftoverPickFolders` from src/main/index.ts beside the other start-up sweeps, before any tab
  can start). Only a folder directly in the temp folder with the launch's prefix, a real folder
  (never a link or junction, read again right before anything in it is removed), this user's where
  the platform keeps owners, a day old or more (the hook folders' bound), and empty or holding only
  `pick.json` and its staging files: each file removed by name, then the folder, never recursively.
  Anything else in it keeps the folder whole. One log line when any went.
- **A running session's folder is never taken.** Its watcher sets the folder's time to now every
  hour (telemetry.ts PICK_FOLDER_TOUCH_MS), so it is never a day old. It matters because the temp
  folder is shared by every copy of the app the user runs (a dev build beside the installed one),
  and the list writes a second decision into it whenever a resumed conversation exits non-zero
  (scripts/codex-resume-picker.js, the fallback), at any point in the session's life.
- **A session an update kept running** has no pick folder left at the next start: the release's kill
  runs the watcher's `stop` for it as for any session (sessions/launch-bindings.ts
  unbindLaunchTelemetry), which removes the folder, and its kept record names none
  (session-helper/manager.ts KeptRecord). B1's branch (3169ddb0) changes neither. So the sweep has
  no kept folder to pass by.
- **Not covered:** an uninstall with no later start (no start runs the sweep). #407 stays open for
  the uninstaller's half.
- **#408, the previous Snap's page.** electron-screenshots 0.6.2 makes its page (a BrowserView) in
  its constructor and never closes it; its end of a capture destroys only the overlay window; its
  constructor's main-process listeners are never removed. The page now closes once its press has
  settled: at once when no overlay is left, else on the package's `windowClosed` (its own end still
  talks to the page until then); a press that took the package up meanwhile keeps it. The package's
  five main-process channels are cleared with it, so the next press's new package is the only one
  answering. No log line: snap-e2e D8 reads one previous-engine line per press.
- **The npm view process (#408's second half), no code.** The app runs
  `npm view @anthropic-ai/claude-code versions --json` in one place (legacy-version-manager.ts, with
  a 15 s timeout), and CI's upstream watch `npm view <package> version`; neither is the
  `@latest version --prefer-online` form #408 saw, so it is probably Claude Code's own. The VM
  line's trace of its parent and command line decides.
- **Tests.** `tests/unit/providers/codex/pick-folder-sweep.test.ts` (9, host-safe; a folder the fs
  stand-in reads as a link stands in for one; a stand-in for this process's user id checks the
  owner on every platform), `pick-folder-sweep-links.test.ts` (1, HOST QUARANTINE: a planted
  junction, CI only), `tests/unit/main/screenshot-previous-snap-page.test.ts` (4). Red against
  e10278e7: all 13 host-safe ones. Mutants, each red: the age bound dropped (2), the content check
  dropped (1), the link check dropped (1), the owner check dropped (1), the hourly mark dropped
  (1), the page closed without waiting for the overlay (2), the in-use guard dropped (1).
  `tests/unit/main/snap/previous-snap-lazy-load.test.ts` (9) is updated to the new behaviour: a
  second press makes the package again (its page was closed once the first press settled) and does
  not load its files again (`constructed: 2`, red against e10278e7's screenshot-capture.ts, which
  kept the package); its electron stand-in gains `ipcMain`, as the two sibling files did.
- **Not checked here:** a real folder of another user's (needs a second account); the owner check
  runs against a stand-in for this process's user id. The planted link (CI only, first run on the
  aggregate PR); a real press's time with the page made at every press (snap-e2e's previous-Snap
  readings, and the VM line).
