## 2026-11-19 -- Release: the Windows job fetches the NSIS compiler before its own test run

The 2.1.3-beta.9 cut (release run 44624973440, aicc_planning #361 for the cause of the test run).

- What happened. The reuse lookup found no green ci.yml run for the release
  tree, so build-windows ran the suite itself (about 32 minutes). One test
  failed: the makensis tripwire in tests/unit/main/installer-nsis-behaviour.test.ts,
  which fails a Windows CI run with no MAKENSIS. ci.yml's Windows parts fetch
  electron-builder's NSIS compiler first (scripts/ci/fetch-makensis.mjs);
  release.yml's build-windows did not. A beta release that reuses green CI never
  runs that step, and a stable release always runs it, so the gap would have
  failed every stable cut too.
- Fix. build-windows runs `node scripts/ci/fetch-makensis.mjs` after the install
  and before the suite, with no condition: when the suite is skipped, it only
  warms the cache that the installer step reads.
- Test. tests/unit/scripts/ci-cadence.test.ts pins the step: present in ci.yml's
  Windows parts and in build-windows, after the install and before the suite,
  unconditional, and absent from the Linux and macOS jobs. Red on the old
  release.yml, green with the fix.
- Why the lookup missed (not fixed here): it reads the 30 newest commits with
  green runs, and the release PR's run, from about 06:40Z, was older than that on
  a day of many PR runs. aicc_planning #361 proposes a direct lookup through the
  release commit's PR.
