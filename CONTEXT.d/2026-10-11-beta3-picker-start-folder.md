## 2026-10-11 -- the picker's start folder and worktrees with no folder (2.1.1-beta.3)

- **Picker start folder:** for a managed launch, the
  resume picker starts the CLI, and its fresh-session fallback, in the
  folder its gated-set check matched, and does not read the worktree's
  spelling again to start it. Below the drive (or share), that folder is
  named by the real path's own folders, so no link anywhere in the
  worktree's path is passed through again, including a junction that
  Node's JS resolver does not follow (one whose target is not a
  drive-letter path). The drive is the one the worktree's path reaches the
  folder through once `fs.realpathSync` (the JS one, as Claude Code names
  a project folder) has followed its links, so a subst or mapped drive
  keeps the conversation's project folder; it is taken only when the
  drive's own real path holds the matched real path, and otherwise the
  folder is the real path itself. A name typed in another case starts in
  the case on disk (the same project folder on a case-insensitive disk);
  an 8.3 short name starts at its long name, whose project folder is
  another one, so such a conversation starts afresh. On Windows a real
  path with a name ending in a dot or a space is not used: such a folder
  is matched by its spelling alone, and starts where it is spelled.
  `isGatedDir` returns the folder to start in, or null. The conversation's
  companion folder is named from that folder too.
- **Picker siblings with no folder:** a worktree git still lists after its
  folder was deleted (a prunable record) is left out of the picker's set
  when the session starts, and logged with the kept-out line ("there was no
  folder there when the session started"). The folder is asked for only
  after the gate finds the sibling clean, and an answer that does not come
  within the gate's own deadline counts as no folder.
- **The launch's own folders:** `gatePickerSiblingDirs` also returns
  `launch`, the launch's own folders to hand the picker: the configured
  folder always, the resume target's folder only when a folder is there by
  the same rule (asked after the launch's own gate has answered). A managed
  launch's gated set (`projectGateDirs`, handed to the picker as
  `CCC_GATED_DIRS`) is `launch` plus the clean siblings, once each; a
  refused verdict keeps the launch's own folders, as before. A resume
  target with no folder when the session starts is therefore outside the
  set: the picker refuses it, and a launch that would resume in a folder
  made there later is refused by the in-process directory check
  (`assertGatedDirectory`). `pty-managed-resume-target-gated-set` drives
  this through the real `spawnPty` and gate.
- **Text:** 2026-10-11-beta3-script-deploys-quit-hold.md says the copies
  are replaced at every start on macOS and Linux only. A picker-sibling test comment carries the
  same-folder qualifier, and the not-on-disk case passes a parent part as
  written.
- **Owed on CI or the VM:** the real-link cases in
  `resume-picker-gated-links` and `managed-launch-picker-siblings-links`
  (host quarantine): a launch folder reached through a link, the
  conversation's project folder through a link, and a sibling or resume
  target at a link to a folder; and
  `pty-managed-deferral-carries-launch` (host quarantine), whose managed
  picker launches build the gated set this way.
