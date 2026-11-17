/**
 * aicc_planning #313: with GPU rendering on, terminal text was drawn in a small
 * sans font inside cells sized for JetBrains Mono.
 *
 * The cause, measured on the test VM (2.1.3-beta.6, Electron 44.11.3): the
 * renderer's 2D canvas IGNORES a `font` value that starts with whitespace.
 * `ctx.font = ' 450 13px "JetBrains Mono"'` leaves the context on its default,
 * `10px sans-serif`, while the same string without the leading space is
 * accepted. @xterm/addon-webgl 0.19 builds every glyph's font as
 * `${fontStyle} ${fontWeight} ${size}px ${family}`, and fontStyle is '' for
 * upright text, so every upright glyph in the WebGL atlas was rasterised in
 * 10px sans-serif. The weight (450 or 400) and the font's load state made no
 * difference; trimming the string fixed it at once. CSS whitespace (space,
 * tab, line feed, carriage return, form feed) around a CSS value is
 * insignificant, so a string with only that removed means exactly what the
 * caller asked for, and a value the browser already accepts is passed on
 * unchanged in meaning. Nothing else is removed: a no-break space, for one, is
 * not CSS whitespace and can be part of a family name.
 *
 * This wraps the `font` setter of the 2D context prototypes once, so the
 * string reaches the browser trimmed. It is renderer-wide: main.tsx installs it
 * before React renders, so every 2D canvas in the window (the terminal's
 * glyph atlas, Excalidraw, pasted images) behaves the same from the start,
 * whatever has been shown. installWebglWithRecovery calls it again as a guard
 * (idempotent). It does not touch the glyph atlas, its cache or how often it
 * is built (the 2026-08 atlas lesson), and it does not change xterm or the
 * addon. It can go when the bundled Chromium accepts the leading space again,
 * or the addon stops sending one.
 */

const MARK = Symbol.for('ccc.canvasFontTrim')

/** CSS whitespace at either end of a value (CSS Syntax: space, tab, and the
 *  newlines LF, CR and FF). String.prototype.trim would remove more. */
const CSS_EDGE_WHITESPACE = /^[ \t\n\r\f]+|[ \t\n\r\f]+$/g

/** The value with CSS whitespace removed from both ends; anything else as is. */
export function trimCssWhitespace(value: string): string {
  return value.replace(CSS_EDGE_WHITESPACE, '')
}

type Proto = object | null | undefined

/** Wrap one prototype's `font` setter. Returns true when it installed now,
 *  false when there is nothing to wrap or it was already wrapped. */
export function trimCanvasFontSetter(proto: Proto): boolean {
  if (!proto || Object.prototype.hasOwnProperty.call(proto, MARK)) return false
  const d = Object.getOwnPropertyDescriptor(proto, 'font')
  if (!d || typeof d.set !== 'function' || !d.configurable) return false
  const nativeSet = d.set
  Object.defineProperty(proto, 'font', {
    configurable: true,
    enumerable: d.enumerable,
    get: d.get,
    set(this: unknown, value: unknown) {
      nativeSet.call(this, typeof value === 'string' ? trimCssWhitespace(value) : value)
    },
  })
  Object.defineProperty(proto, MARK, { value: true })
  return true
}

interface CanvasGlobals {
  CanvasRenderingContext2D?: { prototype: object }
  OffscreenCanvasRenderingContext2D?: { prototype: object }
}

/** Install on both 2D context kinds of `scope` (the renderer's window).
 *  Idempotent, and a no-op where a kind does not exist (tests, workers). */
export function installCanvasFontTrim(scope: CanvasGlobals = globalThis as unknown as CanvasGlobals): void {
  trimCanvasFontSetter(scope.CanvasRenderingContext2D?.prototype)
  trimCanvasFontSetter(scope.OffscreenCanvasRenderingContext2D?.prototype)
}
