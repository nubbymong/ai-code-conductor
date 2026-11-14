/**
 * What katex gives back for the one call the app's dependencies make of it
 * (2.1.3-beta.3).
 *
 * The app source names neither katex nor mermaid. The Agent Canvas drawing
 * library's Mermaid import loads mermaid, and mermaid calls katex only for a
 * diagram whose text holds a `$$...$$` span: renderToString, with the options
 * below. mermaid asks for the 0.16 line and package.json overrides katex to
 * the patched 0.18 line, so this pins what that call returns in terms both
 * lines share: the outer `katex` span, which mermaid's one style rule names,
 * with MathML inside it and no HTML tree. Nothing here names a version or an
 * inner class, so it holds on either line.
 *
 * And a link: with katex's own settings as they come (mermaid sets none that
 * trusts the input), a `javascript:` address never becomes one.
 *
 * Pure: no file, no network, no DOM.
 */
import { describe, it, expect } from 'vitest'
import katex from 'katex'

/** The options mermaid passes. */
const AS_MERMAID = { throwOnError: true, displayMode: true, output: 'mathml' } as const

describe('katex, called as mermaid calls it', () => {
  it('a fixed input comes back as MathML inside the outer katex span', () => {
    const out = katex.renderToString('x^2', AS_MERMAID)
    // The outer span is the first thing in the output and the last to close.
    expect(out).toMatch(/^<span class="katex">/)
    expect(out).toMatch(/<\/span>$/)
    // MathML, as a block (displayMode), holding the input.
    expect(out).toMatch(/<math[\s>]/)
    expect(out).toMatch(/<math[^>]*\bdisplay="block"/)
    expect(out).toContain('<mi>x</mi>')
    expect(out).toContain('<mn>2</mn>')
    // MathML alone was asked for: no HTML tree beside it.
    expect(out).not.toContain('katex-html')
  })

  it('the same input twice gives the same output', () => {
    expect(katex.renderToString('x^2', AS_MERMAID)).toBe(katex.renderToString('x^2', AS_MERMAID))
  })

  it('input katex cannot read throws, as throwOnError asks', () => {
    expect(() => katex.renderToString(String.raw`\notacommand`, AS_MERMAID)).toThrow()
  })
})

describe('katex never makes a javascript: address a link', () => {
  const HOSTILE = [
    String.raw`\href{javascript:alert(1)}{x}`,
    String.raw`\href{JaVaScRiPt:alert(1)}{x}`,
    String.raw`\href{ javascript:alert(1)}{x}`,
    String.raw`\url{javascript:alert(1)}`,
  ]
  /** The output, or null when katex refuses the input outright (as good). */
  const rendered = (tex: string, options?: Parameters<typeof katex.renderToString>[1]): string | null => {
    try { return katex.renderToString(tex, options) } catch { return null }
  }

  it.each(HOSTILE)('%s, with katex\'s own settings as they come', (tex) => {
    const out = rendered(tex)
    if (out === null) return
    expect(out).not.toMatch(/href\s*=\s*["']?\s*javascript:/i)
    // No link of any kind: the command is not trusted unless a caller says so.
    expect(out).not.toMatch(/<a[\s>]/i)
    expect(out).not.toMatch(/\shref\s*=/i)
  })

  it.each(HOSTILE)('%s, with the options mermaid passes', (tex) => {
    const out = rendered(tex, AS_MERMAID)
    if (out === null) return
    expect(out).not.toMatch(/href\s*=\s*["']?\s*javascript:/i)
    expect(out).not.toMatch(/<a[\s>]/i)
    expect(out).not.toMatch(/\shref\s*=/i)
  })

  // So that the checks above can fail: a caller that does trust the input
  // gets an address in the output, where those patterns find it.
  it('an address is in the output only when a caller trusts the input', () => {
    const tex = String.raw`\href{https://example.com/}{x}`
    const trusted = katex.renderToString(tex, { trust: true })
    expect(trusted).toMatch(/\shref\s*=\s*"https:\/\/example\.com\/"/)
    expect(trusted).toMatch(/<a[\s>]/i)
    expect(katex.renderToString(tex, { ...AS_MERMAID, trust: true })).toMatch(/\shref\s*=\s*"https:\/\/example\.com\/"/)
    for (const options of [undefined, AS_MERMAID]) {
      const out = rendered(tex, options)
      if (out !== null) expect(out).not.toMatch(/\shref\s*=/i)
    }
  })
})
