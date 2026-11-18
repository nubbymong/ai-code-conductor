## 2026-11-18 -- Codex review on the account's default model; more agent features off for background Codex runs

Plan 2.1.3-beta.8, section C1.

- **Review model.** The Codex review run (`ARGS.review`, src/main/providers/codex/cli-runner.ts) no
  longer passes `-m`: it runs on the reviewer account's default Codex model, as the analysis and
  Insights runs already did. It passes `-c model_reasoning_effort=medium`, so its reasoning effort
  stays what it was. No review model setting or picker was added, and saved session configs are not
  migrated (the existing GPT-5.5 known issue in app-knowledge covers them).
- **More agent features off.** The review, analysis and Insights runs also pass
  `--disable multi_agent_v2`, `--disable sleep_tool` and `-c agents.enabled=false`. Both supported
  CLIs list both features (tests/fixtures/codex/cli/0.153.4 and 0.155.1, help/features-list.txt),
  and both define `agents.enabled` as a boolean in their config (upstream
  codex-rs/config/src/config_toml.rs and codex-rs/core/config.schema.json at the rust-v0.153.4 and
  rust-v0.155.1 tags, read on 2026-11-18).
- **Text.** The `codex_review` tool description and a types.ts comment no longer name a model; the
  Feature Guide's code review card says a Codex review runs on the reviewer account's default
  Codex model.
- **Pinned copies moved with the argv.** tests/wp1/cli-discovery.test.ts, the wp1 fake CLI
  (tests/wp1/fake-cli.test.ts) and its oracle entry (tests/wp1/fake-cli/oracle.json,
  exec-json-review) hold the review argv word for word, and were updated with it.
- **Not covered by CI.** The real-CLI conformance suite checks each flag against the subcommand's
  help and the analysis run's feature names against `codex features list`; it does not run `exec`
  with the `-c` keys, so a `-c` key's acceptance is shown by the upstream schema above and by a live
  review (the owner's test), not by CI.
- **Owed before stable.** ADR-009 pass (aicc_planning #320 list): the CLI argv of the three
  background runs.
