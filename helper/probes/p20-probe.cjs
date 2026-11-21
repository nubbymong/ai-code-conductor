'use strict';
/*
 * Probe P20 (ADR-030; plan 2.1.3-beta.13, section C1, aicc_planning #376):
 * what Claude Code and Codex do when the app run that started them is gone.
 * It gates S16's second half, steps 2, 4 and 6
 * (CONTEXT.d/2026-11-19-what-a-held-agent-session-needs.md).
 *
 * The three questions.
 *   (a) What each CLI does, and shows, when its hook endpoint refuses the
 *       connection, answers 401, answers 404 (what the hooks gateway answers
 *       a session it does not know, hooks-gateway.ts:619-623, as a new app
 *       run would) or never answers, beside a control that answers 200 {}
 *       (the gateway's answer). Claude Code: its http PreToolUse hook, in the
 *       form buildHooksBlock writes (session-hooks-writer.ts). Codex: the
 *       app's forwarder (scripts/ccc-codex-hook.cmd and .js), given by -c as
 *       codexHookConfigArgs gives it (providers/codex/hooks.ts), with its
 *       hook file laid out as the app lays it out.
 *   (b) Whether Claude Code reads its files again while it runs:
 *       --settings: the PreToolUse URL is changed in the file (written to a
 *         temporary file, then renamed over it, as the app's writer does)
 *         between two turns; which URL does the second turn's hook reach?
 *       --mcp-config: its tool server ends, the file now names another one,
 *         and `/mcp` is asked to reconnect; which one starts?
 *   (c) Whether each CLI lists its tools again on
 *       notifications/tools/list_changed on a stream it already has: the
 *       stand-in tool server adds a tool and sends the notification; does the
 *       CLI send tools/list again, and does its next turn name the new tool?
 *
 * How. Each CLI runs on a terminal of 120 by 40 with node-pty (on Windows on
 * node-pty's bundled ConPTY when it is there), its output fed to an
 * @xterm/headless pane that answers its terminal queries, in a fresh
 * environment: HOME, USERPROFILE, APPDATA, LOCALAPPDATA, CLAUDE_CONFIG_DIR,
 * CODEX_HOME and the temporary folders in the probe's own temporary folder, a
 * new one per run; no account, no key of anyone's. Each CLI is pointed at
 * p20-model-stand-in.cjs (served from this process on a loopback port), which
 * answers a turn with a tool call that reads a file in the run's working
 * folder (Claude Code: Read; Codex: its shell tool, with approval_policy never
 * and sandbox_mode danger-full-access in its config), and the next request
 * with "p20 done". The hook endpoint is a server in this process on
 * 127.0.0.1 (as the gateway listens); a refused connection is a port nothing
 * listens on. The tool server is p20-tool-server.cjs, run by the machine's
 * node. The runs of one case run side by side (each its own folder, session
 * id and paths); the cases run one after the other.
 *
 * Decision lines (written before measuring), per CLI:
 *   (a), per endpoint behaviour, over 3 runs:
 *     RUNS THE TOOL: in 3 of 3 runs the tool's output (the file's marker)
 *       reached the model. Recorded beside it: the wait (from the end of the
 *       stand-in's tool call to the request carrying its result, lowest and
 *       highest), whether the endpoint saw the hook, when the CLI gave up a
 *       request that was never answered, and the rows the screen showed that
 *       name a hook.
 *     BLOCKS THE TOOL: in 3 of 3 runs a result came back without the marker
 *       (the tool not run).
 *     STILL WAITING: in 3 of 3 runs no result came within the cap (12 min
 *       from the tool call; --cap-s).
 *     CANNOT MEASURE: in 3 of 3 runs the CLI made no tool call (no turn, or
 *       no tool the stand-in can call).
 *     NO VERDICT: the runs disagree. Only --runs 3 gives a verdict; another
 *       count gives CHECK RUN with what it saw.
 *     The control (200 {}) must read RUNS THE TOOL with the hook seen in 3 of
 *     3 runs, or that CLI's (a) is CANNOT MEASURE as a whole (the set-up
 *     does not reach its hook).
 *     What it means for S16: Claude Code RUNS THE TOOL within 5 s at every
 *     run for refused, 401 and 404: a held session's PreToolUse on the
 *     gateway after an update loses only the event, and step 2 (the hook
 *     mode) stays a default, not a gate on step 4. Anything else (a block,
 *     or a wait over 5 s) for one of them: step 2 comes before step 4 keeps
 *     any Claude Code session. "Never answers" says how long a session
 *     stalls on a gateway that hangs: recorded, no gate. Codex: its hooks
 *     are asynchronous (hooks.ts), so RUNS THE TOOL with no wait is expected
 *     for all four; anything else reopens item 4 of the fragment.
 *   (b), Claude Code, over 3 runs:
 *     --settings: READS AGAIN when the second turn's PreToolUse reached the
 *       new URL and not the old one in 3 of 3 runs; READS ONCE when it
 *       reached the old one and not the new one in 3 of 3; HOOK DROPPED when
 *       it reached neither in 3 of 3; CANNOT MEASURE when the first turn's
 *       hook was not seen in 3 of 3; NO VERDICT otherwise. Meaning: READS
 *       AGAIN, a take-over can write the new run's gateway port and secret
 *       into the file (item 3's second way); otherwise PreToolUse after an
 *       update needs the hook mode (step 2), since no file the take-over
 *       writes is read.
 *     --mcp-config: READS AGAIN when, after the reconnect, the new server
 *       started and the old one did not, in 3 of 3 runs; READS ONCE when the
 *       old one started again and the new one did not, in 3 of 3; NO
 *       RECONNECT when neither started in 3 of 3; CANNOT MEASURE when the
 *       first server never listed its tools in 3 of 3; NO VERDICT otherwise.
 *       Recorded beside it: a server Claude Code started of itself before
 *       `/mcp`. Meaning: READS ONCE or NO RECONNECT, the relay command a
 *       session starts with must stay valid for the CLI's life (as S15
 *       built it: it names the store and the session, not the app run).
 *   (c), per CLI, over 3 runs: LISTS AGAIN when, in 3 of 3 runs, the CLI sent
 *     tools/list again within 10 s of the notification and its next turn
 *     named the added tool; DOES NOT LIST AGAIN when it did neither in 3 of
 *     3; CANNOT MEASURE when the first tools/list was not seen in 3 of 3; NO
 *     VERDICT otherwise (each run's outcome recorded, a list sent again with
 *     the tool missing from the turn included). The first turn is the
 *     control: a run whose first turn did not name the first tool reads the
 *     turn half as not measurable, and its outcome rests on tools/list
 *     alone. Meaning: LISTS AGAIN, S16 step 6 sends the notification when a
 *     new run's tool list differs; DOES NOT LIST AGAIN, step 6 is dropped
 *     for that CLI, and a held session keeps the tool list it started with
 *     (ADR-030 says so).
 *
 * It refuses node-pty or @xterm/headless at any version but the one the
 * checkout's package.json and package-lock.json name, a .cmd or .bat program
 * on Windows (node-pty starts a program file), and a temporary folder whose
 * path the forwarder's command cannot carry as one plain word. It cleans up
 * in finally blocks: each CLI is ended (Ctrl+C twice, then node-pty's kill),
 * then, after each case, every process that is this probe's descendant or a
 * child of a CLI it started (a child counts only when it started after its
 * parent and before that parent ended), each stopped only after its name and
 * start time are checked again; then the temporary folder is removed and
 * anything of its own still running is listed. The process code is
 * p19-record.cjs's, copied (that file is named by its digest in ADR-030, so
 * it is not changed).
 *
 * Usage:
 *   node p20-probe.cjs run --root <checkout> --out <folder> --forwarder <folder>
 *       [--claude <program>] [--codex <program>] [--only <case or prefix>,...]
 *       [--runs <n>] [--cap-s <seconds>]
 * --root is a checkout whose node_modules hold the pinned node-pty and
 * @xterm/headless; --forwarder the folder holding ccc-codex-hook.cmd and
 * ccc-codex-hook.js (the repository's scripts/ folder of the commit
 * measured). The cases: claude-a-<ok|refused|401|404|never>,
 * codex-a-<the same>, claude-b-settings, claude-b-mcp, claude-c, codex-c.
 *
 * Writes p20-result.json to --out: every run's reading (its turns, the hook
 * requests the endpoint saw, the tool server's log, the last screen) and the
 * verdicts, with the temporary folder, the home folder and the programs'
 * paths written as <temp>, <home>, <claude>, <codex>, <node>. It names the
 * probe code by the sha256 of its three files, each read with LF line ends.
 * The last lines are "P20 (a)", "P20 (b)", "P20 (c)" and "P20 RESULT: ...",
 * or "P20 RESULT: COULD NOT RUN - <reason>", with "; clean-up incomplete:
 * <what>" added when something was left. Exit code 0 when it ran to the end,
 * 2 when it could not run or the clean-up was incomplete.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const standIn = require('./p20-model-stand-in.cjs');

const IS_WIN = process.platform === 'win32';
const TOOL_SERVER = path.join(__dirname, 'p20-tool-server.cjs');
const STAND_IN = path.join(__dirname, 'p20-model-stand-in.cjs');
const COLS = 120;
const ROWS = 40;
const API_KEY = 'sk-ant-p20-probe-made-up-not-a-real-key-0000';
const MODEL = 'p20-probe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

class CouldNotRun extends Error {}

// ── arguments and the pinned modules (as p19-record.cjs) ───────────────────
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new CouldNotRun(`${a} needs a value`);
    out[a.slice(2)] = v;
    i += 1;
  }
  return out;
}
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function satisfies(v, spec) {
  if (v === spec) return true;
  const s = /^\^([1-9]\d*)\.(\d+)\.(\d+)$/.exec(spec || '');
  const n = /^(\d+)\.(\d+)\.(\d+)$/.exec(v || '');
  if (!s || !n) return false;
  const a = s.slice(1).map(Number);
  const b = n.slice(1).map(Number);
  if (a[0] !== b[0]) return false;
  for (let i = 1; i < 3; i++) { if (b[i] !== a[i]) return b[i] > a[i]; }
  return true;
}

function loadPinned(root) {
  const pkg = readJson(path.join(root, 'package.json'));
  const lock = readJson(path.join(root, 'package-lock.json'));
  const out = {};
  for (const name of ['node-pty', '@xterm/headless']) {
    const spec = (pkg.dependencies || {})[name] || (pkg.devDependencies || {})[name] || null;
    const entry = (lock.packages || {})[`node_modules/${name}`];
    const locked = entry ? entry.version : null;
    const dir = path.join(root, 'node_modules', ...name.split('/'));
    let version = null;
    try { version = readJson(path.join(dir, 'package.json')).version; } catch { /* reported below */ }
    if (!spec || !version || version !== locked || !satisfies(version, spec)) {
      throw new CouldNotRun(`${name} ${version || '(missing)'} in ${dir} is not package.json's (${spec}, package-lock ${locked})`);
    }
    const resolved = require.resolve(dir);
    if (!resolved.startsWith(dir + path.sep)) throw new CouldNotRun(`${name} resolved outside ${dir}`);
    out[name] = { version, spec, locked, dir, mod: require(dir) };
  }
  return out;
}

