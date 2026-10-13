#!/usr/bin/env node
// Windows installer artwork generator (build/installer*.bmp, build/installer-art/).
//
// Draws every bitmap the NSIS installer and uninstaller show from the boot
// splash's own brand SVG (resources/splash/index.html, the #logoSrc block) and
// its palette, so the installer and the app's splash stay one design. Pure Node:
// no image library, no network, no browser. The SVG paths are flattened and
// filled by a small anti-aliased scanline rasteriser below, then written as
// 24-bit uncompressed BMPs (BITMAPINFOHEADER, BI_RGB, bottom-up), which is the
// only format NSIS Modern UI and AdvSplash load.
//
// Sizes are the wizard's own 1x sizes. The installer is not DPI aware, so
// Windows scales the whole window as a bitmap at 125% or 150%; larger art would
// only be squeezed back down.
//   installerSidebar.bmp   164x314  Welcome and Finish pages (installer and uninstaller)
//   installerHeader.bmp    150x57   right side of the header band on every inner page
//   installerSplash.bmp    720x430  the fade-in splash on a fresh install (AdvSplash)
//   installer-art/sidebar-1..7.bmp  the Welcome page ring sweep, settling on installerSidebar.bmp
//   installer-art/emblem-1..7.bmp, emblem.bmp  the folder pages' emblem, same motion
//
// Usage:
//   node scripts/gen-installer-art.mjs              write every bitmap into build/
//   node scripts/gen-installer-art.mjs --check      exit 1 if a committed bitmap differs
//   node scripts/gen-installer-art.mjs --preview <dir>  also write PNG previews to <dir>
//
// Deterministic: no randomness, no clock, no locale. --check allows a one-step
// rounding difference per channel so a different Node build cannot fail it.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const SCRIPT = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(SCRIPT), '..')

// Animation steps the installer plays: frames 1..STEPS-1 are files, the last
// step is the static bitmap. build/installer.nsh's CCC_ANIM_STEPS must match.
export const ANIM_STEPS = 8

/** Every bitmap this script owns, relative to the repo root, with its size. */
export function artManifest() {
  const list = [
    { file: 'build/installerSidebar.bmp', width: 164, height: 314 },
    { file: 'build/installerHeader.bmp', width: 150, height: 57 },
    { file: 'build/installerSplash.bmp', width: 720, height: 430 },
    { file: 'build/installer-art/emblem.bmp', width: EMBLEM_W, height: EMBLEM_H },
  ]
  for (let k = 1; k < ANIM_STEPS; k++) {
    list.push({ file: `build/installer-art/sidebar-${k}.bmp`, width: 164, height: 314 })
    list.push({ file: `build/installer-art/emblem-${k}.bmp`, width: EMBLEM_W, height: EMBLEM_H })
  }
  return list
}

const EMBLEM_W = 320
const EMBLEM_H = 72

// ---------------------------------------------------------------------------
// Palette (resources/splash/index.html and splash.js)
// ---------------------------------------------------------------------------
const BG = [0x0b, 0x0e, 0x15]
const RING_STOPS = [
  [0, [0x2f, 0x9b, 0xff]],
  [0.52, [0x8f, 0xb8, 0xe6]],
  [1, [0xd9, 0xdb, 0xe0]],
]
const BLUE = [0x2f, 0x9b, 0xff]
const I_GREY = [0xe0, 0xe0, 0xe0]
const WORD = [0xd9, 0xdb, 0xe0]
const LINE = [140, 170, 230]
const TICK = [160, 190, 240]

// ---------------------------------------------------------------------------
// Brand geometry
// ---------------------------------------------------------------------------

