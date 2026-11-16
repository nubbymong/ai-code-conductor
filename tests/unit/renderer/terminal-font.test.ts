// aicc_planning #313: the terminal's font family list and the capped wait for
// its faces (src/renderer/components/terminal/terminalFont.ts). TerminalView's
// use of it is in terminalview-font-wait.test.tsx.
import { describe, it, expect, vi } from 'vitest'
import {
  TERMINAL_FONT_FALLBACKS,
  TERMINAL_FONT_WAIT_CAP_MS,
  terminalFontFamily,
  terminalFontReady,
  terminalFontSpecs,
  waitForTerminalFont,
} from '../../../src/renderer/components/terminal/terminalFont'

const timers = () => {
  const cleared: unknown[] = []
  let fire: (() => void) | null = null
  let ms = -1
  return {
    cleared,
    fire: () => fire?.(),
    get ms() { return ms },
    t: {
      setTimeout: (cb: () => void, m: number) => { fire = cb; ms = m; return 'timer-1' },
      clearTimeout: (id: unknown) => { cleared.push(id) },
    },
  }
}

describe('terminal font (#313)', () => {
  it('the family list is the chosen family, then the bundled and system fallbacks', () => {
    expect(terminalFontFamily('JetBrains Mono')).toBe(`'JetBrains Mono', ${TERMINAL_FONT_FALLBACKS}`)
    expect(terminalFontFamily(undefined)).toBe(TERMINAL_FONT_FALLBACKS)
    expect(terminalFontFamily('')).toBe(TERMINAL_FONT_FALLBACKS)
  })

  it('specs are the regular and bold faces at the terminal defaults, with no leading space', () => {
    expect(terminalFontSpecs({})).toEqual([`450 13px ${TERMINAL_FONT_FALLBACKS}`, `700 13px ${TERMINAL_FONT_FALLBACKS}`])
    const [regular, bold] = terminalFontSpecs({ fontFamily: 'Cascadia Code', fontSize: 15, fontWeight: 400 })
    expect(regular).toBe(`400 15px 'Cascadia Code', ${TERMINAL_FONT_FALLBACKS}`)
    expect(bold).toBe(`700 15px 'Cascadia Code', ${TERMINAL_FONT_FALLBACKS}`)
    for (const s of [regular, bold]) expect(s).toBe(s.trim())
  })

  it('resolves when every face has loaded, and clears its cap timer', async () => {
    const T = timers()
    const load = vi.fn(() => Promise.resolve([]))
    await waitForTerminalFont({ load }, ['a', 'b'], 1500, T.t)
    expect(load.mock.calls.map((c) => c[0])).toEqual(['a', 'b'])
    expect(T.ms).toBe(1500)
    expect(T.cleared).toEqual(['timer-1'])
  })

  it('never rejects: a load that throws or rejects resolves at once', async () => {
    const T = timers()
    await expect(waitForTerminalFont({ load: () => { throw new SyntaxError('bad') } }, ['a'], 1500, T.t)).resolves.toBeUndefined()
    await expect(waitForTerminalFont({ load: () => Promise.reject(new Error('net')) }, ['a'], 1500, T.t)).resolves.toBeUndefined()
  })

  it('a load that never ends resolves when the cap fires', async () => {
    const T = timers()
    let done = false
    const p = waitForTerminalFont({ load: () => new Promise(() => {}) }, ['a'], TERMINAL_FONT_WAIT_CAP_MS, T.t).then(() => { done = true })
    await Promise.resolve()
    expect(done).toBe(false)
    T.fire()
    await p
    expect(done).toBe(true)
    expect(T.ms).toBe(TERMINAL_FONT_WAIT_CAP_MS)
  })

  it('nothing to load resolves at once', async () => {
    await expect(waitForTerminalFont(undefined, ['a'])).resolves.toBeUndefined()
    await expect(waitForTerminalFont({}, ['a'])).resolves.toBeUndefined()
    await expect(waitForTerminalFont({ load: () => Promise.resolve() }, [])).resolves.toBeUndefined()
  })

  it('ready: only when every face checks loaded, or the page cannot load fonts on request', () => {
    const load = () => Promise.resolve()
    expect(terminalFontReady(undefined, ['a'])).toBe(true)
    expect(terminalFontReady({}, ['a'])).toBe(true)
    expect(terminalFontReady({ load }, ['a'])).toBe(false)
    expect(terminalFontReady({ load, check: () => true }, ['a', 'b'])).toBe(true)
    expect(terminalFontReady({ load, check: (s) => s === 'a' }, ['a', 'b'])).toBe(false)
    expect(terminalFontReady({ load, check: () => { throw new SyntaxError('bad') } }, ['a'])).toBe(false)
  })
})
