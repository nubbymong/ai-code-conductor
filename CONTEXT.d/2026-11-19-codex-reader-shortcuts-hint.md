## 2026-11-19 -- The Codex screen reader reads a composer with the shortcuts hint under its footer

Section C5 of the 2.1.3-beta.10 plan (aicc_planning #349; a prerequisite of
A2, which moves the Watchdog's Codex retry onto the composer rule, whose
screen reading is this reader).

**The problem.** `readCodexScreen` (`src/shared/codex-screen.ts`, `layout()`)
read a composer as ready or busy only when the footer
(`<model> <effort> . <folder>`) was the only row under it; any footer with a
row under it read `unrecognised` (round 2, WW). Codex 0.157.1 draws
`? for shortcuts` on the row under the footer, so all four of beta.11 A2's
recorded 0.157.1 ready screens (probe P19: Linux, macOS, Windows bundled and
Windows system) read `unrecognised`, and the app typed nothing into that
Codex: canvas notes and Ask Conductor (`composer-submit.ts`), the app's own
Codex commands (`codexComposer.ts`), and the Watchdog's retry, whose send gate
(`codexCanSendNow`, `codex-patterns.ts`) already reads this screen.

**Where the row comes from** (Codex's TUI source, read-only, at the
rust-v0.157.1 tag): `bottom_pane/footer.rs`, `left_side_line`, draws the key
`?` then ` for shortcuts`, only while the composer is empty (a draft hides
it), at the footer's indent. It sits under the footer only when the status
line has a row of its own (`chat_composer/status_surface.rs`), which the
fullscreen transcript gives it (`app/owned_transcript.rs`,
`chatwidget/rendering.rs`, `separate_status_line`). On that layout the hint
row's right side is left empty (except in a side conversation, whose label
Codex draws there; that row reads unrecognised), and Plan mode is drawn at the right of the
status row, where the reader already looks for it.

**Did 0.156.1 already draw it?** Not by default. The code is the same at
rust-v0.156.1, but the switch is off by default there: `tui.fullscreen_transcript`
has `#[serde(default)]` (false) and `core/src/config/mod.rs` reads it with
`is_some_and`. At 0.157.1 it is `default_true` and `is_none_or`, so on by
default. A 0.156.1 user who turned the fullscreen transcript on (with the
alternate screen) already had the row and the `unrecognised` reading.

**The change.** One row is accepted under the footer: exactly
`? for shortcuts` at the footer row's own indent. Footer then that row reads
as the footer alone did: ready, or busy when a busy row shows. Everything else
still reads `unrecognised`: any other row under the footer, two hint rows, the
hint above the footer, a wrapped footer (with or without the hint under it),
and the hint at another indent. Nothing else in the reader changed; the other
readers (`codexTextTyped`, `codexCommandTyped`, the paste and height checks)
run with a draft in the composer, when Codex draws no hint.

**Not accepted, on purpose (they read unrecognised, so nothing is typed):**
Codex's variant with agent threads to switch between
(`<left arrow> for agents . ? for shortcuts`), a warning notice drawn on the
hint row, a shortcuts key the user has rebound, and the queue hint
(`tab to queue message`, a draft while a turn runs). Each would need its own
recording before the reader accepts it.

**Tests.** New `tests/unit/shared/codex-screen-shortcuts-hint.test.ts`: the
bottom six rows of each of the four recordings' last screen, copied as
recorded (checked identical to the recordings' rows before committing). Before
the change 3 of its first 8 cases were red (the four ready screens, a turn running
with the hint, Plan mode read from the footer); the other 5 were green (the four
fail-closed cases, and the screens without the hint row). Three mutants, each
run once against those 8 cases (and the first also against
`tests/unit/renderer/codex-composer.test.ts`): accept any row under the footer
(3 cases red, one of them the existing WW case); accept any number of hint
rows (1 red); accept the hint at any indent (1 red). Review added a ninth
case: the hint is matched at the footer row's own indent (a footer at four
spaces). On the unchanged reader the 9-case file then has 4 cases red (the
three above and the new one) and the other 5 green; under a fourth mutant,
the hint fixed at two spaces, the new case is the only red one. The existing
reader tests are unchanged.

**Owner-visible effect.** With Codex 0.157.1, canvas notes, Ask Conductor
questions and the app's own Codex commands into a Codex tab are typed and sent
again, the Watchdog's Codex retry is sent again (on its current path until A2),
and Plan mode reads from the footer again. No live SSH matrix (no radius file); no VM step; no ADR-009
pass (a screen reading, no new input path).
