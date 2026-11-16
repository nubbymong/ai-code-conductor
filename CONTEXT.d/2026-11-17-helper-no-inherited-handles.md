## 2026-11-17 -- A held terminal keeps none of the app's open handles (2.1.3-beta.7, section A1)

**Why.** The app starts each holder through `aicc-helper hold --detach`, run
by Node's `execFile`, which lets the child inherit every handle the app has
marked inheritable. The starter then started the holder with Rust's std
`Command`, which also starts a child with inheritance on, so the holder got
the same handles. The holder outlives the app, so those handles stayed open
for as long as a held terminal ran. On macOS and Linux the same was true of
every descriptor not marked close-on-exec. (planning #316)

**What changed.**
- Windows: `spawn_detached` (`helper/src/detach.rs`) calls `CreateProcessW`
  itself with `STARTUPINFOEX` and `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`. The
  list names only the write end of the holder's standard error pipe; standard
  input and output are null. `DETACHED_PROCESS`, `CREATE_NEW_PROCESS_GROUP`
  and the `CREATE_BREAKAWAY_FROM_JOB` attempt, with its retry inside the job
  (probe P7), are as before. std's `raw_attribute` is unstable, so std
  `Command` could not carry the list. The old step that cleared inheritance on
  the starter's three standard handles is gone: the list covers them.
- A small `DetachedChild` gives `hold --detach` the id, standard error,
  `try_wait` and `kill` it used from std's `Child`, so the wait-and-report
  loop in `main.rs` is unchanged: a holder that fails at once still has its
  own words passed on.
- macOS and Linux: `hold` closes every descriptor from 3 up before
  `serve::run`, listed from `/proc/self/fd` or `/dev/fd`, or every number up
  to the soft limit (at most 65,536) when there is no listing. They are
  closed, not marked close-on-exec, because the holder itself must not hold
  them. It is done in the holder and not between fork and exec in the
  starter, so the pipe std uses to report a failed exec keeps working.
- The app side does not change. One line in
  `docs/remote/helper-threat-model.md` (3.1) records the guarantee.

**Test.** `a_detached_holder_keeps_none_of_its_starters_handles`
(`helper/tests/probe_transport.rs`, all three Helper runners) gives
`hold --detach` an inheritable pipe end, closes its own end once the starter
has exited, and expects end of file within 2 s while list mode still shows
the holder. A plain child given the same pipe is the control: while it runs,
the pipe must stay open. The test alone was pushed first and was red on
Windows, macOS and Linux (CI run 43960735037, "kept the pipe its starter was
given open", with the control passing).

**Owed before stable.** The ADR-009 adversarial pass on this change (process
creation and handle inheritance in the helper), under the owner rule of
2026-11-15 that betas skip it.
