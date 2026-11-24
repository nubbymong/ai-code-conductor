import { describe, it, expect } from 'vitest'
import { decodeBmp32, pixelRectFor, cropPicture, PictureError, BMP_HEADER_BYTES } from '../../../../src/main/snap/bmp'

/**
 * The new Snap reads the helper's pictures in memory (plan 2.1.3-beta.16 A1,
 * aicc_planning#401): a 32-bit BMP, rows from the bottom (capture.rs), turned
 * into rows from the top in the byte order nativeImage.createFromBitmap takes,
 * and the overlay's DIP rectangle cut from it at the display's physical pixels.
 * Not checked here: Electron's image from those bytes (snap-e2e reads it).
 */

/** A BMP as the capture mode writes it: `rows` from the top, each pixel
 *  [b, g, r]; stored from the bottom (a positive height) unless `topDown`. */
function bmp(rows: number[][][], topDown = false): Buffer {
  const height = rows.length
  const width = rows[0].length
  const pixels = Buffer.alloc(width * height * 4)
  rows.forEach((row, y) => {
    const stored = topDown ? y : height - 1 - y
    row.forEach(([b, g, r], x) => pixels.set([b, g, r, 255], (stored * width + x) * 4))
  })
  const h = Buffer.alloc(BMP_HEADER_BYTES)
  h.write('BM', 0, 'latin1')
  h.writeUInt32LE(BMP_HEADER_BYTES + pixels.length, 2)
  h.writeUInt32LE(BMP_HEADER_BYTES, 10)
  h.writeUInt32LE(40, 14)
  h.writeInt32LE(width, 18)
  h.writeInt32LE(topDown ? -height : height, 22)
  h.writeUInt16LE(1, 26)
  h.writeUInt16LE(32, 28)
  h.writeUInt32LE(0, 30)
  h.writeUInt32LE(pixels.length, 34)
  return Buffer.concat([h, pixels])
}

/** Pixel (x, y) of a picture as [b, g, r, a]. */
const px = (p: { width: number; bgra: Buffer }, x: number, y: number) => Array.from(p.bgra.subarray((y * p.width + x) * 4, (y * p.width + x) * 4 + 4))

// A 3 by 2 picture, each pixel its own colour: top row 1 2 3, bottom row 4 5 6.
const TOP = [[1, 1, 1], [2, 2, 2], [3, 3, 3]]
const BOTTOM = [[4, 4, 4], [5, 5, 5], [6, 6, 6]]

describe('decodeBmp32: the helper\'s 32-bit BMP, rows turned to read from the top', () => {
  it('reads a 3 by 2 picture stored from the bottom with its top row first', () => {
    const p = decodeBmp32(bmp([TOP, BOTTOM]))
    expect([p.width, p.height]).toEqual([3, 2])
    expect(p.bgra.length).toBe(3 * 2 * 4)
    expect([0, 1, 2].map((x) => px(p, x, 0))).toEqual([[1, 1, 1, 255], [2, 2, 2, 255], [3, 3, 3, 255]])
    expect([0, 1, 2].map((x) => px(p, x, 1))).toEqual([[4, 4, 4, 255], [5, 5, 5, 255], [6, 6, 6, 255]])
  })

  it('keeps a picture stored from the top (a negative height) as it is', () => {
    const p = decodeBmp32(bmp([TOP, BOTTOM], true))
    expect(px(p, 0, 0)).toEqual([1, 1, 1, 255])
    expect(px(p, 2, 1)).toEqual([6, 6, 6, 255])
  })

  it('refuses what is not a 32-bit uncompressed BMP, or is shorter than its pixels', () => {
    const good = bmp([TOP, BOTTOM])
    const bad = (edit: (b: Buffer) => void) => { const b = Buffer.from(good); edit(b); return b }
    expect(() => decodeBmp32(Buffer.alloc(10))).toThrow(PictureError)
    expect(() => decodeBmp32(bad((b) => b.write('XX', 0, 'latin1')))).toThrow(/not a BMP/)
    expect(() => decodeBmp32(bad((b) => b.writeUInt16LE(24, 28)))).toThrow(/32-bit/)
    expect(() => decodeBmp32(bad((b) => b.writeUInt32LE(3, 30)))).toThrow(/uncompressed/)
    expect(() => decodeBmp32(bad((b) => b.writeInt32LE(0, 18)))).toThrow(PictureError)
    expect(() => decodeBmp32(bad((b) => b.writeInt32LE(-0x80000000, 22)))).toThrow(PictureError)
    expect(() => decodeBmp32(good.subarray(0, good.length - 1))).toThrow(/shorter than its pixels/)
  })
})

