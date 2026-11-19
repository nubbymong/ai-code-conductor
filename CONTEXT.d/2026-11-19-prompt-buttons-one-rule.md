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
  went to. The wait counts the slices: one 12 ms wait per slice after the
  first, each set after that slice's own timer, so the Enter cannot overtake a
  slice even when main is held up.
- Send, Codex: the Codex package's submit primitive with a 5 s ready wait, as
  canvas notes and Ask Conductor use it. A text it refuses before typing is
  typed with no Enter and answered as typed, not sent.
- Type only: the text, and no Enter, on every kind.
- The same text pressed again for a session within 300 ms is dropped (writePty's
  own guard saw it only because the write ended in Enter). Presses go one at a
  time per session, in order. A session with no terminal process takes nothing,
  so nothing waits in writePty's buffer for a later start. The log names a
  prompt by its length only.

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
said in the bar's note, in Ask Conductor's words for each reason with "the
session" where those name the Ask tab. Shell line, partner and page buttons
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
