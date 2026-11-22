## 2026-11-22 -- An edited Claude account keeps its place in the saved list (aicc_planning#383)

Found by aicc_planning#381 (a steady order in Settings, Accounts), which fixed
the Settings list in the window and left the cause in main.

**Before.** `withProfile` in src/main/account-profiles.ts took the edited record
out of profiles.json and put it on the end. So every edit of a Claude account
(made inactive or active, renamed, a sign-in refreshed, a placeholder name
healed, the home-layout migration's email reset) moved it to the end of the
file and of every list read in saved order: the switch-account menu, Account
usage, the launch chooser.

**Change.** `withProfile` replaces a listed record where it stands and puts
only an account that is not listed yet on the end. A second record with the
same id (a hand-edited file) is still dropped; the one left sits at the first
one's place. Entries that are not profile objects and every other top-level
key stay where they were. A file an earlier build already reordered is left in
the order it has; Settings, Accounts lists by the date added either way (#381).

**Readers.** No reader relied on "last edited is last". Where one takes the
first account (the headless home, the launch chooser and the agent and Insights
pickers, each only when no primary is set), that account no longer changes
after an edit.

**Tests.** tests/unit/main/account-profiles-edit-keeps-place.test.ts (16 tests;
11 fail against the old code, the other 5 are cases the old code shared: an
edit of the last account and a new account going last). Two assertions in
tests/unit/main/account-profiles-strict-writers.test.ts pinned the old order
and now expect the steady one.

**Owed.** ADR-009 pass before stable (aicc_planning #320 list), by path
(src/main/account-profiles.ts): a profile record replaced in place.
