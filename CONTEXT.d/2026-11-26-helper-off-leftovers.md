## 2026-11-26 -- with both helper switches off, a start also removes the empty kept folder and the lock-only store (2.1.3-beta.19 section 6.5)

aicc_planning#440 (item 5), from beta.18's post-publish check.

- **The gap.** After a start with both local helper switches off, the helper's
  folder still held `kept` (empty) and `store` (only its 0-byte `.lock`). The
  clean-up beta.15 added (manager.ts removeOldCopiesWithHelperOff) removed
  version and staging folders only, and it began only when one of those was
  there, so the state beta.18 leaves was never cleaned.
- **The fix.** The clean-up now also begins when the folder holds an empty
  `kept` or a `store` holding nothing, or only its lock (leftoversIn: folder
  reads only, so a start with no helper folder, or with nothing to remove,
  still runs no exec). After the version folders, and only when the listing
  named no holder and `stop()` still answers false (asked a third time, just
  before these): `kept` goes if it is empty and `store` if it holds nothing,
  or only its lock (a plain file), each only while the other holds nothing
  else either and no running mark (`app-running.json`) is there, read again
  at that moment; then the helper's folder goes if it is then empty. Each is
  removed with a plain folder removal, so a folder that is no longer empty
  stays; the store's lock goes, when it is there, just before its folder. A
  link, a record (store or kept, of any kind), a temporary file or any other
  entry keeps both. The one log line that named the version folders also
  names these (`kept (empty)`, `store (no record)`).
- **Why a store with nothing in it counts.** On Windows a holder runs with the
  store as its working folder, so a holder still ending makes the store's
  removal fail after its lock has gone. Taking only a lock-only store would
  leave that empty store (and the helper's folder) until the helper is next
  switched on; the next start takes it instead.
- **Changed on purpose.** A start that removes only a staging or version
  folder now also removes the helper's folder when it is then empty (beta.15's
  case 6 left it empty). The manager makes the folder again at its start.
- **Tests.** tests/unit/main/session-helper-old-copies.test.ts, 18 tests in the
  file; cases 6 to 10 (13 of them) are this change's. Mutants, each caught:
  the store's check dropped (a store with a record goes), kept's emptiness
  check dropped, the running mark ignored, the listed holder ignored, the
  third `stop()` check dropped, a store with nothing in it not taken, and the
  lock's removal made unconditional again.
  Case 10 plants a junction in the test's own temp folder, so the file
  carries the host quarantine header (added at the aggregate, where the
  meta test first ran on it): CI and the test VM only.
