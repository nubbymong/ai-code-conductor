# Contributing to AI Code Conductor

Thanks for your interest in contributing! This document covers setup, coding standards, and the PR process.

## Prerequisites

- Node.js 20+
- npm 9+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Optional: OpenAI's [Codex CLI](https://github.com/openai/codex) 0.153.4 or newer, to work on Codex features
- Windows 10/11, macOS 13+, or Linux with glibc 2.39+ (Linux support is experimental — verified on Ubuntu 24.04 and Rocky 10)

## Getting Started

```bash
git clone https://github.com/nubbymong/ai-code-conductor.git
cd ai-code-conductor
npm install
npm run dev
```

This starts the app in development mode with hot module reloading. Changes to renderer code (React components, styles) update instantly. Main process changes require a restart.

### Native modules and local packaging

The install's `postinstall` (`scripts/postinstall-native.mjs`) gets node-pty and better-sqlite3 ready for Electron:

- **Windows:** it uses the prebuilt binaries both packages ship, as CI and the release build do, so no C++ toolchain is needed. A module with no prebuild for your architecture is built from source. Building from source (`npm run rebuild`) needs Visual Studio 2022 with the Desktop development with C++ workload and the Spectre-mitigated libraries for its MSVC version; without them node-pty's build stops at MSB8040. After `npm run rebuild`, run `node node_modules/node-pty/scripts/post-install.js`: it puts node-pty's bundled ConPTY beside the from-source build, which loads ahead of the prebuilds (the install's own postinstall runs it for you).
- **macOS and Linux:** it rebuilds both against Electron, as CI and the release build do there, so you need Xcode's command line tools, or a C++ compiler, make and Python.

`npm run package` (and `package:win`, `package:store`) packages those binaries as they are installed (`--config.npmRebuild=false`, as `release.yml` does), then `npm run verify:package` checks them in `dist/`.

## Project Structure

```
src/
  main/           # Electron main process (PTY, IPC, config, vision, agents)
  renderer/       # React UI (components, pages, stores, utils)
    components/   # Reusable UI components
    pages/        # Full-page views (Tokenomics, Memory, Agents, etc.)
    stores/       # Zustand state stores
    utils/        # Shared utilities
  shared/         # Types and constants shared between main/renderer
  preload/        # Electron preload scripts (IPC bridge)
scripts/          # Build, release, and promotion scripts
tests/            # Unit tests (Vitest)
```

## Running Tests

```bash
npx vitest run         # Run all tests once
npx vitest --watch     # Watch mode
npx tsc --noEmit       # Type-check only
```

## Code Style

- **TypeScript** everywhere - no `any` unless unavoidable
- **Tailwind CSS v4** with `@theme` in `src/renderer/styles.css` (no tailwind.config)
- **Zustand** for state management - keep stores focused and minimal
- **No unnecessary abstractions** - prefer simple, direct code over premature generalization
- **Catppuccin Mocha** color palette - use theme tokens (`text`, `subtext0`, `surface0`, `blue`, etc.)

## Branching Model

- `beta` - default working branch; all feature development happens here, continuously. `beta` is **never frozen** for a release.
- `release/vX.Y.Z` - a release-candidate branch cut from `beta` for **every** release. All RC stabilization happens here, not on `beta`.
- `main` - stable releases only (updated by merging the accepted `release/vX.Y.Z` branch with a merge commit).

### For contributors

1. Fork the repo (or create a feature branch in-repo) from `beta`
2. Make your changes and ensure tests pass
3. Submit a PR targeting `beta`

That's the whole contributor surface — everything below this line is maintainer/release-manager process, documented for transparency.

### Release process (maintainers)

We cut a dedicated RC branch for every release cycle so that `beta` stays open for feature development at all times — features never wait for a release to finish stabilizing.

- When a release is ready to stabilize, cut a `release/vX.Y.Z` branch from `beta` and tag the `-rc.N` release candidates **there**.
- **`beta`:** feature branches and fix branches merge here continuously; it is never frozen.
- **`release/vX.Y.Z`:** bug fixes and stabilization only — **no features**. The RC branch is the proposed stable release; merging a feature into it invalidates the candidate.
- Fixes made on the RC branch are back-ported to `beta` so the next cycle keeps them.
- When the RC is accepted, merge `release/vX.Y.Z` → `main`, then delete the RC branch.
- **Every cut is gated** (`scripts/release-gate.mjs`, run by `release.js` and as the first job of `release.yml`): the GitHub milestone titled after the version must have no open issue without the `excluded`, `in-beta`, or `in-release` label, and the model registry must cover every model in Anthropic's Claude Code model configuration article. No bypass — see [`docs/versioning.md`](docs/versioning.md#release-gate-the-cut-is-refused-until-it-passes).
- **Before a cut, re-read the [Claude Code model configuration](https://support.claude.com/en/articles/11940350-claude-code-model-configuration) article** and refresh `resources/claude-code-model-configuration.json` if it moved. That article is the reference for the model/effort options the app offers (aliases, `--model` values, 1M variants, effort levels) — see [`docs/versioning.md`](docs/versioning.md#the-model-configuration-article-is-the-reference).

For the versioning scheme, prerelease suffixes (`-beta.N`/`-rc.N`), update channels, and when a rebuild ships to users vs. requires a version bump, see [`docs/versioning.md`](docs/versioning.md).

### Beta cadence (maintainers)

A beta is meant to ship within 24 hours of its scope being approved. These are the owner's rules (2026-11-13 and 2026-11-14, [ADR-028](architecture/decisions/2026-11-14-adr-028-fast-beta-cadence.md)); `AGENTS.md` ("Beta cadence") carries the same list for agents.

1. **Scope first.** The owner approves the scope of each beta before it is built. Each beta carries at least one architecture simplification and one process simplification.
2. **One review round per beta, on a frozen head.** On security-sensitive paths the adversarial pass is that round, and its lenses count as the two reviews a change needs. A change that touches no security-sensitive path gets one independent review on the frozen head, by a reviewer who did not write it, covering both what was agreed and whether it is correct and tested, with the same shape and no repeat loop. The round is one pass, one fix batch, one confirmation. A fix made after the confirmation gets a narrow check of that fix diff only, never a new full pass. **Frozen head:** no more commits to the reviewed files once the review starts. **Narrow check:** one independent attacker, on the fix diff only (off the security paths: one independent reviewer); it does not re-read the rest of the change.
3. **What gets fixed before the cut.** Majors, and anything the beta itself introduces. A minor finding in older code near the change gets a ticket in the private planning repo for the next beta.
4. **The beta release reuses green CI for the same tree.** `release.yml`'s `Reuse green CI (beta only)` job looks for a green `ci.yml` run in this repository (not from a fork) for a commit with the same git tree, in which the Windows, macOS and Linux Test jobs each end with a green `Tested tree <hash>` step for that tree. A pull-request run counts only for a PR into `beta` or `main`: it tests the merge into its base, so only a protected base vouches for the `ci.yml` that ran. If it finds one, the release does not run the suite again and links the run in its summary. On any doubt or API error the full suite runs. A stable release always runs the suite.
5. **The version bump rides in the last content PR of a beta** (the `package.json` version and the changelog entry). There is no separate version-bump PR.
6. **CI runs only what a change touches.** A push to a PR cancels the run on the commit it replaced. Adding or removing a label does not run the tests again (only adding `ci-run` does). A PR that changes only documentation (Markdown, `docs/`, `CONTEXT.d/`, `architecture/`) skips the suite on Windows and macOS, and the required checks still report green; Linux always runs the whole suite.
7. **No new release-evidence gate is added.**
8. **Security paths keep the adversarial pass, and the owner still merges every PR.**
9. **Desktop testing is at release level on beta and pre-release on stable, not per PR.** The owner desktop-tests the released beta build; that test is an input to the stable promotion. A PR into `beta` never needs a desktop-test label. See "Desktop-test gate" below.

For the release to reuse CI (rule 4), the last content PR must be rebased on `beta`, carry `ci-run`, be green, and be the last merge before the cut: the squash commit then has exactly the tree CI tested. Otherwise the release runs the suite itself, as before.

### Issue lifecycle (beta vs. main)

Because fixes merge to `beta` (in testing) long before they ship in a stable
`main` release, an issue has four states — don't close an issue the moment its
fix hits `beta`:

- **Open, no status label** — not yet fixed (todo / in progress).
- **Open, labeled `in-beta`** — the fix is merged to `beta` and in testing, but
  not yet shipped. Apply `in-beta` when the fixing PR merges to `beta`, and add a
  comment naming that PR.
- **Open, labeled `in-release`** — the fix is in a **cut release candidate**
  (`-rc.N`), one step past "on beta". When an rc is cut, the open `in-beta`
  issues on its milestone are relabeled `in-beta` → `in-release`
  **automatically** by the release workflow's `roll-rc` job
  (`scripts/roll-issues-into-release.mjs`); an issue carries one lifecycle
  label at a time, never both.
- **Closed (completed)** — the fix has promoted to `main` (shipped in a stable
  release). Only then close the issue.

Rationale: GitHub only auto-closes issues on merges to the **default** branch
(`main`), never on `beta` merges — so beta-merged issues won't self-close, and
closing them early hides "shipped" behind "merged, still baking." The generated
`CHANGELOG.md`/release notes show the same distinction per version.

At `main` promotion the close step is **automatic**: the `Close in-beta issues on
promotion` workflow (`.github/workflows/close-in-beta-on-promotion.yml`) runs on
every push to `main`, walks the promoted commit range, and for each referenced
issue that is open **and** labeled `in-beta` or `in-release` it comments, removes
the lifecycle label, and closes it as completed. Anything else it finds — pull
requests, unlabeled issues, already-closed issues, refs to other projects' issue
numbers — is skipped and listed in the run log. An rc cut promotes nothing to
`main`, so it closes nothing — it only advances labels to `in-release`.

Applying `in-beta` on the beta merge is therefore the one step that stays manual,
and it is what makes both automatic steps (the rc roll and the promotion close)
possible. An issue that never got the label will not be rolled or closed. To
repair labels after a cut that predates the roll job, or to preview one:

```bash
node scripts/roll-issues-into-release.mjs --version 2.1.0-rc.1 --dry-run
```

To preview what a promotion would close, or to catch up after a promotion that
predates this workflow, run it from the Actions tab (`workflow_dispatch`) with a
range such as `v2.0.0..main`; `dry_run` defaults to **true**. Locally:

```bash
node scripts/close-in-beta-issues.js --range origin/main..origin/beta --dry-run
```

### Release-line labels (`release-2.1` / `release-2.1.1` / `release-2.2`)

Orthogonal to the `in-beta` lifecycle above, these release labels say **which
release line, or which patch on a shipped line,** an issue belongs to:

- **`release-2.1`** — the 2.1 line label, for work shipping in 2.1.0. **Apply it** to
  any issue or PR on this line while 2.1.0 is unreleased; in particular, every
  `in-beta` issue then also carries `release-2.1`, so a "what ships in 2.1?" query
  stays accurate. After 2.1.0 ships, new work on the line takes the patch label
  below instead — never both (two release labels are two dispositions).
- **`release-2.2`** — **apply it** to work explicitly **deferred** past 2.1.
- **`release-2.1.1`** — a patch release on a line whose x.y.0 has already shipped
  gets its own label (owner decision, 2026-09-16): once 2.1.0 is live, `release-2.1`
  reads as "ships in 2.1", so 2.1.1 PRs and issues carry `release-2.1.1` instead.
  Same pattern for later patches (`release-2.1.2`, ...). The disposition job
  (`scripts/reconcile-issue-dispositions.js`) understands both shapes: it treats
  `release-2.1` and `release-2.1.1` as the same line, and derives the label it
  auto-adds from `beta`'s `package.json` -- an unshipped `x.y.0-…` gives
  `release-x.y`, a shipped `x.y.z` gives the next patch, `release-x.y.(z+1)`.

**Invariant: `in-beta`/`in-release` and `release-2.2` must never sit on the same
issue.** Either lifecycle label means the fix is already merged to `beta` (which
ships as the next 2.1 release) or in a cut 2.1 rc, so also calling it
`release-2.2` ("deferred") is self-contradictory. If a `release-2.2` issue later
gets a fix merged to `beta`, drop `release-2.2` and add `in-beta`. This invariant
is enforced by the reconcile job below.

### Issue disposition — nothing in limbo (#437)

Every **open** issue must carry exactly **one disposition**, so nothing falls
through the cracks:

- a release line — `release-<major.minor>` (scheduled to ship in that line), or once
  that line's x.y.0 has shipped, a patch release `release-<major.minor.patch>`, **or**
- `backlog` — real work, accepted, not yet scheduled, **or**
- `triage` — undecided; a human must decide (the default on a brand-new issue), **or**
- `wontfix` / `duplicate` / `excluded` — will not ship.

And once an issue reaches a **committed state** — `in-beta`, `in-release`,
`loop-claimed`, `loop-in-progress`, or `loop-done` — it must carry a
release label (`release-<major.minor>` or `release-<major.minor.patch>`): work
started or shipped means the target line is decided. `in-beta` and `in-release` specifically must carry the **active** line
(the invariant above); other committed states may target a future line.

Enforcement is durable, not by hand — `.github/workflows/issue-disposition.yml`
(schedule + `workflow_dispatch`, plus auto-`triage` on newly opened issues) runs
`scripts/reconcile-issue-dispositions.js`, which:

- adds `triage` to any open issue with no disposition (never leaves limbo);
- adds the active release label to an `in-beta`/`in-release` issue that has no
  release line, computed from `beta`'s `package.json`: an unshipped `x.y.0-…` gives
  `release-<x.y>`, a shipped `x.y.z` gives the next patch `release-<x.y.(z+1)>`;
- **flags for a human** — never guesses — a committed issue with no line, an
  `in-beta`/`in-release` issue on a deferred line, or any issue carrying more than
  one disposition.

It runs on a **schedule**, not an `on: labeled` listener: a label applied with the
Actions `GITHUB_TOKEN` does not fire `labeled`, so the scheduled full scan is the
reliable path. Preview locally:

```bash
node scripts/reconcile-issue-dispositions.js --dry-run
```

### Desktop-test gate (`desktop-tested` / `runtime-validated` / `skip-desktop-test`)

Headless CI (typecheck, unit tests, build) can pass while the packaged app fails
to run usefully on a real desktop — that has happened. So **the built app must
actually be exercised** before it reaches stable users. Where that happens was
set by the owner on 2026-11-14 (Beta cadence, rule 9; ADR-028): **at release
level on beta, and pre-release on stable — not per PR.**

- **A PR into `beta` (or a `release/*` line) needs no label.** Its
  `Desktop test gate` check reports success and says that desktop testing
  happens on the released beta. Do not add `desktop-tested`,
  `runtime-validated` or `skip-desktop-test` to a beta PR, and do not wait for
  one.
- **The beta is desktop-tested as a released build.** The owner installs the
  released beta and exercises it. That test is an input to the stable promotion.
- **A PR into `main` (the stable promotion, `release/vX.Y.Z` → `main`) must
  carry a label**, enforced by the `Desktop test gate` check. There are two ways
  to satisfy it — a human pass or an automated one — plus the skip for a
  promotion with no runtime surface.

- **`desktop-tested`** — a **human** launched and exercised the released
  beta/rc build on a real desktop. Apply it once you (or the tester) have actually
  driven the release in the running app, not just watched CI go green.
- **`runtime-validated`** — **automated** runtime validation passed: VM Playwright
  E2E and/or the live SSH statusline matrix. This is the automation route (so it
  no longer borrows `desktop-tested`), and it is strong enough to open the gate on
  its own — a separate human pass is then optional. See the Master Test Process
  (aicc_planning discussion #20) for what each automated pack covers.
- **`skip-desktop-test`** — this PR into `main` needs no runtime test: docs-,
  deps-, CI- or changelog-only changes with no runtime surface. Apply it instead
  of the two above for those.

On a PR into `main` the `Desktop test gate` check **fails until one of these
labels is present**, so it is the inverse of `ci-run` (which is opt-in — apply it
to *run* the matrix; this one must be present to *allow* the merge). Removing the
label turns the check red again.

The check reads the pull request as it is now (its base branch and its labels)
from GitHub, not from the event that started the run. So re-running an old run
gives today's answer: a run that began while the PR was into `beta`, or still
carried `desktop-tested`, goes red when it is run again after the PR was
retargeted to `main` or lost the label. If GitHub cannot be read the check fails
and says so; re-run it.

The check is decided again whenever what it reads changes: on a label change, and
when the PR's base branch changes. A PR that passed on a `beta` base and is then
retargeted to `main` goes red until it carries a label. Neither event starts the
test matrix again for a label or a title/description edit: the test results
already reported for the commit stand. To run the tests again without a push,
remove `ci-run` and add it back.

Maintainer note: the three branch rulesets require `Test (windows-2025)` and
`Test (macos-latest)` only (read 2026-11-14). `Desktop test gate` is not in
them, so on a PR into `main` a red gate is a red X the owner reads before
merging, not a hard block. Making it a required status check for `main` is an
admin-only ruleset change, and safe to make: the job runs on every PR event and
is never skipped.

## Commit Messages

This project follows [Conventional Commits](https://www.conventionalcommits.org/).
The format is enforced two ways, so a non-conforming message is caught before it lands:

- **Locally:** a Husky `commit-msg` hook runs commitlint on every `git commit`
  (installed automatically the first time you run `npm install`).
- **In CI:** because PRs are squash-merged, the **PR title** becomes the commit
  subject — the `PR Title` workflow lints it against the same rules.

Format:

```
<type>(<optional scope>): <imperative subject>
```

- **Allowed types:** `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`,
  `ci`, `chore`, `style`, `revert`, `deps` (`deps` is reserved for Dependabot).
- Use imperative mood ("add feature", not "added feature").
- Aim for a subject under 72 characters (hard cap 120).
- One type per subject — compound types like `docs+chore:` are **not** valid.
- Reference issues/PRs where applicable (`Fixes #123`).

Examples: `feat(sessions): add per-session rename`, `fix(terminal): restore caret under WebGL`.

Rules live in `commitlint.config.js`.

## Changelog & Release Notes

The changelog is **generated**, not hand-edited. The single source of truth is
`src/renderer/changelog.ts` (it also drives the in-app "What's New" modal).

- When your change is user-facing, add an entry to the top of the array in
  `src/renderer/changelog.ts` (type: `feature` | `fix` | `improvement`).
- Run `npm run changelog` to regenerate the root `CHANGELOG.md`, and commit both files.
- CI (`Changelog in sync`) fails if `CHANGELOG.md` is stale — run
  `npm run changelog:check` locally to verify.
- The release workflow reads the same source to populate the **GitHub release
  notes** automatically (`scripts/gen-changelog.js --notes <version>`), so there
  is nothing to paste by hand at release time.

### The other user-facing surfaces (no CI guard — check them by hand)

The changelog is the only one of these CI protects, so the rest drift quietly.
Before a release, walk every surface for each feature added or changed since the
last one, and either update it or satisfy yourself it needs nothing:

| Surface | File | Miss looks like |
| --- | --- | --- |
| What's New / CHANGELOG | `src/renderer/changelog.ts` | (CI catches this one) |
| Feature Guide reference + what Ask Conductor knows | `src/shared/app-knowledge.ts` | Asking the app about a live bug and being told the docs don't cover it |
| Tips | `src/renderer/tips-library.ts` | Tips for deleted features; nothing for anything shipped recently |
| Guided tour + Feature Guide cards | tour steps, guide cards | A whole page nothing mentions |
| README + screenshots | `README.md` | Describes features that were never built |

Ship anything with a known workaround? Add it to the **known-issues** section of
`app-knowledge.ts` in the same PR, so users hitting it can be told the fix rather
than concluding there isn't one.

## What We're Looking For

- Bug fixes with reproduction steps
- Performance improvements with before/after measurements
- New features that align with the project's scope (Claude Code orchestration)
- Test coverage for untested code paths
- Documentation improvements

## What to Avoid

- Large refactors without prior discussion
- Adding dependencies without justification
- Changes that break the update/release pipeline
- Platform-specific code without cross-platform fallbacks

## Questions?

Open a [Discussion](../../discussions) for questions about architecture, feature proposals, or anything else.
