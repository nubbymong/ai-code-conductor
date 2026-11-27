## 2026-11-27 -- Claude sign-in renewal: review round 2 (nubbymong/aicc_planning#444)

2.1.3-beta.20 plan phase 4, the one finding of its second review (P4-8).

What changed:
- `claude auth status` runs in the primary profile's own home, so its "not
  signed in" is about that home only. When that home has no credentials file
  (and the sync did not copy one in), the app reads ~/.claude's sign-in
  instead, which the CLI never saw. The CLI's answer now counts as the
  primary signing out only when the credentials file read after it is the
  profile's own; otherwise the card stays Refreshing rather than a false
  "Sign-in expired".

Tests: tests/unit/account-usage-renewal.test.ts (the profile home empty,
~/.claude lapsed, the CLI saying signed out: Refreshing); the mutant that
drops the own-file check is killed.
