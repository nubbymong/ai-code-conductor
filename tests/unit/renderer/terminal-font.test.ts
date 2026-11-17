// aicc_planning #313: the terminal's font options and the capped, cancellable
// waits for its faces (src/renderer/components/terminal/terminalFont.ts).
// TerminalView's use of them is in terminalview-font-wait.test.tsx.
import { describe, it, expect, vi } from 'vitest'
import {
  TERMINAL_FONT_FALLBACKS,
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_WAIT_CAP_MS,
  TERMINAL_FONT_WEIGHT_BOLD,
  TERMINAL_FONT_WEIGHT_DEFAULT,
  onFontsReady,
  terminalFontFamily,
  terminalFontOptions,
  terminalFontReady,
  terminalFontSpecs,
  waitForTerminalFont,
} from '../../../src/renderer/components/terminal/terminalFont'
import { DEFAULT_TERMINAL_SETTINGS } from '../../../src/renderer/stores/settingsStore'

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
const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve() }
const deferred = () => {
  let resolve!: (v?: unknown) => void
  const promise = new Promise<unknown>((r) => { resolve = r })
  return { promise, resolve }
}

describe('terminal font options (#313)', () => {
  it('the fallbacks are the bundled and system faces, then the generic monospace', () => {
    expect(TERMINAL_FONT_FALLBACKS).toBe("'JetBrains Mono', 'Cascadia Code', 'Cascadia Mono', Consolas, monospace")
    expect(terminalFontFamily(undefined)).toBe(TERMINAL_FONT_FALLBACKS)
    expect(terminalFontFamily('')).toBe(TERMINAL_FONT_FALLBACKS)
  })

  it('the family list is the chosen family, then the fallbacks without the chosen one', () => {
    // The default family is not listed twice.
    expect(terminalFontFamily('JetBrains Mono')).toBe("'JetBrains Mono', 'Cascadia Code', 'Cascadia Mono', Consolas, monospace")
    // CSS family names match without regard to ASCII case.
    expect(terminalFontFamily('jetbrains mono')).toBe("'jetbrains mono', 'Cascadia Code', 'Cascadia Mono', Consolas, monospace")
    expect(terminalFontFamily('Cascadia Code')).toBe("'Cascadia Code', 'JetBrains Mono', 'Cascadia Mono', Consolas, monospace")
    expect(terminalFontFamily('Consolas')).toBe("'Consolas', 'JetBrains Mono', 'Cascadia Code', 'Cascadia Mono', monospace")
    // A family the fallbacks do not name keeps them all.
    expect(terminalFontFamily('Fira Code')).toBe(`'Fira Code', ${TERMINAL_FONT_FALLBACKS}`)
    // The generic monospace always stays: a quoted 'monospace' names a font.
    expect(terminalFontFamily('monospace')).toBe(`'monospace', ${TERMINAL_FONT_FALLBACKS}`)
  })

  it('the defaults are the store defaults, and the options fill only what is unset', () => {
    expect(TERMINAL_FONT_SIZE_DEFAULT).toBe(DEFAULT_TERMINAL_SETTINGS.fontSize)
    expect(TERMINAL_FONT_WEIGHT_DEFAULT).toBe(DEFAULT_TERMINAL_SETTINGS.fontWeight)
    expect(TERMINAL_FONT_WEIGHT_BOLD).toBe(700)
    expect(terminalFontOptions({})).toEqual({
      fontFamily: TERMINAL_FONT_FALLBACKS,
      fontSize: TERMINAL_FONT_SIZE_DEFAULT,
      fontWeight: TERMINAL_FONT_WEIGHT_DEFAULT,
      fontWeightBold: TERMINAL_FONT_WEIGHT_BOLD,
    })
    expect(terminalFontOptions({ fontFamily: 'Fira Code', fontSize: 15, fontWeight: 400 })).toEqual({
      fontFamily: `'Fira Code', ${TERMINAL_FONT_FALLBACKS}`,
      fontSize: 15,
      fontWeight: 400,
      fontWeightBold: TERMINAL_FONT_WEIGHT_BOLD,
    })
  })

  it('specs are the regular and bold faces of the same options, with no leading space', () => {
    expect(terminalFontSpecs({})).toEqual([`450 13px ${TERMINAL_FONT_FALLBACKS}`, `700 13px ${TERMINAL_FONT_FALLBACKS}`])
    const ts = { fontFamily: 'Fira Code', fontSize: 15, fontWeight: 400 }
    const o = terminalFontOptions(ts)
    const [regular, bold] = terminalFontSpecs(ts)
    expect(regular).toBe(`${o.fontWeight} ${o.fontSize}px ${o.fontFamily}`)
    expect(bold).toBe(`${o.fontWeightBold} ${o.fontSize}px ${o.fontFamily}`)
    for (const s of [regular, bold]) expect(s).toBe(s.trim())
  })
})

