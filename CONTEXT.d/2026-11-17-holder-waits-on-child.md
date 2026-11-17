## 2026-11-17 -- The session helper's holder waits on its child instead of checking every 25 ms (2.1.3-beta.8 section B1)

**Why.** Each held terminal's holder had a thread that asked for its child's
status every 25 ms, under the terminal's lock, for the child's whole life:
about 40 wake-ups a second per held terminal while nothing happened.

**What changed.**
- The holder's exit thread now makes one wait that blocks until the child
  exits (`ExitWatch::wait`, `helper/src/pty/`), without the terminal's lock.
  What follows the exit is unchanged: end the rest of the tree, close the
  terminal, the bounded output drain (2 s, 10 ms checks), the exit code, then
  the live channel closes.
- Windows: the watch waits on a handle of its own, duplicated from the
  child's when the holder starts, with only `SYNCHRONIZE` and
  `PROCESS_QUERY_LIMITED_INFORMATION`, not inheritable, closed with the
  watch. A wait that fails is reported as an exit (code -1), as a failed
  status check was before. The job object, the pseudoconsole and `end_tree`
  are unchanged.
- macOS and Linux: the watch is the only reaper. It blocks in
  `waitpid(pid, 0)`, retrying on EINTR, and records the code where the
  terminal's `try_wait` and `end_tree` read it; std's `Child` is no longer
  kept, since its own waits would be a second reaper. The rule that a session
  whose program was reaped and whose session is empty is never signalled
  again (helper-protocol.md section 15, "The whole tree") holds as before. A
  watch dropped before it waited (the exit thread could not be made) hands
  the reaping back to the terminal, and is dropped before the terminal on a
  failed start so the terminal's drop can still end and reap the child.
- Not changed: the protocol, the record, exit codes, the away clock,
  `serve.rs`'s 250 ms clock (which still writes the record's `code`), the
  self-test, and no crate was added.

**Tests.** A test-only counter of the holder's child-status checks:
`the_holder_waits_for_its_childs_exit_instead_of_asking_on_a_clock` expects
at most 2 while a child runs about 2 s. Against the 25 ms loop it failed in
CI (PR #710, first commit) with 82 checks on Windows, 35 on macOS and 81 on
Linux. `helper/tests/holder_wait.rs` times `term.exit` (250 ms) and the
record (one more tick, 500 ms) for exit 0, exit 7 and an outside kill. New
unit tests: on Unix, a child killed from outside is reaped only by its watch
and an end after that sends nothing; a watch dropped unused hands the reaping
back. On Windows, the watch's handle cannot end the child.

**Owed.** The release smoke may take the perf harness's idle reading
(`scripts/perf`) for 25 held terminals before and after. The changelog's
performance line goes in with the release PR.
