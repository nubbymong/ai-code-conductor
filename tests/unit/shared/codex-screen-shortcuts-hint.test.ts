// 2.1.3-beta.10 section C5 (aicc_planning #349): Codex 0.157.1 draws its
// shortcuts hint, "? for shortcuts", on the row under the footer of an empty
// composer. The reader takes exactly that one row as part of the footer's
// place, so the footer stays its anchor; any other row under the footer, a
// second hint row, or a wrapped footer still reads unrecognised (round 2, WW).
//
// Where the row comes from (Codex's TUI source at the rust-v0.157.1 tag):
// bottom_pane/footer.rs, left_side_line, draws the key "?" then " for
// shortcuts" while the composer is empty (footer.rs:242-249, ComposerEmpty;
// a draft hides it), at the footer's indent (FOOTER_INDENT_COLS). It sits
// under the footer only when the status line has its own row
// (chat_composer/status_surface.rs), which the fullscreen transcript gives it
// (app/owned_transcript.rs; chatwidget/rendering.rs, separate_status_line).
// 0.157.1 turns that transcript on by default (config/src/types.rs,
// tui.fullscreen_transcript, default_true; core/src/config/mod.rs, is_none_or);
// 0.156.1 has the same code but defaults it off (serde default false,
// is_some_and), so a 0.156.1 user sees the row only after turning it on.
//
// The four ready screens are the bottom six rows of the last screen of beta.11
// A2's recordings (helper/fixtures/screens/codex-<system>-ready.rows.json,
// probe P19: a stand-in model and a fresh Codex home folder), copied as
// recorded, with the prompt glyph and the middle dot written as code points.
import { describe, it, expect } from 'vitest'
import { readCodexScreen, codexComposerState, codexPlanModeOnScreen, type ScreenLine } from '../../../src/shared/codex-screen'

const P = String.fromCharCode(0x203a)
const DOT = String.fromCharCode(0xb7)
const W = 120
const row = (text: string, typed: string, end: number): ScreenLine => ({ text, typed, inverse: '', width: W, end })
const blank = (): ScreenLine => row('', '', 0)
const plain = (text: string): ScreenLine => row(text, text, text.length)
const HINT = plain('  ? for shortcuts')

/** The bottom six rows of a recorded ready screen: a tip, the composer with
 *  its dim placeholder, the footer, and the hint row. */
const recorded = (tip: string, folder: string): ScreenLine[] => {
  const footer = `  p19-probe default ${DOT} ${folder}`
  return [
    row(tip, tip, W - 1),
    blank(),
    row(`${P} Ask Codex to do anything`, P, 26),
    blank(),
    row(footer, footer, footer.length),
    HINT,
  ]
}
const READY_0157: Record<string, ScreenLine[]> = {
  'codex-linux-ready': recorded(
    `${' '.repeat(52)}Tip: Press ctrl+g to edit your current draft in an external editor.`,
    '/tmp/p19-TFBZJN/codex-pty-turn-1/work'),
  'codex-macos-ready': recorded(
    `${' '.repeat(47)}Tip: Use /statusline to configure which items appear in the status line.`,
    '/private/var/folders/h5/t85nd63d71x27_8gl5gw3l_w0000gn/T/p19-sXYFnL/codex-pty-turn-1/work'),
  'codex-windows-bundled-ready': recorded(
    `${' '.repeat(50)}Tip: Use /init to create an AGENTS.md with project-specific guidance.`,
    '~\\AppData\\Local\\Temp\\p19-BFjuYr\\codex-bundled-turn-1\\work'),
  'codex-windows-system-ready': recorded(
    `${' '.repeat(53)}Tip: Use /skills to list available skills or ask Codex to use one.`,
    '~\\AppData\\Local\\Temp\\p19-BFjuYr\\codex-system-turn-1\\work'),
}
const LINUX = READY_0157['codex-linux-ready']
/** The Linux screen with `under` in place of its hint row. */
const withUnder = (...under: ScreenLine[]): ScreenLine[] => [...LINUX.slice(0, -1), ...under]

