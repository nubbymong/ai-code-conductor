'use strict';
// Probe P19 (ADR-030): a stand-in model endpoint for Claude Code and Codex,
// started by p19-record.cjs beside it, so each CLI reaches its prompt and runs
// one turn with no sign-in and no network. It listens on a loopback port the
// system picks and answers only these requests:
//
//   POST /v1/messages               Claude Code (the Anthropic Messages API)
//   POST /v1/messages/count_tokens  Claude Code: one token
//   POST /v1/responses              Codex (the OpenAI Responses API)
//
// The turn, and only the turn, gets one of two fixed replies, streamed one
// line every `lineMs`: about 300 lines of text (the `reply` section of
// p19-scenarios.json) for a turn that names its marker, and the short one
// (`shortReply`, about 40 lines in about 2 s; the second probe run) for a turn
// that names the short marker. The turn is a request that carries tools and
// names one of the two markers (for Claude Code, a streamed one); any other
// request a CLI makes on its own (a check, a title; Codex 0.157.1 sends a
// second /v1/responses with no tools after its turn) gets the one word "ok",
// streamed when it asked for a stream. Anything else is a 404. No tool call,
// no thinking, only text.
//
//   node p19-model-stand-in.cjs <p19-scenarios.json>
//
// Standard output is one JSON line per event, read by the recorder: the port
// (`listening`), each request (its path, model, whether it streams, how many
// tools, whether it names the prompt, and the reply it got; never its body),
// each line of a reply as it is sent (`reply-progress`), and the end of each
// reply. It reads no file but the scenario file, opens no connection, keeps
// nothing, and ends at end of input.
const fs = require('fs');
const http = require('http');

const scenarioPath = process.argv[2];
if (!scenarioPath) { process.stderr.write('usage: node p19-model-stand-in.cjs <p19-scenarios.json>\n'); process.exit(2); }
const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
// Each line is its own paragraph (`after`), so a CLI that draws its reply
// block by block draws it as it streams.
const build = (r, kind) => {
  const pad = String(r.lines).length;
  const lines = [];
  for (let n = 1; n <= r.lines; n++) lines.push(r.line.replace(/\{n\}/g, String(n).padStart(pad, '0')).replace(/\{total\}/g, String(r.lines)) + (r.after ?? '\n'));
  return { kind, marker: r.marker, lineMs: r.lineMs, blockLines: r.blockLines, lines };
};
// The short reply first: its marker is checked before the long one's.
const REPLIES = [scenario.shortReply ? build(scenario.shortReply, 'short') : null, build(scenario.reply, 'long')].filter(Boolean);
const MAX_BODY = 16 * 1024 * 1024;

const emit = (o) => process.stdout.write(JSON.stringify({ t: Date.now(), ...o }) + '\n');
let replies = 0;

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Streams `parts` one every `everyMs`, calling `each(part, i)`, then `done()`.
// A client that goes away stops the stream.
function pace(res, id, parts, everyMs, each, done) {
  let i = 0;
  let timer = null;
  const stop = () => { if (timer) clearInterval(timer); timer = null; };
  res.on('close', () => { if (timer) { stop(); emit({ event: 'reply-closed', id, sent: i, of: parts.length }); } });
  const tick = () => {
    if (i >= parts.length) { stop(); done(); emit({ event: 'reply-done', id, of: parts.length }); res.end(); return; }
    each(parts[i], i);
    i += 1;
    emit({ event: 'reply-progress', id, sent: i, of: parts.length });
  };
  timer = setInterval(tick, everyMs);
}

