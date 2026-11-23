## 2026-11-23 -- A quit's exit keys come from the session's provider package

Section B3 of the 2.1.3-beta.15 plan (aicc_planning#393; ADR-030 slice S14).

**Measured first (M1.2, the published beta.14 on the test VM, Codex CLI
0.157.1, a direct tab, helper switches off).** Four real quits at Codex's
"Hooks need review" screen and at its composer took 0.39 s to 1.20 s, with no
forced kill. What ends Codex: at the composer, Ctrl-C (or Ctrl-D) alone; at
Hooks review, only Escape and then Ctrl-C. /exit never did: Codex takes one
write of a line and its Enter as a paste and does not submit it (PB3). M1.2
tried the Ctrl-C after the Escape only at 110 ms and at 1,509 ms, and read
the cause as PATH.

**Measured on B3's first build (vm:B3, 3d447f1d, the same VM, Windows 11
build 22621).** One of five held quits at Hooks review waited out the 5 s
timeout and force-killed Codex. 21 key tries on fresh tabs, held and direct
alike, showed why: after the Escape, one Ctrl-C ends Codex at 20 to 105 ms (7
of 7) and at 1,002 and 1,006 ms, and does nothing at 121 to 502 ms (11 of 11;
Codex stays at its composer). The quit typed its Ctrl-C at 100 ms, at the
edge of that dead stretch, so a late timer lost it. The cause is TIMING, and
it fits #393's own 5.0 s reading on the direct path.

**Change.** `SessionProvider.exitKeys` (providers/types.ts): each provider
package names the keys a quit types into its CLI, each with its time from the
quit's start. Claude Code's are the same keys at the same times as before.
Codex's are Escape at once, Ctrl-C at 30 ms (well inside the early stretch)
and Ctrl-C again at 1,500 ms, with no /exit. The second is a backstop for a
first one a late timer pushed into the dead stretch: a Ctrl-C at 1,002,
1,003, 1,006 and 1,509 ms after the Escape ended Codex with exit code 0 (one
try: Ctrl-C at 153 ms lost, at 1,003 ms ended). It comes after every end on
record: an early Ctrl-C ended Codex 562 to 1,163 ms after the Escape (7
tries), and M1.2's slowest quit took 1.20 s. A Ctrl-C into a Codex that is
shutting down gives Windows' Ctrl-C exit status (M1.2: at the composer a
second Ctrl-C 210 ms after the first, exit code -1073741510), which the run
log records as crashed. 1251d798 put the backstop at 1,100 ms, inside that
range (HH2: Ctrl-C at 80 ms, ended at 1,163 ms); this head moves it to
1,500 ms.
`sendExitKeys` (session-input) now takes the session's agent, reads that
provider's keys through the registry and types them as it typed its fixed
list: only while the terminal is still the session's, so a Codex that has
ended (at its composer about 230 ms after a Ctrl-C) gets no backstop, and a
failed write dropped. A session with no agent, or a provider with no keys,
gets none (gracefulExitPty hands a Terminal only SSH tab whose launch line
the app typed the SSH surface's provider, so that one keeps Claude Code's
keys). pty-manager.ts: the one call and four comments, no net line, no hunk
in the SSH branch. A tmux-persistent or not app-started terminal still gets
none.

**Tests.** pty-quit-exit-keys-local.test.ts (the real packages): Claude Code's
keys at 0, 100 and 300 ms; a local Codex session's keys; Codex's at 0, 30 and
1,500 ms and nothing more up to the timeout; a Codex whose terminal ended at
260 ms gets no second Ctrl-C and no kill, nor does one still shutting down at
1,162 ms that ends at 1,163 ms. The first three Codex tests were red on
3d447f1d's keys (one Ctrl-C at 100 ms: 3 failed, 4 passed of 7); the timing
test and the 1,163 ms one were red on 1251d798's (second Ctrl-C at 1,100 ms:
2 failed, 6 passed of 8); all are green now. The 260 ms test also goes red if
sendExitKeys stops checking that the terminal is still the session's.
session-input.test.ts: a Codex session through gracefulExitPty gets its
provider's keys at their times (its stand-in provider names the package's
keys, so that test proves the timer walk, not the package's times); a
session with no agent gets none. The
tests that name Codex's keys or the session with no agent were red on
4252cbfc (it typed /exit into the Codex session, and the three keys into the
session with no agent). The Claude Code timing test pins behaviour that did
not change: it is green on 4252cbfc too, and goes red if a time in the Claude
Code package's list is changed (not run). pty-ssh-terminal-only.test.ts: a
Terminal only SSH tab whose launch line the app typed still gets Escape,
Ctrl-C and /exit; red on B3's first head (d6ab9776, which typed none into it:
1 failed, 48 passed of 49), green on 4252cbfc and now (49 of 49).

**Not measured.** A Ctrl-C 30 ms after the Escape at the composer (100 and
110 ms ended Codex there, in 320 to 397 ms). A Codex quit while its composer
holds a draft, or while a turn runs. A Hooks-review end later than 1,500 ms
after an early Ctrl-C (none on record; the VM line on this head reads each
quit's exit code). A quit whose first Ctrl-C is lost ends after the
backstop: the late tries ended 226 to 833 ms after their Ctrl-C, so such a
quit takes about 1.7 to 2.3 s, still well inside the 5 s timeout. Other
Codex versions and Windows builds. An unended Codex still ends at the 5 s
timeout's forced kill, as before.
