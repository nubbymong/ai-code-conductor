## 2026-10-14 -- WP1 evidence for 2.1.1: the owner's sitting and the owner's decisions folded in

- What: the owner's sitting on the Windows test VM (2026-10-14, an
  interactive console logon, the app not elevated) is recorded at the
  qualification commit d1525759a7a42d941beeff601af3415fddd8afdd, and
  `docs/wp1/owner-decisions-2026-10-13.md` is final: the owner confirmed
  every decision at its default ("Yes"). Recorded: the console check
  (`packaged-smoke.md`): the app recognised a leftover Vision browser of
  2.1.0's shape as its own, ended it and started Vision; the window buttons
  on both full-window pages; in `real-cli-matrix.md`, two managed Codex
  accounts by the browser sign-in (one consented identity), a real prompt,
  the disposable Claude account signed in, `codex_review` on Codex 0.155.1,
  a link click, and WP1.52's re-authentication proof once (0.155.1, file
  store: the old folder signed out, the new one still signed in).
- Not run, on the owner's short path (decisions SP1, UA8): Sign in again a
  second and third time, the second consented identity, `codex_review` on
  0.153.4, the Claude sign-out after a relaunch, the keyring smoke (the
  keyring store is out of 2.1.1's scope, KR1), and the macOS sitting.
- Two known limitations added (release-qualification 3.8): Sign in
  again's "same account" box starts unticked, and unticked it adds a new
  account (by design; tick it; a 2.1.2 follow-up); and the test copy's
  Vision did not connect only because the sitting's launcher overrode
  USERPROFILE and HOME, which makes Chrome 155 refuse remote debugging
  (harness, not product).
- Still owed: the Linux test host run (packaged smoke, upgrade, rollback)
  and, on the owner's ruling (OQ1), WP1.2's rows 9, 25 and 33 on macOS and
  Linux with fake keys. WP1.2, WP1.37, WP1.63 and WP1.73 stay `planned`
  until then. The owner's stable go (Q5) has not been given.
- The manifest (`tests/wp1/traceability.json`) is not changed here; it is
  written once, when the candidate is declared. Every change is on a
  binding-neutral path, so the binding head does not move.
