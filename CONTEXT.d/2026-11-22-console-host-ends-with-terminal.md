## 2026-11-22 -- A terminal's console host ends with its program (aicc_planning #363, plan 2.1.3-beta.14 C5)

**Measured first (C1.3, the published beta.13 on the test VM, one app run).**
Console hosts (`conhost.exe`, children of the app's main process, made after
it) counted 5, 30 and 60 s after each case. Programs that ended by themselves
with their tabs still open (exit typed in 2 Terminal only tabs, Ctrl+C twice
in 3 Claude Code tabs): 5, 5, 5. The same 5 tabs then closed: 5, 5, 5 (the
same five pids). 3 Claude Code tabs and 2 Terminal only tabs closed while
their program ran: none of their own 5 hosts left at 5, 30 or 60 s. The five
left hosts ended only with the app's quit. A Codex tab runs on node-pty's
bundled ConPTY (OpenConsole.exe) and left nothing.

**Root cause: node-pty 1.2.0-beta.15, `src/win/conpty.cc`.** On Windows' own
ConPTY a host ends only when its pseudoconsole is closed. node-pty's kill
(`PtyKill`) closes it only while it still has the pty's record; the thread
that waits for the program (`SetupExitCallback`) erases that record, with its
pseudoconsole handle, unclosed, the moment the program exits. So after a
program ends by itself the tab's kill finds nothing to close. A kill while the
program runs still finds the record and closes it, which is why closing a
running tab left nothing. node-pty's bundled ConPTY releases its pseudoconsole
at the start, so its host ends with the program. The prebuilt binary ships as
it is, and the handle is gone, so the app cannot close the pseudoconsole
after the exit.

