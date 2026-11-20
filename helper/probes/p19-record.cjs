'use strict';
/*
 * Probe P19 (ADR-030; plan 2.1.3-beta.11, section A1, aicc_planning #340):
 * after a re-attach that starts in the middle of a session's output, does a
 * resize make Claude Code and Codex redraw their screen?
 *
 * Why: a held terminal the app takes over again is replayed from the holder's
 * ring, and a ring that no longer holds the session's first byte replays from
 * the middle of its output (helper-protocol.md section 11: "the resize makes
 * the CLI redraw"). Nobody had measured that sentence.
 *
 * What it does. For each program (Claude Code, Codex, and the system's default
 * shell as a row with no verdict) it starts the program on a terminal of 120
 * by 40 with node-pty (on Windows on node-pty's bundled ConPTY, the options
 * src/main/bundled-conpty.ts gives a PTY, or on the system's ConPTY, or both:
 * --conpty), and writes every chunk it reads, with its offset and time, to a
 * recording. It types the keys the scenario file (p19-scenarios.json) names
 * and measures at the marks it names. Each program runs in a fresh
 * environment: HOME, USERPROFILE, APPDATA, LOCALAPPDATA, CLAUDE_CONFIG_DIR,
 * CODEX_HOME and the temporary folders inside the probe's own temporary
 * folder, a new one per run; no account, no key of anyone's. Each CLI is
 * pointed at p19-model-stand-in.cjs, a server on a loopback port, by its own
 * settings (Claude Code: ANTHROPIC_BASE_URL and a made-up key; Codex: a model
 * provider in config.toml), so it reaches its prompt and runs one turn whose
 * reply is about 300 lines. Codex runs with --no-daemon, without its
 * background server: 0.157.1 refuses that server in an elevated session (the
 * test machine's SSH session, GitHub's Windows runner), and on macOS the
 * server's socket path under the runner's temporary folder is too long.
 *
 * The states, per CLI: its first screen with no account (an empty config);
 * its ready prompt; the middle of the streamed reply (35% of its lines sent);
 * after the reply (the prompt back, history above it, some scrolled off).
 * The shell: after 300 lines of output.
 *
 * The measurement, at each mark, in each run. Two panes of @xterm/headless,
 * 120 by 40, 1000 lines of scrollback. Pane 1 has been fed every byte from the
 * first, and it answers the program's terminal queries, as the app's own
 * terminal does. Pane 2 is made at the mark and fed only the bytes from a cut
 * 64 KiB before the mark (or from the middle of the output when there is
 * less), cut at a byte, not at the end of a sequence, as the ring cuts; from
 * then on both are fed every chunk. Then three steps, each compared 2 s
 * later, rows as the app's readers take them (text, the dim cells blanked,
 * the inverse cells: readXtermScreen, src/shared/codex-screen.ts, copied
 * here):
 *   step 0 nothing;
 *   step 1 a resize of the PTY to the size it has (what the app sends after
 *          an attach today, session-helper/helper-pty.ts);
 *   step 2 a nudge: the PTY one row shorter, then back 300 ms later (compared
 *          2 s after it is back).
 * Only the PTY is resized; the panes keep 120 by 40, as the app's terminal
 * would for a nudge it sends itself. Recorded per step: equal or not (and the
 * rows that differ), the bytes the program wrote after the step, when the
 * panes were first equal in the 250 ms samples, and how many of the last 200
 * lines differ (the Watchdog's reach; no verdict, since lines the ring lost
 * stay lost).
 *
 * Decision lines (the plan's, written before measuring), per CLI per system:
 *   REPAINTS: at every state reached, in 3 of 3 runs, pane 2's rows equal
 *     pane 1's 2 s after the nudge (step 2).
 *   DOES NOT REPAINT: a state where they differ after the nudge in 2 of 3 runs
 *     or more.
 *   CANNOT MEASURE, for a state: the CLI cannot be brought to it (recorded
 *     with what it showed). A CLI that reaches no state past its first screen
 *     is CANNOT MEASURE.
 *   Step 1 is recorded beside the verdict.
 * Read here as well: a state where they differ in 1 of 3 runs, or with fewer
 * than 3 runs that reached it, and no state that differs in 2 or more, gives
 * NO VERDICT (the plan's lines do not cover it). Only --runs 3 gives a plan
 * verdict; another count gives CHECK RUN with what it saw. On Windows each
 * ConPTY gets a verdict of its own. The verdict also names each state where
 * pane 2 already matched pane 1 before any resize in every run that reached
 * it: the nudge had nothing to put right there, so it was not put to the test.
 *
 * It refuses node-pty or @xterm/headless at any version but the one the
 * checkout's package.json and package-lock.json name, prints both, and
 * refuses a .cmd or .bat program on Windows (node-pty starts a program file).
 * It cleans up in finally blocks: each program is ended (its exit keys, then
 * node-pty's kill), then every process that is its or this probe's
 * descendant (a child counts only when it started after its parent and, for
 * a program that has ended, before that program ended), and the stand-in,
 * are stopped, each only after its name and start time are checked again;
 * then the temporary folder is removed and anything of its own still running
 * is listed. A program's end is when node-pty reports its exit (on the
 * system ConPTY about a second after the real end); the children of a
 * program whose exit was never reported are left out, neither stopped nor
 * listed.
 *
 * Usage:
 *   node p19-record.cjs run --root <checkout> --out <folder> [--claude <program>]
 *       [--codex <program>] [--conpty bundled|system|both] [--only claude,codex,shell]
 *       [--runs <n>] [--scenarios <file>]
 *   node p19-record.cjs locate <claude prefix> <codex prefix>
 *       (CI: the native programs of the two packages npm installed with scripts
 *       off, written to GITHUB_OUTPUT as claude= and codex=)
 * --root is a checkout whose node_modules hold the pinned node-pty and
 * @xterm/headless (on the test machine, its own repository checkout).
 *
 * Writes to --out: recordings/<program>-<conpty>-<launch>-<run>.jsonl (a
 * header line, then one line per chunk {o, t, b: base64}, and one per event:
 * keys, resize, mark, exit) and p19-result.json. The header line and the
 * result both name the probe code that made them (`files`: the sha256 of
 * this file, the stand-in and the scenario file, each read with LF line
 * ends, so a Windows checkout gives the same digest and
 * `git show <commit>:<file> | sha256sum` checks it). The result writes the
 * temporary folder, the home folder and the programs' paths as <temp>, <home>,
 * <claude>, <codex> and <shell>. A recording keeps the bytes as read; the
 * only paths in it are the probe's own temporary folder under the machine's
 * own account. The last line is "P19 RESULT: ..." with each CLI's verdict
 * (per ConPTY on Windows) and the shell's summary, or "P19 RESULT: COULD NOT
 * RUN - <reason>", with "; clean-up incomplete: <what>" added when something
 * was left. Exit code 0 when it ran to the end, 2 when it could not run or
 * the clean-up was incomplete.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const IS_WIN = process.platform === 'win32';
const STAND_IN = path.join(__dirname, 'p19-model-stand-in.cjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

class CouldNotRun extends Error {}

// ── arguments ──────────────────────────────────────────────────────────────
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

// ── the pinned modules ─────────────────────────────────────────────────────
/** True when `v` is the version `spec` names: the same, or for a caret range
 *  (^X.Y.Z, X above 0) the same major and not lower. */
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
  console.log(`P19: loaded node-pty ${out['node-pty'].version} (package.json ${out['node-pty'].spec}) and @xterm/headless ${out['@xterm/headless'].version} (package.json ${out['@xterm/headless'].spec}, package-lock ${out['@xterm/headless'].locked}); node ${process.version}`);
  return out;
}