/** Parse an absolute M/C/L/Z path into closed polygons (flattened curves). */
export function flattenPath(d, segs = 24) {
  const tok = d.match(/[MCLZmclz]|-?\d*\.?\d+(?:e-?\d+)?/g) || []
  const polys = []
  let cur = null
  let cmd = ''
  let i = 0
  let x = 0
  let y = 0
  const num = () => Number(tok[i++])
  while (i < tok.length) {
    const t = tok[i]
    if (/[A-Za-z]/.test(t)) {
      cmd = t
      i++
      if (cmd === 'Z' || cmd === 'z') {
        cur = null
      }
      continue
    }
    if (cmd === 'M') {
      x = num()
      y = num()
      cur = [[x, y]]
      polys.push(cur)
      cmd = 'L'
    } else if (cmd === 'L') {
      x = num()
      y = num()
      cur.push([x, y])
    } else if (cmd === 'C') {
      const x1 = num(), y1 = num(), x2 = num(), y2 = num(), x3 = num(), y3 = num()
      for (let s = 1; s <= segs; s++) {
        const u = s / segs
        const v = 1 - u
        const a = v * v * v, b = 3 * v * v * u, c = 3 * v * u * u, e = u * u * u
        cur.push([a * x + b * x1 + c * x2 + e * x3, a * y + b * y1 + c * y2 + e * y3])
      }
      x = x3
      y = y3
    } else {
      throw new Error(`unsupported path command ${cmd}`)
    }
  }
  return polys
}

function bbox(polys) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of polys) for (const [x, y] of p) {
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 }
}

/**
 * The brand mark, split the way splash.js splits it: the blue A, the I, the
 * C ring (subpaths starting left of x=265) and the ONDUCTOR word.
 */
export function loadBrand(root = ROOT) {
  const html = readFileSync(path.join(root, 'resources', 'splash', 'index.html'), 'utf8')
  const m = html.match(/<script type="text\/x-logo-src" id="logoSrc">([\s\S]*?)<\/script>/)
  if (!m) throw new Error('brand SVG (#logoSrc) not found in resources/splash/index.html')
  const svg = m[1]
  const paths = [...svg.matchAll(/<path d="([^"]+)"([^>]*)>/g)]
  const light = paths.find((p) => /fill="#F4F7FA"/i.test(p[2]))
  const blue = paths.find((p) => /fill="#2F9BFF"/i.test(p[2]))
  if (!light || !blue) throw new Error('brand SVG paths not found')
  const subs = light[1].split(/(?=M )/).map((s) => s.trim()).filter(Boolean)
  const iSub = subs.find((s) => s.startsWith('M 206 165'))
  if (!iSub) throw new Error('the I subpath (M 206 165) is missing from the brand SVG')
  let ringD = ''
  let wordD = ''
  for (const s of subs) {
    if (s === iSub) continue
    if (parseFloat(s.slice(2)) < 265) ringD += s + ' '
    else wordD += s + ' '
  }
  const ring = flattenPath(ringD)
  const rb = bbox(ring)
  const rcr = rb.h / 2
  return {
    a: flattenPath(blue[1]),
    i: flattenPath(iSub),
    ring,
    word: flattenPath(wordD),
    ringBox: rb,
    // The C is a circle open on the right: its centre sits one radius in from the left.
    rc: { x: rb.x0 + rcr, y: rb.y0 + rcr, r: rcr },
  }
}

// ---------------------------------------------------------------------------
// Raster
// ---------------------------------------------------------------------------

class Canvas {
  constructor(w, h, bg = BG) {
    this.w = w
    this.h = h
    this.px = new Float64Array(w * h * 3)
    for (let k = 0; k < w * h; k++) {
      this.px[k * 3] = bg[0]
      this.px[k * 3 + 1] = bg[1]
      this.px[k * 3 + 2] = bg[2]
    }
  }

  blend(x, y, rgb, a) {
    if (a <= 0 || x < 0 || y < 0 || x >= this.w || y >= this.h) return
    if (a > 1) a = 1
    const k = (y * this.w + x) * 3
    this.px[k] += (rgb[0] - this.px[k]) * a
    this.px[k + 1] += (rgb[1] - this.px[k + 1]) * a
    this.px[k + 2] += (rgb[2] - this.px[k + 2]) * a
  }

  darken(x, y, a) {
    const k = (y * this.w + x) * 3
    this.px[k] *= 1 - a
    this.px[k + 1] *= 1 - a
    this.px[k + 2] *= 1 - a
  }

