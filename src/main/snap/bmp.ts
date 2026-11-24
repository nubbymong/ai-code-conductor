/**
 * The pictures the session helper's capture mode writes, read and cut in
 * memory (ADR-030 D3; plan 2.1.3-beta.16 A1, aicc_planning#401).
 *
 * The mode writes each display as a 32-bit BMP: a 54-byte header (a file
 * header and a BITMAPINFOHEADER), no compression, the rows from the bottom as
 * Windows hands them over, each pixel blue, green, red and a fourth byte of
 * 255 (helper/src/capture.rs). That byte order is the one Electron's
 * nativeImage.createFromBitmap takes on Windows, so a picture is its rows
 * turned the right way up and nothing else. Every size here is in physical
 * pixels.
 */

/** A picture as rows from the top, four bytes a pixel (blue, green, red, alpha). */
export interface Picture {
  width: number
  height: number
  bgra: Buffer
}

/** A rectangle in physical pixels, inside a picture. */
export interface PixelRect {
  x: number
  y: number
  width: number
  height: number
}

/** The bytes before a BMP's pixels when it has the plain header. */
export const BMP_HEADER_BYTES = 54
/** The longest side the capture mode writes (capture.rs MAX_SIDE). */
export const BMP_MAX_SIDE = 16_384

/** Why a file is not a picture this reads. */
export class PictureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PictureError'
  }
}

/** Read a 32-bit, uncompressed BMP into rows from the top. Rows stored from
 *  the bottom (a positive height, as the mode writes them) are turned; rows
 *  from the top (a negative height) are kept. Throws PictureError for anything
 *  else, or a file shorter than its pixels. */
export function decodeBmp32(buf: Buffer): Picture {
  if (buf.length < BMP_HEADER_BYTES) throw new PictureError('a picture shorter than its header')
  if (buf[0] !== 0x42 || buf[1] !== 0x4d) throw new PictureError('not a BMP')
  const offset = buf.readUInt32LE(10)
  const infoSize = buf.readUInt32LE(14)
  const width = buf.readInt32LE(18)
  const rawHeight = buf.readInt32LE(22)
  const planes = buf.readUInt16LE(26)
  const bits = buf.readUInt16LE(28)
  const compression = buf.readUInt32LE(30)
  if (infoSize < 40 || planes !== 1 || bits !== 32 || compression !== 0) throw new PictureError('not a 32-bit uncompressed BMP')
  const height = Math.abs(rawHeight)
  if (width < 1 || height < 1 || width > BMP_MAX_SIDE || height > BMP_MAX_SIDE) throw new PictureError(`a picture of ${width}x${rawHeight}`)
  const stride = width * 4
  if (offset < BMP_HEADER_BYTES || offset + stride * height > buf.length) throw new PictureError('a picture shorter than its pixels')
  const bgra = Buffer.allocUnsafe(stride * height)
  const fromBottom = rawHeight > 0
  for (let row = 0; row < height; row++) {
    const from = offset + (fromBottom ? height - 1 - row : row) * stride
    buf.copy(bgra, row * stride, from, from + stride)
  }
  return { width, height, bgra }
}

/** A rectangle in DIP inside a display, as the overlay answers it, in that
 *  display's picture: each edge times the display's scale, rounded, then kept
 *  inside the picture. Null when nothing is left. */
export function pixelRectFor(rect: { x: number; y: number; width: number; height: number }, scale: number, picture: { width: number; height: number }): PixelRect | null {
  if (![rect.x, rect.y, rect.width, rect.height, scale].every(Number.isFinite) || scale <= 0) return null
  const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v))
  const left = clamp(Math.round(rect.x * scale), picture.width)
  const top = clamp(Math.round(rect.y * scale), picture.height)
  const right = clamp(Math.round((rect.x + rect.width) * scale), picture.width)
  const bottom = clamp(Math.round((rect.y + rect.height) * scale), picture.height)
  if (right - left < 1 || bottom - top < 1) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** The part of a picture inside `r` (physical pixels, inside the picture). */
export function cropPicture(picture: Picture, r: PixelRect): Picture {
  if (r.x < 0 || r.y < 0 || r.width < 1 || r.height < 1 || r.x + r.width > picture.width || r.y + r.height > picture.height) {
    throw new PictureError('a crop outside its picture')
  }
  const from = picture.width * 4
  const to = r.width * 4
  const bgra = Buffer.allocUnsafe(to * r.height)
  for (let row = 0; row < r.height; row++) {
    const start = (r.y + row) * from + r.x * 4
    picture.bgra.copy(bgra, row * to, start, start + to)
  }
  return { width: r.width, height: r.height, bgra }
}
