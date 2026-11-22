## 2026-11-22 -- A restored held terminal lines up with its console

Plan 2.1.3-beta.13, section A4 (aicc_planning#382), on top of A2. A1's VM line showed two faults
in every restore of a plain terminal on Windows, both already in beta.12's evidence. A read-only
probe settled both causes from recorded bytes and @xterm/headless runs.

- **A row lost, and the typed command a row low.** beta.12's redraw makes the console one row
  shorter and, 300 ms later, back. The console built into Windows, its prompt on the last row,
  drops its top row and moves the rest up; its repaints are addressed from the top-left, so they
  paint over the tab's top row, which never reached the scrollback, and back at full height it
  adds an empty row at the bottom. The shell still holds the old last row for its prompt, so
  its line editor draws the next command one row under the prompt. Fix (helper-pty.ts
  `redrawOnce`, manager.ts `redrawFor`): on that console the redraw is one resize at the tab's
  own size (probe P19: enough there at every state, since it draws its whole screen again on
  any resize). node-pty's bundled ConPTY, macOS and Linux keep one row shorter and back.
- **The first kept line torn.** The console writes by absolute rows of its own screen, with its
  cursor on the last row; the replay was started on the tab's second row, so the console's first
  jump to "the row above" landed 23 rows down. A2 already starts the kept text on the last row
  when the tab is at the holder's size, which left up to 25 empty rows under the notice. Fix
  (helper-pty.ts `showHeld`): the notice goes on the row above the last, the kept text on the
  last, and the scrollback is cleared (CSI 3 J) at the start of a row a line feed made, at most
  that many rows into the kept text, so the empty rows above the notice go once they have left
  the screen. The notice is then the tab's first row and the first kept line its second; the
  budget no longer loses those rows (3,323 console lines kept of a 2 MiB replay, was 3,315).
  Outside A2's case (the size wait's cap, output shown before, no screen reads) and on a tab too
  short for the notice and a row: byte for byte as A2.
- **Where the clear may go (replay-tail.ts `clearAfter`).** The probe's prototype took the
  newest line-feed row start within reach. A random-stream check showed that is not enough: a
  kept text that puts its cursor above its own start row (an absolute move, a scroll region),
  moves the screen (CSI S, T), fills it or resets it can leave output in the rows the clear
  drops; and xterm.js keeps a saved cursor row counted from the scrollback's top, so a clear
  between a save and a restore moves the cursor down. So the kept text is read again from the
  cut as a new tab reads it, and the clear goes at the newest line-feed row start before the
  first of those. With none in reach the empty rows stay above the notice, never under it.
- **A program that is over** now gets the same size wait as one still running: its exit waits
  for its replay to be shown, at most the size wait's cap, and its holder is sent no size.
- **Log.** The size wait's lines name the tab's id and the size the tab started at.
- **Measured** (unit tests, @xterm/headless 6.0.0). The recorded redraw (A1's VM line) and the
  recorded typed command (beta.12's smoke) are fixtures; replayed, the first loses line 9992's
  middle row and the second draws the command after 40 spaces under the prompt. End to end
  through HelperPty with a console modelled on those bytes: with the same-size redraw every kept
  line is whole and the command is on the prompt's row; with the nudge the model fails as
  recorded. On A2's random streams (four seeds, 36 sizes) the tab's rows from the notice on are
  the same with the clear and without.
- **Supersedes** the line of 2026-11-22-replay-row-count-follows-cursor.md that says the notice
  is followed by up to a screen of empty rows at the holder's size: there are none now, unless
  the kept text moves its cursor above its own start within its first screen.