  /** 24-bit BI_RGB bottom-up BMP with a 40-byte BITMAPINFOHEADER. */
  toBmp() {
    const stride = Math.ceil((this.w * 3) / 4) * 4
    const size = 54 + stride * this.h
    const b = Buffer.alloc(size)
    b.write('BM', 0, 'ascii')
    b.writeUInt32LE(size, 2)
    b.writeUInt32LE(54, 10)
    b.writeUInt32LE(40, 14)
    b.writeInt32LE(this.w, 18)
    b.writeInt32LE(this.h, 22)
    b.writeUInt16LE(1, 26)
    b.writeUInt16LE(24, 28)
    b.writeUInt32LE(0, 30)
    b.writeUInt32LE(stride * this.h, 34)
    b.writeInt32LE(2835, 38)
    b.writeInt32LE(2835, 42)
    for (let y = 0; y < this.h; y++) {
      const row = 54 + (this.h - 1 - y) * stride
      for (let x = 0; x < this.w; x++) {
        const k = (y * this.w + x) * 3
        b[row + x * 3] = clamp8(this.px[k + 2])
        b[row + x * 3 + 1] = clamp8(this.px[k + 1])
        b[row + x * 3 + 2] = clamp8(this.px[k])
      }
    }
    return b
  }

  toPng() {
    const raw = Buffer.alloc((this.w * 3 + 1) * this.h)
    for (let y = 0; y < this.h; y++) {
      const o = y * (this.w * 3 + 1)
      raw[o] = 0
      for (let x = 0; x < this.w; x++) {
        const k = (y * this.w + x) * 3
        raw[o + 1 + x * 3] = clamp8(this.px[k])
        raw[o + 2 + x * 3] = clamp8(this.px[k + 1])
        raw[o + 3 + x * 3] = clamp8(this.px[k + 2])
      }
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(this.w, 0)
    ihdr.writeUInt32BE(this.h, 4)
    ihdr[8] = 8
    ihdr[9] = 2
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', deflateSync(raw)),
      pngChunk('IEND', Buffer.alloc(0)),
    ])
  }
}

function clamp8(v) {
  const r = Math.round(v)
  return r < 0 ? 0 : r > 255 ? 255 : r
}

let CRC_TABLE = null
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c >>> 0
    }
  }
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td), 0)
  return Buffer.concat([len, td, crc])
}

const SUB = 16 // vertical sub-scanlines per pixel; horizontal coverage is exact

/**
 * Fill polygons (even-odd) mapped by `map` ([x,y] logo -> [x,y] device).
 * `paint(lx, ly)` returns the colour at a logo-space point; `mask(lx, ly)`
 * returns 0..1 (the ring sweep); `alpha` scales the whole shape.
 */
function fillShape(cv, polys, map, inv, paint, alpha = 1, mask = null) {
  if (alpha <= 0) return
  const edges = []
  let ymin = Infinity, ymax = -Infinity, xmin = Infinity, xmax = -Infinity
  for (const p of polys) {
    const pts = p.map(map)
    for (let k = 0; k < pts.length; k++) {
      const [x0, y0] = pts[k]
      const [x1, y1] = pts[(k + 1) % pts.length]
      if (x0 < xmin) xmin = x0
      if (x0 > xmax) xmax = x0
      if (y0 < ymin) ymin = y0
      if (y0 > ymax) ymax = y0
      if (y0 === y1) continue
      edges.push(y0 < y1 ? [x0, y0, x1, y1] : [x1, y1, x0, y0])
    }
  }
  const W = cv.w
  const py0 = Math.max(0, Math.floor(ymin))
  const py1 = Math.min(cv.h - 1, Math.ceil(ymax))
  const px0 = Math.max(0, Math.floor(xmin))
  const px1 = Math.min(W - 1, Math.ceil(xmax))
  if (py0 > py1 || px0 > px1) return
  const cov = new Float64Array(W)
  const xs = []
  for (let py = py0; py <= py1; py++) {
    cov.fill(0, px0, px1 + 1)
    for (let s = 0; s < SUB; s++) {
      const sy = py + (s + 0.5) / SUB
      xs.length = 0
      for (const [x0, y0, x1, y1] of edges) {
        if (sy >= y0 && sy < y1) xs.push(x0 + ((sy - y0) * (x1 - x0)) / (y1 - y0))
      }
      if (xs.length < 2) continue
      xs.sort((p, q) => p - q)
      for (let k = 0; k + 1 < xs.length; k += 2) {
        let xa = Math.max(xs[k], 0)
        let xb = Math.min(xs[k + 1], W)
        if (xb <= xa) continue
        const ia = Math.floor(xa)
        const ib = Math.floor(xb)
        if (ia === ib) {
          cov[ia] += (xb - xa) / SUB
        } else {
          cov[ia] += (ia + 1 - xa) / SUB
          for (let j = ia + 1; j < ib; j++) cov[j] += 1 / SUB
          if (ib < W) cov[ib] += (xb - ib) / SUB
        }
      }
    }
    for (let px = px0; px <= px1; px++) {
      const c = cov[px]
      if (c <= 0) continue
      const [lx, ly] = inv([px + 0.5, py + 0.5])
      const m = mask ? mask(lx, ly) : 1
      if (m <= 0) continue
      cv.blend(px, py, paint(lx, ly), Math.min(1, c) * alpha * m)
    }
  }
}