describe('pixelRectFor and cropPicture: the overlay\'s DIP rectangle cut at the display\'s physical pixels', () => {
  // A 6 by 4 picture whose every pixel names its own x and y.
  const picture = { width: 6, height: 4, bgra: Buffer.alloc(6 * 4 * 4) }
  for (let y = 0; y < 4; y++) for (let x = 0; x < 6; x++) picture.bgra.set([x, y, 0, 255], (y * 6 + x) * 4)

  it('at 100% a DIP rectangle is the same rectangle of pixels', () => {
    expect(pixelRectFor({ x: 1, y: 1, width: 3, height: 2 }, 1, picture)).toEqual({ x: 1, y: 1, width: 3, height: 2 })
    const cut = cropPicture(picture, { x: 1, y: 1, width: 3, height: 2 })
    expect([cut.width, cut.height]).toEqual([3, 2])
    expect(px(cut, 0, 0)).toEqual([1, 1, 0, 255])
    expect(px(cut, 2, 1)).toEqual([3, 2, 0, 255])
  })

  it('at 150% each edge is times 1.5: a 2 by 2 DIP rectangle at (2, 0) is 3 by 3 pixels at (3, 0)', () => {
    const r = pixelRectFor({ x: 2, y: 0, width: 2, height: 2 }, 1.5, picture)
    expect(r).toEqual({ x: 3, y: 0, width: 3, height: 3 })
    const cut = cropPicture(picture, r!)
    expect(px(cut, 0, 0)).toEqual([3, 0, 0, 255])
    expect(px(cut, 2, 2)).toEqual([5, 2, 0, 255])
  })

  it('a 200 by 120 DIP rectangle is 300 by 180 pixels at 150%, wherever it starts', () => {
    const big = { width: 3000, height: 2000 }
    for (const x of [0, 1, 101, 333]) expect(pixelRectFor({ x, y: x, width: 200, height: 120 }, 1.5, big)).toMatchObject({ width: 300, height: 180 })
  })

  it('keeps the rectangle inside the picture, and answers none when nothing is left', () => {
    expect(pixelRectFor({ x: -2, y: -1, width: 4, height: 3 }, 1, picture)).toEqual({ x: 0, y: 0, width: 2, height: 2 })
    expect(pixelRectFor({ x: 5, y: 3, width: 10, height: 10 }, 1, picture)).toEqual({ x: 5, y: 3, width: 1, height: 1 })
    expect(pixelRectFor({ x: 6, y: 0, width: 4, height: 4 }, 1, picture)).toBeNull()
    expect(pixelRectFor({ x: 1, y: 1, width: 0, height: 2 }, 1, picture)).toBeNull()
    expect(pixelRectFor({ x: 1, y: 1, width: 2, height: 2 }, 0, picture)).toBeNull()
    expect(pixelRectFor({ x: Number.NaN, y: 1, width: 2, height: 2 }, 1, picture)).toBeNull()
  })

  it('refuses a crop outside its picture', () => {
    expect(() => cropPicture(picture, { x: 4, y: 0, width: 3, height: 1 })).toThrow(PictureError)
    expect(() => cropPicture(picture, { x: 0, y: 0, width: 0, height: 1 })).toThrow(PictureError)
  })
})
