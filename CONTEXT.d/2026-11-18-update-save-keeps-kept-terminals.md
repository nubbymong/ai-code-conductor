## 2026-11-18 -- With Save, a terminal kept after a crash keeps running through an update (2.1.3-beta.8 section B3)

**Why.** B2 (#713) added declared deviation 5: at an update on Windows,
every held plain terminal kept for a tab that no tab took over (a crash's,
Re-attach's or an earlier `reclaim()`'s) was ended unless its tab was
saved. That served "Close sessions" (acceptance case 6b), but it also
changed Save: a terminal kept after a crash whose tab is not saved (the
resume prompt declined, listed on the Machines page) closed at the update.
Before B2 it ran on past every update and the next start kept it again.

**What changed.**
- `manager.ts releaseForUpdate(restorable)`: `restorable` is now `null`
  when the user discarded the saved sessions. Then each kept, not-live
  plain terminal is ended, as B2 did (case 6b). Otherwise (Save, even with
  no tab saved, or a saved file that did not read) it is neither let go of
  nor ended: it runs on past the exit, the log says so, and the next start
  (the "update" mark takes the crash path) keeps it again and lists it on
  the Machines page. Which terminals are let go of is unchanged.
- `app-wiring.ts`: the user's choice is passed as it is. A cleared file
  (`peekSessionState` answers null) is `null`; a file with tabs or with
  none is the set of its tab ids; a file that does not read is an empty
  set (nothing let go of, kept terminals run on: the pre-B2 behaviour).
  The choice is never read from an empty set.

**Premises that did not hold** (reported to the orchestrator, not changed):
- "Close sessions" does not always clear the saved file. With a remote
  left running, `persistDetachedOnlyOrClear` (session-persistence.ts)
  writes a file with no sessions and the left-running list instead, so
  `peekSessionState` answers that file, not null. The update then reads it
  as Save, and a kept terminal no tab shows runs on (as before B2; B2 ended
  it through the empty set).
- An update with no tab open skips the close dialog (App.tsx
  `handleUpdateRequested`), so no choice is made at the update. If the
  resume prompt's "Don't open" cleared the file earlier in the run (no
  remote left running) and no tab was opened since, the update reads it as
  a discard and a kept terminal no tab shows is ended, as B2 does now.
- Telling these apart needs the renderer to pass the choice with
  `update.installAndRestart` (preload, App.tsx, session-persistence.ts,
  update-handlers.ts), outside this section's files.

**Not changed.** Which terminals are let go of; the order in
update-handlers.ts; a failed launch's reclaim; macOS and Linux; the normal
quit; agent sessions; pty-manager.ts; the installer; the away clock.

**Tests.** `session-helper-manager.test.ts`: Save leaves a kept terminal
running, its tab saved or not, with the log line, and "Close sessions"
then ends every one (B2's test, its Save half turned round, its discard
half kept with `null`); the same after a failed update's reclaim; Save
with no tab saved; a saved file that did not read. `session-helper-flow.test.ts`:
kept after a crash, an update with Save, then the next start keeps the
same holder again and lists it. `session-helper-app-wiring.test.ts`: a
cleared file is `null`, an unreadable or empty one an empty set. Each
new test was red on the base, 4c249119.

**Mutants.** Eight, each turned at least one test red: M1 B2's rule back
(5 tests), M2 a discard read from an empty set (2), M3 a discard ends
nothing (2), M4 no log line (1), M5 a discard still lets go of a saved tab
(1), M6 to M8 app-wiring's cleared, unreadable and empty file (1 each).

**Owed before stable.** The ADR-009 pass owed for B2 (aicc_planning #320
list) also covers this: a discarded state, and a kept terminal left
running through an update.