function lerp(a, b, t) {
  return a + (b - a) * t
}

function mix(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)]
}

function smooth(t) {
  const u = Math.min(1, Math.max(0, t))
  return u * u * (3 - 2 * u)
}

function stops(list, t) {
  if (t <= list[0][0]) return list[0][1]
  for (let k = 1; k < list.length; k++) {
    if (t <= list[k][0]) return mix(list[k - 1][1], list[k][1], (t - list[k - 1][0]) / (list[k][0] - list[k - 1][0]))
  }
  return list[list.length - 1][1]
}

/** The ring's gradient, in the ring's own bounding box (objectBoundingBox units). */
function ringPaint(brand) {
  const b = brand.ringBox
  const p1 = [0, 0.92]
  const p2 = [0.85, 0.08]
  const dx = p2[0] - p1[0]
  const dy = p2[1] - p1[1]
  const len2 = dx * dx + dy * dy
  return (lx, ly) => {
    const u = (lx - b.x0) / b.w
    const v = (ly - b.y0) / b.h
    return stops(RING_STOPS, ((u - p1[0]) * dx + (v - p1[1]) * dy) / len2)
  }
}

/** splash.js's conic reveal: opaque up to (ang - 2) deg, clear from (ang + 14) deg, from -100 deg. */
function sweepMask(brand, ang) {
  if (ang >= 372) return null
  return (lx, ly) => {
    const deg = (Math.atan2(lx - brand.rc.x, -(ly - brand.rc.y)) * 180) / Math.PI
    const p = (((deg + 100) % 360) + 360) % 360
    if (p <= ang - 2) return 1
    if (p >= ang + 14) return 0
    return (ang + 14 - p) / 16
  }
}

/**
 * Where the monogram (ring + A + I) lands with its bounding box centred on
 * (cx, cy) at the given height in pixels, and where its C ring's centre is.
 */
function placeMonogram(brand, cx, cy, height) {
  const mb = bbox([...brand.ring, ...brand.a])
  const s = height / mb.h
  const ox = cx - ((mb.x0 + mb.x1) / 2) * s
  const oy = cy - ((mb.y0 + mb.y1) / 2) * s
  return {
    map: ([x, y]) => [x * s + ox, y * s + oy],
    inv: ([x, y]) => [(x - ox) / s, (y - oy) / s],
    ringX: brand.rc.x * s + ox,
    ringY: brand.rc.y * s + oy,
    ringR: brand.rc.r * s,
  }
}

/** Draw a placed monogram. `t` is the animation time 0..1 (1 = settled). */
function drawMonogram(cv, brand, at, t = 1) {
  const aiAlpha = smooth(t * 2.2)
  fillShape(cv, brand.a, at.map, at.inv, () => BLUE, aiAlpha)
  fillShape(cv, brand.i, at.map, at.inv, () => I_GREY, aiAlpha)
  fillShape(cv, brand.ring, at.map, at.inv, ringPaint(brand), 1, sweepMask(brand, smooth(t) * 372))
}

