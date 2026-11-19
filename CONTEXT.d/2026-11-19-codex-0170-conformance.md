## 2026-11-19 -- Codex 0.170.0 passes the conformance checks and is the newest tested version

Section C4, item 1, of the 2.1.3-beta.11 plan (aicc_planning#347, with
aicc_planning#346 riding along). Built on section C1's frozen head (1443d381,
which raised the range to 0.157.1), under the plan's process simplification 8.

**Cause first, measured.** CI run 44530368458 had two red checks on 0.170.0.
- The model list: four models the registry lacked (gpt-6.2-sol, gpt-6.2-astra,
  gpt-6.1-terra, gpt-6.1-sol).
- macOS only: the app's discovery by PATH found `bin/codex.js` and read no
  version. The CI log did not say why, so a diagnostic dispatch (CI run
  44543504445, a scratch commit dropped afterwards) logged the app's version
  run under each PATH. The first `node` on the login shell's PATH on the macOS
  runner is Homebrew's Node 24.22.3, which has `process.execve`; the first on
  the job's own PATH is Node 20.20.2, which does not. On Linux the first `node`
  on both PATHs is Node 20.20.2. 0.170.0's launcher, unlike 0.157.1's, replaces
  itself with the native program through `process.execve` when Node offers it,
  outside Windows, and the test suite's home guard, which every node child of a
  test loads, refused that call: exit 1, no version. Under Node 20 the same run
  read 0.170.0. The app's discovery was not at fault.

**Changed.**
- The home guard (`tests/helpers/home-guard-core.mjs`) checks a probe's
  `process.execve` as it checks a spawn of the same program (working folder,
  arguments, environment, with its preload and marker added) and hands it to
  Node. It is still refused in a vitest worker, and in a probe that holds a
  refusal not yet reported.
- The registry and the Codex catalogue hold the four models, first, with the
  labels and levels of `codex-rs/models-manager/models.json` at rust-v0.170.0
  ("GPT-6.1 Terra" with a space, as Codex spells it). The registry's revision is
  20261119.
- Sentinel's finding text and the release gate name the catalogue's versions
  as a list ("0.153.4, 0.155.1, 0.156.1 and 0.157.1"), not with "and" between
  each pair (aicc_planning#346).
- Then CI run 44547276658 (0.170.0, at 6aba7bf2): every leg green on Windows,
  macOS and Linux. `CODEX_MAX_TESTED_VERSION` rises to 0.170.0, with README.md,
  docs/USER_GUIDE.md, the Feature Guide entry (which no longer names
  GPT-6.1-Sol as a model the picker lacks), ADR-022's bound 5 and the evidence
  record (docs/wp1/evidence/codex-tested-range-2026-11-19.md). The pin (0.155.1)
  and the minimum (0.153.4) stay.

**Not shown by CI.** A Codex account's usage reading on 0.170.0 needs a
signed-in account. Codex's committed app-server schema bundle was compared
between rust-v0.157.1 and rust-v0.170.0 for what the read uses: the same, apart
from one optional initialize capability the read does not ask for and three
more plan types, which the app keeps as no plan. The owner's test of the
release checks the reading.

**Tests.** CI's test jobs run Node 20, which has no `process.execve`, so the
guard's new execve cases run only on a Node 22.15 or later machine. A guarded
child trusts its parent's temp folder only when it is named like one (Temp,
tmp, T, _temp or ccc-vitest-*), so those cases give the probe homes and a
temp-named folder of their own, whatever a test runner calls its temp folder.