describe('waitForTerminalFont (#313)', () => {
  it('runs once every face has loaded, and clears its cap timer', async () => {
    const T = timers()
    const run = vi.fn()
    const a = deferred()
    const b = deferred()
    const loads = [a, b]
    const load = vi.fn((_spec: string) => loads.shift()!.promise)
    waitForTerminalFont({ load }, ['a', 'b'], run, 1500, T.t)
    expect(load.mock.calls.map((c) => c[0])).toEqual(['a', 'b'])
    expect(T.ms).toBe(1500)
    a.resolve()
    await flush()
    expect(run).not.toHaveBeenCalled()
    b.resolve()
    await flush()
    expect(run).toHaveBeenCalledTimes(1)
    expect(T.cleared).toEqual(['timer-1'])
    T.fire()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('a load that throws or rejects still runs it, at once', async () => {
    const T = timers()
    const run = vi.fn()
    waitForTerminalFont({ load: () => { throw new SyntaxError('bad') } }, ['a'], run, 1500, T.t)
    expect(run).toHaveBeenCalledTimes(1)
    const R = timers()
    const run2 = vi.fn()
    waitForTerminalFont({ load: () => Promise.reject(new Error('net')) }, ['a'], run2, 1500, R.t)
    await flush()
    expect(run2).toHaveBeenCalledTimes(1)
  })

  it('a load that never ends runs it when the cap fires', async () => {
    const T = timers()
    const run = vi.fn()
    waitForTerminalFont({ load: () => new Promise(() => {}) }, ['a'], run, TERMINAL_FONT_WAIT_CAP_MS, T.t)
    await flush()
    expect(run).not.toHaveBeenCalled()
    T.fire()
    expect(run).toHaveBeenCalledTimes(1)
    expect(T.ms).toBe(TERMINAL_FONT_WAIT_CAP_MS)
  })

  it('nothing to load runs it at once', () => {
    const run = vi.fn()
    waitForTerminalFont(undefined, ['a'], run)
    waitForTerminalFont({}, ['a'], run)
    waitForTerminalFont({ load: () => Promise.resolve() }, [], run)
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('cancel clears the cap timer, and neither the load nor the cap runs it after', async () => {
    const T = timers()
    const run = vi.fn()
    const d = deferred()
    const cancel = waitForTerminalFont({ load: () => d.promise }, ['a'], run, 1500, T.t)
    cancel()
    expect(T.cleared).toEqual(['timer-1'])
    d.resolve()
    await flush()
    T.fire()
    expect(run).not.toHaveBeenCalled()
    cancel()
    expect(T.cleared).toEqual(['timer-1'])
  })
})

describe('onFontsReady (#313)', () => {
  it('runs once when ready settles, and clears its cap timer', async () => {
    const T = timers()
    const run = vi.fn()
    onFontsReady({ ready: Promise.resolve() }, run, 1500, T.t)
    expect(run).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(run).toHaveBeenCalledTimes(1)
    expect(T.cleared).toEqual(['timer-1'])
    T.fire()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('runs once after the cap when ready never settles, and once on a rejected ready', async () => {
    const T = timers()
    const run = vi.fn()
    onFontsReady({ ready: new Promise(() => {}) }, run, TERMINAL_FONT_WAIT_CAP_MS, T.t)
    await Promise.resolve()
    expect(run).not.toHaveBeenCalled()
    T.fire()
    expect(run).toHaveBeenCalledTimes(1)
    const R = timers()
    const run2 = vi.fn()
    onFontsReady({ ready: Promise.reject(new Error('x')) }, run2, 1500, R.t)
    await flush()
    expect(run2).toHaveBeenCalledTimes(1)
  })

  it('with no ready at all runs at once', () => {
    const run = vi.fn()
    onFontsReady(undefined, run, 1500, timers().t)
    onFontsReady({}, run, 1500, timers().t)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('cancel clears the cap timer, and neither ready nor the cap runs it after', async () => {
    const T = timers()
    const run = vi.fn()
    const d = deferred()
    const cancel = onFontsReady({ ready: d.promise }, run, 1500, T.t)
    cancel()
    expect(T.cleared).toEqual(['timer-1'])
    d.resolve()
    await flush()
    T.fire()
    expect(run).not.toHaveBeenCalled()
  })
})

describe('terminalFontReady (#313)', () => {
  it('ready only when every face checks loaded, or the page cannot load fonts on request', () => {
    const load = () => Promise.resolve()
    expect(terminalFontReady(undefined, ['a'])).toBe(true)
    expect(terminalFontReady({}, ['a'])).toBe(true)
    expect(terminalFontReady({ load }, ['a'])).toBe(false)
    expect(terminalFontReady({ load, check: () => true }, ['a', 'b'])).toBe(true)
    expect(terminalFontReady({ load, check: (s) => s === 'a' }, ['a', 'b'])).toBe(false)
    expect(terminalFontReady({ load, check: () => { throw new SyntaxError('bad') } }, ['a'])).toBe(false)
  })
})
