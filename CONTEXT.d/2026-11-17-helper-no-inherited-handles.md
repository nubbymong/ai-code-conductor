## 2026-11-17 -- A held terminal keeps none of the app's open handles (aicc_planning#316, 2.1.3-beta.7 section A1)

**Why.** The app starts each holder through `aicc-helper hold --detach`, run
by Node's `execFile`, which lets the child inherit every handle the app has
marked inheritable. The starter then started the holder with Rust's std
`Command`, which also starts a child with inheritance on, so the holder got
the same handles. The holder outlives the app, so those handles stayed open
for as long as a held terminal ran. On macOS and Linux the same was true of
every descriptor not marked close-on-exec. (aicc_planning#316)

**What changed.**
- Windows: `spawn_detached` (`helper/src/detach.rs`) calls `CreateProcessW`
  itself with `STARTUPINFOEX` and `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`. The
  list names only the write end of the holder's standard error pipe; standard
  input and output are null. `DETACHED_PROCESS`, `CREATE_NEW_PROCESS_GROUP`
  and the `CREATE_BREAKAWAY_FROM_JOB` attempt, with its retry inside the job
  (probe P7), are as before, and both starts use the list. After the retry,
  whether the holder is in a job is asked (`IsProcessInJob`), not inferred
  from the first start failing. std's `raw_attribute` is unstable, so std
  `Command` could not carry the list. The old step that cleared inheritance
  on the starter's three standard handles is gone: the list covers them.
  `spawn_detached` must be called while no other thread starts a child,
  which is true for `hold --detach`.
- A small `DetachedChild` gives `hold --detach` the id, standard error,
  `try_wait` and `kill` it used from std's `Child`, with std's contract: a
  wait that fails is an error, not "still running", and ending a holder that
  has already exited is not an error. The wait-and-report loop in `main.rs`
  is unchanged.
- The Windows process-start pieces (errors, wide strings, the attribute list
  as a type that deletes itself, the exit-code wait) now live in one module,
  `helper/src/winproc.rs`, shared with `pty/windows.rs`. A terminal's wait
  that fails now ends its session, as it already did on macOS and Linux,
  instead of reading as "still running".
- macOS and Linux: `hold` closes every descriptor from 3 up before
  `serve::run`: with `close_range` on Linux (kernel 5.9 and later), else
  from `/proc/self/fd` or `/dev/fd`, else every number up to the higher of
  the soft and hard limits, at most 1,048,576. They are closed, not marked
  close-on-exec, because the holder itself must not hold them. It is done in
  the holder and not between fork and exec in the starter, so the pipe std
  uses to report a failed exec keeps working. A hidden `__close-check <way>`
  command runs one way, for the tests.
- The app side does not change. `docs/remote/helper-threat-model.md` (3.13)
  records the guarantee, and protocol section 15 says it next to the folder
  guarantee.

**Test.** `a_detached_holder_keeps_none_of_its_starters_handles`
(`helper/tests/probe_transport.rs`, all three Helper runners) gives
`hold --detach` an inheritable pipe end, closes its own end once the starter
has exited, and expects end of file within 2 s while list mode still shows
the holder. A plain child given the same pipe is the control: while it runs,
the pipe must stay open. The test alone was pushed first and was red on
Windows, macOS and Linux (CI run 43960735037, "kept the pipe its starter was
given open", with the control passing). Review round 1 added, again pushed
before the fixes (CI run 43969107525, red where expected):
- Windows: `hold --detach` started inside a job that forbids leaving it runs
  the holder inside that job, says so, and passes on no handle; inside a job
  that allows it, the holder leaves. Every other holder a test starts must
  say it is in a job exactly when it is.
- Windows: a failed wait is an error, and ending a copy that has exited is
  not (both red before the fix).
- macOS and Linux: each way of closing (and the holder's own order) closes a
  pipe end, also a copy of it above a soft limit lowered after it was opened
  (every-number red before the fix).

**Owed before stable.** The ADR-009 adversarial pass on this change (process
creation and handle inheritance in the helper), under the owner rule of
2026-11-15 that betas skip it.
