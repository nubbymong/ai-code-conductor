## 2026-11-25 -- one input seam: each door types through the session's own provider (2.1.3-beta.18 section 4)

aicc_planning#432; seam audit S3; ADR-030 component rows 3 and 14.

What changed. The session input module's port asked one question, "is it
Codex?", and five doors decided on it: the Watchdog's retry, a prompt
button, an image, a canvas marker and the Ask hand-off. Four of them typed
Claude Code's way for every other session; the Codex run screen was fetched
by name. Now the port says which provider runs the session (providerOf) and
whether it launched as Ask (isAskSession), and each door calls that
provider's run screen member for the door (SessionRunScreen's retry, prompt,
marker, image, ask), handing it the door's waits and the run it was asked
for (RunScreenTyping: the write port, the run, the tmux leave key). A
provider with no member for a door takes nothing there, and the door logs one
line. The Codex package's members are the Codex calls the module made
(providers/codex/run-screen-doors.ts); the Claude Code package now has a run
screen holding the rules the module typed for every non-Codex session,
moved unchanged (providers/claude/run-screen.ts). codexRunScreen is gone: the
PTY manager closes and resizes through closeRunScreens and resizeRunScreens
(every registered provider's run screen). pty-manager.ts stays at 7,741
lines: the registration and those three calls changed in place.

The renderer's image sender asks main's door for every session on this
computer and reads the session's image line (sessionCapabilities' imageLine:
Claude Code `enter`, Codex `composer`, a plain shell none) instead of testing
the provider. It is read in the renderer, not carried in main's answer,
because the existing door tests pin main's answers exactly.

Decisions. "Type it only" stays the prompt door's own, for any provider with
a prompt member. A door a provider has no rule for answers as the session gone
(no new reason or user text for a provider that does not exist yet); its log
line says why. providerOf names the SSH surface's provider for a Terminal only
SSH tab whose launch line the app typed, as the quit keys already do, so that
tab's canvas markers keep Claude Code's rule.

Evidence. Every existing door test passes with its assertions unchanged (their
port fakes and registry mocks now hand each package's own members). New:
tests/unit/main/session-input-third-provider.test.ts (a stand-in third
provider gets nothing at the four fall-through doors and its own member at
all five; red on d0be048e, 12 of its 13 tests; the one green there is the
Ask door with no rule, which typed nothing on the base either) and
tests/unit/renderer/image-transfer-line.test.ts (red on d0be048e, 4 of 4).
The ownership test counts the two packages' typing sites with their reasons
(its two new module-shape checks red on d0be048e). Mutant caught: Claude
Code's run screen put back as the prompt door's fall-through.

Review fixes (the same day). The renderer's image line is keyed by ProviderId
and read from the record's own provider, so a provider with no line gets none
(it read every provider that is not Codex as Claude Code, so a new provider's
session got Claude Code's line after main's `not-taken`); adding a provider is
a compile error there until its line is decided. submitLine is removed: no
src code called it once the retry became the Claude Code package's member,
and its tests now type through submitRetry (the SSH ones through the real,
registered Claude Code package). New: tests/unit/providers/
run-screen-doors-wired.test.ts holds the real packages to their door members
(every other door test hands a stand-in run screen), red with the Claude Code
package's runScreen deleted and with the Codex package's door members dropped.
The isAskSession port's doc now says it is the PTY manager's Codex Ask record,
which a Claude Code Ask launch is not in.

Owed. ADR-009 pass before stable (aicc_planning#320 list): what the app types
into a PTY. A VM line on this head (plain and held, Claude Code and Codex,
each of the four presses), run by the orchestrator's VM lane.
