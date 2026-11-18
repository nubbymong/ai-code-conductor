## 2026-11-18 -- An app update on Windows keeps held plain and partner terminals running (2.1.3-beta.8 section B2)

**Why.** With "Plain terminals through the session helper" on, the only
thing that ended a held terminal at an app update was the app itself:
`killAllPty()` in the install path (`update-handlers.ts`) sent every holder
`term.end`. The installer never touches a holder (it closes only the app's
own image names, and an update keeps the per-user helper folder), and
`app.exit(0)` skips the normal quit, so the running mark already stayed and
the next start already took the crash path. Probe P7 saw a holder survive
the app's exit and a silent install.

**What changed (section B2 as planned).**
- `update-handlers.ts`, Windows only: `releaseHeldTerminalsForUpdate()` runs
  just before `killAllPty()`. A release that throws stops nothing: what it
  did not let go of ends with the kill, as before. When the installer then
  fails to start, `reclaimReleasedTerminals()` runs before the error box.
  macOS and Linux call neither and end every held terminal as before.
- `manager.ts releaseForUpdate(restorable)`: each plain or partner terminal
  through a holder that has been attached, whose tab (a partner's is its
  session's) is in the app's last save AND in the saved file the next start
  restores from, is let go of. Agent sessions, a terminal still starting,
  and one whose tab is not saved are left to the kill. The running mark is
  written again with `reason: "update"`. Off Windows it does nothing.
- `helper-pty.ts release()`: closes the connection with no `term.end`, so the
  holder's away clock starts (2 minutes, Q9; the app passes no `--away`).
  After it, `kill()` sends nothing and reports the exit locally, so
  pty-manager drops the entry as for any ended PTY. A reconnect or attach
  in flight closes its new connection instead of attaching, and one that
  fails does not end the holder.
- `reclaim()`: what was let go of is kept for its tab, exactly as the crash
  path keeps it (adoptable, and a keeper attached), listed on the Machines
  page; the mark loses its reason.
- At the next start a mark with reason "update" takes the crash path; only
  the log line says the app was updated.
- Settings: one sentence in the plain-terminal switch's note.

**Declared deviations from section B2.** The plan says the normal quit and
the crash path do not change and nothing extra is added. These were added
in review rounds (Copilot threads 1 to 11, then the frozen-head review).
The orchestrator accepts them or has the last group split out:
1. The normal quit (`shutdown`): unchanged unless an update let terminals
   go. A quit that overtakes the update after the release ends them too
   (they are no longer in the run's own list, so the quit's own loop would
   miss them). Q9: a normal quit still ends them.
2. The start-up listing (`bringUp`), both branches: unchanged unless an
   update let terminals go. A listing that answers after the release skips
   them: the normal branch would end them, the crash branch would keep them.
3. While an update goes on (release to exit, or to `reclaim()`): nothing new
   goes through the helper, nothing kept is taken over, and Re-attach is
   refused with a new Machines sentence ("The app is being updated.
   Re-attach the terminal once the new version has opened."). A new hold
   ends any leftover record of its session id first, and a take-over in
   the wait before the kill would be killed with `term.end`.
4. `app-wiring.ts`: the release waits for the ends it sent, 1.5 s at most
   (the quit's own bound), so the app does not exit first. It also reads
   the saved file itself (premise 1 below), so the export is not thin.
5. Kept and not taken over (a crash's, Re-attach's or an earlier
   `reclaim()`'s): an update ends it unless its tab is saved, since the
   kill does not reach it and "Close sessions" must leave nothing held
   (acceptance case 6b). Before B2 such a terminal ran on past every update.
6. Re-attach, on every platform (macOS and Linux too, where nothing is
   released): Re-attach of a reclaimed terminal opens a new Terminal only
   tab (its own tab's terminal read as ended) and moves the binding; a tab
   whose shell runs under an id derived from where its first terminal went
   keeps that id as a binding; `sidFor` derives again while the id is bound
   to another tab, at most one try more than there are bindings, so it never
   answers an id another tab holds; only the terminal that still holds an id
   drops its binding when it ends (a quick Restart keeps the new one's); a
   released terminal keeps its binding. The first two follow from the
   reclaim; the rest are older Re-attach and Restart faults the move made
   reachable within one failed update.

**Premises that did not hold.**
- The plan said "Close without saving" clears the saved state the manager
  knows of. It does not: with no remote left running, it calls
  `session:clear` (index.ts), which does not reach `noteSavedTabs`, so the
  manager kept the tabs of the last autosave. B2 may not touch index.ts, so
  `app-wiring.ts` reads the saved file itself (`peekSessionState`, read
  only; null after a clear) and the manager lets go of a terminal only when
  its tab is in both. A file that does not read lets go of nothing.
- The plan said the old helper's version folder is kept while a listed
  holder runs it. `removeOldVersionFolders` (install.ts) keys on the version
  string, and the manager leaves the current version out of the keep-set,
  so a holder of a different build with the same version string has its
  folder removal tried while it runs: the lock on its running exe stops it,
  and a file in that folder it is not using can go first. Seen on the VM
  (beta.7 and N both report helper 0.1.0). Older code, not changed here; an
  aicc_planning ticket is owed (filed by the orchestrator).

**Not changed.** The installer, its arguments and the electron-builder
config; the away clock; pty-manager.ts; any IPC channel or preload API. The
normal quit and the crash path as declared above. Claude Code and Codex
sessions still end at an update and resume their conversation (scope OUT).

**Tests.** `update-handlers.test.ts` (order on Windows, none on macOS and
Linux, the reclaim on a failed launch), `session-helper-manager.test.ts`
(the fake holder: release, kill, reclaim, Machines, Re-attach, the quit and
the listings after a release, kept terminals ended at an update, the id
rules), `session-helper-flow.test.ts` (the whole round over two managers
with the fake helper's away clock, within and past 2 minutes; release while
a terminal attaches again, four races), `session-helper-app-wiring.test.ts`
(no manager: both do nothing; the saved file; the bounded wait). The fake
holder gained an away clock, off unless a test sets one.

**Mutants.** 27, each run alone on the final head through the locked runner
on the named test files, each turned at least one test red. The PR body
lists every red test by name. M1 an unsaved tab released: 4 manager tests.
M2 agent sessions released: 3 manager. M3 release on macOS and Linux in the
install path: the 2 update-handlers guards. M3b no Windows guard in the
manager: the off-Windows test. M4 release() lets go of nothing: 14 (manager
and flow). M5 a released terminal's binding dropped: 2 manager. M6 no
reclaim on a failed launch: 1 update-handlers. M7 release not awaited: 3
update-handlers. M8 unbounded wait: 1 app-wiring. M9 no binding move: 2
manager. M10 endsForUpdate at once: 2 manager. M11 take-over during an
update: 1 manager. M12 no pinned derived id: 2 manager. M13 one-level
sidFor: 3 manager. M13b sidFor's old depth of 16: the deep-chain test. M14
old ended handler: the Restart test. M15 no second updating check: the
Re-attach-during-update test. M16 quit misses released: the quit test. M17
normal listing ends released: its listing test. M18 crash listing keeps
released: its listing test. M19 reclaimed Re-attach to its own tab: 2
manager. M20 only reclaimed ended at an update: the crash-kept test.
M21 to M24 the four HelperPty race guards (reconnect, giveUp, attach's
catch, after attach's reply): one flow test each. M25 no "update" reason:
3 (manager and flow).

**Owed before stable.** ADR-009 pass (aicc_planning #320 list): the release
ordering, a launch failure, a discarded state, a holder pid reused while
released, and the update's ends of kept terminals.
