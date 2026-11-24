import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { snapWithHelper, matchDisplays, type SnapPorts, type AppDisplay, type OverlayAnswer, type OverlayDisplay } from '../../../../src/main/snap/engine'
import { BMP_HEADER_BYTES, type Picture } from '../../../../src/main/snap/bmp'
import type { HelperCaptureRun, HelperDisplay } from '../../../../src/main/snap/helper-capture'

/**
 * One press of the new Snap on Windows (plan 2.1.3-beta.16 A1,
 * aicc_planning#401), with every port a fake: the helper's run, its pictures,
 * Electron's displays, the overlay and the save. What is checked:
 *   - each picture reaches the overlay at its display's physical size, with
 *     the display's scale, and the answer is cut at physical pixels (100%,
 *     150%, a display left of the primary), or the display whole;
 *   - Escape (null) captures nothing; exit 3 captures nothing; every other
 *     failure hands the press to the previous Snap with one line saying why;
 *   - the press folder is removed on every path, and before the overlay opens;
 *   - one log line a press, naming the helper's time and each display, never
 *     a path.
 * Not checked here: Electron, the real helper and the real overlay (snap-e2e).
 */

type Img = { width: number; height: number; scale: number; display: number }

/** A BMP as the mode writes it, every pixel [x, y, display, 255] (x and y mod 256), rows from the bottom. */
function bmp(width: number, height: number, display: number): Buffer {
  const pixels = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set([x % 256, y % 256, display, 255], ((height - 1 - y) * width + x) * 4)
  const h = Buffer.alloc(BMP_HEADER_BYTES)
  h.write('BM', 0, 'latin1')
  h.writeUInt32LE(BMP_HEADER_BYTES, 10)
  h.writeUInt32LE(40, 14)
  h.writeInt32LE(width, 18)
  h.writeInt32LE(height, 22)
  h.writeUInt16LE(1, 26)
  h.writeUInt16LE(32, 28)
  return Buffer.concat([h, pixels])
}

const px = (p: Picture, x: number, y: number) => Array.from(p.bgra.subarray((y * p.width + x) * 4, (y * p.width + x) * 4 + 4))

/** A display both ways: as the helper lists it and as Electron does. `n`
 *  marks its picture's pixels, so a test can tell whose picture it holds. */
interface Screen { n: number; helper: HelperDisplay; app: AppDisplay }
const screen = (n: number, id: number, phys: { left: number; top: number; width: number; height: number }, scale: number, primary: boolean): Screen => ({
  n,
  helper: { file: `display-${n}.bmp`, ...phys, dpi: Math.round(96 * scale), scale: Math.round(scale * 100), primary },
  app: {
    id,
    dipBounds: { x: Math.round(phys.left / scale), y: Math.round(phys.top / scale), width: Math.round(phys.width / scale), height: Math.round(phys.height / scale) },
    scale,
    physical: { x: phys.left, y: phys.top, width: phys.width, height: phys.height },
  },
})

// Small displays, so the pictures are small: a primary at 100%, one at 150%
// to its right, and one at 100% to the left of the primary (negative x).
const PRIMARY = screen(1, 101, { left: 0, top: 0, width: 40, height: 30 }, 1, true)
const HIGH = screen(2, 202, { left: 40, top: 0, width: 60, height: 45 }, 1.5, false)
const LEFT = screen(3, 303, { left: -32, top: 0, width: 32, height: 24 }, 1, false)

const FOLDER = 'C:\\data\\snap-capture\\press-abc'

interface Opts {
  screens?: Screen[]
  run?: HelperCaptureRun
  line?: string
  files?: Record<string, Buffer>
  appDisplays?: AppDisplay[]
  answer?: OverlayAnswer | ((shown: OverlayDisplay<Img>[]) => OverlayAnswer)
  overlayThrows?: string
  /** The overlay rejects as overlay.ts does: a SnapOverlayError with its reason. */
  overlayReason?: string
  helper?: string | null
  makeFolderThrows?: boolean
  saveThrows?: boolean
}

