## 2026-11-19 -- The screen corpus: real recordings of both CLIs on three systems, and the rows xterm.js gives for each

Plan 2.1.3-beta.11, section A2 (aicc_planning #341). Tests and fixtures only; no product code.

- **What was built.** `helper/fixtures/screens/` holds 28 recordings taken from probe P19's runs
  (run 1 of each): Claude Code 2.1.328, Codex 0.157.1 and the system's default shell, at 120 by
  40, on the Windows test machine under node-pty's bundled ConPTY and under the one built into
  Windows, on a GitHub macOS runner and on a GitHub Linux runner (CI run 44533910780). One file
  per program, system and state, `<program>-<system>-<state>.json`, each from the session's
  first byte to the end of that state's own measurement (its same-size resize and its nudge,
  one row shorter and back), so every recording carries resize marks. Beside each,
  `<name>.rows.json`: what @xterm/headless 6.0.0 shows when fed the chunks through main's CSI
  clamp at the Watchdog pane's settings, after each resize mark and after the last chunk (the
  rows as `readXtermScreen` returns them), and the last 200 lines as text.
  `tests/unit/shared/screen-corpus.test.ts` writes the rows files when `SCREEN_CORPUS_WRITE=1`
  is set and compares them otherwise; there is no other script. Recordings 1.17 MB in all, the
  largest 190 KB; the folder 2.1 MB with the rows files.
- **Decisions made while building it.**
  - A chunk is kept as the text node-pty hands the app. On Windows each chunk was already a
    whole UTF-8 string. On macOS and Linux the bytes as read were decoded with a streaming
    decoder, as node-pty's own decoder does, so a character split across two reads joins the
    second. The decode was checked lossless for every recording: the UTF-8 of the chunks joined
    is the recorded bytes, byte for byte. Text, not base64, so a reviewer can read what is
    committed; the holder's tests (A3) feed the same bytes.
  - At a resize mark the pane is resized, as the Watchdog's pane and the holder's screen are when
    the session is. The probe kept its panes at 120 by 40; the recordings hold the same bytes
    either way.
  - Both Windows ConPTYs are in, for both CLIs: the app starts Codex sessions on the bundled one
    and Claude Code sessions and plain terminals on the system one (pty-manager.ts), and the
    helper loads the bundled conpty.dll (helper/Cargo.toml).
- **A finding: Codex's reader misreads Codex 0.157.1's ready screen, on every system.** At its
  ready composer Codex 0.157.1 draws "? for shortcuts" on the last row, under the footer row
  ("<model> <effort> . <folder>"). `readCodexScreen` takes a footer that is not the last row as
  `unrecognised`, so the app would type nothing into it. The four `codex-*-ready` recordings are
  listed in the test as known misreads; the reader is fixed in beta 12. It is not a regression:
  `src/shared/codex-screen.ts` has not changed since 2.1.1-beta.3, and the app's newest tested
  Codex is 0.156.1. Not known: whether a signed-in Codex with a real model draws the row too.
- **Readers that read right.** Claude Code: no prompt at its first screen (the theme picker,
  drawn where the prompt box would be), ready at its prompt, busy in the middle of the reply,
  ready after it. Codex: blocked at its first screen (its sign-in choice). The shell: no prompt
  for both readers.
- **Beside it.** Both CLIs draw on the alternate screen, which keeps no scrollback, so the
  Watchdog's tail of a Claude Code or Codex session is its 40 rows and no more; only the shell
  recordings fill the 200 lines.
- **What the corpus lacks, and why.**
  - Codex in the middle of its reply and after it, on every system: over 256 KiB. Codex writes
    21 to 44 KiB a second for as long as a turn runs (its own redraws), so P19's 36-second reply
    gave 434 KB to 877 KB of output by the end of the mid-reply measurement and 0.9 MB to 1.7 MB
    by the end of the after-reply one. After the reply needs a turn of a few seconds (a reply that
    streams faster). In the middle of the reply, the measurement alone keeps Codex streaming for
    6.5 s, which is over 256 KiB on Linux by itself: it needs a shorter measurement there, or a
    cap of its own. Either is a change to probe P19's scenario and a new run, for beta 12.
  - Any version but Claude Code 2.1.328 and Codex 0.157.1: the app's pinned Codex (0.155.1) and
    its tested range (0.153.4 to 0.156.1) were not recorded.
  - A signed-in account's screens: none was recorded, by rule (the probe used a stand-in model).
  - GitHub's windows-2025 runner: its readings exist (the same run), but the corpus keeps one
    Windows machine, the test machine (Windows 11, build 22621), as the users' kind of Windows.
  - Other screens and sizes: a question before a command or an edit, the folder-trust question,
    a narrow or a resized-for-good pane, a session over SSH or under tmux. P19's scenario has
    none of them.
- **Shown able to fail** (local runs on this branch, each restored after): one cell changed in
  `claude-macos-ready.rows.json` failed case 1 for that recording only; `claude-linux-ready`
  renamed to `claude-linux-mid-reply` failed case 2 for it (it reads ready, its name says busy),
  and case 3's inventory and structure checks; one `C:\Users\User` in a chunk of
  `shell-windows-bundled-after-output.json` turned to another name failed case 4 for that
  recording only. The test also runs the check functions of cases 1, 2 and 4 on planted
  inputs, so those three are shown able to fail in every run.
- **WP1 legacy Codex gate.** The recordings and the test name Codex, so the manifest and the
  ledger are regenerated with `added` rows for them.
