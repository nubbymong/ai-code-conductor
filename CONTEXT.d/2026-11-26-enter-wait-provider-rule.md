## 2026-11-26 -- a held terminal waits before a queued lone Enter only when its provider declares it (2.1.3-beta.19 section 6.2)

aicc_planning#440 (item 2); ADR-030 component rows 3 and 14.

What changed. beta.18's fix round made a held terminal's attach again send
a lone Enter typed while it was detached 300 ms after the frame before it
(session-helper/helper-pty.ts, flushQueued), because Claude Code (2.1.332,
measured) takes a control character as a key only in a read shorter than 64
characters and the holder writes frames that come back to back into one
read. That wait applied to every held terminal, a plain one too. Now a
provider's run screen declares the wait (SessionRunScreen.heldEnterWaitMs),
HelperPty is told the provider whose CLI it runs (HelperPtyOptions.provider:
the manager's agent sessions and take-overs, and a tab through the session
helper on its machine, from its launch plan) and asks that provider through
the registry when a lone Enter waits behind a frame. Claude Code's and
Codex's run screens declare PROMPT_ENTER_DELAY_MS. Codex needs it too: the
probes of the real 0.153.4 and 0.155.1 TUIs (PB3,
providers/codex/composer-submit.ts) found that one write of a text and its
Enter never submits, and the text then Enter 300 ms later does. A plain
terminal, a provider that declares none, one not registered, and a lookup
that throws send what was queued at once, as before that fix round. The
order rules (input typed during the wait goes behind the Enter, a second
drop keeps it first, an update's let-go sends it at once) are unchanged.

Decisions. The provider is passed at construction where it is known
(manager.ts spawnAgent and takeOverKept; remote-helper/session.ts from the
plan), not read back from the held session id: a remote tab's id carries no
provider. The usual-way stand-in in spawnAgent (a HelperPty whose hold
always hands over to the usual start) is not told one: it never attaches.
The review of the first build found that it took the wait away from Codex
against the PB3 measurement; the fix round gave Codex's run screen the same
declaration.

Evidence. tests/unit/main/session-helper-enter-wait.test.ts (17 tests: the
real packages' declarations; a plain, a Codex and a Claude Code terminal
with the real packages registered; values that are no wait; the remote
tab's terminal told its provider): 15 red on cc36c7f3 with src/ reverted.
session-helper-take-over.test.ts: the manager's agent sessions and
take-overs name their provider (red on cc36c7f3). session-helper-flow's
order cases now run a Claude Code terminal. Mutants, each red: the wait
given to every terminal (11 tests); Codex's run screen declaring none (2);
Claude Code's run screen declaring none (7); the positive-number check
dropped (1); the remote tab not told its provider (1); the manager not
passing it (54, through the shared fixture).