/** node-pty's options: the bundled ConPTY when it sits beside the native
 *  module (as src/main/bundled-conpty.ts gives a PTY), else the system's. */
function ptyOptions(ptyDir) {
  if (!IS_WIN) return { id: 'pty', options: {} };
  for (const d of ['build/Release', 'build/Debug', `prebuilds/${process.platform}-${process.arch}`]) {
    const dir = path.join(ptyDir, d);
    if (fs.existsSync(path.join(dir, 'conpty.node')) && ['conpty.dll', 'OpenConsole.exe'].every((f) => fs.existsSync(path.join(dir, 'conpty', f)))) {
      return { id: 'bundled', options: { useConpty: true, useConptyDll: true } };
    }
  }
  return { id: 'system', options: { useConpty: true } };
}

// ── processes (copied from p19-record.cjs) ─────────────────────────────────
const startMs = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? t : null; };
const LISTERS = new Set();

function listProcesses() {
  return new Promise((resolve, reject) => {
    let child = null;
    const done = (parse) => (err, stdout) => {
      if (child) LISTERS.delete(child.pid);
      if (err) { reject(new Error(`the process list failed: ${err.message}`)); return; }
      try { resolve({ self: child.pid, procs: parse(stdout) }); } catch (e) { reject(e); }
    };
    if (IS_WIN) {
      const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const cmd = "Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p = [int]$_.ProcessId; q = [int]$_.ParentProcessId; s = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }); n = [string]$_.Name } } | ConvertTo-Json -Compress";
      child = cp.execFile(ps, ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout: 60000, maxBuffer: 1 << 24 },
        done((out) => [].concat(JSON.parse(out)).map((x) => ({ pid: x.p, ppid: x.q, start: x.s, startMs: startMs(x.s), name: x.n }))));
    } else {
      child = cp.execFile('ps', ['-A', '-o', 'pid=,ppid=,lstart=,comm='], { timeout: 60000, maxBuffer: 1 << 24 },
        done((out) => out.split('\n').filter((l) => l.trim()).map((l) => {
          const m = /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3} +\d+ \d+:\d+:\d+ \d{4})\s+(.*)$/.exec(l);
          const start = m && m[3].replace(/ +/g, ' ');
          return m ? { pid: Number(m[1]), ppid: Number(m[2]), start, startMs: startMs(start), name: m[4].trim() } : null;
        }).filter(Boolean)));
    }
    if (child.pid) LISTERS.add(child.pid);
  });
}

/** The processes that are this probe's (p19-record.cjs's rule): its
 *  descendants, and the children of a program it started that has ended,
 *  each child counted only when it started after its parent and, for a
 *  program that has ended, before that program ended. */
function ownedProcesses(list, known, skip) {
  const byPid = new Map(list.procs.map((p) => [p.pid, p]));
  const byParent = new Map();
  for (const p of list.procs) { if (!byParent.has(p.ppid)) byParent.set(p.ppid, []); byParent.get(p.ppid).push(p); }
  const self = byPid.get(process.pid);
  const roots = [{ pid: process.pid, from: self ? self.startMs : null, to: Infinity }];
  for (const [pid, k] of known) {
    const live = byPid.get(pid);
    if (!live) roots.push({ pid, from: k.startMs, to: k.endMs });
    else if (live.name === k.name && live.start === k.start) roots.push({ pid, from: k.startMs, to: Infinity });
  }
  const out = new Map();
  const stack = [...roots];
  while (stack.length) {
    const { pid, from, to } = stack.pop();
    if (!Number.isFinite(from) || to == null) continue;
    for (const c of byParent.get(pid) || []) {
      if (c.pid === process.pid || c.pid === list.self || LISTERS.has(c.pid) || skip.has(c.pid) || out.has(c.pid)) continue;
      if (!Number.isFinite(c.startMs) || c.startMs < from || c.startMs > to) continue;
      out.set(c.pid, c);
      stack.push({ pid: c.pid, from: c.startMs, to: Infinity });
    }
  }
  return [...out.values()];
}

