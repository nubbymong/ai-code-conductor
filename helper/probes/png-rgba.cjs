'use strict';
// A PNG's pixels as 8-bit RGBA, and a hash of them (plan 2.1.3-beta.21 phase
// 2, 2.1.7; ADR-032). Each CLI re-encodes the picture it reads from the
// clipboard, so the bytes it sends its model are not the bytes the app
// wrote; its pixels are. The model stand-in (p11-model-stand-in.cjs) names
// each PNG a request carries by this hash, and the Snap e2e names the
// picture the app wrote to the clipboard the same way, so equality is exact.
// No JPEG is compared by pixels.
//
// Node's zlib only, no package. Reads 8-bit greyscale, greyscale with alpha,
// RGB, RGBA and palette pictures (with tRNS), not interlaced; anything else
// (16-bit, interlaced, a bad chunk or filter) answers null with why, and is
// recorded as unread. An image with no alpha channel reads as opaque (alpha
// 255), so a picture that lost a constant opaque alpha on the way still
// compares equal.
const zlib = require('zlib');
const crypto = require('crypto');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** No picture the tests make is anywhere near this. */
const MAX_PIXELS = 40 * 1000 * 1000;

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** `buf` (a PNG) decoded: { width, height, rgba } or { unread: why }. */
function decodePngRgba(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) return { unread: 'not a PNG' };
  let at = 8;
  let ihdr = null;
  let palette = null;
  let trns = null;
  const idat = [];
  while (at + 8 <= buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + len);
    if (data.length !== len) return { unread: 'a cut chunk' };
    if (type === 'IHDR') ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    at += 12 + len;
  }
  if (!ihdr) return { unread: 'no IHDR' };
  const { width, height, depth, color, interlace } = ihdr;
  if (depth !== 8) return { unread: `bit depth ${depth}` };
  if (interlace !== 0) return { unread: 'interlaced' };
  if (width * height > MAX_PIXELS || width === 0 || height === 0) return { unread: 'size' };
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  if (!channels) return { unread: `colour type ${color}` };
  if (color === 3 && !palette) return { unread: 'no palette' };
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return { unread: 'inflate' }; }
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) return { unread: 'short data' };
  const lines = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= channels ? lines[out + x - channels] : 0;
      const b = y > 0 ? lines[out - stride + x] : 0;
      const c = x >= channels && y > 0 ? lines[out - stride + x - channels] : 0;
      let r;
      if (filter === 0) r = v;
      else if (filter === 1) r = v + a;
      else if (filter === 2) r = v + b;
      else if (filter === 3) r = v + ((a + b) >> 1);
      else if (filter === 4) r = v + paeth(a, b, c);
      else return { unread: `filter ${filter}` };
      lines[out + x] = r & 0xff;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, p = 0; i < width * height; i++, p += channels) {
    let r; let g; let b; let a = 255;
    if (color === 6) { r = lines[p]; g = lines[p + 1]; b = lines[p + 2]; a = lines[p + 3]; }
    else if (color === 2) { r = lines[p]; g = lines[p + 1]; b = lines[p + 2]; if (trns && trns.length >= 6 && trns.readUInt16BE(0) === r && trns.readUInt16BE(2) === g && trns.readUInt16BE(4) === b) a = 0; }
    else if (color === 0) { r = g = b = lines[p]; if (trns && trns.length >= 2 && trns.readUInt16BE(0) === r) a = 0; }
    else if (color === 4) { r = g = b = lines[p]; a = lines[p + 1]; }
    else { const k = lines[p]; r = palette[k * 3]; g = palette[k * 3 + 1]; b = palette[k * 3 + 2]; if (trns && k < trns.length) a = trns[k]; }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }
  return { width, height, rgba };
}

/** The hashes of a PNG's decoded pixels: RGBA (the comparison) and RGB
 *  alone (a reading, for a cause), each prefixed with the picture's size so
 *  two sizes never compare equal; or { unread: why }. */
function pngPixelHashes(buf) {
  const d = decodePngRgba(buf);
  if (!d.rgba) return { unread: d.unread };
  const head = `${d.width}x${d.height}:`;
  const rgb = Buffer.alloc(d.width * d.height * 3);
  for (let i = 0; i < d.width * d.height; i++) { rgb[i * 3] = d.rgba[i * 4]; rgb[i * 3 + 1] = d.rgba[i * 4 + 1]; rgb[i * 3 + 2] = d.rgba[i * 4 + 2]; }
  return {
    rgbaSha256: crypto.createHash('sha256').update(head).update(d.rgba).digest('hex'),
    rgbSha256: crypto.createHash('sha256').update(head).update(rgb).digest('hex'),
  };
}

module.exports = { decodePngRgba, pngPixelHashes };
