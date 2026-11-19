## 2026-11-19 -- S13: three ways a session's screen can have one owner, with numbers

Section B3 of the 2.1.3-beta.10 plan (aicc_planning #339). A record so beta.11
can plan ADR-030 slice S13 (one screen) from facts. Nothing is built, and
ADR-030 is unchanged: which way S13 goes is the owner's choice (the plan's
Question 3). Code read at beta 32fb8b36; helper facts that depend on the relay
PR are marked (#733), read at its head e1b6f240.

**What the readers need.**
- `readXtermScreen` (src/shared/codex-screen.ts:55) returns, for each of the
  `rows` rows below the scrollback of the active buffer, a `ScreenLine` (:25):
  `text`, `typed` (each dim cell a space), `inverse` (each cell that is not
  inverse a space), `width` and `end` (the cell after the last non-blank one).
  It skips the second half of a wide character. So a screen owner keeps, per
  cell: the character, its width, dim and inverse. No colour, no bold.
- `readClaudeScreen` (src/shared/claude-screen.ts:204) uses `text`, `typed` and
  `inverse`: the prompt box, the dim pointer while a turn runs, and the one
  inverse cursor cell over a dim placeholder. `readCodexScreen`
  (codex-screen.ts:203) uses `text` and `typed`, and `codexPlanModeOnScreen`
  compares `end` with `width` (:310).
- The Watchdog reads more: the last 200 lines, screen and scrolled-off lines,
  with a dim-blanked copy (`readPanePair`, src/main/watchdog/watchdog-manager.ts:315;
  200 lines of scrollback, :46). So the owner also keeps 200 lines of scrollback.
- Widths: the renderer and main both run xterm.js 6.0.0 with its default
  Unicode 6 width table; no Unicode 11 addon is loaded anywhere in src/.
  Checked: U+1F600 is one cell wide there. Current Unicode, as in the
  `unicode-width` crate, makes it two.

**Which sequences the screen fixtures use.**
- One recording of a real CLI's bytes is in the repo:
  tests/fixtures/codex/tui-trace.txt, 699 bytes of Codex's trust screen as
  ConPTY draws it on Windows. It uses 11 kinds of sequence plus CR and LF: CUP
  (CSI row;col H), CUF (CSI n C, used for spaces), EL (CSI K), ED (CSI 2J), SGR
  (0, 1, 2, 22, 38;5;n), cursor show and hide (CSI ?25 h and l), the modes ?1004
  (focus), ?2004 (bracketed paste), ?2026 (synchronized output) and ?9001
  (win32 input), and OSC 0 (title).
- The Claude Code screens (tests/unit/shared/claude-screens.ts), the Codex
  slash-popup captures (tests/fixtures/codex/cli/*/tui-slash-popup.txt) and the
  mode-matrix screens are rendered rows, not bytes. They test the readers; they
  cannot test a parser.
- Unit tests add made-up bytes: REP (CSI n b, for the parameter clamp), CHA
  (CSI G), SGR 7, 27 and 31, and OSC 8 (watchdog-manager.test.ts,
  codex-session-screen.test.ts).
- Not recorded at all: Claude Code's raw output; either CLI on macOS or Linux,
  where nothing redraws it on the way; either CLI through tmux or ssh. Known
  from code only: on macOS and Linux Codex also sends a cursor position, a
  keyboard and a device attributes query at start (terminal-query-responder.ts:28-35).

**Who reads a screen today.** ADR-030 counts 2 headless terminals in main and
up to 3 readers of one session's screen:
1. The Watchdog: one headless xterm per watched session
   (watchdog-manager.ts:581), with 200 lines of scrollback. It is made when the
   Watchdog starts for that session, so one turned on mid-session sees only
   what came after. Off by default.
2. The Codex pane: one headless xterm per local Codex session, from its first
   byte, with no scrollback (src/main/providers/codex/session-screen.ts:66). The
   composer rule and canvas notes into Codex read it.
3. The renderer's own xterm, through its screen registry: the status strip's
   controls (src/renderer/lib/claudePrompt.ts, codexComposer.ts) and canvas
   notes into Claude Code, which main asks the renderer to read and type
   (src/main/canvas/claude-marker-typing.ts:7-8, over canvas:claudeMarkerAsk and
   canvas:claudeMarkerAnswer). With no window, the ask reports false
   (src/main/ipc/canvas-handlers.ts:1494-1496): the note is held up to 120 s,
   then reported not sent.
A local Codex session with the Watchdog on is parsed three times.

Measured on this PC (Node 24.18, @xterm/headless 6.0.0, outside Electron, one
run): one full 120x40 pane holds about 148 KiB of heap with no scrollback and
210 KiB with 200 lines. It parses 32 MiB/s (the ConPTY trace, repeated) to
136 MiB/s (an Ink-style 942-byte spinner frame, repeated). So a session
writing 100 KiB/s costs main about 1 to 3 ms a second per pane, and replaying
a full 2 MiB output ring (helper/src/ring.rs:10) costs 15 to 65 ms.

**Way 1: an emulator crate in the holder.** The supply chain rule is under 25
packages in helper/Cargo.lock. It holds 12 today, and the relay PR changes
neither Cargo.toml nor Cargo.lock (#733).

| Crate (published) | Adds | Lock total | Notes |
|---|---|---|---|
| avt 0.21.0 (2026-11-17) | 2 | 14 | asciinema's emulator: faint (dim) and inverse per cell, scrollback, a state dump. Three breaking releases in three weeks (0.19.0 on 2026-10-27, 0.20.0 on 2026-11-04, 0.21.0) |
| vt100 0.18.1 (2026-10-19) | 6 | 18 | dim, inverse and wide flags per cell, scrollback, `state_formatted` (a repaint of the screen); about 20.7 million downloads |
| vte 0.15.0 (2025-02-02), parser only | 3 | 15 | gives the sequences, the grid is ours: way 2 with a crate parser |
| libghostty-vt 0.2.2 | 9 | 21 | its -sys crate fetches Ghostty's sources and builds them with Zig at build time (its README): not crates.io only, not an offline locked build. Out, whatever its count |
| alacritty_terminal 0.26.0 | 45 | 57 | also wants windows-sys 0.61 beside the helper's 0.59, and libc 0.2.182 or later (the pin is 0.2.172) |
| ghostty-vt 0.9.0 | 103 | 115 | |
| termwiz 0.23.3 | 104 | 116 | wezterm-term itself is not on crates.io |

The trees counted for the two that fit:

```
vt100 0.18.1 (default features: std)
  itoa 1.0.19
  unicode-width 0.2.3 (default: cjk)
  vte 0.15.0 (no default features; std from vt100's std)
    arrayvec 0.7.8 (no default features)
    memchr 2.8.3 (std, from vte's std)
avt 0.21.0 (no features)
  unicode-width 0.2.3 (default: cjk)
```

Method: the crates.io sparse index, read on 2026-11-19 with a scratch script
that is not committed. For each requirement, the newest version that matches.
Normal and build dependencies on every target are followed, since Cargo.lock
is the same on every system; dev dependencies are not. Each crate's default
features are expanded through its feature table. A helper package counts as
already there when its version matches. The large trees are approximate
(cargo may unify a version differently); the small ones have no version to
choose. Source to review under the exact-pin rule (crates.io line counts):
38,730 lines of Rust for vt100's tree and 35,603 for avt's; 22,708 of each are
`unicode-width`, mostly generated tables.

Costs: that review; and a second emulator beside the one the user sees, so the
readers can drift from what is drawn. Both crates use current Unicode widths,
so a row holding U+1F600 ends one cell later than xterm.js draws it, which is
what `codexPlanModeOnScreen` compares. The CSI parameter clamp
(watchdog-manager.ts:129) must be ported to Rust, or shown not needed for the
crate. Protocol change 5 (`screen.read`, `screen.tail`) is named in ADR-030 but
not yet written in helper-protocol.md. An ADR-009 pass: a new runtime crate
parsing session output in a long-lived process (threat model 3.10). And the
recorded corpus described under way 2, to show the readers read the holder's
screen as they read xterm's.
Deletes, and when: main's two panes for local sessions at the local deletion
(S21), for remote ones at the remote deletion (S32), and @xterm/headless
leaves main then. These are ADR-030's targets as written (2, then 1, then 0;
readers 3 to 1 at each half's cutover).

**Way 2: a small parser of our own in the holder.** No package; the lock
stays at 12. helper/src/json.rs (477 lines), written in place of a JSON
crate, is the precedent. An estimate, not a
measurement:
- the parser (ground, escape, CSI, OSC and DCS strings bounded and dropped,
  UTF-8): about 250 lines;
- the grid, the cursor and the operations, about 600 lines: CUP, CUU, CUD,
  CUF, CUB, CHA, VPA, ED, EL, ECH, ICH, DCH, IL, DL, SU, SD, DECSTBM, IND, RI,
  NEL, CR, LF, BS, TAB, save and restore cursor, REP with the clamp, autowrap
  with xterm's pending-wrap rule, the alternate screen (?1049, ?1047, ?47),
  SGR 1, 2, 7, 22 and 27 kept and colours parsed and dropped, 200 lines of
  scrollback, resize;
- xterm.js's Unicode 6 width table, copied (MIT), so widths match what the
  user sees: about 150 lines of ranges;
- the row producer (text, typed, inverse, width, end): about 60 lines;
- protocol change 5 in serve.rs: about 150 lines, plus its section in
  helper-protocol.md.
About 1,200 lines in all, against 12,344 lines in the 27 Rust files of
helper/src on beta.
Tested by a check in CI that compares it with xterm: a Node script feeds each
recorded stream to @xterm/headless 6.0.0 in its recorded chunks and writes the
rows `readXtermScreen` returns as JSON; a helper test feeds the same chunks to
the holder's screen and compares every row, at two sizes. Bound tests beside
it: a huge CSI parameter, a 16 MiB OSC. The corpus does not exist: there is one
699-byte trace. It needs the helper's ring recorded from signed-in Claude Code
and Codex sessions (ready, busy, a question, a picker, a paste) on Windows and
on Linux or macOS. A ready prompt needs a sign-in, so recording it is an owner
step, or needs a token as P12 had.
Costs: we own a terminal emulator. A CLI release that starts using a sequence
we skip (the alternate screen, or scroll regions on macOS and Linux) reads
wrong until we add it, and only a recording shows it. An ADR-009 pass for
protocol change 5.
Deletes, and when: as way 1.

**Way 3: the screen stays in main.** One provider-neutral module, one
headless pane per agent session, fed from the session's first byte where the
two panes are fed today (pty-manager.ts:5317, :6294, :7260, resize :7739;
providers/codex/index.ts:130-134), with the clamp and 200 lines of scrollback.
On the helper path the session client feeds it from the holder's output
frames, and rebuilds it from the replay on attach. No helper change, no
protocol change 5, no package. It is the same parser and width table as the
user's terminal, so no reader can drift from what is drawn.
- Cost: about 150 to 210 KiB per agent session, Claude Code sessions with the
  Watchdog off included (they have no pane today); main parses every agent
  session's output, at the rates above.
- A replay that starts mid-stream (the ring wrapped while the app was away)
  loses the modes set before the ring's start, and the pane can read wrong
  until the CLI repaints. ConPTY repaints the screen on a changed-size resize
  (about 2.6 KB, watchdog-manager.ts:186-187), so one resize may fix it on
  Windows; on macOS and Linux it depends on each CLI's redraw on a resize. Not
  measured. The user's own terminal is rebuilt from the same replay under all
  three ways, so that repaint is needed whichever way is chosen.
- A note typed with no window: main reads the pane itself, so a canvas note
  into Claude Code is typed as one into Codex is today, without the renderer.
  No window means the renderer reloading or crashed, or the window not back
  yet after a restart while main has re-attached; on macOS, closing the last
  window ends the sessions (src/main/index.ts:1296-1302). While the app itself
  is away (an update), no way types anything: ADR-030 row 4 gives the holder
  no decision, so under ways 1 and 2 the holder's screen has no reader then.
- Remote sessions: main already receives every byte to draw the terminal, so
  a read stays local with no round trip (the composer rule reads again and
  again while it waits). It works on today's SSH path too, before the remote
  half. Under ways 1 and 2 each read is a request over the ssh side
  connection. The stricter check for a remote-drawn screen stays in all three
  (ADR-030 row 14).
- Deletes, and when: the two panes become one module at S13's first step (2
  kinds to 1). At its second, the renderer stops being a reader and the
  canvas:claudeMarkerAsk and canvas:claudeMarkerAnswer channels go
  (src/shared/ipc-channels.ts:533-534, src/preload/index.ts:1232-1233):
  readers 3 to 1, for local and SSH sessions alike. @xterm/headless stays in
  main for good, so ADR-030's target of 0 headless terminals in main after the
  remote deletion becomes 1.

**Recommendation: way 3.**
1. Readers of one screen reach 1 at S13's second step, for every kind of
   session, instead of at each half's cutover.
2. No reader can drift: the same parser and widths, so the reader tests and
   their screens stay valid. Ways 1 and 2 first need a corpus recorded from
   signed-in CLIs on two systems, which does not exist.
3. No crate, no protocol change and no Rust, at a measured cost of about
   150 to 210 KiB a session.
4. The holder has no use for a screen of its own: ADR-030 row 4 gives it no
   decision, and the user's terminal needs the same repaint after a replay
   anyway.
What it changes in ADR-030, for the owner to decide (Question 3): row 4's "the
one screen of record" and D1's "the screen" move to core; the parity rows for
the Watchdog, canvas markers, Codex composer submit and the status strip read
main's session screen in place of the holder's; protocol change 5 is dropped;
the SDLC target for headless terminals in main is 1 after S13 and stays 1.
Way 2 stays open behind the same module, since the readers take rows from
wherever: a holder screen can replace the pane later if D18's measurement of
main, or a slow remote link, shows the need.

**The first two sections it implies** (beta.11, if the owner picks way 3):
1. refactor(main): one session screen module (about 6 h). One headless pane
   per agent session from its first byte, with the clamp and 200 lines of
   scrollback; the Watchdog and the Codex composer rule read it; behaviour
   unchanged. Provider names come from the provider packages (no new provider
   name list). A name-level ratchet: only the module builds a headless
   Terminal. Tests: codex-session-screen.test.ts and watchdog-manager.test.ts
   on the module's API, plus one pane per session with the Watchdog on or off,
   and a Watchdog started mid-session reading the screen as it was. Net zero
   or fewer lines in pty-manager.ts. Owner-visible effect: none. ADR-009: none
   (main only).
2. feat(main): canvas notes and the status strip read main's screen (about
   8 h). claude-marker-typing.ts reads the module instead of asking the
   renderer; the two canvas channels go with their preload and handler parts;
   the strip's controls call main's submit (the S14 step that waited for S13,
   beta.10 plan); the renderer's screen registry goes if nothing else reads
   it. Readers 3 to 1. Owner-visible: a canvas note into Claude Code no longer
   depends on the window, so it needs owner test steps. ADR-009 pass owed
   before stable (IPC and preload).
Then, before S16 relies on it, a probe: after a replay that starts mid-stream,
does one resize make the pane read as one fed from the first byte, for both
CLIs on Windows (and with P8 on macOS and Linux)?
If the owner picks way 2: first the corpus and the CI comparison (CI only, no
product change), then the holder's screen, dormant, with protocol change 5
written. Way 1 the same, with vt100 pinned (avt's API moves with each minor
release).

**Proposed for ADR-030**, to add once the owner picks (it changes no decision
before then), as a paragraph after the SDLC targets table:

> S13 options (2026-11-19; CONTEXT.d/2026-11-19-s13-screen-owner-comparison.md).
> The readers need, per cell, the character, its width, dim and inverse, and
> 200 lines of scrollback. A crate in the holder: avt (14 packages with it)
> and vt100 (18) fit the limit; alacritty_terminal (57), termwiz (116) and
> ghostty-vt (115) do not, and libghostty-vt builds sources from outside
> crates.io. Our own parser: about 1,200 lines and no package. Either needs a
> recorded corpus and a check against xterm.js 6.0.0, which uses Unicode 6
> widths. In main: one pane per agent session at about 150 to 210 KiB, the
> parser the user sees, no helper change, and one headless terminal left in
> main after the remote deletion. The owner chose way N on DATE.
