'use strict';
// Probe P11 (ADR-030): a stand-in model endpoint for Claude Code (the
// Anthropic Messages API) and Codex (the OpenAI Responses API), loaded by
// p11-probe.cjs and served from its own process on a loopback port, so each
// CLI runs a turn with no sign-in and no network. It records, for every
// request, whether the request carries an image, and which picture it is.
//
//   POST /v1/messages               Claude Code
//   POST /v1/messages/count_tokens  Claude Code: one token
//   POST /v1/responses              Codex
//
// A turn is a request that carries tools (for Claude Code, a streamed one)
// and whose user text names a run with the probe's marker, "p11 probe
// <run>". A turn gets the short text "p11 ok"; any other request a CLI makes
// on its own (a check, a title) gets "ok", streamed when it asked for a
// stream. Anything else is a 404. No tool call, no thinking, only text.
//
// The images. Every user message of a request (Claude Code: `messages` whose
// role is user; Codex: `input` items whose role is user) is read for image
// parts: Claude Code's `{ type: 'image', source: { type: 'base64', data } }`
// and Codex's `{ type: 'input_image', image_url: 'data:...;base64,...' }`. An
// inline picture is decoded and named by its SHA-256, its kind (JPEG, PNG,
// GIF, WebP) and its width and height read from its header; an image given
// another way (a URL, a file id) is named by that way only. The picture's
// bytes are never kept or written anywhere. Since 2.1.3-beta.21 (ADR-032,
// plan phase 2, 2.1.7) a PNG is named by the hash of its decoded pixels too
// (rgbaSha256, and rgbSha256 as a reading; ./png-rgba.cjs): a CLI re-encodes
// what it reads from the clipboard, so its bytes differ from the app's while
// its pixels do not.
//
// Events go to the `onEvent` callback with the time: the request's path,
// kind, the run it names, its tool count, its images, and the first 400
// characters of the text part that names the run, never the message's other
// parts (the probe writes personal paths in it as placeholders). A request's
// body is never kept.
const http = require('http');
const crypto = require('crypto');
const { pngPixelHashes } = require('./png-rgba.cjs');

const MARKER_RE = /p11 probe ([a-z]+-[a-z]+(?:-[a-z]+)?-\d{1,2})\b/;
const MAX_BODY = 32 * 1024 * 1024;

/** A picture's kind, width and height from its first bytes (JPEG, PNG, GIF;
 *  WebP's kind only), its length and its SHA-256. */
function pictureInfo(buf) {
  const info = { bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), kind: 'unknown', width: null, height: null };
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    const px = pngPixelHashes(buf);
    return { ...info, kind: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), ...(px.unread ? { pixelsUnread: px.unread } : { rgbaSha256: px.rgbaSha256, rgbSha256: px.rgbSha256 }) };
  }
  if (buf.length >= 10 && buf.toString('latin1', 0, 4) === 'GIF8') {
    return { ...info, kind: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { ...info, kind: 'webp' };
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    // The frame header (SOF0 to SOF15 but DHT, JPG and DAC) holds the size.
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) break;
      const m = buf[i + 1];
      if (m === 0xff) { i += 1; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { ...info, kind: 'jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return { ...info, kind: 'jpeg' };
  }
  return info;
}

/** An inline picture given as base64: its info, or why it could not be read. */
function inlinePicture(b64, mediaType) {
  if (typeof b64 !== 'string' || !b64) return { way: 'base64', mediaType: mediaType || null, unreadable: 'no data' };
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) return { way: 'base64', mediaType: mediaType || null, unreadable: 'no bytes' };
  return { way: 'base64', mediaType: mediaType || null, ...pictureInfo(buf) };
}

/** A data URL's picture, or the way an image was given when it is not one. */
function urlPicture(url) {
  if (typeof url !== 'string') return { way: 'unknown' };
  const m = /^data:([^;,]*)((?:;[^;,]*)*),/.exec(url);
  if (!m) return { way: /^https?:/i.test(url) ? 'url' : 'other' };
  if (!/;base64/i.test(m[2])) return { way: 'data url (not base64)', mediaType: m[1] || null };
  return { ...inlinePicture(url.slice(m[0].length), m[1] || null), way: 'data url' };
}

const partsOf = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []);
/** The text part that names a run, and the run: only that part, since a CLI
 *  may put text of its own in other parts of the same message (Claude Code
 *  2.1.330 puts a reminder block first). */
function namedPart(parts) {
  for (const p of parts) {
    const m = p && typeof p.text === 'string' ? MARKER_RE.exec(p.text) : null;
    if (m) return { run: m[1], text: p.text };
  }
  return null;
}

/** The images in an Anthropic Messages request's user messages (a
 *  tool_result's content included), and the user text that names a run. */
function readAnthropic(body) {
  const msgs = Array.isArray(body && body.messages) ? body.messages : [];
  const images = [];
  let named = null;
  for (const msg of msgs) {
    if (!msg || msg.role !== 'user') continue;
    const parts = partsOf(msg.content);
    const nested = parts.flatMap((p) => (p && p.type === 'tool_result' ? partsOf(p.content) : []));
    for (const p of [...parts, ...nested]) {
      if (!p || p.type !== 'image') continue;
      const s = p.source || {};
      images.push(s.type === 'base64' ? inlinePicture(s.data, s.media_type) : { way: typeof s.type === 'string' ? s.type : 'unknown' });
    }
    named = namedPart(parts) || named;
  }
  return { images, run: named ? named.run : null, text: named ? named.text : null };
}

