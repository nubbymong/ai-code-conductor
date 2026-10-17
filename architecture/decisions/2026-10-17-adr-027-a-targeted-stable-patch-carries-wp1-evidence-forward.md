# ADR-027: A targeted stable patch carries the previous stable's WP1 evidence forward, on a declared, tested and reviewed file list

- Status: Accepted on the owner's decision of 2026-10-17
  (`docs/wp1/owner-decisions-2026-10-17.md#CF1`)
- Date: 2026-10-17
- Amends: the WP1 binding (WP1.70, WP1.73) in `tests/wp1/binding.ts` and
  `tests/wp1/traceability.test.ts`; the release gate
  (`scripts/release-gate.mjs`, check 5); the permissions of `release.yml`'s
  `gate` job

## Context

The WP1 candidate check binds a stable release to its evidence in two halves.
Every evidence record in `tests/wp1/traceability.json` is digest-bound and was
taken at `boundHead`, and nothing but binding-neutral paths (the manifest,
`docs/`, `CONTEXT.d/`, the ADRs, top-level Markdown) changed between
`boundHead` and the commit being released. 2.1.1 shipped on that binding, at
`boundHead` d1525759.

Then a macOS bug turned up. An app opened from the Dock or Finder gets
launchd's PATH, so a headless Claude Code run (the setup version check,
Insights, Sentinel's checks) exited 127 wherever Claude Code lived in a folder
only the login shell names. The fix is in three files under `src/main/`.
Under the binding as it stood, any such change breaks the second half, and the
only honest way back is to requalify all 73 items, which takes days of
Windows VM, Mac and Linux sittings.

The options were:

- full requalification;
- a beta first (the owner said no: "We should not need a beta, this is a
  targeted fix");
- rebinding `boundHead` past the change, which is the "rebind reflex"
  `staleRecords` exists to stop;
- waiving the check, against the rule that the gate is never waived;
- this rule, which the owner chose ("Stable, new fast rule").

## Decision

A stable release may keep the previous stable's WP1 evidence when one
committed declaration, `tests/wp1/carry-forward.json` (schema
`wp1-carry-forward/1`), lists path by path every non-neutral file changed
since `boundHead`, with named regression cases for each, and the release gate
confirms on GitHub what the suite cannot see. The declaration is a file of its
own, never a field of the neutral manifest, so an edit to it is itself a
change it must declare.

**The candidate check** (`carryForwardProblems`, `committedCarryForward` and
`bindingVerdict` in `binding.ts`) replaces only its final assertion.
Everything before it runs as before: nothing planned, every record
digest-bound and taken at `boundHead`, and `boundHead` an ancestor of HEAD.
With no declaration the final assertion is the one before this ADR, with the
same message. With one, every rule fails closed:

1. The declaration is the one committed at HEAD, read with `git ls-tree` and
   `git show`, never from the working tree; the suite and the gate share that
   scan (`scanCommittedCarryForward` in `release-gate.mjs`). The declaration's
   path in another case (the full path, compared ignoring case, as a
   case-insensitive file system sees it) refuses, as does a link or an
   executable at the path; a file of the same name in another folder, such as
   an archived declaration, is not the declaration and is ignored. A
   working-tree copy HEAD does not have (one written while the suite runs, by a
   setup file say), or one that differs from HEAD's (line endings aside), also
   refuses. These refusals apply in every candidate run, with or without a
   declaration. It must be one of the paths changed since `boundHead`.
2. A declaration that is not valid JSON of its schema fails, naming the file;
   it is never read as absent.
3. Its `targetVersion` must be `package.json`'s version, or it is stale and
   must be deleted. This stops it lingering into the next qualified stable or
   being reused by editing one field.
4. The target is a stable `x.y.z`, the next patch after a stable base of the
   same major and minor, and `base.tag` is `v<base.version>`.
5. `base.commit` is an ancestor of HEAD (undecidable in a shallow clone fails
   with the fetch hint), its `package.json` is `base.version`, and its manifest
   is a candidate bound to this `boundHead`, which `base.boundHead` names too.
6. Once a base already has this rule (its `binding.ts` exports the check or
   names the declaration path), the files that run and judge it may not change
   between the base and HEAD: `tests/wp1/binding.ts`, `traceability.test.ts`,
   `phase.ts`, `scripts/release-gate.mjs`, `scripts/wp1/fetch-ledger-commit.mjs`,
   `release.yml`, `ci.yml`, every `vitest*.config.*` and every setup and
   global-setup file they name (a case holds the list to the configs). 2.1.2's
   base, v2.1.1, has no rule, so 2.1.2 may change them, once.
7. The list is exact: every changed non-neutral path is declared, nothing else
   is, each by its exact repository path (no glob, pathspec, `..` or
   backslash), once, and no neutral path pads it.
8. Under a binding-neutral prefix only Markdown and the manifest may change.
   Any other file there (code under `docs/` that a counted line could import,
   a JSON file, an image) refuses by name.
9. Each path names one or more tests vitest collects (not native, not e2e),
   present and not empty, holding every named case as the title of a bare
   `it(` or `test(` call in the code, not in a comment or a string. The raw
   text of each named file may hold no unconditional skip, todo or focus, not
   even in a comment or a string (`skipIf` and `runIf` are allowed). Every
   entry, test file and case is checked, not only the first.
10. `package.json` and `package-lock.json` may change their version fields and
    nothing else.
11. At most 16 paths. In counted paths (declared paths outside `tests/` and
    `.github/`, and outside `DEV_ONLY_TOOLING`, two release scripts a case
    proves are never packaged: no `files`, `extraResources` or `extraFiles`
    entry, per platform too, reaches them, a bare folder or a glob included;
    the case runs only when a declaration is committed, so beta and dev
    packaging are not tied to it), at most 600 lines added plus deleted since
    `boundHead`, no added line over 1000 characters, and no binary file; a
    line count git gives that cannot be read fails. Scripts that ship stay
    counted. The caps are constants in `binding.ts`, never fields of the
    declaration, and count from `boundHead`, so chained patches add up until a
    qualification resets them.
12. The approval is a dated owner-decisions record under `docs/wp1` whose own
    section names the version, says the evidence is "carried forward" or "carry
    forward" (spaced: the hyphen form is the declaration's own path, which every
    section names), and names every declared path, outside code fences and HTML
    comments.
