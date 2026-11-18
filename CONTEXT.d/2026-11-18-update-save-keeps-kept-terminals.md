## 2026-11-18 -- With Save, a terminal kept after a crash keeps running through an update (2.1.3-beta.8 section B3)

**Why.** B2 (#713) added declared deviation 5: at an update on Windows,
every held plain terminal kept for a tab that no tab took over (a crash's,
Re-attach's or an earlier `reclaim()`'s) was ended unless its tab was
saved. That served "Close sessions" (acceptance case 6b), but it also
changed Save: a terminal kept after a crash whose tab is not saved (the
resume prompt declined, listed on the Machines page) closed at the update.
Before B2 it ran on past every update and the next start kept it again.

**What changed.**
- The renderer passes the user's choice with the install call:
  "Close sessions" on the update dialog sends `{ discarded: true }`
  (App.tsx, through preload). Save, and the Update pill with no tab open
  (which shows no dialog), send no discard. `update-handlers.ts` takes only
  a literal `true` as a discard and passes it to
  `releaseHeldTerminalsForUpdate({ discarded })`.
- `app-wiring.ts`: a discard reaches the manager as `null`; otherwise the
  tab ids in the saved file, none when it is cleared or does not read.
  The choice is never read from the file: "Close sessions" with a remote
  left running writes a file with no tab instead of clearing it, and
  "Don't open" on the resume prompt clears it with no choice made.
- `manager.ts releaseForUpdate(restorable)`: with `null`, each kept,
  not-live plain terminal is ended, as B2 did. With a set, even an empty
  one, it is neither let go of nor ended: it runs on past the exit, the log
  says so, and the next start (the "update" mark takes the crash path)
  keeps it again and lists it on the Machines page. Which terminals are let
  go of is unchanged.

**Scope.** The section named manager.ts and app-wiring.ts only. Passing the
choice needed App.tsx, preload (one argument on the existing channel, no new
channel) and the one install call in update-handlers.ts; the review of the
first head asked for it.

**Tests.** Manager, flow, app-wiring, update-handlers, the App wiring test
and a new preload bridge test (`update-install-bridge.test.ts`). The runs
that showed each new test red, and the mutants, are listed in PR #717.

**Owed before stable.** The ADR-009 pass owed for B2 (aicc_planning #320
list) also covers this: the new install-call argument, a discarded state,
and a kept terminal left running through an update.
