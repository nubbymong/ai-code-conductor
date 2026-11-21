'use strict';
// Probe P20 (ADR-030): a stand-in model endpoint for Claude Code (the
// Anthropic Messages API) and Codex (the OpenAI Responses API), loaded by
// p20-probe.cjs and served from its own process on a loopback port, so each
// CLI runs a turn with no sign-in and no network. Unlike P19's stand-in it
// answers a turn with a TOOL CALL:
//
//   a prompt "p20 tool <run> <turn>: read <path>"  -> a tool call that reads a
//       file in the run's working folder: Claude Code's Read with that path;
//       Codex's shell tool (shell_command, exec_command or shell, whichever
//       the request offers) running `type p20-file.txt` (`cat` off Windows);
//   the request that carries that call's result     -> the text "p20 done",
//       and an event saying whether the result holds the file's marker
//       (the tool ran) or not (refused, failed or not run);
//   a prompt "p20 list <run> <turn>"               -> the text "p20 ok", and
//       an event saying which of the stand-in tool server's tools
//       (p20_first, p20_second) the request names anywhere;
//   any other request a CLI makes on its own       -> "ok", as P19's does.
//
// A turn is a request that carries tools (for Claude Code, a streamed one).
// The run and turn are read from the last user message; a result is matched
// to its call by the call's id. Events go to the `onEvent` callback with the
// time; a request's body is never kept, only these facts and, for a result
// that does not hold the marker, its first 300 characters (the probe writes
// personal paths in it as placeholders).
const http = require('http');

/** The text the probe writes into p20-file.txt: its presence in a tool's
 *  result means the tool ran. */
const FILE_MARKER = 'P20-FILE-MARKER-6d1f2a';
const FILE_NAME = 'p20-file.txt';
const PROMPT_RE = /p20 (tool|list) ([A-Za-z0-9_-]{1,64}) ([A-Za-z0-9_-]{1,16})(?::\s*read (\S+))?/;
const SHELL_TOOLS = ['shell_command', 'exec_command', 'shell'];
const MAX_BODY = 16 * 1024 * 1024;

const blocksOf = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []);
const textOfBlocks = (blocks) => blocks.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
const toolNames = (body) => (Array.isArray(body.tools) ? body.tools.map((t) => (t && (t.name || (t.function && t.function.name))) || null).filter(Boolean) : []);

/** What an Anthropic Messages request asks of the stand-in. */
function classifyAnthropic(body) {
  const tools = toolNames(body);
  const turn = body.stream === true && tools.length > 0;
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const last = [...msgs].reverse().find((m) => m && m.role === 'user');
  if (!turn || !last) return { kind: 'ok', tools };
  const blocks = blocksOf(last.content);
  const result = blocks.find((b) => b && b.type === 'tool_result' && typeof b.tool_use_id === 'string' && b.tool_use_id.startsWith('toolu_p20_'));
  if (result) {
    const text = typeof result.content === 'string' ? result.content : JSON.stringify(result.content ?? '');
    return { kind: 'result', callId: result.tool_use_id, ran: text.includes(FILE_MARKER), isError: result.is_error === true, text, tools };
  }
  const m = PROMPT_RE.exec(textOfBlocks(blocks));
  if (!m) return { kind: 'ok', tools };
  return { kind: m[1], run: m[2], turn: m[3], path: m[4] || null, tools };
}