13. `adversarial.pr` always names the PR whose ADR-009 pass covers the diff,
    whether or not a path is on the adversarial-review path table. A
    carry-forward swaps 73 items of independent evidence for an author-written
    list, which is the self-review ADR-009 exists to prevent, and the first one
    also lands the gate that judges it.

`BINDING_NEUTRAL` and `bindingBreaks` are unchanged, and a case pins
`BINDING_NEUTRAL` by value. The declaration has no field that feeds the neutral
rules, item statuses or `UNAVAILABLE_ELIGIBLE`.

**The release gate** adds check 5 (`evaluateCarryForward`). It reads the
declaration as committed at HEAD too, with the same scan, on every cut (a local
git call): the declaration's path in another case, a link at the path, or text
that is not JSON cannot be evaluated, and the error names the file. Check 5
applies only when the declaration's `targetVersion` is the version being cut,
and every other cut makes no new GitHub call. On the commit being released
(`GITHUB_SHA`, else HEAD) it requires:

- (a) ci.yml's newest push run on that commit has completed (its latest
  attempt), and its three Test jobs, for Windows, macOS and Linux, are each
  there and green; the run's other jobs do not gate. The
  release workflow itself blocks on the Windows leg only (the Linux leg is
  non-blocking and the Mac job runs no tests), and the fix's own regression
  cases skip on Windows, so this check is what makes "green on all three" a
  precondition. Listings GitHub counts are read to exactly their
  `total_count`.