/** The images in a Responses API request's user items, and the user text
 *  that names a run. */
function readResponses(body) {
  const input = Array.isArray(body && body.input) ? body.input : typeof (body && body.input) === 'string' ? [{ role: 'user', content: body.input }] : [];
  const images = [];
  let named = null;
  for (const it of input) {
    if (!it || it.role !== 'user') continue;
    const parts = partsOf(it.content);
    for (const p of parts) {
      if (!p || p.type !== 'input_image') continue;
      images.push(typeof p.image_url === 'string' ? urlPicture(p.image_url) : { way: p.file_id ? 'file id' : 'unknown' });
    }
    named = namedPart(parts) || named;
  }
  return { images, run: named ? named.run : null, text: named ? named.text : null };
}

const toolCount = (body) => (Array.isArray(body && body.tools) ? body.tools.length : 0);

/** What one request is: a turn (tools, a named run; for Claude Code a
 *  stream), or a request the CLI made on its own. */
function classify(path, body) {
  if (path === '/v1/messages') {
    const r = readAnthropic(body);
    return { api: 'anthropic', kind: body && body.stream === true && toolCount(body) > 0 && r.run ? 'turn' : 'ok', ...r };
  }
  if (path === '/v1/responses') {
    const r = readResponses(body);
    return { api: 'responses', kind: toolCount(body) > 0 && r.run ? 'turn' : 'ok', ...r };
  }
  return null;
}

function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }

function anthropicReply(res, body, id, text) {
  const model = typeof body.model === 'string' ? body.model : 'p11-probe';
  if (body.stream !== true) {
    res.writeHead(200, { 'content-type': 'application/json', 'request-id': `req_p11_${id}` });
    res.end(JSON.stringify({ id: `msg_p11_${id}`, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'request-id': `req_p11_${id}` });
  sse(res, 'message_start', { type: 'message_start', message: { id: `msg_p11_${id}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

// Codex fails a stream that closes without response.completed.
function responsesReply(res, body, id, text) {
  const model = typeof body.model === 'string' ? body.model : 'p11-probe';
  const rid = `resp_p11_${id}`;
  const mid = `msg_p11_${id}`;
  const created = Math.floor(Date.now() / 1000);
  const item = (status, t) => ({ id: mid, type: 'message', status, role: 'assistant', content: t === null ? [] : [{ type: 'output_text', text: t, annotations: [] }] });
  const usage = { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 11 };
  let seq = 0;
  const ev = (type, data) => sse(res, type, { type, sequence_number: seq++, ...data });
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  ev('response.created', { response: { id: rid, object: 'response', created_at: created, status: 'in_progress', model, output: [] } });
  ev('response.output_item.added', { output_index: 0, item: item('in_progress', null) });
  ev('response.content_part.added', { item_id: mid, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
  ev('response.output_text.delta', { item_id: mid, output_index: 0, content_index: 0, delta: text });
  ev('response.output_text.done', { item_id: mid, output_index: 0, content_index: 0, text });
  ev('response.content_part.done', { item_id: mid, output_index: 0, content_index: 0, part: { type: 'output_text', text, annotations: [] } });
  ev('response.output_item.done', { output_index: 0, item: item('completed', text) });
  ev('response.completed', { response: { id: rid, object: 'response', created_at: created, status: 'completed', model, output: [item('completed', text)], usage } });
  res.end();
}

/** The stand-in: `listen()` gives its port, `close()` ends it. */
function createModelStandIn({ onEvent }) {
  let n = 0;
  const srv = http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
    req.on('end', () => {
      const id = ++n;
      const path = (req.url || '').split('?')[0];
      let body = {};
      try { body = size > 0 && size <= MAX_BODY ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { body = {}; }
      const base = { ev: 'request', t: Date.now(), id, method: req.method, path, bytes: size, tooBig: size > MAX_BODY, model: typeof body.model === 'string' ? body.model : null, stream: body.stream === true, tools: toolCount(body) };
      const c = req.method === 'POST' ? classify(path, body) : null;
      if (c) {
        onEvent({ ...base, api: c.api, kind: c.kind, run: c.run, images: c.images, text: c.text ? c.text.slice(0, 400) : null });
        const text = c.kind === 'turn' ? 'p11 ok' : 'ok';
        if (c.api === 'anthropic') anthropicReply(res, body, id, text); else responsesReply(res, body, id, text);
        onEvent({ ev: 'reply-done', t: Date.now(), id, run: c.run, kind: c.kind });
      } else if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
        onEvent({ ...base, kind: 'count', run: null, images: [] });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 1 }));
      } else {
        onEvent({ ...base, kind: 'not-found', run: null, images: [] });
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'p11 probe: nothing here' } }));
      }
    });
  });
  return {
    listen: () => new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)); }),
    close: () => new Promise((resolve) => { srv.close(() => resolve()); if (srv.closeAllConnections) srv.closeAllConnections(); }),
  };
}

module.exports = { createModelStandIn, classify, readAnthropic, readResponses, pictureInfo, urlPicture, MARKER_RE };