/** The ConPTYs to run on. node-pty loads its native module from the first of
 *  these folders that holds it (lib/utils.js, loadNativeModule) and looks for
 *  conpty.dll in a `conpty` folder beside it, as bundled-conpty.ts does. */
function conptyModes(ptyDir, wanted) {
  if (!IS_WIN) return [{ id: 'pty', label: 'pty', options: { encoding: null } }];
  if (!['bundled', 'system', 'both'].includes(wanted)) throw new CouldNotRun(`--conpty must be bundled, system or both (got ${wanted})`);
  let nativeDir = null;
  for (const d of ['build/Release', 'build/Debug', `prebuilds/${process.platform}-${process.arch}`]) {
    if (fs.existsSync(path.join(ptyDir, d, 'conpty.node'))) { nativeDir = path.join(ptyDir, d); break; }
  }
  const modes = [];
  if (wanted !== 'system') {
    const ok = nativeDir && ['conpty.dll', 'OpenConsole.exe'].every((f) => fs.statSync(path.join(nativeDir, 'conpty', f), { throwIfNoEntry: false }));
    if (!ok) throw new CouldNotRun(`the bundled ConPTY is not beside node-pty's native module (${nativeDir || 'no native module found'})`);
    modes.push({ id: 'bundled', label: 'bundled ConPTY', options: { useConpty: true, useConptyDll: true } });
  }
  if (wanted !== 'bundled') modes.push({ id: 'system', label: 'system ConPTY', options: { useConpty: true } });
  return modes;
}

// ── processes ──────────────────────────────────────────────────────────────
/** A start time as milliseconds, or null when it cannot be read. */
const startMs = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? t : null; };

/** Every process on the machine: pid, parent, start time (as listed, and as
 *  milliseconds) and name. Run asynchronously, so the terminals keep being
 *  read meanwhile. */
function listProcesses() {
  return new Promise((resolve, reject) => {
    const done = (child, parse) => (err, stdout) => {
      if (err) { reject(new Error(`the process list failed: ${err.message}`)); return; }
      try { resolve({ self: child.pid, procs: parse(stdout) }); } catch (e) { reject(e); }
    };
    if (IS_WIN) {
      const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const cmd = "Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p = [int]$_.ProcessId; q = [int]$_.ParentProcessId; s = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }); n = [string]$_.Name } } | ConvertTo-Json -Compress";
      const child = cp.execFile(ps, ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout: 60000, maxBuffer: 1 << 24 },
        done({ get pid() { return child.pid; } }, (out) => [].concat(JSON.parse(out)).map((x) => ({ pid: x.p, ppid: x.q, start: x.s, startMs: startMs(x.s), name: x.n }))));
      return;
    }
    const child = cp.execFile('ps', ['-A', '-o', 'pid=,ppid=,lstart=,comm='], { timeout: 60000, maxBuffer: 1 << 24 },
      done({ get pid() { return child.pid; } }, (out) => out.split('\n').filter((l) => l.trim()).map((l) => {
        const m = /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3} +\d+ \d+:\d+:\d+ \d{4})\s+(.*)$/.exec(l);
        const start = m && m[3].replace(/ +/g, ' ');
        return m ? { pid: Number(m[1]), ppid: Number(m[2]), start, startMs: startMs(start), name: m[4].trim() } : null;
      }).filter(Boolean)));
  });
}

/** The processes that are this probe's: its descendants, and any child of a
 *  program it started that has ended (an orphan keeps its parent's id on
 *  Windows). A program it started is followed only while its id still names
 *  the same process or none. Windows never updates a parent id and reuses
 *  ids, so a process whose parent id is ours may be another's: a child
 *  counts only when it started after its parent and, for a program that has
 *  ended, before that program ended. When a start or that end is not known,
 *  the child is left out. The lister itself and `skip` are left out. */
function ownedProcesses(list, known, skip) {
  const byPid = new Map(list.procs.map((p) => [p.pid, p]));
  const byParent = new Map();
  for (const p of list.procs) { if (!byParent.has(p.ppid)) byParent.set(p.ppid, []); byParent.get(p.ppid).push(p); }
  // Each root with the times its children must have started between.
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
      if (c.pid === process.pid || c.pid === list.self || skip.has(c.pid) || out.has(c.pid)) continue;
      if (!Number.isFinite(c.startMs) || c.startMs < from || c.startMs > to) continue;
      out.set(c.pid, c);
      stack.push({ pid: c.pid, from: c.startMs, to: Infinity });
    }
  }
  return [...out.values()];
}

