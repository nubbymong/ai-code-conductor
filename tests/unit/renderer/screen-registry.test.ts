// P3.8 round 1: the screen reader a Codex command is gated on reads the LIVE
// screen of a session's terminal (below its scrollback, whichever buffer is
// active), each row as its text and as its text with the dim cells blanked
// (Codex's placeholder is dim). The registry connects TerminalView, which owns
// the terminal, to the strip and the command bar.
import { describe, it, expect } from 'vitest'
import { Terminal } from '@xterm/headless'
import { readXtermScreen, registerScreenReader, readSessionScreen, type XtermLike } from '../../../src/renderer/components/terminal/screenRegistry'

/** A fake xterm: rows of cells [chars, width, dim]. */
function fakeTerm(rows: Array<Array<[string, number, boolean]>>, opts: { baseY?: number; screenRows: number; cols: number }): XtermLike {
  return {
    rows: opts.screenRows,
    cols: opts.cols,
    buffer: { active: {
      baseY: opts.baseY ?? 0,
      getLine: (y: number) => {
        const row = rows[y]
        if (!row) return undefined
        return { getCell: (x: number) => {
          const c = row[x]
          if (!c) return { getChars: () => '', getWidth: () => 1, isDim: () => 0 }
          return { getChars: () => c[0], getWidth: () => c[1], isDim: () => (c[2] ? 1 : 0) }
        } }
      },
    } },
  }
}
const cells = (s: string, dimFrom = Infinity): Array<[string, number, boolean]> => [...s].map((ch, i) => [ch, 1, i >= dimFrom])

describe('readXtermScreen', () => {
  it('reads the rows below the scrollback, dim cells blanked in `typed`', () => {
    const rows = [cells('old scrollback'), cells('\u203a Ask Codex to do anything', 2), cells('  gpt-6-astra low \u00b7 C:\\p')]
    const screen = readXtermScreen(fakeTerm(rows, { baseY: 1, screenRows: 2, cols: 40 }))
    expect(screen).toEqual([
      { text: '\u203a Ask Codex to do anything', typed: '\u203a', width: 40, end: 26 },
      { text: '  gpt-6-astra low \u00b7 C:\\p', typed: '  gpt-6-astra low \u00b7 C:\\p', width: 40, end: 24 },
    ])
  })

  // P3.8 round 4 (E4): each row says its width and where its last non-blank cell ends (a right-aligned segment's
  // end), a wide character counting its two cells.
  it('skips the second half of a wide character, and reads a missing row as blank', () => {
    const rows = [[['\u6f22', 2, false], ['', 0, false], ['x', 1, false]] as Array<[string, number, boolean]>]
    expect(readXtermScreen(fakeTerm(rows, { screenRows: 2, cols: 3 }))).toEqual([{ text: '\u6f22x', typed: '\u6f22x', width: 3, end: 3 }, { text: '', typed: '', width: 3, end: 0 }])
  })
})

describe('readXtermScreen and inverse cells', () => {
  // A cursor block is drawn inverse: where the terminal says which cells are,
  // each row also carries its text with every cell that is not inverse blanked.
  it('reports the inverse cells of each row where the terminal says, and nothing where it cannot', () => {
    const row: Array<[string, boolean]> = [['>', false], [' ', false], ['r', true], ['u', false], ['n', false]]
    const term: XtermLike = {
      rows: 1,
      cols: 5,
      buffer: { active: {
        baseY: 0,
        getLine: () => ({ getCell: (x: number) => {
          const c = row[x]
          return c ? { getChars: () => c[0], getWidth: () => 1, isDim: () => (x > 2 ? 1 : 0), isInverse: () => (c[1] ? 1 : 0) } : undefined
        } }),
      } },
    }
    expect(readXtermScreen(term)).toEqual([{ text: '> run', typed: '> r', inverse: '  r', width: 5, end: 5 }])
  })

  it('reads a cell a real terminal draws inverse (SGR 7) as inverse, and dim (SGR 2) cells as dim', async () => {
    const ESC = String.fromCharCode(27)
    const term = new Terminal({ cols: 10, rows: 1, scrollback: 0, allowProposedApi: true })
    try {
      await new Promise<void>((resolve) => term.write(`> ${ESC}[7mr${ESC}[27m${ESC}[2mun${ESC}[22m`, resolve))
      expect(readXtermScreen(term as unknown as XtermLike)).toEqual([{ text: '> run', typed: '> r', inverse: '  r', width: 10, end: 5 }])
    } finally {
      term.dispose()
    }
  })
})

describe('the screen registry', () => {
  it('reads a registered session, only removes its own registration, and never throws', () => {
    const a = () => [{ text: 'a', typed: 'a' }]
    const b = () => [{ text: 'b', typed: 'b' }]
    const offA = registerScreenReader('s1', a)
    const offB = registerScreenReader('s1', b)
    offA()
    expect(readSessionScreen('s1')).toEqual([{ text: 'b', typed: 'b' }])
    offB()
    expect(readSessionScreen('s1')).toBeNull()
    const off = registerScreenReader('s2', () => { throw new Error('disposed') })
    expect(readSessionScreen('s2')).toBeNull()
    off()
  })
})
