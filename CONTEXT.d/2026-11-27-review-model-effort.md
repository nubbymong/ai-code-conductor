## 2026-11-27 -- codex_review and claude_review take a model and an effort; every result names what ran

Plan 2.1.3-beta.20, phase 1 (nubbymong/aicc_planning#446). Decision: ADR-031.

- **Tool input.** Both tools take optional `model` and `effort`
  (`reviewArgsSchema` and `reviewToolShape`, src/main/codex-review-mcp-tool.ts).
  Each parameter's description lists the values it takes, from the registry as
  it stands when the tool is offered.
- **Allow-lists in main, when the review runs.** `chooseCodexReview` and
  `chooseClaudeReview` read the lists from the model registry (`getRegistry`,
  injectable as `ReviewToolDeps.registry`) before anything is read, leased or
  run. Codex: the Codex picker's models (the installed Codex's list once read)
  and CODEX_EFFORTS less none, each one the model runs. Claude: the registry's
  Claude ids and aliases (first character a letter or digit) and the levels the
  model supports. A value off a list is refused with the list.
- **Argv.** `codexReviewArgs` (cli-runner.ts) adds `-m <id>` just before the
  effort override and sets that override's level; `claudeReviewArgs`
  (claude/review.ts) appends `--model <id>` and `--effort <level>`. Each checks
  the values' form again (the list is main's), and `PLAIN_ARG` holds every
  element as before. With nothing chosen the argv is the constant, word for
  word: 2.1.3-beta.19's.
- **Review round 1 (no default `-m`).** The first build named the installed
  Codex's first listed model with `-m` when no model was chosen. That list is
  the catalogue built into the binary, read signed out (model-catalogue.ts),
  not the account's own, so its first model is not known to be the account's
  default. A Codex review with no model chosen now passes no `-m` (beta.19's
  argv, pinned end to end through the real adapter) and its footer says "the
  reviewer account's default model, not named". Naming the default later
  needs a read of the account's own list.
- **Environment (Q1, kept).** `claudeReviewEnvironment` reads `ANTHROPIC_MODEL`
  and `CLAUDE_CODE_EFFORT_LEVEL` from the prepared launch's environment (any
  spelling on Windows). A review with no model chosen reports the variable's
  model as `environment`; a chosen effort is refused while the effort variable
  is set, since it comes before `--effort`.
- **Footer and log lines.** `<name> review on <model> (<source>...), effort
  <level> (<source>...)`, then the usage as before; a log line before the run
  and one after it (with what the CLI reported). Claude Code's model comes from
  its result's `modelUsage` keys (`parseClaudeResult`, `reportedModels` on
  `ReviewRunResult`), several listed as reported; without them the footer says
  "requested, not confirmed" (or "not confirmed" for the default). Review
  round 1: an effort nothing confirms (Claude Code's always, Codex's when no
  model is named) is said as "requested, not confirmed", and a reviewer that
  never started names no model. That field was read from the CLI's
  documented result shape; it has not been checked against a live 2.1.278 run
  on this host (no real CLI runs here), so the VM line of 6.2.1 should look at
  a real footer.
- **Contract.** `ReviewRunInput` gains `model` and `effort`, `ReviewRunResult`
  gains `reportedModels` (providers/core/package.ts), so the helper path
  (beta.21) carries them unchanged. No helper change in this phase.
- **Text.** The Feature Guide's code review card (src/shared/app-knowledge.ts)
  and both tool descriptions say what can be chosen, the defaults, and that the
  footer names what ran. The changelog entry is left to the cut.
- **Owed before stable.** The ADR-009 pass on this change (pre-stable list,
  aicc_planning#320), per the 15 Nov rule.
