# Real-CLI matrix: per-item evidence at 2.1.1

This file is the real-CLI evidence that WP1.2, WP1.10, WP1.20, WP1.32, WP1.64 and WP1.71 cite in
`tests/wp1/traceability.json`. It has the two parts `docs/wp1/evidence/release-qualification.md` section 4 gives it:
the item part (rows 2, 3, 4, 6, 9, 25, 33 and 49) and the no-item part (rows 1, 12, 13, 18, 21, 23, 27, 29, 48, 50, 64
and 74). Each entry gives the CLI version and route, the actor and the commands.

Rows 3, 4, 6 and 29 have no entry of their own:
- rows 3 and 29 owe nothing on Windows (section 4);
- row 4 (sign-in) is the WP1.20 and WP1.64 PENDING blocks below;
- row 6 (multiple isolated accounts) is the WP1.10 PENDING block below; its keyring smoke is in `keyring-smoke.md`.

Every check here was taken at d1525759a7a42d941beeff601af3415fddd8afdd, the squash merge of PR #644 on beta and the commit
`release/v2.1.1` points at (tree `12310fe71f3706f624e3905f8b92f06f099cdc3f`). The qualification build of that commit is
the release `v2.1.1-beta` (release run 38409628911).

**Status: partly recorded.** The VM agent's rows, the packaged-build agent's runs of the app's own Codex install
(WP1.32) and the CI conformance smoke are recorded below. The owner's rows
(real sign-ins, the second consented identity, the disposable Claude account, a real prompt to a working model,
`codex_review` and the session-strip meters, and the macOS sign-in) have not run yet; each is a PENDING block below.
Until they are recorded, every item this file serves except WP1.71 stays `planned`.

| Item | Recorded here at the head | Still owed (PENDING) | Expected unavailable, pending the owner's confirmation |
|---|---|---|---|
| WP1.2 | Rows 2, 9, 25 and 33 on the Windows test VM: the real Codex 0.153.4 and 0.155.1 on both install routes, fake keys, the loopback fake model. The mode-matrix cells are in `mode-matrix.md` | A real signed-in Codex session with a consented identity on Windows, and with the owner's sign-in on the macOS test user. Rows 9, 25 and 33 on macOS and Linux with fake keys, as on Windows, unless the owner rules otherwise: they are open (`docs/wp1/owner-decisions-2026-10-13.md#OQ1`) | A real Codex-only session on Linux, with rows 9, 25 and 33 there in a signed-in session: `docs/wp1/owner-decisions-2026-10-13.md#UA1` |
| WP1.10 | Nothing yet | The two-account run on Windows with two consented identities | The two-account run on macOS and Linux: `docs/wp1/owner-decisions-2026-10-13.md#UA2` |
| WP1.20 | Nothing yet | The browser sign-in into the selected managed account on Windows and on macOS | A disposable identity, and the Linux sign-in: `docs/wp1/owner-decisions-2026-10-13.md#UA4` |
| WP1.32 | The CI conformance job's installs on each OS (WP1.71 below; npm, not through the app). The app's own install ("Run it for me") on the Windows test VM: OpenAI's installer route reached a version class; the npm route reaches one only once npm's global folder is on the user's PATH, and that cause is proven (below) | The sign-in after the install, on the Windows test VM. The owner's ruling on the npm route's account shape, which has a stated default (`docs/wp1/owner-decisions-2026-10-13.md#OQ2`) | The real installer smoke through the app on macOS and Linux: `docs/wp1/owner-decisions-2026-10-13.md#UA5` |
| WP1.64 | Nothing yet (every agent row uses fake keys) | The real Claude smoke with the disposable Claude account; the real Codex sign-in, status and sign-out; one real prompt to a working model; `codex_review`; the macOS sign-in | Disposable Codex identities, the API-key flow, the second-identity flows off Windows, every credential-bearing flow on Linux, and `codex_review` (row 49) on macOS and Linux: `docs/wp1/owner-decisions-2026-10-13.md#UA6` |
| WP1.71 | All 9 legs: the minimum, pinned and release-candidate CLI on Windows, macOS and Linux | Nothing (the owner confirms the release-candidate version at go) | None: WP1.71 may never read `unavailable` (ADR-026) |

## The VM agent's rows (item part: rows 2, 9, 25 and 33)

**Result of the VM agent's rows:**
- **Row 2: PASS** on both versions and both install routes.
- **Row 33: PASS** on both versions and both routes.
- **Row 9: PASS on `codex.exe`. On the npm `codex.cmd` shim it passes only with a deviation.** The tab keeps its account,
  and its conversation continues in that account's folder. But when the project folder was written in a different letter
  case from the folder on disk, the restored tab opened the resume list instead of resuming directly. Finding F-L1-1 below
  has the cause.
- **Row 25: the index matched its own per-turn rule on every session.** But in 1 of 6 real rollouts, 3 turns are priced
  twice (finding F-L1-2). That part fails the row's "each turn priced once".