/** Stops one process, only when its pid still names the same program started
 *  at the same time. */
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
    const s = await same();
    if (s !== true) return 'stopped';
  }
  if (!IS_WIN) {
    try { process.kill(p.pid, 'SIGKILL'); } catch { /* checked below */ }
    await sleep(500);
    if ((await same()) !== true) return 'stopped (SIGKILL)';
  }
  return 'still running after it was stopped';
}

// ── panes ──────────────────────────────────────────────────────────────────
/** The rows of a pane's live screen, as readXtermScreen
 *  (src/shared/codex-screen.ts) reads them: text, the dim cells blanked
 *  (`typed`) and the inverse cells only (`inverse`), trailing spaces trimmed. */
function readRows(term) {
  const buf = term.buffer.active;
  const out = [];
  for (let y = buf.baseY; y < buf.baseY + term.rows; y++) {
    const line = buf.getLine(y);
    if (!line) { out.push({ text: '', typed: '', inverse: '' }); continue; }
    let text = '';
    let typed = '';
    let inverse = '';
    for (let x = 0; x < term.cols; x++) {
      const cell = line.getCell(x);
      if (!cell) break;
      if (cell.getWidth() === 0) continue;
      const ch = cell.getChars() || ' ';
      text += ch;
      typed += cell.isDim() ? ' '.repeat(ch.length) : ch;
      inverse += cell.isInverse() ? ch : ' '.repeat(ch.length);
    }
    out.push({ text: text.replace(/\s+$/, ''), typed: typed.replace(/\s+$/, ''), inverse: inverse.replace(/\s+$/, '') });
  }
  return out;
}

function tailLines(term, n) {
  const buf = term.buffer.active;
  const out = [];
  for (let y = Math.max(0, buf.length - n); y < buf.length; y++) {
    const line = buf.getLine(y);
    out.push(line ? line.translateToString(true) : '');
  }
  return out;
}

/** A pane's state once it has parsed everything written to it so far. */
function snap(term, n) {
  return new Promise((resolve, reject) => term.write('', () => {
    // A throw here would be lost inside xterm's write loop: handed on instead.
    try {
      resolve({
        rows: readRows(term),
        tail: tailLines(term, n),
        cursor: [term.buffer.active.cursorX, term.buffer.active.cursorY],
        length: term.buffer.active.length,
        buffer: term.buffer.active.type,
      });
    } catch (e) { reject(e); }
  }));
}

const sameRow = (a, b) => a.text === b.text && a.typed === b.typed && a.inverse === b.inverse;
function compareSnaps(a, b, n) {
  const rows = [];
  for (let i = 0; i < Math.max(a.rows.length, b.rows.length); i++) {
    const x = a.rows[i] || { text: '', typed: '', inverse: '' };
    const y = b.rows[i] || { text: '', typed: '', inverse: '' };
    if (!sameRow(x, y)) {
      rows.push({ row: i, fields: ['text', 'typed', 'inverse'].filter((f) => x[f] !== y[f]), pane1: x.text, pane2: y.text });
    }
  }
  const pad = (t) => [...Array(Math.max(0, n - t.length)).fill(null), ...t.slice(-n)];
  const ta = pad(a.tail);
  const tb = pad(b.tail);
  let tailDiffer = 0;
  for (let i = 0; i < n; i++) if ((ta[i] ?? '') !== (tb[i] ?? '') || (ta[i] === null) !== (tb[i] === null)) tailDiffer += 1;
  return { equal: rows.length === 0, rows, tailDiffer, tailLengths: [a.tail.length, b.tail.length], cursor: [a.cursor, b.cursor], buffers: [a.buffer, b.buffer] };
}

// ── the probe ──────────────────────────────────────────────────────────────
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
  if (!IS_WIN) {
    Object.assign(env, {
      TMPDIR: dirs.tmp, TERM: 'xterm-256color', XDG_CONFIG_HOME: path.join(dirs.home, '.config'),
      XDG_CACHE_HOME: path.join(dirs.home, '.cache'), XDG_DATA_HOME: path.join(dirs.home, '.local', 'share'), XDG_STATE_HOME: path.join(dirs.home, '.local', 'state'),
    });
    if (!env.LANG && !env.LC_ALL) env.LANG = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
  }
  return Object.assign(env, extra || {});
}

function makeDirs(base) {
  const dirs = {};
  for (const k of ['home', 'appdata', 'localappdata', 'claude', 'codex', 'tmp', 'work']) {
    dirs[k] = path.join(base, k);
    fs.mkdirSync(dirs[k], { recursive: true });
  }
  return dirs;
}

function defaultShell() {
  if (IS_WIN) return { file: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: [] };
  if (process.env.SHELL) return { file: process.env.SHELL, args: [] };
  if (process.platform === 'darwin') return { file: '/bin/zsh', args: [] };
  for (const f of ['/bin/bash', '/bin/zsh']) if (fs.existsSync(f)) return { file: f, args: [] };
  return { file: '/bin/sh', args: [] };
}

/** Runs `file args` to its end in a fresh environment and returns its output. */
function runFresh(file, args, env, cwd) {
  return new Promise((resolve) => {
    cp.execFile(file, args, { env, cwd, windowsHide: true, timeout: 30000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      resolve({ ok: !err, text: `${stdout || ''}${stderr || ''}`.trim().split(/\r?\n/)[0] || (err ? err.message : '') });
    });
  });
}

