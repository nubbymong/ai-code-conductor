## 2026-11-26 -- 2.1.3-beta.19's aggregate: Codex 0.172.0 as the newest tested, and a fix round

**Codex 0.172.0 is the newest tested version.** Section 4's fragment
(`2026-11-26-codex-two-row-footer.md`) left the raise to the aggregate, after
its conformance run. CI run 45756034358, a dispatch of `ci.yml` on section 4's
branch at its frozen head cefc6d15 (the two-row footer) with
`codex_rc_version` 0.172.0, ran every real-CLI conformance check of Codex
0.172.0 on Windows, macOS and Linux: each rc leg installed 0.172.0 and proved
it the `codex` on PATH, its conformance suite passed 9 with 1 skipped (the
placeholder that runs only without a CLI), and its flag-drift suite passed 5.
0.172.0 lists the same eleven models as 0.171.0, in the same order, so the
registry does not change; the catalogue names 0.172.0 among its versions.
`CODEX_MAX_TESTED_VERSION` (`cli-contract.ts`) moves from 0.171.0 to 0.172.0,
and README.md, docs/USER_GUIDE.md, the Feature Guide (`app-knowledge.ts`),
ADR-022 and the evidence record (`docs/wp1/evidence/codex-tested-range-2026-11-19.md`)
follow it. The too-new examples move to 0.172.1. Not shown: 0.172.0 was not
run on the aggregate head (the run was on section 4's head); a usage reading
on 0.172.0 needs a signed-in account; and 0.172.0's app-server schema was
neither generated nor compared with 0.171.0's. The owner's test of the
release checks the reading itself.

**The flag-drift suite can no longer pass by skipping on a conformance leg.**
In the same run the pinned Windows leg passed its flag-drift step with the
suite skipped (6 skipped), though `codex --version` had found 0.155.1 on PATH
two steps before. Measured from the run's own log: that file's import took
6.13 s, against 2.86 s and 2.92 s on the two Windows legs that ran the suite;
the extra time matches the suite's `where codex` look-up running past its
3 s limit, and every error of that look-up read as "no codex, skip". The
suite now finds codex from the PATH folders themselves (no process, no time
limit), and on a CI conformance leg (`CCC_CODEX_CONFORMANCE_KIND` set; every
such leg installs codex first) it fails instead of skipping. On a developer
machine and on the unit legs it still skips. The quarantined file itself was
not run on this computer; `codex-cli-compat-env.test.ts` checks the look-up,
the rule and the file's use of both, red against the earlier head.

**The Machines card says what is true after a same-version update.** A
machine's card read "this build of the app carries another version of the
session helper" beside 0.1.0, the version both beta.18's and beta.19's helper
carry: the compare is by the file's SHA-256. The line, and the matching log
line of a tab that takes the usual path, now name a different helper file.