- **No-item rows 1, 12, 23 and 48: PASS** (12 and 23 as rewritten for O5). Row 21 was skipped for a harness gap, rows 64
  and 74 were passed over for row 12, and rows 13, 27 and 50 were not reached in the window (see the no-item part).

### How the rows ran

- **Who and where:** the VM operator agent (Claude Code) on the Windows test VM, over key-authenticated SSH. Each runner
  was started detached through WMI (session 0, elevated, NETWORK logon).
- **The app:** the dev build of the commit above (`npm run build`, the bundle names `d152575`). It was launched by
  Playwright `_electron` with the tracked e2e helpers (`tests/e2e/helpers/*`), from a VM-local spec. The spec was copied
  into `tests/e2e` for each run and moved out afterwards; the checkout's status was the same before and after.
- **Isolation:**
  - each instance had its own data folder (`CCC_E2E_DATA_DIR`) and its own home (`USERPROFILE`/`HOME`), and `CODEX_HOME`
    was unset;
  - the runner's `TEMP` was in the run's folder;
  - every PATH folder holding a real `codex` or `claude` was dropped;
  - for the run, the two real-Codex folders were also taken out of the VM user's registry PATH. They were put back
    afterwards and checked to be byte-equal. This is the WP1.3 harness fix in `mode-matrix.md`;
  - a dead proxy covered everything but loopback.
- **Real Codex:**
  - 0.153.4: the npm `codex.cmd` shim, and the `codex.exe` that install ships;
  - 0.155.1: the same two routes.
  The four files were hash-checked.
- **Managed accounts A and B** were written with the app's own registry transitions (`src/shared/providers`). Each
  realm's `config.toml` pointed at the loopback fake model, and each realm was signed in with a fake API key through the
  real CLI (`codex login --with-api-key`). `codex login status` then read "Logged in using an API key".
- **First screens** were answered by plan 9.2's rules (`tests/e2e/helpers/codex-first-screens.ts`): trust, then hooks
  ("Continue without trusting"), then the sandbox (option 2), each only on a verified row of the live menu.
- **Snapshots:** the VM user's own `~\.codex` (6,536 entries) was snapshotted before and after each run, and was
  unchanged. The real `~\.claude`, `~\.claude.json`, the app's data folder and the HKCU keys were unchanged too.

### Row 2: CLI detect and version classes

Run `vm16-r1`, 2026-10-13, VM local 07:37 PDT. For each route, the route's own folder was the only Codex the instance could
find, on PATH or in the registry PATH. `providerAccounts.discover('codex')` answered, and Settings, Accounts was read.

| Version | Route | Discovery | Version read | Class (expected) | Settings, Accounts |
|---|---|---|---|---|---|
| 0.153.4 | npm `codex.cmd` | found | 0.153.4 | supported (supported) | "Codex 0.153.4 - ready" |
| 0.153.4 | `codex.exe` | found | 0.153.4 | supported (supported) | "Codex 0.153.4 - ready" |
| 0.155.1 | npm `codex.cmd` | found | 0.155.1 | supported (supported) | "Codex 0.155.1 - ready" |
| 0.155.1 | `codex.exe` | found | 0.155.1 | supported (supported) | "Codex 0.155.1 - ready" |

The expected class is `classifyCodexVersion(<version>)` at this commit. The discovery view does not name the executable's
path. Which file was found is shown by isolation instead: each instance could find no other Codex.

### Row 9: launch and resume in the exact account

**What each version and route did:**
1. Two managed accounts, A and B, each signed in with a fake key.
2. Two saved configs on the same project folder, one bound to A and one to B (the account picker in New saved config).
3. Each was launched. Its first screens were answered (trust, hooks, sandbox, on both versions and routes). One prompt
   was answered by the fake model.
4. The app was quit with the Close dialog's "Save sessions".
5. The app was relaunched on the same data folder, and Resume previous sessions was answered "Resume". Each restored tab
   was opened.
6. One more prompt was sent in each.

| Run | Version, route | Saved conversation at quit | Restored tab | After the second prompt |
|---|---|---|---|---|
| vm16-r3 | 0.155.1 `codex.exe` | A and B, each its own | `resume <its id>` directly, in its own account folder | each prompt is in its own account's original rollout and not in the other's |
| vm16-swap | 0.153.4 `codex.exe` | A and B, each its own | `resume <its id>` directly | the same |
| vm16-r3 | 0.153.4 npm `codex.cmd` | none recorded | the resume list, listing only its own account's conversation; picking it ran `resume <its id>` | the same |
| vm16-swap | 0.155.1 npm `codex.cmd` | none recorded | the resume list, as above | the same |
| vm16-case | 0.155.1 npm `codex.cmd`, project folder in its on-disk case | A and B, each its own | `resume <its id>` directly | the same |
| vm16-case | 0.153.4 `codex.exe`, the same folder | A and B | `resume <its id>` directly | the same |
| vm16-swap2 | 0.155.1 npm `codex.cmd`, as vm16-swap | none recorded | the resume list | the same. The folder Codex recorded differs from the configured one only in the letter case of one segment |