// Claude Code: the Messages API's stream (message_start, text blocks of
// `blockLines` lines each, message_delta, message_stop), or one message when
// no stream was asked for. Claude Code draws a text block when it ends, not
// as it streams (2.1.328 on the test machine: a spinner and a token count
// until then), so the reply comes in blocks to be drawn while it streams.
function anthropic(res, body, id, turn) {
  const model = typeof body.model === 'string' ? body.model : 'p19-probe';
  const parts = turn ? turn.lines : ['ok'];
  const text = parts.join('');
  if (body.stream !== true) {
    res.writeHead(200, { 'content-type': 'application/json', 'request-id': `req_p19_${id}` });
    res.end(JSON.stringify({ id: `msg_p19_${id}`, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: parts.length } }));
    emit({ event: 'reply-done', id, of: parts.length });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'request-id': `req_p19_${id}` });
  sse(res, 'message_start', { type: 'message_start', message: { id: `msg_p19_${id}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  sse(res, 'ping', { type: 'ping' });
  const per = Math.max(1, (turn && turn.blockLines) || parts.length);
  pace(res, id, parts, turn ? turn.lineMs : 1,
    (part, i) => {
      const index = Math.floor(i / per);
      if (i % per === 0) sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: part } });
      if (i % per === per - 1 || i === parts.length - 1) sse(res, 'content_block_stop', { type: 'content_block_stop', index });
    },
    () => {
      sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: parts.length } });
      sse(res, 'message_stop', { type: 'message_stop' });
    });
}

// Codex: the Responses API's stream, one assistant message whose text comes
// as deltas, then the finished item and response.completed (Codex fails a
// stream that closes without it).
function responses(res, body, id, turn) {
  const model = typeof body.model === 'string' ? body.model : 'p19-probe';
  const lines = turn ? turn.lines : ['ok'];
  const full = lines.join('');
  const rid = `resp_p19_${id}`;
  const mid = `msg_p19_${id}`;
  const created = Math.floor(Date.now() / 1000);
  const item = (status, text) => ({ id: mid, type: 'message', status, role: 'assistant', content: text === null ? [] : [{ type: 'output_text', text, annotations: [] }] });
  const usage = { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: lines.length, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 10 + lines.length };
  let seq = 0;
  const ev = (type, data) => sse(res, type, { type, sequence_number: seq++, ...data });
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  ev('response.created', { response: { id: rid, object: 'response', created_at: created, status: 'in_progress', model, output: [] } });
  ev('response.in_progress', { response: { id: rid, object: 'response', created_at: created, status: 'in_progress', model, output: [] } });
  ev('response.output_item.added', { output_index: 0, item: item('in_progress', null) });
  ev('response.content_part.added', { item_id: mid, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
  pace(res, id, lines, turn ? turn.lineMs : 1,
    (part) => ev('response.output_text.delta', { item_id: mid, output_index: 0, content_index: 0, delta: part }),
    () => {
      ev('response.output_text.done', { item_id: mid, output_index: 0, content_index: 0, text: full });
      ev('response.content_part.done', { item_id: mid, output_index: 0, content_index: 0, part: { type: 'output_text', text: full, annotations: [] } });
      ev('response.output_item.done', { output_index: 0, item: item('completed', full) });
      ev('response.completed', { response: { id: rid, object: 'response', created_at: created, status: 'completed', model, output: [item('completed', full)], usage } });
    });
}

const srv = http.createServer((req, res) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
  req.on('end', () => {
    const id = ++replies;
    const path = (req.url || '').split('?')[0];
    let body = {};
    try { body = size > 0 && size <= MAX_BODY ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { body = {}; }
    const tools = Array.isArray(body.tools) ? body.tools.length : 0;
    const text = JSON.stringify(body.messages || body.input || '');
    const named = REPLIES.find((r) => text.includes(r.marker)) || null;
    const names = !!named;
    const info = { event: 'request', id, method: req.method, path, model: typeof body.model === 'string' ? body.model : null, stream: body.stream === true, tools, namesPrompt: names, bytes: size };
    // `kind` and `of` say which reply a turn gets and how many lines it has.
    const turnInfo = (turn) => (turn ? { reply: 'turn', kind: named.kind, of: named.lines.length } : { reply: 'ok', of: 1 });
    if (req.method === 'POST' && path === '/v1/messages') {
      const turn = body.stream === true && tools > 0 && names ? named : null;
      emit({ ...info, ...turnInfo(turn) });
      anthropic(res, body, id, turn);
    } else if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
      emit({ ...info, reply: 'count' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 1 }));
    } else if (req.method === 'POST' && path === '/v1/responses') {
      const turn = tools > 0 && names ? named : null;
      emit({ ...info, ...turnInfo(turn) });
      responses(res, body, id, turn);
    } else {
      emit({ ...info, reply: 'not-found' });
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'p19 probe: nothing here' } }));
    }
  });
});
srv.listen(0, '127.0.0.1', () => emit({ event: 'listening', port: srv.address().port, replies: REPLIES.map((r) => ({ kind: r.kind, lines: r.lines.length, lineMs: r.lineMs })) }));
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(s, () => process.exit(0));
