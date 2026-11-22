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
that time (`helper/src/consoles.rs`). The helper ends the one `conhost.exe`
(Windows' own program file) that is a child of the app, this user's, made in
that time and still running, holding it open from the check to the end; none,
or more than one, and it ends nothing. Two starts in one millisecond are not
asked for. The wrapper sits on the one place the app starts a terminal the
usual way (`spawnWithNodePty`, `src/main/session-helper/manager.ts`: Terminal
only and partner tabs, Claude Code and Codex sessions, Insights' run, and the
helper's own fallback start), so pty-manager.ts and the launch bindings are
unchanged (no line).

**Tests.** `tests/unit/main/console-host-end.test.ts` (11): asked once after
the exit with the start's time; never while the program runs; same
millisecond, a start of ten seconds or more and a clock set back not asked
for; no helper said once; an answer naming another process not taken; the
bundled ConPTY, another system and a terminal node-pty did not make left as
they were; the manager's three usual-way spawns go through it with their
arguments unchanged; and a pin on node-pty's two behaviours above, which fails
when an update fixes it. Red against the old code (the wiring reverted, and
seven mutants). Rust: `helper/tests/console_hosts.rs` (3, Windows) and two unit
tests in `consoles.rs`; the three were committed before the mode and failed in
the Helper job with "unknown command end-console-host". They suspend each host
before its program ends, as the console-hosts tests do, so they check the
mode and not what Windows does with an idle host. (The red runs 45032572689,
45033409949 and 45034021302 also showed a host gone before the mode ran; the
test had ended it itself: its host search dropped each other terminal's host
it looked at, and the test's process handle ends what it holds when dropped.)

**Not covered here.** Three other places start node-pty themselves and leave a
host the same way when their program ends by itself: an SSH session's terminal
and the SSH End and liveness execs (pty-manager.ts's SSH code, which takes no
hunk this beta) and the first-run setup terminal (ipc/setup-handlers.ts).
Handed to the orchestrator for a ticket. The VM line (C1.3's three counts on
this head) is owed.
