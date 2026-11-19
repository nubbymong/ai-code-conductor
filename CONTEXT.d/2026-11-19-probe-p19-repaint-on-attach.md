## 2026-11-19 -- Probe P19: after a one-row nudge, Claude Code and Codex redraw their whole screen on Windows, macOS and Linux

Plan 2.1.3-beta.11, section A1 (aicc_planning #340). No product code.

- **What was built.** `helper/probes/p19-record.cjs` (the recorder), `p19-model-stand-in.cjs`
  (a stand-in model on a loopback port that streams one reply of 300 lines, Messages API for
  Claude Code and Responses API for Codex) and `p19-scenarios.json` (the keys, the marks and the
  reply). ci.yml has a `probe_p19` dispatch input and a `probe-p19` job on windows-2025,
  macos-latest and ubuntu-latest that runs only on a dispatch that names it, read-only, no
  secret, the CLIs installed with scripts off; `tests/unit/scripts/probe-p19-job.test.ts`
  evaluates its condition for each event (seen red under two planted conditions: one that also
  starts on a push, one that ignores the input).
- **Decisions made while building it.**
  - Claude Code 2.1.328 draws a text block only when the block ends (a spinner and a token count
    until then), so the stand-in sends the reply as 30 blocks of 10 lines, each line its own
    paragraph; otherwise the middle of the reply would show none of it.
  - Codex 0.157.1 starts a background server unless given `--no-daemon`. It refuses that server
    in an elevated session (the test machine's SSH session, GitHub's Windows runner), and on
    macOS the server's socket path under the runner's temporary folder is too long, so every turn
    there ended with code 1. The probe runs Codex with `--no-daemon` everywhere. The app passes no
    such flag, so a normal user's Codex runs with the server; the TUI measured is the same.
  - Codex sends a second Responses request with no tools after its turn; requests a CLI makes on
    its own get a one-word reply, so only the turn gets the 300 lines.
  - Pane 1 answers the CLI's terminal queries, as the app's terminal does; pane 2 does not. Only
    the PTY is resized; the panes stay 120 by 40, as for a nudge the app sends itself.
  - On Windows both ConPTYs are measured: the plan named the bundled one, and the app gives the
    system one to Claude Code sessions and plain terminals today (pty-manager.ts, the P3.15 note),
    so each gets a verdict of its own.
- **Result: REPAINTS for both CLIs on all three systems**, 3 of 3 runs at every state, on the
  test machine (build 22621, both ConPTYs, the probe as of 0c49af32) and in CI run 44533910780
  (e1392065: windows-2025 on both ConPTYs, macos-latest, ubuntu-latest). An earlier dispatch on
  0c49af32 (run 44532520348) gave the same on windows-2025 and Linux, where Codex ran with its
  background server (0c49af32 gave `--no-daemon` on Windows only); its macOS Codex rows failed
  on the background server above and are not counted. A same-size resize is enough only on the
  system ConPTY, whose console host redraws the whole screen on any resize. The full paragraph
  is in ADR-030, after the P18 result (#731).
- **Beside the verdict.** Both CLIs draw their session on the alternate screen, so a replay cut
  after the switch leaves the re-attached terminal on the normal screen with the right rows (not
  under the test machine's system ConPTY, which passes no alternate screen through). The step that
  plans the nudge in beta 12 decides how the terminal gets back to the screen the CLI is on. On
  the system ConPTY a console host was still running a second after node-pty ended the program,
  in 15 of 15 runs on the test machine and 15 of 15 on the runner; the probe stopped each one
  after checking its name and start time (none on the bundled ConPTY, 0 of 15 on each).
- **After review (the readings above came before it).** The clean-up counts a process as the
  probe's only when it started after its parent and, for a program that has ended, before that
  program ended: Windows keeps a parent id after the parent ends and reuses ids, so the parent id
  alone could name a process the probe never started. The recorded runs stopped only console
  hosts the probe had started. The verdict line also names each state already equal before any
  resize, where the nudge had nothing to put right (Claude Code after its reply, on every
  system). Each recording's header and the result name the probe code by the sha256 of its three
  files. The readings above carry no digest: that the test machine's used the probe as of
  0c49af32 is the builder's record. `tests/unit/scripts/probe-p19-record.test.ts` covers the
  three.
- **For A2.** The recordings of every run (each chunk with its offset and time, and the keys,
  resizes and marks) are in each run's artifact (`probe-p19-<os>`) and, for the test machine, in
  the orchestrator's scratch folder; nothing signed in was recorded.
- **WP1 legacy Codex gate.** On beta, helper/ is in no scope of the legacy Codex manifest, so a
  file there that names Codex fails the gate. The scope line is the same as #731's, so the two
  merge cleanly; the manifest and the ledger are regenerated with `added` rows for the new files
  and a note on ci.yml's row.
- **VM.** Held 12:58Z to 13:37Z under the VM lock. Two early runs crashed before their clean-up
  ran (an option the headless terminal needs) and left their two temporary folders, removed by
  name at the end; nothing of theirs was left running. One later run's node did not exit after
  its clean-up (node-pty's Windows reader keeps the event loop alive); it was stopped after its
  name and start time were checked, and the probe now ends itself. A full run stopped on a
  refused pipe write, with its clean-up complete; such a write is now noted, not fatal. The
  profile's own Claude Code and Codex folders show the same item counts and newest writes
  before and after.
- **Order of work.** The job was dispatched on the pushed branch before the PR was opened, so
  the PR opens once with its results and takes one CI round, not two.
