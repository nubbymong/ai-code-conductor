'use strict';
// Probe P18 (ADR-030): a stand-in tool server, started by Claude Code or Codex
// and run by p18-windows-tool-server-start.ps1 beside it. It speaks the tool
// protocol's local framing: one JSON-RPC message per line on standard input
// and output. It answers initialize, tools/list and ping, refuses any other
// request, and with --hold answers nothing. As the helper's planned relay
// mode will, it ends at end of input. It reads no other file, opens no
// connection and writes nothing to standard output but its answers.
//
//   node p18-stand-in.cjs <log file> [--hold]
//
// The log gets one JSON line per event: its start (process ids, arguments,
// working folder, the NAMES of its environment variables, never their values,
// and how its input and output are connected), each message in and out, and
// how it ended. A line is written and closed at once, so the log survives the
// process being ended.
const fs = require('fs');
const net = require('net');
const tty = require('tty');

const [logPath, mode] = process.argv.slice(2);
const hold = mode === '--hold';
const upMs = () => Math.round(process.uptime() * 1000);
const log = (o) => {
  try { fs.appendFileSync(logPath, JSON.stringify({ t: new Date().toISOString(), up: upMs(), ...o }) + '\n'); } catch { /* a missing line is seen in the result */ }
};
const kind = (fd, stream) => (tty.isatty(fd) ? 'console' : stream instanceof net.Socket ? 'pipe' : 'other');

log({
  event: 'start', pid: process.pid, ppid: process.ppid, argv: process.argv, execPath: process.execPath, cwd: process.cwd(),
  envNames: Object.keys(process.env).sort(), stdin: kind(0, process.stdin), stdout: kind(1, process.stdout), stderr: kind(2, process.stderr), hold,
});

const answer = (m) => {
  if (m.method === 'initialize') {
    const version = (m.params && m.params.protocolVersion) || '2025-06-18';
    return { result: { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: 'p18-stand-in', version: '1.0.0' } } };
  }
  if (m.method === 'tools/list') return { result: { tools: [] } };
  if (m.method === 'ping') return { result: {} };
  return { error: { code: -32601, message: 'Method not found' } };
};

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { log({ event: 'in', unreadable: line.length }); continue; }
    log({ event: 'in', method: m.method, id: m.id });
    if (hold || m.id === undefined || typeof m.method !== 'string') continue;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...answer(m) }) + '\n');
    log({ event: 'out', method: m.method, id: m.id });
  }
});
process.stdin.on('end', () => { log({ event: 'end-of-input' }); process.exit(0); });
process.stdout.on('error', (e) => { log({ event: 'output-error', code: e.code }); process.exit(0); });
for (const s of ['SIGINT', 'SIGBREAK', 'SIGHUP', 'SIGTERM']) process.on(s, () => { log({ event: 'signal', name: s }); process.exit(0); });
