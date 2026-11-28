#!/usr/bin/env node
'use strict';
// A stand-in Codex for the review line of the remote-helper-e2e job
// (2.1.3-beta.21 plan, phase 6, 6.3's CI line; aicc_planning#446). The job
// puts it on the sshd account's login PATH as `codex` (beside the fake
// `claude`), and tests/live/remote-review.live.ts runs probes PV1 and PV2 and
// a review through it, with REMOTE_REVIEW_CODEX=stand-in. A host line (Rocky,
// the Pi) runs the same file with the real Codex instead, signed in there.
//
// Why a stand-in in CI, not the real Codex 0.157.1 against P11's model
// stand-in: the review's argv passes --ignore-user-config
// (src/main/providers/codex/cli-runner.ts, `review`), so no config.toml can
// point a real Codex review at a loopback model; it would reach the real
// service. The real Codex is proven on the hosts by PV1.
//
// It answers only these command lines, and exits 2 on any other:
//   --version                 codex-cli 0.157.1
//   debug models --bundled    a catalogue of two models, in the 0.157.1 shape
//   exec --json ... -         the review: reads its prompt on standard input
//                             to the end, then prints Codex's JSON events, a
//                             reply naming the first `diff --git` line (or
//                             FILE line) of the prompt and its size, then the
//                             turn's usage
// For each exec it writes a record, one JSON file in `codex-runs/` beside
// itself (the run's environment is the app's choice, so no variable of the
// test's can name a folder): its argv, its folder, its variables' names,
// whether its standard streams are terminals, its session id and its parent's
// command line (Linux /proc), its ancestors from its parent up (each one's
// pid and command name, Linux /proc; null where there is no /proc: the
// review check reads from them that the review started under the machine's
// sshd, never under the check's own process), and the prompt's size and
// SHA-256. The prompt's text is never kept. No network, no file but its
// record.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = '0.157.1';
const args = process.argv.slice(2);

function parentCommand() {
  try {
    return fs.readFileSync(`/proc/${process.ppid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

function sessionId() {
  try {
    // /proc/self/stat: pid (comm) state ppid pgrp session ...; comm may hold spaces.
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pgrp: Number(rest[2]), session: Number(rest[3]) };
  } catch {
    return null;
  }
}

/** Its ancestors from its parent up to the first process, by /proc/<pid>/stat
 *  (pid (comm) state ppid ...; comm may hold spaces and brackets); null with
 *  no /proc. At most 64. */
function ancestors() {
  const out = [];
  let pid = process.ppid;
  for (let i = 0; i < 64 && Number.isSafeInteger(pid) && pid > 0; i++) {
    let stat;
    try {
      stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch {
      return out.length > 0 ? out : null;
    }
    const comm = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    out.push({ pid, comm });
    if (ppid === pid) break;
    pid = ppid;
  }
  return out;
}

function record(extra) {
  const dir = path.join(__dirname, 'codex-runs');
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${Date.now()}-${process.pid}.json`);
    fs.writeFileSync(file, `${JSON.stringify({
      argv: args,
      cwd: process.cwd(),
      envNames: Object.keys(process.env).sort(),
      tty: { stdin: !!process.stdin.isTTY, stdout: !!process.stdout.isTTY, stderr: !!process.stderr.isTTY },
      pid: process.pid,
      ids: sessionId(),
      parent: parentCommand(),
      ancestors: ancestors(),
      ...extra,
    })}\n`, { mode: 0o600 });
  } catch (err) {
    process.stderr.write(`pv-codex-stand-in: the record was not written: ${err.message}\n`);
  }
}

// No process.exit after a write: a write to a pipe may still be pending, so
// the exit code is set and the script ends by itself.
if (args.length === 1 && args[0] === '--version') {
  process.stdout.write(`codex-cli ${VERSION}\n`);
} else if (args.length === 3 && args[0] === 'debug' && args[1] === 'models' && args[2] === '--bundled') {
  process.stdout.write(`${JSON.stringify({
    models: [
      { slug: 'gpt-pv-1', display_name: 'PV One', visibility: 'list', priority: 1, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }] },
      { slug: 'gpt-pv-hidden', display_name: 'Hidden', visibility: 'hide', priority: 0 },
      { slug: 'gpt-pv-2', display_name: 'PV Two', visibility: 'list', priority: 2 },
    ],
  }, null, 2)}\n`);
} else if (args[0] === 'exec' && args.includes('--json') && args[args.length - 1] === '-') {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    const prompt = Buffer.concat(chunks);
    const text = prompt.toString('utf8');
    const first = text.split('\n').find((l) => l.startsWith('diff --git ') || /^FILE-[0-9a-f]+ /.test(l)) || '(no change line)';
    record({ promptBytes: prompt.length, promptSha256: crypto.createHash('sha256').update(prompt).digest('hex') });
    const events = [
      { type: 'thread.started', thread_id: 'pv-stand-in' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: `PV stand-in review of ${prompt.length} bytes. First change line: ${first}` } },
      { type: 'turn.completed', usage: { input_tokens: prompt.length, cached_input_tokens: 0, output_tokens: 9 } },
    ];
    process.stdout.write(`${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  });
} else {
  process.stderr.write(`pv-codex-stand-in: a command line it does not answer: ${JSON.stringify(args)}\n`);
  process.exitCode = 2;
}
