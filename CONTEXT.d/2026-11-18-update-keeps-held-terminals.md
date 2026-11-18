## 2026-11-18 -- An app update on Windows keeps held plain and partner terminals running (2.1.3-beta.8 section B2)

**Why.** With "Plain terminals through the session helper" on, the only
thing that ended a held terminal at an app update was the app itself:
`killAllPty()` in the install path (`update-handlers.ts`) sent every holder
`term.end`. The installer never touches a holder (it closes only the app's
own image names, and an update keeps the per-user helper folder), and
`app.exit(0)` skips the normal quit, so the running mark already stayed and
the next start already took the crash path. Probe P7 saw a holder survive
the app's exit and a silent install.

**What changed.**
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
  written again with `reason: "update"`. Nothing new goes through the helper
  until `reclaim()`, so a tab started again in the few seconds before the
  exit cannot end the holder it let go of (a new hold ends a leftover record
  of its session id first). Off Windows it does nothing.
- `helper-pty.ts release()`: closes the connection with no `term.end`, so the
  holder's away clock starts (2 minutes, Q9; the app passes no `--away`).
  After it, `kill()` sends nothing and reports the exit locally, so
  pty-manager drops the entry as for any ended PTY. A reconnect or attach in
  flight closes its new connection instead of attaching.
- A terminal Re-attach moved to a new tab keeps its binding through the
  release (the binding was dropped when the terminal ended), so the next
  start shows it in that tab.
- `reclaim()`: what was let go of is kept for its tab, exactly as the crash
  path keeps it (adoptable, and a keeper attached), listed on the Machines
  page; the mark loses its reason. Its tab's terminal already read as ended,
  so Re-attach opens a new Terminal only tab on it rather than bringing that
  tab forward (the tab started again takes it over too). A later update
  attempt ends what reclaim kept unless its tab is saved (a retry with
  "Close sessions").
- PR review: a normal quit that overtakes the update (after the release)
  ends what was let go of, inside the quit's bounded wait; the start-up
  listing never treats a released terminal as one a quit left (it would have
  ended it) or as one a crash left (it would have kept it). The ends a
  "Close sessions" retry sends are waited for (1.5 s at most, the quit's
  own bound) before every PTY is killed, so the app does not exit first.
  Re-attach into a new tab moves the binding: a tab an earlier Re-attach
  bound to the same terminal gets one of its own if it starts again, and can
  no longer take it over or end it. A tab whose shell runs under an id
  derived from where its first terminal went keeps that id as a binding, so
  a later move does not cost it its shell. While an update goes on, nothing
  is taken over either: the kill would end it. sidFor derives again while
  the id it derived is bound to another tab (a moved terminal whose
  replacement was moved too). Only the terminal that still holds an id lets
  go of its binding when it ends (a quick Restart keeps the new one's).
  Re-attach is refused while an update goes on, also when one began while
  its listing ran.
- At the next start a mark with reason "update" takes the crash path
  unchanged; only the log line says the app was updated.
- Settings: one sentence in the plain-terminal switch's note.

**Premise that did not hold.** The plan said "Close without saving" clears
the saved state the manager knows of. It does not: with no remote left
running, it calls `session:clear` (index.ts), which does not reach
`noteSavedTabs`, so the manager kept the tabs of the last autosave. B2 may
not touch index.ts, so `app-wiring.ts` reads the saved file itself
(`peekSessionState`, read only; null after a clear) and the manager lets go
of a terminal only when its tab is in both. A file that does not read lets
go of nothing.

**Not changed.** The installer, its arguments and the electron-builder
config; the away clock; the normal quit; the crash path; pty-manager.ts;
any IPC channel or preload API. Claude Code and Codex sessions still end at
an update and resume their conversation (scope OUT).

**Tests.** `update-handlers.test.ts` (order on Windows, none on macOS and
Linux, the reclaim on a failed launch), `session-helper-manager.test.ts`
(the fake holder: no end for the saved plain and partner terminals, an end
for an unsaved one and for a Claude session, the mark, the reclaim and
Machines listing, the cleared file, a terminal still starting, off Windows,
the Re-attach binding), `session-helper-flow.test.ts` (the whole round over
two managers with the fake helper's away clock, within and past 2 minutes),
`session-helper-app-wiring.test.ts` (both exports do nothing with no
manager). The fake holder gained an away clock, off unless a test sets one.
Six mutants each turned a test red.

**Owed before stable.** ADR-009 pass (aicc_planning #320 list): the release
ordering, a launch failure, a discarded state, a holder pid reused while
released.
