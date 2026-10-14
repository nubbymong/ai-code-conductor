## 2026-10-11 -- script deploys, their launches, and the installer guard (2.1.1-beta.3)

- **Script deploys, what sits at the destination:** before a write,
  `script-deploy.ts` reads the destination without following a link. A link
  of any kind there (a symbolic link, and on Windows a junction) is removed as
  a link, never what it names; one Windows will not unlink is removed as a
  directory, which takes the link only, and when that fails too the unlink's
  own error is what is logged and thrown. A directory is removed only when it
  is empty, never what it holds, so one that is not empty fails that deploy.
  Only a plain file with one name and the shipped bytes is left as it is (on
  macOS and Linux, also only when group and others have no permission bit on
  it); anything else with the shipped bytes, a hard link included, is
  replaced by a new file.
- **Script deploys, Windows open handles:** every write is first a new file
  renamed over the destination. Windows refuses that rename while another
  process has the old copy open (a sync, backup or antivirus client). Then,
  when the old copy is a plain file with one name, its bytes are written in
  place through a handle checked to be that same file, so the shipped bytes
  still land; an in-place write that fails partway leaves bytes that differ,
  which the next start replaces. macOS and Linux keep the rename only.
- **Script deploys, the log:** every failure to put a changed copy in place is
  logged by the file's name and the error code through the app log
  (`logWarn`), and still throws to the caller.
- **Launches of deployed scripts:** a Claude Code session that opens the
  resume list (`pty-manager.ts` getResumePickerPath) runs the deployed picker
  only when it is a plain file with one name (`isPlainScriptFile`), and a
  Codex resume picker launch only when the picker, and the helper lib it
  loads where one is there, is one. A Codex launch gets the app's hooks only
  when the forwarder, and on Windows the wrapper that starts it, is one.
  Anything else there is logged by the file's name, and Claude Code or Codex
  starts directly, or without hooks, as when the script is not deployed.
- **Tests only:** the installer guard bans, in `ClassifyUninstallRecord`, any
  naming of the app's executable (`.exe` and the defines its name is built
  from) and every other way NSIS can probe a file there (GetFileTime,
  FileOpen, GetFileAttributes, FindFirst, GetSize, GetDLLVersion, SearchPath,
  Locate), with an in-memory mutation pinned for each. Those bans read the
  macro's own lines; the macros it inserts are outside them.
- **Owed on CI or the VM:** `script-deploy-links` (host quarantine): a real
  hard link with the shipped bytes, a real junction or directory link at the
  destination, and the earlier link cases.
