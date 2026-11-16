/**
 * The terminal's font: the family list xterm is given, and the wait for that
 * font before a terminal is built (aicc_planning #313).
 *
 * Why the wait. The bundled JetBrains Mono is a lazy @font-face: the browser
 * fetches it only when something first asks for it. With GPU rendering on,
 * nothing in the page draws terminal text as DOM, so the first ask is xterm's
 * own cell measure when the terminal is built, and the WebGL addon rasterises
 * its glyph atlas a moment later (its warm-up runs in the next idle time).
 * Glyphs drawn while the face is still loading are drawn in a stand-in font
 * and stay in the atlas, because nothing redraws the atlas when the face
 * arrives. On the test VM the face arrived only 34 ms before the first glyph
 * (a reload, served from cache), so a cold start after a reboot can lose that
 * race. Waiting for the face first takes the race away: the cell measure and
 * the atlas both see the real font. The atlas itself is not touched.
 */

/** What the terminal falls back to after the chosen family. */
export const TERMINAL_FONT_FALLBACKS = "'JetBrains Mono', 'Cascadia Code', 'Cascadia Mono', Consolas, monospace"

/** The family list xterm is given for a chosen family (or none). */
export function terminalFontFamily(chosen?: string): string {
  return chosen ? `'${chosen}', ${TERMINAL_FONT_FALLBACKS}` : TERMINAL_FONT_FALLBACKS
}

/** The longest a terminal waits for its font. A face that never arrives (a
 *  missing file, a stalled load) must not leave the tab blank. */
export const TERMINAL_FONT_WAIT_CAP_MS = 1500

/** The bold weight TerminalView gives xterm (fontWeightBold). */
export const TERMINAL_FONT_WEIGHT_BOLD = 700

interface TerminalFontSettings {
  fontFamily?: string
  fontSize?: number
  fontWeight?: number | string
}

/** CSS font shorthands for the faces the terminal draws: regular and bold, at
 *  the same defaults TerminalView uses. No leading space (see canvasFontTrim). */
export function terminalFontSpecs(ts: TerminalFontSettings): string[] {
  const family = terminalFontFamily(ts.fontFamily)
  const size = ts.fontSize || 13
  const weight = ts.fontWeight || 450
  return [`${weight} ${size}px ${family}`, `${TERMINAL_FONT_WEIGHT_BOLD} ${size}px ${family}`]
}

interface FontLoader {
  load?: (font: string, text?: string) => Promise<unknown>
  check?: (font: string, text?: string) => boolean
}

/**
 * True when there is nothing to wait for: the page cannot load fonts on
 * request, or every spec's faces are already loaded (FontFaceSet.check). Then
 * the terminal starts on its first frame exactly as it did before #313; only a
 * terminal built while its face is not yet loaded waits.
 */
export function terminalFontReady(fonts: FontLoader | null | undefined, specs: readonly string[]): boolean {
  if (!fonts || typeof fonts.load !== 'function') return true
  if (typeof fonts.check !== 'function') return false
  try {
    return specs.every((s) => fonts.check!(s))
  } catch {
    return false
  }
}

interface Timers {
  setTimeout: (cb: () => void, ms: number) => unknown
  clearTimeout: (id: unknown) => void
}

const defaultTimers: Timers = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
}

/**
 * Resolves once every spec's faces have loaded, or after `capMs`, whichever is
 * first. Never rejects: a failed or impossible load (no document.fonts, a spec
 * the browser refuses) resolves at once, so the terminal still starts.
 */
export function waitForTerminalFont(
  fonts: FontLoader | null | undefined,
  specs: readonly string[],
  capMs: number = TERMINAL_FONT_WAIT_CAP_MS,
  timers: Timers = defaultTimers,
): Promise<void> {
  if (!fonts || typeof fonts.load !== 'function' || specs.length === 0) return Promise.resolve()
  const load = fonts.load.bind(fonts)
  return new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      timers.clearTimeout(timer)
      resolve()
    }
    const timer = timers.setTimeout(finish, capMs)
    let loads: Promise<unknown>[]
    try {
      loads = specs.map((s) => load(s))
    } catch {
      finish()
      return
    }
    Promise.all(loads).then(finish, finish)
  })
}
