## 2026-11-19 -- The app's data folder takes the dev and E2E root by the one rule; Codex 0.170.0's plan names

aicc_planning#345 and #348, 2.1.3-beta.11 section C4 (items 2 and 3).

**The data folder (#345).** `getDataDirectory` and `getResourcesDirectory`
(`src/main/data-paths.ts`) read `CCC_E2E_DATA_DIR` and `CCC_DEV_DATA_DIR` by a
rule of their own: no packaged check and no full-path check. They now take the
root from `devDataRoot` (`src/main/dev-data-root.ts`), as `devSessionDataDir`,
`instanceRecordPath` and `helperRootDir` already did, so the five apply the
same rule. Two things change. An installed app with `CCC_DEV_DATA_DIR` in its
environment ignores it. A root that is not a full path is ignored and logged,
instead of a data folder under the folder the app started in; a relative
end-to-end root is not swapped for the dev root. A run that is not installed
then uses a `dev` folder inside the installed app's data folder (the registry
folder or the default one), with its resources inside it, as `helperRootDir`
does, so it still keeps off that app's CONFIG and sessions; an installed app
uses its own folders. A normal install, `ccc`, `npm run dev`, an end-to-end run
and the tests (all with full roots, or none) get the same folders as before:
the existing data-path tests pass as they were.

**How data-paths knows "packaged".** It cannot ask Electron's `app.isPackaged`:
the hooks worker loads it too, through the logger, and has no `app`. A setter
called from `index.ts` was not an option either: the section allows only the
`LOCALAPPDATA` line there, the setter would have to run before any module logs
its first line (the folder is fixed then), and the worker would still not have
it. It reads
packaged as "this code runs from inside the app's archive" (`runsFromAppArchive`:
an `app.asar` path segment in its own folder), which is how an installed build
runs it (package.json `build.asar`). `npm run dev`, `ccc`, an end-to-end run and
the tests run from plain folders. It differs from `app.isPackaged` in two
cases: a packaged build without an archive reads as not packaged (how the data
folder behaved before), and an unpackaged Electron started on an `app.asar`
reads as packaged.

**LOCALAPPDATA.** `dataDirCandidates` (`data-paths.ts`) and the dev root
`index.ts` builds when none is set joined `LOCALAPPDATA` as it was, so a
relative value put the folder under the working folder. Both now take it
through one check, `fullLocalAppData` (the leaf), and fall back to
`<home>\AppData\Local`, as `helperRootDir` did since beta.10 C4; `helperRootDir`
uses the same function now. So does `getBrowserPaths` (`browser-paths.ts`), the
list of Chrome and Edge programs the sign-in and vision browsers start from: a
`LOCALAPPDATA` that is not a full path gives no per-user entry there, as an
unset one always did. A name-level test keeps the four files on it.

**Plan names (#348).** Codex 0.170.0's app-server `PlanType` adds `promax`,
`sci` and `sci_plus`, which had no label, so such an account showed no plan
pill. They read as that version's own display names give them: "Pro (Max)",
"Academic Researchers" and "Academic Researchers Plus" (read on GitHub from the
schema bundle and `KnownPlan::display_name` at tag rust-v0.170.0; no Codex was
run). The same version renames its own display names for `pro` ("Pro (More)")
and `prolite` ("Pro"); the app's labels for those two stay "Pro" and
"Pro Lite", which still read as the tiers below "Pro (Max)". No 0.170.0 schema
fixture is recorded here (recording one needs the CLI); the test pins the
0.170.0 list against the recorded 0.157.1 schema. When #347 records that
fixture, '0.170.0' joins the schema cases and the hand list goes.

**Red first.** Each behaviour change was seen red against the base code
(428baed0; local run c4b-red over data-paths-dev-root-rule, dev-data-root
and rate-limits test files), and green after (local run c4b-green): the
packaged run with `CCC_DEV_DATA_DIR`, the relative dev and end-to-end roots, the relative `LOCALAPPDATA`, the two new
leaf functions, the name-level check on the three files, and the three plan
labels. The review's fixes were seen red against the code of 6b2217d8 (local
run c4b-red2 over data-paths-dev-root-rule, dev-data-root and
account-web-detect-browsers): the `dev` folder for the two relative roots and
for a run with nothing saved, the name-level check on `browser-paths.ts`, and
no per-user browser for a relative `LOCALAPPDATA`. The check that data-paths
reads "packaged" from its own folder was seen red with `process.cwd()` planted
in its place (local run c4b-mutant). All green after (local run c4b-green2).
