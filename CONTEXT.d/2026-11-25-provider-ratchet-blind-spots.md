## 2026-11-25 -- provider-name ratchet: lookups by name, launch styles, the renderer and shared code

aicc_planning#429 (2.1.3-beta.18 section 1, seam audit S4). The provider-name
ratchet (`tests/unit/architecture/provider-name-ratchet.test.ts`) counted two
shapes in `src/main` only. It now counts five, per file, in every TypeScript
file under `src/main`, `src/renderer`, `src/shared` and `src/preload`, leaving
out each provider's own package (`src/main/providers`, and
`src/renderer/providers/<id>` for each id in `PROVIDER_IDS`):

- comparisons with a provider name and ids defaulted to one (as before);
- registry lookups by a provider name: a call of a registry lookup
  (`getProvider`, `tryGetProvider`, `getProviderPackage`,
  `tryGetProviderPackage`, `getRendererProvider`, `tryGetRendererProvider`,
  read from the two registries' own source) with a name as its argument;
- launch-style tests: a comparison with one of `LocalLaunchStyle`'s words
  (read from `pty-manager.ts`), a style standing for a provider;
- in `src/main/remote-helper` only: a CLI's long flags, its variables (a name
  that starts with a provider id in capitals) and a path ending in its name.

Every name is read from the code (`PROVIDER_IDS`, the registries, the style
type), so a third provider is counted, and its renderer package left out, from
the day it is listed. The ceilings file is `provider-name-ceilings/2`: a file
lists the counts it holds.

Counts at d0be048e, by the new rule, and at this branch's head:

| Count | Scope | d0be048e | head |
|---|---|---|---|
| Comparisons | main / renderer / shared / preload | 73 / 188 / 10 / 0 (271) | the same |
| Ids defaulted to a name | main / renderer / shared / preload | 32 / 56 / 3 / 0 (91) | the same |
| Registry lookups by a name | main (renderer 0) | 25 | 21 |
| Launch-style tests | main: pty-manager.ts 4, launch-bindings.ts 2 | 6 | 6 |
| CLI flags, variables and paths | src/main/remote-helper: index.ts 9, session.ts 1 | 10 | 10 |

The audit named three launch-style tests (`pty-manager.ts:6025`,
`launch-bindings.ts:757`, `:951`); the count's rule (every comparison with a
style word) also takes `launchStyleOf`'s two (`pty-manager.ts:2348-2349`) and
the Claude Code branch's guard (`:6260`). S1 removes the style with all six.

One burn-down: the start's script deploys and its sweep of left-over pick
folders (`src/main/index.ts`) no longer look a provider up by name. Each is a
loop over the registered providers through `providerMembers` (provider core's
registry), where it was, each step with its own catch, in today's order
(Claude Code's statusline script and resume picker, then Codex's resume
picker and hook forwarder; the sweep, Codex's today). `index.ts:627`, Codex's
hook folders behind Codex's switch, stays and is counted.

`tests/wp1/dependency-boundaries.test.ts` builds its package pattern, its
concrete-target pattern and its name set from `PROVIDER_IDS`, and R2, R3 and
R7 go over every id. Measured with a stand-in third id added to the list (not
committed): R7 names its missing main and renderer packages; the old file
passed it unseen.
