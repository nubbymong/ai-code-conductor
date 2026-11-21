## 2026-11-21 -- The holder keeps the session's screen and answers two read-only screen requests (dormant)

Plan 2.1.3-beta.12, section A3 (aicc_planning#342), carried from beta.11's A3. The second half of
opening ADR-030 slice S13, after probe P19 and the screen corpus: D1 says the holder keeps the
PTY, the output and the screen, and until now it kept no screen. Nothing in the app asks for a
screen in this beta, and no connection the app makes acks `screen`.

- **The screen.** helper/src/screen.rs: the `vt100` crate's terminal (0.18.1, with the five
  packages it brings: 12 packages become 18 of the 24 CI allows), at the session's size with
  200 lines of scrollback. The holder's output thread gives each chunk to the ring and the
  attached connection first, then, with that lock let go, to the screen, for the session's
  whole life; a resize resizes the terminal, then the screen. A read is taken under the
  screen's own lock, so it never holds up an attach or the ring. A panic in the parser is
  caught: the screen is then not kept, a read says so (`io`), and the output goes on.
- **The bound.** The parse runs on the output thread, so a CSI parameter above 9999 reaches
  the parser as 9999, as main cuts it for its panes: a repeat writes at most 9999 cells, and
  no other sequence's work grows with its parameter. The cut follows the parser's own rules
  for where a CSI begins and ends, holds a parameter's digits until it ends and writes its
  value, so it is the same however the output is split. The crate is built without its
  default `std` feature, so its parser keeps an OSC string in a 1 KiB buffer instead of one
  that grows with the string; DCS, SOS, PM and APC strings are not kept at all.
- **The two reads** (capability `screen`, the sixth in the holder's hello, after B1's `away`;
  protocol change 5, written by the slice that first uses it). `screen.read` answers
  `screen.rows`: the size, the cursor, each row as the app's readers take a row of xterm.js
  (text, typed, inverse, width, end) and the modes as fixed words and yes or no values: the
  screen in use, bracketed paste, application cursor keys, application keypad, the mouse
  mode and its encoding, the cursor hidden, each from its own accessor of the crate. The
  crate keeps no focus reporting, synchronized output, keyboard protocol, wrap or insert
  mode, and gives no way to read origin mode, so none is answered. `screen.tail` answers
  `screen.lines`: the last 1 to 200 lines, scrollback included, as the Watchdog's pane gives
  a line, and the copy with dim cells blanked. Both are read-only, answered to any
  connection that acked `screen`, attached or not, never to a relay, and each is one message
  within the 1 MiB a frame to the app holds (rows that do not fit are left out from the top,
  and the answer says `cut`). The app's side: protocol.ts reads both answers strictly and
  acks `screen` when asked; connection.ts has a `screen` option no caller sets.
- **Measured** in the Helper job (helper/tests/screen.rs, `what_the_screen_costs`, the test build,
  the same on Windows, macOS and Linux for memory). Memory, counted by the test's own allocator:
  0.89 MiB for a 120 by 40 screen with its 200 lines of scrollback full, 1.04 MiB with the
  alternate screen full too; 36.66 MiB and 67.21 MiB at 1000 by 1000, the largest a launch may
  ask for. Parse rate on the corpus (28 recordings, 663,908 bytes of output), best of 3, in the
  unoptimised test build: 4.10 MB/s on Windows, 4.73 MB/s on macOS, 5.13 MB/s on Linux (run
  44853211158; run 44854718394 gave 7.21, 3.85 and 5.13 MB/s and run 44864470895, on 49af44ab,
  3.64, 4.29 and 5.56 MB/s, as runners vary). The slowest of the three runs, 3.64 MB/s, is
  about eighty times the 44 KiB a second Codex writes while a turn runs; the release build that
  ships was not timed. The Windows release helper grows by 103,424 bytes (925,696 to
  1,029,120, the helper-windows artifact of B1's head against the one of run 44864470895).
- **Widths.** The crate counts a character's cells by current Unicode, xterm.js 6.0.0 by
  Unicode 6. The corpus rows where that alone makes them differ are named in
  helper/tests/screen.rs (WIDTH_ROWS), the one "Not checked" list of the comparison.
- **Owed.** The release smoke's VM line (the signed helper answers `version` and `list`, and a
  plain terminal through the helper opens, replays and resizes as in beta.10). An ADR-009 pass
  before stable (aicc_planning #320 list): a new runtime crate that parses session output in a
  long-lived process, and two new requests.
