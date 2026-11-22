## 2026-11-22 -- screen.read answers the screen's title (2.1.3-beta.14 B1)

aicc_planning#384. The Codex screen reader takes the window title as a busy
sign (2.1.3-beta.13 B2), and the holder's `screen.read` answered rows but no
title, so moving that reader onto the holder's screen would have lost it.

- **The crate keeps no title.** `vt100` 0.18.1 hands each OSC string to its
  `Callbacks` (`set_window_title` for exactly `0` or `2` and one part,
  `unhandled_osc` for the rest) and keeps nothing itself. The holder's screen
  keeps the title in its own callbacks: OSC 0 or 2, everything after the
  first `;` as xterm.js keeps it (a title with a `;` comes in more parts and
  is joined again), control characters dropped, bounded by the parser's 1 KiB
  OSC buffer and its 16 parts, and by `TITLE_MAX` (1024 characters).
- **A new capability, `title`,** offered after `screen` and counting only
  beside it, as `away` counts only beside `mcp`. A connection that acked both
  gets `title` in `screen.rows`; any other, and every connection to an older
  holder, gets `screen.rows` as before. The app reads it strictly
  (`readScreenRows(m, size, title)`): absent reads null, and a title that is
  not text, holds a control character or is over 1024 characters is refused.
  Nothing in the app asks for it yet (dormant until the Codex reader moves).
- **The corpus commits each recording's last title.** Each rows file in
  helper/fixtures/screens gained `"title"` (xterm.js 6.0.0's title after the
  last chunk, null for none); helper/tests/screen.rs holds the holder's screen
  to it for every recording. Of the 61 recordings, 54 end with a title and 7
  with none; no recorded title has a `;` or a control character.
- Docs: docs/remote/helper-protocol.md (caps line, the table row, a "title"
  bullet under screen reads), helper/README.md (the Screen row) and the
  threat model's screen entry.
