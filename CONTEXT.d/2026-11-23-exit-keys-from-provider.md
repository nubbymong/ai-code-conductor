## 2026-11-23 -- A quit's exit keys come from the session's provider package

Section B3 of the 2.1.3-beta.15 plan (aicc_planning#393; ADR-030 slice S14).

**Measured first (M1.2, the published beta.14 on the test VM, Codex CLI
0.157.1, a direct tab, helper switches off).** #393's 5 s wait at Codex's
"Hooks need review" screen did not happen again: four real quits took 0.39 s
to 1.20 s, with no forced kill. The keys the app typed (Escape at once, Ctrl-C
at 100 ms, /exit at 300 ms) end Codex at both screens in under 1 s. What ends
it: at the composer, Ctrl-C (or Ctrl-D) alone; at Hooks review, only Escape
and then Ctrl-C. /exit never did: Codex takes one write of a line and its
Enter as a paste and does not submit it (PB3). So the verdict is PATH: #393
was read on beta.14's B2 section build, which M1 did not run again, and the
published build has no measured defect.

**Change.** `SessionProvider.exitKeys` (providers/types.ts): each provider
package names the keys a quit types into its CLI, each with its time from the
quit's start. Claude Code's are the same keys at the same times as before.
Codex's are Escape at once and Ctrl-C at 100 ms, with no /exit. Only one
Ctrl-C: two, 200 ms apart, ended Codex at its composer with Windows' Ctrl-C
exit status, not 0. `sendExitKeys` (session-input) now takes the session's
agent, reads that provider's keys through the registry and types them as it
typed its fixed list: only while the terminal is still the session's, a failed
write dropped. A session with no agent, or a provider with no keys, gets none.
pty-manager.ts: the one call and its two comments, no net line, no hunk in the
SSH branch. A tmux-persistent or not app-started terminal still gets none.

**Tests.** pty-quit-exit-keys-local.test.ts (the real packages): Claude Code's
keys at 0, 100 and 300 ms; Codex's at 0 and 100 ms and nothing more up to the
timeout. session-input.test.ts: a Codex session through gracefulExitPty gets
its provider's keys; a session with no agent gets none. All four new tests
were red on 4252cbfc (it typed /exit into the Codex session, and the three
keys into the session with no agent) and are green now.

**Not measured.** A Codex quit while its composer holds a draft, or while a
turn runs: neither the keys before nor these were tried there. An unended
Codex still ends at the 5 s timeout's forced kill, as before.