describe("Codex 0.157.1's shortcuts hint under the footer (C5, #349)", () => {
  it('the four recorded ready screens read ready, the composer empty', () => {
    for (const [name, screen] of Object.entries(READY_0157)) {
      expect(readCodexScreen(screen), name).toEqual({ screen: 'ready', text: '' })
      expect(readCodexScreen(screen, ['p19-probe']), name).toEqual({ screen: 'ready', text: '' })
      expect(codexComposerState(screen), name).toBe('ready')
    }
  })

  it('the same screens without the hint row read ready, as before', () => {
    for (const [name, screen] of Object.entries(READY_0157)) expect(readCodexScreen(screen.slice(0, -1)).screen, name).toBe('ready')
  })

  it('a turn running with the hint row under the footer reads busy', () => {
    const busy = [...LINUX.slice(0, 2), plain('  Working (3s, esc to interrupt)'), ...LINUX.slice(2)]
    expect(readCodexScreen(busy).screen).toBe('busy')
    expect(codexComposerState(busy)).toBe('busy')
  })

  // 2.1.3-beta.12 C3 (aicc_planning #357): the queue hint and Codex 0.170.0's
  // "<left arrow> for agents . ? for shortcuts" were in this list until probe
  // P19's second run recorded them; they are read now, and pinned with the
  // other recorded rows in codex-screen-hint-rows.test.ts.
  it('any other row under the footer still reads unrecognised', () => {
    for (const text of [
      '  ? for shortcuts                                                                                   100% context left',
      '  ? for shortcuts.',
      '  ? shortcuts',
      '  for shortcuts',
      '? for shortcuts',
      '    ? for shortcuts',
      '  Tip: Use /init to create an AGENTS.md with project-specific guidance.',
    ]) {
      expect(readCodexScreen(withUnder(plain(text))).screen, text).toBe('unrecognised')
    }
  })

  it('two hint rows under the footer read unrecognised', () => {
    expect(readCodexScreen(withUnder(HINT, HINT)).screen).toBe('unrecognised')
    expect(readCodexScreen(withUnder(HINT, blank(), HINT)).screen).toBe('unrecognised')
  })

  // The footer is read at any indent from 0 to 8 (footerRe), so the hint is
  // matched at the footer row's own indent, not at a fixed two spaces.
  it("the hint row is matched at the footer row's own indent", () => {
    const footer4 = plain(`    p19-probe default ${DOT} /tmp/p19-TFBZJN/codex-pty-turn-1/work`)
    const base = LINUX.slice(0, -2)
    expect(readCodexScreen([...base, footer4, plain('    ? for shortcuts')]).screen).toBe('ready')
    expect(readCodexScreen([...base, footer4, HINT]).screen).toBe('unrecognised')
  })

  it('a wrapped footer reads unrecognised, with or without the hint row under it', () => {
    const wrapped = [plain(`  p19-probe default ${DOT} C:\\Users\\alex\\projects\\a-very-long`), plain('-folder-name')]
    const base = LINUX.slice(0, -2)
    expect(readCodexScreen([...base, ...wrapped]).screen).toBe('unrecognised')
    expect(readCodexScreen([...base, ...wrapped, HINT]).screen).toBe('unrecognised')
  })

  it('the hint row is never a footer of its own: above the footer it is a row under the composer, and alone it is no prompt', () => {
    const composer = LINUX.slice(0, -2)
    const footer = LINUX[LINUX.length - 2]
    expect(readCodexScreen([...composer, HINT, footer]).screen).toBe('unrecognised')
    expect(readCodexScreen([...composer, HINT]).screen).toBe('no-prompt')
  })

  // The status row keeps Plan mode right-aligned, two cells from the edge
  // (status_surface.rs, render_context_right), so it is read as before.
  it('Plan mode is still read from the footer row when the hint row is under it', () => {
    const label = 'Plan mode'
    const text = `  p19-probe default ${DOT} /tmp/p19-TFBZJN/codex-pty-turn-1/work`.padEnd(W - 2 - label.length) + label
    expect(codexPlanModeOnScreen([...LINUX.slice(0, -2), row(text, text, W - 2), HINT])).toBe(true)
    expect(codexPlanModeOnScreen(LINUX)).toBe(false)
  })
})