/** The text of one Responses API input item, as it reaches the model. */
const itemText = (it) => (it && Array.isArray(it.content) ? it.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n') : typeof (it && it.content) === 'string' ? it.content : '');

/** What a Responses API request asks of the stand-in. */
function classifyResponses(body) {
  const tools = toolNames(body);
  const input = Array.isArray(body.input) ? body.input : [];
  if (tools.length === 0 || input.length === 0) return { kind: 'ok', tools };
  const last = input[input.length - 1];
  if (last && last.type === 'function_call_output' && typeof last.call_id === 'string' && last.call_id.startsWith('call_p20_')) {
    const text = typeof last.output === 'string' ? last.output : JSON.stringify(last.output ?? '');
    return { kind: 'result', callId: last.call_id, ran: text.includes(FILE_MARKER), isError: false, text, tools };
  }
  // The newest user message, and nothing the model or a tool gave after it
  // (a turn already answered asks nothing new).
  const at = input.map((it) => !!(it && it.role === 'user')).lastIndexOf(true);
  const after = at < 0 ? [] : input.slice(at + 1);
  const answered = after.some((it) => it && (it.role === 'assistant' || it.type === 'function_call' || it.type === 'function_call_output'));
  const m = at >= 0 && !answered ? PROMPT_RE.exec(itemText(input[at])) : null;
  if (!m) return { kind: 'ok', tools };
  return { kind: m[1], run: m[2], turn: m[3], path: m[4] || null, tools };
}

/** The shell tool a Codex request offers and the arguments that read the
 *  probe's file with it, or null when it offers none of them. */
function codexShellCall(tools, platform) {
  const name = SHELL_TOOLS.find((n) => tools.includes(n));
  if (!name) return null;
  const line = platform === 'win32' ? `type ${FILE_NAME}` : `cat ${FILE_NAME}`;
  if (name === 'shell_command') return { name, args: { command: line } };
  if (name === 'exec_command') return { name, args: { cmd: line } };
  return { name, args: { command: platform === 'win32' ? ['cmd.exe', '/c', line] : ['cat', FILE_NAME] } };
}

function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }

