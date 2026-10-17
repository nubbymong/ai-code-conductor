## 2026-10-17 -- 2.1.2 carries the 2.1.1 WP1 evidence forward on a declared file list (ADR-027)

**Decision.** The owner chose to ship the macOS headless PATH fix as 2.1.2, a stable patch with no beta, under a new recorded rule: 2.1.1's WP1 evidence carries forward when the only changes are a declared small file list with named regression tests and green CI on all three operating systems (`docs/wp1/owner-decisions-2026-10-17.md#CF1`). ADR-027 is the rule.

**Branch.** `release/v2.1.2` is cut from `v2.1.1` (main), not from beta: beta is already past the binding with a non-neutral change, and main is not in beta's history. On it: the 2.1.1 security record, the three fix commits, the rule, check 5 of the release gate, the docs, and the 2.1.2 version and changelog entry.

**The rule.** `tests/wp1/carry-forward.json` lists every non-neutral path changed since boundHead with its regression tests; the candidate case judges it in place of its final assertion (`carryForwardProblems`, `bindingVerdict` in `tests/wp1/binding.ts`), and with no declaration behaves exactly as before. The release gate's check 5 requires CI's Test legs green on all three operating systems on the released commit, the declared PR merged as that commit with an ADR-009 PASS at its final head, and the base tag on the base commit. The `gate` job gains `checks: read` and `pull-requests: read`.

**The list.** 15 paths, 587 lines outside `tests/` measured from boundHead (caps 16 and 600, both cumulative from boundHead). The line cap was first proposed at 400; the coordinating agent set it to 600 when the fix gained a bounded probe wait in review. Adding the 2.1.2 changelog entry broke two tests that read the real changelog (one assumed 2.1.1 is newest; the What's New drift guard required curated lines for the newest release). Both tests were changed, and 2.1.2 is named there as a fixes-only release (the coordinating agent's choice), rather than adding a curated What's New line, which would have needed 17 paths.

**Not yet done.** The declaration file itself is written after the PR is opened, when its number is known; until then the candidate case is red on the branch, as designed. The adversarial pass, the Mac runtime check under a test user, and CI on the PR and on the merge to main follow.

**Next qualified stable.** The stale rule fails it until `tests/wp1/carry-forward.json` is deleted.