/** "CONDUCTOR": the C ring and the traced word, as the SVG lays them out. */
function drawWordmark(cv, brand, cx, cy, width, alpha = 1) {
  const b = bbox([...brand.ring, ...brand.word])
  const s = width / b.w
  const ox = cx - ((b.x0 + b.x1) / 2) * s
  const oy = cy - ((b.y0 + b.y1) / 2) * s
  const map = ([x, y]) => [x * s + ox, y * s + oy]
  const inv = ([x, y]) => [(x - ox) / s, (y - oy) / s]
  fillShape(cv, brand.ring, map, inv, ringPaint(brand), alpha)
  fillShape(cv, brand.word, map, inv, () => WORD, alpha)
}

/**
 * The splash's final lockup: the monogram 26% smaller and nudged 27 units
 * toward the word (splash.js MS / MDX), the word where the SVG puts it.
 */
function drawLockup(cv, brand, cx, cy, scale) {
  const MS = 0.74
  const MDX = 27
  const rc = brand.rc
  const monoToLogo = ([x, y]) => [rc.x + MDX + (x - rc.x) * MS, rc.y + (y - rc.y) * MS]
  const logoToMono = ([x, y]) => [(x - rc.x - MDX) / MS + rc.x, (y - rc.y) / MS + rc.y]
  // Centre the logo's own centre (405, 165.5) at (cx, cy), as the splash does.
  const toDev = ([x, y]) => [(x - 405) * scale + cx, (y - 165.5) * scale + cy]
  const fromDev = ([x, y]) => [(x - cx) / scale + 405, (y - cy) / scale + 165.5]
  const mono = (p) => toDev(monoToLogo(p))
  const monoInv = (p) => logoToMono(fromDev(p))
  fillShape(cv, brand.a, mono, monoInv, () => BLUE)
  fillShape(cv, brand.i, mono, monoInv, () => I_GREY)
  fillShape(cv, brand.ring, mono, monoInv, ringPaint(brand))
  fillShape(cv, brand.word, toDev, fromDev, () => WORD)
}

function hline(cv, x0, x1, y, rgb, a) {
  for (let x = Math.round(x0); x <= Math.round(x1); x++) cv.blend(x, y, rgb, a)
}

function vline(cv, x, y0, y1, rgb, a) {
  for (let y = Math.round(y0); y <= Math.round(y1); y++) cv.blend(x, y, rgb, a)
}

/** The splash's 1px frame with its corner ticks. */
function drawFrame(cv, inset) {
  const x0 = inset
  const y0 = inset
  const x1 = cv.w - 1 - inset
  const y1 = cv.h - 1 - inset
  hline(cv, x0, x1, y0, LINE, 0.1)
  hline(cv, x0, x1, y1, LINE, 0.1)
  vline(cv, x0, y0 + 1, y1 - 1, LINE, 0.1)
  vline(cv, x1, y0 + 1, y1 - 1, LINE, 0.1)
  for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
    hline(cv, x - 6, x + 6, y, TICK, 0.55 * 0.35)
    vline(cv, x, y - 6, y + 6, TICK, 0.55 * 0.35)
  }
}

/** Thin anti-aliased circle outline; `dash` = [on, off] in pixels along the arc. */
function drawRing(cv, cx, cy, r, a, dash = null) {
  const x0 = Math.max(0, Math.floor(cx - r - 2))
  const x1 = Math.min(cv.w - 1, Math.ceil(cx + r + 2))
  const y0 = Math.max(0, Math.floor(cy - r - 2))
  const y1 = Math.min(cv.h - 1, Math.ceil(cy + r + 2))
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx
      const dy = y + 0.5 - cy
      const d = Math.abs(Math.sqrt(dx * dx + dy * dy) - r)
      if (d >= 1) continue
      if (dash) {
        const along = (Math.atan2(dy, dx) + Math.PI) * r
        if (along % (dash[0] + dash[1]) >= dash[0]) continue
      }
      cv.blend(x, y, LINE, (1 - d) * a)
    }
  }
}

/** Soft radial wash of `rgb` (peak alpha `a`) - the glow behind the mark. */
function drawWash(cv, cx, cy, r, rgb, a) {
  for (let y = 0; y < cv.h; y++) {
    for (let x = 0; x < cv.w; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r
      if (d < 1) cv.blend(x, y, rgb, a * (1 - smooth(d)))
    }
  }
}

