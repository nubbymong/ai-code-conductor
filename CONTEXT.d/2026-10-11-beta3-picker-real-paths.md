## 2026-10-11 -- picker real paths, their text, and script deploys (2.1.1-beta.3)

- **Picker real paths:** the resume picker matches a
  worktree against the folders a managed launch checked (CCC_GATED_DIRS) by
  real path (`fs.realpathSync.native`). Two folders whose names differ only
  in case stay two. One folder in any spelling that leads to it is one:
  drive letter, separators, the name's case on a case-insensitive volume, a
  link or junction. When a real path cannot be read, only the same spelling
  matches (resolved, with the separators, a trailing separator and the drive
  letter's case settled; off Windows a spelling with a parent part is kept
  as written), never a folder name in another case. On Windows a path with a
  name ending in a dot or a space, as written or once resolved, is matched by
  its spelling alone. The launch gate looks for such a name in the resolved
  path only, so the picker is the stricter of the two there.
- **Picker text:** every folder a managed launch leaves out of the picker's
  set is logged with the one line "the resume picker will not open
  conversations in <folder> for this launch: <why>", also when its name
  differs only in case from a folder the picker is given. The comments in
  `managed-launch-diagnostics.ts` (gatePickerSiblingDirs), `pty-manager.ts`
  (pickerCandidateDirs) and `resume-picker.js` (isGatedDir) say exactly when
  the picker takes a folder for one in its set: one real path, or one
  settled spelling where it does not take the disk's answer. So a folder
  left out is refused unless it is a folder of the set under another
  spelling or through a link. The picker-sibling tests describe current
  behaviour only.
- **Script deploys on Windows:** a deployed script that is not a plain file
  with one name (a symbolic link, or a hard link) is replaced by a plain copy
  even when it holds the shipped bytes, as on macOS and Linux. A plain file
  with one name and the shipped bytes is left alone. The warning
  for a copy that could not be replaced names no owner-only mode.
- **Tests only:** the held runner route of `claude auth status` also checks
  that the account hold is let go; the picker's not-on-disk case uses names
  inside a fresh folder of its own.
- **Owed on CI or the VM:** the real symbolic-link case in
  `script-deploy-links` (host quarantine), with its red run on Windows.
