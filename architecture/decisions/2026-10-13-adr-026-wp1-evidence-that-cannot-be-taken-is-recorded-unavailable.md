# ADR-026: WP1 evidence that cannot be taken is recorded as unavailable, on a recorded owner decision

- Status: Accepted (the owner approved the 2.1.1 stable plan on 2026-10-13. Its rule 10.6 takes option (d) of checklist decision D-new2)
- Date: 2026-10-13
- Tracker: aicc_planning #286
- Amends: the WP1 traceability gate (WP1.70, WP1.73), in `tests/wp1/binding.ts`
  and `tests/wp1/traceability.test.ts`; the text and evidence of WP1.73, the
  evidence WP1.38 cites, and WP1.30's reason and tests (settled points 3 to
  5 below)

## Context

The WP1 gate maps each of the 73 acceptance items to the tests and evidence
that prove it (`tests/wp1/traceability.json`). Before this change, an item read
`planned` or `evidenced`. Once the candidate phase is declared, the gate passes
only when every item reads `evidenced` and every evidence record was taken at
`boundHead`. A stable release declares that phase in the environment of both of
its test steps (`release.yml`, `WP1_PHASE`), and the environment can only raise
the phase (`tests/wp1/phase.ts`). So the manifest cannot switch the check off,
and the stable run refuses a release with any item short of `evidenced`.

Some evidence cannot be taken for 2.1.1:

- The macOS and Linux second-identity parts of WP1.10, WP1.11, WP1.64 and
  WP1.72. A second identity is available on the Windows test VM only.
- Any part whose consent the owner does not give. For example, the disposable
  Claude account (WP1.64) or a macOS test user (WP1.63, and WP1.32 on macOS).

Without a third status there were three ways out:

- a per-row waiver, which goes against the owner's "never waived" directive;
- holding stable;
- setting the item to `evidenced` with part of its evidence missing. That
  would be a false record.

## Decision

1. **A third status, `unavailable`.** It means that everything that could be
   taken is recorded, at `boundHead`, exactly as for `evidenced`. A named part
   could not be taken, on the owner's decision. It records a gap inside the
   bound evidence and never replaces that evidence.

2. **Only eight items may use it.** `UNAVAILABLE_ELIGIBLE` in `binding.ts` names
   them. Their evidence needs something only the owner can give: a real
   provider identity or credential, or a host the owner consents to.

   | Item | Kind | What may be unavailable |
   | --- | --- | --- |
   | WP1.2 | real-cli | a real signed-in session on an OS whose sign-in the owner does not run or consent to |
   | WP1.10 | real-cli | the second identity on macOS and Linux |
   | WP1.11 | real-cli | the native keyring smoke with a second identity on macOS and Linux |
   | WP1.20 | real-cli | the disposable identity for the browser sign-in |
   | WP1.32 | real-cli | the opt-in real installer smoke on a host without consent |
   | WP1.63 | packaged | the packaged smoke on a host without consent (the macOS test user) |
   | WP1.64 | real-cli | the disposable credential-bearing flows (identities, the disposable Claude account) |
   | WP1.72 | real-cli | the native keyring smoke with an ephemeral identity on macOS and Linux |

   No other item may use it. That excludes all 57 `automated` items, WP1.30
   (`ci`), all 6 `document` items, and WP1.71. WP1.71 is a non-secret
   conformance smoke that needs no account and no consent, so the agents can
   always take it on the CI real-CLI job on each OS runner
   (`docs/wp1/evidence/ci-matrix.md`, P4.8). A listed item must also be of kind `real-cli` or
   `packaged`, so editing a listed item's kind in the manifest takes it off
   the list. The list is in `tests/wp1/`, which is not binding-neutral, so
   widening it after `boundHead` breaks the binding. The test proves that each
   of the other 65 items is refused.

3. **What it carries.** An `unavailable` item has
   `"unavailable": { "reason": ..., "decision": ... }`.
   - `reason` says what could not be taken and why. It must be at least 20
     characters, not counting the spaces around it.
   - `decision` is `docs/wp1/owner-decisions-YYYY-MM-DD.md#<ID>`. The earlier
     owner decisions are kept in files of that name, and those of 2026-09-26
     and 2026-09-27 head each decision `## <ID>. <title>` (U1, M2). The file
     must exist and have a `## <ID>` heading, and that heading's own section
     must name the item and say what is unavailable (the word `unavailable`).
     The section runs up to the next heading of level one or two. A heading or
     text inside a fenced code block or an HTML comment does not count.
     `WP1.2` is not matched by `WP1.20`. The gate checks the shape of the
     decision, not its meaning: the owner reviews the section itself at go.
   - A private-tracker number is not accepted as the decision. The public
     repository cannot read it, and the gate must be able to.

