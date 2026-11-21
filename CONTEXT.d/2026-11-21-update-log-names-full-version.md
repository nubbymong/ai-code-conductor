## 2026-11-21 -- The update log lines name the offered version in full (aicc_planning#379)

Follows aicc_planning#369 (see 2026-11-21-update-offer-names-full-version.md),
which fixed what the user sees and left the log lines on the base version.
Logging only.

**Before.** The beta.12 post-publish check read "Update available: v2.1.3" in
the log while Settings showed v2.1.3-beta.12, so a log could not say which beta
was offered.

**Change.** Three log strings now name the full label (the tag without its
leading v, prerelease part kept):
- `[github-update] Update available: v<label> (tag: ...)` and
  `[github-update] Skipping v<label> (tag: ...)` in src/main/github-update.ts,
  from `displayVersionOf(best.tag)`.
- `[update] Latest GitHub release: v<label> (channel: ...)` in
  src/main/ipc/update-handlers.ts, from `displayVersion`, falling back to
  `version` when a release carries none.

`ReleaseInfo.version` is unchanged (still the base version), so ordering, the
download path and the installer checks read exactly what they read before. The
comments that said the logs use the base version now say they do not.

**When it shows.** From 2.1.3-beta.13 on, in that build's own log. The app that
logs the offer of beta.13 is beta.12, with the old line, so the first post-publish
check that can read the new line is beta.14's: "Update available: v2.1.3-beta.14"
in the beta.13 app's log.

**Tests.** tests/unit/github-update.test.ts (the offer line for a beta, an rc and
a stable release, each on this host and as a Mac; the skip line) and
tests/unit/main/update-handlers.test.ts (the re-check line for the same three,
and the fallback to the base version). Five of them fail against the old code.

**Owed.** ADR-009 pass before stable (aicc_planning #320 list), failing closed
because it edits an IPC handler file: three log strings only.
