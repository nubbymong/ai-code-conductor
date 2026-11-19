## 2026-11-19 -- One function holds the dev and E2E data-root rule

aicc_planning#335, 2.1.3-beta.10 section C4 (from the 2.1.3-beta.9 release
PR review).

**What.** The rule "`CCC_E2E_DATA_DIR` first, packaged or not; else
`CCC_DEV_DATA_DIR` when the app is not packaged; a full (absolute) path only"
was written three times: `devSessionDataDir` (`src/main/data-paths.ts`),
`instanceRecordPath` and `helperRootDir` (`src/main/session-helper/install.ts`).
It is now one leaf, `devDataRoot(env, isPackaged, platform?)` in
`src/main/dev-data-root.ts`. It gives the root when it is a full path,
`undefined` when there is none, and `null` when the root that applies is not a
full path. "Full" follows the rules of the platform named (`path.win32` for
win32, `path.posix` otherwise), or this computer's when none is. The leaf
imports only `path`, so `install.ts` stays loadable by helper tests that mock
little.

**Same results.** `devSessionDataDir` and `instanceRecordPath` give the same
answers as before; neither names a platform, so the full-path check is the
host's, as it was.

**What changes.** `helperRootDir` now takes the full-path check too. Before, a
relative `CCC_E2E_DATA_DIR` or `CCC_DEV_DATA_DIR` was joined as it was, so the
helper's folder went under the folder the run started in (the config-dot-cwd
failure class). Now such a root is ignored and the run uses the folder it would
use with no override: the installed app's folder when packaged, its `dev`
folder otherwise. A relative end-to-end root is not swapped for the dev root.
Red-first test: the new `helperRootDir` case in
`tests/unit/main/session-helper-install.test.ts`.

The review found the same class one step further on, in older code: on
Windows the no-override folder joined a relative `LOCALAPPDATA` as it was. A
relative dev root built from that same `LOCALAPPDATA` (`index.ts`) was then
ignored, and the fallback still put the helper under the working folder. A
`LOCALAPPDATA` that is not a full path is now ignored as well, for
`<home>\AppData\Local`. Red-first test: the `LOCALAPPDATA` case beside it.
`dataDirCandidates` (`data-paths.ts`) and `index.ts` read `LOCALAPPDATA` the
same way and are left alone here.

**Left alone.** `getDataDirectory` and `getResourcesDirectory` in
`data-paths.ts` read both variables by a rule of their own (no packaged check,
no full-path check); the ticket kept every other caller unchanged.
