// 2.1.3-beta.19 section 4 (aicc_planning#436): Codex 0.170.0 and 0.172.0 add
// the thread's title to the footer once a prompt is sent ("<model> <effort> .
// <folder> . <title>"), and where that does not fit across the pane Codex
// wraps it at a word onto a second row, at the footer's indent (Codex's TUI at
// the rust-v0.170.0 and rust-v0.172.0 tags: bottom_pane/status_line.rs,
// wrap_rows, to the width of the footer's area less the two cells footer.rs's
// inset_footer_hint_area takes at the left). Until this section the reader
// refused every such screen, so the app typed nothing into that Codex: no
// canvas note, no Ask Conductor question, no app Codex command, no Watchdog
// retry, and a prompt button said "not sent".
//
// The reader now takes the wrapped footer in its recorded shape only, matched
// whole as the hint rows are (tests/unit/shared/codex-screen-hint-rows.test.ts):
// row one the footer with the title begun after its folder, cut at the pane's
// edge (row two's first word, with the space the wrap took, would have passed
// the row's last cell), and row two the rest of the title at the footer's
// indent and none of Codex's other rows. The screen's state, the draft and
// height readers, and the three readers that confirm a typed text (a command,
// a text, a paste placeholder) take the same shape, so a text typed over it is
// confirmed and Enter pressed, or taken back.
//
// The screens are the bottom six rows of the last screen of each recording
// that shows the wrap (helper/fixtures/screens/<name>.rows.json), copied as
// recorded (each row's end is its text's length: every cell is one wide), with
// the prompt glyph, the middle dot, the left arrow, the warning sign and the
// braille spinner written as code points; each with the window title its
// output last set. Probe P19 recorded them after its short prompt: Codex
// 0.170.0 on macOS and both Windows ConPTYs, Codex 0.172.0 (beta.18 section
// 7.4's hold) on both ConPTYs.
//
// Not checked here:
//  - a text typed at the composer over a wrapped footer: no recording holds
//    one, so those screens are built from the recorded rows (Codex hides its
//    hint row once a text is typed, as codex170-macos-queue-hint's events 38
//    to 40 show over a footer of one row);
//  - Codex 0.172.0 on macOS and Linux, and Codex 0.170.0 on Linux (its footer
//    did not wrap there after the same prompt: codex170-linux-after-reply);
//  - a footer wrapped onto three rows or more, a wrap inside the folder or
//    between the folder and the title: not recorded, so refused (below);
//  - a row two whose first word is of wide characters: the reader counts it
//    in code points, not cells, so it counts short and that wrap can stay
//    refused (the safe side; not recorded);
//  - a reply streaming on macOS: its wrapped screen reads ready, as Codex
//    0.157.1's does with a footer of one row (aicc_planning#370; the corpus
//    test lists both).
import { describe, it, expect } from 'vitest'
import {
  readCodexScreen, codexComposerState, codexComposerDraft, codexComposerRows, codexCommandTyped, codexTextTyped,
  codexPastedContentShown, codexPlanModeOnScreen, type ScreenLine,
} from '../../../src/shared/codex-screen'

const P = String.fromCharCode(0x203a)
const DOT = String.fromCharCode(0xb7)
const ARROW = String.fromCharCode(0x2190)
const WARN = String.fromCharCode(0x26a0)
const W = 120
const row = (text: string, typed: string, end: number): ScreenLine => ({ text, typed, inverse: '', width: W, end })
const blank = (): ScreenLine => row('', '', 0)
const plain = (text: string): ScreenLine => row(text, text, text.length)
/** The empty composer: the prompt glyph, then Codex's dim placeholder. */
const EMPTY = row(`${P} Ask Codex to do anything`, P, 26)
const QUEUED = plain(`${P} p19 queued draft`)

const AGENTS = plain(`  ${ARROW} for agents ${DOT} ? for shortcuts`)
const AGENTS_WARNING = plain(`  ${ARROW} for agents ${DOT} ? for shortcuts${' '.repeat(63)}${WARN} 1 warning ${DOT} f2 to view`)
const QUEUE_HINT = plain('  tab to queue message')
const WARNING = `${WARN} 1 warning ${DOT} f2 to view`
const COUNT_ALONE = plain(`${' '.repeat(W - 1 - WARNING.length)}${WARNING}`)

