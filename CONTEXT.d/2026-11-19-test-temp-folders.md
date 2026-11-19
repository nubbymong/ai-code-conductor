## 2026-11-19 -- A test run leaves nothing in the system temp folder, and a test that moves it fails

Plan 2.1.3-beta.10, section C1 (aicc_planning #332; #232 as a rider).

- **Measured first, in CI.** The global teardown (tests/global-setup.ts) now prints one line in
  CI, or with CCC_TEMP_REPORT set: the names at the top of the machine temp folder that were not
  there when the run started, other than the run's own `ccc-vitest-<tag>-*` folders and owner
  record, and vitest's own folder for module copies (its project.tmpDir, which vitest removes as
  it closes, right after the teardown), with how many names were there at the start and how
  many now, so an unreadable folder cannot pass for a clean run. Decision line, written in the
  measurement commit before any log was read: an entry whose name starts with a prefix a test
  of ours passes to mkdtemp is a leak to fix here; none means the unit run already leaves nothing and #560 fixed the ticket's
  unit part. Run 44463829599 (Ubuntu, macOS, the four Windows parts): no such entry anywhere, so
  the 19,204 folders the ticket counted predate #560 or came from runs outside the test config.
  Each run listed vitest's module-copy folder (a 21-character random name), since left out of the
  line. macOS listed 28 folders of Apple's own services (com.apple.*, betaenrollmentagent).
  Ubuntu listed `tmux-1001`, which is ours: ssh-liveness-r8 runs the production tmux probe, which
  tries /usr/bin/tmux, and tmux keeps its socket folder in TMUX_TMPDIR, else /tmp, never TMPDIR.
  tests/helpers/test-tmp.ts now points TMUX_TMPDIR at the worker's root too.
- **The per-test check.** tests/helpers/home-isolation.ts puts TEMP, TMP and TMPDIR back on the
  worker's temp folder before each test, as it does the home variables (a value inside that
  folder is kept), and fails a test that leaves one unset or pointing outside it, naming the
  variable and where it pointed; the next test starts with it put back. No existing test had
  to change: the two that move TEMP put it back themselves.
- **The meta test** (tests/unit/meta/test-temp-folders.test.ts): every vitest config at the repo
  root loads home-isolation.ts first, or is the live config, where every folder a tests/live
  file makes with mkdtemp is removed in the same file and os.tmpdir() is named only inside a
  mkdtemp call; and no file under tests/ hands mkdtemp or mkdir a hard-coded temp root. The
  tree needed no exception. Its header lists what it does not check.
- **Gaps found by reading.** When the inherited marker named a folder that was gone,
  test-tmp.ts made a new root but neither pointed the temp variables at it nor removed it at
  exit; it now sets the new root up as a first importer does, beside the gone one when the temp
  variables still name it. The live harness and the
  two-session repro removed their data folder but never their scratch folder (config, resources
  and app folder); both go now. Of the three release scripts, verify-release-manifest.js already
  removed its folder; verify-release.mjs now removes its dump folder after a clean pass (kept on
  a failure or a warning), and file-advisory.mjs removes its payload folder once the report is
  filed (kept when the request fails). The two-session repro now writes its evidence file and
  raw panes only with CCC_REPRO_EVIDENCE set; before, every run left them at the top of the
  machine temp folder.
- **#232.** The default cache folder under the shared node_modules held
  `vitest/<sha1 of an empty name>/results.json`, which every run reads back to order its files,
  so worktrees sharing one junctioned node_modules ordered each other's runs. vitest.config.ts
  sets `cacheDir: '.vite-cache'` (already in .gitignore). The native and live configs keep the
  default: they run a few files each.
- **Owed.** The live pack's harness changed, so one combo of it runs once at the release PR,
  and the scratch folder is confirmed gone after it.