function press(o: Opts = {}) {
  const screens = o.screens ?? [PRIMARY]
  // The helper names its files display-1.bmp, display-2.bmp ... in the order it lists them.
  const listed = screens.map((s, i) => ({ ...s.helper, file: `display-${i + 1}.bmp` }))
  const line = o.line ?? JSON.stringify({ displays: listed })
  const files = o.files ?? Object.fromEntries(screens.map((s, i) => [join(FOLDER, listed[i].file), bmp(s.helper.width, s.helper.height, s.n)]))
  const calls = { made: 0, removed: [] as string[], removedBeforeOverlay: false, shown: null as OverlayDisplay<Img>[] | null, saved: [] as Picture[], log: [] as string[], ran: [] as Array<[string, string]> }
  const ports: SnapPorts<Img> = {
    helperPath: () => (o.helper === undefined ? 'C:\\app\\resources\\helper\\aicc-helper.exe' : o.helper),
    makeFolder: () => {
      if (o.makeFolderThrows) throw new Error('EPERM')
      calls.made++
      return FOLDER
    },
    removeFolder: (f) => { calls.removed.push(f) },
    runHelper: async (helper, folder) => {
      calls.ran.push([helper, folder])
      return o.run ?? { kind: 'exit', code: 0, stdout: `${line}\r\n`, stderr: '', ms: 58 }
    },
    readFile: (f) => {
      const b = files[f]
      if (!b) throw Object.assign(new Error(`ENOENT: ${f}`), { code: 'ENOENT' })
      return b
    },
    displays: () => o.appDisplays ?? screens.map((s) => s.app),
    toImage: (p, scale) => ({ width: p.width, height: p.height, scale, display: p.bgra[2] }),
    openOverlays: async (shown) => {
      calls.removedBeforeOverlay = calls.removed.includes(FOLDER)
      calls.shown = shown
      if (o.overlayThrows) throw new Error(o.overlayThrows)
      if (o.overlayReason) throw Object.assign(new Error(`the Snap overlay failed: ${o.overlayReason}`), { name: 'SnapOverlayError', reason: o.overlayReason })
      const a = o.answer === undefined ? null : o.answer
      return typeof a === 'function' ? a(shown) : a
    },
    save: (p) => {
      if (o.saveThrows) throw new Error('ENOSPC')
      calls.saved.push(p)
      return 'C:\\res\\screenshots\\screenshot-1.jpg'
    },
    log: (l) => { calls.log.push(l) },
  }
  return { result: snapWithHelper(ports), calls }
}

describe('a press that works: the overlay gets each display\'s picture, and the answer is cut at physical pixels', () => {
  it('runs the helper into the press folder, and shows each picture at its display\'s physical size with its scale', async () => {
    const { result, calls } = press({ screens: [PRIMARY, HIGH, LEFT], answer: null })
    expect(await result).toEqual({ kind: 'cancelled' })
    expect(calls.ran).toEqual([['C:\\app\\resources\\helper\\aicc-helper.exe', FOLDER]])
    expect(calls.shown!.map((s) => ({ id: s.id, scale: s.scale, size: [s.picture.width, s.picture.height], picScale: s.picture.scale, dip: s.dipBounds }))).toEqual([
      { id: 101, scale: 1, size: [40, 30], picScale: 1, dip: { x: 0, y: 0, width: 40, height: 30 } },
      { id: 202, scale: 1.5, size: [60, 45], picScale: 1.5, dip: { x: 27, y: 0, width: 40, height: 30 } },
      { id: 303, scale: 1, size: [32, 24], picScale: 1, dip: { x: -32, y: 0, width: 32, height: 24 } },
    ])
    // Each display got its own picture.
    expect(calls.shown!.map((s) => s.picture.display)).toEqual([1, 2, 3])
  })

  it('at 100%, a rectangle is cut at the same pixels, rows the right way up', async () => {
    const { result, calls } = press({ answer: { id: 101, rect: { x: 5, y: 4, width: 20, height: 12 } } })
    expect(await result).toEqual({ kind: 'saved', file: 'C:\\res\\screenshots\\screenshot-1.jpg' })
    const cut = calls.saved[0]
    expect([cut.width, cut.height]).toEqual([20, 12])
    expect(px(cut, 0, 0)).toEqual([5, 4, 1, 255])
    expect(px(cut, 19, 11)).toEqual([24, 15, 1, 255])
  })

  it('at 150%, the DIP rectangle is cut at its display\'s physical pixels (each edge times 1.5)', async () => {
    const { result, calls } = press({ screens: [PRIMARY, HIGH], answer: { id: 202, rect: { x: 4, y: 2, width: 20, height: 12 } } })
    expect((await result).kind).toBe('saved')
    const cut = calls.saved[0]
    expect([cut.width, cut.height]).toEqual([30, 18])
    expect(px(cut, 0, 0)).toEqual([6, 3, 2, 255])
    expect(px(cut, 29, 17)).toEqual([35, 20, 2, 255])
  })

  it('on a display left of the primary, the rectangle is cut from that display\'s own picture', async () => {
    const { result, calls } = press({ screens: [PRIMARY, LEFT], answer: { id: 303, rect: { x: 2, y: 3, width: 10, height: 5 } } })
    expect((await result).kind).toBe('saved')
    const cut = calls.saved[0]
    expect([cut.width, cut.height]).toEqual([10, 5])
    expect(px(cut, 0, 0)).toEqual([2, 3, 3, 255])
  })

  it('Whole screen saves that display\'s whole picture, at its physical size', async () => {
    const { result, calls } = press({ screens: [PRIMARY, HIGH], answer: { id: 202, whole: true } })
    expect((await result).kind).toBe('saved')
    expect([calls.saved[0].width, calls.saved[0].height]).toEqual([60, 45])
    expect(px(calls.saved[0], 59, 44)).toEqual([59, 44, 2, 255])
  })

  it('logs one line: the engine, the helper\'s time, each display\'s size and scale, and what was taken; never a path', async () => {
    const { result, calls } = press({ screens: [PRIMARY, HIGH], answer: { id: 202, whole: true } })
    await result
    expect(calls.log).toEqual(['[snap] new engine: the whole screen of display 2, 60x45; the helper took 58 ms; display 1 40x30 at 100% (primary), display 2 60x45 at 150%'])
    const rect = press({ answer: { id: 101, rect: { x: 0, y: 0, width: 4, height: 4 } } })
    await rect.result
    expect(rect.calls.log).toEqual(['[snap] new engine: a rectangle of display 1, 4x4; the helper took 58 ms; display 1 40x30 at 100% (primary)'])
    for (const l of [...calls.log, ...rect.calls.log]) expect(l).not.toMatch(/[A-Z]:\\|press-|screenshot-/)
  })
})

