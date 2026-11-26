## 2026-11-26 -- fix(codex): the reader takes the footer Codex 0.170.0 and 0.172.0 wrap onto two rows (#436)

Plan 2.1.3-beta.19, section 4 (aicc_planning #436, the last part of #357). Once a prompt is sent,
Codex 0.170.0 and 0.172.0 add the thread's title to the footer ("<model> <effort> . <folder> .
<title>"); where that does not fit across the pane, Codex wraps it at a word onto a second row at the
footer's indent. The reader refused every such screen, so the app typed nothing into that Codex.

- **The recordings (4.1.1).** Beta.18 section 7.4's hold had recorded the wrap after P19's short
  prompt on both Windows ConPTYs (its tseq launch, run 1) and kept it outside the repo; those copies
  were used (no VM time). They join the corpus as codex172-windows-bundled-wrapped-after-reply and
  codex172-windows-system-wrapped-after-reply (state wrapped-after-reply: the hold named them
  after-reply, a name the corpus already gives that hold's long-prompt launch); only their state
  field, last mark and one source sentence differ from the hold's files. 24,534 and 17,364 bytes;
  the corpus is 3,114,555 bytes of 69 recordings, 31,173 under its 3 MiB cap, which was not raised.
- **The rule (4.1.2).** Codex's TUI at rust-v0.170.0 and rust-v0.172.0 wraps the footer
  (bottom_pane/status_line.rs, wrap_rows) to the width of its area less the two cells
  inset_footer_hint_area takes (footer.rs). The reader takes the wrap in its recorded shape only, as
  it takes the hint rows: row one the footer with the title begun after its folder, cut at the
  pane's edge (row two's first word with the space the wrap took would pass the last cell), row two
  the rest of the title at the footer's indent, neither with two spaces in a row, and row two none
  of Codex's own rows (a footer of any model, a hint row, the warning row, a popup row). The state,
  draft and height readers and all three confirm readers (command, text, paste placeholder) take
  the same shape, so composer-submit confirms and presses Enter, or takes its text back. No footer
  row is handed out for a wrapped footer, so Plan mode is not read from it (null, as before).
  Still refused (not recorded): three rows or more, a wrap inside the folder or at its separator,
  two spaces in a row, a row of unknown width.
- **Known misreads (4.1.3).** The five codex170 names leave the #357 group: four read their state;
  codex170-macos-mid-reply now reads ready and is listed on #370 beside Codex 0.157.1's macOS
  mid-reply (on macOS nothing says a reply streams). Tests: codex-screen-wrapped-footer.test.ts
  (new, the recorded screens and the refusals), screen-corpus.test.ts, codex-screen-hint-rows.test.ts,
  session-helper-replay-queries.test.ts (55 of 69 recordings hold queries).
- **Review round.** A different model found three refusals of the confirm readers unpinned: a hint
  row taken as a footer's second row, the wrapped pair taken away from the last rows, and a hint row
  dropped under the wrapped footer. The reader was right on all three; two tests now pin them, each
  red under its mutant (an Enter pressed over a turn that runs, or over a popup). Row two's first
  word is counted in code points, not cells: a first word of wide characters counts short, so that
  wrap can stay refused (the safe side).
- **Not measured.** Codex 0.172.0 on macOS and Linux, Codex 0.170.0 on Linux (its footer did not
  wrap there after the same prompt), a footer on three rows or more. The tested-version raise
  (4.1.4) is the aggregate's, after its conformance run.
