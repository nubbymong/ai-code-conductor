## 2026-10-11 -- Updater: the gh fallback asks each gh command only for fields it has

The update check's last fallback asked `gh release list --json` for `assets`,
a field that command does not have (its fields: createdAt, isDraft,
isImmutable, isLatest, isPrerelease, name, publishedAt, tagName), so gh
refused it and the fallback found nothing on every release line since it was
written.

`fetchReleasesGhCli()` in `src/main/github-update.ts` now:
- lists tags with `gh release list --json tagName,isPrerelease,isDraft`;
- keeps the releases the check could offer (`isOfferableTag()`: on the channel,
  a tag `parseTag()` understands, newer than the running version; drafts left
  out), newest first. Off macOS the check always picks the newest of them, so
  only that one is read; on macOS, where a release the Mac is too old for is
  passed over for the next, up to three (`GH_VIEW_LIMIT_MAC`). With nothing to
  offer, no view starts and the log says the fallback found nothing newer;
- reads their downloads with `gh release view <tag> --json
  tagName,isPrerelease,isDraft,assets` (an asset's `url` there is its browser
  download URL, as the direct download and the CHECKSUMS.txt derivation need).

It fails closed: a gh error, output that does not parse, or a view that answers
for a different tag means no update is offered from this leg. Every call names
`activeRepo()`. `checkGitHubRelease()` uses the same `isOfferableTag()` for its
own filter, so the two cannot drift.

Tests: `tests/unit/main/github-update-gh-release-fields.test.ts` (host-safe; gh
is emulated, including its refusal of a field a command does not have). The
pinned list arguments in `github-update-gh-lookup.test.ts` and the two gh
fallback cases in `tests/unit/github-update.test.ts` now answer as gh does.