describe('nothing captured: Escape, an empty rectangle, and exit 3', () => {
  it('Escape (the overlay answers null) saves nothing and does not hand the press on', async () => {
    const { result, calls } = press({ answer: null })
    expect(await result).toEqual({ kind: 'cancelled' })
    expect(calls.saved).toHaveLength(0)
    expect(calls.log).toEqual(['[snap] new engine: cancelled; the helper took 58 ms; display 1 40x30 at 100% (primary)'])
  })

  it('a rectangle with nothing left inside the display saves nothing', async () => {
    const { result, calls } = press({ answer: { id: 101, rect: { x: 50, y: 0, width: 5, height: 5 } } })
    expect(await result).toEqual({ kind: 'cancelled' })
    expect(calls.saved).toHaveLength(0)
  })

  it('exit 3 (no desktop to capture) captures nothing, opens no overlay, and logs that it was exit 3', async () => {
    const { result, calls } = press({ run: { kind: 'exit', code: 3, stdout: '', stderr: 'no desktop', ms: 7 } })
    expect(await result).toEqual({ kind: 'no-desktop' })
    expect(calls.shown).toBeNull()
    expect(calls.log).toEqual(['[snap] new engine: no desktop to capture (exit 3); the helper took 7 ms; nothing captured'])
  })
})

