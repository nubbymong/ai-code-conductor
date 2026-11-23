/**
 * Snap on Windows with the session helper's capture mode and the app's own
 * overlay (ADR-030 S8 step 2, D3 and D4; plan 2.1.3-beta.16 A1,
 * aicc_planning#401). One press:
 *
 *   1. the helper writes one picture of each display into a folder of the
 *      app's own (helper-capture.ts), ended through its handle if it has not
 *      answered within the bound;
 *   2. each picture is read (bmp.ts) and matched to one of Electron's displays
 *      by its physical bounds, then the folder is removed;
 *   3. the overlay is opened on every display with its picture, and answers a
 *      rectangle in DIP inside one display, that display whole, or nothing;
 *   4. the answer is cut from that display's picture at its physical pixels
 *      and saved by the caller (today's 1920 cap and JPEG).
 *
 * Exit 3 (no desktop to capture: an SSH session, a service, a locked screen or
 * an elevation prompt) captures nothing. Anything else that goes wrong (exit
 * 1, 2 or 4, a start that fails, no answer in time, a line or a picture it
 * cannot read, a display it cannot match, an overlay that fails, a save that
 * fails) hands the press to the previous Snap. Each press logs one line: the
 * engine, the helper's time, each display's size and scale, and what came of
 * it (a rectangle, the whole screen, cancelled, nothing, or why the previous
 * Snap took it). The line never holds a path or a pixel.
 *
 * Electron and the file system are reached through `SnapPorts` only, so this
 * file is tested without either (tests/unit/main/snap/).
 */
import { join } from 'path'
import { cropPicture, decodeBmp32, pixelRectFor, PictureError, type Picture } from './bmp'
import { CAPTURE_EXIT, parseCaptureLine, type HelperCaptureRun, type HelperDisplay } from './helper-capture'

/** A rectangle; in DIP for the overlay (ADR-030 D4's contract). */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** One of Electron's displays: its DIP bounds, its scale and its bounds in
 *  physical pixels (screen.dipToScreenRect). */
export interface AppDisplay {
  id: number
  dipBounds: Rect
  scale: number
  physical: Rect
}

/** What the overlay is given for each display. `picture` is what the caller's
 *  toImage made (a NativeImage in the app). */
export interface OverlayDisplay<Img> {
  id: number
  dipBounds: Rect
  scale: number
  picture: Img
}

/** The overlay's answer: a rectangle in DIP inside the named display, that
 *  display whole, or null when the user cancelled. An overlay that fails
 *  rejects. */
export type OverlayAnswer = { id: number; rect: Rect } | { id: number; whole: true } | null

export type OpenOverlays<Img> = (displays: OverlayDisplay<Img>[]) => Promise<OverlayAnswer>

export type SnapOutcome =
  | { kind: 'saved'; file: string }
  | { kind: 'cancelled' }
  | { kind: 'no-desktop' }
  | { kind: 'previous'; why: string }

export interface SnapPorts<Img> {
  /** The helper to run, or null when there is none to use. */
  helperPath: () => string | null
  /** A new, empty folder of the app's own for one press. */
  makeFolder: () => string
  /** Remove that folder and everything in it. Never throws. */
  removeFolder: (folder: string) => void
  /** One run of `capture --out <folder>`, with its bound (helper-capture.ts). */
  runHelper: (helper: string, folder: string) => Promise<HelperCaptureRun>
  readFile: (file: string) => Buffer
  /** Electron's displays, now. */
  displays: () => AppDisplay[]
  /** The picture as the overlay shows it, at the display's scale. */
  toImage: (picture: Picture, scale: number) => Img
  openOverlays: OpenOverlays<Img>
  /** Save the answer (today's cap and JPEG); returns its file. */
  save: (picture: Picture) => string
  log: (line: string) => void
}

/** A helper display and the app display it is: the same physical bounds,
 *  each edge within one pixel (a fractional scale can round an edge). */
export function matchDisplays(helper: HelperDisplay[], app: AppDisplay[]): Array<{ helper: HelperDisplay; app: AppDisplay }> | null {
  if (helper.length !== app.length) return null
  const near = (a: number, b: number) => Math.abs(a - b) <= 1
  const used = new Set<number>()
  const pairs: Array<{ helper: HelperDisplay; app: AppDisplay }> = []
  for (const h of helper) {
    const found = app.filter((a, i) => !used.has(i)
      && near(a.physical.x, h.left) && near(a.physical.y, h.top)
      && near(a.physical.x + a.physical.width, h.left + h.width) && near(a.physical.y + a.physical.height, h.top + h.height))
    if (found.length !== 1) return null
    used.add(app.indexOf(found[0]))
    pairs.push({ helper: h, app: found[0] })
  }
  return pairs
}

const describeDisplays = (list: HelperDisplay[]): string =>
  list.map((d, i) => `display ${i + 1} ${d.width}x${d.height} at ${d.scale}%${d.primary ? ' (primary)' : ''}`).join(', ')

