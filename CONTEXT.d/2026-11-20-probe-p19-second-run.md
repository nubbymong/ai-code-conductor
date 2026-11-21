## 2026-11-20 -- Probe P19, second run: the modes a mid-stream re-attach loses, Codex 0.170.0, the console host, and Codex's hint rows

Plan 2.1.3-beta.12, section A2, steps 1 and 2 (aicc_planning #353). No product code. Step 1 is
the probe and its runs; step 2 (the recordings into helper/fixtures/screens, screen-corpus.test.ts
and the ADR-030 "P19, second run" paragraph) was built on beta once beta.11's A2 and #740 were
on it, with step 1's commits picked onto it in order.

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
  runner), gone by 5 s. The counts are on aicc_planning#363, for beta.13's bug track (the app's
  kill is in pty-manager.ts, a radius file at its line cap).
- **Result, Codex with its background server** (the test machine, elevated, in session 0 as an
  SSH session is, started detached from it). Codex 0.157.1 FAILS on both ConPTYs: it printed
  "Error: start the Windows daemon from a non-elevated terminal; shared clients must not inherit
  administrator privileges" and "To work without the background server, rerun the same command
  with --no-daemon", and ended with code 1 before its composer. Codex 0.170.0 RUNS A TURN on
  both, leaves no server process behind, and shows a warning count on its hint row (1 at ready,
  2 after the reply; the `--no-daemon` rows show none at ready and 1 from the first prompt on,
  as step 2's recordings show). The 0.157.1 failure is aicc_planning#364, for beta.13: what a
  Codex tab does when the app itself runs elevated.
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
- **Step 2, the recordings.** 33 recordings join `helper/fixtures/screens/` (61 in all; recordings
  2,972,596 bytes of the 3 MiB cap, the largest 205,931 bytes; none cut, no cap raised), each
  with its rows file written by `screen-corpus.test.ts` with `SCREEN_CORPUS_WRITE=1`. The
  28 files already there keep their names and bytes. The plan's order of keeping chose them:
  Codex 0.170.0's ready, mid-reply and after-reply on all four systems (12); each hint row
  reached, of both versions, on the bundled ConPTY (the one the app gives Codex) and macOS (14);
  then Codex 0.157.1's mid-reply and after-reply on as many systems as fit: the bundled and
  system ConPTYs and macOS, and Linux's mid-reply (7). Left out and listed in the test: Linux's
  0.157.1 after-reply (243,915 bytes; 173,132 were left), the hint rows on the system ConPTY and
  Linux, 0.170.0's first screen (not in the order; its sign-in choice, as 0.157.1's) and
  0.157.1's agents form (not reached). Ready comes from the long turn's launch, mid-reply and
  after-reply from the short turn's (the long turn's are 0.7 to 2.7 MiB). The Windows ones are
  the test machine's, the others GitHub's runners' (dispatches 44636688885 and 44636706580).
  Each is run 1 up to its state's `mark-end` line, decoded and recounted as beta.11's were
  (the rule is in the probes' README); checked first on beta.11's own Linux run, where it
  wrote `codex-linux-ready.json` and `claude-linux-ready.json` byte for byte.
- **Step 2, the test.** `screen-corpus.test.ts` gains the program `codex170` (Codex 0.170.0),
  a version each program's recordings must have (`codex` is 0.157.1), the four hint states
  (the queue hint reads busy, the other three ready with an empty prompt), and LEFT_OUT rows
  that can name systems. A planted case each shows the version check and the LEFT_OUT rows
  can fail.
- **Step 2, the finding: Codex's reader reads every new recording unrecognised** (all 33, both
  versions, every system). It takes one row under the footer, exactly `? for shortcuts`; each of
  these ends in another: 0.170.0's `<left arrow> for agents . ? for shortcuts`, the same with
  `<warning sign> 1 warning . f2 to view` at its right, `<left arrow> for agents . f6 for
  shortcuts`, the queue hint `tab to queue message`, 0.157.1's `f6 for shortcuts`, and 0.157.1's
  `? for shortcuts` with the warning at its right. From the first prompt sent on, both versions
  draw that warning in every launch (with the stand-in model; what it warns of was not read), so
  no Codex 0.157.1 screen after a prompt reads ready or busy either, though #740's fix reads its
  ready screen. Codex 0.170.0 adds the thread's title to its footer once a prompt is sent, and
  the footer then wraps to two rows when its working folder and title do not fit in the 120
  columns (on macOS and Windows in these runs, whose temporary folders are longer than Linux's).
  And no mid-reply or queue-hint screen
  holds an `esc to interrupt` row, the reader's only sign of busy (codex-screen.ts `BUSY_RE`):
  Codex drew `Working (0s . esc to interrupt)` once, right after Enter, and it was gone while
  the reply streamed, in both versions' turns, long and short. So taking the last row alone would
  read those screens ready. Each of the 33 is a known misread in the test, with
  aicc_planning#357 and the answer `unrecognised`; C3 fixes the reader.
- **Shown able to fail** (local runs on this branch, one planted change at a time, each
  restored): the test as changed, run on beta's corpus before the recordings, failed its
  inventory (the 33 names missing) and the version case (no 0.170.0 recording); one cell
  changed in `codex170-macos-ready.rows.json` failed case 1 for that recording only;
  `codex170-linux-ready` renamed to `codex170-linux-first-screen` failed case 2 for it (it reads
  unrecognised, its name says blocked), case 3's inventory, its structure and its known misread
  (no such recording); `C:\Users\User` in a chunk of `codex170-windows-system-ready.json` turned
  to another name failed case 4 for that recording, and its structure check (the name is 3
  bytes longer, so the offsets after it no longer add up).
- **Picked onto beta.** Step 1's commits went onto origin/beta bf572ee7 in order. One conflict:
  the WP1 ledger's and manifest's header fields (both sides regenerated them); both were
  regenerated on beta's tree, keeping beta's rows and step 1's `added` row. ci.yml and the
  probes' README merged by themselves (beta's newer lines kept, step 1's added).
- **Beside it, not this change.** The same 0.170.0 dispatches ran the Codex conformance job's rc
  leg, which failed on all three systems in its model-list case: Codex 0.170.0 lists four models
  the model registry does not hold (gpt-6.2-sol, gpt-6.2-astra, gpt-6.1-terra, gpt-6.1-sol);
  beta's registry lacks them too. Nothing here changes it.
- **WP1 legacy Codex gate.** The recorder's test now names Codex; the ledger has an `added` row for
  it and the manifest is regenerated. The 33 recordings and their rows files name Codex too, so
  each has an `added` row.
