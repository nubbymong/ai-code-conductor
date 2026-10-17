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
only the login shell names. The fix is about 100 lines in three files under
`src/main/`. Under the binding as it stood, any such change breaks the second
half, and the only honest way back is to requalify all 73 items, which takes
days of Windows VM, Mac and Linux sittings.

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

**The candidate check** (`carryForwardProblems` and `bindingVerdict` in
`binding.ts`) replaces only its final assertion. Everything before it runs as
before: nothing planned, every record digest-bound and taken at `boundHead`,
and `boundHead` an ancestor of HEAD. With no declaration the final assertion
is the one before this ADR, with the same message. With one, every rule fails
closed:

1. A declaration that is not valid JSON of its schema fails; it is never read
   as absent.
2. Its `targetVersion` must be `package.json`'s version, or it is stale and
   must be deleted. This stops it lingering into the next qualified stable or
   being reused by editing one field.
3. The target is a stable `x.y.z`, the next patch after a stable base of the
   same major and minor, and `base.tag` is `v<base.version>`.
4. `base.commit` is an ancestor of HEAD (undecidable in a shallow clone fails
   with the fetch hint), its `package.json` is `base.version`, and its manifest
   is a candidate bound to this `boundHead`, which `base.boundHead` names too.
5. The list is exact: every changed non-neutral path is declared, nothing else
   is, each by its exact repository path (no glob, pathspec, `..` or
   backslash), once, and no neutral path pads it.
6. Each path names one or more tests vitest collects (not native, not e2e),
   present and not empty, with no unconditional skip, todo or focus anywhere in
   their code (`skipIf` and `runIf` are allowed), holding every named case as
   the title of a bare `it(` or `test(` call. Titles are found in the code,
   not in comments or strings.
7. `package.json` and `package-lock.json` may change their version fields and
   nothing else.
8. At most 16 paths, and at most 400 lines added plus deleted outside `tests/`
   since `boundHead`; a binary file fails. The caps are constants in
   `binding.ts`, never fields of the declaration, and count from `boundHead`,
   so chained patches add up until a qualification resets them.
9. The approval is a dated owner-decisions record under `docs/wp1` whose own
   section names the version, says the evidence is carried forward, and names
   every declared path, outside code fences and HTML comments.
10. `adversarial.pr` always names the PR whose ADR-009 pass covers the diff,
    whether or not a path is on the adversarial-review path table. A
    carry-forward swaps 73 items of independent evidence for an author-written
    list, which is the self-review ADR-009 exists to prevent, and the first one
    also lands the gate that judges it.

`BINDING_NEUTRAL` and `bindingBreaks` are unchanged, and a case pins
`BINDING_NEUTRAL` by value. The declaration has no field that feeds the neutral
rules, item statuses or `UNAVAILABLE_ELIGIBLE`.

**The release gate** adds check 5 (`evaluateCarryForward`). It applies only
when the declaration's `targetVersion` is the version being cut, and every
other cut makes no new call. On the commit being released (`GITHUB_SHA`) it
requires:

- (a) CI's `Test (<os>)` runs from GitHub Actions on Windows, macOS and Linux,
  each completed and green. The release workflow itself blocks on the Windows
  leg only (the Linux leg is non-blocking and the Mac job runs no tests), and
  the fix's own regression cases skip on Windows, so this check is what makes
  "green on all three" a precondition.
- (b) The declared PR merged as that commit, and the latest ADR-009 verdict
  marker an owner, member or collaborator posted on it is a PASS at the PR's
  final head. A push after the pass needs the marker posted again.
- (c) The base tag points at `base.commit`, with an annotated tag dereferenced
  once. The suite only proves that `base.commit` looks like the previous
  candidate; this ties it to the tag.

A GitHub read error, or a caller that gives no reader, cannot be evaluated,
which also refuses the cut. The `gate` job gains `checks: read` and
`pull-requests: read`.

## The readers of the declaration

| Reader | What it reads | Change |
| --- | --- | --- |
| `tests/wp1/traceability.test.ts` | the whole declaration, in the candidate case | the cases below |
| `tests/wp1/binding.ts` | the declaration, given by the test | the rules above |
| `scripts/release-gate.mjs` | `targetVersion`, `adversarial.pr`, `base.tag`, `base.commit` | check 5 |
| `tests/wp1/phase.ts`, `scripts/wp1/fetch-ledger-commit.mjs` | not the declaration | none |

## What it cannot do, and what it relies on

- It re-proves every automated item on three operating systems at HEAD,
  because the whole suite runs. It does not retake real-CLI, packaged or
  manual evidence (packaged smoke, the real-CLI matrix, rollback). Each path's
  `why`, and the owner's decision, say why the change does not touch them. The
  Mac runtime check of the PR's build under a test user is the one packaged
  check taken.
- Named cases are proven to exist, not to have run, and conditional skips are
  allowed. "Ran and passed" rests on check 5(a) (the macOS leg) and on the
  ADR-009 pass showing each regression case red without the fix.
- The first carry-forward lands the gate code that judges it, so it certifies
  itself. That is mitigated by the PASS on the PR that holds both, by the
  owner-listed paths, and by the mutants below.
- The gate checks the shape of the approval, not its meaning, as ADR-026 does.
- The caps are cumulative from `boundHead`. 2.1.2 uses 15 of the 16 paths and
  315 of the 400 lines, so a further patch on the same binding has room for
  very little, and then the next stable requalifies. That is intended.
- The declaration is a standing exception while it exists. The stale rule makes
  the next qualified stable fail until `tests/wp1/carry-forward.json` is
  deleted; the next qualification's checklist must say so.
- The test-title scanner reads enough of JavaScript's lexical grammar to tell
  code from comments and strings. Where it guesses (a `/` after a closing
  bracket is read as division) it can only miss a case, never invent one.

## Verification

- The eight [host] cases in `traceability.test.ts` were written first. On the
  previous `binding.ts` the file does not load, and with the new exports
  present but no rule (mutant M00) seven of the eight are red. All pass with
  the rule.
- Each guard rail of the candidate rule was mutated in turn (51 mutants, M00 to
  M50) and each turned a case red: the schema and invalid JSON; the stale
  rule; the patch, line, prerelease and tag rules; `base.boundHead`, ancestry,
  undecidable ancestry, the base `package.json` and the base manifest's phase
  and `boundHead`; the reason; undeclared, padded and neutral paths, the exact
  path rule, duplicates and both list bounds; `why`, a missing test, a file
  vitest does not collect, a native test, a test path with `..`, an empty test
  file, an unconditional skip, the skip rule read over comments, a missing
  case, the title format and titles read from raw text; the version-only rule
  (removed, and loosened to drop dependencies); the line cap (by rule, by
  constant, binaries and tests counted); the approval's version, phrase, paths,
  whole-path match, section and format; `adversarial.pr` at 0 and as a string;
  the declaration made neutral; the absent case; and an empty file read as
  absent.
- Check 5 was mutated in turn (33 mutants, G00 to G32) and each turned a case
  of `tests/unit/scripts/release-gate.test.ts` red, as did removing either new
  permission from the `gate` job (2 mutants).
- The candidate case itself is the real proof: green on the release branch's
  three Test legs once the declaration is committed, and red until then.
