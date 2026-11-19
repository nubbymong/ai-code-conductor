## 2026-11-19 -- A command bar prompt button sends on every session, by one rule

Section A1 of the 2.1.3-beta.10 plan (aicc_planning #333; ADR-030 slice S14).
A behaviour change on purpose.

**Before.** A prompt button wrote its text and Enter in one write
(`fullCommand + '\r'` through pty.write), on every session alike. Codex takes
such a write as a paste and never submits it, so on a local Codex session the
button typed and did not send. #333 also reports a local session where it did
not send; which CLI that was is the owner's question 1 (the fix covers both).

**The rule** (`submitPrompt` in `src/main/session-input/index.ts`, beside
submitLine; it moves into the Claude Code package with S13):
- Send, not Codex (Claude Code on this computer, held by the session helper,
  or over SSH): the text in one write through writePty (its slices and its
  launch-pending buffer still apply), after the tmux leave key on an SSH
  Persistent session, then Enter as its own write 300 ms after the text's last
  slice, only while the session's terminal process is still the one the text
  went to. The wait is 300 ms, then one 12 ms wait per slice after the first:
  a slice still to go when the 300 ms ends (main held up, or writePty
  replaying a text it held for a launch line) had its timer set before each of
  those waits, in the same timer list, so the Enter cannot overtake a slice.
  On an SSH Persistent session the Enter's write starts with the leave key
  too: a wheel turn in those 300 ms opens tmux's scrollback again, and
  copy-mode would take a bare Enter.
- Send, Codex: the Codex package's submit primitive with a 5 s ready wait, as
  canvas notes and Ask Conductor use it. A text it refuses before typing is
  typed with no Enter and answered as typed, not sent. A text over 8,000 code
  points is not handed to it (the most it is known to type and confirm; it
  types in one unsliced write, and a missed confirm waits a window that grows
  with the length): nothing is typed, and the answer is not sent. Claude Code
  sessions keep the channel's 100,000 cap.
- Type only: the text, and no Enter, on every kind.
- The same text pressed again for a session within 300 ms is dropped (writePty's
  own guard saw it only because the write ended in Enter). Presses go one at a
  time per session, in order, and each holds the next until its text has
  settled as above, typed ones too. A press types only into the terminal
  process the session had when it was pressed: none, or one replaced while
  the press waited, takes nothing, so nothing waits in writePty's buffer for a
  later start. The log names a prompt by its length only.

**Review.** Copilot reviewed the first head on its own (no review was asked
for). Three of its four threads were right and are fixed: a type-only press
let the next one land between its slices, and a queued press (the Codex
refused-text fallback too) chose its terminal process when its turn came, so
it could type into a restarted session. The fourth asked about writePty's
launch-line hold. A local Claude Code start holds writes on a 300 ms timer set
when the session starts. That timer is always set before a press's own
300 ms wait, so the replay has started when the wait ends. A test now holds
that, including a press in the start's own millisecond. Ordering the 300 ms
wait before the slice waits is what makes that last case hold.

The plan's one reviewer then found four code issues, all fixed: the SSH
Persistent Enter's missing leave key and the Codex length cap (both above),
an untested guard that keeps a Terminal only tab's shell line off the new
path (now a routing case), and the session-gone note, which did not fit a
session still starting (writePty used to hold such a press; the door now
refuses it), now "the session was not running, or it ended or restarted
before it could be sent."

**The channel.** `pty:submitPrompt` ({ sessionId, text }), answered to the
app's window only, with a strict payload and a 100,000-character cap (far
above any prompt button; askConductor:handOff caps a question at 8,000, which a
long template prompt could pass). A partner terminal's id is refused: its
buttons are shell lines. Main reads the mode from the saved settings at each
press: `type` only when `commandPromptButtons` is exactly 'type'; anything else,
an unreadable file included, sends. The answer is a new shared type,
`PromptButtonResult` (src/shared/types.ts, beside SubmitTextResult), which the
plan's file list did not name.

**The renderer.** CommandBar's typeIntoPty calls the bridge for a prompt
button aimed at the agent in the main pane, after dropping the wheel's tmux
scrollback belief (a new `dropTmuxCopyModeBelief`). A "not sent" answer is
said in the bar's note: Ask Conductor's words for Codex's four reasons, with
"the session" where those name the Ask tab, and new words for main's own
refusal (refused-text) and for session-gone. Shell line, partner and page buttons
are unchanged, and a preload with no bridge writes as before.

**The setting.** Settings, Custom Commands, the Commands card: "Prompt
buttons: Send the prompt" (default) or "Type it only". One choice for every
session; shell line buttons always run.

**Not changed.** writePty, pty-manager.ts, the SSH radius files, the Codex
composer rule, the status strip controls, canvas notes, Ask Conductor, /login
and image paste.

**Owed.** ADR-009 pass before stable (aicc_planning #320 list): a new IPC
channel and preload method that types into a session. The live SSH matrix is
not owed (no radius file; it cannot see a prompt button); the SSH check is the
plan's owner test steps 2 and 3.
