## 2026-11-21 -- The update check names the offered version in full (aicc_planning#369)

Fixed in the 2.1.3-beta.11 release PR, with the test carried from the final-head
re-review of #750. Display only.

**Before.** On the beta channel, Settings, General, Check for Updates offered a
beta as "Update available -- v2.1.3", next to "Installed: v2.1.3-beta.9 (beta)",
so a beta offer read as the stable release. The footer's Update pill named only
the installed version.

**Cause.** `update:getVersion` answered `ReleaseInfo.version`, and
`parseVersion` (src/main/github-update.ts) strips the prerelease part from it.

**Decision: add a field, change none.**
- `ReleaseInfo.version` is kept exactly as it was. The log lines in
  github-update.ts and ipc/update-handlers.ts and the existing tests read it.
  Ordering reads the tag through `compareTags`, never this field. No store keeps
  a skipped version, and the installer name comes from the release's asset.
- `ReleaseInfo` gains `displayVersion`: the tag without its leading v
  (2.1.3-beta.11, 2.1.3-rc.1, 2.1.3). `update:getVersion` answers it, falling
  back to `version`.
- In the renderer, `formatUpdateOffer` (src/renderer/utils/versionLabel.ts) is
  the one label for the Settings line and the footer pill's tooltip. With no
  version named (the dev source watcher, or a call that fails), the tooltip is
  as before. The update dialog and the Updating overlay name no version.
- No new IPC channel or preload method. The download and its digest checks read
  `tagName` and `installerName`, as before, so the updater's verification path
  is unchanged. The display is built on the main side because only main has the
  tag.

**When it shows.** From 2.1.3-beta.11 on. An update offered to 2.1.3-beta.10 is
shown by beta.10's own screen, which still reads "v2.1.3".

**The macOS CI leg.** The first push was red there only: a 2.1.3 tag carries the
macOS 13 floor (resources/macos-release-floors.json), and the test's release had
only the old-style Mac download name, which the updater refuses for a release
with a floor, so a Mac was offered nothing. The three cases now give the
release the floored Mac download, report macOS 15, and ask twice: on the host
and as a Mac, so a Windows run sees the Mac half fail too.

**Carried test.** tests/unit/renderer/codex-models.test.ts gains the case where
a model's own versions name every supported version, so a new config starts on
the head of the list; replacing `versions.every(...)` in `idsEveryCodexLists`
with `false` turns it red. Its WP1 matched line count moved from 42 to 43.

**Owed.** Recorded on the ADR-009 list before stable (aicc_planning#320), failing
closed because it edits an IPC handler file.
