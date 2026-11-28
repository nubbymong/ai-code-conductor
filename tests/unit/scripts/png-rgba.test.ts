// The decoded-pixel hash the Snap e2e compares pictures by (plan
// 2.1.3-beta.21 phase 2, 2.1.7; helper/probes/png-rgba.cjs): a CLI
// re-encodes what it reads from the clipboard, so the proof compares pixels,
// exactly. Pictures are encoded here with each PNG row filter and colour
// type the decoder reads, and decoded back to the same RGBA; the hash is the
// same for the same pixels encoded differently, and differs for one pixel
// changed or another size; what it does not read (16-bit, interlaced, not a
// PNG) is named, never a wrong hash. The model stand-in names a PNG request
// picture by it.
// Red before the decoder existed (no helper/probes/png-rgba.cjs).
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { deflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'

const require_ = createRequire(__filename)
const { decodePngRgba, pngPixelHashes } = require_('../../../helper/probes/png-rgba.cjs') as {
  decodePngRgba: (b: Buffer) => { width?: number; height?: number; rgba?: Buffer; unread?: string }
  pngPixelHashes: (b: Buffer) => { rgbaSha256?: string; rgbSha256?: string; unread?: string }
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
const paeth = (a: number, b: number, c: number) => { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c }

/** A PNG of `px` (one array of `channels` bytes a pixel), each row with `filter(y)`. */
function encode(width: number, height: number, color: number, channels: number, px: number[], filter: (y: number) => number, extra: Buffer[] = [], opts: { depth?: number; interlace?: number } = {}) {
  const stride = width * channels
  const rows: Buffer[] = []
  for (let y = 0; y < height; y++) {
    const f = filter(y)
    const line = Buffer.alloc(stride + 1)
    line[0] = f
    for (let x = 0; x < stride; x++) {
      const v = px[y * stride + x]
      const a = x >= channels ? px[y * stride + x - channels] : 0
      const b = y > 0 ? px[(y - 1) * stride + x] : 0
      const c = x >= channels && y > 0 ? px[(y - 1) * stride + x - channels] : 0
      const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][f]
      line[x + 1] = (v - pred) & 0xff
    }
    rows.push(line)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = opts.depth ?? 8; ihdr[9] = color; ihdr[12] = opts.interlace ?? 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...extra, chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))])
}

const W = 7
const H = 5
const rgbaPx = Array.from({ length: W * H * 4 }, (_, i) => (i * 37 + (i >> 2) * 11) & 0xff)

describe('the PNG decoder', () => {
  it('every row filter decodes to the same RGBA', () => {
    for (const f of [0, 1, 2, 3, 4]) {
      const d = decodePngRgba(encode(W, H, 6, 4, rgbaPx, () => f))
      expect(d.width).toBe(W)
      expect([...d.rgba!]).toEqual(rgbaPx)
    }
    const mixed = decodePngRgba(encode(W, H, 6, 4, rgbaPx, (y) => y % 5))
    expect([...mixed.rgba!]).toEqual(rgbaPx)
  })

  it('RGB, greyscale, greyscale with alpha and a palette with tRNS, as RGBA (no alpha read as opaque)', () => {
    const rgb = Array.from({ length: W * H * 3 }, (_, i) => (i * 13) & 0xff)
    const want = [] as number[]
    for (let i = 0; i < W * H; i++) want.push(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], 255)
    expect([...decodePngRgba(encode(W, H, 2, 3, rgb, () => 4)).rgba!]).toEqual(want)
    const grey = Array.from({ length: W * H }, (_, i) => (i * 7) & 0xff)
    expect([...decodePngRgba(encode(W, H, 0, 1, grey, () => 1)).rgba!].slice(0, 8)).toEqual([0, 0, 0, 255, 7, 7, 7, 255])
    const ga = Array.from({ length: W * H * 2 }, (_, i) => (i * 5) & 0xff)
    expect([...decodePngRgba(encode(W, H, 4, 2, ga, () => 2)).rgba!].slice(0, 8)).toEqual([0, 0, 0, 5, 10, 10, 10, 15])
    const idx = Array.from({ length: W * H }, (_, i) => i % 3)
    const plte = chunk('PLTE', Buffer.from([10, 20, 30, 40, 50, 60, 70, 80, 90]))
    const trns = chunk('tRNS', Buffer.from([0, 128]))
    expect([...decodePngRgba(encode(W, H, 3, 1, idx, () => 0, [plte, trns])).rgba!].slice(0, 12)).toEqual([10, 20, 30, 0, 40, 50, 60, 128, 70, 80, 90, 255])
  })

  it('what it does not read is named: 16-bit, interlaced, not a PNG', () => {
    expect(decodePngRgba(encode(W, H, 6, 4, rgbaPx, () => 0, [], { depth: 16 })).unread).toBe('bit depth 16')
    expect(decodePngRgba(encode(W, H, 6, 4, rgbaPx, () => 0, [], { interlace: 1 })).unread).toBe('interlaced')
    expect(decodePngRgba(Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(40).fill(0)])).unread).toBe('not a PNG')
    expect(pngPixelHashes(Buffer.from('nope')).unread).toBe('not a PNG')
  })
})

describe('the pixel hash', () => {
  it('the same pixels encoded differently hash the same; RGB with no alpha equals the same pixels opaque', () => {
    const a = pngPixelHashes(encode(W, H, 6, 4, rgbaPx, () => 0))
    const b = pngPixelHashes(encode(W, H, 6, 4, rgbaPx, (y) => (y * 3) % 5))
    expect(a.rgbaSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(b.rgbaSha256).toBe(a.rgbaSha256)
    const opaque = rgbaPx.map((v, i) => (i % 4 === 3 ? 255 : v))
    const rgb = opaque.filter((_, i) => i % 4 !== 3)
    expect(pngPixelHashes(encode(W, H, 2, 3, rgb, () => 1)).rgbaSha256).toBe(pngPixelHashes(encode(W, H, 6, 4, opaque, () => 2)).rgbaSha256)
  })

  it('one pixel changed, or another size with the same bytes, hashes differently', () => {
    const changed = [...rgbaPx]
    changed[17] ^= 1
    expect(pngPixelHashes(encode(W, H, 6, 4, changed, () => 0)).rgbaSha256).not.toBe(pngPixelHashes(encode(W, H, 6, 4, rgbaPx, () => 0)).rgbaSha256)
    const px = Array.from({ length: 12 * 4 }, (_, i) => i)
    expect(pngPixelHashes(encode(3, 4, 6, 4, px, () => 0)).rgbaSha256).not.toBe(pngPixelHashes(encode(4, 3, 6, 4, px, () => 0)).rgbaSha256)
  })

  it('the model stand-in names a PNG request picture by it, beside the file\'s SHA-256', () => {
    const { createModelStandIn } = require_('../../../helper/probes/p11-model-stand-in.cjs') as { createModelStandIn: unknown }
    expect(typeof createModelStandIn).toBe('function')
    const png = encode(W, H, 6, 4, rgbaPx, () => 4)
    const text = require_('node:fs').readFileSync(require_.resolve('../../../helper/probes/p11-model-stand-in.cjs'), 'utf8') as string
    expect(text).toContain("require('./png-rgba.cjs')")
    expect(pngPixelHashes(png).rgbaSha256).not.toBe(createHash('sha256').update(png).digest('hex'))
  })
})
