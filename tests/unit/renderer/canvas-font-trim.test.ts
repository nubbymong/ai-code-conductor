/**
 * aicc_planning #313: the GPU terminal drew its text in 10px sans-serif.
 *
 * Measured on the test VM (2.1.3-beta.6, Electron 44.11.3, WebGL renderer):
 * the 2D canvas ignores a font value that starts with whitespace, and
 * @xterm/addon-webgl builds every upright glyph's font as
 * `${fontStyle} ${fontWeight} ${size}px ${family}` with fontStyle ''. The fake
 * context below behaves the way that canvas did, so these tests fail without
 * the trim and pass with it. jsdom has no canvas, so the real pixels are a VM
 * check (see the PR).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { trimCanvasFontSetter, installCanvasFontTrim, trimCssWhitespace } from '../../../src/renderer/components/terminal/canvasFontTrim'
import { installWebglWithRecovery } from '../../../src/renderer/components/terminal/terminalWebgl'

const repoRoot = join(__dirname, '../../..')
const DEFAULT_FONT = '10px sans-serif'
const FAMILY = "'JetBrains Mono', 'Cascadia Code', 'Cascadia Mono', Consolas, monospace"

/** A 2D-context stand-in with the measured behaviour: a value with leading
 *  whitespace is ignored (the context keeps what it had), anything else is
 *  kept as given. */
function makeContextClass() {
  const sets: unknown[] = []
  class FakeContext2D {
    _font = DEFAULT_FONT
  }
  Object.defineProperty(FakeContext2D.prototype, 'font', {
    configurable: true,
    enumerable: true,
    get(this: FakeContext2D) { return this._font },
    set(this: FakeContext2D, v: unknown) {
      sets.push(v)
      const s = String(v)
      if (/^\s/.test(s) || s.trim() === '') return
      this._font = s
    },
  })
  return { FakeContext2D, sets }
}

/** The glyph font exactly as @xterm/addon-webgl 0.19's TextureAtlas builds it. */
const atlasFont = (italic: boolean, weight: number | string, size: number, family: string) =>
  `${italic ? 'italic' : ''} ${weight} ${size}px ${family}`

describe('canvas font trim (#313)', () => {
  it('with the trim, the atlas font for upright text reaches the canvas and is kept, at any weight', () => {
    const { FakeContext2D } = makeContextClass()
    // Precondition: the stand-in drops the atlas string as the VM canvas did,
    // so the trim below is what makes it stick.
    const bare = new FakeContext2D() as unknown as { font: string }
    bare.font = atlasFont(false, 450, 13, FAMILY)
    expect(bare.font, 'precondition: the untrimmed string is ignored').toBe(DEFAULT_FONT)

    expect(trimCanvasFontSetter(FakeContext2D.prototype)).toBe(true)
    const ctx = new FakeContext2D() as unknown as { font: string }
    for (const w of [450, 400, 700, 'normal', 'bold']) {
      ctx.font = atlasFont(false, w, 13, FAMILY)
      expect(ctx.font).toBe(`${w} 13px ${FAMILY}`)
    }
    ctx.font = atlasFont(true, 450, 16.25, FAMILY)
    expect(ctx.font).toBe(`italic 450 16.25px ${FAMILY}`)
  })

  it('passes a value that needs no trim through unchanged, and a non-string as is', () => {
    const { FakeContext2D, sets } = makeContextClass()
    trimCanvasFontSetter(FakeContext2D.prototype)
    const ctx = new FakeContext2D() as unknown as { font: unknown }
    ctx.font = '13px "JetBrains Mono"'
    const obj = { toString: () => '12px serif' }
    ctx.font = obj
    expect(sets).toEqual(['13px "JetBrains Mono"', obj])
  })

  it('removes only CSS whitespace (space, tab, LF, CR, FF) at the ends', () => {
    expect(trimCssWhitespace(' \t\n\r\f450 13px x \t\n\r\f')).toBe('450 13px x')
    expect(trimCssWhitespace('450  13px  x')).toBe('450  13px  x')
    // Not CSS whitespace: a no-break space can end a valid family ident, and
    // the others are not whitespace to CSS either. String.prototype.trim would
    // remove all of them.
    for (const ch of [' ', '﻿', ' ', ' ', '　', ' ']) {
      const v = `${ch}13px x${ch}`
      expect(trimCssWhitespace(v), `U+${ch.codePointAt(0)!.toString(16).toUpperCase()}`).toBe(v)
    }
  })

  it('a value with a leading no-break space reaches the native setter unchanged', () => {
    const { FakeContext2D, sets } = makeContextClass()
    trimCanvasFontSetter(FakeContext2D.prototype)
    const ctx = new FakeContext2D() as unknown as { font: string }
    const v = ' 13px Mono '
    ctx.font = v
    ctx.font = ` ${v} `
    expect(sets).toEqual([v, v])
  })

  it('wraps a prototype once: a second install is a no-op and the native setter runs once per set', () => {
    const { FakeContext2D, sets } = makeContextClass()
    expect(trimCanvasFontSetter(FakeContext2D.prototype)).toBe(true)
    expect(trimCanvasFontSetter(FakeContext2D.prototype)).toBe(false)
    const ctx = new FakeContext2D() as unknown as { font: string }
    ctx.font = ' 450 13px x'
    expect(sets).toEqual(['450 13px x'])
  })

  it('keeps the native getter, and leaves a prototype without a configurable font setter alone', () => {
    const { FakeContext2D } = makeContextClass()
    const before = Object.getOwnPropertyDescriptor(FakeContext2D.prototype, 'font')!
    trimCanvasFontSetter(FakeContext2D.prototype)
    expect(Object.getOwnPropertyDescriptor(FakeContext2D.prototype, 'font')!.get).toBe(before.get)
    expect(trimCanvasFontSetter(undefined)).toBe(false)
    expect(trimCanvasFontSetter({})).toBe(false)
    const frozen = {}
    Object.defineProperty(frozen, 'font', { configurable: false, get: () => '', set: () => {} })
    expect(trimCanvasFontSetter(frozen)).toBe(false)
  })

  it('installCanvasFontTrim covers both 2D context kinds and is a no-op where one is missing', () => {
    const on = makeContextClass()
    const off = makeContextClass()
    installCanvasFontTrim({ CanvasRenderingContext2D: on.FakeContext2D, OffscreenCanvasRenderingContext2D: off.FakeContext2D })
    const a = new on.FakeContext2D() as unknown as { font: string }
    const b = new off.FakeContext2D() as unknown as { font: string }
    a.font = ' 450 13px x'
    b.font = ' 450 13px x'
    expect([a.font, b.font]).toEqual(['450 13px x', '450 13px x'])
    expect(() => installCanvasFontTrim({})).not.toThrow()
  })
})

