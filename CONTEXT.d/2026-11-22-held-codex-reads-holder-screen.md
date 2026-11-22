## 2026-11-22 -- a held Codex session's composer rule reads the holder's screen (2.1.3-beta.14 B2)

aicc_planning#388, S13's first reader move. Before this, every local Codex
session had a headless pane in main, fed from its first byte, which the
composer rule read before main typed into Codex; a session the helper holds
already has a screen of record in its holder, so it was parsed twice.

- **Which sessions.** With the agent sessions' switch on, a held agent session
  of a provider in the manager's `deps.screens` asks on its connections for
  `screen` and `title`. app-wiring.ts gives Codex's only, so Claude Code and
  plain terminals ask as before. The manager compares no provider name; the
  map is keyed by provider, as `hooks` and `tools` are.
- **The read.** `HelperPty.screenRead` is the one new accessor on the helper's
  terminal: defined while the terminal is on a holder whose connection acked
  `screen`, each call reads on the connection in use then (an attach again's
  too). It is undefined on the usual way and on a holder without screen reads.
- **Decided at the first byte.** A launch through the helper can still start
  the usual way before its first byte (helper-pty.ts fallBack), and a holder
  may read no screen, so bindCodexPane hands the run screen a `held` question
  and the run's first byte answers it: the holder's read and no pane, or the
  pane, opened then, before that byte is fed. Before the first byte a read
  gives nothing, as an empty pane read nothing ready; `has` is true from the
  launch, so Ask's opening question still waits for the first ready screen.
- **No reading is never a ready one.** A read that fails, a screen cut to its
  bottom rows (what is above them could be a prompt) and rows that do not
  fill the screen are each no reading: nothing is typed on them, and a text
  already typed is not taken back. The holder's title is '' for none, which
  the rule reads as the pane's null.
- **The rule is unchanged.** src/shared/codex-screen.ts and composer-submit.ts
  keep their rules; only where the rows and title come from changed. All 41
  Codex recordings in helper/fixtures/screens, as the holder answers them
  (the rows and title B1 committed), give the rule the same state as main's
  pane fed the recording.
- **Logs.** One line when a held run's first byte decides ("held by the
  session helper, so its composer rule reads the holder's screen and no pane
  is opened", or the pane's line), and one line per submission naming what
  came of it and where the rule read the screen.
- pty-manager.ts is not touched. Its comments that say an Ask question is
  typed "through the pane" (:6146, :6250) and that name the submit
  primitive's pane of a Codex session (:7411) are left for the aggregate,
  which owns that file's edits this beta. The lines in docs/remote/helper-protocol.md (:1251, :1294),
  helper/README.md (:30) and helper/src/serve.rs (:125) that say nothing in
  the app asks for the screen reads or the title yet are left for the
  aggregate too.
