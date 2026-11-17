/**
 * The terminal's font: the options xterm is given (family list, size, weights),
 * and the wait for that font before a terminal is built (aicc_planning #313).
 *
 * One source for both. TerminalView builds xterm from terminalFontOptions, and
 * the wait asks for the faces terminalFontSpecs names from the same options,
 * so the wait always loads the faces the terminal and its atlas draw.
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
 * race. Waiting for the face first removes the race for any load that
 * finishes within the cap (TERMINAL_FONT_WAIT_CAP_MS): the cell measure and
 * the atlas both see the real font. A face slower than the cap still puts
 * stand-in glyphs in the atlas, and nothing repaints them; that is the price of
 * never rebuilding the atlas for it (the 2026-08 atlas lesson). The atlas
 * itself is not touched.
 */

/** The fallback entries after the chosen family, as xterm is given them, each
 *  with the family name it stands for. `monospace` is the generic family and
 *  stays whatever the choice: a chosen family is quoted, so a choice called
 *  "monospace" names a font, not the generic. */
const FALLBACK_ENTRIES: ReadonlyArray<{ css: string; name: string | null }> = [
  { css: "'JetBrains Mono'", name: 'jetbrains mono' },
  { css: "'Cascadia Code'", name: 'cascadia code' },
  { css: "'Cascadia Mono'", name: 'cascadia mono' },
  { css: 'Consolas', name: 'consolas' },
  { css: 'monospace', name: null },
]

/** What the terminal falls back to when no family is chosen. */
export const TERMINAL_FONT_FALLBACKS = FALLBACK_ENTRIES.map((e) => e.css).join(', ')

/** The family list xterm is given for a chosen family (or none). A fallback
 *  that names the chosen family is left out (CSS family names match without
 *  regard to ASCII case), so the default 'JetBrains Mono' is not listed twice. */
export function terminalFontFamily(chosen?: string): string {
  if (!chosen) return TERMINAL_FONT_FALLBACKS
  const key = chosen.trim().toLowerCase()
  const rest = FALLBACK_ENTRIES.filter((e) => e.name !== key).map((e) => e.css)
  return [`'${chosen}'`, ...rest].join(', ')
}

/** The terminal's size when none is set. */
export const TERMINAL_FONT_SIZE_DEFAULT = 13
/** The terminal's regular weight when none is set. 450 is a variable-font
 *  instance; if it renders unreliably in packaged Electron, fall back to 400
 *  after visual testing (spec section 2). The #313 bisect showed the weight is
 *  not what drew GPU text in a sans font. */
export const TERMINAL_FONT_WEIGHT_DEFAULT = 450
/** The bold weight the terminal draws bold text in (xterm fontWeightBold). */
export const TERMINAL_FONT_WEIGHT_BOLD = 700

/** The longest a terminal waits for its font. A face that never arrives (a
 *  missing file, a stalled load) must not leave the tab blank. */
export const TERMINAL_FONT_WAIT_CAP_MS = 1500

interface TerminalFontSettings {
  fontFamily?: string
  fontSize?: number
  fontWeight?: number | string
}

export interface TerminalFontOptions {
  fontFamily: string
  fontSize: number
  fontWeight: number | string
  fontWeightBold: number
}

/** The font options xterm is given for the terminal settings. */
export function terminalFontOptions(ts: TerminalFontSettings): TerminalFontOptions {
  return {
    fontFamily: terminalFontFamily(ts.fontFamily),
    fontSize: ts.fontSize || TERMINAL_FONT_SIZE_DEFAULT,
    fontWeight: ts.fontWeight || TERMINAL_FONT_WEIGHT_DEFAULT,
    fontWeightBold: TERMINAL_FONT_WEIGHT_BOLD,
  }
}

/** CSS font shorthands for the faces the terminal draws: regular and bold, from
 *  the same options xterm is given. No leading space (see canvasFontTrim). */
export function terminalFontSpecs(ts: TerminalFontSettings): string[] {
  const o = terminalFontOptions(ts)
  return [`${o.fontWeight} ${o.fontSize}px ${o.fontFamily}`, `${o.fontWeightBold} ${o.fontSize}px ${o.fontFamily}`]
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

/** Stops a wait that has not run yet: its cap timer is cleared and its callback
 *  never runs. Calling it after the callback ran, or twice, does nothing. */
export type CancelFontWait = () => void

/** Calls `run` at most once, through `fire`, and arms the cap timer. The
 *  returned cancel clears the timer and makes a later `fire` a no-op. */
function once(run: () => void, capMs: number, timers: Timers): { fire: () => void; cancel: CancelFontWait } {
  let done = false
  let timer: unknown = null
  const cancel = () => {
    if (done) return
    done = true
    timers.clearTimeout(timer)
  }
  const fire = () => {
    if (done) return
    cancel()
    run()
  }
  timer = timers.setTimeout(fire, capMs)
  return { fire, cancel }
}

/**
 * Calls `run` once: when `fonts.ready` settles, or after `capMs`, whichever is
 * first. `ready` waits for EVERY font the page is loading, so one stalled load
 * would otherwise hold a terminal's first fit and PTY start for good (the wait
 * before the terminal is built is capped; this one must be too). `run` is
 * called straight from `ready`'s callback, as the unbounded wait did, so the
 * usual case keeps its timing. No `ready` at all runs it at once. Returns a
 * cancel for a view torn down before `run`.
 */
export function onFontsReady(
  fonts: { ready?: PromiseLike<unknown> } | null | undefined,
  run: () => void,
  capMs: number = TERMINAL_FONT_WAIT_CAP_MS,
  timers: Timers = defaultTimers,
): CancelFontWait {
  const w = once(run, capMs, timers)
  const ready = fonts?.ready
  if (ready && typeof ready.then === 'function') ready.then(w.fire, w.fire)
  else w.fire()
  return w.cancel
}

/**
 * Calls `run` once every spec's faces have loaded, or after `capMs`, whichever
 * is first. A failed or impossible load (no document.fonts, a spec the browser
 * refuses) runs it at once, so the terminal still starts. Returns a cancel for
 * a view torn down while it waits.
 */
export function waitForTerminalFont(
  fonts: FontLoader | null | undefined,
  specs: readonly string[],
  run: () => void,
  capMs: number = TERMINAL_FONT_WAIT_CAP_MS,
  timers: Timers = defaultTimers,
): CancelFontWait {
  if (!fonts || typeof fonts.load !== 'function' || specs.length === 0) {
    run()
    return () => {}
  }
  const load = fonts.load.bind(fonts)
  const w = once(run, capMs, timers)
  let loads: Promise<unknown>[]
  try {
    loads = specs.map((s) => load(s))
  } catch {
    w.fire()
    return w.cancel
  }
  Promise.all(loads).then(w.fire, w.fire)
  return w.cancel
}