4. **Held to every rule of `evidenced`.** In every phase, the item's tests must
   exist and name it, and its evidence files must exist. Each
   `docs/wp1/evidence/` file must have a record with the file's sha256, a
   40-hex head, an actor, a time and commands. At the candidate phase, every
   record must be taken at `boundHead` (`staleRecords`). These are the same
   rules, in the same function (`evidenceProblems`), for both statuses. In
   addition, an `unavailable` item must have a `docs/wp1/evidence/` record, and
   one of its records must cite the decision reference whole: a record that
   cites `#D10` does not cite `#D1`. So the
   gap is stated inside the evidence that is bound at `boundHead`, and not only
   in the manifest.

5. **No stale gaps.** An `unavailable` record on an item of any other status is
   refused. Setting an item back to `evidenced` or `planned` means removing
   the record too.

6. **The candidate check.** It refuses every item that is neither `evidenced`
   nor `unavailable` on a listed item (`incompleteItems`). That covers
   `planned`, any status this gate does not know (`Evidenced`, `unavailable `,
   `waived`), and `unavailable` on an item the list does not name, so the
   check never rests on the separate eligibility case having run. At the
   candidate phase the case prints the `unavailable` items on stdout
   (`WP1 candidate: unavailable on a recorded owner decision: ...`), which
   vitest's default reporter shows for a passing case, so the stable run's log
   names them at go. Its title names them too, which the reporter shows only
   for a failing or slow case.

7. **Gate0 is unchanged** for every manifest that was valid before this
   change and whose statuses the gate knows (today every item reads
   `planned`). The new structural checks run in every phase, but they act only
   on an `unavailable` status or record, or on a status outside
   `ITEM_STATUSES` (`Evidenced`), which the candidate check always refused and
   gate0 now refuses too. A malformed `unavailable` item or a mistyped status
   fails PR CI at gate0, so the problem is not found 25 minutes into the
   stable run.

## The readers of the manifest

| Reader | What it reads | Change |
| --- | --- | --- |
| `tests/wp1/traceability.test.ts` | everything | the cases above |
| `tests/wp1/binding.ts` | items, given by the test | the status rules |
| `tests/wp1/phase.ts` | `phase` only | none |
| `scripts/wp1/fetch-ledger-commit.mjs` | `boundHead` only | none (a case pins that it reads `boundHead` beside an `unavailable` item) |
| `scripts/wp1/legacy-codex-manifest.mjs`, `compare-baseline.mjs`, `mutants.mjs` | not the manifest | none |
| `.github/workflows/release.yml` | nothing; it sets `WP1_PHASE` and runs the suite | none |

## What it cannot do, and what it still relies on

- It cannot mark an automated, ci or document item as satisfied.
- It cannot stand in for evidence. An `unavailable` item that lacks its tests,
  its evidence files or its bound records fails in the same way an
  `evidenced` one does.
- It cannot be added without a decision, recorded in this repository, that
  names the item.
- It is not deferral of anything that could be taken, and WP1.73 now says
  so in its own text (settled point 3 below). A part is either taken at
  `boundHead`, or it is recorded as not takeable with the owner's decision.
  It never covers a part that could have been taken but was not run in time.
  The gate cannot tell "could not" from "did not". The decision record says
  which, and the owner reviews that record and the list at go.
- The manifest, the decision file and the evidence files are all
  binding-neutral, as before. So a commit after `boundHead` could add an
  `unavailable` item together with a decision section and a citing record. The
  check on that is the in/out list at go, which carries the `unavailable`
  items the candidate run prints on stdout.

## Verification

- Four new cases were committed first and failed on the 2.1.1-beta.3 gate
  code (28ec75df), where `binding.ts` has none of these rules. The fifth (the
  evidence rules an `unavailable` item shares with an `evidenced` one) was
  added after the change and shown red by mutant 16, which restores
  28ec75df's `evidenced`-only filter. All passed after. The existing cases and
  the legacy-name gate stayed green throughout.
- The review pass added six rules, each shown red before its fix and green
  after: the candidate check refusing `unavailable` on an unlisted item and a
  decision section that does not say `unavailable` (the final cases on the
  pre-fix `binding.ts`), a citation matched as a prefix, a heading inside a
  code fence and one inside an HTML comment (one mutant each, putting back
  the pre-fix rule), and a mistyped status at gate0 (accepted by the pre-fix
  gate, refused after, on a temporary manifest edit).
