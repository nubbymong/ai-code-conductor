## 2026-10-13 -- the WP1 evidence gate gains an owner-decided 'unavailable' item status (2.1.1 stable)

- **Why:** the stable release run declares the WP1 candidate phase, which
  passed only when all 73 items read `evidenced`. Some 2.1.1 evidence cannot
  be taken: the macOS and Linux second-identity parts, and any part whose
  consent the owner does not give. That left a waiver, holding stable, or a
  false record. The owner-approved 2.1.1 stable plan (rule 10.6) takes the
  gate change instead. Tracked privately as aicc_planning #286. The decision
  and its guard rails are in ADR-026.
- **What changed:** `tests/wp1/binding.ts` gains `ITEM_STATUSES` (with
  `unavailable`), `UNAVAILABLE_ELIGIBLE`, `unavailableProblems`,
  `incompleteItems`, `unavailableIds` and `evidenceProblems`. The last of
  these is the existing evidenced-file check, lifted out with the same pass
  and fail per rule so that it can be proven on injected files.
  `tests/wp1/traceability.test.ts` holds an `unavailable` item to every rule
  of an `evidenced` one. Its candidate case refuses anything that is neither
  `evidenced` nor `unavailable`, and at that phase prints the `unavailable`
  items on stdout, which vitest shows for a passing case (it shows a passing
  case's title only when the case is slow). The manifest's note describes the third status.
- **Who may use it:** only WP1.2, WP1.10, WP1.11, WP1.20, WP1.32, WP1.63,
  WP1.64 and WP1.72, the real-cli and packaged items whose evidence needs a
  real identity, a credential or a host the owner consents to. No automated,
  ci or document item may use it, and neither may WP1.71.
- **What it carries:** a reason of 20 characters or more, and a decision
  `docs/wp1/owner-decisions-YYYY-MM-DD.md#<ID>` whose `## <ID>` section names
  the item. One of the item's `docs/wp1/evidence/` records cites that
  decision.
- **Gate0:** unchanged for every manifest that was valid before and whose
  statuses the gate knows (today all 73 read `planned`). The new checks act
  only on an `unavailable` status or record, or on a status outside
  `ITEM_STATUSES`, which gate0 now refuses as the candidate check always did. `phase.ts`,
  `fetch-ledger-commit.mjs` and `release.yml` read no status and are
  unchanged.
- **Proof:** four new cases were committed first and failed on the
  2.1.1-beta.3 gate code (28ec75df). The fifth was added after the change
  and shown red by mutant 16, which restores 28ec75df's evidenced-only
  filter. All passed after. Each of 19 mutants of the rules turned a case
  red. The review pass's six added rules (eligibility in the candidate
  check, a whole-reference citation, a section that says unavailable outside
  code fences and comments, and a known status at gate0) were each shown red
  before their fix and green after. The legacy-name gate stayed green
  throughout.
- **Follow-up for the evidence work:** each `unavailable` item needs three
  things: its decision section in a dated `docs/wp1/owner-decisions-*.md`, an
  evidence record that says what was not taken and cites that decision, and
  its `status` and `unavailable` fields in the manifest. The candidate run prints
  these items on stdout (`WP1 candidate: unavailable on a recorded owner
  decision: ...`), for the in/out list at go.
- **Settled by the candidate dry run** (ADR-026, "Settled by the candidate
  dry run"): an `unavailable` item's records are taken at `boundHead` like
  any other item's. There is no "evidenced with limits", and what an item's
  parts are depends on its kind. For a real-cli or packaged item, a part not
  taken on any OS its text, or else its release plan, gives it makes one of
  the eight listed items `unavailable` and keeps WP1.71 `planned`. For an
  automated, ci or document item, the parts are what its tests prove in CI
  at `boundHead` on the three runners and what the evidence file it cites
  records. A release-plan check that no cited file records is a known
  limitation in `release-qualification.md` section 3, not a part of the
  item. An item whose own text names a part its tests do not prove needs
  an owner-decision section amending its scope, or it stays `planned`.
  WP1.73's text now names its exception: a part an owner decision says
  cannot be taken, recorded `unavailable` on a listed item or otherwise as
  a known limitation, and listed at go. As U1 did for WP1.5, the amendment
  is the owner's decision. It is recorded in
  `docs/wp1/owner-decisions-2026-10-13.md`, which WP1.73 now cites.
- **WP1.30 and WP1.19** (ADR-026, settled points 5 and 6): WP1.30's
  `reason` said its Windows half was deferred (aicc_planning #103). It has
  not been deferred since 2.1.1-beta.2, when the app's owner-only folder
  rule started securing the managed Codex folders. So the reason is
  corrected, the rule's tests are cited, and its text stands. No case
  proves WP1.19's four install outcomes distinct, and under ADR-024 a
  non-zero exit and a zero exit with no binary are one outcome on the Codex
  surfaces. WP1.19 needs the owner's amendment, or it stays `planned`.
- **WP1.38 evidence** (ADR-026, settled point 4): WP1.38 no longer cites
  `docs/wp1/evidence/claude-settings-isolation-2026-09-21.md`. Most of that
  record probed Claude Code 2.1.278 with harness scripts that were never
  committed. Its VM gates also checked the installed app at c9c908a5 and
  f2332e39: the project gate's refusal, worktree resume and the picker.
  WP1.38 is an automated item, and its nine `tests/wp1` files cover its
  whole text in CI at `boundHead`. A retake was not chosen: the harness is
  gone, rebuilding it would cost 60 to 90 minutes, and the item's text is
  about the app. The record stays, with a status note at its head. Two
  known limitations go to `release-qualification.md` section 3: the
  authority list comes from Claude Code 2.1.278, and the in-app VM gates
  ran at c9c908a5 and f2332e39, not at `boundHead`.
