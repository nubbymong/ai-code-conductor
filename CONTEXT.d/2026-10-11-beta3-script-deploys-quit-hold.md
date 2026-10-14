## 2026-10-11 -- script deploys at start, the quit hold and picker siblings (2.1.1-beta.3)

- **Script deploys at start:** replacing a
  loosened deployed script is best effort: a refusal leaves the shipped copy
  as it is and logs one warning a run, and on macOS and Linux, on a folder
  that cannot keep the mode (a share mounted without permission support, a
  FAT drive), the copies are replaced at every start (Windows never replaces
  a plain file for its mode). Each startup step in `index.ts` has its own
  catch, and the Codex provider tries its picker and hook deploys whatever
  the other did.
- **Script deploys, the heal itself:** every write by `script-deploy.ts` is
  first a new file made 0600 and renamed over the destination
  (`atomicWriteFileSync`, as `writePlainCopies` does), so the copy in use is
  never written through a link, and on macOS and Linux never through a handle
  on the old copy. Windows refuses that rename while another process holds
  the old copy open, and then writes a plain file with one name in place.
  On macOS and Linux a copy with the shipped bytes is replaced the
  same way when group or others have any permission bit on it, or when it is
  not a plain file with one name; on Windows such a copy is replaced only
  when it is not a plain file with one name.
- **Quit hold:** `quit-hold.ts` is set with the first-start warm-up's latch
  (`flushFirstStartWarmups`, before-quit teardown only). The setup terminal,
  headless runs, cloud agents and both routes of `claude auth status` read
  it in the same step as their own start, on every platform and for every
  program, so none starts after the teardown (macOS, Linux and an npm
  `claude.cmd` included). The status read inside a Claude sign-out is
  part of the sign-out, and is not held. ADR-025 item 7 says exactly which
  starts are held. The update-install exit and SIGTERM still skip the
  teardown.
- **Picker siblings:** on Windows a clean worktree whose name differs only
  in case from one left out is not handed to the resume picker either. The
  resume picker matches a worktree against the folders it is handed by real
  path, so a worktree whose name differs only in case from a launch
  folder is refused there too, unless the disk resolves both to one folder.
- **Tests only:** the installer guard pins `ClassifyUninstallRecord` with an
  allow-list (its one existence test is on the recorded uninstaller) and
  counts an app exe test in any spelling and folder; the owner-only fallback
  test gains a deny-entry case; the owner-only wiring pin reads only code.
- **Owed on CI or the VM:** `script-deploy-links` (host quarantine: the
  link cases, and on Linux and macOS an open handle and a symbolic link),
  the POSIX mode cases of the statusline and picker deploy tests, and the
  non-elevated run of the owner-only folder rule.