/** The two rows of each recorded wrapped footer, as recorded. */
const TITLE_HEAD = "p19 short: print the probe's short"
const WIN170 = (conpty: 'bundled' | 'system', launch: 'short' | 'queue'): ScreenLine[] => [
  plain(`  p19-probe default ${DOT} ~\\AppData\\Local\\Temp\\p19-9qw1BB\\codex-${conpty}-${launch}-1\\work ${DOT} ${TITLE_HEAD}`),
  plain('  reply'),
]
const MAC170 = (launch: 'short' | 'queue'): ScreenLine[] => [
  plain(`  p19-probe default ${DOT} /private/var/folders/q2/p1t6rgxj5fj32g1dc7dmd49r0000gn/T/p19-yqcGCX/codex-pty-${launch}-1/work ${DOT} p19`),
  plain("  short: print the probe's short reply"),
]
const WIN172 = (conpty: 'bundled' | 'system'): ScreenLine[] => [
  plain(`  GPT-6.1 Terra low ${DOT} ~\\AppData\\Local\\Temp\\p19-MAYv6e\\codex-${conpty}-tseq-1\\work ${DOT} ${TITLE_HEAD}`),
  plain('  reply'),
]

/** The window titles the recordings' output last set: at rest, and with
 *  Codex's braille spinner while a reply streams (Windows and Linux only). */
const AT_REST = "p19 short: print the probe's short reply | work"
const spinning = (code: number): string => `${String.fromCharCode(code)} ${AT_REST}`

interface Recorded { screen: ScreenLine[]; title: string; reads: 'ready' | 'busy'; text: string; models: string[] }
const RECORDED: Record<string, Recorded> = {
  'codex170-windows-bundled-after-reply': { screen: [blank(), EMPTY, blank(), ...WIN170('bundled', 'short'), AGENTS_WARNING], title: AT_REST, reads: 'ready', text: '', models: ['p19-probe'] },
  'codex170-windows-system-after-reply': { screen: [blank(), EMPTY, blank(), ...WIN170('system', 'short'), AGENTS_WARNING], title: AT_REST, reads: 'ready', text: '', models: ['p19-probe'] },
  'codex170-macos-after-reply': { screen: [blank(), EMPTY, blank(), ...MAC170('short'), AGENTS_WARNING], title: AT_REST, reads: 'ready', text: '', models: ['p19-probe'] },
  'codex170-windows-bundled-mid-reply': { screen: [blank(), EMPTY, blank(), ...WIN170('bundled', 'short'), AGENTS_WARNING], title: spinning(0x2807), reads: 'busy', text: '', models: ['p19-probe'] },
  'codex170-windows-system-mid-reply': { screen: [blank(), EMPTY, blank(), ...WIN170('system', 'short'), AGENTS_WARNING], title: spinning(0x2807), reads: 'busy', text: '', models: ['p19-probe'] },
  // aicc_planning#370: on macOS nothing on screen or in the title says a reply streams.
  'codex170-macos-mid-reply': { screen: [blank(), EMPTY, blank(), ...MAC170('short'), AGENTS_WARNING], title: AT_REST, reads: 'ready', text: '', models: ['p19-probe'] },
  'codex170-windows-bundled-queue-hint': { screen: [blank(), QUEUED, blank(), ...WIN170('bundled', 'queue'), QUEUE_HINT], title: spinning(0x2838), reads: 'busy', text: 'p19 queued draft', models: ['p19-probe'] },
  'codex170-macos-queue-hint': { screen: [blank(), QUEUED, blank(), ...MAC170('queue'), QUEUE_HINT], title: AT_REST, reads: 'busy', text: 'p19 queued draft', models: ['p19-probe'] },
  'codex172-windows-bundled-wrapped-after-reply': { screen: [blank(), EMPTY, blank(), ...WIN172('bundled'), AGENTS], title: AT_REST, reads: 'ready', text: '', models: ['gpt-6.1-terra'] },
  'codex172-windows-system-wrapped-after-reply': { screen: [blank(), EMPTY, blank(), ...WIN172('system'), AGENTS], title: AT_REST, reads: 'ready', text: '', models: ['gpt-6.1-terra'] },
}

/** Row one and row two of a recorded wrapped footer (Codex 0.170.0, the
 *  bundled ConPTY: row one ends at 117 of 120, row two is "  reply"). */
