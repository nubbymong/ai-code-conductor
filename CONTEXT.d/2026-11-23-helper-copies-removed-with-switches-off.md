## 2026-11-23 -- with both helper switches off, a start removes the old helper copies (2.1.3-beta.15 B1)

aicc_planning#397 (beta.15 scope item 6) and #388's hand-built item.

- **The gap.** The manager removes old helper version folders after its
  listing (bringUp), and the manager is made only with a switch on, a running
  mark or an agent record (app-wiring.ts initSessionHelper). A user who turned
  a switch on and later both off kept every old copy: each release's helper is
  0.1.0 with a new hash, so each update added a folder nothing removed. The
  beta.14 post-publish check saw one on the test VM.
- **The clean-up.** That start now runs manager.ts
  removeOldCopiesWithHelperOff instead of returning: only when the helper's
  folder holds a version or staging folder (one folder read, so a user who
  never used the helper starts nothing), the installed helper itself runs
  `list` once (no copy, no holder), and every version folder no listed
  holder's version needs goes, with the staging folders, through
  removeOldVersionFolders with no current folder (`current` may now be null).
  This build's own copy goes too. A failed listing, a listing that does not
  read, or no installed helper removes nothing, and the log says why; one log
  line names what went.
- **No overlap with a switch turned on.** The clean-up's promise is kept in
  app-wiring.ts; a manager made later in the run gets it as `copyAfter`, and
  its install waits for it before it copies. The clean-up removes nothing once
  a manager exists (its `stop`). Either alone keeps the copy; the tests break
  each one alone.
- **An unreadable settings file removes nothing.** routing() reads it as both
  off, so the clean-up reads the file again with readConfigChecked (never
  moving it aside): only `ok` or `absent` with both off lets it remove.
- **#388's hand-built item.** HelperPty.screenRead now needs the connection's
  `title` as well as `screen`, in the getter and in each call: a holder that
  offers `screen` but not `title` gives no read, so the composer rule reads
  main's own pane, title included (the title's spinner is its only busy sign
  while a reply streams).
- **Recorded, no change.** With a switch on, a start that lists a holder keeps
  every folder of that holder's version (#322's keep rule is by version); the
  next start with none removes them.
