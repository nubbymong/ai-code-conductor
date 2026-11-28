// The clipboard writers for macOS and Linux app machines (ADR-032; plan
// 2.1.3-beta.21 phase 3, 3.1): the picture onto this computer's clipboard in
// the formats each CLI's read takes there.
//  - macOS: public.png (Claude Code reads «class PNGf») and public.tiff (Codex
//    reads TIFF only there, through arboard), both in ONE clipboard.write of
//    one item, so the two can never belong to two different pictures. The
//    TIFF is made here from the PNG's own pixels (Electron has no TIFF
//    encoder), so its pixels are the PNG's exactly.
//  - Linux: image/png, one write of one item (Claude Code's xclip or
//    wl-paste and Codex's arboard all ask for image/png).
//  - Each registered provider's formats for that OS are written.
//  - A write that throws answers `failed`; neither writer answers `not-yet`
//    any more (plan s6's lines go where 3.1 makes the route work).
// Red on e89996bb: both writers answered `not-yet` and wrote nothing.
// Mutants this must catch: TIFF dropped on macOS; the TIFF's pixels not the
// PNG's (an RGBA order swapped); two writes in place of one.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { deflateSync } from 'node:zlib'
import { createRequire } from 'node:module'

type Item = { types: string[]; items: Record<string, unknown> }
const writes: Item[][] = []
let failWrite = false
vi.mock('electron', () => {
  class ClipboardItem {
    readonly types: string[]
    readonly items: Record<string, unknown>
    constructor(items: Record<string, unknown>) { this.items = items; this.types = Object.keys(items) }
  }
  return {
    ClipboardItem,
    clipboard: { write: vi.fn(async (items: Item[]) => { if (failWrite) throw new Error('the clipboard refused'); writes.push(items) }) },
  }
})

const writer = await import('../../../src/main/paste/clipboard-writer')
const formats = await import('../../../src/main/paste/picture-formats')
const { CLAUDE_CLIPBOARD_PASTE } = await import('../../../src/main/providers/claude/clipboard-paste')
const { CODEX_CLIPBOARD_PASTE } = await import('../../../src/main/providers/codex/clipboard-paste')
const { decodePngRgba } = createRequire(import.meta.url)('../../../helper/probes/png-rgba.cjs') as { decodePngRgba: (b: Buffer) => { width?: number; height?: number; rgba?: Buffer; unread?: string } }

// ── a PNG made here, each row by its own filter, so the decoder meets all five ──
function crc32(buf: Buffer): number {
  let c = ~0
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) }
  return ~c >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
