## 2026-10-12 -- the repository is now nubbymong/ai-code-conductor

- **The rename:** the owner renamed the public repository
  `nubbymong/claude-command-center` to `nubbymong/ai-code-conductor` on
  2026-10-12. GitHub redirects the old web, git, API and release-download links.
- **Installed builds:** every build from 2.1.0-beta.13 onward (stable 2.1.0, the
  2.1.0 release candidates, 2.1.1-beta.1 and 2.1.1-beta.2) asks for the new name
  at its next start and, once the new name answers, saves it and checks for
  updates there from then on (#296). 2.1.1-beta.3 does the same: `DEFAULT_REPO`
  in the updater stays on the old name for this release, and `RENAMED_REPO`
  never changes.
- **References moved to the new name:** the advisory filing script's repository
  and package label, the changelog generator's link base (CHANGELOG.md
  regenerated from it), the URLs the release and promote scripts print, the
  README badge and clone lines, the CONTRIBUTING clone lines, the PRIVACY issues
  link, the issue template's discussions link, the embargo runbook's fork names
  (a fork of an advisory opened before the rename keeps the old prefix), the
  LoopReady skill's two repository lines, and the dev launcher's clean-up match,
  which now matches a clone folder of either name.
- **Left as they are:** test fixtures that parse the old slug, the frozen
  identifiers (npm name, appId, registry keys, data folders), installer file
  names, the workflows (they read `github.repository`), and dated fragments in
  this folder.
- **What's New:** one 2.1.1-beta.3 line says where the project now lives, that
  old links redirect, and to restart the app once if no update shows.