/**
 * The splash's glow line (#glowline): a 1px gradient line with a bright dot in
 * the middle. `reach` 0..1 grows it out from the centre (animation).
 */
function drawGlowLine(cv, x0, x1, y, reach = 1) {
  const mid = (x0 + x1) / 2
  const half = ((x1 - x0) / 2) * smooth(reach)
  for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
    const f = (x + 0.5 - x0) / (x1 - x0)
    if (f < 0 || f > 1) continue
    if (Math.abs(x + 0.5 - mid) > half) continue
    const a = stops([[0, [0]], [0.3, [0.34]], [0.5, [0.6]], [0.7, [0.34]], [1, [0]]], f)[0]
    const col = mix([90, 150, 255], [150, 200, 255], 1 - Math.min(1, Math.abs(f - 0.5) / 0.2))
    cv.blend(x, y, col, a)
    cv.blend(x, y - 1, col, a * 0.18)
    cv.blend(x, y + 1, col, a * 0.18)
  }
  const dotA = smooth(reach)
  const R = 14
  for (let yy = Math.floor(y - R); yy <= Math.ceil(y + R); yy++) {
    for (let xx = Math.floor(mid - R); xx <= Math.ceil(mid + R); xx++) {
      const d = Math.hypot(xx + 0.5 - mid, yy + 0.5 - (y + 0.5))
      const glow = 0.75 * Math.exp(-(Math.max(0, d - 2.5) ** 2) / (2 * 4 * 4))
      cv.blend(xx, yy, [120, 180, 255], glow * 0.55 * dotA)
      const core = Math.min(1, Math.max(0, 3 - d))
      cv.blend(xx, yy, [0xbc, 0xd8, 0xff], core * dotA)
    }
  }
}

/** The splash's vignette: clear to 52% of the corner distance, then to 42% black. */
function drawVignette(cv, strength = 0.42) {
  const rx = (cv.w / 2) * Math.SQRT2
  const ry = (cv.h / 2) * Math.SQRT2
  for (let y = 0; y < cv.h; y++) {
    for (let x = 0; x < cv.w; x++) {
      const t = Math.hypot((x + 0.5 - cv.w / 2) / rx, (y + 0.5 - cv.h / 2) / ry)
      if (t > 0.52) cv.darken(x, y, strength * Math.min(1, (t - 0.52) / 0.48))
    }
  }
}

// ---------------------------------------------------------------------------
// The bitmaps
// ---------------------------------------------------------------------------

/** Welcome / Finish side panel, 164x314. `t` < 1 draws an animation frame. */
export function renderSidebar(brand, t = 1) {
  const cv = new Canvas(164, 314)
  const at = placeMonogram(brand, 82, Math.round(314 * 0.38), 100)
  drawWash(cv, at.ringX, at.ringY, 120, BLUE, 0.07)
  drawRing(cv, at.ringX, at.ringY, 70, 0.07)
  drawRing(cv, at.ringX, at.ringY, 92, 0.05, [2, 7])
  drawRing(cv, at.ringX, at.ringY, 112, 0.04)
  drawFrame(cv, 9)
  drawMonogram(cv, brand, at, t)
  drawGlowLine(cv, 164 * 0.14, 164 * 0.86, Math.round(314 * 0.63), t)
  drawWordmark(cv, brand, 82, Math.round(314 * 0.75), 104, smooth((t - 0.5) * 2))
  drawVignette(cv, 0.3)
  return cv
}

/** Header band image, 150x57, on the band's own dark ground. */
export function renderHeader(brand) {
  const cv = new Canvas(150, 57)
  const at = placeMonogram(brand, 150 - 34, 28, 36)
  drawWash(cv, at.ringX, at.ringY, 40, BLUE, 0.06)
  drawRing(cv, at.ringX, at.ringY, at.ringR + 5, 0.07)
  drawMonogram(cv, brand, at)
  // A short glow line leading in from the header text, fading out to the left.
  const end = Math.floor(at.ringX - at.ringR - 8)
  for (let x = 14; x <= end; x++) cv.blend(x, 28, [90, 150, 255], 0.34 * smooth((x - 14) / (end - 14)))
  return cv
}

