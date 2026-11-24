## 2026-11-24 -- A canvas decision for a restored tab not on screen waits for its take-over

Plan 2.1.3-beta.17, section B1g (aicc_planning#423), on B1 to B1e (the beta.17 aggregate,
b0b450ec). Windows, behind the agent sessions' switch. Fragments B1c to B1e
(2026-11-24-takeover-hidden-tab-*.md) are not edited (CONTEXT.d/README.md).

- **Found (read in the code during the B1e join, then measured red in unit tests on
  b0b450ec, tests/unit/main/takeover-hidden-tab-canvas-decision.test.ts, 9 of 13 red).**
  A restored tab whose kept session it has not taken over yet has no terminal in this run.
  (1) An approval or review filed on the Agent Canvas for it went through the queue to the
  marker door (session-input submitMarker), which answered "not delivered, the session
  gone", so the canvas said the agent did not get it, and nothing was typed after the
  take-over. Codex the same way: a session reads as Codex only with a live PTY, so a Codex
  tab's marker took the same answer; there is no other Codex path. (2) A decision the queue
  held while the kept CLI's turn ran (its hook events reach the app from 3 s after Resume,
  B1e) was dropped by the take-over's own kill (killPty, cleanupSessionResources,
  unbindLaunchRegistrations, forgetCanvasMarkers) and told as not sent, so the turn's Stop
  typed nothing. A Restart's kill did the same. Workaround until now: open the tab, then
  file the decision again.
- **Fix (canvas-marker-delivery.ts, launch-bindings.ts).** A marker the queue hands on
  while kept-launches.ts keptForItsTab says the session waits for its tab waits in the
  delivery module, in order (the same line about the same canvas once, at most 32), and the
  canvas is told nothing; canvas:agentMarker answers 'queued'. While the session waits,
  forgetCanvasMarkers drops nothing (the take-over's own kill and a Restart's come before
  the same CLI goes on in the tab). Right after the take-over (takeOverKeptLaunch, once
  pty-manager.ts has made the run the session's in the same call) each goes on once, as the
  queue hands one on: held again ahead of later ones while a turn reads open, else to the
  marker door, which types it at Claude Code's ready, empty prompt or hands it to Codex's
  submit primitive, as for an open tab. When the session is kept no longer with no take-over
  (its tab closed, its CLI ended, the 5 minutes after its tab was shown, its holder not
  reached, End on the Machines page, a quit, or the tab starting a new CLI on another
  account), unserveKeptLaunchUnseen drops them and each is told to its canvas once, the
  session gone, in the order filed.
- **Unchanged.** Nothing kept for the tab (the switch off, no update): a tab with no
  terminal is told at once, as before. An open tab, and a tab taken over: as before. No
  helper (Rust), protocol, session helper manager or pty-manager.ts change (pty-manager.ts
  7,741 lines, cap 7,773).
- **Tests.** The new file (13 cases): 9 red on b0b450ec, the 4 that pin unchanged
  behaviour green there; all 13 green with the fix; mutants each turn their cases red: the hold dropped, the release not made, the
  release made before the run is the session's, the kill's keep dropped, the release list
  not cleared, the collapse dropped (a Codex double press, which Codex's primitive does not
  collapse), the end's drop removed, the kept check dropped from the hold, the keep made for
  every session.
- Not checked here: the two-build VM line (the orchestrator's).
