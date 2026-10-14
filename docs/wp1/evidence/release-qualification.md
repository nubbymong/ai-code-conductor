# Release qualification record

This file collects the release evidence the WP1 ledger and traceability items
cite. Section 1 is the **documentation sweep** (WP1.35, WP1.36), written with
the WP2 guidance commit (commit 7, on top of `accec3c2`,
branch `session/beta/c4d568ce-wp2-codex`, 2026-09-25). Section 3 is the
release-run record (WP1.37, WP1.73), written for 2.1.1 at its qualification
commit, d1525759a7a42d941beeff601af3415fddd8afdd. Every part of it is
recorded, and `tests/wp1/traceability.json` declared the 2.1.1 candidate on
it for the promotion to main (pull request #645); on beta the manifest is
back at phase gate0, keeping its statuses and the records bound to this
commit. Section 4 maps the verification the 20 DONE parity rows still owe
to the check that gives it and the file it is recorded in (PR 4, P4.10).

Every statement below was checked against the code of this build before it was
written; section 2 gives the code evidence for the privacy claims.

## 1. Documentation sweep (WP1.35, WP1.36)

### What the ledger and traceability items require

| Source | Required statement |
| --- | --- |
| Ledger `README.md` (replace, WP1.35) | Stop claiming unsupported Codex account behaviour; describe provider selection. |
| Ledger `docs/USER_GUIDE.md` (replace, WP1.36) | Provider selection, account vs identity, managed vs external Codex homes, recovery. |
| Ledger `PRIVACY.md` (replace, WP1.36) | Describe managed Codex homes under the app data root. |
| Traceability WP1.35 | README, feature guide and troubleshooting stop claiming unsupported Codex account/history behaviour (evidence: `README.md`, `src/shared/app-knowledge.ts`, `docs/USER_GUIDE.md`, `PRIVACY.md`, `src/renderer/tips-library.ts`). |
| Traceability WP1.36 | User documentation explains provider selection, account vs identity, managed vs external Codex homes and recovery (evidence: `docs/USER_GUIDE.md`, `src/shared/app-knowledge.ts`, `PRIVACY.md`). |

### Where each statement is now made

| # | Statement | Where the documentation says it |
| --- | --- | --- |
| S1 | Provider selection: Claude Code and Codex are providers, turned on or off on the Providers card in Settings, Accounts, with install status, version and the install or update commands | `docs/USER_GUIDE.md` "Choosing your assistants (Claude Code and Codex)"; `src/shared/app-knowledge.ts` section `providers`; `README.md` bullet "Two assistants, one Accounts page", Getting started step 3, Requirements rows Claude Code and Codex |
| S2 | Choosing assistants at setup: "Which assistants will you use?" on a fresh install, "Use Codex only" when Claude Code is not installed, the Set up Codex page | `docs/USER_GUIDE.md` Getting started steps 1-2 and "Installing or updating Codex"; app-knowledge `providers` and `troubleshooting`; `README.md` Getting started step 3 |
| S3 | Turning a provider off and what happens to its sessions (at least one stays on; refused while in use; nothing starts; "Not started ... then Restart this tab"; the tab and conversation are kept) | `docs/USER_GUIDE.md` "Turning a provider off"; app-knowledge `providers` and `troubleshooting`; tip `tip.provider-switch`; Feature Guide card `provider-accounts` |
| S4 | Account vs identity (an account is one sign-in with one provider; an identity is the name and colour; "The same person as an existing account"; this computer's sign-in keeps its own identity; name/colour conflicts) | `docs/USER_GUIDE.md` "Codex accounts", "Account and identity"; app-knowledge `codex` (name and colour, or the same person) |
| S5 | Managed Codex homes: each Codex account's own sign-in folder, created by the app under its resources folder (`codex-realms/`); the app never reads the sign-in there | `PRIVACY.md` "What the app stores, and where" and "Codex accounts and sign-ins"; `docs/USER_GUIDE.md` "Managed Codex accounts and this computer's own sign-in"; app-knowledge `codex` and `privacy`; tip `tip.transparency.resources-folder`; `README.md` bullet "Codex accounts, each with its own sign-in" and the Account isolation row |
| S6 | External Codex home (`~/.codex`, or `CODEX_HOME` at start): never checked or taken in since 2.1.1-beta.3 (O5, owner decision 2026-10-11); an account 2.1.1-beta.2 adopted is confirmed at each launch, never used for reviews, never signed in to by the app | `PRIVACY.md` "Codex accounts and sign-ins" (last bullet); `docs/USER_GUIDE.md` "Managed Codex accounts and this computer's own sign-in"; app-knowledge `codex`, `code-review` and `known-issues`; tip `tip.codex-accounts-reviewer`; Feature Guide cards `codex-provider` and `code-review`; `README.md` bullet "Codex accounts, each with its own sign-in" |
| S7 | API key: goes to Codex on stdin, never stored by the app | `PRIVACY.md` "Codex accounts and sign-ins"; `docs/USER_GUIDE.md` managed accounts; app-knowledge `codex` and `privacy`; `README.md`; Feature Guide card `codex-provider` |
| S8 | Recovery: Sign in again (same account confirmed), Check sign-in, "Needs attention: signed in a different way than before" (a change of sign-in kind, such as an API key where there was a ChatGPT sign-in) and This is still my account, `codex login` for this computer's sign-in | `docs/USER_GUIDE.md` "Sign-in recovery"; app-knowledge `codex` and `troubleshooting`; tip `tip.codex-check-sign-in`; Feature Guide card `provider-accounts` |
| S9 | Reviewer default (reviews use the reviewer default, or the default if none is set) and review in both directions | app-knowledge `codex` and `code-review`; `docs/USER_GUIDE.md` "Code review between Claude and Codex"; Feature Guide cards `codex-provider` and `code-review`; tips `tip.codex-accounts-reviewer` and `tip.review-switches`; `README.md` Conductor MCP bullet |
| S10 | Local only: Codex sessions and Codex reviews run on this computer only in this release | app-knowledge `codex`, `code-review` and `known-issues`; `docs/USER_GUIDE.md` "Choosing your assistants" and "Known issues with Codex"; Feature Guide card `codex-provider`; `README.md` remote sessions paragraph, Codex bullet and Requirements |
| S11 | No unsupported history claim: the Logs page does not index Codex conversations | app-knowledge `codex` and `pages` (replacing "history all work"); tip `tip.codex-sessions` (replacing "tabs, notes, commands, logs"); Feature Guide card `codex-provider`; `docs/USER_GUIDE.md` "Logs & transcript viewer"; `README.md` Codex bullet |
| S12 | No unsupported account claims: the retired Settings Codex tab and single-account sign-in are described nowhere; "every session the app launches is a Claude Code process" and "behind a master switch" are gone | `README.md` Getting started step 3 and Codex bullet; app-knowledge `troubleshooting`; `tests/unit/renderer/settings-codex-tab-retired.test.tsx` sweeps `src/` for the old pointer |
| S13 | Known issues with a live workaround: no Codex review while the only Codex sign-in is an account 2.1.1-beta.2 registered for `~/.codex` (add a Codex account, Make reviewer); an environment API key is not used (add an account with Use an API key); no Codex over SSH | app-knowledge `known-issues`; `docs/USER_GUIDE.md` "Known issues with Codex" |

The Hello Codex statements (local only; the reviewer default) are pinned
against app-knowledge and the Feature Guide card by AC14 in
`tests/unit/renderer/hello-codex.acceptance.test.ts`. A third, confirming an
existing sign-in at each launch, went with O5 (2.1.1-beta.3): AC14 now checks
that the pages and the card no longer offer that sign-in.

### Corrections made on the way

Two claims older than WP2 were found not to hold and were corrected where the
sweep touched them: the transcript-indexing switch in Settings, General stops
the Logs index only, not the Tokenomics index (`PRIVACY.md`, app-knowledge
`privacy`); and Codex conversations are not in Logs (S11).

### Screenshots

No images were added. Images that showed a surface this release retired, and what became of each:

| Image | Showed | Decision |
| --- | --- | --- |
| `src/renderer/assets/training/step-security.jpg`, `step-security-mac.jpg` | The Settings rail with the retired Codex tab | No longer used: the Multiple Accounts, Settings and Sentinel cards now show the neutral `v2-shell-hero.jpg`, as the two new cards do. Needs a recapture of the current Settings, Accounts page. |
| `src/renderer/assets/training/step-vision.jpg` | The Conductor MCP page, whose Codex review card still points at "Settings -> Codex" | Kept on the Conductor MCP, Agent Canvas and Canvas Explained cards. Recaptured on the 2.1.1-beta.2 candidate and approved by the owner on 2026-10-07: it shows the page without that pointer. Its macOS variant `step-vision-mac.jpg` was recaptured on a macOS build of the same candidate and approved by the owner on 2026-10-07 too. |
| `docs/screenshots/settings.jpg`, `settings-mac.jpg` | A 1.5.x Settings page with the Codex tab | Referenced by nothing; nothing to remove. |
| `docs/screenshots/shot-memory.png` | The Memory page with the banner WP2 removed, and no Codex account's memories (P4.4 lists them) | Not recaptured: the README shows no Memory image, since a superseded shot beside text that contradicts it is worse than none (P4.11 review), and nothing references the file. |
| `docs/screenshots/shot-tokenomics.png` | Tokenomics without the provider and account filters and the split KPIs (the WP2 usage track) | Recaptured on the 2.1.1-beta.2 candidate and approved by the owner on 2026-10-07: it shows the provider and account filters. |
| `docs/screenshots/shot-sessions.png` | The stacked sidebar and separate tools row the 2.1 two-mode panel and one-row bar replaced (superseded before WP2) | Recaptured on the 2.1.1-beta.2 candidate and approved by the owner on 2026-10-07: it shows the current sidebar, with a Codex account beside the Claude accounts. |
| `docs/screenshots/shot-canvas.png` | The canvas before its review rework, with per-note Approve and Re-annotate (superseded before WP2) | Recaptured on the 2.1.1-beta.2 candidate and approved by the owner on 2026-10-07: it shows the current review. |

Corrected in P4.11: an earlier version of this record said none of the seven
README images showed a surface WP2 changed. Four do, listed above. The other
three (`hero-banner.png`, `shot-logs.png`, `shot-insights.png`) show the
stacked sidebar the 2.1 two-mode panel replaced, and the Insights account picker now
lists Codex accounts too (P4.7), so they were due a recapture as well. Corrected
again before the 2.1.1-beta.2 cut: the four rows above said the images had
been recaptured at the final head; they had not. The six README images and
the four Feature Guide images (`v2-shell-hero.jpg`, `step-session-options.jpg`,
`step-tokenomics.jpg`, `step-vision.jpg`) were then recaptured on the
2.1.1-beta.2 candidate and approved by the owner on 2026-10-07. Their macOS
variants `step-session-options-mac.jpg`, `step-tokenomics-mac.jpg` and
`step-vision-mac.jpg` were then recaptured on a macOS build of the
2.1.1-beta.2 candidate, made on a Mac from a later head of this branch, and
approved by the owner on 2026-10-07.

For the recapture (the VM for Windows and the Mac for macOS, never the owner's
machine): the capture tool runs the app on a home of its own inside its
throwaway data root (P4.11). It still has to seed Codex on with fictional
Claude and Codex accounts and open the Accounts tab for the Settings shot, and
its host safety is checked again with Codex on, a resources path with a space
on Windows included.

## 2. Code evidence for the privacy claims

| Claim (`PRIVACY.md`) | Code |
| --- | --- |
| A managed Codex home is `<resources>/codex-realms/<realmId>` | `src/main/providers/codex/realm-paths.ts:5`, `:19` |
| The folder is created before any sign-in | `src/main/providers/core/accounts-service.ts:705` (setup prepares the folder first); `src/main/providers/codex/realm-folders.ts:408-429` |
| The app never opens the sign-in file; it only checks whether it exists before removing an abandoned setup's folder | `src/main/providers/codex/auth-operations.ts:5-6`; `src/main/providers/codex/realm-folders.ts:311`, `:375-376`, `:503-505`; enforced by `tests/wp1/legacy-codex-retired.test.ts` |
| Sign-in state comes from `codex login status`: signed in with ChatGPT or an API key, no email or token | `src/main/providers/codex/cli-contract.ts:51-66` |
| The API key reaches Codex only on stdin, from a single-use handle; never logged; dropped after 120 s | `src/main/providers/codex/cli-runner.ts:38-39`, `:583-585`; `src/main/providers/codex/auth-operations.ts:371-385`, `:409`; `src/main/providers/core/secret-handles.ts:1-19`, `:24`, `:97` |
| `~/.codex` is never checked or taken in (since 2.1.1-beta.3, O5; 2.1.1-beta.2 checked it only after the user said they use Codex, and only on Use this sign-in took it in) | `src/main/providers/core/accounts-service.ts` `externalAdoptionRetired` (`probeExternalDefault` and `adoptExternalDefault` refuse with 'unsupported' first, before anything is reserved, written or run) and `changeLifecycle` (an archived account beta.2 registered for it is never restored); `src/main/provider-accounts.ts` (the composition root never sets the test seam `beta2ExternalAdoptionForTests`; nothing is taken in at start, and a check a beta.2 run left is dropped by `dropLeftoverExternalReservations`); `src/renderer/onboarding/CodexSetupStep.tsx` and `src/renderer/components/settings/accounts/ManagedAccountsSection.tsx` offer only Add Codex account. Tests: `tests/unit/main/provider-startup-no-adoption.test.ts` (the real composition root refuses), `tests/wp1/launch-handoff.test.ts` and `tests/wp1/provider-ipc.test.ts` (O5 blocks), `tests/wp1/account-lifecycle.test.ts` (no Restore). The beta.2 line references this row cited are superseded |
| A launch on `~/.codex` needs that launch's confirmation | `src/main/providers/core/accounts-service.ts:1854-1857` |
| `~/.codex` never runs a review | `src/main/providers/core/accounts-service.ts:1774` |
| The app never signs in to `~/.codex`; signing out of it needs a confirmation | `src/main/providers/codex/auth-operations.ts:392`; `src/main/providers/core/accounts-service.ts:1219` |
| Codex transcripts in `~/.codex` and in each account's folder feed Tokenomics | `src/main/tokenomics/tokenomics-service.ts:31`, `:88`, `:97` |
| The app removes an entry older versions added to Codex's `config.toml`, at tool-server start and stop | `src/main/providers/codex/mcp-config.ts:25-27`, `:85-105`; `src/main/conductor-mcp-server.ts:1615`, `:1630` |
| Version discovery runs in a throwaway home, never `~/.codex` | `src/main/providers/codex/discovery.ts:12-15` |
| An environment API key is left out of every Codex launch (known issue) | `src/main/providers/codex/index.ts:177-181` |
| The transcript switch stops the Logs index only | `src/main/logging/logging-service.ts:52-53`; `src/main/index.ts:828` (Tokenomics starts unconditionally) |
| Needs attention (S8) is a change in the kind of sign-in (ChatGPT or device code vs API key), not a different person: a check passes no subject, and Codex status reports none; Claude has no status check in this build | `src/main/providers/core/accounts-service.ts:1183-1186`; `src/shared/providers/registry.ts:267-271`, `:730`; `src/main/providers/codex/index.ts:132`; `src/main/providers/claude/index.ts:132` |

## 3. Release-run record (WP1.37, WP1.73)

Written for 2.1.1 at its qualification commit. **Status: recorded.** The commit, the builds, the CI runs, the agents'
runs on the Windows test VM and the Linux test host, the owner's sitting on the Windows test VM (2026-10-14) and the
known limitations are recorded here. No PENDING block is left, here or in the files this section cites. The owner
confirmed `docs/wp1/owner-decisions-2026-10-13.md` on 2026-10-14, and ruled OQ1 and SP1's amendment of WP1.52's
2.1.1 scope later that morning (section 3.10). WP1.37 and WP1.73 read `evidenced` in
`tests/wp1/traceability.json`, which declared the candidate for the promotion to main (back at phase gate0 on beta).

### 3.1 The tested commit

- **d1525759a7a42d941beeff601af3415fddd8afdd**, tree `12310fe71f3706f624e3905f8b92f06f099cdc3f`: the squash merge of
  PR #644 on beta (2026-10-13). Its only parent is `28ec75df2abdbd14afcf774c51c5ec7083928b21` (2.1.1-beta.3).
  `release/v2.1.1` points at it. It is the binding's head (`boundHead`): every evidence record names it, and only
  binding-neutral paths may change after it (`tests/wp1/binding.ts`).
- The pull request's head, `0834df263e40a727e787fc58a799ea552df84196`, and GitHub's merge commit for its final CI run,
  `72639eba01b52aebfde6a8fed05d67db0feadfb8`, have the same tree.
- `package.json` reads 2.1.1. The release notes are the 2.1.1 entry of `src/renderer/changelog.ts` at this commit,
  word for word.

### 3.2 The builds

The qualification build is release run 38409628911 (`release.yml`, `workflow_dispatch` on `release/v2.1.1`, channel
beta, `skip_vt=false`, attempt 1, conclusion success). Its `headSha` is the commit above. It published the prerelease
`v2.1.1-beta` (2026-10-13T14:24:49Z), a plain tag on that commit; the latest release stayed v2.1.0. A bare 2.1.1 on
the beta channel is tagged `v<version>-beta`, so the build reads 2.1.1 throughout.

| Asset | SHA-256 | Checks |
|---|---|---|
| `AI-Code-Conductor-2.1.1.exe` (194,103,848 bytes) | `da72adf4e5d9f175c9a3e8c1b58f8e4234f9be5f9acc2eeef7a4b64a0e6f5952` | Authenticode Valid, thumbprint `00EC0DEE208F91785D253C0731E28249C68053FD`, SSL.com timestamp, file and product version 2.1.1; the uninstaller it carries is Valid with the same thumbprint. VirusTotal 0 of 55 |
| `AICodeConductor-2.1.1-macos13.dmg` | `262cc39c0aca5dff04d41539b004b8aa3222df6e5626f291d0090d18fa4a6c0a` | The app inside: Developer ID signed (the same team as 2.1.0), hardened runtime, notarized, ticket stapled, `spctl` accepted. The DMG itself is unsigned and unstapled by design (known limitation 6). VirusTotal 0 of 52 |
| `AI-Code-Conductor-2.1.1-linux-x86_64.AppImage` | `7be0348a24a11fe58d90a75aa4594b9a31d6a24839f3e8714d68d5b64b5f952b` | Unsigned by convention. VirusTotal 0 of 50 |

`CHECKSUMS.txt` lists 8 assets; every line equals GitHub's own asset digest and the downloaded bytes. Each
`latest*.yml` reads 2.1.1 and names one file whose size and sha512 equal the downloaded bytes.

### 3.3 CI at the commit

| Run | What | Result |
|---|---|---|
| CI run 38400973974 (the pull request's final run, merge commit `72639eba`, the same tree) | `Test` on Windows, macOS and Linux; the minimum and pinned Codex legs on each OS; SSH smoke; Changelog in sync; Desktop test gate | All green, attempt 1 |
| Release run 38409628911 (the commit itself) | `build-windows` and `build-linux` run the whole suite (`npx vitest run`) before building | Green; every file's result equals the pull request run's on the same OS |
| CI run 38409643796 (`ci.yml` dispatch on `release/v2.1.1`, `codex_rc_version` 0.156.1) | The real-CLI conformance smoke: minimum, pinned and release candidate on each OS (WP1.71) | All 9 legs green |

The suite: 1,462 files on each OS; Windows 23,013 tests (22,891 passed, 1 expected fail, 119 skipped, 2 todo), macOS
22,970 (22,704 passed, 1 expected fail, 263 skipped, 2 todo), Linux 22,962 (22,683 passed, 1 expected fail, 276
skipped, 2 todo). No test failed and none was retried.
Every skip is explained in `skip-ledger.md`; per-OS detail is in `ci-matrix.md`. `release.yml` runs no test step on
macOS, so macOS has no suite run at the commit's own SHA; its run is the pull request's, on the same tree. The release
run's test steps ran with `WP1_PHASE` empty (a beta-channel run), so the traceability gate there ran at the manifest's
phase, gate0. The candidate phase first runs in the promotion pull request and the stable run.

### 3.4 CLI versions

- **Codex.** The minimum 0.153.4 and the pinned 0.155.1 (`src/main/providers/codex/cli-contract.ts`), and the release
  candidate 0.156.1, the newest version tested against the app (the owner confirmed that choice on 2026-10-14,
  `docs/wp1/owner-decisions-2026-10-13.md#RC1`). In CI each was installed from the published `@openai/codex` package.
  On the Windows test VM: 0.153.4 and 0.155.1, each as the npm `codex.cmd` shim and as the `codex.exe` its npm install
  ships. The packaged smokes and the owner's sitting use 0.155.1. On the Linux test host: 0.155.1 only, the npm
  package's own binary (0.153.4 is not on that host).
- **Claude Code.** No session of a real Claude Code runs in CI or in the agents' runs: their sessions use a stand-in
  that answers `--version` with `2.1.296 (Claude Code)` and records each start. At the owner's sitting the disposable
  Claude account was signed in, and a Claude session in that copy asked Codex for a review (`real-cli-matrix.md`,
  WP1.64). The authority list the app strips is derived from Claude Code 2.1.278 (known limitation 9).

### 3.5 Runners and hosts

- **CI:** `windows-2025` (image windows-2025-vs2026, 20260925.250.1), `macos-latest` (macos-26-arm64, 20260907.0351.1)
  and `ubuntu-latest` (ubuntu-24.04, 20261004.327.1), Node 20.20.2.
- **The Windows test VM:** Hyper-V, Windows 11 Enterprise Evaluation, x64. The dev build at the commit for the e2e
  matrix and the real-CLI rows (Node 24.16.0, Electron 44.5.1, @playwright/test 1.63.0); the signed installer for the
  packaged smoke, in a standard (non-administrator) account; for the owner's sitting, a hash-equal copy of that install
  in the VM's administrator test account, at the console (an interactive logon), the app not elevated.
- **The macOS test Mac:** macOS 27.0.1, arm64; a standard test user for the owner's run, which was not run.
- **The Linux test host:** Rocky Linux 10.2, x86_64, GNOME on Wayland; a fresh standard test user, logged in at the
  console by the owner. The agent worked inside that session over key SSH, with no administrator rights.

### 3.6 Commands

- CI: `gh workflow run release.yml --ref release/v2.1.1 -f channel=beta -f skip_vt=false`;
  `gh workflow run ci.yml --ref release/v2.1.1 -f codex_rc_version=0.156.1`; each run read with `gh run view` and its
  job logs (`ci-matrix.md`, `skip-ledger.md`).
- The release: the shared release verifier (tag, version, assets, update metadata, `CHECKSUMS.txt`),
  `Get-AuthenticodeSignature` on the installer and on the uninstaller it carries, `node scripts/gen-changelog.js
  --notes 2.1.1` at the commit against the release body, and VirusTotal read per file.
- The Windows test VM: `git checkout --detach d1525759a7a42d941beeff601af3415fddd8afdd`, `npm run build`, then
  `npx playwright test --reporter=line,json` with the 27 tracked specs named (`mode-matrix.md`) and with a VM-local
  spec for the real-CLI rows (`real-cli-matrix.md`); the signed installers by double-click and their wizards
  (`packaged-smoke.md`, `rollback.md`); the app's own Codex install, driven over a loopback DevTools port in a fresh
  install of the qualification build (`real-cli-matrix.md`, WP1.32).
- The owner's sitting on the Windows test VM: the app's own pages and buttons, by the owner, with the app's state read
  over a loopback DevTools port; two staged scripts for the console check and its harness cause; one for the managed
  re-authentication proof (`codex login status` and `codex logout` with `CODEX_HOME` set per folder); for the window
  buttons, mouse events injected into the page through the loopback DevTools port, not the operating system's mouse,
  each after the page's own hit test (`real-cli-matrix.md`, `packaged-smoke.md`).
- The Mac: `spctl -a -t exec -vv`, `xcrun stapler validate`, `codesign --verify --deep --strict -vv` and the bundle's
  `Info.plist`, on the DMG mounted read-only (`packaged-smoke.md`).
- The Linux test host: the AppImage checked against `CHECKSUMS.txt`, and against its SHA-256 before each start; started
  with `--appimage-extract-and-run` (and `--ozone-platform=x11` once the screen had locked) and a loopback DevTools
  port, and driven over it by a client on the host; `codex login status` per account folder; the loopback fake model;
  process, port and file-hash reads (`packaged-smoke.md`, `rollback.md`, `real-cli-matrix.md`).

### 3.7 The scope of the real smoke

Recorded at the commit:
- the e2e mode matrix on the Windows test VM, every cell green, with the real Codex 0.153.4 and 0.155.1 in the minimum
  real launch (`mode-matrix.md`; WP1.1, WP1.60);
- the real-CLI rows 2, 9, 25 and 33 and the no-item rows 1, 12, 23 and 48 on the Windows test VM: the real CLI on both
  versions and both install routes, fake keys, the loopback fake model, no real sign-in (`real-cli-matrix.md`);
- the non-secret conformance smoke on the minimum, pinned and release-candidate CLI on all three OSes
  (`real-cli-matrix.md`, WP1.71);
- the packaged smoke of the signed installer on Windows, and the macOS signature, notarization and Gatekeeper checks
  (`packaged-smoke.md`);
- the packaged upgrade from 2.1.0 on Windows (`packaged-smoke.md`, "Upgrade from 2.1.0"). Every check passed, Vision
  by the console check: Vision did not start in the agent's network logon (known limitation 11), and in an interactive
  logon the console check passed (below). The What's New heading names the release the user comes from, which the owner
  ruled correct (`docs/wp1/owner-decisions-2026-10-13.md#WN1`);
- the install chain on Windows: 2.1.1-beta.2, the qualification build, 2.1.1-beta.1, 2.1.0 and the qualification build
  again, then a second run that repeated the 2.1.1-beta.2 and 2.1.1-beta.1 steps, each installed over the qualification
  build. Every step passed (Vision aside, as above). The profile starts at those two steps, not confirmed in the first
  run, were confirmed in the second (`rollback.md`, note 1);
- the app's own Codex install on Windows ("Run it for me", WP1.32): OpenAI's installer route reached a version class,
  and counts as the Windows install smoke (`docs/wp1/owner-decisions-2026-10-13.md#OQ2`). The npm route installed
  Codex, but the app found it only once npm's global folder was on the user's PATH, which proves why it did not before
  (`real-cli-matrix.md`; known limitation 12);
- the owner's sitting on the Windows test VM, 2026-10-14, in an interactive logon with the app not elevated
  (`real-cli-matrix.md`, `packaged-smoke.md`):
  - the console check: the app recognised a leftover browser of 2.1.0's shape as its own, ended it and started Vision;
    the test copy's own Vision browser then did not connect, for a harness cause that was proven (known limitation 14);
  - two managed Codex accounts signed in by the browser sign-in with the owner's consented identity (WP1.20, WP1.10,
    and WP1.32's sign-in through the app), one made the reviewer default;
  - a real prompt in a Codex session on a managed account, on a model the owner chose as GPT-6 (not read independently);
  - the disposable Claude account signed in, and `codex_review` asked from a Claude session on Codex 0.155.1, which
    answered with Codex's finding;
  - a link in a session's output, which opened in the default browser;
  - Sign in again on a Codex account, then WP1.52's proof: the old sign-in folder signed out with `codex logout`, the
    new one still signed in, the file store in both (once, on 0.155.1). Sign in again's "same account" box starts
    unticked (known limitation 13);
  - the window buttons on the setup page and the Multi Spawn page: each button's action worked, clicked by the agent
    through the DevTools port, which cannot rule out a window drag region over a button (`packaged-smoke.md`);
- the packaged run on the Linux test host, 2026-10-14, in the test user's graphical session: a clean run of the
  AppImage, then the upgrade from 2.1.0 and the rollback to it, on the same data. Every check passed. Every start used
  `--appimage-extract-and-run` (known limitation 1). The screen was locked, so the sessions, the typing, the upgrade
  and the rollback ran on X11 through Xwayland, not native Wayland; the typing was injected through the DevTools port;
  and there are no screenshots (known limitation 16; `packaged-smoke.md`, `rollback.md`);
- WP1.2's rows 9, 25 and 33 on the Linux test host, on the packaged qualification build, with Codex 0.155.1, fake keys
  and the loopback fake model: rows 9 and 33 passed, and row 25's index matched its rule on every session, with F-L1-2
  reproduced on a labelled synthetic rollout (`real-cli-matrix.md`; known limitation 8).

Not run, on the owner's ruling of 2026-10-14 (`docs/wp1/owner-decisions-2026-10-13.md#SP1`; known limitation 15):
- on the Windows test VM: Sign in again a second and a third time (Codex 0.153.4, the keyring store), the second
  consented identity's run, `codex_review` on Codex 0.153.4, the disposable Claude account's sign-out and its check after
  a relaunch, and the keyring smoke (the keyring store is out of 2.1.1's scope, `#KR1`);
- on the macOS test user: the owner's install, first launch, Codex sign-in, prompt, upgrade from 2.1.0 and rollback
  (`#UA8`).

Not run on macOS either: WP1.2's rows 9, 25 and 33 with fake keys, with the macOS test user's sitting, on the
owner's later ruling of 2026-10-14 (`docs/wp1/owner-decisions-2026-10-13.md#OQ1`, section 3.10).

Not taken: section 4 row 18, the session-strip meters with a working model (known limitation 3).

### 3.8 Known limitations

Items 2 to 4 and 15 are checks not taken, each citing the owner-decision section that says why. The others are limits
of this release or of what was taken, each with the file that records it where there is one. They cite no owner
decision, except that item 8 cites AM3, which accepts its second finding, and item 12 cites the owner's ruling that
accepts it (OQ2). The owner confirmed every section cited here on 2026-10-14: OQ1, which item 4 cites, and SP1's
amendment of WP1.52's 2.1.1 scope, which item 15 bears on, by the later ruling in section 3.10.

1. **Linux: the AppImage needs FUSE 2.** Start the AppImage with `--appimage-extract-and-run` where FUSE 2's
   `fusermount` is missing, because the AppImage cannot mount there. This was seen on the Rocky Linux 10.2 test host,
   which had FUSE 2's library and FUSE 3, but no `fusermount` (`packaged-smoke.md`). 2.1.0's AppImage fails the same
   way. `README.md` (Requirements) says so.
2. **Release-plan checks not taken** (`docs/wp1/owner-decisions-2026-10-13.md#KL1`): the API-key sign-in, status and
   sign-out on every OS; the ChatGPT sign-in, status and sign-out on Linux; launch, resume and the account picker on
   Linux (section 4 rows 9, 23 and 33); a real install through the app on macOS and Linux (row 3). Rows 9 and 33 on
   Linux were later taken with fake keys, for WP1.2 (`real-cli-matrix.md`); signed in, and row 23, they were not.
3. **No-item rows not taken on Windows** (`docs/wp1/owner-decisions-2026-10-13.md#KL2`): section 4 rows 13, 18, 21,
   27, 50, 64 and 74 on the Windows test VM, which could have been taken and were not run. Row 21 was skipped for a
   harness gap (its usage-header pills needed more test harness than the time left allowed), rows 64 and 74 were
   passed over for row 12, and rows 13, 27 and 50 were not reached in the window. Row 18 (the session-strip meters
   with a working model, the owner's) was not taken at the owner's sitting: the prompt was sent, but the meters and its
   rollout were not read (`real-cli-matrix.md`).
4. **Other checks not taken** (`docs/wp1/owner-decisions-2026-10-13.md#KL3`): the macOS and Linux columns of the
   section 4 rows that nothing else covers; the four WP1.30 cases that need a non-elevated Windows process (the CI
   runner is elevated, so they skip by design; every other WP1.30 case ran on each OS, `ci-matrix.md`); and the
   rollback rehearsal of the published release (set to draft, gone from the in-app update list, published again),
   refused by the agent's permission policy as a change to a public release, with its pre-checks passed. KL3 does not
   cover the macOS and Linux columns of rows 9, 25 and 33 (WP1.2) or row 49 (WP1.64): they are parts of those items.
   Their signed-in parts are unavailable (UA1 on Linux; UA6, `codex_review` on macOS and Linux; UA8 for the macOS
   sitting; section 3.9). Of rows 9, 25 and 33 with fake keys, the Linux columns were taken (`real-cli-matrix.md`) and
   the macOS columns were not run, on the owner's ruling (`docs/wp1/owner-decisions-2026-10-13.md#OQ1`, under UA8).
5. **Cases that run in no CI job.** `skip-ledger.md` ("Unexplained or to decide") lists them with where each would
   run: the makensis cases, the opt-in real-Claude and live cases, the manual console check, the authority-list
   re-derivation, cases that need Node 24, other shells, or helper-made folders on a VM, and the WP1.30 cases above.
6. **The macOS DMG is unsigned and unstapled by design** (`build.dmg.sign: false`, unchanged since 2.1.0). The app
   inside it is signed, notarized and stapled, and Gatekeeper accepts it.
7. **The Vision browser outlives Quit when the app runs in a non-administrator network logon.** The app ends it with
   `taskkill`, which such a logon is denied. In an administrator's logon the same build ended it at every quit. In an
   interactive logon with the app not elevated it was not observed: at the owner's sitting the test copy's own Vision
   browser never opened its port (item 14), and its quit was not checked for a leftover browser (`packaged-smoke.md`).
   2.1.0 leaves it running after every quit, so this is not a regression.
8. **Two findings, neither severe nor a regression against 2.1.0** (`real-cli-matrix.md`):
   - a Codex tab started through the npm `codex.cmd` shim, whose configured project folder differs in letter case from
     the folder on disk, opens the resume list after a relaunch instead of resuming directly. It lists only that
     account's conversation, and nothing is lost; 2.1.0 has no exact Codex resume at all;
   - Tokenomics prices a Codex `token_count` event that repeats the previous cumulative total. In 1 of 6 real
     rollouts, 3 turns were priced twice (0.63% over that rollout's own total). 2.1.0 has the same rule. The owner
     accepted it for WP1.2's row 25 (`docs/wp1/owner-decisions-2026-10-13.md#AM3`);
   - on Linux, F-L1-1's letter-case form cannot arise and did not; a project folder reached through a symbolic link,
     which could miss the claim in the same way, was not tested. F-L1-2 reproduced there on a labelled synthetic
     rollout that repeats its one usage event.
9. **WP1.38** (ADR-026, settled point 4): the authority list is derived from Claude Code 2.1.278, and a later Claude
   Code is not re-derived in this release; the in-app project-gate refusal and worktree resume were last run on the
   installed app at `c9c908a5` and `f2332e39`, not at the commit above.
10. **WP1.71:** the release-candidate legs capture the help but do not compare it, since no fixture exists for 0.156.1.
    The smoke is non-secret by design: it proves detection, the command lines' flags, the model list and the features
    against each real CLI, not a signed-in turn.
11. **Windows: Vision may not start after an upgrade from 2.1.0, in a logon where the app cannot list running
    programs.** 2.1.0's Vision browser outlives 2.1.0's quit and keeps port 9222. At each start the qualification build
    first asks Windows (CIM) which program holds that port, and ends the browser only if it is the app's own. The
    agent's non-administrator NETWORK-token logon is denied that query, so there the build ended nothing and did not
    start Vision, and logged that port 9222 is in use (`packaged-smoke.md`, "Upgrade from 2.1.0"). In the same logon
    2.1.0 and 2.1.1-beta.1 attach to the leftover browser and start Vision (`rollback.md`, "Vision"), so in that logon
    type this differs from 2.1.0. In an interactive logon it does not happen: at the owner's console check the same
    build, not elevated, recognised a leftover browser of 2.1.0's shape as its own, ended it and started Vision
    (`packaged-smoke.md`). The app's help carries a known issue for it after an in-app update from 2.1.0, with the
    workaround: sign out of Windows and back in, or restart the computer; Vision then starts.
12. **Windows: "Run it for me" with npm does not find Codex where npm's global folder is not on the user's PATH.** On a
    computer where another user installed Node.js, npm installs Codex into the account's own npm folder
    (`%APPDATA%\npm`), which is then on neither the user's nor the computer's PATH. The app looks for Codex only on the
    PATH (re-read from the registry after an install), so Set up Codex reads "The command ended, but Codex was still
    not found". With that folder on the user's PATH the same build found that Codex (`real-cli-matrix.md`, WP1.32).
    Workaround: use OpenAI's installer, the other recipe on the same page, which found Codex in the same account; or
    add that folder to the PATH and run it again.
    Not a regression: 2.1.0 has no "Run it for me". The app's help does not carry this yet: its known issues live in
    `src/shared/app-knowledge.ts`, which is not a binding-neutral path, so the entry, and a check that also looks in
    npm's global folder or a message that names the PATH cause, are follow-ups for the next release.
    The owner accepted this as a known limitation on 2026-10-14 (`docs/wp1/owner-decisions-2026-10-13.md#OQ2`).
13. **Codex: Sign in again's "Sign in to the same account as before." box starts unticked.** Left unticked, the sign-in
    is added as a new account, by design, and the account it was started from is left as it was. At the owner's
    sitting the obvious path made a second account this way (`real-cli-matrix.md`). Workaround: tick the box. A
    follow-up for 2.1.2.
14. **The owner's sitting: the test copy's Vision did not connect, because of the test harness, not the product.** The
    sitting's launcher gave the app a home folder of its own (`USERPROFILE` and `HOME`). Chrome 155 started that way
    refuses remote debugging ("DevTools remote debugging requires a non-default data directory") and never opens its
    port. With the account's normal environment the same Chrome, with the app's arguments, listened within about half a
    second (`packaged-smoke.md`). A normal install sets no such override.
15. **Checks the owner's short path left out** (`docs/wp1/owner-decisions-2026-10-13.md#SP1`): on the Windows test VM,
    Sign in again a second and a third time (Codex 0.153.4, the keyring store), the second consented identity's run,
    `codex_review` on Codex 0.153.4, the disposable Claude account's sign-out and its check after a relaunch, and the
    keyring smoke; and the owner's run on the macOS test user. A part of an item that may read `unavailable` is in
    section 3.9. WP1.52's VM proof was taken once, on Codex 0.155.1 with the file store; the keyring store is out of
    2.1.1's scope (`docs/wp1/owner-decisions-2026-10-13.md#KR1`).
16. **Linux: what the packaged run did not exercise.** GNOME's idle lock had locked the test user's screen, and the
    agent did not unlock it; a locked Wayland session gives the window no frames. So the sessions, the typing, the
    upgrade and the rollback ran on X11 through Xwayland, not native Wayland. The typing was injected through the
    DevTools port, so the desktop's own keyboard path, and typing into a terminal under native Wayland, were not
    tested. There are no screenshots. Only Codex 0.155.1, on one install route, was on the host (`packaged-smoke.md`,
    `real-cli-matrix.md`).

### 3.9 Unavailable items

Eight items read `unavailable`, each on a section of `docs/wp1/owner-decisions-2026-10-13.md` the owner confirmed on
2026-10-14. The OQ1 lines in UA1 and UA8, for WP1.2's rows 9, 25 and 33 on macOS with fake keys, rest on the owner's
later ruling of OQ1 the same day (section 3.10). Each decision section says what was taken.

| Item | Status | What is unavailable | Decision |
|---|---|---|---|
| WP1.10 | `unavailable` | The two-account run on macOS and Linux; on Windows, the run with the second consented identity, not run on the owner's short path | `docs/wp1/owner-decisions-2026-10-13.md#UA2` |
| WP1.11 | `unavailable` | The native keyring smoke with a second identity on macOS and Linux; on Windows, the keyring smoke, the store being out of 2.1.1's scope | `docs/wp1/owner-decisions-2026-10-13.md#UA3` |
| WP1.20 | `unavailable` | A disposable identity for the browser sign-in, and the Linux sign-in; the macOS sign-in, not run (UA8) | `docs/wp1/owner-decisions-2026-10-13.md#UA4` |
| WP1.32 | `unavailable` | The real installer smoke through the app on macOS and Linux | `docs/wp1/owner-decisions-2026-10-13.md#UA5` |
| WP1.64 | `unavailable` | Disposable Codex identities, the API-key flow, the second-identity flows off Windows, every credential-bearing flow on Linux, `codex_review` (section 4 row 49) on macOS and Linux; on the owner's short path the Claude sign-out and its relaunch check, `codex_review` on 0.153.4 and the second identity's flows on Windows; the macOS sign-in (UA8) | `docs/wp1/owner-decisions-2026-10-13.md#UA6` |
| WP1.72 | `unavailable` | An ephemeral identity, the macOS and Linux stores, and the Windows smoke, the store being out of 2.1.1's scope | `docs/wp1/owner-decisions-2026-10-13.md#UA7` |
| WP1.2 | `unavailable` | A real, signed-in Codex-only session on Linux, with section 4 rows 9, 25 and 33 there in a signed-in session; on macOS, the signed-in session and rows 9, 25 and 33 with fake keys, not run (UA8, OQ1) | `docs/wp1/owner-decisions-2026-10-13.md#UA1` |
| WP1.63 | `unavailable` | The owner's install, first launch, upgrade and rollback on the macOS test user, not run on the owner's ruling | `docs/wp1/owner-decisions-2026-10-13.md#UA8` |

WP1.2's rows 9, 25 and 33 with fake keys were taken on Linux (`real-cli-matrix.md`) and not run on macOS (OQ1, under
UA8). Its row 25 reads as AM3 amends it, so WP1.2 also cites the decisions file as evidence. WP1.63's Linux run is
recorded (`packaged-smoke.md`); only its macOS host part is unavailable.

The candidate run prints the items that read `unavailable` (`WP1 candidate: unavailable on a recorded owner decision:
...`), and that list goes to go with this section.

### 3.10 Owner answers

Given on 2026-10-14, in one answer ("Yes") to "may I record every remaining decision at its default?"
(`docs/wp1/owner-decisions-2026-10-13.md`, its status paragraph, which quotes the question's list as it was recorded):
- confirmed as drafted: UA1 to UA7 (UA1 to UA4, UA6 and UA7 gained their "Not run (2026-10-14)" rows afterwards,
  from the answer's lines), AM1 (WP1.73's text), AM2 (WP1.19), KL1, KL2 and KL3. Written afterwards, each from a line
  of the list the owner confirmed: UA8 (the macOS sitting), AM3 (WP1.2's row 25, finding F-L1-2), KR1 (the keyring
  store out of 2.1.1's scope), RC1 (WP1.71's release candidate, 0.156.1), SP1 (the checks the short path left out)
  and WN1 (the What's New heading). UA1, UA8, KL3 and SP1 were then updated for OQ1, below;
- OQ1: not ruled by this answer. The list as first recorded named it ("OQ1 = take the fake-key macOS and Linux
  columns"), but that line was the coordinating agent's paraphrase, not part of the question, which did not name OQ1.
  The owner ruled its macOS part later the same morning (below): the macOS columns of WP1.2's rows 9, 25 and 33 with
  fake keys are recorded as not run. The Linux columns were taken by an agent run on the Linux test host
  (`docs/wp1/owner-decisions-2026-10-13.md#OQ1`);
- WP1.52: SP1 amends its 2.1.1 scope to the one run taken (Sign in again once, on Codex 0.155.1 with the file store).
  This answer's question named neither WP1.52, nor Sign in again's run on Codex 0.153.4, nor any amendment; the owner
  ruled the amendment later the same morning (below; `docs/wp1/owner-decisions-2026-10-13.md#SP1`);
- OQ2: its default. OpenAI's installer route is WP1.32's Windows install smoke, and the npm route in an account whose
  npm global folder is on no PATH is known limitation 12. WP1.32's sign-in through the app was taken at the owner's
  sitting;
- the What's New heading: "What's new since 2.1.0" is correct, and the upgrade check's heading clause reads "What's new
  since <from-version>" (WN1). No wording change, so the binding head does not move;
- WP1.30's four non-elevated Windows cases: KL3's row confirmed, which this section had set out before the answer as
  against ADR-026 settled points 2 and 5. WP1.30 reads `evidenced`, with those cases as known limitation 4, and no
  non-elevated VM run is taken for 2.1.1.

The owner's go (the plan's Q5), which this answer did not give, was given later on 2026-10-14, at about 02:12 BST, on
condition that the remaining gates pass with no severe finding: the Linux run and its independent check, the review of
this evidence, the candidate check, and green CI on the promotion pull request. A severe finding or a red gate goes
back to the owner. The go came before the OQ1 correction, and its conditions did not include a ruling on OQ1 or on
WP1.52's amendment, so both were then put to the owner in one question of their own. At about 06:00 BST on
2026-10-14 the owner ruled both, answering "OK both vms are on - go" (the question and the answer are quoted in
`docs/wp1/owner-decisions-2026-10-13.md#OQ1` and `docs/wp1/owner-decisions-2026-10-13.md#SP1`): WP1.2's rows 9, 25
and 33 on macOS with fake keys are recorded as not run with the macOS sitting (UA8); and WP1.52's 2.1.1 proof is the
one Sign in again run taken, on Codex 0.155.1 with the file store, its runs on Codex 0.153.4 and with the keyring
store recorded as not run. The promotion pull request is merged with "Create a merge commit", so the commit above
stays an ancestor of main.

## 4. Verification owed by the 20 DONE rows (PR 4, P4.10)

20 of the 52 DONE parity rows (75 rows in all; of the other DONE rows, 27 owe
PR 3's VM checks and 5 owe nothing) have an automated test on the Codex path
and owe only real-CLI, per-OS or packaged verification
(`docs/wp2/completion-plan.md` section 2): rows 1, 2, 3, 4, 6, 9, 12, 13, 18,
21, 23, 25, 27, 29, 33, 48, 49, 50, 64 and 74. PR 4 records their Windows
column, and OR1 records rows 4 and 6 on macOS and Linux as well; the other
rows' macOS and Linux columns and the signed packaged build close at release.
This section is the map, not the evidence: every check below is still owed,
and each is run on PR 4's final head (P4.10 runs last) and recorded in the file
named.

Who runs each check:

- **VM agent**: the Windows test VM, no real sign-in: throwaway Codex homes
  signed in with a fake key behind a dead proxy, the loopback fake model or
  the stand-in Claude, the real Codex 0.153.4 and 0.155.1, under the VM rules
  of plan 9.2 (nothing typed into a composer that is not ready; the sandbox
  menu answered only on a verified "2." row; `config.toml` hashed before and
  after every writable step; the VM user's own `~/.codex` never started or
  written).
- **OR1**: the owner, on real accounts on the owner's hosts, one per OS
  (Windows, macOS, and Linux Ubuntu 24.04 or newer), with two disposable
  ChatGPT identities and a throwaway OpenAI API key, on PR 4's final build.
  These checks block merging PR 4, not building it (OD20 D8; plan 9.5).
- **OR4**: the owner, with a working model.
- **Release**: nothing owed on Windows; the row closes at release.

Where each check is recorded:

- `docs/wp1/evidence/real-cli-matrix.md` (P4.10 writes it; cited by WP1.2,
  WP1.10, WP1.20, WP1.32, WP1.64, WP1.71), in two parts: the item part, for
  the checks a citing item claims (rows 2, 3, 4, 6, 9, 25, 33 and 49), and the
  no-item part, for the checks no citing item claims (rows 1, 12, 13, 18, 21,
  23, 27, 29, 48, 50, 64 and 74). Each entry gives the CLI version and route,
  the actor and the commands.
  The WP1 items column below names the items a row relates to; an item's
  evidence record covers a check only where the item cites the file.
- `docs/wp1/evidence/keyring-smoke.md` (P4.10, OR1; WP1.11, WP1.72).
- `docs/wp1/evidence/packaged-smoke.md` (P4.10, from the owner's packaged smoke
  of the PR 4 build; WP1.63 stays `planned` until the signed release run).
- `docs/wp1/evidence/ci-matrix.md` and `mode-matrix.md` (lane E, P4.8 and
  P4.9).
- Every evidence file names the full 40-hex head its checks ran on, and its
  record in `tests/wp1/traceability.json` gives the same head, which must be
  the binding's `boundHead` (`tests/wp1/traceability.test.ts`).
- The result also goes on the row itself, in `docs/wp2/parity-checklist.md`
  and section 4 of the completion plan (the integration owner).

| Row | Feature | Check owed in PR 4 (Windows unless an OS is named) | Who | Recorded in | WP1 items | Left for release |
|---|---|---|---|---|---|---|
| 1 | Provider on/off, "not set up", last provider on | With the real CLI at 0.153.4 and 0.155.1: an unanswered Codex starts nothing; Codex off refuses its configs and restored tabs with the off wording; the last provider on cannot be turned off | VM agent | `real-cli-matrix.md` (no-item part); the fake-CLI e2e side in `mode-matrix.md` (P4.9) | WP1.1, WP1.3, WP1.6, WP1.7, WP1.60 | Packaged on a clean machine per OS (`packaged-smoke.md`, WP1.63); macOS, Linux |
| 2 | CLI detect and version classes | The minimum 0.153.4 and the pinned 0.155.1 detected and classed on both install routes (the `codex.exe` each npm install ships, and its `.cmd` shim); per OS also from P4.8's real-CLI job | VM agent; CI (P4.8) | `real-cli-matrix.md`; `ci-matrix.md` | WP1.17, WP1.44, WP1.49, WP1.71 (minimum and pinned) | The release-candidate CLI (WP1.71); macOS, Linux |
| 3 | Install and update | None on Windows (the 2026-09-26 upgrade walk ran the npm install and the npm update there) | Release | `real-cli-matrix.md`, at release | WP1.18, WP1.19, WP1.32 | One real install per OS on macOS and Linux; Homebrew unrun |
| 4 | Sign-in (browser, API key) | On Windows, macOS and Linux: a real sign-in with a disposable ChatGPT identity and with the API key, status and sign-out, on a managed account (the owner's browser sign-in on Windows, 0.157.1, predates the final build) | OR1 | `real-cli-matrix.md` | WP1.20, WP1.22, WP1.23, WP1.64 | None: OR1 closes every OS before merge |
| 6 | Multiple isolated accounts | On Windows, macOS and Linux: a real two-account run (each disposable identity signs in to its own folder, and status and sign-out of one leave the other untouched) and the native keyring smoke on that OS's own credential store | OR1 | `real-cli-matrix.md` (WP1.10); `keyring-smoke.md` (WP1.11, WP1.72) | WP1.10, WP1.11, WP1.72 | None: OR1 closes every OS before merge |
| 9 | Launch and resume in the exact account | A tab restored after a relaunch keeps its managed account and resumes in that account's folder, on 0.153.4 and 0.155.1 | VM agent | `real-cli-matrix.md` | WP1.2, WP1.38, WP1.42 | macOS, Linux |
| 12 | Upgrade question and the read-only sign-in check | The check of this computer's sign-in (a throwaway `CODEX_HOME` standing in for `~/.codex`) and "Use this sign-in" on 0.153.4 and 0.155.1, with the CLI's own scratch writes under `tmp/` recorded on 0.155.1. Retired in 2.1.1-beta.3 (O5, owner decision 2026-10-11): the check and "Use this sign-in" are refused by main, so only the upgrade question is still owed here | VM agent | `real-cli-matrix.md` (no-item part) | WP1.5, WP1.43 | macOS, Linux; the upgrade walk again on the signed release candidate |
| 13 | Hello Codex | On the final build (P4.1 and P4.2 change its copy): shown after Set up Codex once a managed account is signed in, marked seen, not shown on relaunch, replayed from Accounts and from the Feature Guide | VM agent | `real-cli-matrix.md` (no-item part); the owner's screenshot review | none (HCS; `hello-codex.acceptance.test.ts`) | macOS, Linux |
| 18 | Session-strip meters | A 0.155.1 rollout fixture taken from a real session (OD27 M3), and a real-CLI run with a working model | OR4 | `real-cli-matrix.md` (no-item part); the fixture beside the strip's tests | none | macOS, Linux |
| 21 | Multi-account footer | Two managed accounts live at once on the packaged PR 4 build with the real CLI, the fake model sending usage headers: one pill per identity, grouped by provider | VM agent | `real-cli-matrix.md` (no-item part) | none | Packaged on macOS and Linux |
| 23 | Choose the account at launch | The new-config picker on a managed account (no confirmation) and on this computer's sign-in (a throwaway `CODEX_HOME`; the per-launch confirmation), on 0.153.4 and 0.155.1 | VM agent | `real-cli-matrix.md` (no-item part) | WP1.38, WP1.42 | macOS, Linux |
| 25 | Tokenomics reads managed realms and `~/.codex` | Real rollouts copied read-only from the VM user's `~/.codex/sessions` into a throwaway home (no Codex started there), indexed beside a managed realm's fake-model rollouts, each turn priced once | VM agent | `real-cli-matrix.md` | WP1.2 (`tokenomics-realm-discovery.test.ts`) | macOS, Linux |
| 27 | Subagent collision | A 0.155.1 subagent rollout indexed without a collision (the #307 fix, `7fc96639`), if the fake model can drive a subagent; otherwise from a real session | VM agent, else OR4 | `real-cli-matrix.md` (no-item part) | none | macOS, Linux |
| 29 | Plan type | None on Windows (the MP8 VM walk showed the plan on 0.153.4 and 0.155.1) | Release | `real-cli-matrix.md` (no-item part), at release | none | macOS, Linux, packaged |
| 33 | Resume in the exact realm | Two managed accounts with a conversation each: the second account's picker never lists the first's, on 0.153.4 and 0.155.1 | VM agent | `real-cli-matrix.md` | WP1.2, WP1.38 | macOS, Linux |
| 48 | Conductor MCP transport | A live 0.155.1 tool listing of the Conductor MCP server through Codex's tool search, on the final build (P4.1 and P4.2 add tools) | VM agent | `real-cli-matrix.md` (no-item part) | none (WP1.68's per-spawn MCP outcome is evidenced by the ledger) | macOS, Linux |
| 49 | `codex_review` | A real run on a signed-in account with a working model | OR4 | `real-cli-matrix.md` (WP1.64) | WP1.64 | macOS, Linux |
| 50 | `claude_review` | A live wait past 300 s, with the stand-in Claude if it can hold a review that long; otherwise a real one | VM agent, else OR4 | `real-cli-matrix.md` (no-item part) | none | macOS, Linux |
| 64 | Partner terminal wording | On a live Codex tab (real CLI) and a Claude tab (the stand-in Claude), the strip names the tab's assistant; at a narrow window the label clears the floating GitHub button (P3.7's fix, `b1cffc71`) | VM agent | `real-cli-matrix.md` (no-item part); the owner's screenshot review | none | macOS, Linux |
| 74 | Command buttons, preset pill, restart menu, theme | The real-CLI pass on 0.153.4 and 0.155.1: a command button's text reaches Codex, the preset pill, Restart and Restart and pick a conversation, light and dark themes | VM agent | `real-cli-matrix.md` (no-item part); the owner's screenshot review | none | macOS, Linux |

Counts: VM agent 12 rows (1, 2, 9, 12, 13, 21, 23, 25, 33, 48, 64, 74), and
rows 27 and 50 when the fake model can make their evidence; OR1 2 rows (4, 6),
on every OS; OR4 2 rows (18, 49), and rows 27 and 50 otherwise; nothing on
Windows for 2 rows (3, 29). The items only the release can evidence stay
`planned` with that reason: the signed packaged smoke (row 66, WP1.63), the
release-candidate CLI (WP1.71) and this file's section 3 (WP1.37).