const paeth = (a: number, b: number, c: number) => { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
/** An 8-bit PNG of `rgba` (colour type 6), or of its RGB (type 2), each row filtered by `row % 5`. */
function makePng(width: number, height: number, rgba: Buffer, color: 2 | 6 = 6): Buffer {
  const ch = color === 6 ? 4 : 3
  const stride = width * ch
  const lines = Buffer.alloc(height * stride)
  for (let i = 0; i < width * height; i++) for (let k = 0; k < ch; k++) lines[i * ch + k] = rgba[i * 4 + k]
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    const f = y % 5
    raw[y * (stride + 1)] = f
    for (let x = 0; x < stride; x++) {
      const v = lines[y * stride + x]
      const a = x >= ch ? lines[y * stride + x - ch] : 0
      const b = y > 0 ? lines[(y - 1) * stride + x] : 0
      const c = x >= ch && y > 0 ? lines[(y - 1) * stride + x - ch] : 0
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c)
      raw[y * (stride + 1) + 1 + x] = (v - pred) & 0xff
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = color; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
/** A pattern with every channel different and some alpha. */
function pattern(width: number, height: number, opaque = false): Buffer {
  const out = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4
    out[i] = (x * 37 + 11) & 0xff; out[i + 1] = (y * 53 + 7) & 0xff; out[i + 2] = ((x ^ y) * 29 + 3) & 0xff; out[i + 3] = opaque ? 255 : (x * 13 + y * 7 + 40) & 0xff
  }
  return out
}

// ── a TIFF read here: the baseline tags and the one strip ──
function readTiff(buf: Buffer): { tags: Map<number, number[]>; pixels: Buffer } {
  expect(buf.toString('latin1', 0, 2)).toBe('II')
  expect(buf.readUInt16LE(2)).toBe(42)
  const ifd = buf.readUInt32LE(4)
  const n = buf.readUInt16LE(ifd)
  const tags = new Map<number, number[]>()
  let last = 0
  for (let k = 0; k < n; k++) {
    const at = ifd + 2 + k * 12
    const tag = buf.readUInt16LE(at)
    expect(tag, 'the tags are in ascending order').toBeGreaterThan(last)
    last = tag
    const type = buf.readUInt16LE(at + 2)
    const count = buf.readUInt32LE(at + 4)
    const size = ({ 3: 2, 4: 4, 5: 8 } as Record<number, number>)[type]
    expect(size, `tag ${tag}: a type this reader knows`).toBeDefined()
    const where = count * size <= 4 ? at + 8 : buf.readUInt32LE(at + 8)
    const values: number[] = []
    for (let i = 0; i < count; i++) {
      if (type === 3) values.push(buf.readUInt16LE(where + i * 2))
      else if (type === 4) values.push(buf.readUInt32LE(where + i * 4))
      else values.push(buf.readUInt32LE(where + i * 8) / buf.readUInt32LE(where + i * 8 + 4))
    }
    tags.set(tag, values)
  }
  expect(buf.readUInt32LE(ifd + 2 + n * 12), 'one image only').toBe(0)
  const off = tags.get(273)![0]
  const len = tags.get(279)![0]
  return { tags, pixels: buf.subarray(off, off + len) }
}

const RAW = (name: string) => `electron application/osclipboard;format="${name}"`
const bytesOf = async (v: unknown) => Buffer.from(await (v as Blob).arrayBuffer())

beforeEach(() => { writes.length = 0; failWrite = false })

describe('the PNG\'s pixels (the TIFF is made from them)', () => {
  it('decodes every filter, RGBA and RGB, exactly as the probes\' decoder does', () => {
    const rgba = pattern(23, 17)
    const png = makePng(23, 17, rgba)
    const got = formats.decodePngRgba(png)
    expect(got).not.toBeNull()
    expect(got!.width).toBe(23)
    expect(got!.height).toBe(17)
    expect(Buffer.from(got!.rgba).equals(rgba)).toBe(true)
    expect(Buffer.from(got!.rgba).equals(decodePngRgba(png).rgba!)).toBe(true)
    const opaque = pattern(9, 6, true)
    const rgb = formats.decodePngRgba(makePng(9, 6, opaque, 2))
    expect(Buffer.from(rgb!.rgba).equals(opaque)).toBe(true)
  })

  it('answers null for what it does not read: not a PNG, a cut one, 16-bit', () => {
    expect(formats.decodePngRgba(Buffer.from('not a png at all, not even close'))).toBeNull()
    const png = makePng(4, 4, pattern(4, 4))
    expect(formats.decodePngRgba(png.subarray(0, png.length - 30))).toBeNull()
    const deep = Buffer.from(png)
    deep[8 + 8 + 8] = 16 // IHDR bit depth
    expect(formats.decodePngRgba(deep)).toBeNull()
  })
})

describe('the TIFF', () => {
  it('is a baseline RGBA TIFF of the same pixels: 8 bits a sample, unassociated alpha, one uncompressed strip', () => {
    const rgba = pattern(31, 12)
    const tiff = formats.encodeRgbaTiff(31, 12, rgba)
    const { tags, pixels } = readTiff(tiff)
    expect(tags.get(256)).toEqual([31])
    expect(tags.get(257)).toEqual([12])
    expect(tags.get(258)).toEqual([8, 8, 8, 8])
    expect(tags.get(259)).toEqual([1])
    expect(tags.get(262)).toEqual([2])
    expect(tags.get(277)).toEqual([4])
    expect(tags.get(278)).toEqual([12])
    expect(tags.get(279)).toEqual([31 * 12 * 4])
    expect(tags.get(284)).toEqual([1])
    expect(tags.get(338), 'ExtraSamples: unassociated alpha (the PNG\'s own, not premultiplied)').toEqual([2])
    expect(tags.get(273)![0] % 2, 'the strip starts on a word boundary').toBe(0)
    expect(pixels.equals(rgba)).toBe(true)
  })
})

describe('the macOS writer', () => {
  it('one clipboard.write of one item holding public.png (the PNG\'s own bytes) and public.tiff (the same pixels)', async () => {
    const rgba = pattern(40, 25)
    const png = makePng(40, 25, rgba)
    expect(await writer.writeMacClipboardPicture(png)).toBe('written')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toHaveLength(1)
    const item = writes[0][0]
    expect([...item.types].sort()).toEqual([RAW('public.png'), RAW('public.tiff')].sort())
    expect((await bytesOf(item.items[RAW('public.png')])).equals(png)).toBe(true)
    expect(readTiff(await bytesOf(item.items[RAW('public.tiff')])).pixels.equals(rgba)).toBe(true)
  })

  it('a PNG it cannot read for a TIFF: public.png alone (Claude Code still reads it)', async () => {
    const png = makePng(4, 4, pattern(4, 4))
    const deep = Buffer.from(png)
    deep[8 + 8 + 8] = 16
    expect(formats.macPictureFormats(deep).map((f) => f.type)).toEqual([RAW('public.png')])
  })

  it('a write that throws answers failed', async () => {
    failWrite = true
    expect(await writer.writeMacClipboardPicture(makePng(4, 4, pattern(4, 4)))).toBe('failed')
  })
})

describe('the Linux writer', () => {
  it('one clipboard.write of one item holding image/png, the PNG\'s own bytes', async () => {
    const png = makePng(8, 8, pattern(8, 8))
    expect(await writer.writeLinuxClipboardPicture(png)).toBe('written')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toHaveLength(1)
    expect(writes[0][0].types).toEqual(['image/png'])
    expect((await bytesOf(writes[0][0].items['image/png'])).equals(png)).toBe(true)
    failWrite = true
    expect(await writer.writeLinuxClipboardPicture(png)).toBe('failed')
  })
})

describe('the writer for each OS', () => {
  it('macOS and Linux write (plan s6\'s "not available on this computer" lines go): neither answers not-yet', async () => {
    const png = makePng(6, 6, pattern(6, 6))
    expect(await writer.clipboardWriterFor('darwin')(png)).toBe('written')
    expect(await writer.clipboardWriterFor('linux')(png)).toBe('written')
    expect(writes).toHaveLength(2)
  })

  it('writes every format each registered provider\'s read takes on that OS (row 14\'s tables)', () => {
    const png = makePng(6, 6, pattern(6, 6))
    const mac = formats.macPictureFormats(png).map((f) => f.type)
    for (const rule of [CLAUDE_CLIPBOARD_PASTE, CODEX_CLIPBOARD_PASTE]) {
      for (const name of rule.formats('darwin')) expect(mac, `macOS: ${name}`).toContain(RAW(name))
      for (const name of rule.formats('linux')) expect(formats.linuxPictureFormats(png).map((f) => f.type), `Linux: ${name}`).toContain(name)
    }
  })
})
