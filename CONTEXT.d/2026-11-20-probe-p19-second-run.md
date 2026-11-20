## 2026-11-20 -- Probe P19, second run: the modes a mid-stream re-attach loses, Codex 0.170.0, the console host, and Codex's hint rows

Plan 2.1.3-beta.12, section A2, step 1 (aicc_planning #353). No product code. Step 2 (the
recordings into helper/fixtures/screens, screen-corpus.test.ts and the ADR-030 paragraph) follows
once beta.11's A2 and #740 are on beta.

- **What was built.** `helper/probes/p19-record.cjs` now records, for both panes at each mark and
  after each step, the screen in use and every field of xterm.js's `modes`, with a verdict per
  mode. A mark can be record only (to the mark and 300 ms on, no resize). On Windows it counts each
  run's console hosts 1, 2, 5, 10, 30 and 60 s after node-pty reports the exit, before anything of
  that run is stopped; the next run goes on meanwhile, and a run's processes are the probe's own
  children started between its start and its end, and their descendants. A launch can run fewer
  times than `--runs`: the queue, rebound-key, agents and warning launches and the background
  server row run once; the short turn, whose mid-reply is record only, runs three times like the
  rest. A reference row that runs only when `--only` names it starts Codex without
  `--no-daemon`. `P19 SIZES` estimates each state's screen corpus file against its 256 KiB cap.
  The stand-in has a second, short reply.
  `p19-scenarios.json` adds Codex launches: a short turn of its own (mid-reply record only,
  after-reply measured), a draft typed while it runs (the queue hint), a config that rebinds the
  shortcuts key to F6, and two attempts of up to 60 s: the agents form of the hint row and a
  warning count on it (a config whose MCP server program does not exist). ci.yml's probe job
  installs the dispatch's `codex_rc_version` when given, 0.157.1 otherwise.
- **Decision lines, written before measuring** (in the recorder's header). A mode, per CLI per
  system: KEPT when pane 2 equals pane 1 two seconds after the nudge in 3 of 3 runs at every state
  reached; LOST when they differ in 2 of 3 or more at some state; else NO VERDICT; whether it was
  already equal before any resize recorded beside it. Codex 0.170.0: P19's own three lines. The
  console host: ENDS BY ITSELF when none is left 10 s after the exit in every run; STAYS when one
  is left at 60 s in any run; in between, recorded with its times. Codex with its background
  server in an elevated session: RUNS A TURN, or FAILS with what it printed. A hint row: RECORDED,
  or NOT REACHED with what was tried and what the screen showed.
- **Decisions made while building it.**
  - The short reply is 30 lines in 1.5 s, not about 40 in 2 s. At 40 lines the after-reply
    recording was 277 to 299 KiB on macOS and Linux. Replayed line by line, Codex redraws the
    whole screen for each new line once the screen is full, about 6 KB each, whatever the pace:
    streaming the 40 lines in 0.8 s left it at 285 to 298 KiB. At 30 lines the largest is
    239 KiB (Linux, 0.157.1); the cap is not raised.
  - The launches this run adds wait for the composer and the footer row with the model's name
    before they type or mark. On one runner the queue launch typed while Codex 0.157.1 still
    showed "model: loading" and no footer; the Enter was dropped and the hint never showed.
  - The test machine run was started detached under a headless console host, so the probe had a
    console as in an SSH session and its helper processes made no console hosts of their own to
    count; it ran elevated, in session 0.
- **Result, the modes** (the same on GitHub's Linux, macOS and Windows runners, both ConPTYs, and
  the test machine's bundled ConPTY). LOST: the screen in use (both CLIs), bracketed paste (both),
  focus reporting (`?1004`, both), mouse reporting (Codex 0.157.1 and 0.170.0). KEPT: Claude
  Code's mouse reporting (pane 2 differs before the resize and matches after the nudge: Claude
  Code sets it again when it redraws), and application cursor keys, the application keypad,
  insert, origin, reverse wraparound and synchronized output (off throughout) and wraparound (on).
  Under the test machine's own ConPTY (Windows 11 build 22621), which passes no alternate screen
  through, the screen in use reads KEPT (pane 1 never leaves the normal screen) and Codex's focus
  reporting reads KEPT (pane 1 never had it); bracketed paste and Codex's mouse reporting are LOST
  there too, and so is Claude Code's focus reporting. Already equal before any resize: Claude
  Code's screen at its first screen (the theme picker, on the normal screen); the KEPT modes at
  most states.
- **What it means (fixed before measuring).** The screen in use and bracketed paste (both CLIs)
  and mouse reporting (Codex) are LOST and acted on by the app's terminal: they are restored from
  the holder's screen in the step that first shows an agent session again from the middle (S16's
  second half), carried by A3's `screen.read`. Focus reporting is LOST too and is not in A3's
  list of modes: that step decides. More than the screen is restored. Nothing changes in A1.
