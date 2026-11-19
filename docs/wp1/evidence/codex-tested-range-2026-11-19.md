# The newest tested Codex raised to 0.157.1 (2.1.3-beta.11, aicc_planning#185)

The evidence for moving `CODEX_MAX_TESTED_VERSION` (`src/main/providers/codex/cli-contract.ts`) from 0.156.1 to 0.157.1. The minimum (0.153.4) and the pinned version (0.155.1) did not move.

It is a file of its own, not new rows in `ci-matrix.md`: that file is the 2.1.1 record, bound by its sha256 to the WP1.30 evidence record taken at the 2.1.1 head (`tests/wp1/traceability.json`), and a row added there would re-sign that record at a head it was not taken at. The job, its checks and its columns are the ones `ci-matrix.md` describes ("The real-CLI conformance job").

## The runs

Both were `workflow_dispatch` runs of `ci.yml` on `beta` at 32fb8b36ea5d35bf35cf1c3ab97d9f2b24527436 (tree d84ec544fe25a15988d753efe6755b9d321fd132), attempt 1, on 2026-11-19, with `CCC_CODEX_HELP_ASSERT` = 1 and no prove-red input. Commands: `gh workflow run ci.yml --ref beta -f codex_rc_version=0.170.0` and `gh workflow run ci.yml --ref beta -f codex_rc_version=0.157.1`; each job read with `gh api .../actions/jobs/<id>` and its log.

The versions were npm's `latest` for `@openai/codex` that day (0.170.0, read from the registry's dist-tags) and 0.157.1, the Codex on the test VM. The decision line was written before either log was read: a version whose every conformance check is green on Windows, macOS and Linux may become the newest tested version; a red check leaves the range below it.

| Run | OS | Version class | Version | Job | Detection | Flags | Model list | Features | Help | Flag-drift suite | Own home untouched |
|---|---|---|---|---|---|---|---|---|---|---|---|
| CI run 44530382595 (conclusion success) | Windows (win32-x64) | rc | 0.157.1 | 135581803839 | Both cases found, version 0.157.1, too-new under the range at that commit (up to 0.156.1); `codex.cmd` | Every flag defined, each in its subcommand help | 7 ids (gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5); covered by the registry; no recorded list for 0.157.1 | 149 listed; the 14 the analysis turns off all named; the review, analysis and Insights runs' settings load | 15 captured; no fixture for 0.157.1, none compared | 5 passed | Yes |
| CI run 44530382595 | macOS (darwin-arm64) | rc | 0.157.1 | 135581802958 | Both cases found, version 0.157.1; `codex.js` | Every flag defined | 7 ids; covered; no recorded list | 149 listed; the 14 all named; settings load | 15 captured, none compared | 5 passed | Yes |
| CI run 44530382595 | Linux (linux-x64) | rc | 0.157.1 | 135581803639 | Both cases found, version 0.157.1; `codex.js` | Every flag defined | 7 ids; covered; no recorded list | 149 listed; the 14 all named; settings load | 15 captured, none compared | 5 passed | Yes |
| CI run 44530382595 | Windows / macOS / Linux | minimum / pinned | 0.153.4 / 0.155.1 | 135581803474 / 135581803559; 135581803731 / 135581803373; 135581803499 / 135581803824 | Every step green, as at the 2.1.1 head: found, supported; the model list equal to the recorded list; help asserted against the fixtures | | | | | | |
| CI run 44530368458 (conclusion failure) | Windows (win32-x64) | rc | 0.170.0 | 135581757079 | Both cases found, version 0.170.0, too-new; `codex.cmd` | Every flag defined | Red: 11 ids, 4 not in the registry (gpt-6.2-sol, gpt-6.2-astra, gpt-6.1-terra, gpt-6.1-sol) | 215 listed; the 14 all named; settings load | 15 captured, none compared | Not run (skipped after the red step) | Yes |
| CI run 44530368458 | macOS (darwin-arm64) | rc | 0.170.0 | 135581756896 | Red: the app's runner found version 0.170.0, but the app's own PATH resolution found `bin/codex.js` and its discovery read no version it recognises (state invalid) | Every flag defined | Red: its discovery by PATH failed the same way, so no list was read | 215 listed; the 14 all named; settings load | 15 captured, none compared | Not run | Yes |
| CI run 44530368458 | Linux (linux-x64) | rc | 0.170.0 | 135581756850 | Both cases found, version 0.170.0, too-new; `codex.js` | Every flag defined | Red: the same 4 ids not in the registry | 215 listed; the 14 all named; settings load | 15 captured, none compared | Not run | Yes |
| CI run 44530368458 | Windows / macOS / Linux | minimum / pinned | 0.153.4 / 0.155.1 | 135581756738 / 135581756754; 135581756958 / 135581756999; 135581757073 / 135581756829 | Every step green | | | | | | |

## What it shows

0.157.1 passed every check on all three systems and is the newest tested version. 0.170.0 did not, and stays too-new. Its two red checks, the model list on every system and the PATH detection on macOS, are a difference between that Codex and what the app reads from it; they go on aicc_planning#185, for a later beta, when this change merges. Versions between 0.157.1 and 0.170.0 were not run.

The model catalogue (`resources/codex-model-catalogue.json`) adds 0.157.1 to the versions it was read from. Read from `codex-rs/models-manager/models.json` at the rust-v0.157.1 tag, 0.157.1 lists the same seven models as 0.156.1, with the same labels, effort levels and order, and the real CLI listed the same seven ids above.

What CI cannot show: a Codex account's usage reading on 0.157.1 needs a signed-in account, which CI does not have. The app-server usage schema of 0.157.1 is the one already checked (`tests/fixtures/codex/app-server/0.157.1/usage-schema.json`), and the owner's test of the release checks the reading itself.
