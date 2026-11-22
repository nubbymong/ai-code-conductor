## 2026-11-22 -- 2.1.3-beta.13 lands in one PR, with its release commit, and the live SSH matrix is retired

**One PR for the beta.** The thirteen reviewed sections of 2.1.3-beta.13 were
merged at their frozen heads, in plan order, with real merge commits, onto one
branch from beta (#755). The version bump, the changelog entry and the release
surface sweep are that branch's last commit, so no second release PR is opened
and the release workflow reuses this PR's green CI (plan rule 11).

**Conflicts, each resolved by keeping both sides.**
- `src/main/session-helper/helper-pty.ts` (A3 and A4, both built on A2's head):
  the header keeps A4's paragraph and A3's paragraph on terminal queries; the
  attach reply keeps A3's start and end of the query filter and takes A4's
  change, that a program which is over waits for the size as a running one does.
- `src/main/session-helper/replay-tail.ts`: A3 made the reader keep a CSI's or
  DCS string's intermediates as a string, as the tab collects them (its query
  filter reads `$` there). A4 had added a number for the first intermediate, for
  two stops of its clear: ESC # 8 and a soft reset (CSI ! p). The reader keeps
  A3's string; A4's checks read it as `#` after ESC and `!` alone in a CSI, the
  same sequences A4's number matched (a second intermediate set A4's number to 0,
  and `!` alone excludes it the same way). Every session-helper test file passed
  on the resolved tree before the merge was committed.
- C6's comments in `accountProfilesStore.ts` and its test said main writes a
  changed profile at the end of profiles.json. C7 merged after C6, so they now
  say it did up to 2.1.3-beta.12 (C7's review gave the words). The sort by date
  added stays: a file an earlier build edited keeps that order.

**The size wait's cap is 3,000 ms.** `SIZE_WAIT_MAX_MS` in helper-pty.ts was
2,000 ms, provisional until the VM measured it. The longest time from the spawn
to the holder's size was 1,417 ms in A2's VM line and 1,334 ms in A4's, where 3
of 14 restores took over 1.3 s; 2,000 ms left little room for a slower PC.

**The live SSH matrix is retired (owner, 2026-11-22).** Removing it was one of
the simplification goals: it took a long time and was fragile. AGENTS.md, the
adversarial review skill and CONTRIBUTING.md now say so in one line, and
`scripts/ci/pr-numbers.mjs` no longer reports a blast radius or a matrix owed
(it keeps the pty-manager.ts cap; its test checks AGENTS.md carries the
retirement line instead of reading the radius list from it). The
`tests/live/ssh-statusline-*` files stay for now. A check that the session
helper works across devices (the test VMs, the Mac, Linux hosts) replaces the
matrix when the remote helper needs one. B1's fragment
(2026-11-21-launch-bindings-module.md) says the matrix runs once on B1's head;
it did not run.

**Owed text applied here.** helper/README.md's Screen row names the take-over's
one `screen.read` (A1). ADR-030's Rocky Linux note lists the three ways the P3
and P6 probe changed after its run (C2's re-check).

**Release surface sweep.** app-knowledge.ts: the Usage paragraph says an
account a Claude Code session uses is never fetched, the primary included (C3);
the credits-row known issue follows it; the Accounts paragraph names the steady
order and the All / Active / Inactive control (C6, C7); the Plain terminals
known issue is narrowed to a tab that does not come back at the terminal's size
(A1, A2, A4); the Codex known issue about text taken back keeps only macOS (B2,
aicc_planning#370 stays open for macOS). tips-library.ts: the Usage tip follows
C3. The Feature Guide cards and README.md needed nothing.