- (b) The declared PR merged as that commit, the commit is a merge with
  exactly two parents (the base commit, then the PR's final head), and the
  latest ADR-009 verdict marker an owner, member or collaborator posted on it,
  naming the PR by its exact number, is a PASS at that head. A push after the
  pass needs the marker posted again. A comment read that reaches its page
  limit refuses rather than drop the newest markers.
- (c) The base tag is a published GitHub release, neither a draft nor a
  prerelease, and points at `base.commit`, with an annotated tag dereferenced
  once.

A GitHub read error, or a caller that gives no reader, cannot be evaluated,
which also refuses the cut. The `gate` job reads with `contents`, `issues`,
`pull-requests` and `actions`, and nothing else.

## The readers of the declaration

| Reader | What it reads | Change |
| --- | --- | --- |
| `tests/wp1/traceability.test.ts` | the committed declaration, in the candidate case | the cases below |
| `tests/wp1/binding.ts` | the committed declaration, given by the test | the rules above |
| `scripts/release-gate.mjs` | the committed declaration: `targetVersion`, `adversarial.pr`, `base.tag`, `base.commit` | check 5 |
| `tests/wp1/phase.ts`, `scripts/wp1/fetch-ledger-commit.mjs` | not the declaration | none |

## What it cannot do, and what it relies on

- The fix changes the headless Claude Code runs (the setup version check,
  Insights and Sentinel's checks) that the carried real-CLI and packaged
  records describe at `boundHead`. Those records are carried, not retaken:
  they describe the runs before the fix. What is taken instead is the whole
  suite on three operating systems at HEAD (check 5a), which includes the fix's
  POSIX regression cases on macOS and Linux, and the Mac runtime check of the
  PR's build under a test user, the one packaged check taken. The packaged
  evidence (packaged smoke) and the real-CLI evidence (the real-CLI matrix)
  are among the carried records, and the manual evidence (rollback) is not
  retaken either.
- Only `release.yml` and `ci.yml` of the `.github/` tree are frozen, and
  nothing under `.github/` counts toward the caps. That holds while only
  `release.yml` builds and there is no `.github/actions/`.
- Named cases are proven to exist, not to have run, and conditional skips are
  allowed. "Ran and passed" rests on check 5(a) (the macOS leg) and on the
  ADR-009 pass showing each regression case red without the fix.
- The first carry-forward lands the gate code that judges it, so it certifies
  itself. That is mitigated by the PASS on the PR that holds both, by the
  owner-listed paths and by the mutants below; and from the next carry-forward
  on, rule 6 freezes those files.
- The gate checks the shape of the approval, not its meaning, as ADR-026 does.
- The caps are cumulative from `boundHead`, so a further patch on the same
  binding has what 2.1.2 leaves, and then the next stable requalifies. That is
  intended. At the 2.1.2 cut: 15 of 16 paths, 394 of 600 counted lines (the
  fix 374, the changelog 14, the package files 6), and a longest added line of
  890 characters, a one-line changelog description.
- The declaration is a standing exception while it exists. The stale rule makes
  the next qualified stable fail until `tests/wp1/carry-forward.json` is
  deleted; the next qualification's checklist must say so.
- A beta-channel cut of the bare 2.1.2 version from the release branch carries
  forward in the suite (the manifest is a candidate), but check 5 does not run
  for it (its milestone is `2.1.2-beta`). The stable cut is the one check 5
  guards.
- The test-title scanner reads enough of JavaScript's lexical grammar to tell
  code from comments and strings in an ordinary test file; it is not a parser.
  It guesses whether a `/` starts a regular expression, and a wrong guess can
  desynchronise it, so in a hostile layout it can miss a case or read one that
  is not there. Skips are found in the raw text for that reason, and hostile
  test files are the ADR-009 pass's to catch.
- `COLLABORATOR` includes read-only collaborators, and the PR author can post
  their own PASS; agents post as the owner's account, so author and reviewer
  cannot be told apart here.
- Stable releases are not restricted to `main` by the workflow. The parents
  rule (b) ties the release commit to the base and the reviewed PR head, so
  the commit is exactly the base plus that PR.

## Consequences

- A targeted patch costs one PR into `main` and one squash merge-back into
  beta, not a qualification.
- The candidate run's log names the carried paths (a `console.info` in the
  candidate case), so the stable run's record lists what was carried.
- The owner's decision section is public, so it states scope only, never a
  finding under embargo.
- The next qualified stable must delete the declaration, and it cannot ship
  until it does.
- From the next carry-forward on, the gate files are frozen, so a change to
  the rule itself needs a qualified stable or a new owner decision and ADR.

## Verification

- The eight first [host] cases in `traceability.test.ts` were written before
  the rule. On the previous `binding.ts` the file does not load, and with the
  exports present but no rule (mutant M00) seven of the eight are red. All pass
  with the rule.
- Each guard rail of the candidate rule was mutated in turn, and each turned a
  case red: 50 mutants of the first rule (M00 to M50 less one superseded) and
  29 of the review and attack fixes (R01 to R29: the spaced phrase, the numstat
  parse, the counted paths in both directions, the line-length check and its
  constant and parser, the neutral allowlist in both directions, the committed
  read in four ways, the case-variant and plain-file checks, the gate-file
  freeze and its detection and list, the raw-text skip search, the three
  branches of the scanner's regular-expression guess, a change of major alone,
  and the second entry, file and case).
- A second round mutated the packaging proof's helper (9 mutants, P01 to P09:
  a bare folder, an exclusion read as an inclusion, a `*` across folders,
  extra resources, per-platform entries, an unreadable glob, a moved app root,
  an import by the build config, a reference from `src/`) and the shared scan
  and 5a (7 mutants, X01 to X07: a same-named file in another folder refused
  again, a case variant accepted or matched case-sensitively, a missing
  declaration reported present, a link accepted, the run conclusion gating
  again, a run still in progress accepted). Each turned a case red; X01 to X03
  and X07 turned both the suite's and the gate's tests red, which shows the
  scan is shared. They supersede G05 and G45 to G47 below.
- Check 5 was mutated in turn (55 mutants, G00 to G54, covering the ci.yml run
  and jobs, the paging, the parents, the exact marker number, the comment
  limit, the published release, the committed read and the `main()` wiring),
  and each turned a case of `tests/unit/scripts/release-gate.test.ts` red, as
  did removing either needed permission from the `gate` job or adding
  `checks: read` back (3 mutants).
- The candidate case itself is the real proof: green on the release branch's
  three Test legs once the declaration is committed, and red until then.