function seed(ctx, prog, launch, dirs) {
  if (launch.seed === 'claude') {
    // Onboarding done, the made-up key approved and the folder trusted, so
    // Claude Code opens at its prompt (rules in the scenario answer any
    // question it still asks).
    const proj = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, projectOnboardingSeenCount: 1, allowedTools: [] };
    const projects = { [dirs.work]: proj, [dirs.work.replace(/\\/g, '/')]: proj };
    const version = (/\d+\.\d+\.\d+/.exec(ctx.versions.claude || '') || [''])[0];
    fs.writeFileSync(path.join(dirs.claude, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: true, lastOnboardingVersion: version, theme: 'dark', numStartups: 1, autoUpdates: false,
      hasAcknowledgedCostThreshold: true, customApiKeyResponses: { approved: [ctx.scenario.apiKey.slice(-20)], rejected: [] }, projects,
    }, null, 2));
  } else if (launch.seed === 'codex') {
    const toml = [
      'model = "p19-probe"',
      'model_provider = "p19probe"',
      '',
      '[model_providers.p19probe]',
      'name = "p19 probe"',
      `base_url = "http://127.0.0.1:${ctx.port}/v1"`,
      'env_key = "P19_PROBE_KEY"',
      'wire_api = "responses"',
      'request_max_retries = 0',
      'stream_max_retries = 0',
      '',
      `[projects.'${dirs.work}']`,
      'trust_level = "trusted"',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dirs.codex, 'config.toml'), toml);
  } else if (launch.seed === 'shell' && !IS_WIN) {
    // zsh asks a new user to set it up when the home holds none of its files.
    fs.writeFileSync(path.join(dirs.home, '.zshrc'), '');
  }
}

