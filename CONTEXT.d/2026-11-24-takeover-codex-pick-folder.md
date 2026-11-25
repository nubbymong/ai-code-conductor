## 2026-11-24 -- A Codex session kept on its resume list keeps its pick folder through an update

Plan 2.1.3-beta.17, section B1b (aicc_planning#419), a follow-up of B1's take-over
(aicc_planning#412, S16 step 5). Windows, behind the agent sessions' switch.

- **Measured first (rule 34).** tests/unit/main/launch-bindings-kept-pick.test.ts runs the
  real launch bindings, the real Codex provider and its real watcher on real folders. On B1's
  head 3169ddb0, 8 of its 10 cases failed: an update that kept the session running still
  removed its `ccc-codex-pick-*` folder at the kill (the watcher's stop, telemetry.ts), the
  release recorded no pick, and the take-over bound the telemetry with the saved conversation
  only, never the pick file. So a resume list still open at the update could not write its
  pick after the take-over: it shows its "could not be told" notice, and the app does not
  learn which conversation the tab resumed.
- **Fix.** The kill of a session an update keeps stops its watcher with `keepPickFolder`
  (launch-bindings.ts unbindLaunchTelemetry, the same `launchKeptForUpdate` check its hook
  folder uses); every other stop removes the folder as before. The release records the pick
  (describeLaunch, from the watcher's new `pick()`): the file, the folder's identity as made
  (device and file id, real path), and the decision the watcher read last. The kept record
  carries it (manager.ts KeptRecord `pick`, read strictly: an absolute `pick.json`, a
  `<digits>:<digits>` id and an absolute real folder, else no pick). The take-over binds it as
  the launch did (pickFile, pickFolder), so the watcher still reads only while the folder is
  the one made, and the list's own folder check (CCC_CODEX_PICK_DIR_ID) still holds: no new
  folder is made.
- **The decision read before the update.** A watcher of a launch through the list claims only
  what the list decided, and the list's decision was already read and removed. So the
  take-over seeds the new watcher with it (`picked`): the conversation the session is on,
  else the decision read last (a conversation, or the time a new one was chosen). Without it a
  session already resumed through the list would claim nothing after the take-over; with it,
  that conversation is claimed at once and the list's later decision (its fallback to a new
  conversation when a resume fails) is still read, as at a launch.
- **Kept no longer.** removeKeptLaunchFiles removes the pick folder with the session's other
  files (the provider's removeSessionPickFolder, the watcher's own removal moved into
  telemetry.ts removeCodexPickFolder): the start ended it, its tab did not take it over, a
  quit or a new start of its tab came first, or the update did not go ahead. A take-over whose
  bindings fail removes it too. Only while it is still the folder made; never recursively.
  The start-up sweep of left-behind pick folders (C4, aicc_planning#407) stays the backstop for
  a kill.
- **Not helped.** An update from the published beta.16: its own code removes the folder at the
  release. The first update that keeps the folder is one from a version with this fix.
- **Tests.** launch-bindings-kept-pick.test.ts (10, host-safe: real folders, no link) and 8
  cases added to session-helper-take-over.test.ts (the record carries the pick to the
  take-over or to the removal; a pick or decision that does not read is left out). 11 red on
  3169ddb0. The 7 guards that pass there (a replaced folder, a folder holding anything else,
  and the five records that do not read) are red under their mutants, bar "no folder", which
  two checks guard (the id and the real folder). 18 mutants, each red.
