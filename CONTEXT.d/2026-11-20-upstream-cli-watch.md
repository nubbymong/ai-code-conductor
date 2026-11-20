## 2026-11-20 -- CI: a daily watch checks each new Codex and Claude Code release against the conformance jobs

Ticket aicc_planning #368 (premise reviewed when filed; one gap found since and designed around, below).

- What it does. Once a day (cron 41 05 UTC) the new workflow
  .github/workflows/upstream-cli-watch.yml looks up the newest published Codex
  and Claude Code with `npm view <package> version` (the way the app's own install
  recipes install them). When one is newer than the newest version the app was
  tested with, and is not already recorded green, it dispatches ci.yml on beta
  with that version and waits for the run. On any red job the watch run itself
  fails, and its job summary names the CLI, the version, each failing check and
  the ci.yml run link, so the normal Actions failure notice reaches the owner.
  The logic is scripts/ci/upstream-cli-watch.mjs (npm, gh, files and the clock
  injected, tests/unit/scripts/upstream-cli-watch.test.ts); the workflow only
  calls it.
- The gap. GitHub runs a schedule, and a dispatch of a workflow file, only from the
  default branch's copy of the file, and the default branch is main. A schedule
  merged to beta does not fire until the file reaches main (the next promotion).
  So the workflow is the same file on both branches, checks beta out itself, and
  dispatches ci.yml with `--ref beta`. To start it sooner, the one file would have
  to be landed on main on its own (the owner's call). If the dispatch is refused, the failure text says where to look: a dispatch is checked
  against the copy of ci.yml on the ref it names (beta), not main's copy.
- Where "tested up to" lives. Codex: CODEX_MAX_TESTED_VERSION in
  src/main/providers/codex/cli-contract.ts. Claude Code: the app declares none (the
  provider says "No tested CLI version range is declared yet"); the only version its
  evidence names is the managed-launch floor, CLAUDE_MIN_MANAGED_CLI_VERSION in
  src/main/providers/claude/managed-launch.ts. That is the baseline, so the newest
  Claude Code is checked until the record holds it green. Raising a Claude Code
  tested-up-to number on that evidence is a separate decision, not made here.
- Claude Code legs (ci.yml had none). New input `claude_rc_version` and job
  `claude-conformance`, run only on a dispatch that sets the input: two legs per OS
  (the app's floor and the dispatched version), no sign-in, no secret. The CLI is
  installed from its platform package with `--ignore-scripts`, so no install script
  runs. It checks: the install answers `--version` with the version asked for and the
  app's own reader and floor check accept it; `claude --help` lists every switch of
  the reviewer's constant command line (CLAUDE_REVIEW_ARGS) and `--output-format`
  still offers json; `--permission-mode` offers every mode the launch picker
  writes; `claude auth` lists login, logout and status and `claude auth login`
  lists the three sign-in methods and `--email`. NOT driven (each needs a sign-in, a
  model call or a live session): the hooks run against a real Claude, the statusline
  and transcript shapes, and the authority census (a maintainer tool that compares
  with one pinned Windows binary byte for byte).
- De-duplication and record. Each run leaves `record.json` as the artifact
  `upstream-cli-watch-record`; the next run reads the newest earlier run's record
  (green or red runs alike, cancelled ones are skipped; the record is read only from
  the watch's own scheduled or manually started runs). A version recorded green is
  not run again; a red one is run again the next day. Nothing is committed, pushed
  or written to a repository variable.
- Reading the dispatched run. A leg counts as passed only when it also ran its install
  step for the version asked about (`Install <CLI> <version> into its own prefix`), so a
  ci.yml run someone else started for another version is never taken for the watch's own.
  One failed read while waiting is tried again (five in a row give up, and the summary
  then links the ci.yml run). A run that does not finish in time is red and still names
  each leg that failed or is still running.
- Ticketing into aicc_planning is optional and dormant. The default token cannot
  write to that private repository and no secret exists. If a secret named
  AICC_PLANNING_ISSUES_TOKEN is set, the last job opens or updates ONE issue per
  failing CLI version (found by its exact title first); without it, one line says it
  was skipped.
- Safety. Least privilege per job (plan: contents and actions read; check: actions
  write, only because it dispatches; ticket: contents read), actions pinned by
  commit, no `pull_request_target`, no expression in a run line (every value comes
  through env, and a version string is checked against a strict semver pattern
  first), one concurrency group so two watch runs never overlap.
- WP1 legacy-codex gate: manifest and ledger regenerated; six new rows (the new
  files that name Codex), and the ci.yml row's evidence extended.
