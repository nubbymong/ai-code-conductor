// The clipboard formats a picture is written in on macOS and Linux app
// machines (ADR-032's table; plan 2.1.3-beta.21 phase 3, 3.1). Pure: no
// Electron, so the paste e2e builds the same item the app writes
// (tests/e2e/paste-unix.spec.ts).
//
// macOS: public.png and public.tiff, the two in one item. Claude Code reads
// the clipboard as «class PNGf» (public.png) only; the other CLI's read
// (arboard) takes NSPasteboardTypeTIFF (public.tiff) only, as each
// provider's table says (formats). Each is written as the platform's
// own format through Electron 44's raw format key (`electron
// application/osclipboard;format="<name>"`), so nothing re-encodes either.
// Electron has no TIFF encoder, so the TIFF is made here from the PNG's own
// pixels: a baseline TIFF, 8 bits a sample, RGBA with unassociated alpha (the
// PNG's alpha is not premultiplied), one uncompressed strip. Its pixels are
// the PNG's exactly. A PNG this file cannot read (16-bit, interlaced, or one
// over MAX_TIFF_PIXELS) is written as public.png alone: Claude Code still
// reads it, and the picture is never refused for its TIFF.
//
// Linux: image/png, through the W3C-shaped key as on Windows. Claude Code's
// xclip or wl-paste and the other CLI's arboard all ask the clipboard for
// image/png.
import { inflateSync } from 'zlib'

/** The key Electron 44's clipboard.write takes for a platform format by its
 *  own name. */
export function osClipboardFormat(name: string): string {
  return `electron application/osclipboard;format="${name}"`
}

/** One format of one clipboard item: its key and its bytes. */
export interface PictureFormat {
  type: string
  bytes: Buffer
}

/** The largest picture made into a TIFF: a Snap's bound, 1920 pixels on its
 *  longer side (SCREENSHOT_MAX_DIM, src/main/screenshot-capture.ts), so at
 *  most 1920 by 1920. Only a Snap needs the TIFF: it is written for both
 *  CLIs, and the other CLI's read (arboard) takes TIFF only there. A copied
 *  image file is written for Claude Code alone, which reads public.png only
 *  (the other CLI reads the file itself), and it can be a photo
 *  of tens of megapixels, whose TIFF (4 bytes a pixel, built on the main
 *  thread) would stall every terminal's output for hundreds of milliseconds
 *  (review round 1, N3). A larger picture is written as public.png alone. */
export const MAX_TIFF_PIXELS = 1920 * 1920

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/**
 * A PNG's pixels as 8-bit RGBA (not premultiplied), or null: not a PNG, a
 * cut chunk, a bit depth other than 8, interlaced, too large, or a bad
 * filter. Greyscale, greyscale with alpha, RGB, RGBA and palette pictures
 * (tRNS included); a picture with no alpha reads as opaque. The same reading
 * as the probes' decoder (helper/probes/png-rgba.cjs), which names a picture
 * by these pixels.
 */
export function decodePngRgba(png: Buffer): { width: number; height: number; rgba: Buffer } | null {
  if (!Buffer.isBuffer(png) || png.length < 33 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  let at = 8
  let ihdr: { width: number; height: number; depth: number; color: number; interlace: number } | null = null
  let palette: Buffer | null = null
  let trns: Buffer | null = null
  const idat: Buffer[] = []
  while (at + 8 <= png.length) {
    const len = png.readUInt32BE(at)
    const type = png.toString('latin1', at + 4, at + 8)
    const data = png.subarray(at + 8, at + 8 + len)
    if (data.length !== len) return null
    if (type === 'IHDR') {
      if (len < 13) return null
      ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] }
    } else if (type === 'PLTE') palette = data
    else if (type === 'tRNS') trns = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    at += 12 + len
  }
  if (!ihdr) return null
  const { width, height, depth, color, interlace } = ihdr
  if (depth !== 8 || interlace !== 0 || width === 0 || height === 0 || width * height > MAX_TIFF_PIXELS) return null
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color]
  if (!channels || (color === 3 && !palette)) return null
  let raw: Buffer
  try { raw = inflateSync(Buffer.concat(idat)) } catch { return null }
  const stride = width * channels
  if (raw.length < height * (stride + 1)) return null
  const lines = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const out = y * stride
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x]
      const a = x >= channels ? lines[out + x - channels] : 0
      const b = y > 0 ? lines[out - stride + x] : 0
      const c = x >= channels && y > 0 ? lines[out - stride + x - channels] : 0
      let r: number
      if (filter === 0) r = v
      else if (filter === 1) r = v + a
      else if (filter === 2) r = v + b
      else if (filter === 3) r = v + ((a + b) >> 1)
      else if (filter === 4) r = v + paeth(a, b, c)
      else return null
      lines[out + x] = r & 0xff
    }
  }
  const rgba = Buffer.alloc(width * height * 4)
  for (let i = 0, p = 0; i < width * height; i++, p += channels) {
    let r: number
    let g: number
    let b: number
    let a = 255
    if (color === 6) { r = lines[p]; g = lines[p + 1]; b = lines[p + 2]; a = lines[p + 3] }
    else if (color === 2) {
      r = lines[p]; g = lines[p + 1]; b = lines[p + 2]
      if (trns && trns.length >= 6 && trns.readUInt16BE(0) === r && trns.readUInt16BE(2) === g && trns.readUInt16BE(4) === b) a = 0
    } else if (color === 0) {
      r = g = b = lines[p]
      if (trns && trns.length >= 2 && trns.readUInt16BE(0) === r) a = 0
    } else if (color === 4) { r = g = b = lines[p]; a = lines[p + 1] }
    else {
      const k = lines[p]
      if (!palette || k * 3 + 2 >= palette.length) return null
      r = palette[k * 3]; g = palette[k * 3 + 1]; b = palette[k * 3 + 2]
      if (trns && k < trns.length) a = trns[k]
    }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a
  }
  return { width, height, rgba }
}

