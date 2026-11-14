# ADR-028: A beta ships in a day: one approved scope, one review round, CI that runs only what is needed

- Status: Accepted (owner decisions of 2026-11-13 and 2026-11-14; scope of 2.1.3-beta.1 approved on the Agent Canvas, 2026-11-14)
- Date: 2026-11-14
- Amends: ADR-009 (the fix -> re-attack loop of an interactive caller);
  ADR-020 (the gates a session PR into `beta` clears); the release flow in
  `AGENTS.md` and `CONTRIBUTING.md`; `.github/workflows/ci.yml` and
  `.github/workflows/release.yml`

## Context

A beta had become slow to ship for reasons that had little to do with the
change inside it:

- A review could be repeated without limit. ADR-009 told an interactive caller
  to repeat fix -> re-attack "until clean", and each pass could raise small
  findings in older code near the change, which were then fixed, which changed
  the diff, which asked for another pass.
- The same tree was tested several times. A PR ran the matrix; every label
  added to the PR (`desktop-tested`, `in-beta`, a release label) started the
  matrix again; the release then ran the suite once more on Windows and Linux
  for a tree CI had already passed. The Windows suite alone takes about half
  an hour.
- A push to a PR did not stop the run on the commit it replaced.
- The version bump was a PR of its own, with its own review, CI run and merge.
- Every PR needed a desktop-test label (`desktop-tested`, `runtime-validated`
  or `skip-desktop-test`) for its `Desktop test gate` check to go green (#309).
  On a beta PR that asked the owner to exercise a build per PR, or to wave the
  check through, before the beta that would actually be tested existed.

## Decision

The owner decided these rules. They are written into `AGENTS.md` ("Beta
cadence") and `CONTRIBUTING.md`, and the workflows carry out rules 4, 6 and 9.

1. **The owner approves the scope of each beta before it is built.** Each beta
   carries at least one architecture simplification and one process
   simplification. The target is a release within 24 hours of the approval.
2. **One review round per beta, on a frozen head.** On security-sensitive
   paths the adversarial pass (ADR-009) is that round, and its lenses count as
   the two reviews a change needs (does it do what was agreed; is it correct
   and tested). The round is one pass, one fix batch, one confirmation. A fix
   made after the confirmation gets a narrow check of that fix diff only, never
   a new full pass. This replaces "repeat until clean" for an interactive
   caller. The bar does not move: a pass with an open BLOCKER or MAJOR is
   still FINDINGS, and FINDINGS still does not merge.
3. **Majors, and anything the beta itself introduces, are fixed before the
   cut.** A minor finding in older code near the change gets a ticket in the
   private planning repository for the next beta. This replaces "every minor
   gets fixed" in the same round.
4. **The beta release reuses green CI for the same tree** instead of running
   the suite again. A stable release is unchanged: it runs the suite itself.
5. **The version bump rides in the last content PR of a beta.** There is no
   separate version-bump PR.
6. **CI runs only what a change touches; a superseded run is cancelled; a
   label change does not restart the tests.**
7. **No new release-evidence gate is added.**
8. **Security paths keep the adversarial pass, and the owner still merges
   every PR.**
9. **Desktop testing is at release level on beta and pre-release on stable,
   not per PR** (owner, 2026-11-14). The owner desktop-tests the released beta
   build; that test is an input to the stable promotion. A PR into `beta`
   never needs a `desktop-tested`, `runtime-validated` or `skip-desktop-test`
   label.

### How the workflows carry out rules 4, 6 and 9

**Superseded runs (`ci.yml`, `concurrency`).** The code events of one PR
(opened, synchronize, reopened, `ci-run` being added, and the base branch
being changed) share a group that cancels the run in progress. Every other
label change, and an edit of the title or description, runs in a second group
per PR, so it can never cancel the tests of that PR. A push to `main` and a
dispatch get a group of their own per run and are never cancelled.
`release.yml` has no concurrency at all.

**Label changes (`ci.yml`, the `test` and `codex-conformance` conditions).**
On a `labeled` event the two OS matrices run only when the label added is
`ci-run`; on `unlabeled`, never; on `edited`, only when the base branch
changed (the merge under test is then another one). The results already
reported for the commit stand. `Desktop test gate` still runs on every PR
event, so the check keeps updating. `Changelog in sync` and the SSH smoke also
run again on a label change or an edit (about a minute together): a job
skipped by its condition reports as passed under its own name, and that would
sit over an earlier red result for the same commit.

**The Desktop test gate (`ci.yml`, the `desktop-gate` job; rule 9).** The job
keeps its name, `Desktop test gate`, and still runs on every PR event. It now
decides from the base branch first. On any base but `main` it reports success
with one line saying that desktop testing happens on the released beta. On a
PR into `main` (the stable promotion, `release/vX.Y.Z` to `main`) it asks for
one of the three labels, exactly as it did for every PR before. The decision
is taken inside the job, never by a job-level condition, because a job skipped
by its condition reports as passed. The workflow now also starts on the
`edited` event, the only event GitHub sends when a PR's base branch changes,
so a PR that passed on a `beta` base is decided again, and goes red, when it
is retargeted to `main`. A base that cannot be read is treated as `main`.

**Only what a change touches (`ci.yml`, "Decide the scope";
`scripts/ci/change-scope.mjs`).** The safe minimum: a PR that changes only
documentation (Markdown anywhere, `docs/`, `CONTEXT.d/`, `architecture/`)
skips the suite on Windows and macOS. The Test jobs still start and end green,
because `Test (windows-2025)` and `Test (macos-latest)` are required checks
and a job skipped as a whole never reports them: the paths are read inside the
job, and every later step is conditional. Linux always runs the whole suite,
because some tests read the Markdown they guard. Anything the step cannot read
for certain runs the suite.

**Reusing green CI (`release.yml`, the `ci-reuse` job;
`scripts/ci/reuse-green-ci.mjs`).** Each `ci.yml` Test job ends with a step
named after the git tree it checked out, `Tested tree <hash>`, reached only
when the suite, the native tests and the build passed. On `channel=beta` the
release looks for a `ci.yml` run that is green, in this repository, not from a
fork, started by a PR or a push, for a commit whose tree equals the release
commit's, and in which the Windows, macOS and Linux Test jobs are each green
with a green `Tested tree <that hash>` step. If it finds one, `build-windows`
and `build-linux` skip "Run tests" and the job summary links the run. On any
doubt, and on any API error, the full suite runs as before. `channel=stable`
never reuses.

Two conditions are checked because each closes a different gap. The commit's
tree is what GitHub itself records for the run, so the `ci.yml` that ran is the
one in the released tree and not one a branch altered. The step is what the
job says it tested: a pull-request run tests the merge of the branch into its
base, so a branch that was behind its base tested another tree than its head,
and a docs-only run tested nothing on Windows and macOS. In both cases the
step is missing or names another tree, and the release runs the suite.

## Consequences

- A beta release skips about half an hour of suite time when the last content
  PR was rebased on `beta`, carried `ci-run`, and was squash-merged with no
  other merge in between: the squash commit then has the tree CI tested.
  Anything else falls back to the full suite, so the worst case is today's
  behaviour.
- A beta whose last merge is docs-only does not reuse (Windows and macOS did
  not run the suite on that tree). Rule 5 makes the last PR a content PR.
- The reuse trusts a green run of this repository's own `ci.yml` on a tree the
  owner merged. Branches in this repository are pushed by collaborators only,
  and the owner merges every PR (rule 8).
- `ci.yml` and `release.yml` are among the WP1 carry-forward gate files
  (ADR-027). They change here on `beta`, where the candidate check does not
  run. A carry-forward patch is cut from the stable tag, so it does not
  contain this change and must not pick it up; the next qualified stable does.
- The desktop test moves from every PR to the released beta. A beta can ship
  without anyone having launched that exact build; the owner's test of the
  released beta, and the label on the promotion PR into `main`, are what stand
  between it and stable users. No release-evidence gate was added for this
  (rule 7): the release workflow and the release gate do not read the labels.
- The three rulesets require `Test (windows-2025)` and `Test (macos-latest)`
  only (read 2026-11-14). `Desktop test gate` is not a required check in any
  of them, so on a PR into `main` a red gate is a red X for the owner to read,
  not a hard block. Requiring it on `main` is an admin-only ruleset change,
  outside this decision.
- A PR edit (title, description) now starts a CI run of the three cheap jobs
  (the gate, the changelog check, the SSH smoke), because `edited` cannot be
  filtered to base changes at the workflow level.
- Nothing here changes a signing, notarization, upload or publish step, the
  release gate, or the branch rulesets.

## Alternatives considered

- **Workflow-level path filters for docs-only changes.** Refused: a workflow
  that does not start reports no check, and a required check that never
  reports blocks the merge.
- **Skipping the Linux suite on docs-only changes too.** Not taken by
  default: tests pin text in `AGENTS.md`, the adversarial-review skill and
  `docs/wp1/`, and Linux is the fastest runner (about six minutes) and not a
  required check, so it costs no merge time.
- **Matching the reuse on the tested-tree step alone**, which would also hit
  when a PR branch was behind `beta`. Refused: without the commit's own tree
  nothing ties the run to the `ci.yml` being released.
- **Running CI on every push to `beta`** so the release could match by commit.
  Refused: it would test every merge a second time, which is the cost this
  decision removes.
- **Removing the `Desktop test gate` job, or skipping it on a beta base with a
  job-level condition.** Refused: the check is known by name, a job skipped by
  its condition reports as passed whatever the base is, and the stable
  promotion still needs the label.
- **A gate in the release workflow that asks for proof of the beta desktop
  test.** Refused by rule 7. The existing label on the promotion PR is the
  record.