**Fix.** The app ends the host instead. `src/main/console-host-end.ts` times
each terminal node-pty makes on Windows' own ConPTY (Date.now() just before
and after the spawn, inside which the pseudoconsole and its host are made;
spawns run one at a time on the main thread) and, once node-pty reports the
program's exit, runs the session helper's new `end-console-host` mode with
that time (`helper/src/consoles.rs`). The helper ends each `conhost.exe`
(Windows' own program file) that is a child of the app, this user's, made in
that time and still running, holding each open from the check to the end
(the first fix ended one, and none when more than one passed; the second
review fix below ends each). Two starts in one millisecond are not asked
for.

**Review fix: the time does not keep a running terminal's host.** Date.now()
in Electron's main process is not the clock Windows stamps creation times
with: it runs behind it by up to one Windows clock tick (15.625 ms at the
default tick), and a host is made only a few ms before the spawn returns. So
the time as first passed could end before the terminal's own host was made,
and instead hold the host of a terminal started a few ms earlier, which the
helper would then end while its program ran. The reviewer's measurements on
the dev PC: CreateProcess returned 1.6 to 3.3 ms after the new process's
creation time (27 runs); that PC's tick was 0.35 to 1 ms at the time (171
distinct system time readings in 500 ms), so the default tick was not
reproduced there. Now the app widens the time by 50 ms on each side and asks
no sooner than 6 s and that 50 ms after the start, and the helper never ends
a host that still has a program (the console host of a listed process that
still runs, `ProcessConsoleHostProcess`; a running process it can open but not
read stops it from ending anything) nor one made less than 6 s before it runs
(node-pty gives a program 5 s to start in its pseudoconsole,
`CONNECTION_TIMEOUT` in its `windowsPtyAgent.js`, and until then a running
terminal's host has no program). The helper's program check, not the time, is
what keeps a running terminal's host.

**Second review fix: every host left is ended.** With every time widened by
50 ms on each side, two terminals started within about 50 ms of each other (for
example tabs switched through quickly: the app starts a tab's terminal only
when the tab is first on screen, so tabs made together do not start their
terminals together) each lie in the other's time, and the helper still ended
nothing when more than one host passed its rules. So when both programs had
ended by the first ask (both ended within about 1.2 s of each other, as
node-pty reports an exit 1 s after it, or both in their first 6 s), neither
host was ended, each terminal asks only once, and both ran until the app quit,
as on beta.13. A host never ended earlier (a same-millisecond start, a helper
error) blocked its neighbour for good the same way. After the program check
that rule kept nothing safe: every host left has passed every rule by itself.
Now the helper ends each host left, and `ended` says how many. The app's code
is unchanged: it logs any `ended` above 0.

**Wording: what a process with no console answers.** The reviewer read
`ProcessConsoleHostProcess` read-only on the dev PC (Windows 11 build 26320,
347 processes readable): 228 with no console answered the pid of the process
that made them, flag bit 0 clear; the 63 attached to a console answered their
host's pid, bit 0 set. The comments said such a process answers 0. The code
counts those makers' pids as hosts with a program, which can only keep a host,
never end one, so the code stays as it is (not narrowed to bit 0 until
Windows 10 and Server are measured); `host_pid_of`, `hosts_with_a_program`
and the threat model now say so.

The wrapper sits on the one place the app starts a terminal the
usual way (`spawnWithNodePty`, `src/main/session-helper/manager.ts`: Terminal
only and partner tabs, Claude Code and Codex sessions, Insights' run, and the
helper's own fallback start), so pty-manager.ts and the launch bindings are
unchanged (no line).

**Tests.** `tests/unit/main/console-host-end.test.ts` (14): asked once after
the exit with the start's time, widened by 50 ms on each side; an exit within
6 s of the start asked for only after the wait (a timer); never while the
program runs; same millisecond, a start too long for the helper's ten seconds
once widened, and a clock set back not asked for; no helper said once; an
answer naming another process not taken; the bundled ConPTY, another system
and a terminal node-pty did not make left as they were; the manager's three
usual-way spawns go through it with their arguments unchanged; and a pin on
node-pty's behaviours above (and its 5 s CONNECTION_TIMEOUT, beside the
helper's 6 s), which fails when an update changes them. Red against the old
code (the wiring reverted, and seven mutants; after the review fix, 7 of the
14 red against the first fix's module, and the slack, the wait and the
widened bound each dropped as a mutant). Rust: `helper/tests/console_hosts.rs`
(5 for this mode, Windows) and four unit tests in `consoles.rs`; the first
three were committed before the mode and failed in the Helper job with
"unknown command end-console-host", and the review fix's two new tests and the
6 s check failed in run 45039534666 against the first fix's mode (a running
terminal's host ended; a time holding a running and an ended terminal ended
neither; a host asked for within 5 s of its start ended). The second review
fix's test (two terminals started back to back whose programs have both
ended, and a third still running, asked once with a time that holds all
three: ended 2, the running one's host kept with its note) replaces the one
that pinned "neither host ended", and failed in run 45046117494 (Helper,
windows-2025) against the first review fix's mode: ended 0, "2 console hosts
were made in that time, so none was ended". The third review round found that
the replacement had dropped the only check that the time picks among ended
hosts (nothing failed if the mode stopped applying it), so the test now also
has an ended terminal started before the time of the first ask: that ask ends
the two hosts in its time (2), the early terminal's host, with no program and
old enough, is kept (only the time keeps it), and the early terminal's own
ask then ends it (1), the running one's host kept throughout. With the time
check dropped in a throwaway commit on a temporary branch (since deleted) it
fails in run 45051425080 (Helper, windows-2025): ended 3, not 2, at the first
ask; it is green on the real code. They suspend each host before its program
ends, as the console-hosts tests do, so they check the mode and not what
Windows does with an idle host, and they wait until each host is 6 s old.
(The red runs 45032572689, 45033409949 and 45034021302 also showed a host gone
before the mode ran; the test had ended it itself: its host search dropped
each other terminal's host it looked at, and the test's process handle ends
what it holds when dropped.)

**Not covered here.** Three other places start node-pty themselves and leave a
host the same way when their program ends by itself: an SSH session's terminal
and the SSH End and liveness execs (pty-manager.ts's SSH code, which takes no
hunk this beta) and the first-run setup terminal (ipc/setup-handlers.ts).
Handed to the orchestrator for a ticket. The VM line: C1.3's three counts
passed on the first review fix's head (f86e2efa) with tabs started 12 s apart.
On the second review fix's head (9d544893) the VM re-check passed: a burst of
three terminals started within 42 ms of each other, two with their programs
ended and one still running, had both ended terminals' hosts gone by one ask
and the running one's host kept; two tabs started 12 s apart whose programs
each ended had both hosts gone in about 1 s; and the app was then quit with
Close sessions and left nothing at 3, 10 and 30 s. Not run again on 9d544893:
the VM's clock tick and C1.3's three counts (they passed on f86e2efa, before
the second review fix). The burst check also showed that tabs made together do
not start their terminals together: the app starts a tab's terminal only when
the tab is first on screen, so a burst is terminals started within about 50 ms
of each other (for example tabs switched through quickly), not a restore's
tabs. The third round changes only a test and wording, so no VM run follows
it.