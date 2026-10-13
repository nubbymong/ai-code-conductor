## 2026-10-11 -- small fixes and two VM regressions (2.1.1-beta.3)

- **Quit hold, wording only:** the first-start warm-up holds its
  callers once the before-quit teardown has run. The comments and ADR-025
  now say what that covers: only a start that awaits the warm-up first
  (several callers ask for one only for a direct `claude.exe` on Windows),
  and only the before-quit teardown sets it (the exit that installs an
  update and SIGTERM do not). No behaviour change. ADR-025 no
  longer lists the setup terminal with those callers; it asks for a warm-up
  on Windows for any program, so it is held there.
- **Deployed script mode:** `script-deploy.ts` puts mode 0600 back on
  macOS and Linux on every start, on an unchanged copy and after a rewrite,
  as `copyFileSync` used to. Windows unchanged.
- **Installer guard:** `brand-identity-guard.test.ts` finds an
  exe-existence test on the install folder in every spelling of the exe's
  name, with the path in any NSIS quote mark or none, and allows only the
  splash probe in `CccBrandGuiInit`.
- **Sentinel reason:** a test pins redact-before-cut in
  `envelopeError`.
- **Setup terminal fragment:** corrected where the stop runs (just
  before `killAllPty`) and which exits skip it.
- **Picker siblings:** a worktree whose path differs from a gated one
  only in case is skipped only when the disk resolves both to the same real
  path; on a case-sensitive folder it is gated on its own. The picker side
  matches a worktree by real path (2026-10-11-beta3-picker-real-paths.md).
- **Stream logs:** `log-line-redact.ts` redacts a stream's reads on
  whole lines (an unfinished line is held, bounded at 8 KiB, and joined to
  the next read), for a cloud agent's error output and the Insights
  terminal's chunk log.
- **VM regressions:** `ssh-partner-folder.ts` no longer imports the Claude
  package (dependency-boundaries R2, R4); its folder check is written out
  and a test holds it to the session's own. `pr600-r3-fresh-wait` fakes the
  Claude Code version probe, so it never runs an installed CLI.
- **Known issue text:** signing an account in again stops with the same
  folder message as adding it.
- **Owed on CI or the VM:** the POSIX mode cases in the statusline and
  resume picker deploy tests (Linux, macOS), and `pr600-r3-fresh-wait`
  (host quarantine).