/**
 * A baseline TIFF (little-endian) of `rgba`: 8 bits a sample, four samples
 * a pixel (RGB and unassociated alpha, ExtraSamples 2), uncompressed, one
 * strip, 72 pixels an inch. The tags in ascending order, every offset on a
 * word boundary.
 */
export function encodeRgbaTiff(width: number, height: number, rgba: Buffer): Buffer {
  const pixelBytes = width * height * 4
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || rgba.length < pixelBytes) {
    throw new Error('encodeRgbaTiff: the size does not match the pixels')
  }
  const SHORT = 3
  const LONG = 4
  const RATIONAL = 5
  const entries = 14
  const ifdAt = 8
  const ifdSize = 2 + entries * 12 + 4
  const bitsAt = ifdAt + ifdSize
  const xResAt = bitsAt + 8
  const yResAt = xResAt + 8
  const dataAt = yResAt + 8
  const out = Buffer.alloc(dataAt + pixelBytes)
  out.write('II', 0, 'latin1')
  out.writeUInt16LE(42, 2)
  out.writeUInt32LE(ifdAt, 4)
  out.writeUInt16LE(entries, ifdAt)
  let at = ifdAt + 2
  const tag = (id: number, type: number, count: number, value: number) => {
    out.writeUInt16LE(id, at)
    out.writeUInt16LE(type, at + 2)
    out.writeUInt32LE(count, at + 4)
    if (type === SHORT && count === 1) out.writeUInt16LE(value, at + 8)
    else out.writeUInt32LE(value, at + 8)
    at += 12
  }
  tag(256, LONG, 1, width) // ImageWidth
  tag(257, LONG, 1, height) // ImageLength
  tag(258, SHORT, 4, bitsAt) // BitsPerSample: 8, 8, 8, 8
  tag(259, SHORT, 1, 1) // Compression: none
  tag(262, SHORT, 1, 2) // PhotometricInterpretation: RGB
  tag(273, LONG, 1, dataAt) // StripOffsets
  tag(277, SHORT, 1, 4) // SamplesPerPixel
  tag(278, LONG, 1, height) // RowsPerStrip: the whole picture
  tag(279, LONG, 1, pixelBytes) // StripByteCounts
  tag(282, RATIONAL, 1, xResAt) // XResolution
  tag(283, RATIONAL, 1, yResAt) // YResolution
  tag(284, SHORT, 1, 1) // PlanarConfiguration: chunky
  tag(296, SHORT, 1, 2) // ResolutionUnit: inch
  tag(338, SHORT, 1, 2) // ExtraSamples: unassociated alpha
  out.writeUInt32LE(0, at) // no next image
  for (let k = 0; k < 4; k++) out.writeUInt16LE(8, bitsAt + k * 2)
  out.writeUInt32LE(72, xResAt); out.writeUInt32LE(1, xResAt + 4)
  out.writeUInt32LE(72, yResAt); out.writeUInt32LE(1, yResAt + 4)
  rgba.copy(out, dataAt, 0, pixelBytes)
  return out
}

/** macOS: public.png (the PNG's own bytes) and public.tiff (its pixels), or
 *  public.png alone when the PNG cannot be read for a TIFF. */
export function macPictureFormats(png: Buffer): PictureFormat[] {
  const out: PictureFormat[] = [{ type: osClipboardFormat('public.png'), bytes: png }]
  const pixels = decodePngRgba(png)
  if (pixels) out.push({ type: osClipboardFormat('public.tiff'), bytes: encodeRgbaTiff(pixels.width, pixels.height, pixels.rgba) })
  return out
}

/** Linux: image/png, the PNG's own bytes. */
export function linuxPictureFormats(png: Buffer): PictureFormat[] {
  return [{ type: 'image/png', bytes: png }]
}
