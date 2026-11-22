## 2026-11-22 -- A held terminal's replay is counted with the cursor's row followed at the holder's size

Plan 2.1.3-beta.13, section A2 (aicc_planning#374, P2.1), on top of A1. The replay-tail Reader
counted every line feed and wrap as a new row. A Windows console writes a wrapped line with a
jump back to the row above, so a line the tab shows in 3 rows counted 5, and a restored tab was
shown about 6,000 rows of a replay where about 10,000 fit.

- **The count** (session-helper/replay-tail.ts). Given the tab's rows, the Reader keeps how far
  the cursor is above the screen's last row (0 to the rows less one, never more than it really
  is). A line feed or wrap adds a row only at the last row. CSI A and F and ESC M raise it, CSI B,
  E and e lower it, CSI H, f and d set it, a cursor saved and restored carries it per screen, a
  full reset puts it at the top. A scroll region that is not the whole screen counts as before,
  per screen. The 8-bit reverse index is not followed (xterm.js 6.0.0 ignores it). Without the
  rows, the count is as before. A CSI sub-parameter (after a colon) now belongs to the parameter
  before it, as in xterm.js, since the scroll region reads the second parameter.
- **Where the cut lands.** A line feed that adds a row and is followed by a cursor moved up before
  anything is printed starts no line: the console went back to the line above. Without this rule a
  cut one row off a line's start left a row of spaces and a lone character under the notice, and
  the log counted each of a console line's three line breaks as a line.
- **The helper** (helper-pty.ts `showHeld`). Rows are passed only when A1's size wait saw the tab
  reach the holder's size, the tab's size has not changed since, and nothing was shown before.
  What is shown then starts on the tab's last row, where the count has the console's cursor, so
  the console's jumps land where they did; the rows less one come off the budget for the empty
  rows that leaves under the notice. The log line says the cursor's row was followed. A wait the
  cap ended, a size changed since, a replay after output already shown, and a holder without the
  screen reads keep the old count, with no move to the last row.
- **Measured** (unit tests against @xterm/headless 6.0.0). The recorded console lines
  (tests/fixtures/replay/, 27 lines from the beta.12 smoke) count 3 rows a line at 27 rows, 5 at
  26, 1 at 28 and 5 with no rows, as the tab adds them. A 2 MiB replay at 103x27 keeps 3,315
  whole lines from a line's first row, the notice at row 0 through a screen of redraw and a screen
  more. Random streams (four seeds, 600 each, 36 sizes) never count fewer rows than the tab adds,
  whole or after the cut.
- **User-visible.** At the holder's size the notice is now followed by up to a screen of empty
  rows, then the output from a line's start; the known-issues line about the line after the
  notice starting part-way still holds when the size wait's cap ends it, or a single line is
  longer than the tab keeps.