describe('every other failure hands the press to the previous Snap, with one line saying why', () => {
  const cases: Array<[string, Opts, RegExp]> = [
    ['exit 1', { run: { kind: 'exit', code: 1, stdout: '', stderr: 'grab failed\nmore', ms: 9 } }, /the helper exited 1 \(grab failed\)/],
    ['exit 2', { run: { kind: 'exit', code: 2, stdout: '', stderr: 'usage', ms: 9 } }, /the helper exited 2/],
    ['exit 4', { run: { kind: 'exit', code: 4, stdout: '', stderr: '', ms: 9 } }, /the helper exited 4;/],
    ['no answer in time', { run: { kind: 'no-answer', ms: 2000 } }, /no answer from the helper in time; it was ended; the helper took 2000 ms/],
    ['a start that fails', { run: { kind: 'start-failed', why: 'spawn ENOENT', ms: 1 } }, /the helper could not start \(spawn ENOENT\)/],
    ['too much output', { run: { kind: 'too-much-output', ms: 3 } }, /more than its one line/],
    ['an unreadable line', { line: 'garbage' }, /a line from the helper it cannot read/],
    ['a missing picture', { files: {} }, /a picture it cannot read \(display-1\.bmp: ENOENT/],
    ['a picture not a BMP', { files: { [join(FOLDER, 'display-1.bmp')]: Buffer.alloc(80) } }, /a picture it cannot read \(display-1\.bmp: not a BMP\)/],
    ['a picture of another size', { files: { [join(FOLDER, 'display-1.bmp')]: bmp(41, 30, 1) } }, /a picture whose size is not its line's/],
    ['an unmatched display', { appDisplays: [{ ...PRIMARY.app, physical: { x: 0, y: 0, width: 1024, height: 768 } }] }, /a display it cannot match/],
    ['a display Electron does not list', { appDisplays: [] }, /a display it cannot match/],
    ['an overlay that fails', { overlayThrows: 'the page did not load\nstack' }, /the overlay failed \(the page did not load\)/],
    ['an overlay that fails with its own reason', { overlayReason: 'no-ready' }, /the overlay failed \(no-ready\);/],
    ['an answer for a display not shown', { answer: { id: 999, whole: true } }, /a display it was not shown/],
    ['a save that fails', { answer: { id: 101, whole: true }, saveThrows: true }, /the picture could not be saved/],
    ['no helper', { helper: null }, /no session helper to run/],
    ['a folder that cannot be made', { makeFolderThrows: true }, /the capture folder could not be made/],
  ]
  for (const [name, opts, why] of cases) {
    it(name, async () => {
      const { result, calls } = press(opts)
      const r = await result
      expect(r.kind, JSON.stringify(r)).toBe('previous')
      expect(calls.saved).toHaveLength(0)
      expect(calls.log).toHaveLength(1)
      expect(calls.log[0]).toMatch(why)
      expect(calls.log[0]).toMatch(/^\[snap\] new engine: .*; the previous Snap takes this press$/)
      expect(calls.log[0]).not.toMatch(/press-abc/)
    })
  }
})

describe('the press folder is removed on every path, and before the overlay opens', () => {
  const paths: Array<[string, Opts]> = [
    ['saved', { answer: { id: 101, whole: true } }],
    ['cancelled', { answer: null }],
    ['exit 3', { run: { kind: 'exit', code: 3, stdout: '', stderr: '', ms: 1 } }],
    ['exit 1', { run: { kind: 'exit', code: 1, stdout: '', stderr: '', ms: 1 } }],
    ['no answer', { run: { kind: 'no-answer', ms: 2000 } }],
    ['an unreadable line', { line: '{' }],
    ['a missing picture', { files: {} }],
    ['an unmatched display', { appDisplays: [] }],
    ['an overlay that fails', { overlayThrows: 'gone' }],
    ['a save that fails', { answer: { id: 101, whole: true }, saveThrows: true }],
  ]
  for (const [name, opts] of paths) {
    it(name, async () => {
      const { result, calls } = press(opts)
      await result
      expect(calls.made).toBe(1)
      expect(calls.removed.length).toBeGreaterThanOrEqual(1)
      expect(new Set(calls.removed)).toEqual(new Set([FOLDER]))
    })
  }

  it('the pictures are off the disk before the overlay shows them', async () => {
    const { result, calls } = press({ answer: null })
    await result
    expect(calls.removedBeforeOverlay).toBe(true)
  })

  it('no folder is made, and none removed, when there is no helper to run', async () => {
    const { result, calls } = press({ helper: null })
    await result
    expect(calls.made).toBe(0)
    expect(calls.removed).toEqual([])
  })
})

describe('matchDisplays: each picture to one of Electron\'s displays, by physical bounds', () => {
  it('pairs by bounds, not by order, and allows one pixel of rounding on an edge', () => {
    const pairs = matchDisplays([PRIMARY.helper, HIGH.helper], [HIGH.app, PRIMARY.app])
    expect(pairs!.map((p) => [p.helper.file, p.app.id])).toEqual([['display-1.bmp', 101], ['display-2.bmp', 202]])
    const rounded = { ...HIGH.app, physical: { x: 40, y: 0, width: 61, height: 44 } }
    expect(matchDisplays([HIGH.helper], [rounded])).not.toBeNull()
  })

  it('matches nothing when the counts differ, an edge is two pixels out, or two pictures would share one display', () => {
    expect(matchDisplays([PRIMARY.helper], [PRIMARY.app, HIGH.app])).toBeNull()
    expect(matchDisplays([PRIMARY.helper], [{ ...PRIMARY.app, physical: { x: 0, y: 0, width: 42, height: 30 } }])).toBeNull()
    expect(matchDisplays([PRIMARY.helper, PRIMARY.helper], [PRIMARY.app, { ...PRIMARY.app, id: 5, physical: { x: 500, y: 0, width: 40, height: 30 } }])).toBeNull()
  })
})
