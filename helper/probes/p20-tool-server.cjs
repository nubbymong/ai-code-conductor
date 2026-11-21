'use strict';
// Probe P20 (ADR-030): a stand-in tool server, started by Claude Code (from
// its --mcp-config) or by Codex (from its config.toml) as its `conductor`
// server over standard input and output, as the helper's relay is started
// (S15). It speaks the Model Context Protocol as newline-delimited JSON-RPC
// and answers only:
//
//   initialize                 its tools capability with listChanged: true,
//                              as the app's tool host declares it (the SDK's
//                              McpServer, conductor-mcp-server.ts)
//   tools/list                 p20_first, and p20_second once it was added
//   tools/call                 one line of text
//   ping                       an empty result
//   anything else with an id   method not found
//
//   node p20-tool-server.cjs --dir <folder> --label <name>
//
// It appends one JSON line per event to <folder>/<name>.jsonl: its start,
// each message it is sent (its method only, never its parameters), each
// notification it sends, and its end. Every 200 ms it looks in <folder> for
// two files the probe writes: <name>.add (once: add p20_second and send
// notifications/tools/list_changed) and <name>.stop (end, code 0). It reads
// no other file, opens no connection, and ends at end of input.
const fs = require('fs');
const path = require('path');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const dir = arg('dir');
const label = arg('label');
if (!dir || !label || !/^[a-z0-9-]{1,32}$/.test(label)) { process.stderr.write('usage: node p20-tool-server.cjs --dir <folder> --label <name>\n'); process.exit(2); }
const logFile = path.join(dir, `${label}.jsonl`);
const log = (o) => { try { fs.appendFileSync(logFile, JSON.stringify({ t: Date.now(), label, ...o }) + '\n'); } catch { /* the probe sees a gap */ } };

const tool = (name) => ({ name, description: `P20 probe tool ${name}`, inputSchema: { type: 'object', properties: {}, additionalProperties: false } });
const tools = [tool('p20_first')];
let added = false;

const send = (o) => { try { process.stdout.write(JSON.stringify(o) + '\n'); } catch { /* the client is gone */ } };

function answer(msg) {
  const { id, method } = msg;
  if (method === 'initialize') {
    const asked = msg.params && typeof msg.params.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18';
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: asked, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'p20-stand-in', version: '1.0.0' } } });
  }
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools } });
  if (method === 'tools/call') return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'p20 tool answer' }] } });
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `p20 probe: no method ${String(method).slice(0, 64)}` } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log({ ev: 'unparsed' }); continue; }
    const method = typeof msg.method === 'string' ? msg.method.slice(0, 64) : null;
    if (method) log({ ev: 'method', method, request: msg.id !== undefined });
    if (method && msg.id !== undefined) answer(msg);
  }
});

const end = (why, code) => { log({ ev: 'exit', why }); process.exit(code); };
process.stdin.on('end', () => end('end of input', 0));
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(s, () => end(s, 0));

const timer = setInterval(() => {
  if (!added && fs.existsSync(path.join(dir, `${label}.add`))) {
    added = true;
    tools.push(tool('p20_second'));
    send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    log({ ev: 'sent', method: 'notifications/tools/list_changed' });
  }
  if (fs.existsSync(path.join(dir, `${label}.stop`))) { clearInterval(timer); end('stop file', 0); }
}, 200);

log({ ev: 'start', node: process.version });
