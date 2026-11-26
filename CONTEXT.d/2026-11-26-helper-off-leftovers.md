## 2026-11-26 -- with both helper switches off, a start also removes the empty kept folder and the lock-only store (2.1.3-beta.19 section 6.5)

aicc_planning#440 (item 5), from beta.18's post-publish check.

- **The gap.** After a start with both local helper switches off, the helper's
  folder still held `kept` (empty) and `store` (only its 0-byte `.lock`). The
  clean-up beta.15 added (manager.ts removeOldCopiesWithHelperOff) removed
  version and staging folders only, and it began only when one of those was
  there, so the state beta.18 leaves was never cleaned.
- **The fix.** The clean-up now also begins when the folder holds an empty
  `kept` or a `store` holding only its lock (leftoversIn: folder reads only,
  so a start with no helper folder, or with nothing to remove, still runs no
  exec). After the version folders, and only when the listing named no holder
  and `stop()` still answers false: `kept` goes if it is empty and `store` if
  it holds only its lock (a plain file), each only while the other holds
  nothing else either and no running mark (`app-running.json`) is there, read
  again at that moment; then the helper's folder goes if it is then empty.
  Each is removed with a plain folder removal, so a folder that is no longer
  empty stays. A link, a record (store or kept, of any kind), a temporary file
  or any other entry keeps both. The one log line that named the version
  folders also names these.
- **Changed on purpose.** A start that removes only a staging or version
  folder now also removes the helper's folder when it is then empty (beta.15's
  case 6 left it empty). The manager makes the folder again at its start.
- **Tests.** tests/unit/main/session-helper-old-copies.test.ts cases 6 to 10.
  Mutants, each caught: the store's lock-only check dropped, kept's emptiness
  check dropped, the running mark ignored, and the listed holder ignored.
