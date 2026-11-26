## 2026-11-26 -- only Claude Code's held terminals wait before a queued lone Enter (2.1.3-beta.19 section 6.2)

aicc_planning#440 (item 2); ADR-030 component rows 3 and 14.

What changed. beta.18's fix round made a held terminal's attach again send
a lone Enter typed while it was detached 300 ms after the frame before it
(session-helper/helper-pty.ts, flushQueued), because Claude Code (2.1.332,
measured) takes a control character as a key only in a read shorter than 64
characters and the holder writes frames that come back to back into one
read. That wait applied to every held terminal, a plain one too, though the
rule is Claude Code's. Now a provider's run screen declares the wait
(SessionRunScreen.heldEnterWaitMs; Claude Code's run screen declares
PROMPT_ENTER_DELAY_MS), HelperPty is told the provider whose CLI it runs
(HelperPtyOptions.provider: the manager's agent sessions and take-overs,
and a tab through the session helper on its machine, from its launch plan)
and asks that provider through the registry when a lone Enter waits behind a
frame. A plain terminal, a provider that declares none, one not registered,
and a lookup that throws send what was queued at once, as before that fix
round. The order rules (input typed during the wait goes behind the Enter, a
second drop keeps it first, an update's let-go sends it at once) are
unchanged.

Decisions. The provider is passed at construction where it is known
(manager.ts spawnAgent and takeOverKept; remote-helper/session.ts from the
plan), not read back from the held session id: a remote tab's id carries no
provider. The usual-way stand-in in spawnAgent (a HelperPty whose hold
always hands over to the usual start) is not told one: it never attaches.

Evidence. tests/unit/main/session-helper-enter-wait.test.ts (17 tests: the
real packages' declarations; a plain, another provider's and a Claude Code
terminal with the real packages registered; values that are no wait; the
remote tab's terminal told its provider): 16 red on cc36c7f3 with src/
reverted. session-helper-take-over.test.ts: the manager's agent sessions
and take-overs name their provider (red on cc36c7f3). session-helper-flow's
order cases now run a Claude Code terminal. Mutants, each red: the wait
given to every provider (13 tests); Claude Code's run screen declaring none
(7); the positive-number check dropped (1); the remote tab not told its
provider (1); the manager not passing it (54, through the shared fixture).
