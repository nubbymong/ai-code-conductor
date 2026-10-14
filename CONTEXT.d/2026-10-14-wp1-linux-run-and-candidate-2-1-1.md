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
  recorded question list was the coordinating agent's paraphrase. The
  Linux columns were taken.
- The owner's ruling, about 06:00 BST: asked in one question whether the
  macOS fake-key rows of OQ1, and the Sign in again runs SP1 drops from
  WP1.52's 2.1.1 proof, are recorded as not run, the owner answered "OK
  both vms are on - go". So the macOS columns are not run with the macOS
  sitting, under UA8, and WP1.52's 2.1.1 proof is the one Sign in again run
  taken (Codex 0.155.1, the file store). OQ1 and SP1 in
  `docs/wp1/owner-decisions-2026-10-13.md` quote the question and the
  answer; UA1, UA8 and KL3 cite them.
- Corrected after the spec and quality review: the review found that the
  records stated an owner decision for those two parts that the owner had
  not yet made; both were then put to the owner, who ruled them (above),
  and the records cite that ruling. Also corrected: the window
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