const firstLine = (text: string): string => String(text ?? '').trim().split(/\r?\n/)[0]?.slice(0, 200) ?? ''

/** One press of Snap with the new engine. Never throws: whatever goes wrong
 *  that the previous Snap could still do answers `previous`. */
export async function snapWithHelper<Img>(p: SnapPorts<Img>): Promise<SnapOutcome> {
  let ran = ''
  const previous = (why: string): SnapOutcome => {
    p.log(`[snap] new engine: ${why}${ran}; the previous Snap takes this press`)
    return { kind: 'previous', why }
  }
  let helper: string | null
  try { helper = p.helperPath() } catch { helper = null }
  if (!helper) return previous('no session helper to run')
  let folder: string
  try { folder = p.makeFolder() } catch (err) {
    return previous(`the capture folder could not be made (${err instanceof Error ? err.name : 'error'})`)
  }
  try {
    const run = await p.runHelper(helper, folder)
    ran = `; the helper took ${run.ms} ms`
    if (run.kind === 'start-failed') return previous(`the helper could not start (${firstLine(run.why)})`)
    if (run.kind === 'no-answer') return previous('no answer from the helper in time; it was ended')
    if (run.kind === 'too-much-output') return previous('the helper wrote more than its one line; it was ended')
    if (run.code === CAPTURE_EXIT.noDesktop) {
      p.log(`[snap] new engine: no desktop to capture (exit 3)${ran}; nothing captured`)
      return { kind: 'no-desktop' }
    }
    if (run.code !== CAPTURE_EXIT.written) {
      // The helper's message can name the folder: it is never logged.
      const said = firstLine(run.stderr).split(folder).join('the capture folder')
      return previous(`the helper exited ${run.code ?? 'without a status'}${said ? ` (${said})` : ''}`)
    }
    const listed = parseCaptureLine(run.stdout)
    if (!listed) return previous('a line from the helper it cannot read')
    ran += `; ${describeDisplays(listed)}`
    const pictures: Picture[] = []
    for (const d of listed) {
      let picture: Picture
      try { picture = decodeBmp32(p.readFile(join(folder, d.file))) } catch (err) {
        // A file system error's message holds the file's path: its code only.
        const why = err instanceof PictureError ? err.message : String((err as { code?: unknown })?.code ?? (err instanceof Error ? err.name : 'error'))
        return previous(`a picture it cannot read (${d.file}: ${why})`)
      }
      if (picture.width !== d.width || picture.height !== d.height) return previous(`a picture whose size is not its line's (${d.file})`)
      pictures.push(picture)
    }
    // The pictures are in memory: the folder goes before the overlay opens.
    p.removeFolder(folder)
    let appDisplays: AppDisplay[]
    try { appDisplays = p.displays() } catch { appDisplays = [] }
    const pairs = matchDisplays(listed, appDisplays)
    if (!pairs) return previous('a display it cannot match to the app\'s')
    const shown = pairs.map((pair, i) => ({ pair, picture: pictures[listed.indexOf(pair.helper)], i }))
    let answer: OverlayAnswer
    try {
      answer = await p.openOverlays(shown.map(({ pair, picture }) => ({
        id: pair.app.id,
        dipBounds: pair.app.dipBounds,
        scale: pair.app.scale,
        picture: p.toImage(picture, pair.app.scale),
      })))
    } catch (err) {
      return previous(`the overlay failed (${err instanceof Error ? firstLine(err.message) : 'error'})`)
    }
    if (answer === null) {
      p.log(`[snap] new engine: cancelled${ran}`)
      return { kind: 'cancelled' }
    }
    const chosen = shown.find((s) => s.pair.app.id === answer.id)
    if (!chosen) return previous('the overlay answered for a display it was not shown')
    let cut: Picture
    if ('whole' in answer && answer.whole === true) {
      cut = chosen.picture
    } else if ('rect' in answer) {
      const r = pixelRectFor(answer.rect, chosen.pair.app.scale, chosen.picture)
      if (!r) {
        p.log(`[snap] new engine: an empty rectangle${ran}; nothing captured`)
        return { kind: 'cancelled' }
      }
      cut = cropPicture(chosen.picture, r)
    } else {
      return previous('an answer from the overlay it cannot read')
    }
    let file: string
    try { file = p.save(cut) } catch (err) {
      return previous(`the picture could not be saved (${err instanceof Error ? err.name : 'error'})`)
    }
    p.log(`[snap] new engine: ${'rect' in answer ? 'a rectangle' : 'the whole screen'} of display ${chosen.i + 1}, ${cut.width}x${cut.height}${ran}`)
    return { kind: 'saved', file }
  } catch (err) {
    return previous(`an error (${err instanceof Error ? err.name : 'error'})`)
  } finally {
    p.removeFolder(folder)
  }
}