async function stopChecked(p) {
  const same = async () => {
    const l = await listProcesses();
    const cur = l.procs.find((x) => x.pid === p.pid);
    return cur ? cur.name === p.name && cur.start === p.start : null;
  };
  const before = await same();
  if (before === null) return 'gone before it was stopped';
  if (before === false) return 'its pid now names another process: left alone';
  try { process.kill(p.pid, IS_WIN ? undefined : 'SIGTERM'); } catch (e) { return `could not be stopped (${e.code || e.message})`; }
  for (let i = 0; i < 10; i++) {
    await sleep(300);
    if ((await same()) !== true) return 'stopped';
  }
  if (!IS_WIN) {
    try { process.kill(p.pid, 'SIGKILL'); } catch { /* checked below */ }
    await sleep(500);
    if ((await same()) !== true) return 'stopped (SIGKILL)';
  }
  return 'still running after it was stopped';
}

// ── the screen ─────────────────────────────────────────────────────────────
/** A pane's rows once it has parsed everything written to it: the screen,
 *  and every line of its buffer (scrollback included). */
function screenOf(term) {
  return new Promise((resolve, reject) => term.write('', () => {
    try {
      const buf = term.buffer.active;
      const all = [];
      for (let y = 0; y < buf.length; y++) { const l = buf.getLine(y); all.push(l ? l.translateToString(true) : ''); }
      resolve({ rows: all.slice(buf.baseY, buf.baseY + term.rows), all });
    } catch (e) { reject(e); }
  }));
}
const screenText = async (run) => (await screenOf(run.pane)).rows.join('\n');

/** The lines a pane's buffer holds that name a hook (each once, at most 12). */
async function hookRows(run) {
  const { all } = await screenOf(run.pane);
  const seen = [];
  for (const l of all) { const t = l.trim(); if (/hook/i.test(t) && !seen.includes(t)) seen.push(t); }
  return seen.slice(0, 12);
}

// ── fresh environments ─────────────────────────────────────────────────────
function freshEnv(dirs, extra) {
  const keep = IS_WIN
    ? ['PATH', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'SystemDrive', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
      'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'ProgramData', 'NUMBER_OF_PROCESSORS',
      'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'OS', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME']
    : ['PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE'];
  const env = {};
  for (const k of keep) { const v = process.env[k]; if (v) env[k] = v; }
  Object.assign(env, {
    HOME: dirs.home, USERPROFILE: dirs.home, APPDATA: dirs.appdata, LOCALAPPDATA: dirs.localappdata,
    CLAUDE_CONFIG_DIR: dirs.claude, CODEX_HOME: dirs.codex, TEMP: dirs.tmp, TMP: dirs.tmp,
  });
  if (!IS_WIN) Object.assign(env, { TMPDIR: dirs.tmp, TERM: 'xterm-256color', XDG_CONFIG_HOME: path.join(dirs.home, '.config') });
  return Object.assign(env, extra || {});
}

function makeDirs(base) {
  const dirs = { base };
  for (const k of ['home', 'appdata', 'localappdata', 'claude', 'codex', 'tmp', 'work', 'tools']) {
    dirs[k] = path.join(base, k);
    fs.mkdirSync(dirs[k], { recursive: true });
  }
  return dirs;
}

/** A file written whole: to a temporary file beside it, then renamed over it
 *  (as the app's atomicWriteFileSync writes a settings file). */
function writeWhole(file, text) {
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** A loopback port nothing listens on: one the system gave, then closed. */
function closedPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// ── the hook endpoint ──────────────────────────────────────────────────────
/** The endpoint for every run: /hook/<id> answered as `modes.get(id)` says
 *  (ok: 200 {}; 401; 404 {}; never: held open until the client gives up or
 *  the probe ends). Records the request's event and tool names, whether its
 *  token was the run's, when it came and, for one held open, when the client
 *  closed it. Never its body. */
function hookEndpoint() {
  const modes = new Map();
  const tokens = new Map();
  const seen = [];
  const held = new Set();
  const srv = http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= 4 << 20) chunks.push(c); });
    req.on('end', () => {
      const id = ((/^\/hook\/([A-Za-z0-9_-]{1,128})$/.exec((req.url || '').split('?')[0]) || [])[1]) || null;
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = {}; }
      const token = req.headers['x-ccc-hook-token'];
      const mode = id ? modes.get(id) || 'unknown' : 'unknown';
      const r = {
        id, t: now(), mode, method: req.method, event: typeof body.hook_event_name === 'string' ? body.hook_event_name.slice(0, 40) : null,
        tool: typeof body.tool_name === 'string' ? body.tool_name.slice(0, 40) : null, tokenOk: !!id && token === tokens.get(id),
        client: typeof req.headers['x-ccc-hook-client'] === 'string' ? req.headers['x-ccc-hook-client'].slice(0, 16) : null, closedAt: null,
      };
      seen.push(r);
      if (mode === 'never') {
        held.add(res);
        res.on('close', () => { r.closedAt = now(); held.delete(res); });
        return;
      }
      const status = mode === '401' ? 401 : mode === '404' || mode === 'unknown' ? 404 : 200;
      res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
      res.end(status === 401 ? '{"error":"unauthorized"}' : '{}');
    });
  });
  return {
    modes, tokens, seen,
    listen: () => new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)); }),
    close: () => new Promise((resolve) => { for (const r of held) { try { r.destroy(); } catch { /* gone */ } } srv.close(() => resolve()); if (srv.closeAllConnections) srv.closeAllConnections(); }),
  };
}

// ── the cases ──────────────────────────────────────────────────────────────
const A_MODES = ['ok', 'refused', '401', '404', 'never'];
const CASES = [
  ...A_MODES.map((m) => ({ id: `claude-a-${m}`, cli: 'claude', q: 'a', mode: m })),
  ...A_MODES.map((m) => ({ id: `codex-a-${m}`, cli: 'codex', q: 'a', mode: m })),
  { id: 'claude-b-settings', cli: 'claude', q: 'b-settings' },
  { id: 'claude-b-mcp', cli: 'claude', q: 'b-mcp' },
  { id: 'claude-c', cli: 'claude', q: 'c' },
  { id: 'codex-c', cli: 'codex', q: 'c' },
];
const pickCases = (only) => (only ? CASES.filter((c) => only.some((o) => c.id === o || c.id.startsWith(`${o}-`))) : CASES);

const CODEX_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop'];
const tomlLiteral = (s) => { if (s.includes("'")) throw new CouldNotRun(`a path holds a quote: ${s}`); return `'${s}'`; };
const PLAIN_WIN_PATH_RE = /^[A-Za-z]:\\[A-Za-z0-9_.\\-]+$/;