describe('the trim is in place before any canvas draws (#313)', () => {
  it('main.tsx installs it once at renderer startup, before React renders', () => {
    // main.tsx renders the whole App, so it is pinned by its source, as the
    // other renderer start-up wiring is (excalidraw-fonts-guard).
    const src = readFileSync(join(repoRoot, 'src/renderer/main.tsx'), 'utf-8')
    expect(src).toMatch(/import \{ installCanvasFontTrim \} from '\.\/components\/terminal\/canvasFontTrim'/)
    const call = src.search(/^installCanvasFontTrim\(\)\r?$/m)
    const render = src.indexOf('createRoot(')
    expect(call, 'a top-level installCanvasFontTrim() call').toBeGreaterThan(-1)
    expect(render).toBeGreaterThan(-1)
    expect(call, 'installed before the root is created').toBeLessThan(render)
  })

  describe('installWebglWithRecovery installs it too (guard), before the WebGL addon builds its atlas', () => {
    const g = globalThis as unknown as { CanvasRenderingContext2D?: unknown }
    const had = Object.prototype.hasOwnProperty.call(g, 'CanvasRenderingContext2D')
    const prev = g.CanvasRenderingContext2D
    afterEach(() => {
      if (had) g.CanvasRenderingContext2D = prev
      else delete g.CanvasRenderingContext2D
    })

    it('a canvas used by the addon from its constructor on accepts the atlas font', () => {
      const { FakeContext2D } = makeContextClass()
      g.CanvasRenderingContext2D = FakeContext2D
      let seenInCtor: string | null = null
      class FakeWebglAddon {
        constructor() {
          const ctx = new FakeContext2D() as unknown as { font: string }
          ctx.font = atlasFont(false, 450, 13, FAMILY)
          seenInCtor = ctx.font
        }
        onContextLoss() {}
        dispose() {}
      }
      const term = { loadAddon() {}, refresh() {}, rows: 24 }
      installWebglWithRecovery(term as never, { WebglAddonCtor: FakeWebglAddon as never, raf: (cb) => { cb(); return 0 }, isDisposed: () => false })
      expect(seenInCtor).toBe(`450 13px ${FAMILY}`)
    })
  })
})