- Each guard rail was mutated in turn (19 mutants), and each mutant turned a
  case red. They cover the list, the kind, the reason and its trimming, the
  decision's format, file, heading, section and item boundary, the citing
  record, the stale-record rule, `incompleteItems` in both directions,
  `unavailableIds`, `ITEM_STATUSES`, the evidence filter (put back to the
  `evidenced`-only rule of 28ec75df), and the digest check.

## Settled by the candidate dry run

The candidate dry run on 2.1.1-beta.3 (2026-10-13) asked three questions
of this status, and found one citation that cannot be retaken. The spec and
quality reviews of the answers raised two more items. Each is settled here,
in line with the decision above.

1. **An `unavailable` item's records are bound to `boundHead`, like any
   other item's.** What could be taken is evidence about the qualified
   build only if it was taken at that build. The record is also where the
   gap is stated and the decision cited (point 4), so the statement of the
   gap is bound with it. An item none of whose parts could be taken still
   has its record at `boundHead`, saying that nothing was taken and why.
   This is how the gate already works: `staleRecords` reads every item's
   records whatever its status, and a [host] case pins it for an
   `unavailable` item. No code changes.

2. **What an item's parts are depends on its kind. There is no "evidenced
   with limits".** `evidenced` means every part of the item is recorded.
   - **A real-cli or packaged item.** Its parts are what its text names,
     on every OS its text names (WP1.32 "per supported OS", WP1.63 "on
     Windows, macOS and Linux", WP1.64 "per provider/OS", WP1.71 "every
     applicable OS"). Where the text names no OS, they are taken on every
     OS the release plan gives the item: the per-OS checks in
     `docs/wp1/evidence/release-qualification.md` section 4 and the
     completion plan's section 7 (OD20 D2 and D5). The two-account run of
     WP1.10, for example, is owed on Windows, macOS and Linux. A part not
     taken on one OS is a part not taken. On one of the eight listed items,
     the item reads `unavailable`, and its decision section and its record
     name the part, OS included, that was not taken. On WP1.71, the one
     other item of these kinds, the item stays `planned`, and the stable
     run refuses it.
   - **An automated, ci or document item.** Its parts are what its text
     names, as its tests prove it in CI at `boundHead` on the three OS
     runners, and as each evidence file it cites says it records, that
     file's record bound at `boundHead`. `mode-matrix.md`, for example,
     records the Windows test VM, so WP1.1 and WP1.60 owe the VM run it
     records. A per-OS check that `release-qualification.md` section 4 or
     the completion plan's section 7 gives such an item, and that no file
     the item cites records, is release completion, not a part of the
     item. When that check is not taken, `release-qualification.md`
     section 3 lists it as a known limitation, citing the owner-decision
     section that says why (the approved plan's Q3: everything without a
     consent is recorded "not run"), and the in/out list carries it to go.
     Such a section is never an item's `unavailable.decision`. This covers,
     for example, the API-key sign-in of section 4 row 4 (WP1.22, WP1.23:
     no OpenAI API key) and the macOS and Linux runs of rows 9, 23 and 33
     (WP1.38, WP1.42).
   - **Any item whose own text names a part that its tests and records do
     not prove** stays `planned`, whatever its kind, unless an
     owner-decision section amends its 2.1.1 scope, as U1 in
     `docs/wp1/owner-decisions-2026-09-26.md` amends WP1.5, and the item
     cites that decision file as evidence, as WP1.5 does. The reviews of
     this point found one: WP1.19 (point 6). They also named WP1.30, whose
     premise turned out to be stale (point 5).

   A part the release plan records as "not run" is `unavailable` only on a
   listed item and only when an owner-decision section names it (rule 10.6
   and the consents of the approved plan). The gate cannot read an OS scope
   or an item's text, so this rule is applied by the evidence work and
   checked at go, with the list the candidate run prints.

3. **WP1.73 reads true.** Its text was "All acceptance items block merge;
   real-CLI qualification is not deferred". That is false as soon as one
   real-CLI part is not taken in this release. Such a part is either a
   part of a listed item, recorded `unavailable`, or a per-OS real-CLI
   check of an automated, ci or document item, recorded as a known
   limitation (point 2). Its text in `tests/wp1/traceability.json` is now
   "All acceptance items block merge; real-CLI qualification is not
   deferred, except a part an owner decision recorded in this repository
   says cannot be taken, which is recorded unavailable on an item ADR-026
   lists, or otherwise as a known limitation in release-qualification.md
   section 3, and listed at go".

   The design reviewed under the manifest's `designDigest` (e4d5b99a)
   keeps the old text. As U1 does for WP1.5, the amendment is recorded as
   the owner's decision, in a section of
   `docs/wp1/owner-decisions-2026-10-13.md`, which the evidence work
   commits. It follows from the approved plan's rule 10.6 and its Q3
   consents. WP1.73 cites that file as evidence, so it cannot read
   `evidenced` before the file is there. No automated requirement changes:
   - every item still blocks the candidate check until it reads
     `evidenced`, or `unavailable` on a listed item with its decision and a
     bound record;
   - WP1.73 is a document item, which may never read `unavailable`;
   - its record, `release-qualification.md` section 3, lists the
     `unavailable` items, as the candidate run prints them, and the known
     limitations.

4. **WP1.38 is evidenced by its automated tests at `boundHead`, not by
   the 2026-09-21 probe record.** The dry run also found that WP1.38 cited
   a record that cannot be retaken as it stands. WP1.38 is an `automated`
   item: "Selected/default binding is validated and converted to the exact
   realm env on every launch; ambient poisoning cannot override it". Its
   nine `tests/wp1` files exercise every clause of that text against the
   build under test:
   - the binding is validated, and the named account or else the default
     is chosen: `launch-handoff.test.ts`, `provider-core.test.ts` (the
     binding's shape), `claude-reviewer.test.ts`;
   - it becomes the exact realm environment: `provider-core.test.ts` (the
     realm patch), `launch-handoff.test.ts`, `launch-handoff-pty.test.ts`,
     `review-profile-home.test.ts`, `env-allowlist.test.ts`;
   - on every launch: `managed-launch.test.ts` (no source composes a
     profile-home environment outside the one choke point, and every
     launch through it names itself) and `launch-handoff-pty.test.ts` (no
     PTY without a prepared launch);
   - ambient poisoning cannot override it: every authority variable is
     stripped in any spelling (`provider-core.test.ts`,
     `managed-launch.test.ts`, `authority-manifest.test.ts`,
     `startup-manifest-boundary.test.ts`), the app-owned settings copy is
     sanitised, and the project gate refuses an override
     (`managed-launch.test.ts`).

   They run in CI at `boundHead`: in the 2.1.1 PR's final run on three
   OSes and in both test legs of the qualification and stable runs, which
   run the whole suite, the host-quarantined files included. On every
   runner `authority-manifest.test.ts` checks the generated authority list
   the app ships: its schema, its digest, tamper detection and the
   invariants the strip relies on. Its one other case re-derives the list
   from the pinned Claude Code binary and skips where there is none, which
   is every runner. That case checks for drift in the CLI. It is not a part
   of WP1.38, whose text is about the app.

   `docs/wp1/evidence/claude-settings-isolation-2026-09-21.md` is the
   record the design was built on. Most of it probes Claude Code 2.1.278
   on one host, with harness scripts that were never committed and no
   longer exist, and its first rounds measure a host flag the app no
   longer sets (its Part 9). Its last section also records checks of the
   app itself. The VM gates of 2026-09-23 drove the installed
   2.1.1-beta.1 app, built at c9c908a5, with Claude Code 2.1.280, over CDP:
   gate 1 is the project gate's refusal on a real project, and gates 2a to
   2c are worktree resume and the resume picker. A VM re-check at f2332e39
   then ran a clean managed launch on the rebuilt app; gates 1 and 2b were
   not re-run.

   A retake of the record at `boundHead` was weighed and not chosen, for
   three reasons. Its harness is gone, and rebuilding it with the VM run
   would take 60 to 90 minutes of phase 5. WP1.38's text is about the app,
   and its automated tests cover every clause of it at `boundHead`, the
   project gate's refusal included (`managed-launch.test.ts`). And the
   in-app checks the record holds go beyond that text (resume in a
   worktree, the picker). A retake would have re-run those checks on the
   qualified build, and a re-derivation on the Claude Code that ships
   would have closed the 2.1.278 limit below. Neither is done in this
   release.

   WP1.38 no longer cites the file, so it needs no record. The file stays,
   with a note at its head, as the reason the design is what it is. Two
   limits go into the known limitations of `release-qualification.md`
   section 3:
   - the authority list is derived from Claude Code 2.1.278, and a later
     Claude Code is not re-derived in this release;
   - the in-app project-gate refusal and worktree resume were last run on
     the installed app at c9c908a5 (gates 1 and 2a to 2c) and f2332e39 (a
     managed launch), not at `boundHead`.

5. **WP1.30's text stands; its `reason` was out of date.** The dry run and
   both reviews read WP1.30 ("Windows ACL and Unix mode tests prove
   owner-only realm protection") through its `reason` in the manifest,
   which said the Windows half was deferred while the shared ACL primitive
   was investigated (aicc_planning #103), and that its tests assert no
   permission change on Windows. That has not been true since
   2.1.1-beta.2. Before a managed Codex home is used, the app's owner-only
   folder rule (`src/main/owner-only-folders.ts`) makes the managed root
   and then the home this user's and owner-only, and reads them back. A
   folder that does not read back so is refused
   (`src/main/providers/codex/realm-folders.ts`). The tests that prove it
   run on the Windows runner:
   - `tests/wp1/codex-realm-folders.test.ts` ("Windows: a managed account
     folder is made owner-only and read back before use", and the refusal
     cases after it), with the rule injected;
   - `tests/unit/providers/codex/realm-folders-owner-only-wiring.test.ts`,
     which shows that the app's own composition always gives these folders
     the real rule;
   - `tests/unit/main/owner-only-folders-real.test.ts`, which reads back the
     real rights the rule leaves (exactly the user and SYSTEM, inheritance
     off, owned by the user), also under Constrained Language Mode; and
     `owner-only-folders-native.test.ts`, which proves that mode's route
     through Windows' own programs against an in-memory fake.

   So WP1.30's text is kept as it is. Its `reason` now says what is
   proven, and its tests now list the three `tests/unit` files. It needs
   no owner decision and no known limitation for its Windows half. The
   spec review's proposed rewording ("on Windows they prove no permission
   change is made") would have been false, so it was not made.

6. **WP1.19 is amended only by the owner, or it stays `planned`.** WP1.19
   reads "Cancel, non-zero exit, zero-exit-with-no-binary and
   incompatible-version outcomes are distinct". It is an `automated` item,
   so it may never read `unavailable`. No case in the files it cites
   (`install-recipes.test.ts`, `fake-cli.test.ts`) proves those four
   outcomes distinct. The design that ships is the one ADR-024 (owner
   decision D1, 2026-10-10) set: an install runs in a visible terminal
   tab, the line ends its shell however the command ends, and "whether the
   tool is there is decided by the check, never by the exit code". The
   renderer tests prove that design:
   - Cancel at the confirmation runs nothing
     (`onboarding-codex-setup.test.tsx`, `setup-cli-install.test.tsx`);
   - a command that ends with no CLI found is a failure, never success,
     whatever its exit code. A zero exit is included, which is the design's
     own rule (WP2 plan A9). On the Codex surfaces that is one outcome,
     with the terminal showing what happened
     (`onboarding-codex-setup.test.tsx`,
     `providers-card-install-commands.test.tsx`). The Claude first-run
     screen also names a non-zero exit code (`setup-cli-install.test.tsx`);
   - a CLI found too old, or of a version the app does not support, is
     offered the update, never treated as ready
     (`onboarding-codex-setup.test.tsx`,
     `providers-card-install-commands.test.tsx`);
   - every line ends its shell however its command ends, Ctrl+C included
     (`install-recipes.test.ts`).

   On the Codex surfaces a non-zero exit and a zero exit with no binary are
   one outcome, by ADR-024's design. So WP1.19's text does not hold as
   written, and no test can be added that would make it hold. The owner's
   decision is needed, the U1 precedent (point 2): a section of
   `docs/wp1/owner-decisions-2026-10-13.md` that amends WP1.19's 2.1.1
   scope to the outcomes above. With it, the evidence work points WP1.19's
   tests at the renderer files named here and cites the decision file as
   its evidence. All of those tests exist before `boundHead`, so nothing
   under `tests/` has to change. Without it, WP1.19 stays `planned`, and
   the stable run refuses.

## Consequences

- For each `unavailable` item, the evidence work writes three things. It adds a
  `## <ID>` section, which names the item and says what is unavailable, to a
  dated `docs/wp1/owner-decisions-*.md`. It makes the item's evidence record say what
  was not taken, citing that reference. It sets the item's `status` and
  `unavailable` in the manifest.
- `docs/wp1/owner-decisions-*.md` is public: record the decision and its
  scope only, never an account address or embargoed detail.
- The candidate run's log and the in/out list carry the `unavailable` items to
  the go decision.
- After 2.1.1, an item should leave the list once its evidence can always be
  taken, for example when CI can hold disposable identities.
