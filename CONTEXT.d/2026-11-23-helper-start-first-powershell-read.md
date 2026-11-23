## 2026-11-23 -- start.rs: the first Windows PowerShell read outlasted the 10 s fakes; fakes now run until their test ends them

start.rs's `it_says_which_process_it_started_in_the_form_the_app_checks` failed twice in the Helper
(windows-2025) job with "You cannot call a method on a null-valued expression": Get-CimInstance
Win32_Process found no process for the pid the helper had just started. Run 45128948476 (2026-11-23,
PR #757) and run 44747703272 (2026-11-20). In the last 300 CI runs (2026-11-19 to 23) start.rs ran
in 68 Helper windows job runs, and these two are its only failures. Commit c598a224 answered the first
by giving each fake 120 s of life instead of 10 s, without measuring what slowed the read.

- **The cause.** Each fake CLI slept a fixed 10 s, and the test's first read can take longer. That
  read is the job's first Windows PowerShell 5.1 and its first CIM query: no other helper test runs
  PowerShell or WMI.
- **Measured** on windows-2025, after the Helper job's own steps (diag runs 45164289668 and
  45167229173):
  - The first read took 2.1 to 7.3 s on 14 runners. PowerShell's start to its first statement took
    1.4 to 5.3 s, and the CIM query 0.6 to 1.8 s. On the 7.3 s runner, PowerShell's own log shows
    2.8 s from "starting" to "ready" (0.8 to 1.4 s on the others). Its CIM query also started a new
    WMI provider host, because the one from boot had exited.
  - Later reads took at most 1.0 s alone (2,800 reads) and 3.7 s beside four busy loops (672 reads).
  - On 8 more runners the first PowerShell took 2.35 to 2.67 s of wall time against 0.63 to 0.95 s
    of its own CPU. Later runs took 0.26 to 0.36 s. Most of the first start is waiting, not
    PowerShell's own work. What it waits for (disk reads or another process) was not measured.
  - The two failures spent 12.4 s and 18.3 s in the test before failing. The median of the 66 passes is
    5.4 s; the slowest pass took 8.8 s. Eight reads take that long only when one is far slower than the rest, and the slow one
    is the first.
  - A fake that has exited is not in Win32_Process, even while a handle to it is held. On 14 of 14
    runners, a fake that expired by itself (exit code 0, about 2,005 ms after it was made) and one
    that was ended (exit code 1) each gave the same empty answer.
  - Beta's old test, with its read begun 130 s after the start, fails with the same message (run
    45167229173, proofs).
- **Ruled out.**
  - A fake that ended early for another reason: none had exited at any of 3,584 reads. Each fake was
    read through a handle held from its start.
  - A wrong pid: every read found the program that was started, with the creation time the helper
    printed (the test asserts both).
  - Defender: real-time protection, script scanning and behaviour monitoring are off on the runner,
    and C:\ and D:\ are excluded. Its process used 0.06 s of CPU over the whole test step.
  - A cold WMI service: winmgmt and a provider host ran from boot.
- **Not reproduced unaided.** No diag read took longer than 10 s. The slowest first read was 7.3 s,
  and one verify run spent 10.8 s in the test and passed. The two CI failures are matched by their
  timing, the failure message, and the measured slow first read.
- **The fix** (tests and the fake CLI only).
  - `aicc-fake-cli --while <file>` runs while a file is there, looking every 100 ms, with no time
    limit of its own.
  - start.rs holds one such file per test process in the cargo target's tmp folder, open with
    FILE_FLAG_DELETE_ON_CLOSE. Windows deletes the file when the test process ends, whether or not
    any guard ran.
  - Every fake start.rs starts runs on that file. LIFE (120 s) is gone.
  - `Started::checked` holds the process only while it has the creation time `start` printed.
    `Started::open` (the early guard for a line with no readable creation time, and the copy found
    under a started program) holds the process its pid names when the test takes it. Both end it
    through the held handle, never by a bare pid at the end (the class of a21b99da).
  - A failed read says how long it took, how long after the process was made it began, and whether
    the process still ran or exited, when, and with what code.
- **Checked** (run 45167229173):
  - start.rs passed 250 times on 10 runners: the full suite once, then 20 times alone and 4 times
    beside four busy loops on each runner. No fake and no lease file was left.
  - The test fails under four helper mutants and leaves no fake after any of them. The mutants: the
    helper's own pid printed, pid 4, the program ended before its pid is printed, and the creation
    time rounded instead of cut.
  - A test process ended by force leaves no fake 1 s later. Beta's old test leaves its 120 s fake
    running, so this check can fail.
  - A read begun 130 s after the start passes.
  - CI run 45166826515 (a dispatch with the Helper job) is green on windows-2025, macos-latest and
    ubuntu-latest.
- **Not the same hazard.** probe_transport.rs's control fake keeps `--sleep 20` as a leak cap: it is
  used for a 0.5 s wait with no other program started in between, and its guard ends it (a comment
  now says so beside it).
