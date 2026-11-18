## 2026-11-17 -- The session helper's holder waits on its child instead of checking every 25 ms (2.1.3-beta.8 section B1)

**Why.** Each held terminal's holder had a thread that asked for its child's
status every 25 ms, under the terminal's lock, for the child's whole life:
about 40 wake-ups a second per held terminal while nothing happened.

**What changed.**
- The holder's exit thread now makes one wait that blocks until the child
  has exited (`ExitWatch::wait`, `helper/src/pty/`), without the terminal's
  lock. Then, under the lock and in one critical section, it reads the code
  (`try_wait`), ends the rest of the tree and closes the terminal. The
  bounded output drain (2 s, 10 ms checks), the exit code and the closing of
  the live channel follow as before. A wait that fails is reported as an
  exit (code -1) at once, as a failed status check was before.
- Windows: the watch waits on a handle of its own, duplicated from the
  child's when the holder starts, with only `SYNCHRONIZE` (the right to
  wait), not inheritable, closed with the watch. The watch never reads the
  exit code: `try_wait` reads it through the terminal's own handle. The job
  object, the pseudoconsole and `end_tree` are unchanged.
- macOS and Linux: the watch never reaps. It blocks in `waitid` with
  `WEXITED | WNOWAIT` (retrying on EINTR), which sees the exit but leaves the
  child unreaped, still holding its id. The terminal reaps it in `try_wait`,
  which `end_tree` also uses, so in the holder the reap and every decision to
  signal the session happen under the one lock. std's `Child` is no longer
  kept, since its own waits would be a second reaper. The rule that a session
  whose program was reaped and whose session is empty is never signalled
  again (helper-protocol.md section 15, "The whole tree") holds as before.
- macOS and Linux: that rule needs SIGCHLD at its default, so that
  `try_wait` alone reaps the child. A starter may leave SIGCHLD ignored,
  which is handed down through exec, so each start of a terminal sets it
  back to its default first (`Pty::spawn_with`).
- Changed from the plan's text, after review:
  - The plan had the macOS and Linux watch reap with `waitpid(pid, 0)` and
    record the status. Copilot's review of PR #710 found the race in that:
    the reap frees the id before the status is recorded, and an end running
    at that moment on another thread (holding the lock) still reads "not
    reaped" and can signal an id another process may already have. The 25 ms
    loop never had that gap, because it reaped under the lock. A wait that
    does not reap closes it.
  - The plan had the Windows handle duplicated with `SYNCHRONIZE` and
    `PROCESS_QUERY_LIMITED_INFORMATION`, to read the code through it. The
    code is read through the terminal's handle under its lock instead, so
    the query right was never used and was dropped: the watch holds the
    least it needs.
- Not changed: the protocol, the record, exit codes, the away clock,
  `serve.rs`'s 250 ms clock (which still writes the record's `code`), the
  self-test, and no crate was added.

**Tests.** The terminal counts, in test builds only, each time the child's
status is asked of the system (each wait call in `ExitWatch::wait`, each
check in `try_wait`): `the_holder_waits_for_its_childs_exit_instead_of_asking_on_a_clock`
expects 1 or 2 while a child runs about 2 s (now: the wait, then one read
of the code). Against the 25 ms loop it failed in CI (PR #710, first commit)
with 82 checks on Windows, 35 on macOS and 81 on Linux.
`helper/tests/holder_wait.rs` times `term.exit` (250 ms) and the record (1 s:
it is written on serve's 250 ms clock and synced to disk, and one macOS run
took 400 ms) for exit 0, exit 7, an outside kill and a program that
writes as it exits (that output must reach the app before `term.exit`), and
on macOS and Linux for a holder started with SIGCHLD ignored. It prints the
times it measured. Unit tests: a failed wait is reported as exit code -1 and
the live channel closes, without waiting for the child; the terminal is not
locked while the holder waits; on Unix the exit watch never reaps, and a
watch made after the reap answers at once; on Windows the watch's handle
holds exactly `SYNCHRONIZE` and can neither read the code nor end the child.
Also: `hold.rs`'s 64-byte ring test waited out its 20 s limit on every
Windows run (before this change too); it now waits for any output instead
of a banner that a ring that small cannot be relied on to hold.

**Owed.** The release smoke may take the perf harness's idle reading
(`scripts/perf`) for 25 held terminals before and after. The changelog's
performance line goes in with the release PR.
