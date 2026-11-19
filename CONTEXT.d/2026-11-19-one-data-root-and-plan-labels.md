## 2026-11-19 -- The app's data folder takes the dev and E2E root by the one rule; Codex 0.170.0's plan names

aicc_planning#345 and #348, 2.1.3-beta.11 section C4 (items 2 and 3).

**The data folder (#345).** `getDataDirectory` and `getResourcesDirectory`
(`src/main/data-paths.ts`) read `CCC_E2E_DATA_DIR` and `CCC_DEV_DATA_DIR` by a
rule of their own: no packaged check and no full-path check. They now take the
root from `devDataRoot` (`src/main/dev-data-root.ts`), as `devSessionDataDir`,
`instanceRecordPath` and `helperRootDir` already did, so the five cannot
disagree. Two things change. An installed app with `CCC_DEV_DATA_DIR` in its
environment ignores it. A root that is not a full path is ignored and logged,
and the registry folder or the default folder is used, instead of a data folder
under the folder the app started in; a relative end-to-end root is not swapped
for the dev root. A normal install, `ccc`, `npm run dev`, an end-to-end run and
the tests (all with full roots, or none) get the same folders as before: the
existing data-path tests pass as they were.

**How data-paths knows "packaged".** It cannot ask Electron's `app.isPackaged`:
the hooks worker loads it too, through the logger, and has no `app`. A setter
called from `index.ts` was not an option either: the section allows only the
`LOCALAPPDATA` line there, the setter would have to run before any module logs
its first line (the folder is fixed then), and the worker would still not have
it. It reads
packaged as "this code runs from inside the app's archive" (`runsFromAppArchive`:
an `app.asar` path segment in its own folder), which is how an installed build
runs it (package.json `build.asar`). `npm run dev`, `ccc`, an end-to-end run and
the tests run from plain folders. A build this reads wrongly reads as not
packaged, which is how the data folder behaved before.

**LOCALAPPDATA.** `dataDirCandidates` (`data-paths.ts`) and the dev root
`index.ts` builds when none is set joined `LOCALAPPDATA` as it was, so a
relative value put the folder under the working folder. Both now take it
through one check, `fullLocalAppData` (the leaf), and fall back to
`<home>\AppData\Local`, as `helperRootDir` did since beta.10 C4; `helperRootDir`
uses the same function now. A name-level test keeps the three files on it.

**Plan names (#348).** Codex 0.170.0's app-server `PlanType` adds `promax`,
`sci` and `sci_plus`, which had no label, so such an account showed no plan
pill. They read as that version's own display names give them: "Pro (Max)",
"Academic Researchers" and "Academic Researchers Plus" (read on GitHub from the
schema bundle and `KnownPlan::display_name` at tag rust-v0.170.0; no Codex was
run). The same version renames its own display names for `pro` ("Pro (More)")
and `prolite` ("Pro"); the app's labels for those two stay "Pro" and
"Pro Lite", which still order correctly beside "Pro (Max)". No 0.170.0 schema
fixture is recorded here (recording one needs the CLI); the test pins the
0.170.0 list against the recorded 0.157.1 schema.

**Red first.** Each behaviour change was seen red against the base code
(428baed0), and green after: the packaged run with `CCC_DEV_DATA_DIR`, the
relative dev and end-to-end roots, the relative `LOCALAPPDATA`, the two new
leaf functions, the name-level check on the three files, and the three plan
labels.
