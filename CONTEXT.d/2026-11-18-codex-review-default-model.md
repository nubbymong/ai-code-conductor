## 2026-11-18 -- Codex review on the account's default model; more agent features off for background Codex runs

Plan 2.1.3-beta.8, section C1.

- **Review model.** The Codex review run (`ARGS.review`, src/main/providers/codex/cli-runner.ts) no
  longer passes `-m`: it runs on the reviewer account's default Codex model, as the analysis and
  Insights runs already did. It passes `-c model_reasoning_effort=medium`, so its reasoning effort
  stays what it was. Every model the recorded 0.153.4 list shows, and every Codex model in
  resources/model-registry.json, offers medium (tests/unit/providers/codex/analysis-features.test.ts).
  No review model setting or picker was added, and saved session configs are not migrated (the
  existing GPT-5.5 known issue in app-knowledge covers them).
- **More agent features off.** The review, analysis and Insights runs also pass
  `--disable multi_agent_v2`, `--disable sleep_tool` and `-c agents.enabled=false`. Both supported
  CLIs list both features (tests/fixtures/codex/cli/0.153.4 and 0.155.1, help/features-list.txt),
  and both define `agents.enabled` as a boolean in their config (upstream
  codex-rs/config/src/config_toml.rs and codex-rs/core/config.schema.json at the rust-v0.153.4 and
  rust-v0.155.1 tags, read on 2026-11-18).
- **Text.** The `codex_review` tool description and a types.ts comment no longer name a model; the
  Feature Guide's code review card says the Codex reviewer runs on the reviewer account's default
  Codex model. The WP2 plan's review command line (docs/wp2/plan.md) carries a dated note that it
  is superseded.
- **Pinned copies moved with the argv.** tests/wp1/cli-discovery.test.ts, the wp1 fake CLI
  (tests/wp1/fake-cli.test.ts) and its oracle entry (tests/wp1/fake-cli/oracle.json,
  exec-json-review) hold the review argv word for word, and were updated with it.
- **The settings in CI.** A new no-sign-in case of the real-CLI conformance suite
  (tests/integration/codex-real-cli-conformance.test.ts, check 6) puts each background run's `-c`
  overrides and `--disable` names in front of `codex features list`, which loads the config with
  them, on the minimum and pinned CLIs on each OS. It must exit 0, and multi_agent_v2 and
  sleep_tool must read off. A value of the wrong type for a key the CLI defines is refused there.
  Codex ignores an unknown top-level config key rather than refusing it (its config denies unknown
  fields only in the schema it generates), so the keys' spelling is pinned by the unit tests
  instead: the `-c` overrides of the review, analysis and Insights runs are each checked exactly. A live
  review is still the owner's test.
- **Owed before stable.** ADR-009 pass (aicc_planning #320 list): the CLI argv of the three
  background runs.