/** The files a run starts from, its arguments and its environment. */
function prepare(ctx, kase, run) {
  const d = run.dirs;
  fs.writeFileSync(path.join(d.work, standIn.FILE_NAME), `${standIn.FILE_MARKER}\n`);
  const env = {};
  const args = [];
  if (kase.cli === 'claude') {
    const proj = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, projectOnboardingSeenCount: 1, allowedTools: [] };
    const version = (/\d+\.\d+\.\d+/.exec(ctx.versions.claude || '') || [''])[0];
    fs.writeFileSync(path.join(d.claude, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: true, lastOnboardingVersion: version, theme: 'dark', numStartups: 1, autoUpdates: false,
      hasAcknowledgedCostThreshold: true, customApiKeyResponses: { approved: [API_KEY.slice(-20)], rejected: [] },
      projects: { [d.work]: proj, [d.work.replace(/\\/g, '/')]: proj },
    }, null, 2));
    Object.assign(env, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${ctx.modelPort}`, ANTHROPIC_API_KEY: API_KEY, DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
    if (kase.q === 'a' || kase.q === 'b-settings') {
      run.settingsFile = path.join(d.claude, `settings-${run.sid}.json`);
      writeWhole(run.settingsFile, settingsText(ctx, run, kase.q === 'a' ? run.sid : `${run.sid}-one`));
      args.push('--settings', run.settingsFile);
    }
    if (kase.q === 'b-mcp' || kase.q === 'c') {
      run.mcpFile = path.join(d.claude, `mcp-${run.sid}.json`);
      writeWhole(run.mcpFile, mcpText(ctx, run, 'one'));
      args.push('--mcp-config', run.mcpFile);
    }
  } else {
    const toml = [
      `model = "${MODEL}"`, 'model_provider = "p20probe"', 'approval_policy = "never"', 'sandbox_mode = "danger-full-access"', '',
      '[model_providers.p20probe]', 'name = "p20 probe"', `base_url = "http://127.0.0.1:${ctx.modelPort}/v1"`, 'env_key = "P20_PROBE_KEY"',
      'wire_api = "responses"', 'request_max_retries = 0', 'stream_max_retries = 0', '',
      `[projects.${tomlLiteral(d.work)}]`, 'trust_level = "trusted"', '',
    ];
    if (kase.q === 'c') {
      toml.push('[mcp_servers.conductor]', `command = ${tomlLiteral(process.execPath)}`,
        `args = [${[TOOL_SERVER, '--dir', d.tools, '--label', 'one'].map(tomlLiteral).join(', ')}]`, '');
    }
    fs.writeFileSync(path.join(d.codex, 'config.toml'), toml.join('\n'));
    env.P20_PROBE_KEY = 'p20-probe-placeholder-not-a-key';
    args.push('--no-daemon');
    if (kase.q === 'a') {
      // The hook file as the app lays it out (<data>/codex-hooks/ccc-codex-hook-<random>/hook.json)
      // and the forwarder's command as codexHookConfigArgs gives it.
      const hookDir = path.join(d.base, 'ccc-data', 'codex-hooks', `ccc-codex-hook-${crypto.randomBytes(8).toString('hex')}`);
      fs.mkdirSync(hookDir, { recursive: true });
      run.hookFile = path.join(hookDir, 'hook.json');
      fs.writeFileSync(run.hookFile, JSON.stringify({ v: 1, port: run.hookPort, sid: run.sid, token: run.token }));
      for (const ev of CODEX_HOOK_EVENTS) args.push('-c', `hooks.${ev}=[{hooks=[{type='command',command=${tomlLiteral(ctx.hookCommand)},timeout=10,async=true}]}]`);
      env.CLAUDE_MULTI_SESSION_ID = run.sid;
      env.CCC_CODEX_HOOK_FILE = run.hookFile;
    }
  }
  return { args, env: freshEnv(d, env) };
}

/** A Claude Code settings file with only the PreToolUse entry
 *  buildHooksBlock writes, for the endpoint path `id`. */
function settingsText(ctx, run, id) {
  const url = `http://localhost:${run.hookPort}/hook/${id}`;
  return JSON.stringify({ hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'http', url, headers: { 'X-CCC-Hook-Token': run.token } }] }] } }, null, 2);
}

/** A Claude Code MCP config whose `conductor` server is the stand-in tool
 *  server with label `label`. */
function mcpText(ctx, run, label) {
  return JSON.stringify({ mcpServers: { conductor: { type: 'stdio', command: process.execPath, args: [TOOL_SERVER, '--dir', run.dirs.tools, '--label', label] } } }, null, 2);
}

// ── one run ────────────────────────────────────────────────────────────────
const READY = {
  claude: /(?:^|\n) {0,2}\u2500{8,} *\n {0,2}[\u276f>](?:[ \u00a0][^\n]*)?\n {0,2}\u2500{8,}/u,
  codex: /(?:^|\n) ?\u203a(?:[ \n]|$)[\s\S]*\n {1,4}p20-probe [^\n]*\u00b7/u,
};
const BUSY = /esc to interrupt/i;
/** Screens each CLI may show before its prompt, and what answers each. */
const RULES = {
  claude: [
    { label: 'theme picker', re: /text style|Dark mode/i, keys: ['\r'] },
    { label: 'API key question', re: /use this API key/i, keys: ['\u001b[A', '\r'] },
    { label: 'folder trust', re: /trust (the files in )?this folder/i, keys: ['\r'] },
    { label: 'press Enter', re: /Press Enter to continue/i, keys: ['\r'] },
  ],
  codex: [
    // Codex's review of the app's hooks at start-up ("Hooks need review ...
    // Trust all and continue"): the option's number when the screen shows
    // one, else the /hooks view's key.
    { label: 'hooks review', re: /Hooks need review|Press t to trust/i, keys: (text) => { const m = /(\d)[.)]\s*Trust all/i.exec(text); return [m ? m[1] : 't']; } },
    { label: 'folder trust', re: /trust the contents|allow Codex to work in this folder|Do you trust/i, keys: ['\r'] },
    { label: 'press Enter', re: /[Pp]ress [Ee]nter to continue/i, keys: ['\r'] },
  ],
};

function note(run, s) { run.notes.push({ t: now() - run.t0, s }); }

async function typeKeys(run, keys) {
  for (let i = 0; i < keys.length; i++) {
    if (i > 0) await sleep(250);
    try { run.pty.write(keys[i]); } catch (e) { note(run, `a write failed: ${e.message}`); }
  }
}

/** Waits for `re` on the screen (and not busy), answering the rules' screens. */
async function untilScreen(run, re, label, timeoutMs, rules = []) {
  const start = now();
  const used = new Map();
  for (;;) {
    await sleep(200);
    if (run.exited) return `the CLI ended (code ${run.exited.code}) before ${label}`;
    const text = await screenText(run);
    if (re.test(text) && !BUSY.test(text)) return null;
    for (const r of rules) {
      const u = used.get(r.label) || { n: 0, at: 0 };
      if (r.re.test(text) && u.n < 3 && now() - u.at > 1500) {
        used.set(r.label, { n: u.n + 1, at: now() });
        run.answered.push({ rule: r.label, t: now() - run.t0 });
        await typeKeys(run, typeof r.keys === 'function' ? r.keys(text) : r.keys);
        break;
      }
    }
    if (now() - start >= timeoutMs) return `${label} was not shown within ${timeoutMs} ms`;
  }
}

async function until(pred, timeoutMs, run) {
  const start = now();
  for (;;) {
    const v = pred();
    if (v) return v;
    if (run && run.exited) return null;
    if (now() - start >= timeoutMs) return null;
    await sleep(100);
  }
}

