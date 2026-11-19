## 2026-11-19 -- The newest tested Codex is 0.157.1, measured in CI first

Section C1 of the 2.1.3-beta.11 plan (aicc_planning#185). The app called a
Codex "tested" only up to 0.156.1, while the test VM already runs 0.157.1 and
the first-run recipe installs whatever npm serves that day. A newer Codex still
runs, but the Set up Codex page, the Providers card and Sentinel show a notice,
and a closed account's usage reading is not attempted at all.

**Measured before the change.** `ci.yml` was dispatched on `beta` (32fb8b36)
twice with `codex_rc_version`: 0.170.0, npm's `latest` that day, and 0.157.1.
The decision line was written before either log was read: a version whose
every conformance check is green on Windows, macOS and Linux may become the
newest tested version; a red check leaves the range below it.
- CI run 44530382595, 0.157.1: every leg green on all three systems. Its model
  list is the same seven ids as 0.156.1, and the rust-v0.157.1 tag's
  models.json gives the same labels, effort levels and order.
- CI run 44530368458, 0.170.0: the rc leg red on all three systems. On Windows
  and Linux its model list names four models the registry lacks (gpt-6.2-sol,
  gpt-6.2-astra, gpt-6.1-terra, gpt-6.1-sol); on macOS the app's own PATH
  resolution found `bin/codex.js` and read no version it recognises, so no
  model list was read there. Both go on #185, for a later beta, when this
  merges. Versions between the two were not run.

**What changed.** `CODEX_MAX_TESTED_VERSION` is 0.157.1. The pin (0.155.1) and
the minimum (0.153.4) stay, with their captures and the oracle. What a too-new
or too-old Codex may do is unchanged. The same number moved in README.md, the
user guide and the Feature Guide's known issue (app-knowledge.ts).

The runs are in docs/wp1/evidence/codex-tested-range-2026-11-19.md, not as new
rows in ci-matrix.md as the plan said: ci-matrix.md is the 2.1.1 record, bound
by its sha256 to the WP1.30 evidence record taken at the 2.1.1 head
(tests/wp1/traceability.json), and a row added there turns the traceability
test red or re-signs that record at a head it was not taken at.

Places the plan's file list did not name, or named only in general, had to move with the number:
- resources/codex-model-catalogue.json lists 0.157.1 among the versions it was
  read from (a test requires the newest tested version there since S18).
- Two usage-read tests used 0.157.1 as their example of a too-new Codex; they
  now use 0.157.2, and a new case shows 0.157.1 is asked.
- tests/unit/providers/codex/app-server-read.test.ts used 0.157.1 as a version
  above the range that discovery calls supported, which the reader must still
  refuse. With 0.157.1 in range it no longer proved that, and the PR's first CI
  run was red on it on every system; it now uses 0.157.2.
- The app-knowledge test tied the 2.1.1 What's New row, which is history, to
  the live constant; that row now pins its own 0.156.1, and the Feature Guide
  entry still follows the constant.
- ADR-022's bound 5 and its evidence paragraph gave 0.156.1 as the top and
  0.157.1 as never read; they now say when each held.

The review added one pin of today's behaviour in tests/wp1/cli-discovery.test.ts:
a pre-release of the top (0.157.1-alpha.1) and a zero-padded top (0.157.01)
read as supported. The ADR-009 pass owed before stable decides them.

**Shown red.** Against the old constant, tests/wp1/cli-discovery.test.ts ("reaches
0.157.1 ...": too-new, not supported) and tests/unit/main/codex-usage-read.test.ts
("a CLI on 0.157.1, the newest tested version, is asked": refused) were red in
one local run, and green with the new one.

**What CI cannot prove.** The usage reading on 0.157.1 needs a signed-in
account. Its own guard stands (a CLI that answers "unsupported" is not asked
again until its program file changes), and the owner's test step 1 checks it.
At the release smoke, one look on the VM: the Set up Codex page with Codex
0.157.1 reads "Version supported".

The release PR carries the What's New fix line and the known issue's number
wherever the release notes repeat it.
