## 2026-10-14 -- 2.1.1 stable: promoted to main, released, merged back into beta

- What: v2.1.1 was promoted to main through pull request #645, merged with
  "Create a merge commit" (merge commit
  9ca0f0e0f4231ff3d83402dc1a39036c5200ac00, whose tree equals the release
  branch head's), and released as stable from main. The qualification
  commit d1525759a7a42d941beeff601af3415fddd8afdd, the WP1 binding head, is
  an ancestor of main.
- Merge-back: the 2.1.1 evidence and the gate0 manifest reach beta as one
  squash commit on d1525759a7a42d941beeff601af3415fddd8afdd, as the beta
  ruleset requires (squash only, linear history), so the qualified commit
  stays an ancestor of beta. Main's merge commit is not part of beta's
  history.
- WP1 manifest: `tests/wp1/traceability.json` is back at phase `gate0` on
  beta. boundHead stays d1525759a7a42d941beeff601af3415fddd8afdd and every
  status and evidence record is kept. Left at `candidate`, the first source
  change on beta would break the binding and turn its CI red.
- Evidence wording: the three non-blocking points of the final independent
  recheck are applied. Section 3.10 of `release-qualification.md` and the OQ1
  heading of `owner-decisions-2026-10-13.md` say that the owner ruled only
  the macOS columns of WP1.2's fake-key rows, and that the Linux columns were
  taken by an agent run; the owner-decisions status paragraph says OQ1 was
  ruled in one question together with SP1's amendment; and the record of
  `packaged-smoke.md` names the agent as the one who clicked the window
  buttons, with mouse events injected through the DevTools port.
  `release-qualification.md` also now says the manifest declared the
  candidate for the promotion and is back at `gate0` on beta. Its two
  records are re-hashed; apart from those hashes and that actor, the records
  are unchanged.
- Rule kept: any later edit to a file under `docs/wp1/evidence/` on beta
  re-hashes its record in the manifest, or the traceability gate fails.