const [ROW_ONE, ROW_TWO] = WIN170('bundled', 'short')
/** A screen down to the footer: the empty composer and the blank row under it. */
const TOP = [blank(), EMPTY, blank()]
/** The composer holding `text`, then the blank row under it. */
const typedTop = (text: string): ScreenLine[] => [blank(), plain(`${P} ${text}`), blank()]
/** Row one cut to end at `end` cells (its folder shortened or lengthened). */
const rowOneEndingAt = (end: number): ScreenLine => {
  const tail = ` ${DOT} ${TITLE_HEAD}`
  const head = `  p19-probe default ${DOT} ~\\AppData\\Local\\Temp\\`
  return plain(`${head}${'x'.repeat(end - head.length - tail.length - 5)}\\work${tail}`)
}

describe('Codex 0.170.0 and 0.172.0: the footer wrapped onto two rows (2.1.3-beta.19 section 4, #436)', () => {
  it('holds every recorded wrapped screen (a vacuous pass is no pass)', () => {
    expect(Object.keys(RECORDED)).toHaveLength(10)
    for (const [name, { screen }] of Object.entries(RECORDED)) {
      expect(screen, name).toHaveLength(6)
      expect(screen[3].end, name).toBeGreaterThanOrEqual(115)
    }
  })

  it('each recorded wrapped screen reads its state, with its title as the app reads it, and with the session\'s models', () => {
    for (const [name, { screen, title, reads, text, models }] of Object.entries(RECORDED)) {
      expect(readCodexScreen(screen, null, { title }), name).toEqual({ screen: reads, text })
      expect(readCodexScreen(screen, models, { title }), name).toEqual({ screen: reads, text })
    }
  })

  it('read without the title, the screens whose only busy sign is the spinner read their rows: ready, the queue hint busy', () => {
    for (const [name, { screen, text }] of Object.entries(RECORDED)) {
      const rows = name.endsWith('queue-hint') ? 'busy' : 'ready'
      expect(readCodexScreen(screen), name).toEqual({ screen: rows, text })
      expect(codexComposerState(screen), name).toBe(rows)
    }
  })

  it('with a list that lacks the model, no row is the footer: no prompt', () => {
    for (const [name, { screen, title }] of Object.entries(RECORDED)) {
      expect(readCodexScreen(screen, ['gpt-5.5'], { title }).screen, name).toBe('no-prompt')
    }
  })

  it('what the composer holds is read over the wrapped footer, and its height is one row', () => {
    for (const [name, { screen, text }] of Object.entries(RECORDED)) {
      expect(codexComposerDraft(screen), name).toBe(text.replace(/\s+/g, ''))
      expect(codexComposerRows(screen), name).toBe(1)
    }
  })

  it('Plan mode is not read from a footer cut at the edge: no reading, as before', () => {
    for (const [name, { screen }] of Object.entries(RECORDED)) expect(codexPlanModeOnScreen(screen), name).toBeNull()
  })

  it('a command, a text and a paste placeholder typed over the wrapped footer are confirmed (Codex hides its hint row once a text is typed)', () => {
    for (const footer of [WIN170('bundled', 'short'), MAC170('short'), WIN172('system')]) {
      expect(codexCommandTyped([...typedTop('/model'), ...footer], '/model', null, AT_REST)).toBe(true)
      expect(codexTextTyped([...typedTop('p19 note'), ...footer], 'p19 note', null, AT_REST)).toBe(true)
      expect(codexPastedContentShown([...typedTop('[Pasted Content 1200 chars]'), ...footer], 1200, null, AT_REST)).toBe(true)
      // The warning count Codex keeps alone under the footer once a text is typed.
      expect(codexTextTyped([...typedTop('p19 note'), ...footer, COUNT_ALONE], 'p19 note', null, AT_REST)).toBe(true)
      expect(codexCommandTyped([...typedTop('/model'), ...footer, COUNT_ALONE], '/model', null, AT_REST)).toBe(true)
      expect(codexPastedContentShown([...typedTop('[Pasted Content 1200 chars]'), ...footer, COUNT_ALONE], 1200, null, AT_REST)).toBe(true)
      expect(readCodexScreen([...typedTop('p19 note'), ...footer, COUNT_ALONE], null, { title: AT_REST })).toEqual({ screen: 'ready', text: 'p19 note' })
    }
  })

  it('a text Codex wraps onto a second composer row is read and confirmed over the wrapped footer, two rows high', () => {
    const first = 'Please check the second panel: the Save button label is cut off at narrow widths, and its icon sits too far left of'
    const rest = 'it. Thanks'
    const screen = [blank(), plain(`${P} ${first}`), plain(`  ${rest}`), blank(), ROW_ONE, ROW_TWO]
    expect(codexTextTyped(screen, `${first} ${rest}`, null, AT_REST)).toBe(true)
    expect(codexComposerDraft(screen)).toBe(`${first}${rest}`.replace(/\s+/g, ''))
    expect(codexComposerRows(screen)).toBe(2)
  })

  it('a text is not confirmed over the wrapped footer while a turn runs or for another text', () => {
    const screen = [...typedTop('p19 note'), ROW_ONE, ROW_TWO]
    expect(codexTextTyped(screen, 'p19 note', null, spinning(0x2807))).toBe(false)
    expect(codexTextTyped([blank(), plain('  Working (3s, esc to interrupt)'), ...screen], 'p19 note', null, AT_REST)).toBe(false)
    expect(codexTextTyped(screen, 'p19 notes', null, AT_REST)).toBe(false)
    expect(readCodexScreen([blank(), plain('  Working (3s, esc to interrupt)'), ...TOP, ROW_ONE, ROW_TWO, AGENTS]).screen).toBe('busy')
  })

  it('a prompt on screen over the wrapped footer reads blocked, and nothing typed is confirmed', () => {
    const prompt = plain('  Would you like to run the following command?')
    expect(readCodexScreen([prompt, ...TOP, ROW_ONE, ROW_TWO, AGENTS]).screen).toBe('blocked')
    expect(codexTextTyped([prompt, ...typedTop('p19 note'), ROW_ONE, ROW_TWO], 'p19 note')).toBe(false)
  })

  // The mutant "any second row accepted": each row here sits under a footer row
  // cut at the edge, and none is the recorded continuation.
  it('a second row not of the recorded shape keeps the screen refused, and no reader takes it', () => {
    const rows: Record<string, ScreenLine> = {
      'at 0': plain('reply'),
      'at 1': plain(' reply'),
      'at 3': plain('   reply'),
      'at 4': plain('    reply'),
      'two spaces inside': plain('  reply  now'),
      'right-aligned': plain(`${' '.repeat(W - 2 - 'Plan mode'.length)}Plan mode`),
      'the queue hint with the count': plain(`  tab to queue message${' '.repeat(73)}${WARNING}`),
      'a word that fits on row one': plain('  ok'),
    }
    for (const [what, two] of Object.entries(rows)) {
      expect(readCodexScreen([...TOP, ROW_ONE, two]).screen, what).toBe('unrecognised')
      expect(readCodexScreen([...TOP, ROW_ONE, two, AGENTS]).screen, `${what}, over the hint row`).toBe('unrecognised')
      expect(codexComposerDraft([...TOP, ROW_ONE, two]), what).toBeNull()
      expect(codexComposerRows([...TOP, ROW_ONE, two]), what).toBeNull()
      expect(codexTextTyped([...typedTop('p19 note'), ROW_ONE, two], 'p19 note'), what).toBe(false)
      expect(codexCommandTyped([...typedTop('/model'), ROW_ONE, two], '/model'), what).toBe(false)
      expect(codexPastedContentShown([...typedTop('[Pasted Content 1200 chars]'), ROW_ONE, two], 1200), what).toBe(false)
    }
  })

  it('one of Codex\'s own rows under a footer row cut at the edge is never its second row: the screen is refused, and no text typed over it is confirmed', () => {
    const rows: Record<string, ScreenLine> = {
      'a footer of its own': plain(`  GPT-5.5 medium ${DOT} /tmp/p19/work`),
      'a footer of a model not listed': plain(`  o9 high ${DOT} /tmp/p19/work`),
      'a popup row': plain('  /model  choose what model and reasoning effort to use'),
      'a popup row, single-spaced': plain('  /model'),
    }
    for (const [what, two] of Object.entries(rows)) {
      expect(readCodexScreen([...TOP, ROW_ONE, two]).screen, what).toBe('unrecognised')
      expect(readCodexScreen([...TOP, ROW_ONE, two], ['p19-probe']).screen, `${what}, with the session's model`).toBe('unrecognised')
      expect(codexTextTyped([...typedTop('p19 note'), ROW_ONE, two], 'p19 note'), what).toBe(false)
      expect(codexPastedContentShown([...typedTop('[Pasted Content 1200 chars]'), ROW_ONE, two], 1200), what).toBe(false)
    }
  })

  // The queue hint says a turn runs (on macOS it is the only sign, aicc_planning#370): no Enter over it.
  it('a hint row is never the second row of a footer cut at the edge, and under the wrapped footer it stops the confirm readers: nothing typed is confirmed', () => {
    const cases: ReadonlyArray<readonly [string, ScreenLine[]]> = [
      ['the queue hint under a footer of one row', [ROW_ONE, QUEUE_HINT]],
      ['the shortcuts hint under a footer of one row', [rowOneEndingAt(119), plain('  ? for shortcuts')]],
      ['the rebound shortcuts hint under a footer of one row', [rowOneEndingAt(118), plain('  f6 for shortcuts')]],
      ['the agents hint under a footer of one row', [rowOneEndingAt(119), AGENTS]],
      ['the queue hint under the wrapped footer', [ROW_ONE, ROW_TWO, QUEUE_HINT]],
      ['the agents hint under the wrapped footer', [ROW_ONE, ROW_TWO, AGENTS]],
    ]
    for (const [what, under] of cases) {
      expect(codexTextTyped([...typedTop('p19 note'), ...under], 'p19 note', null, AT_REST), what).toBe(false)
      expect(codexCommandTyped([...typedTop('/model'), ...under], '/model', null, AT_REST), what).toBe(false)
      expect(codexPastedContentShown([...typedTop('[Pasted Content 1200 chars]'), ...under], 1200, null, AT_REST), what).toBe(false)
    }
    // The text typed while a reply streams is still read, so composer-submit can take it back.
    expect(readCodexScreen([...typedTop('p19 note'), ROW_ONE, QUEUE_HINT], null, { title: AT_REST })).toEqual({ screen: 'busy', text: 'p19 note' })
    expect(codexComposerDraft([...typedTop('p19 note'), ROW_ONE, ROW_TWO, QUEUE_HINT])).toBe('p19note')
  })

  it('a popup row or a footer of one row under the wrapped footer: a command typed over them is not confirmed', () => {
    expect(codexCommandTyped([...typedTop('/model'), ROW_ONE, ROW_TWO, plain('  /model  choose what model and reasoning effort to use')], '/model', null, AT_REST)).toBe(false)
    expect(codexCommandTyped([...typedTop('/model'), ROW_ONE, ROW_TWO, plain(`  p19-probe default ${DOT} /tmp/p19/work`)], '/model', null, AT_REST)).toBe(false)
  })

  it('row one cut at the edge means row two\'s first word with its space passes the last cell: at the edge it is read, one cell short it is not', () => {
    // "reply" is 5 cells; with the space the wrap took, 6.
    expect(rowOneEndingAt(115).end).toBe(115)
    expect(readCodexScreen([...TOP, rowOneEndingAt(115), ROW_TWO, AGENTS]).screen).toBe('ready')
    expect(readCodexScreen([...TOP, rowOneEndingAt(118), ROW_TWO, AGENTS]).screen).toBe('ready')
    expect(readCodexScreen([...TOP, rowOneEndingAt(114), ROW_TWO, AGENTS]).screen).toBe('unrecognised')
    expect(readCodexScreen([...TOP, rowOneEndingAt(100), ROW_TWO, AGENTS]).screen).toBe('unrecognised')
    expect(codexTextTyped([...typedTop('p19 note'), rowOneEndingAt(114), ROW_TWO], 'p19 note')).toBe(false)
    // Row one filling every cell: any word wraps, but row two still sits at the footer's own indent.
    expect(readCodexScreen([...TOP, rowOneEndingAt(W), ROW_TWO, AGENTS]).screen).toBe('ready')
    expect(codexTextTyped([...typedTop('p19 note'), rowOneEndingAt(W), ROW_TWO], 'p19 note')).toBe(true)
    for (const spaces of [0, 1, 3, 4]) {
      const two = plain(`${' '.repeat(spaces)}reply`)
      expect(readCodexScreen([...TOP, rowOneEndingAt(W), two]).screen, `at ${spaces}`).toBe('unrecognised')
      expect(codexTextTyped([...typedTop('p19 note'), rowOneEndingAt(W), two], 'p19 note'), `at ${spaces}`).toBe(false)
    }
  })

  it('a row one not of the recorded shape keeps the screen refused: no title after the folder, two spaces, or a width the reader does not know', () => {
    const noTitle = plain(`  p19-probe default ${DOT} ~\\AppData\\Local\\Temp\\${'x'.repeat(69)}\\work`)
    expect(noTitle.end).toBe(117)
    const atSeparator = plain(`  p19-probe default ${DOT} ~\\AppData\\Local\\Temp\\${'x'.repeat(68)}\\work ${DOT}`)
    expect(atSeparator.end).toBe(118)
    const spaced = plain(ROW_ONE.text.replace('p19 short', 'p19  short'))
    const unsized: ScreenLine = { text: ROW_ONE.text, typed: ROW_ONE.typed }
    for (const [what, one, two] of [
      ['a wrap inside the folder', noTitle, plain('  folder')],
      ['a wrap between the folder and the title', atSeparator, plain(`  ${TITLE_HEAD} reply`)],
      ['two spaces in row one', spaced, ROW_TWO],
      ['no width or end', unsized, ROW_TWO],
    ] as const) {
      expect(readCodexScreen([...TOP, one, two, AGENTS]).screen, what).toBe('unrecognised')
      expect(codexTextTyped([...typedTop('p19 note'), one, two], 'p19 note'), what).toBe(false)
    }
  })

  // The mutant "a footer among other rows read ready": the wrapped footer is
  // read only as the last rows under the composer (Codex's one row under it
  // aside), never with another row above, between or under it.
  it('a wrapped footer among other rows reads unrecognised, and nothing typed over it is confirmed', () => {
    const other = plain('  Reconnecting 1/5')
    const screens: Record<string, ScreenLine[]> = {
      'a row under it': [...TOP, ROW_ONE, ROW_TWO, other],
      'a row under it, then the hint row': [...TOP, ROW_ONE, ROW_TWO, other, AGENTS],
      'a row above it': [...TOP, other, ROW_ONE, ROW_TWO, AGENTS],
      'a third row': [...TOP, ROW_ONE, ROW_TWO, plain('  more'), AGENTS],
      'the hint row between its rows': [...TOP, ROW_ONE, AGENTS, ROW_TWO],
      'its rows the other way round': [...TOP, ROW_TWO, ROW_ONE, AGENTS],
      'the hint row twice': [...TOP, ROW_ONE, ROW_TWO, AGENTS, AGENTS],
      'the wrapped footer twice': [...TOP, ROW_ONE, ROW_TWO, ROW_ONE, ROW_TWO],
    }
    for (const [what, screen] of Object.entries(screens)) {
      expect(readCodexScreen(screen, null, { title: AT_REST }).screen, what).toBe('unrecognised')
      expect(readCodexScreen(screen, ['p19-probe'], { title: AT_REST }).screen, `${what}, with the session's model`).toBe('unrecognised')
    }
    expect(codexTextTyped([...typedTop('p19 note'), ROW_ONE, ROW_TWO, other], 'p19 note', null, AT_REST)).toBe(false)
    expect(codexTextTyped([...typedTop('p19 note'), other, ROW_ONE, ROW_TWO], 'p19 note', null, AT_REST)).toBe(false)
    expect(codexCommandTyped([...typedTop('/model'), ROW_ONE, ROW_TWO, other], '/model', null, AT_REST)).toBe(false)
    expect(codexPastedContentShown([...typedTop('[Pasted Content 1200 chars]'), other, ROW_ONE, ROW_TWO], 1200, null, AT_REST)).toBe(false)
  })

  it('the warning count alone under the wrapped footer is taken only under a composer that holds something, as recorded', () => {
    expect(readCodexScreen([...TOP, ROW_ONE, ROW_TWO, COUNT_ALONE]).screen).toBe('unrecognised')
    expect(readCodexScreen([...typedTop('p19 note'), ROW_ONE, ROW_TWO, COUNT_ALONE])).toEqual({ screen: 'ready', text: 'p19 note' })
  })
})