- **The account is kept in every case.** After the relaunch, the saved state still binds each tab to its own account.
  Each realm holds exactly one rollout, and every prompt of that conversation is in that rollout and in no other realm.
- **`config.toml`** (hashed per account at each step):
  - it was unchanged by the app's start;
  - it changed only on the first screens' answers;
  - it was unchanged from there through the relaunch, the resume, the second prompt and the resume list.
- **F-L1-1 (the `codex.cmd` deviation).**
  - Through `cmd.exe`, Codex records the conversation's folder in its on-disk letter case.
  - The app claims a new conversation only when the recorded folder matches the configured one exactly, as a
    case-sensitive string (`src/main/providers/codex/telemetry.ts`, the claim's cwd match).
  - Here the configured folder had a lower-case user-profile segment, so the claim never happened and nothing was saved
    to resume by id.
  - With the folder spelled in its on-disk case (vm16-case), the same route claimed it and resumed it directly.
  - **Effect:** a tab on the npm route whose configured folder's case differs from the disk opens the resume list after a
    relaunch, one keystroke from the same conversation. It never opens another account's conversation and loses
    nothing. That is how every Codex tab restored in 2.1.0, which has no exact Codex resume.
  - **Class:** neither severe nor a regression against 2.1.0.

### Row 33: resume in the exact realm

On each run above, after the relaunch:
1. In each tab, Restart, then "Restart and pick a conversation" (`codex-restart-pick`).
2. Codex's resume list (codex-resume-picker) for the shared project folder was read.

| Version, route | B's list | A's list |
|---|---|---|
| 0.153.4 `codex.cmd` (vm16-r3) | 1 conversation: B's (its first prompt); nothing of A's | 1: A's; nothing of B's |
| 0.155.1 `codex.exe` (vm16-r3) | the same | the same |
| 0.153.4 `codex.exe` (vm16-swap) | the same | the same |
| 0.155.1 `codex.cmd` (vm16-swap) | the same | the same |

vm16-case and vm16-swap2 repeated the check on the same versions and routes, with the same result.

"Nothing of the other's" means: neither its tab name, nor either of its prompts, nor its conversation id. Both accounts'
conversations were in the same project folder, so only the account separated them. The resume list shown on restore on
the `codex.cmd` route (row 9) also listed only its own account's conversation.

### Row 25: Tokenomics reads the managed realms and `~/.codex`

Run vm16-r3, on 0.155.1 `codex.exe`:
- The VM user's 6 real rollouts were copied, read-only, from `~\.codex\sessions` into the instance's own home
  (`~\.codex\sessions` there). No Codex was started on them.
- Accounts A and B each held one fake-model conversation of two turns.
- After the relaunch, `tokenomics.indexStatus()` reported the first index complete. `tokenomics.sessions({ provider:
  'codex' })` and `sessionDetail(id)` were then read.
- The expected figures were recomputed from each rollout's own bytes:
  - one priced turn per `token_count` event carrying a cumulative total;
  - its usage is `last_token_usage`;
  - input is split into non-cached and cached.

| Session | Account key | Turns (index / rollout) | Input, cached, output: index = rollout | One row |
|---|---|---|---|---|
| real 1 | `codex:external` | 2 / 2 | yes | yes |
| real 2 | `codex:external` | 19 / 19 | yes | yes |
| real 3 | `codex:external` | 35 / 35 | yes | yes |
| real 4 | `codex:external` | 169 / 169 | yes | yes |
| real 5 | `codex:external` | 6 / 6 | yes | yes |
| real 6 | `codex:external` | 2 / 2 | yes | yes |
| account A | `codex:<A's id>` | 2 / 2 | yes (152,022 / 0 / 80) | yes |
| account B | `codex:<B's id>` | 2 / 2 | yes (154,022 / 0 / 80) | yes |

- 8 Codex sessions were listed, each once, under its own account's key. A managed realm's conversation was never counted
  as this computer's, and a real one never as an account's. Every model had a price (0 unpriced tokens).
- **F-L1-2: real 4 has 3 turns priced twice.**
  - That rollout has 169 `token_count` events, on gpt-5.5 and gpt-5.4-mini. 3 of them repeat the previous event's
    cumulative total exactly, so they carry no new usage. They were found with a read-only pass over the VM user's own
    rollouts.
  - The index prices every event, so it counts those 3 again: 23,367,184 tokens against the CLI's own cumulative
    23,221,895. That is 145,289 tokens (0.63%) too many.
  - With the repeats skipped, the per-event sum equals the cumulative total exactly. The same is true of the other 5 real
    rollouts and both fake-model ones, which have no repeats.
  - The rule is the same in 2.1.0 (`src/main/tokenomics/tk-parse.ts`, one priced turn per `token_count` event, and its
    ordinal in the dedup key).
  - **Class:** neither severe nor a regression against 2.1.0. It is recorded as a known limitation in
    `release-qualification.md` section 3.

## WP1.71: the conformance smoke on the minimum, pinned and release-candidate CLI, per OS

WP1.71: "Non-secret conformance smoke executes against the minimum, pinned and release-candidate CLI versions on every applicable OS." Its evidence is a `ci.yml` dispatch at the binding's head with a release-candidate version, because only a dispatch runs the release-candidate leg (a pull request run checks the minimum and pinned versions only).

- **Commit:** d1525759a7a42d941beeff601af3415fddd8afdd, the binding's head (the 2.1.1 squash merge on beta), tree 12310fe71f3706f624e3905f8b92f06f099cdc3f.
- **Run:** CI run 38409643796, `workflow_dispatch` of `.github/workflows/ci.yml` on `release/v2.1.1` (which points at the head), attempt 1, 2026-10-13, conclusion success. Command: `gh workflow run ci.yml --ref release/v2.1.1 -f codex_rc_version=0.156.1`.
- **Versions:** the minimum 0.153.4 and the pinned 0.155.1, read from `src/main/providers/codex/cli-contract.ts` at the head; the release candidate 0.156.1 (`codex_rc_version`). Each was installed from the published `@openai/codex` package with `npm install --global --prefix <its own folder> --ignore-scripts`, in an npm cache of its own.
- **Runners:** `windows-2025` (win32-x64), `macos-latest` (darwin-arm64), `ubuntu-latest` (linux-x64).
- **No secret, no sign-in:** the job holds no secrets and keeps no token on disk; every run of the CLI gets a fresh, empty `CODEX_HOME`; no request needs the network. On every leg the runner's own `~/.codex` was absent before the CLI was installed and still absent after the last run (the job's last step checks it).
- **What each leg runs:** the `codex --version` PATH check (it printed exactly `codex-cli <version>` on every leg); `tests/integration/codex-real-cli-conformance.test.ts` (8 cases: the run's configuration, detection in two cases, the model list through the app's reader, the flags of every command line the app runs against the subcommand's own help, `codex features list`, the help captures against the fixtures, and the run report; plus a placeholder, skipped by design); `tests/integration/codex-cli-compat.test.ts` (the 5-case flag-drift suite); the runner's own home check. `CCC_CODEX_HELP_ASSERT` = 1; no prove-red input.

| OS | Version class | Version | Job | Conformance suite | Detection | Flags | Model list | Features | Help | Flag-drift suite | Own home untouched |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Windows | minimum | 0.153.4 | 115338273353 | 8 passed, 1 skipped (placeholder) | Found, version 0.153.4, supported; PATH resolution finds `codex.cmd` with the same version | Every flag defined, each in its subcommand's help | 6 ids, equal to the recorded list; every id in the registry | 135 listed; the 12 the analysis turns off all named | 15 of 15 the same as the fixtures (asserted) | 5 passed | Yes |
| Windows | pinned | 0.155.1 | 115338273682 | 8 passed, 1 skipped | Found, 0.155.1, supported; `codex.cmd` | Every flag defined | 5 ids, equal to the recorded list; in the registry | 141 listed; the 12 all named | 15 of 15 the same (asserted) | 5 passed | Yes |
| Windows | rc | 0.156.1 | 115338273366 | 8 passed, 1 skipped | Found, 0.156.1, supported; `codex.cmd` | Every flag defined | 7 ids, every one in the registry; no recorded list exists for 0.156.1 | 148 listed; the 12 all named | 15 captured; no fixture exists for 0.156.1, so none compared | 5 passed | Yes |
| macOS | minimum | 0.153.4 | 115338273648 | 8 passed, 1 skipped | Found, 0.153.4, supported; PATH resolution finds `codex.js` (the npm bin link) | Every flag defined | 6 ids, equal to the recorded list; in the registry | 135 listed; the 12 all named | 15 of 15 the same, the reviewed macOS differences applied (asserted) | 5 passed | Yes |
| macOS | pinned | 0.155.1 | 115338273913 | 8 passed, 1 skipped | Found, 0.155.1, supported; `codex.js` | Every flag defined | 5 ids, equal to the recorded list; in the registry | 141 listed; the 12 all named | 15 of 15 the same, reviewed differences applied (asserted) | 5 passed | Yes |
| macOS | rc | 0.156.1 | 115338273271 | 8 passed, 1 skipped | Found, 0.156.1, supported; `codex.js` | Every flag defined | 7 ids, in the registry; no recorded list for 0.156.1 | 148 listed; the 12 all named | 15 captured; no fixture for 0.156.1, none compared | 5 passed | Yes |
| Linux | minimum | 0.153.4 | 115338273156 | 8 passed, 1 skipped | Found, 0.153.4, supported; `codex.js` | Every flag defined | 6 ids, equal to the recorded list; in the registry | 135 listed; the 12 all named | 15 of 15 the same, the reviewed Linux differences applied (asserted) | 5 passed | Yes |
| Linux | pinned | 0.155.1 | 115338273110 | 8 passed, 1 skipped | Found, 0.155.1, supported; `codex.js` | Every flag defined | 5 ids, equal to the recorded list; in the registry | 141 listed; the 12 all named | 15 of 15 the same, reviewed differences applied (asserted) | 5 passed | Yes |
| Linux | rc | 0.156.1 | 115338273142 | 8 passed, 1 skipped | Found, 0.156.1, supported; `codex.js` | Every flag defined | 7 ids, in the registry; no recorded list for 0.156.1 | 148 listed; the 12 all named | 15 captured; no fixture for 0.156.1, none compared | 5 passed | Yes |

The model lists: 0.153.4 lists gpt-6-astra, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5 and gpt-5.2; 0.155.1 the same without gpt-5.2; 0.156.1 lists gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna and gpt-5.5. Every listed id is in `resources/model-registry.json` on every leg; registry ids a version does not list are reported, as designed, and fail nothing.

Limits of this record:
- The release-candidate legs' help is captured, not compared: no fixture exists for 0.156.1, and the suite's summary line reads "0 differ" because nothing was compared. The minimum and pinned legs compared all 15 captures and the comparison was asserted.
- The release candidate is 0.156.1, the newest version tested against the app (the tested ceiling), not a newer published Codex; the owner confirms that choice at go.
- The smoke is no-sign-in by design ("non-secret"): it proves detection, the command lines' flags, the model list and the features against each real CLI, not a signed-in turn. The signed-in rows are elsewhere in this file.

Supporting, the same tree: the 2.1.1 pull request's final run, CI run 38400973974, ran the minimum and pinned legs on all three OSes (jobs 115308204067 and 115308204138 on Windows, 115308204162 and 115308204098 on macOS, 115308204111 and 115308204085 on Linux) on GitHub's merge commit 72639eba01b52aebfde6a8fed05d67db0feadfb8, whose tree is the head's tree 12310fe71f3706f624e3905f8b92f06f099cdc3f. Every one of the six passed with the same results as the dispatch's minimum and pinned legs.

## The packaged-build agent's runs (item part: WP1.32 on Windows)

WP1.32's opt-in real smoke through the app on Windows: Codex's "Run it for me" on Set up Codex, in the qualification
build.

**Result:**
- **OpenAI's installer route: the version class was reached.** After the install, Set up Codex read "Codex 0.162.1
  found" and "Newer than the versions this app was tested with; it will still be used", and offered the sign-in. The
  agent changed no PATH for this run.
- **The npm route: npm installed Codex, but the app did not find it in this account, in both runs.** **The cause is
  proven:** npm's global folder for this account is on no PATH, because Node.js was installed by another user. With
  only that folder added to the account's user PATH, the same build found the same Codex and read the same version
  class.
- **Not taken:** the sign-in after the install. The agent's runs make no real sign-in; it is PENDING in the owner's
  rows below.
- **Class:** neither severe nor a regression against 2.1.0, which has no "Run it for me". The npm-route case is known
  limitation 12 in `release-qualification.md` section 3, and `docs/wp1/owner-decisions-2026-10-13.md#OQ2` asks the
  owner to rule on it.

### How it ran

- **Who and where:** the packaged-build agent (Claude Code), on the Windows test VM, in a standard (non-administrator)
  local account, over key SSH through a job runner. Two runs on 2026-10-13: 17:03 to 17:12 UTC (the npm route), and
  18:48 to 19:02 UTC (the npm route again, the cause test, OpenAI's installer route and the removal).
- **The build:** the qualification build, installed fresh for each run from its signed installer with `/S` (its
  wizard's data-folder values written first), outside any checkout. Its first run was walked to Set up Codex with the
  pages' own buttons, over a loopback DevTools port.
- **The account had no Codex:** none on the PATH the app was started with, and no `%APPDATA%\npm` or `~\.codex`.
  Node.js was installed for the computer by another user: the computer's `Path` holds Node.js's folder, and the
  account's own user `Path` holds only `%USERPROFILE%\AppData\Local\Microsoft\WindowsApps;`.
- **The page before:** in its `missing` state, "Codex CLI not found", with two recipes, each with "Run it for me":
  OpenAI's installer (`powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"`) and
  `npm.cmd install -g @openai/codex`.
- **No real sign-in.** No Codex app-server ran: at every check the only Codex process on the computer was a system
  service (`codex-windows-sandbox-service`) that was running before the runs. It was not touched.

### The npm route (both runs)

1. "Run it for me" on the npm recipe, then "Run it" in the confirmation ("Run this in a new terminal tab? It types the
   line below. ..."). The command ran in a new terminal tab.
2. npm installed Codex 0.162.1, npm's latest (above the tested range, 0.153.4 to 0.156.1), into the account's npm
   global folder, `%APPDATA%\npm`, and ended.
3. After "Back to setup" the page read, still `missing`: "Codex CLI not found" and "The command ended, but Codex was
   still not found. The terminal shows what happened: fix what it reports and run it again, or try another command."
   In the second run it read the same about 22 s later. The app shows that last line only once the command it ran has
   ended (`afterInstallMessage`, `src/renderer/onboarding/InstallRecipeList.tsx`). So the app had checked again after
   the command, and that check did not find Codex.

After the first run Codex was removed with npm. After the second, the cause test below ran on the Codex it had
installed.

### The cause test (the npm route)

- The app was quit.
- **The only change to the account:** the full path of `%APPDATA%\npm` was appended to the account's own user `Path`
  (`HKCU\Environment`), keeping the value's kind (`REG_EXPAND_SZ`). The value before was saved with its kind. The app
  was then started again and walked to Set up Codex.
- **It read, in its sign-in state:** "Codex 0.162.1 found" and "Newer than the versions this app was tested with; it
  will still be used".
- The user `Path` was then written back and read equal to the saved value, kind included.
- **Why this proves the cause.** At this commit Codex's discovery looks only on the PATH (`discoverCodex`,
  `src/main/providers/codex/discovery.ts`). Before the check after an install, the app re-reads the computer's and the
  user's `Path` from the registry and adds any folder it lacks (ADR-024; `src/main/windows-path-refresh.ts`). In this
  account npm's global folder is in neither value, so no check can see it. Starting the app again was a second change,
  but it is not the cause: the npm route's own check after the command had already re-read the registry and still did
  not find Codex, and OpenAI's route below shows that the re-read finds a new user-`Path` folder without a restart.

### OpenAI's installer route (once)

- First the npm Codex was removed (`npm.cmd uninstall -g @openai/codex`), and the npm folder the run had created was
  removed, so a Codex found next could only be the installer's.
- OpenAI's install script was fetched once and read before the run. It installs Codex under `~\.codex`, makes
  `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` a link into it, puts that folder on the user `Path`, and then asks "Start
  Codex now? [y/N]".
- The app was started again and walked to Set up Codex (`missing`). "Run it for me" on OpenAI's recipe, then "Run it".
  Its confirmation read "This downloads a script from chatgpt.com and runs it. Run this in a new terminal tab? It types
  the line below. ...".
- The installer made its `bin` link and changed the user `Path`. At its question "Start Codex now? [y/N]", N and Enter
  were typed into the app's terminal tab, as the page tells the user to do.
- **After "Back to setup" the page read, in its sign-in state:** "Codex 0.162.1 found" and "Newer than the versions
  this app was tested with; it will still be used". The app's registry re-read found the installer's folder with no
  restart.
- **OpenAI's installer, not the app:** it rewrote the account's user `Path` from `REG_EXPAND_SZ` to `REG_SZ`, with
  `%USERPROFILE%` expanded and its own folder first. Its script reads the user `Path` expanded and writes it back as a
  plain string, through .NET's `Environment` methods.

### Removal

- Codex was removed: the npm copy with `npm.cmd uninstall -g @openai/codex` after each npm run, and the installer's
  folders, `%LOCALAPPDATA%\Programs\OpenAI` and `~\.codex`, each link removed as a link first.
- The user `Path` was written back to the saved value and read equal, kind included, after the cause test and after
  the installer route.
- The app was removed with its own uninstaller (`/currentuser /S`, Valid, exit 0). The account's state report then
  matched the one taken before the run, its header and the stand-in's count of calls aside.
- npm's cached package files stay in the account's npm cache, which existed before the runs.

**Commands:** the signed installer with `/S`; the app driven over a loopback DevTools port; `codex.cmd --version` as
the account; the user and computer `Path` read from the registry, and the user `Path` saved and written back with its
kind; `npm.cmd uninstall -g @openai/codex`.

## The owner's rows (item part)

None of these has run yet. Each block is replaced by its record when it runs. Every one is taken on the qualification
build `v2.1.1-beta` (the commit above), installed outside any checkout, with the owner signing in. The record is
non-secret: it names which kind of identity was used, never an address or an account name.

> **PENDING: WP1.2, a real signed-in Codex-only session.** On the Windows test VM, with a consented identity: start a
> Codex session on the managed account, choose a GPT-6 model, send one prompt and record the answer. On the macOS test
> user, with the owner's sign-in: "Use Codex only" at setup, sign in, start a Codex session, send one prompt, sign out.
> Expected unavailable: the Linux session, `docs/wp1/owner-decisions-2026-10-13.md#UA1`. Also owed unless the owner
> rules otherwise: rows 9, 25 and 33 on macOS and Linux with fake keys, as on Windows (open,
> `docs/wp1/owner-decisions-2026-10-13.md#OQ1`).

> **PENDING: WP1.10, two Codex accounts in distinct homes.** On the Windows test VM: account A and account B signed in
> to their own folders, the second with the second consented identity; status of each; a quit and relaunch with B's
> conversation continued; a running session switched from A to B; then B signed out and archived while A still reads
> signed in. Expected unavailable: the same run on macOS and Linux, `docs/wp1/owner-decisions-2026-10-13.md#UA2`.

> **PENDING: WP1.20, the browser sign-in in the selected realm.** On the Windows test VM: Settings, Accounts, Add Codex
> account, Sign in with ChatGPT, twice (accounts A and B), each landing in its own folder with no credential parsed by
> the app. On the macOS test user: the same, once. Expected unavailable: a disposable identity on every OS, and the
> Linux sign-in, `docs/wp1/owner-decisions-2026-10-13.md#UA4`.

> **PENDING: WP1.32, the sign-in after the app's own install.** On the Windows test VM, in the owner's sitting: a real
> sign-in through the app (Sign in with ChatGPT) into a managed Codex account, on the qualification build. The install
> part is recorded above ("The packaged-build agent's runs"), and the CI installs per OS under WP1.71. Expected
> unavailable: the same through the app on macOS and Linux, `docs/wp1/owner-decisions-2026-10-13.md#UA5`. Open for the
> owner's ruling, with a stated default: whether OpenAI's installer route counts as the Windows install smoke, and the
> npm route in an account whose npm global folder is on no PATH (`docs/wp1/owner-decisions-2026-10-13.md#OQ2`). Not
> run yet.

> **PENDING: WP1.64, real Claude and Codex smoke and the credential-bearing flows.** On the Windows test VM: the
> disposable Claude account signed in, used, signed out, and still signed out after a relaunch; the real Codex sign-in,
> status and sign-out with the consented identities; one real prompt to a working model; `codex_review` asked from a
> Claude session (on 0.155.1, then 0.153.4), with its first finding.
> On the macOS test user: the owner's Codex sign-in and sign-out. Expected unavailable, `codex_review` on macOS and
> Linux included: `docs/wp1/owner-decisions-2026-10-13.md#UA6`.

## No-item part: rows 1, 23, 48 and 12 (VM agent)

These rows ran with the same setup as above, after the item rows. The plan's order for the no-item rows was 1, 23, 21,
48, 64, 74, 12, 13, 27, 50; the agent ran 1, 23, 48 and 12, in that order, and did not run the others (below).

**Row 1 (provider on/off, "not set up", last provider on): PASS** on 0.153.4 npm `codex.cmd` and on 0.155.1 `codex.exe`
(run row1-r1, 08:25 PDT). Each version ran in its own instance:
1. **In use.** A managed account, signed in with the fake key, had a config whose tab answered a prompt with the real
   CLI. Turning Codex off was then refused with "Codex is in use (1)." and the switch stayed On.
2. **Off.** After a "Save sessions" quit, no Codex process was left. Codex was then set off at the next start:
   - Resume previous sessions tagged the tab "Codex off", with the full not-started wording as its title;
   - the restored tab read "Not started. Codex is off. Turn it on in Settings, Accounts, then Restart this tab.";
   - the saved config was tagged "Codex off", titled "Codex is off. Turn it on in Settings, Accounts to launch this
     config.";
   - no Codex process started in that time.
3. **Last provider.** With Codex off, turning Claude Code off was refused with "At least one provider stays on.". Codex
   was then turned on, and the real CLI was found and read "Codex <version> - ready". Claude Code was turned off, and
   turning Codex off was then refused with the same words.
4. **Unanswered.** The saved Codex answer was removed, leaving Codex saved on. At the next start "Do you use Codex?"
   showed, and no Codex process started.

**Row 23, as rewritten for O5 (the app's own accounts only): PASS** on 0.153.4 `codex.cmd` and 0.155.1 `codex.exe`
(run rows-23-48, 08:32 PDT).
- The instance had two managed accounts. It also had a signed-in "this computer" Codex folder: a throwaway `CODEX_HOME`,
  signed in with the fake key.
- New saved config's Codex account picker offered exactly the two managed accounts: A, marked "(Default)", and B. The
  computer's own sign-in was not offered.
- A config created on B launched with no app dialog or confirmation. Codex showed its own first screens (trust, hooks,
  sandbox) and answered a prompt.
- The conversation's rollout is in B's folder only: none is in A's, and none in this computer's folder, which was
  unchanged.

**Row 48 (Conductor MCP transport): PASS** on 0.155.1 `codex.exe` (run rows-23-48).
- The tab's launch line gives Codex the Conductor MCP server (`mcp_servers.conductor.url` and `.enabled=true`).
- The config used gpt-5.5. Asked to search for "canvas", the fake model saw Codex offer its tool search: type
  `tool_search`, client execution, parameters `query` and `limit`.
- Codex's search returned 5 Conductor tools: `mcp__conductor/canvas_complete`, `canvas_render`, `canvas_snapshot`,
  `canvas_verdict` and `canvas_resolve`.
- No tool was called: "canvas" names none exactly.
- **Observation, not a finding:** a first attempt (row48-r1) used the build's default model id, gpt-6-astra. Against
  the loopback fake model, Codex 0.155.1 then sent no tools at all, and none in plain turns either. The fake model has no
  model catalogue, and the CLI evidently decides tools by model. The owner's prompt on a GPT-6 model with a real account
  (pending, below) is the check for GPT-6.

**Row 12, as rewritten for O5 (only the upgrade question is still owed): PASS** on 0.153.4 `codex.cmd` and 0.155.1
`codex.exe` (run row12-r1, 08:37 PDT).
- Setup: an upgrade from 2.1.0-rc.9 with Codex saved on but not answered, and this computer's own Codex folder (a
  throwaway `CODEX_HOME`) signed in with the fake key.
- The release notes showed, then "Do you use Codex?". No Codex process ran while it asked.
- Continue (Yes) opened Set up Codex. It read "Codex <version> found", "Version supported" and "Sign in to a new Codex
  account" (ChatGPT, or an API key). It made no offer to use this computer's sign-in.
- The saved settings then had Codex on and answered. A relaunch showed neither the notes nor the question.

**Not taken: rows 21, 64, 74, 13, 27 and 50.**
- Row 21 was skipped for a harness gap: its usage-header pills needed more test harness than the time left allowed, and
  the agent ran row 12 in its place.
- Rows 64 and 74 were passed over in favour of row 12 too.
- Rows 13, 27 and 50 were not reached in the window.

They are recorded as known limitations in `release-qualification.md` section 3, citing
`docs/wp1/owner-decisions-2026-10-13.md#KL2` (a draft section until the owner confirms it).

> **PENDING (the owner's sitting on the Windows test VM): row 18, the session-strip meters (OR4, no item).** Taken
> with the owner's prompt to a working model (the WP1.64 block above), on 0.155.1: the session strip's meters on that
> live Codex tab are read and recorded, and the 0.155.1 rollout that session writes is the row's fixture from a real
> session. The record gives what each meter showed and the fixture's SHA-256, and nothing from the conversation.
> Adding the fixture beside the strip's tests would change a path outside the binding-neutral ones
> (`tests/wp1/binding.ts`), so it is not made at this head. Until this is recorded, row 18 is listed as pending in
> `docs/wp1/owner-decisions-2026-10-13.md#KL2`. Not run yet.

> **PENDING (the owner's sitting on the Windows test VM): the managed re-authentication proof.** Owed by WP1.52's
> reason, which this file records but WP1.52 does not cite. Sign in again three times on account B (file store on
> 0.153.4 and 0.155.1, then the keyring store on 0.155.1), and once more with the second consented identity; after
> each, the old folder is signed out with the same CLI version, and the replacement must still read signed in
> (`codex login status` and Settings, Accounts). Each folder's store is recorded as observed (`auth.json` present:
> file; none, with a credential-store entry: keyring). 2.1.1 sets no credential store itself (see
> `keyring-smoke.md`), so the keyring runs use Codex's own `cli_auth_credentials_store` setting, given outside the
> app; the record says so. Not run yet.

> **PENDING (the owner's sitting on the Windows test VM): a link in a session's output.** In a Claude session, a
> printed web address is left-clicked; the record says what opened. Not run yet.

## Commands (per run)

- `npx playwright test --reporter=line,json tests/e2e/zz-p5-vm16.spec.ts` (with `-g rows` for the row 9, 25 and 33 runs).
  It ran under the isolation above, with:
  - `VM16_ROUTES`: the four routes;
  - `VM16_REAL_SESSIONS`: the real sessions folder, read only;
  - `VM16_SWAP=1`: for vm16-swap and vm16-case, the other route of each version;
  - and, for vm16-case only, the runner's folder spelled in its on-disk case.
- Inside the spec, per realm:
  - `codex login --with-api-key` (the fake key on stdin);
  - `codex login status`.

Runs, all on 2026-10-13, VM local time (PDT):

| Run | Time | Spec run | Result |
|---|---|---|---|
| vm16-r1 | 07:37 | all | row 2: 4 of 4 passed; row 9/33 stopped at a harness fault (a colour not in the palette), fixed |
| vm16-r2 | 07:50 | rows | 0.153.4 `codex.cmd` stopped at the restored tab's resume list (the harness then expected only a direct resume); fixed to record and answer the list |
| vm16-r3 | 08:01 | rows | 2 of 2 passed (0.153.4 `codex.cmd`; 0.155.1 `codex.exe` with row 25) |
| vm16-swap | 08:08 | rows, other routes | 2 of 2 passed |
| vm16-case | 08:14 | rows, other routes, folder in on-disk case | 2 of 2 passed |
| vm16-swap2 | 08:17 | rows, other routes (as vm16-swap), recording the folder Codex wrote | 2 of 2 passed. On `codex.cmd` the recorded folder differs from the configured one in the letter case of one segment only; on `codex.exe` it is identical |
| row1-r1 | 08:25 | row 1 (both versions) | 2 of 2 passed |
| row48-r1 | 08:29 | row 48 on the default model id | failed: no tool offered (see the observation); not a product result |
| row23-r1 | 08:30 | row 23 | harness fault (the dialog was closed with Escape, which it ignores); fixed to use its Cancel |
| rows-23-48 | 08:32 | rows 23 (both versions) and 48 (gpt-5.5) | 3 of 3 passed |
| row12-r1 | 08:37 | row 12 (both versions) | 2 of 2 passed |

Every run:
- left no app, Electron or Codex process of its own;
- left the real-folder and registry snapshots equal;
- put the registry PATH back byte-equal;
- left the checkout's status unchanged.

Not run in these rows: macOS and Linux, the packaged build, and a real sign-in (the owner's rows, pending above).
