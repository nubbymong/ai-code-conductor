# Owner decisions, 2026-10-17: 2.1.2, a targeted stable patch

This record supplements `owner-decisions-2026-10-13.md`. It records the
owner's decision of 2026-10-17 on how 2.1.2, the macOS fix for headless
Claude Code runs started when the app is opened from the Dock or Finder,
ships. ADR-027
(`architecture/decisions/2026-10-17-adr-027-a-targeted-stable-patch-carries-wp1-evidence-forward.md`)
is the gate rule this decision uses, and `tests/wp1/carry-forward.json` cites
section CF1 as its approval.

The owner's words are quoted as given in chat on 2026-10-17. The choices the
coordinating agent made inside that decision are recorded separately, as the
agent's, not the owner's.

## CF1. 2.1.2 ships as a stable patch, with the 2.1.1 evidence carried forward on a declared file list

**The owner's words.** On 2026-10-17 the owner said, verbatim: "We should not
need a beta, this is a targeted fix", and named the version 2.1.2.

The owner was then asked, verbatim: "How should 2.1.2 (the macOS PATH fix)
ship?" The owner chose the option "Stable, new fast rule (Recommended)", whose
description read, verbatim: "Same day. Add a recorded rule: 2.1.1's evidence
carries forward when the only code changes are a declared small file list with
named regression tests and green CI on all 3 OSes. Needs an ADR and an
adversarial pass on the gate change."

**What that decides.** 2.1.2 is cut from 2.1.1 (`v2.1.1`, commit
9ca0f0e0f4231ff3d83402dc1a39036c5200ac00) as a stable release, with no beta.
The WP1 evidence 2.1.1 shipped on, bound at boundHead
d1525759a7a42d941beeff601af3415fddd8afdd, is carried forward to 2.1.2 under
ADR-027: the candidate check holds it on the declaration in
`tests/wp1/carry-forward.json`, which names each changed file and its
regression tests; the release gate requires CI's Test run green on Windows,
macOS and Linux on the released commit, and an ADR-009 PASS on the PR that
merges it. Nothing in the evidence files or the manifest is edited, and no
evidence is retaken for 2.1.2 beyond the automated suite and the Mac runtime
check on the PR's build.

**The coordinating agent's choices, not the owner's.**

- The 2.1.1 security record (the commit that published it on beta) is carried
  onto the 2.1.2 branch, so the 2.1.1 entry in 2.1.2's changelog, and so its
  What's New history, carries those security lines. The changelog file is
  declared below in any case.
- The declared list is whatever the final diff since boundHead is, file by
  file, rather than a list fixed in advance.
- Adding the 2.1.2 changelog entry broke two tests that read the real
  changelog: one assumed 2.1.1 is the newest entry, and one required curated
  What's New lines for the newest release. The implementing agent changed both
  tests rather than add a curated What's New line, which would have meant two
  more declared files (17, over the cap of 16). 2.1.2 is named there as a
  fixes-only release, so its What's New page shows the fixes line, as the
  existing fixes-only cases already expected for 2.1.2.

**The files carried forward** (every file 2.1.2 changes outside the
binding-neutral paths, each with its regression tests in the declaration):

- `src/main/claude-headless.ts`
- `src/main/claude-cli-probe.ts`
- `src/main/claude-cli-version.ts` (comments only)
- `tests/unit/claude-headless-posix-path.test.ts`
- `src/renderer/changelog.ts`
- `package.json` (version only)
- `package-lock.json` (version only)
- `tests/unit/shared/app-knowledge.test.ts`
- `tests/unit/renderer/whatsnew-showcase.test.tsx`
- `tests/wp1/binding.ts`
- `tests/wp1/traceability.test.ts`
- `tests/wp1/carry-forward.json`
- `scripts/release-gate.mjs`
- `tests/unit/scripts/release-gate.test.ts`
- `.github/workflows/release.yml`

**Scope only.** This section is public and names scope, not findings. The
packaged, real-CLI and manual evidence is carried, not retaken (ADR-027,
"Limits"); the one packaged check taken for 2.1.2 is the Mac runtime check of
the PR's build under a test user.