function anthropicText(res, body, id, text) {
  const model = typeof body.model === 'string' ? body.model : 'p20-probe';
  if (body.stream !== true) {
    res.writeHead(200, { 'content-type': 'application/json', 'request-id': `req_p20_${id}` });
    res.end(JSON.stringify({ id: `msg_p20_${id}`, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'request-id': `req_p20_${id}` });
  sse(res, 'message_start', { type: 'message_start', message: { id: `msg_p20_${id}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function anthropicToolUse(res, body, id, callId, input) {
  const model = typeof body.model === 'string' ? body.model : 'p20-probe';
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'request-id': `req_p20_${id}` });
  sse(res, 'message_start', { type: 'message_start', message: { id: `msg_p20_${id}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: callId, name: 'Read', input: {} } });
  sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 10 } });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function responsesStream(res, body, id, item) {
  const model = typeof body.model === 'string' ? body.model : 'p20-probe';
  const rid = `resp_p20_${id}`;
  const created = Math.floor(Date.now() / 1000);
  const usage = { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 11 };
  let seq = 0;
  const ev = (type, data) => sse(res, type, { type, sequence_number: seq++, ...data });
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  ev('response.created', { response: { id: rid, object: 'response', created_at: created, status: 'in_progress', model, output: [] } });
  ev('response.in_progress', { response: { id: rid, object: 'response', created_at: created, status: 'in_progress', model, output: [] } });
  if (item.type === 'function_call') {
    ev('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', arguments: '' } });
    ev('response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: item.arguments });
    ev('response.function_call_arguments.done', { item_id: item.id, output_index: 0, arguments: item.arguments });
  } else {
    const text = item.content[0].text;
    ev('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    ev('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    ev('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text });
    ev('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text });
    ev('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text, annotations: [] } });
  }
  ev('response.output_item.done', { output_index: 0, item: { ...item, status: 'completed' } });
  ev('response.completed', { response: { id: rid, object: 'response', created_at: created, status: 'completed', model, output: [{ ...item, status: 'completed' }], usage } });
  res.end();
}
const responsesText = (id, text) => ({ id: `msg_p20_${id}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });

/** The stand-in server. `onEvent(o)` gets each event. */
function createModelStandIn({ onEvent, platform = process.platform }) {
  let n = 0;
  const calls = new Map();
  const emit = (o) => { try { onEvent({ t: Date.now(), ...o }); } catch { /* the probe's own handler */ } };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
    req.on('end', () => {
      const id = ++n;
      const route = (req.url || '').split('?')[0];
      let body = {};
      try { body = size > 0 && size <= MAX_BODY ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { body = {}; }
      const all = size <= MAX_BODY ? Buffer.concat(chunks).toString('utf8') : '';
      const api = route === '/v1/messages' ? 'anthropic' : route === '/v1/responses' ? 'responses' : route === '/v1/messages/count_tokens' ? 'count' : null;
      if (req.method !== 'POST' || !api) {
        emit({ ev: 'request', id, api: null, route, kind: 'not-found' });
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'p20 probe: nothing here' } }));
        return;
      }
      if (api === 'count') {
        emit({ ev: 'request', id, api, kind: 'count' });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      const c = api === 'anthropic' ? classifyAnthropic(body) : classifyResponses(body);
      const base = { ev: 'request', id, api, kind: c.kind, tools: c.tools.length };
      if (c.kind === 'tool') {
        const callId = api === 'anthropic' ? `toolu_p20_${id}` : `call_p20_${id}`;
        if (api === 'anthropic') {
          if (!c.tools.includes('Read') || !c.path) {
            emit({ ...base, run: c.run, turn: c.turn, noTool: c.tools.includes('Read') ? 'no path in the prompt' : `no Read tool among ${c.tools.length}` });
            return anthropicText(res, body, id, 'p20: no tool to call');
          }
          calls.set(callId, { run: c.run, turn: c.turn });
          emit({ ...base, run: c.run, turn: c.turn, callId, tool: 'Read' });
          anthropicToolUse(res, body, id, callId, { file_path: c.path });
        } else {
          const call = codexShellCall(c.tools, platform);
          if (!call) {
            emit({ ...base, run: c.run, turn: c.turn, noTool: `none of ${SHELL_TOOLS.join(', ')} among ${c.tools.join(', ').slice(0, 300)}` });
            return responsesStream(res, body, id, responsesText(id, 'p20: no tool to call'));
          }
          calls.set(callId, { run: c.run, turn: c.turn });
          emit({ ...base, run: c.run, turn: c.turn, callId, tool: call.name });
          responsesStream(res, body, id, { id: `fc_p20_${id}`, type: 'function_call', call_id: callId, name: call.name, arguments: JSON.stringify(call.args) });
        }
        emit({ ev: 'tool-call-sent', id, run: c.run, turn: c.turn, callId });
        return;
      }
      if (c.kind === 'result') {
        const of = calls.get(c.callId) || { run: null, turn: null };
        emit({ ...base, run: of.run, turn: of.turn, callId: c.callId, ran: c.ran, isError: c.isError, excerpt: c.ran ? null : c.text.slice(0, 300) });
        return api === 'anthropic' ? anthropicText(res, body, id, 'p20 done') : responsesStream(res, body, id, responsesText(id, 'p20 done'));
      }
      if (c.kind === 'list') {
        emit({ ...base, run: c.run, turn: c.turn, first: all.includes('p20_first'), second: all.includes('p20_second') });
        return api === 'anthropic' ? anthropicText(res, body, id, 'p20 ok') : responsesStream(res, body, id, responsesText(id, 'p20 ok'));
      }
      emit(base);
      return api === 'anthropic' ? anthropicText(res, body, id, 'ok') : responsesStream(res, body, id, responsesText(id, 'ok'));
    });
  });
  return {
    listen: () => new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)); }),
    close: () => new Promise((resolve) => { srv.close(() => resolve()); if (srv.closeAllConnections) srv.closeAllConnections(); }),
  };
}

module.exports = { createModelStandIn, classifyAnthropic, classifyResponses, codexShellCall, FILE_MARKER, FILE_NAME, PROMPT_RE };
