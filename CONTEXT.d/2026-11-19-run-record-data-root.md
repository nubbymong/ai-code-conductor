## 2026-11-19 -- app-run.json follows the run's own data root; ssh-program.ts joins the live SSH radius

Two changes in the 2.1.3-beta.9 release PR (#728), besides the release commit.

**Where app-run.json lives (aicc_planning#334).** At start-up the app hands
the session helper's console-hosts mode the record of its run before,
`app-run.json` (`src/main/console-host-leftovers.ts`). That record was written
under the user data folder for every run, and a dev run shares that folder
with an installed app on the same computer. It now follows
`instanceRecordPath` in `src/main/session-helper/install.ts`:
`CCC_E2E_DATA_DIR`, else `CCC_DEV_DATA_DIR` when the app is not packaged, else
the user data folder; a root that is not absolute gives no record, and then
nothing is looked for. The rule moved out of `vision-manager.ts` (#727's
`startedRecordPath`) into that one function, so `vision-started.json` and
`app-run.json` are placed the same way. `docs/remote/helper-protocol.md`
section 15 and `docs/remote/helper-threat-model.md` say where the record is.
Red-first test: `tests/unit/main/console-host-run-record-root.test.ts`.

**The live SSH matrix radius (aicc_planning#331).** Since #724,
`src/main/ssh-program.ts` decides which ssh.exe an SSH session runs, so it
joined the radius list in AGENTS.md, the adversarial-review skill,
`RADIUS_FILES` in `scripts/ci/pr-numbers.mjs` and its test. The list is nine
files.

**Follow-up.** `devSessionDataDir` in `src/main/data-paths.ts` holds the same
root rule; folding the two into one function is aicc_planning#335.