- **Result, Codex 0.170.0.** REPAINTS on every system: GitHub's Linux, macOS and Windows (both
  ConPTYs) and the test machine (both ConPTYs), 3 of 3 runs at every state; a same-size resize is
  enough only on the ConPTY built into Windows. Claude Code 2.1.328 and Codex 0.157.1 read
  REPAINTS again everywhere.
- **Result, the console host.** On the ConPTY built into Windows it STAYS: the pseudo console's
  own conhost.exe was there at 1, 2, 5, 10, 30 and 60 s after the exit in every run but the one
  node-pty killed, node-pty's kill having run right after the exit, as the app's does (21 of 22
  runs in each dispatch on the runner; 22 of 23 and 13 of 14 on the test machine, where Codex
  0.157.1 with its background server ended by itself with code 1 and its host stayed too). The
  one run without is the only one node-pty killed (Codex does not quit on two Ctrl+C while a turn
  runs); it had none at 1 s. The probe stopped each host after the 60 s reading, its name and
  start time checked. On the bundled ConPTY it ENDS BY ITSELF: no OpenConsole.exe left at any
  time; one Codex 0.170.0 run had a conhost.exe under another process at 1 s (2 s on the
  runner), gone by 5 s. The counts go on a ticket for beta.13's bug track, filed by the
  orchestrator (the app's kill is in pty-manager.ts, a radius file at its line cap).
- **Result, Codex with its background server** (the test machine, elevated, in session 0 as an
  SSH session is, started detached from it). Codex 0.157.1 FAILS on both ConPTYs: it printed
  "Error: start the Windows daemon from a non-elevated terminal; shared clients must not inherit
  administrator privileges" and "To work without the background server, rerun the same command
  with --no-daemon", and ended with code 1 before its composer. Codex 0.170.0 RUNS A TURN on
  both, leaves no server process behind, and shows a warning count on its hint row (1 at ready,
  2 after the reply; the normal rows show none). The 0.157.1 failure goes on a ticket for
  beta.13: what a Codex tab does when the app itself runs elevated.
- **Result, the hint rows** (every system). Codex 0.157.1: the queue hint (`tab to queue
  message`), the rebound key (`f6 for shortcuts`) and a warning count at the right of the hint
  row (`<warning sign> 1 warning . f2 to view`) are RECORDED; the agents form is NOT REACHED
  (waited 60 s; the screen showed the ready composer with `? for shortcuts`: 0.157.1 does not
  draw it). Codex 0.170.0: all four RECORDED; its default ready row is `<left arrow> for agents .
  ? for shortcuts` (`bottom_pane/footer.rs`, `left_side_line`, set by
  `chat_composer/agents_navigation.rs` for the normal start, read at the rust-v0.170.0 tag), so
  every 0.170.0 composer screen recorded has a hint row other than the exact `? for shortcuts`
  #740's reader accepts.
- **Runs.** The probe jobs ended green on ca7aa8c5 (runs 44636688885 for Codex 0.157.1 and
  44636706580 for 0.170.0); the earlier heads' dispatches (ca51952b, d491287e, 64de0d29) gave the
  same mode, rows and console host verdicts. The test machine held 23:38Z to 00:12Z under the VM
  lock; both readings ended with their clean-up complete, nothing of theirs left running, the
  Codex 0.170.0 prefix removed with the work folder, and the profile's own Claude Code and Codex
  folders show the same item counts and newest writes before and after.
- **Beside it, not this change.** The same 0.170.0 dispatches ran the Codex conformance job's rc
  leg, which failed on all three systems in its model-list case: Codex 0.170.0 lists four models
  the model registry does not hold (gpt-6.2-sol, gpt-6.2-astra, gpt-6.1-terra, gpt-6.1-sol);
  beta's registry lacks them too. Nothing here changes it.
- **WP1 legacy Codex gate.** The recorder's test now names Codex; the ledger has an `added` row for
  it and the manifest is regenerated.