/** Fresh-install splash, 720x430: the boot splash's final frame, no loader. */
export function renderSplash(brand) {
  const cv = new Canvas(720, 430)
  drawWash(cv, 360, 198, 260, BLUE, 0.05)
  drawRing(cv, 360, 430 * 0.46, 300, 0.07)
  drawRing(cv, 360, 430 * 0.46, 382, 0.05, [2, 7])
  drawRing(cv, 360, 430 * 0.46, 428, 0.04)
  drawFrame(cv, 26)
  drawGlowLine(cv, 720 * 0.14, 720 * 0.86, Math.round(430 * 0.635))
  drawLockup(cv, brand, 360, 215, 0.725)
  drawVignette(cv)
  return cv
}

/** Folder-page emblem, EMBLEM_W x EMBLEM_H, on the page's dark ground. */
export function renderEmblem(brand, t = 1) {
  const cv = new Canvas(EMBLEM_W, EMBLEM_H)
  const cx = EMBLEM_W / 2
  const at = placeMonogram(brand, cx, 27, 44)
  drawWash(cv, at.ringX, at.ringY, 60, BLUE, 0.06)
  drawMonogram(cv, brand, at, t)
  drawGlowLine(cv, cx - 120, cx + 120, 62, t)
  return cv
}

/** Every bitmap, keyed by repo-relative path. */
export function renderAll(root = ROOT) {
  const brand = loadBrand(root)
  const out = new Map()
  out.set('build/installerSidebar.bmp', renderSidebar(brand))
  out.set('build/installerHeader.bmp', renderHeader(brand))
  out.set('build/installerSplash.bmp', renderSplash(brand))
  out.set('build/installer-art/emblem.bmp', renderEmblem(brand))
  for (let k = 1; k < ANIM_STEPS; k++) {
    out.set(`build/installer-art/sidebar-${k}.bmp`, renderSidebar(brand, k / ANIM_STEPS))
    out.set(`build/installer-art/emblem-${k}.bmp`, renderEmblem(brand, k / ANIM_STEPS))
  }
  return out
}

/** Largest per-channel difference between two same-shaped BMPs, or Infinity. */
export function bmpMaxDelta(a, b) {
  if (a.length !== b.length) return Infinity
  if (a.subarray(0, 54).compare(b.subarray(0, 54)) !== 0) return Infinity
  let max = 0
  for (let k = 54; k < a.length; k++) {
    const d = Math.abs(a[k] - b[k])
    if (d > max) max = d
  }
  return max
}

export function main(argv = process.argv.slice(2), root = ROOT) {
  const check = argv.includes('--check')
  const pi = argv.indexOf('--preview')
  const previewDir = pi >= 0 ? argv[pi + 1] : null
  if (pi >= 0 && !previewDir) {
    console.error('--preview needs a directory')
    return 2
  }
  const art = renderAll(root)
  let bad = 0
  for (const [rel, cv] of art) {
    const file = path.join(root, rel)
    const bmp = cv.toBmp()
    if (check) {
      const delta = existsSync(file) ? bmpMaxDelta(bmp, readFileSync(file)) : Infinity
      if (delta > 1) {
        console.error(`differs from the generator: ${rel} (max channel delta ${delta})`)
        bad++
      }
    } else {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, bmp)
      console.log(`wrote ${rel} (${cv.w}x${cv.h}, ${bmp.length} bytes)`)
    }
    if (previewDir) {
      mkdirSync(previewDir, { recursive: true })
      writeFileSync(path.join(previewDir, rel.replace(/[\\/]/g, '_').replace(/\.bmp$/, '.png')), cv.toPng())
    }
  }
  if (check) console.log(bad ? `${bad} bitmap(s) out of date: run node scripts/gen-installer-art.mjs` : 'installer art matches the generator')
  return bad ? 1 : 0
}

export function isThisScript(argv1, scriptPath = SCRIPT) {
  if (typeof argv1 !== 'string' || argv1.length === 0) return false
  try {
    return realpathSync(path.resolve(argv1)) === realpathSync(scriptPath)
  } catch {
    return false
  }
}

if (isThisScript(process.argv[1])) process.exitCode = main()