const ready = (ctx, run, kase, label) => untilScreen(run, READY[kase.cli], label, 90000, RULES[kase.cli]);
const serverLog = (run, label) => {
  try { return fs.readFileSync(path.join(run.dirs.tools, `${label}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};

/** One turn: the prompt typed, then the stand-in's events for it awaited. */
async function toolTurn(ctx, run, turn, capMs) {
  const t = { turn, typedAt: now(), callAt: null, resultAt: null, ran: null, isError: null, excerpt: null, noTool: null, tool: null };
  run.turns[turn] = t;
  const file = path.join(run.dirs.work, standIn.FILE_NAME);
  await typeKeys(run, [`p20 tool ${run.sid} ${turn}: read ${file}`]);
  await sleep(700);
  await typeKeys(run, ['\r']);
  const call = await until(() => ctx.model.find((e) => e.run === run.sid && e.turn === turn && e.ev === 'request' && (e.kind === 'tool')), 90000, run);
  if (!call) { t.why = 'no tool turn reached the stand-in within 90 s'; return t; }
  if (call.noTool) { t.noTool = call.noTool; return t; }
  t.tool = call.tool;
  const sent = await until(() => ctx.model.find((e) => e.ev === 'tool-call-sent' && e.callId === call.callId), 10000, run);
  t.callAt = sent ? sent.t : call.t;
  const res = await until(() => ctx.model.find((e) => e.ev === 'request' && e.kind === 'result' && e.callId === call.callId), capMs, run);
  if (!res) { t.why = run.exited ? 'the CLI ended before a result' : `no result within ${Math.round(capMs / 1000)} s`; return t; }
  Object.assign(t, { resultAt: res.t, ran: res.ran, isError: res.isError, excerpt: res.excerpt, waitMs: res.t - t.callAt });
  return t;
}

async function listTurn(ctx, run, turn) {
  const t = { turn, typedAt: now(), first: null, second: null };
  run.lists[turn] = t;
  await typeKeys(run, [`p20 list ${run.sid} ${turn}`]);
  await sleep(700);
  await typeKeys(run, ['\r']);
  const e = await until(() => ctx.model.find((x) => x.run === run.sid && x.turn === turn && x.ev === 'request' && x.kind === 'list'), 90000, run);
  if (!e) { t.why = 'no list turn reached the stand-in within 90 s'; return t; }
  Object.assign(t, { at: e.t, first: e.first, second: e.second });
  return t;
}

/** Claude Code's /mcp: open it, pick the one server, pick Reconnect. */
async function mcpReconnect(run) {
  await typeKeys(run, ['/mcp']);
  await sleep(600);
  await typeKeys(run, ['\r']);
  const steps = [];
  for (let i = 0; i < 12; i++) {
    await sleep(800);
    const text = await screenText(run);
    const pick = /^\s*[\u276f>]\s*(?:\d+\.\s*)?Reconnect/im.test(text);
    if (pick) { steps.push('Reconnect'); await typeKeys(run, ['\r']); return steps; }
    if (/Reconnect/i.test(text)) { steps.push('down'); await typeKeys(run, ['\u001b[B']); continue; }
    if (/conductor/i.test(text)) { steps.push('server'); await typeKeys(run, ['\r']); continue; }
    steps.push('waiting');
  }
  return steps;
}

async function runOne(ctx, kase, k) {
  const sid = `p20${kase.id.replace(/[^a-z0-9]/g, '')}${k}`;
  const dirs = makeDirs(path.join(ctx.tempRoot, `${kase.id}-${k}`));
  const run = {
    id: `${kase.id}-${k}`, case: kase.id, cli: kase.cli, k, sid, dirs, token: crypto.randomUUID(), t0: now(), turns: {}, lists: {}, answered: [], notes: [],
    exited: null, known: null, closed: false, bytes: 0,
  };
  run.hookPort = kase.mode === 'refused' ? await closedPort() : ctx.hookPort;
  ctx.hooks.modes.set(sid, kase.mode || 'ok');
  ctx.hooks.modes.set(`${sid}-one`, 'ok');
  ctx.hooks.modes.set(`${sid}-two`, 'ok');
  for (const id of [sid, `${sid}-one`, `${sid}-two`]) ctx.hooks.tokens.set(id, run.token);
  const { args, env } = prepare(ctx, kase, run);
  const cmd = ctx.commands[kase.cli];
  run.pane = ctx.newPane();
  const term = ctx.pty.spawn(cmd, args, { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: dirs.work, env, ...ctx.ptyMode.options });
  run.pty = term;
  run.pane.onData((d) => { try { term.write(d); } catch { /* ended */ } });
  term.onData((d) => { if (run.closed) return; run.bytes += d.length; run.pane.write(d); });
  term.onExit(({ exitCode }) => {
    run.exited = { code: exitCode, t: now() - run.t0 };
    if (run.known) run.known.endMs = now();
  });
  listProcesses().then((l) => {
    const p = l.procs.find((x) => x.pid === term.pid);
    if (p) { run.known = { ...p, endMs: run.exited ? now() : null }; ctx.known.set(p.pid, run.known); }
  }).catch(() => { /* the case's sweep lists again */ });
  const capMs = kase.mode === 'never' ? ctx.capMs : 120000;
  try {
    let why = await ready(ctx, run, kase, 'the ready prompt');
    if (why) { run.why = why; return run; }
    await sleep(1500);
    if (kase.q === 'a') {
      await toolTurn(ctx, run, '1', capMs);
      if (run.turns['1'].resultAt) run.endedTurn = !(await ready(ctx, run, kase, 'the prompt after the turn'));
    } else if (kase.q === 'b-settings') {
      await toolTurn(ctx, run, '1', capMs);
      why = await ready(ctx, run, kase, 'the prompt after the first turn');
      if (why) { run.why = why; return run; }
      run.rewrittenAt = now();
      writeWhole(run.settingsFile, settingsText(ctx, run, `${sid}-two`));
      await sleep(3000);
      await toolTurn(ctx, run, '2', capMs);
      await ready(ctx, run, kase, 'the prompt after the second turn');
    } else if (kase.q === 'b-mcp') {
      run.firstList = !!(await until(() => serverLog(run, 'one').find((e) => e.ev === 'method' && e.method === 'tools/list'), 30000, run));
      run.rewrittenAt = now();
      writeWhole(run.mcpFile, mcpText(ctx, run, 'two'));
      fs.writeFileSync(path.join(dirs.tools, 'one.stop'), '');
      run.oneExited = !!(await until(() => serverLog(run, 'one').find((e) => e.ev === 'exit'), 10000, run));
      // Removed again, so a server one started anew does not end at once.
      try { fs.unlinkSync(path.join(dirs.tools, 'one.stop')); } catch { /* gone */ }
      await sleep(5000);
      run.reconnectAt = now();
      run.mcpSteps = await mcpReconnect(run);
      await sleep(15000);
      run.mcpScreen = (await screenText(run)).split('\n').filter((l) => /conductor|reconnect|fail|connect/i.test(l)).map((l) => l.trim()).slice(0, 12);
      await typeKeys(run, ['\u001b']);
      await sleep(500);
      await typeKeys(run, ['\u001b']);
    } else if (kase.q === 'c') {
      run.firstList = !!(await until(() => serverLog(run, 'one').find((e) => e.ev === 'method' && e.method === 'tools/list'), 30000, run));
      await listTurn(ctx, run, '1');
      why = await ready(ctx, run, kase, 'the prompt after the first turn');
      if (why) { run.why = why; return run; }
      fs.writeFileSync(path.join(dirs.tools, 'one.add'), '');
      const sent = await until(() => serverLog(run, 'one').find((e) => e.ev === 'sent'), 10000, run);
      run.notifiedAt = sent ? sent.t : null;
      await sleep(10000);
      await listTurn(ctx, run, '2');
      await ready(ctx, run, kase, 'the prompt after the second turn');
    }
  } finally {
    run.hookRows = await hookRows(run).catch(() => []);
    run.screen = (await screenOf(run.pane).catch(() => ({ rows: [] }))).rows.map((r) => r.replace(/\s+$/, ''));
    await endRun(run);
  }
  return run;
}

async function endRun(run) {
  if (!run.exited) {
    for (const k of ['\u0003', '\u0003']) { try { run.pty.write(k); } catch { /* ended */ } await sleep(500); }
    for (let i = 0; i < 25 && !run.exited; i++) await sleep(200);
    run.end = run.exited ? 'exit keys' : 'killed';
  } else run.end = 'ended by itself';
  try { run.pty.kill(); } catch { /* closed */ }
  for (let i = 0; i < 25 && !run.exited; i++) await sleep(200);
  run.closed = true;
  try { run.pane.dispose(); } catch { /* disposed */ }
}

/** A run's reading: what the verdicts and the record need, no handles. */
function readingOf(ctx, run) {
  const hooks = ctx.hooks.seen.filter((h) => h.id === run.sid || h.id === `${run.sid}-one` || h.id === `${run.sid}-two`)
    .map((h) => ({ path: h.id === run.sid ? 'session' : h.id.slice(run.sid.length + 1), t: h.t - run.t0, event: h.event, tool: h.tool, tokenOk: h.tokenOk, mode: h.mode, client: h.client, heldMs: h.closedAt ? h.closedAt - h.t : null }));
  const rel = (t) => (t == null ? null : t - run.t0);
  const turns = Object.fromEntries(Object.entries(run.turns).map(([k, t]) => [k, { ...t, typedAt: rel(t.typedAt), callAt: rel(t.callAt), resultAt: rel(t.resultAt) }]));
  const lists = Object.fromEntries(Object.entries(run.lists).map(([k, t]) => [k, { ...t, typedAt: rel(t.typedAt), at: rel(t.at) }]));
  const server = ['one', 'two'].flatMap((l) => serverLog(run, l)).map((e) => ({ label: e.label, ev: e.ev, method: e.method || null, why: e.why || null, t: e.t - run.t0 })).sort((a, b) => a.t - b.t);
  return {
    id: run.id, case: run.case, cli: run.cli, run: run.k, why: run.why || null, exit: run.exited, end: run.end, bytes: run.bytes, answered: run.answered, notes: run.notes,
    turns, lists, hooks, server, endedTurn: run.endedTurn ?? null, firstList: run.firstList ?? null, oneExited: run.oneExited ?? null,
    rewrittenAt: rel(run.rewrittenAt), reconnectAt: rel(run.reconnectAt), notifiedAt: rel(run.notifiedAt), mcpSteps: run.mcpSteps || null, mcpScreen: run.mcpScreen || null,
    hookRows: run.hookRows, screen: run.screen,
  };
}

// ── verdicts ───────────────────────────────────────────────────────────────
/** Every outcome the same: that verdict; else NO VERDICT. Only `runs` 3
 *  gives a plan verdict; another count gives CHECK RUN. */
function overall(outcomes, names, runs) {
  const all = (o) => outcomes.length > 0 && outcomes.every((x) => x === o);
  let v = 'NO VERDICT';
  for (const [o, name] of names) if (all(o)) v = name;
  if (runs !== 3 || outcomes.length !== 3) return `CHECK RUN (${v.toLowerCase()} in ${outcomes.length} runs)`;
  return v;
}
const range = (xs) => (xs.length ? `${(Math.min(...xs) / 1000).toFixed(1)} to ${(Math.max(...xs) / 1000).toFixed(1)} s` : 'none');

/** (a) one case: each run's outcome, the case's verdict and what it saw. */
function outcomeA(r) {
  const t = r.turns && r.turns['1'];
  if (!t || t.noTool || t.callAt == null) return 'no call';
  if (t.resultAt == null) return 'waiting';
  return t.ran ? 'ran' : 'blocked';
}
function verdictA(readings, runs) {
  const outcomes = readings.map(outcomeA);
  const verdict = overall(outcomes, [['ran', 'RUNS THE TOOL'], ['blocked', 'BLOCKS THE TOOL'], ['waiting', 'STILL WAITING'], ['no call', 'CANNOT MEASURE']], runs);
  const waits = readings.map((r) => r.turns['1'] && r.turns['1'].waitMs).filter((x) => Number.isFinite(x));
  const hookSeen = readings.filter((r) => (r.hooks || []).some((h) => h.event === 'PreToolUse')).length;
  const held = readings.flatMap((r) => (r.hooks || []).filter((h) => h.heldMs != null).map((h) => h.heldMs));
  const rows = [...new Set(readings.flatMap((r) => r.hookRows || []))].slice(0, 6);
  const summary = `${verdict}; wait ${range(waits)}; PreToolUse seen by the endpoint in ${hookSeen} of ${readings.length}${held.length ? `; a held request given up by the CLI after ${range(held)}` : ''}${rows.length ? `; the screen showed: ${rows.map((x) => JSON.stringify(x)).join(' / ')}` : ''}`;
  return { verdict, outcomes, waits, hookSeen, summary };
}

/** (a) one CLI: the control must run the tool with the hook seen. */
function verdictACli(byMode, runs) {
  const ok = byMode.ok;
  const usable = ok && ok.verdict === 'RUNS THE TOOL' && ok.hookSeen === 3;
  return { usable, line: usable || !ok ? null : `CANNOT MEASURE (the control read ${ok.verdict}, PreToolUse seen in ${ok.hookSeen} of 3)` };
}

/** (b) --settings. */
function outcomeBSettings(r) {
  const at = r.rewrittenAt;
  const first = (r.hooks || []).some((h) => h.path === 'one' && h.event === 'PreToolUse' && (at == null || h.t < at));
  if (!first || at == null) return 'cannot';
  const after = (r.hooks || []).filter((h) => h.event === 'PreToolUse' && h.t >= at);
  const one = after.some((h) => h.path === 'one');
  const two = after.some((h) => h.path === 'two');
  return two && !one ? 'again' : one && !two ? 'once' : !one && !two ? 'dropped' : 'both';
}
function verdictBSettings(readings, runs) {
  const outcomes = readings.map(outcomeBSettings);
  return { verdict: overall(outcomes, [['again', 'READS AGAIN'], ['once', 'READS ONCE'], ['dropped', 'HOOK DROPPED'], ['cannot', 'CANNOT MEASURE']], runs), outcomes };
}

/** (b) --mcp-config. */
function outcomeBMcp(r) {
  if (!r.firstList) return 'cannot';
  const after = (r.server || []).filter((e) => e.ev === 'start' && r.reconnectAt != null && e.t >= r.reconnectAt);
  const one = after.some((e) => e.label === 'one');
  const two = after.some((e) => e.label === 'two');
  return two && !one ? 'again' : one && !two ? 'once' : !one && !two ? 'none' : 'both';
}
function verdictBMcp(readings, runs) {
  const outcomes = readings.map(outcomeBMcp);
  const self = readings.filter((r) => (r.server || []).some((e) => e.ev === 'start' && r.rewrittenAt != null && e.t >= r.rewrittenAt && (r.reconnectAt == null || e.t < r.reconnectAt))).length;
  return { verdict: overall(outcomes, [['again', 'READS AGAIN'], ['once', 'READS ONCE'], ['none', 'NO RECONNECT'], ['cannot', 'CANNOT MEASURE']], runs), outcomes, startedOfItself: self };
}

/** (c) one CLI. */
function outcomeC(r) {
  if (!r.firstList || r.notifiedAt == null) return 'cannot';
  const relisted = (r.server || []).some((e) => e.ev === 'method' && e.method === 'tools/list' && e.t > r.notifiedAt && e.t <= r.notifiedAt + 10000);
  const control = r.lists && r.lists['1'] && r.lists['1'].first === true;
  const inTurn = control ? !!(r.lists['2'] && r.lists['2'].second) : null;
  if (relisted) return inTurn === false ? 'listed, not in the turn' : 'again';
  return inTurn === true ? 'in the turn, not listed' : 'not';
}
function verdictC(readings, runs) {
  const outcomes = readings.map(outcomeC);
  const turnHalf = readings.filter((r) => r.lists && r.lists['1'] && r.lists['1'].first === true).length;
  return { verdict: overall(outcomes, [['again', 'LISTS AGAIN'], ['not', 'DOES NOT LIST AGAIN'], ['cannot', 'CANNOT MEASURE']], runs), outcomes, turnHalfMeasured: turnHalf };
}

// ── the result ─────────────────────────────────────────────────────────────
function codeDigests() {
  const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
  return { probe: sha(__filename), standIn: sha(STAND_IN), toolServer: sha(TOOL_SERVER) };
}

function sanitizer(pairs) {
  const list = pairs.filter(([p]) => p && p.length > 3).flatMap(([p, tag]) => [[p, tag], [p.replace(/\\/g, '/'), tag], [p.replace(/\\/g, '\\\\'), tag]]).sort((a, b) => b[0].length - a[0].length);
  const fix = (s) => { let out = s; for (const [p, tag] of list) out = out.split(p).join(tag); return out; };
  const walk = (v) => (typeof v === 'string' ? fix(v) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [fix(k), walk(x)])) : v);
  return walk;
}

function removeTempRoot(dir) {
  // Guarded: only a folder this probe made, directly in the system's temporary folder.
  if (!dir || !fs.existsSync(dir)) return null;
  const tmp = fs.realpathSync(os.tmpdir());
  if (path.dirname(fs.realpathSync(dir)) !== tmp || !path.basename(dir).startsWith('p20-')) return `not removed (not the probe's own folder): ${dir}`;
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch (e) { return `could not be removed: ${e.code || e.message}`; }
  return fs.existsSync(dir) ? 'still there after it was removed' : null;
}

async function sweep(ctx, where) {
  try {
    const list = await listProcesses();
    const left = [];
    for (const p of ownedProcesses(list, ctx.known, ctx.skip)) {
      const how = await stopChecked(p);
      left.push({ name: p.name, how });
      if (how.startsWith('still') || how.startsWith('could not')) ctx.incomplete.push(`${p.name} (pid ${p.pid}) ${how}`);
    }
    return left;
  } catch (e) {
    ctx.incomplete.push(`the processes after ${where} could not be listed (${e.message})`);
    return null;
  }
}

async function main() {
  const [cmdName, ...rest] = process.argv.slice(2);
  if (cmdName !== 'run') throw new CouldNotRun('usage: node p20-probe.cjs run --root <checkout> --out <folder> --forwarder <folder> [--claude <program>] [--codex <program>] [--only <cases>] [--runs <n>] [--cap-s <s>]');
  const args = parseArgs(rest);
  if (!args.root || !args.out || !args.forwarder) throw new CouldNotRun('run needs --root, --out and --forwarder');
  const runs = args.runs ? Number(args.runs) : 3;
  if (!Number.isInteger(runs) || runs < 1 || runs > 5) throw new CouldNotRun('--runs must be 1 to 5');
  const capMs = (args['cap-s'] ? Number(args['cap-s']) : 720) * 1000;
  if (!Number.isFinite(capMs) || capMs < 30000) throw new CouldNotRun('--cap-s must be 30 or more');
  const cases = pickCases(args.only ? args.only.split(',') : null);
  if (!cases.length) throw new CouldNotRun(`--only names no case (the cases: ${CASES.map((c) => c.id).join(', ')})`);
  const mods = loadPinned(path.resolve(args.root));
  const { Terminal } = mods['@xterm/headless'].mod;
  const out = path.resolve(args.out);
  fs.mkdirSync(out, { recursive: true });
  const ctx = {
    pty: mods['node-pty'].mod, ptyMode: ptyOptions(mods['node-pty'].dir), known: new Map(), skip: new Set(), incomplete: [], versions: {}, commands: {}, model: [], capMs,
    tempRoot: fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'p20-')),
    newPane: () => new Terminal({ cols: COLS, rows: ROWS, scrollback: 1000, allowProposedApi: true }),
    system: `${process.platform} ${os.release()} ${process.arch}`,
  };
  const writeErrors = [];
  process.on('uncaughtException', (e) => {
    if (e && e.syscall === 'write' && ['EAGAIN', 'EPIPE', 'ECONNRESET', 'EOF'].includes(e.code)) { writeErrors.push(`a write failed with ${e.code}`); return; }
    console.error(e.stack);
    ctx.incomplete.push(`an error the probe did not expect: ${e.message}`);
  });
  const result = { probe: 'P20', started: new Date().toISOString(), system: ctx.system, node: process.version, files: codeDigests(), modules: { 'node-pty': mods['node-pty'].version, '@xterm/headless': mods['@xterm/headless'].version }, conpty: ctx.ptyMode.id, runs, capS: capMs / 1000, programs: {}, readings: [], verdicts: {}, sweeps: [] };
  const sanitize = () => sanitizer([[ctx.tempRoot, '<temp>'], [os.homedir(), '<home>'], [process.execPath, '<node>'], ...Object.entries(ctx.commands).map(([id, c]) => [c, `<${id}>`])]);
  const lines = [];
  let line = null;
  let model = null;
  ctx.hooks = hookEndpoint();
  try {
    model = standIn.createModelStandIn({ onEvent: (e) => ctx.model.push(e) });
    ctx.modelPort = await model.listen();
    ctx.hookPort = await ctx.hooks.listen();
    // The forwarder, copied to a plain path, as the app stages it.
    const scripts = path.join(ctx.tempRoot, 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    for (const f of ['ccc-codex-hook.cmd', 'ccc-codex-hook.js']) fs.copyFileSync(path.join(path.resolve(args.forwarder), f), path.join(scripts, f));
    result.forwarder = Object.fromEntries(['ccc-codex-hook.cmd', 'ccc-codex-hook.js'].map((f) => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(scripts, f), 'utf8').replace(/\r\n/g, '\n')).digest('hex')]));
    ctx.hookCommand = IS_WIN ? path.join(scripts, 'ccc-codex-hook.cmd') : `node '${path.join(scripts, 'ccc-codex-hook.js')}'`;
    if (IS_WIN && !PLAIN_WIN_PATH_RE.test(ctx.hookCommand)) throw new CouldNotRun(`the forwarder's path is not one plain word: ${ctx.hookCommand}`);
    for (const cli of ['claude', 'codex']) {
      if (!cases.some((c) => c.cli === cli)) continue;
      if (!args[cli]) throw new CouldNotRun(`--${cli} is needed for ${cases.filter((c) => c.cli === cli).map((c) => c.id).join(', ')}`);
      const file = path.resolve(args[cli]);
      if (IS_WIN && /\.(cmd|bat)$/i.test(file)) throw new CouldNotRun(`--${cli} is a .cmd or .bat file; give the program it runs`);
      if (!fs.existsSync(file)) throw new CouldNotRun(`--${cli}: no file at ${file}`);
      ctx.commands[cli] = file;
      const vdirs = makeDirs(path.join(ctx.tempRoot, `version-${cli}`));
      ctx.versions[cli] = await new Promise((resolve) => cp.execFile(file, ['--version'], { env: freshEnv(vdirs), cwd: vdirs.work, windowsHide: true, timeout: 30000 }, (err, so, se) => resolve(`${so || ''}${se || ''}`.trim().split(/\r?\n/)[0] || (err ? err.message : ''))));
      result.programs[cli] = { program: file, version: ctx.versions[cli] };
    }
    console.log(`P20: node-pty ${mods['node-pty'].version} (${ctx.ptyMode.id} ConPTY), @xterm/headless ${mods['@xterm/headless'].version}, node ${process.version}; model stand-in 127.0.0.1:${ctx.modelPort}, hook endpoint 127.0.0.1:${ctx.hookPort}; ${Object.entries(ctx.versions).map(([c, v]) => `${c} ${v}`).join(', ')}`);
    const byCase = {};
    for (const kase of cases) {
      const done = await Promise.all(Array.from({ length: runs }, (_, i) => runOne(ctx, kase, i + 1).catch((e) => ({ id: `${kase.id}-${i + 1}`, case: kase.id, cli: kase.cli, run: i + 1, why: `the run failed: ${e.message}`, turns: {}, lists: {}, hooks: [], server: [], notes: [], answered: [], dirs: null }))));
      const readings = done.map((r) => (r.dirs ? readingOf(ctx, r) : r));
      result.readings.push(...readings);
      byCase[kase.id] = readings;
      result.sweeps.push({ after: kase.id, stopped: await sweep(ctx, kase.id) });
      console.log(`P20: ${kase.id}: ${readings.map((r) => (r.why ? `run ${r.run}: ${r.why}` : `run ${r.run}: ${kase.q === 'a' ? outcomeA(r) : kase.q === 'b-settings' ? outcomeBSettings(r) : kase.q === 'b-mcp' ? outcomeBMcp(r) : outcomeC(r)}`)).join('; ')}`);
    }
    for (const cli of ['claude', 'codex']) {
      const modes = Object.fromEntries(A_MODES.filter((m) => byCase[`${cli}-a-${m}`]).map((m) => [m, verdictA(byCase[`${cli}-a-${m}`], runs)]));
      if (!Object.keys(modes).length) continue;
      const c = verdictACli(modes, runs);
      result.verdicts[`${cli}-a`] = { ...modes, cli: c };
      lines.push(`P20 (a) ${cli === 'claude' ? 'Claude Code' : 'Codex'}${c.line ? `: ${c.line}` : ''}: ${Object.entries(modes).map(([m, v]) => `${m}: ${v.summary}`).join(' || ')}`);
    }
    if (byCase['claude-b-settings']) { const v = verdictBSettings(byCase['claude-b-settings'], runs); result.verdicts['claude-b-settings'] = v; lines.push(`P20 (b) Claude Code --settings: ${v.verdict} (${v.outcomes.join(', ')})`); }
    if (byCase['claude-b-mcp']) { const v = verdictBMcp(byCase['claude-b-mcp'], runs); result.verdicts['claude-b-mcp'] = v; lines.push(`P20 (b) Claude Code --mcp-config: ${v.verdict} (${v.outcomes.join(', ')}; a server started of itself before /mcp in ${v.startedOfItself} of ${byCase['claude-b-mcp'].length})`); }
    for (const cli of ['claude', 'codex']) {
      if (!byCase[`${cli}-c`]) continue;
      const v = verdictC(byCase[`${cli}-c`], runs);
      result.verdicts[`${cli}-c`] = v;
      lines.push(`P20 (c) ${cli === 'claude' ? 'Claude Code' : 'Codex'}: ${v.verdict} (${v.outcomes.join(', ')}; the turn half measured in ${v.turnHalfMeasured} of ${byCase[`${cli}-c`].length})`);
    }
    line = `P20 RESULT (${ctx.system}; ${Object.entries(ctx.versions).map(([c, v]) => `${c} ${v}`).join(', ')}): ${Object.entries(result.verdicts).map(([k, v]) => `${k} ${v.verdict || Object.entries(v).filter(([m]) => m !== 'cli').map(([m, x]) => `${m}=${x.verdict}`).join(' ')}`).join('; ')}`;
  } catch (e) {
    line = `P20 RESULT: COULD NOT RUN - ${e.message}`;
    if (!(e instanceof CouldNotRun)) console.error(e.stack);
  } finally {
    if (model) await model.close().catch(() => {});
    await ctx.hooks.close().catch(() => {});
    result.sweeps.push({ after: 'the end', stopped: await sweep(ctx, 'the end') });
    const removed = removeTempRoot(ctx.tempRoot);
    if (removed) ctx.incomplete.push(`the temporary folder ${removed}`);
    try {
      const left = ownedProcesses(await listProcesses(), ctx.known, new Set());
      if (left.length) ctx.incomplete.push(`still running: ${left.map((p) => `${p.name} (pid ${p.pid})`).join(', ')}`);
    } catch (e) { ctx.incomplete.push(`the last process list failed (${e.message})`); }
  }
  if (ctx.incomplete.length) line += `; clean-up incomplete: ${ctx.incomplete.join('; ')}`;
  result.ended = new Date().toISOString();
  result.cleanup = ctx.incomplete.length ? ctx.incomplete : 'complete';
  result.writeErrors = writeErrors;
  result.lines = lines;
  result.line = line;
  const clean = sanitize();
  fs.writeFileSync(path.join(out, 'p20-result.json'), JSON.stringify(clean(result), null, 2) + '\n');
  for (const l of lines) console.log(clean(l));
  console.log(clean(line));
  return line.includes('COULD NOT RUN') || ctx.incomplete.length ? 2 : 0;
}

// node-pty's Windows output reader can keep the event loop alive after its
// pseudo console is closed, so the probe ends itself.
const finish = (code) => process.stdout.write('', () => process.exit(code));
if (require.main === module) {
  main().then(finish, (e) => { console.log(`P20 RESULT: COULD NOT RUN - ${e.message}`); finish(2); });
}

// For tests/unit/scripts/probe-p20.test.ts, which loads this file without
// running it.
module.exports = {
  CASES, pickCases, outcomeA, verdictA, verdictACli, outcomeBSettings, verdictBSettings, outcomeBMcp, verdictBMcp, outcomeC, verdictC, overall, ownedProcesses, sanitizer, codeDigests,
};
