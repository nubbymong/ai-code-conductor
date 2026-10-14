## 2026-10-14 -- WP1 evidence for 2.1.1: the Linux run recorded, OQ1 corrected, the candidate declared

- What: the run on the Linux test host is recorded at the qualification
  commit d1525759a7a42d941beeff601af3415fddd8afdd, on the packaged AppImage,
  in the test user's graphical session: a clean run, the upgrade from 2.1.0
  and the rollback to it (`packaged-smoke.md`, `rollback.md`), and WP1.2's
  rows 9, 25 and 33 with fake keys (`real-cli-matrix.md`). Rows 9 and 33
  passed; row 25's index matched its rule, and F-L1-2 reproduced on a
  labelled synthetic rollout (accepted, AM3). Each run had an independent
  check. Nothing severe, and no regression against 2.1.0.
- How it differs from the plan: the host has no FUSE 2, so every start used
  `--appimage-extract-and-run`; GNOME's idle lock had locked the session, so
  the sessions, typing, upgrade and rollback ran on X11 through Xwayland;
  typing was injected through the DevTools port; there are no screenshots
  (release-qualification 3.8, known limitation 16). The test user was not
  removed (that needs administrator rights); its run files were moved aside.
- OQ1 corrected: the owner's "Yes" did not rule it. Its line in the
  recorded question list was the coordinating agent's paraphrase. What
  applies was set by the coordinating agent from the owner's short path,
  and the owner has not ruled on it: the Linux columns taken, the macOS
  columns not run, under UA8. UA1, UA8, KL3, SP1 and OQ1 in
  `docs/wp1/owner-decisions-2026-10-13.md` say so.
- Corrected after the spec and quality review: the records now say which
  parts rest on the coordinating agent's reading rather than on the owner's
  words (OQ1's macOS fake-key rows, and SP1's amendment of WP1.52's 2.1.1
  scope), and that both go to the owner before the promotion; the window
  buttons were clicked by mouse events injected through the DevTools port,
  which shows each button's action but cannot rule out a drag region over
  a button; the Linux run's `/tmp` leftovers need their own removal; and
  the disposable Claude account's record keeps to what the saved reads
  hold (no refresh-token claim).
- With these, every item is `evidenced` or `unavailable`: WP1.2 reads
  `unavailable` on UA1 (and cites the decisions file for AM3), WP1.63 on
  UA8, and WP1.37 and WP1.73 read `evidenced`. The manifest
  (`tests/wp1/traceability.json`) is then written as the candidate (phase
  `candidate`, the binding head, the evidence records), in its own commit.
- Every change is on a binding-neutral path, so the binding head does not
  move.