function extraEnv(ctx, prog, launch) {
  if (prog.id === 'claude') {
    return {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${ctx.port}`, DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ...(launch.seed === 'claude' ? { ANTHROPIC_API_KEY: ctx.scenario.apiKey } : {}),
    };
  }
  if (prog.id === 'codex') return { P19_PROBE_KEY: 'p19-probe-placeholder-not-a-key' };
  return {};
}

function rec(run, o) {
  try { fs.writeSync(run.fd, JSON.stringify(o) + '\n'); } catch { /* a lost line shows as a gap in the offsets */ }
}

function resolveKeys(ctx, keys) {
  const k = typeof keys === 'object' && !Array.isArray(keys) ? (keys[process.platform] ?? keys.default) : keys;
  return [].concat(k).map((s) => s.replace(/\{prompt\}/g, ctx.scenario.prompt));
}

async function typeKeys(ctx, run, keys) {
  const parts = resolveKeys(ctx, keys);
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) await sleep(250);
    rec(run, { ev: 'keys', o: run.total, t: now() - run.t0, keys: parts[i] });
    run.pty.write(parts[i]);
  }
}

function resize(run, cols, rows) {
  rec(run, { ev: 'resize', o: run.total, t: now() - run.t0, cols, rows });
  try { run.pty.resize(cols, rows); } catch (e) { run.notes.push(`a resize to ${cols}x${rows} failed: ${e.message}`); }
}

const screenText = async (ctx, run) => (await snap(run.pane1, 1)).rows.map((r) => r.text).join('\n');

async function settle(ctx, run, step) {
  const start = now();
  const base = run.total;
  for (;;) {
    await sleep(100);
    if (run.exited) return `the program ended (code ${run.exited.code}) while it was settling`;
    const got = run.total - base;
    if (got >= (step.minBytes || 0) && now() - Math.max(run.lastDataAt, start) >= step.quietMs) return null;
    if (now() - start >= step.timeoutMs) {
      // Output that never pauses (an animation) does not stop the run: noted.
      if (got >= (step.minBytes || 0)) { run.notes.push(`not quiet for ${step.quietMs} ms within ${step.timeoutMs} ms; went on`); return null; }
      return `${got} bytes within ${step.timeoutMs} ms (${step.minBytes} wanted)`;
    }
  }
}

async function until(ctx, run, step) {
  const start = now();
  const screen = new RegExp(step.screen, 'u');
  const not = step.not ? new RegExp(step.not, 'iu') : null;
  const rules = (step.rules || []).map((r) => ({ ...r, re: new RegExp(r.screen, 'iu'), count: 0, at: 0 }));
  for (;;) {
    await sleep(200);
    if (run.exited) return `the program ended (code ${run.exited.code}) before ${step.label}`;
    const text = await screenText(ctx, run);
    if (screen.test(text) && !(not && not.test(text))) return null;
    for (const r of rules) {
      if (r.re.test(text) && r.count < (r.max || 3) && now() - r.at > 1500) {
        r.count += 1;
        r.at = now();
        run.answered.push({ rule: r.label, t: now() - run.t0 });
        await typeKeys(ctx, run, r.keys);
        break;
      }
    }
    if (now() - start >= step.timeoutMs) return `${step.label} was not shown within ${step.timeoutMs} ms`;
  }
}

async function waitReply(ctx, run, step, done) {
  const start = now();
  for (;;) {
    const turn = run.requests.find((r) => r.reply === 'turn');
    if (turn) {
      if (done && (turn.done || turn.closed)) return turn.closed ? `the reply was cut off at line ${turn.sent} of ${turn.of}` : null;
      if (!done && turn.sent >= Math.ceil(step.atLeast * turn.of)) return null;
    }
    if (run.exited) return `the program ended (code ${run.exited.code}) ${done ? 'before the reply ended' : 'before the reply reached its middle'}`;
    if (now() - start >= step.timeoutMs) return turn ? `the reply reached line ${turn.sent} of ${turn.of} within ${step.timeoutMs} ms` : `no turn was asked of the stand-in within ${step.timeoutMs} ms`;
    await sleep(100);
  }
}

async function observe(ctx, run, name, act) {
  const S = ctx.scenario;
  const from = run.total;
  const tAct = now();
  await act();
  const tDone = now();
  let firstEqualMs = null;
  for (let t = S.sampleMs; t < S.settleMs; t += S.sampleMs) {
    await sleep(Math.max(0, tDone + t - now()));
    const [a, b] = await Promise.all([snap(run.pane1, 1), snap(run.pane2, 1)]);
    if (firstEqualMs === null && a.rows.every((r, i) => sameRow(r, b.rows[i]))) firstEqualMs = now() - tAct;
  }
  await sleep(Math.max(0, tDone + S.settleMs - now()));
  const at = run.total;
  const [a, b] = await Promise.all([snap(run.pane1, S.tailLines), snap(run.pane2, S.tailLines)]);
  const c = compareSnaps(a, b, S.tailLines);
  if (c.equal && firstEqualMs === null) firstEqualMs = now() - tAct;
  return { step: name, equal: c.equal, bytesAfter: at - from, firstEqualMs: c.equal ? firstEqualMs : null, tailDiffer: c.tailDiffer, tailLengths: c.tailLengths, cursor: c.cursor, buffers: c.buffers, rows: c.rows };
}

async function measure(ctx, run, state) {
  const S = ctx.scenario;
  const { cols, rows } = S.size;
  const n = run.total;
  const all = Buffer.concat(run.chunks, n);
  const cut = n > S.cutBytes ? n - S.cutBytes : Math.floor(n / 2);
  const pane2 = ctx.newPane();
  pane2.write(all.subarray(cut));
  run.pane2 = pane2;
  rec(run, { ev: 'mark', o: n, t: now() - run.t0, state, cut });
  const steps = [];
  try {
    steps.push(await observe(ctx, run, 'nothing', async () => {}));
    steps.push(await observe(ctx, run, 'same size', async () => { resize(run, cols, rows); }));
    steps.push(await observe(ctx, run, 'nudge', async () => { resize(run, cols, rows - 1); await sleep(S.nudgeMs); resize(run, cols, rows); }));
  } finally {
    run.pane2 = null;
    pane2.dispose();
  }
  return { state, reached: true, markOffset: n, markMs: now() - run.t0, cut, replayBytes: n - cut, steps };
}

async function endRun(ctx, run, prog) {
  if (!run.exited) {
    for (const k of prog.exitKeys || []) { try { run.pty.write(k); } catch { /* ended */ } await sleep(500); }
    for (let i = 0; i < 25 && !run.exited; i++) await sleep(200);
    run.end = run.exited ? 'exit keys' : 'killed';
  } else {
    run.end = 'ended by itself';
  }
  // node-pty's kill also closes the pseudo console after a program has ended.
  try { run.pty.kill(); } catch { /* already closed */ }
  for (let i = 0; i < 25 && !run.exited; i++) await sleep(200);
  await sleep(1000);
  run.leftover = [];
  try {
    const list = await listProcesses();
    for (const p of ownedProcesses(list, ctx.known, ctx.skip)) {
      const how = await stopChecked(p);
      run.leftover.push({ name: p.name, pid: p.pid, how });
      if (how.startsWith('still') || how.startsWith('could not')) ctx.incomplete.push(`${p.name} (pid ${p.pid}) ${how}`);
    }
  } catch (e) {
    ctx.incomplete.push(`the processes after ${run.id} could not be listed (${e.message})`);
  }
  run.closed = true;
  try { run.pane1.dispose(); } catch { /* disposed */ }
  try { fs.closeSync(run.fd); } catch { /* closed */ }
}

async function runOne(ctx, prog, mode, launch, k) {
  const S = ctx.scenario;
  const { cols, rows } = S.size;
  const id = `${prog.id}-${mode.id}-${launch.id}-${k}`;
  const dirs = makeDirs(path.join(ctx.tempRoot, id));
  seed(ctx, prog, launch, dirs);
  const env = freshEnv(dirs, extraEnv(ctx, prog, launch));
  const cmd = ctx.commands[prog.id];
  const run = {
    id, program: prog.id, conpty: mode.id, launch: launch.id, run: k, chunks: [], total: 0, t0: now(), lastDataAt: now(),
    pane1: ctx.newPane(), pane2: null, fd: fs.openSync(path.join(ctx.recDir, `${id}.jsonl`), 'w'),
    requests: [], answered: [], notes: [], states: [], exited: null,
  };
  rec(run, recordingHeader(ctx, prog, mode, launch, k));
  ctx.current = run;
  const term = ctx.pty.spawn(cmd.file, cmd.args, { name: 'xterm-256color', cols, rows, cwd: dirs.work, env, ...mode.options });
  run.pty = term;
  // The attached terminal answers the program's terminal queries, as the
  // app's own terminal does; pane 2 is only a viewer.
  run.pane1.onData((d) => { try { term.write(d); } catch { /* ended */ } });
  term.onData((d) => {
    if (run.closed) return;
    const b = Buffer.isBuffer(d) ? d : Buffer.from(d, 'utf8');
    const o = run.total;
    run.chunks.push(b);
    run.total += b.length;
    run.lastDataAt = now();
    rec(run, { o, t: now() - run.t0, b: b.toString('base64') });
    run.pane1.write(b);
    if (run.pane2) run.pane2.write(b);
  });
  // The program as the clean-up knows it: its end, once seen, bounds the
  // children it can have had (ownedProcesses).
  let known = null;
  term.onExit(({ exitCode, signal }) => {
    run.exited = { code: exitCode, signal: signal || null, t: now() - run.t0 };
    if (known) known.endMs = run.t0 + run.exited.t;
    rec(run, { ev: 'exit', o: run.total, t: run.exited.t, code: exitCode, signal: signal || null });
  });
  listProcesses().then((l) => {
    const p = l.procs.find((x) => x.pid === term.pid);
    if (p) { known = { ...p, endMs: run.exited ? run.t0 + run.exited.t : null }; ctx.known.set(p.pid, known); }
  }).catch(() => { /* the end-of-run sweep lists again */ });
  try {
    let why = null;
    for (const step of launch.steps) {
      if (ctx.fatal.length) throw new CouldNotRun(`an error the probe did not expect: ${ctx.fatal[0]}`);
      if (why) {
        if (step.do === 'mark') run.states.push({ state: step.state, reached: false, why, screen: await screenText(ctx, run) });
        continue;
      }
      if (step.do === 'mark') run.states.push(await measure(ctx, run, step.state));
      else if (step.do === 'settle') why = await settle(ctx, run, step);
      else if (step.do === 'until') why = await until(ctx, run, step);
      else if (step.do === 'keys') { await typeKeys(ctx, run, step.keys); if (step.afterMs) await sleep(step.afterMs); }
      else if (step.do === 'reply') why = await waitReply(ctx, run, step, false);
      else if (step.do === 'replyDone') why = await waitReply(ctx, run, step, true);
      else throw new CouldNotRun(`unknown step ${JSON.stringify(step.do)} in the scenario`);
    }
  } finally {
    ctx.current = null;
    await endRun(ctx, run, prog);
  }
  return {
    id, program: prog.id, conpty: mode.id, launch: launch.id, run: k, bytes: run.total, exit: run.exited, end: run.end, answered: run.answered,
    notes: run.notes, requests: run.requests.map((r) => ({ path: r.path, model: r.model, stream: r.stream, tools: r.tools, namesPrompt: r.namesPrompt, reply: r.reply, sent: r.sent, of: r.of, done: !!r.done, closed: !!r.closed })),
    leftover: run.leftover, states: run.states,
  };
}

// ── verdicts ───────────────────────────────────────────────────────────────
function verdictFor(prog, readings, runs) {
  const byState = new Map();
  for (const r of readings) for (const s of r.states) { if (!byState.has(s.state)) byState.set(s.state, []); byState.get(s.state).push(s); }
  const states = [];
  for (const [state, list] of byState) {
    const reached = list.filter((s) => s.reached);
    const step = (i) => reached.filter((s) => s.steps[i].equal).length;
    // Beside the rows: pane 2 on another screen buffer than pane 1 (the switch
    // to the alternate screen was before the cut), not in the verdict.
    const otherBuffer = reached.filter((s) => s.steps[2].buffers[0] !== s.steps[2].buffers[1]).length;
    states.push({
      state, runs: list.length, reached: reached.length, equalAfterNothing: step(0), equalAfterSameSize: step(1), equalAfterNudge: step(2),
      differAfterNudge: reached.length - step(2), otherBufferAfterNudge: otherBuffer,
      pane1Buffer: [...new Set(reached.map((s) => s.steps[2].buffers[0]))].join('/'), notReached: list.filter((s) => !s.reached).map((s) => s.why),
    });
  }
  const summary = states.map((s) => `${s.state}: nudge ${s.equalAfterNudge}/${s.reached}, same size ${s.equalAfterSameSize}/${s.reached}, nothing ${s.equalAfterNothing}/${s.reached}${s.reached < s.runs ? `, not reached in ${s.runs - s.reached}` : ''}${s.otherBufferAfterNudge ? `, pane 2 on another screen in ${s.otherBufferAfterNudge}` : ''}`).join('; ');
  if (!prog.verdict) return { verdict: 'no verdict (a reference row)', states, summary };
  const reachedStates = states.filter((s) => s.reached > 0);
  const cannot = states.filter((s) => s.reached === 0).map((s) => s.state);
  const sameSize = reachedStates.filter((s) => s.equalAfterSameSize === s.reached && s.reached === runs).map((s) => s.state);
  let verdict;
  if (!reachedStates.some((s) => s.state !== 'first-screen')) {
    verdict = 'CANNOT MEASURE - it reached no state past its first screen';
  } else {
    const differ = reachedStates.filter((s) => s.differAfterNudge >= 2);
    const allEqual = reachedStates.every((s) => s.reached === runs && s.equalAfterNudge === runs);
    if (differ.length) verdict = `DOES NOT REPAINT - ${differ.map((s) => `${s.state} differs after the nudge in ${s.differAfterNudge} of ${s.reached}`).join(', ')}`;
    else if (allEqual) verdict = 'REPAINTS';
    else verdict = `NO VERDICT - ${reachedStates.filter((s) => !(s.reached === runs && s.equalAfterNudge === runs)).map((s) => `${s.state}: equal after the nudge in ${s.equalAfterNudge} of ${s.reached} reached`).join(', ')}`;
    if (runs !== 3) verdict = `CHECK RUN (${runs} runs; would read ${verdict})`;
  }
  if (cannot.length) verdict += `; CANNOT MEASURE ${cannot.join(', ')}`;
  verdict += sameSize.length ? `; a same-size resize was enough at ${sameSize.join(', ')}` : '; a same-size resize was enough at no state';
  // Where the rows already matched before any resize, the nudge had nothing
  // to put right: said, so a verdict that rests on such states shows it.
  const already = reachedStates.filter((s) => s.equalAfterNothing === s.reached).map((s) => s.state);
  if (already.length) verdict += `; already equal before any resize at ${already.join(', ')}`;
  const other = reachedStates.filter((s) => s.otherBufferAfterNudge > 0).map((s) => `${s.state} (${s.pane1Buffer})`);
  if (other.length) verdict += `; pane 2 stayed on another screen buffer than pane 1 at ${other.join(', ')}`;
  return { verdict, states, summary };
}

// ── clean-up and output ────────────────────────────────────────────────────
/** The probe code that makes a reading: the sha256 of this file, the
 *  stand-in and the scenario file, each read with LF line ends. */
function codeDigests(scenarioFile) {
  const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
  return { record: sha(__filename), standIn: sha(STAND_IN), scenarios: sha(scenarioFile) };
}

/** A recording's first line: what ran, where, and the code that recorded it. */
function recordingHeader(ctx, prog, mode, launch, k) {
  const { cols, rows } = ctx.scenario.size;
  return {
    probe: 'P19', program: prog.name, version: ctx.versions[prog.id] || null, system: ctx.system.label, conpty: mode.id, cols, rows, launch: launch.id, run: k,
    encoding: IS_WIN ? 'utf-8 strings from node-pty, written back as utf-8' : 'bytes as read', files: ctx.files,
  };
}

function sanitizer(pairs) {
  const list = pairs.filter(([p]) => p && p.length > 3).flatMap(([p, tag]) => [[p, tag], [p.replace(/\\/g, '/'), tag]]).sort((a, b) => b[0].length - a[0].length);
  const fix = (s) => { let out = s; for (const [p, tag] of list) out = out.split(p).join(tag); return out; };
  const walk = (v) => (typeof v === 'string' ? fix(v) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [fix(k), walk(x)])) : v);
  return walk;
}

function removeTempRoot(dir) {
  // Guarded: only a folder this probe made, directly in the system's temporary folder.
  if (!dir || !fs.existsSync(dir)) return null;
  const tmp = fs.realpathSync(os.tmpdir());
  if (path.dirname(fs.realpathSync(dir)) !== tmp || !path.basename(dir).startsWith('p19-')) return `not removed (not the probe's own folder): ${dir}`;
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch (e) { return `could not be removed: ${e.code || e.message}`; }
  return fs.existsSync(dir) ? 'still there after it was removed' : null;
}

function locate(claudePrefix, codexPrefix) {
  const plat = `${process.platform}-${process.arch}`;
  const lib = (prefix) => (IS_WIN ? path.join(path.resolve(prefix), 'node_modules') : path.join(path.resolve(prefix), 'lib', 'node_modules'));
  const triple = { 'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl', 'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin', 'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc' }[plat];
  if (!triple) throw new CouldNotRun(`no native CLI for ${plat}`);
  // The platform packages each wrapper package installs as an optional
  // dependency, found the way its own launcher finds them (Claude Code's
  // install.cjs, Codex's bin/codex.js); no install script has run.
  const pkgDir = (name, from) => path.dirname(require.resolve(`${name}/package.json`, { paths: [from] }));
  const claude = path.join(pkgDir(`@anthropic-ai/claude-code-${plat}`, path.join(lib(claudePrefix), '@anthropic-ai', 'claude-code')), IS_WIN ? 'claude.exe' : 'claude');
  const codex = path.join(pkgDir(`@openai/codex-${plat}`, path.join(lib(codexPrefix), '@openai', 'codex')), 'vendor', triple, 'bin', IS_WIN ? 'codex.exe' : 'codex');
  for (const f of [claude, codex]) {
    const st = fs.statSync(f, { throwIfNoEntry: false });
    if (!st || st.size < (1 << 20)) throw new CouldNotRun(`no native CLI at ${f}`);
  }
  console.log(`claude: ${claude}\ncodex: ${codex}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `claude=${claude}\ncodex=${codex}\n`);
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === 'locate') { locate(rest[0], rest[1]); return 0; }
  if (mode !== 'run') throw new CouldNotRun('usage: node p19-record.cjs run --root <checkout> --out <folder> [...] | locate <claude prefix> <codex prefix>');
  const args = parseArgs(rest);
  if (!args.root || !args.out) throw new CouldNotRun('run needs --root and --out');
  const scenarioFile = args.scenarios ? path.resolve(args.scenarios) : path.join(__dirname, 'p19-scenarios.json');
  const scenario = readJson(scenarioFile);
  const runs = args.runs ? Number(args.runs) : scenario.runs;
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new CouldNotRun('--runs must be 1 to 10');
  const only = args.only ? args.only.split(',') : null;
  const programs = scenario.programs.filter((p) => !only || only.includes(p.id));
  const mods = loadPinned(path.resolve(args.root));
  const modes = conptyModes(mods['node-pty'].dir, args.conpty || 'bundled');
  const { Terminal } = mods['@xterm/headless'].mod;
  const out = path.resolve(args.out);
  const recDir = path.join(out, 'recordings');
  fs.mkdirSync(recDir, { recursive: true });

  const ctx = {
    scenario, files: codeDigests(scenarioFile), pty: mods['node-pty'].mod, recDir, known: new Map(), skip: new Set(), incomplete: [], versions: {}, commands: {}, current: null, fatal: [], writeErrors: [],
    tempRoot: fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'p19-')),
    // @xterm/headless counts its buffer API as proposed.
    newPane: () => new Terminal({ cols: scenario.size.cols, rows: scenario.size.rows, scrollback: scenario.scrollback, allowProposedApi: true }),
    system: { platform: process.platform, release: os.release(), arch: process.arch, node: process.version, runner: process.env.GITHUB_ACTIONS ? `${process.env.ImageOS || ''} ${process.env.ImageVersion || ''}`.trim() : null },
  };
  ctx.system.label = `${process.platform} ${os.release()} ${process.arch}${ctx.system.runner ? ` (GitHub runner ${ctx.system.runner})` : ''}`;
  // A throw in an event handler would end the process before its clean-up:
  // kept, and the run in progress stops at its next step. A write a pipe
  // refused (a terminal's input while its program starts or ends, or this
  // probe's own output) only loses that write: noted, and the run goes on.
  process.on('uncaughtException', (e) => {
    if (e && e.syscall === 'write' && ['EAGAIN', 'EPIPE', 'ECONNRESET', 'EOF'].includes(e.code)) {
      const note = `a write failed with ${e.code}${ctx.current ? ` in ${ctx.current.id}` : ' between runs'}`;
      ctx.writeErrors.push(note);
      if (ctx.current) ctx.current.notes.push(note);
      return;
    }
    ctx.fatal.push(e.message);
    console.error(e.stack);
  });
  for (const s of [process.stdout, process.stderr]) s.on('error', (e) => ctx.writeErrors.push(`the probe's own output: ${e.code || e.message}`));
  const result = { probe: 'P19', started: new Date().toISOString(), system: ctx.system, files: ctx.files, modules: { 'node-pty': mods['node-pty'].version, '@xterm/headless': mods['@xterm/headless'].version }, conpty: modes.map((m) => m.id), runs, scenario: { size: scenario.size, cutBytes: scenario.cutBytes, settleMs: scenario.settleMs, nudgeMs: scenario.nudgeMs, reply: scenario.reply }, programs: [], readings: [], verdicts: [] };
  const sanitize = () => sanitizer([[ctx.tempRoot, '<temp>'], [os.homedir(), '<home>'], ...Object.entries(ctx.commands).map(([id, c]) => [c.file, `<${id}>`])]);
  let standIn = null;
  let line = null;
  try {
    // The stand-in, in a fresh environment of its own.
    const sdirs = makeDirs(path.join(ctx.tempRoot, 'stand-in'));
    standIn = cp.spawn(process.execPath, [STAND_IN, scenarioFile], { cwd: sdirs.work, env: freshEnv(sdirs), stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    ctx.skip.add(standIn.pid);
    const byId = new Map();
    let buf = '';
    const port = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new CouldNotRun('the stand-in gave no port within 15 s')), 15000);
      standIn.on('exit', (code) => reject(new CouldNotRun(`the stand-in ended (code ${code})`)));
      standIn.stdout.setEncoding('utf8');
      standIn.stdout.on('data', (d) => {
        buf += d;
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
          const l = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let m;
          try { m = JSON.parse(l); } catch { continue; }
          if (m.event === 'listening') { clearTimeout(t); resolve(m.port); }
          else if (m.event === 'request') { const r = { ...m, sent: 0, of: m.reply === 'turn' ? scenario.reply.lines : 1 }; byId.set(m.id, r); if (ctx.current) ctx.current.requests.push(r); }
          else if (m.event === 'reply-progress' && byId.has(m.id)) { byId.get(m.id).sent = m.sent; byId.get(m.id).of = m.of; }
          else if (m.event === 'reply-done' && byId.has(m.id)) byId.get(m.id).done = true;
          else if (m.event === 'reply-closed' && byId.has(m.id)) { byId.get(m.id).closed = true; byId.get(m.id).sent = m.sent; }
        }
      });
    });
    ctx.port = port;
    console.log(`P19: stand-in on 127.0.0.1:${port}; temporary folder ${ctx.tempRoot}; ConPTY ${modes.map((m) => m.id).join(', ')}`);

    // The programs and their versions, each asked in a fresh environment.
    for (const prog of programs) {
      let cmd;
      if (prog.id === 'shell') cmd = defaultShell();
      // A program's arguments: a list, or a list per platform (`default` for the rest).
      else if (args[prog.id]) cmd = { file: path.resolve(args[prog.id]), args: Array.isArray(prog.args) ? prog.args : prog.args ? (prog.args[process.platform] ?? prog.args.default ?? []) : [] };
      else { result.programs.push({ id: prog.id, name: prog.name, notRun: `no --${prog.id} given` }); continue; }
      if (IS_WIN && /\.(cmd|bat)$/i.test(cmd.file)) throw new CouldNotRun(`--${prog.id} is a .cmd or .bat file; give the program it runs`);
      if (!fs.existsSync(cmd.file)) throw new CouldNotRun(`--${prog.id}: no file at ${cmd.file}`);
      ctx.commands[prog.id] = cmd;
      if (prog.id !== 'shell') {
        const vdirs = makeDirs(path.join(ctx.tempRoot, `version-${prog.id}`));
        ctx.versions[prog.id] = (await runFresh(cmd.file, ['--version'], freshEnv(vdirs, extraEnv(ctx, prog, { seed: 'none' })), vdirs.work)).text;
      }
      result.programs.push({ id: prog.id, name: prog.name, program: cmd.file, args: cmd.args, version: ctx.versions[prog.id] || null });
      console.log(`P19: ${prog.name}${ctx.versions[prog.id] ? ` ${ctx.versions[prog.id]}` : ''}: ${cmd.file}`);
    }

    for (const mode of modes) {
      for (const prog of programs) {
        if (!ctx.commands[prog.id]) continue;
        const readings = [];
        for (const launch of prog.launches) {
          for (let k = 1; k <= runs; k++) {
            const r = await runOne(ctx, prog, mode, launch, k);
            readings.push(r);
            result.readings.push(r);
            console.log(`P19: ${r.id}: ${r.states.map((s) => (s.reached ? `${s.state} [${s.steps.map((x) => (x.equal ? 'equal' : 'differs')).join(', ')}]` : `${s.state} not reached (${s.why})`)).join('; ')}; ${r.bytes} bytes, ${r.end}`);
          }
        }
        const v = verdictFor(prog, readings, runs);
        result.verdicts.push({ program: prog.id, name: prog.name, conpty: mode.id, ...v });
        console.log(`P19: ${prog.name} (${mode.label}): ${v.verdict}`);
      }
    }
    const by = (m) => result.verdicts.filter((v) => v.conpty === m.id).map((v) => (v.program === 'shell' ? `default shell: ${v.summary}` : `${v.name} ${v.verdict}`)).join('; ');
    line = `P19 RESULT (${ctx.system.label}): ${modes.map((m) => (IS_WIN ? `${m.label}: ${by(m)}` : by(m))).join(' || ')}`;
  } catch (e) {
    line = `P19 RESULT: COULD NOT RUN - ${e.message}`;
    if (!(e instanceof CouldNotRun)) console.error(e.stack);
  } finally {
    if (standIn) {
      try { standIn.stdin.end(); } catch { /* ended */ }
      for (let i = 0; i < 15 && standIn.exitCode === null && standIn.signalCode === null; i++) await sleep(200);
      ctx.skip.delete(standIn.pid);
    }
    try {
      const list = await listProcesses();
      for (const p of ownedProcesses(list, ctx.known, ctx.skip)) {
        const how = await stopChecked(p);
        if (!how.startsWith('stopped') && !how.startsWith('gone')) ctx.incomplete.push(`${p.name} (pid ${p.pid}) ${how}`);
      }
    } catch (e) { ctx.incomplete.push(`the final process list failed (${e.message})`); }
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
  result.writeErrors = ctx.writeErrors;
  result.line = line;
  const clean = sanitize();
  fs.writeFileSync(path.join(out, 'p19-result.json'), JSON.stringify(clean(result), null, 2) + '\n');
  console.log(clean(line));
  return line.includes('COULD NOT RUN') || ctx.incomplete.length ? 2 : 0;
}

// Everything it started has been ended and checked by now; node-pty's
// Windows output reader can keep the event loop alive after its pseudo
// console is closed, so the probe ends itself.
const finish = (code) => process.stdout.write('', () => process.exit(code));
if (require.main === module) {
  main().then(finish, (e) => {
    console.log(`P19 RESULT: COULD NOT RUN - ${e.message}`);
    finish(2);
  });
}

// For tests/unit/scripts/probe-p19-record.test.ts, which loads this file
// without running it.
module.exports = { ownedProcesses, verdictFor, codeDigests, recordingHeader };
