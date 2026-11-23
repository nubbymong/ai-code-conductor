## 2026-11-23 -- Codex: an app-launched Codex shows no warning count of the app's making

Section B1F of the 2.1.3-beta.16 plan (aicc_planning #371), added by the orchestrator from B1's
hold. In `src/main/providers/codex/spawn.ts`.

- **The finding (B1's hold, published signed beta.15 on the Windows test machine, Codex 0.157.1).**
  A Codex tab the app started showed `1 warning . f2 to view` on its hint row at rest, and the app
  typed nothing into it: a prompt button answered "not sent (busy-timeout)". F2 named the warning:
  "Running without the shared background server: command-line configuration overrides (-c,
  --enable, --disable, or --search) requires embedded mode." The screen reader refuses a hint row
  with a count on purpose (#371), so no prompt button, canvas note, Ask Conductor question, image
  paste or broadcast reached the tab. With `daemon_auto_start = false` in the tab's Codex config,
  the count went and every press was sent.
- **The cause, read in Codex's source (rust-v0.153.4 to rust-v0.171.0, all 30 releases).** From
  0.156.0 Codex can start a shared background server by itself (the `daemon_auto_start` feature:
  experimental and off by default in 0.156.0 and 0.156.1, on by default from 0.157.0). Any `-c`
  key other than a few it allows (`codex-rs/tui/src/daemon_startup.rs`, `config_exclusion`) makes
  it run without the server (embedded), and every key the app sets is such a key. While the
  feature is on, Codex then also shows that exclusion as a startup warning
  (`codex-rs/tui/src/startup_orchestration.rs`, `daemon_exclusion.filter(|_| auto_start_daemon)`).
- **The fix.** A launch whose own `-c` keys already run Codex embedded now also carries
  `-c features.daemon_auto_start=false` (`codexDaemonAutoStartOffArgs`), last of the app's flags
  and before the user's, on every route: direct, the npm launcher's cmd.exe line, Ask Conductor,
  an exact resume, the resume list (it hands the flags on), and a launch the session helper holds
  (it swaps only the tool server's entries). Codex runs embedded as before, without the warning. A
  launch with no app `-c`, or only keys Codex allows, is unchanged. 0.153.4 to 0.155.1 do not know
  the key, have no such server start or warning, and only log an unknown feature key; under
  `--strict-config` they refuse it, so a launch whose extra arguments name that flag goes without
  the key. Not `--no-daemon` or `--disable daemon_auto_start`: 0.153.4 to 0.155.1 exit on both.
- **Not changed.** The screen reader (`codex-screen.ts`) still refuses a hint row with a count:
  #371's reader steps are separate. Codex can still show a count of its own (a tool server that
  cannot start, or from 0.161.0 on Windows an app run as administrator); the known-issues entry
  keeps its workaround. `codex exec` runs (review, analysis, Insights, agents) never show it.
- **Tests.** `tests/unit/providers/codex/spawn-daemon-auto-start.test.ts`: the key on each route,
  once, in place; unchanged launches; the `--strict-config` case. Red on the old code, and under
  three mutants (the wiring, the embedded check, the strict check).
  `tests/unit/providers/codex/spawn-hooks.test.ts` pins the key once, as the last two arguments,
  on a launch whose only app `-c` entries are its hooks: red on the old code and under a fourth
  mutant (the key's push moved above the hooks block).
