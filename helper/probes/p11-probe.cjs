'use strict';
/*
 * Probe P11 (ADR-030; plan 2.1.3-beta.16, section X1, aicc_planning #405):
 * do Claude Code and Codex attach an image from an inserted path like their
 * own paste, as a bracketed paste and as typed text? It gates S17 (D5: the
 * app inserts the path of a saved image so the CLI attaches it, the same
 * local and remote; a CLI that does not keeps its own paste on This
 * computer, declared exception 6).
 *
 * Why: a local session gets an image today as typed text, a sentence and
 * then the path (src/renderer/utils/imageTransfer.ts, composeLocalPathPrompt
 * and sendImageToSession), and nobody had measured whether either CLI then
 * sends the picture with the turn, or only the words.
 *
 * The forms, each typed into the CLI's prompt once it is ready:
 *   paste        the path as a bracketed paste (ESC [200~, the path, ESC
 *                [201~), 1.5 s, then a space and the sentence typed, 0.7 s,
 *                then Enter: what X1.2 would send.
 *   typed        today's form: the sentence, a space and the path typed as
 *                one write, 0.7 s, then Enter (the app writes the Enter in
 *                the same write; here it is a write of its own, as a prompt
 *                button's submit gives it, so the question is the picture,
 *                not how the CLI takes an Enter at the end of a burst).
 *   paste-plain  (recorded only, one run) the paste form with a path in a
 *                folder with no space in its name.
 *   paste-quoted (recorded only, one run) the paste form with the path in
 *                double quotes.
 * The path is shaped as the app's own: a JPEG named as Snap names one
 * (screenshot-<date>-<time>.jpg, screenshot-capture.ts generateFilename) in
 * <local app data>\AI Code Conductor\resources\screenshots, the app's
 * default resources folder, whose name holds spaces; the local app data
 * folder is the run's own. The picture is the 96 by 64 JPEG below (written
 * by .NET's encoder at quality 85, as the app writes JPEG at 85), the same
 * bytes in every run. The sentence names the run: "p11 probe <run>: please
 * view the image." If no turn reaches the stand-in within 20 s of the Enter,
 * one more Enter is sent and recorded (`enters`).
 *
 * How. Each CLI runs on a terminal of 120 by 40 with node-pty (on Windows on
 * node-pty's bundled ConPTY when it is there, as src/main/bundled-conpty.ts
 * gives a local session's PTY), its output fed to an @xterm/headless pane
 * that answers its terminal queries, in a fresh environment: HOME,
 * USERPROFILE, APPDATA, LOCALAPPDATA, CLAUDE_CONFIG_DIR, CODEX_HOME and the
 * temporary folders in the probe's own temporary folder, a new one per run;
 * no account, no key of anyone's. Each CLI is pointed at
 * p11-model-stand-in.cjs (served from this process on a loopback port),
 * which answers every request with text and records whether the turn
 * carries an image and which picture it is. Codex runs with --no-daemon (as
 * P19 and P20 ran it: 0.157.1 refuses its background server in an elevated
 * session) and with the model the app's Codex tab on the test machine starts
 * with (gpt-5.5), so Codex applies that model's own rule for images; its
 * update check is off, and when it offers a newer model first the probe
 * picks "Use existing model". The runs go one after the other.
 *
 * Per run it records: whether the CLI asked for bracketed paste (the pane's
 * bracketedPasteMode when the path is sent, as the app's terminal would
 * know it), the composer rows after the paste and before the Enter (rows
 * that show an image placeholder, the picture's file name or the sentence),
 * every request the stand-in saw for the run, and for the turn: its images
 * (kind, width, height, SHA-256), whether the path is still in its text, and
 * the first 400 characters of that text.
 *
 * Decision lines (the plan's, written before measuring), per form per CLI:
 *   ATTACHES: in 3 of 3 runs the turn carried the probe's picture (the same
 *     bytes, or a picture of the same width and height: a CLI may encode it
 *     again).
 *   NOT: in 3 of 3 runs the turn reached the stand-in with no image.
 *   CANNOT MEASURE: in 3 of 3 runs no turn reached the stand-in (with what
 *     the screen showed).
 *   Anything else (runs that disagree, or a turn with only another picture)
 *   is NO VERDICT, each run's outcome listed. Only --runs 3 gives a plan
 *   verdict; another count gives CHECK RUN with what it saw. The recorded
 *   forms give no verdict, only their outcomes.
 * What it means (plan 2.1.3-beta.16, X1):
 *   X1.2 is built, for Claude Code only in this beta, when Claude Code's
 *   paste ATTACHES and its typed form is NOT: a local Claude Code session
 *   then gets an image as a bracketed paste of the path, the sentence and
 *   Enter. Claude Code's typed form ATTACHES: today's form already sends the
 *   picture, nothing to build. Its paste NOT, CANNOT MEASURE or NO VERDICT:
 *   no build, and Claude Code keeps today's typed path (declared exception
 *   6). Codex's lines are recorded for beta.17 (S17); its submit primitive
 *   refuses a control character (session-input/index.ts) and is not changed
 *   here.
 *
 * It refuses node-pty or @xterm/headless at any version but the one the
 * checkout's package.json and package-lock.json name, a .cmd or .bat program
 * on Windows (node-pty starts a program file), and a temporary folder whose
 * path holds a space or a quote (the plain-path row needs one with none). It
 * cleans up in finally blocks: each CLI is ended (Ctrl+C twice, then
 * node-pty's kill), then, after each run, every process that is this
 * probe's descendant or a child of a CLI it started (a child counts only
 * when it started after its parent and before that parent ended), each
 * stopped only after its name and start time are checked again; then the
 * temporary folder is removed and anything of its own still running is
 * listed. The process code is p20-probe.cjs's (itself p19-record.cjs's),
 * copied: those files are named by their digests in ADR-030.
 *
 * Usage:
 *   node p11-probe.cjs run --root <checkout> --out <folder> [--claude <program>]
 *       [--codex <program>] [--only claude,codex] [--forms paste,typed,...] [--runs <n>]
 * --root is a checkout whose node_modules hold the pinned node-pty and
 * @xterm/headless (on the test machine, its own repository checkout).
 *
 * Writes p11-result.json to --out: every run's reading and the verdicts, with
 * the temporary folder, the home folder and the programs' paths written as
 * <temp>, <home>, <claude> and <codex>. It names the probe code by the
 * sha256 of its two files, each read with LF line ends. The last lines are
 * "P11 Claude Code ...", "P11 Codex ...", "P11 FOR X1.2: ..." and
 * "P11 RESULT: ...", or "P11 RESULT: COULD NOT RUN - <reason>", with
 * "; clean-up incomplete: <what>" added when something was left. Exit code 0
 * when it ran to the end, 2 when it could not run or the clean-up was
 * incomplete.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const standIn = require('./p11-model-stand-in.cjs');

const IS_WIN = process.platform === 'win32';
const STAND_IN = path.join(__dirname, 'p11-model-stand-in.cjs');
const COLS = 120;
const ROWS = 40;
const API_KEY = 'sk-ant-p11-probe-made-up-not-a-real-key-0000';
const CODEX_MODEL = 'gpt-5.5';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

class CouldNotRun extends Error {}

// ── the picture ────────────────────────────────────────────────────────────
/** A 96 by 64 baseline JPEG (four colours and an ellipse; .NET's encoder at
 *  quality 85), SHA-256 96cd0bda2e11e97a24180b9f967a3dbecb46f3bb8579c19e234497a44657bef6. */
const PICTURE = Buffer.from([
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAUEBAQEAwUEBAQGBQUGCA0ICAcHCBALDAkNExAUExIQEhIUFx0ZFBYcFhISGiMaHB4f',
  'ISEhFBkkJyQgJh0gISD/2wBDAQUGBggHCA8ICA8gFRIVICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg',
  'ICAgICAgICD/wAARCABAAGADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUF',
  'BAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVW',
  'V1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi',
  '4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAEC',
  'AxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVm',
  'Z2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq',
  '8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD0iiiisj9QCiiigAooooA62iiivnz8HCiiigAooooA5KiiivoD94CiiigAooooA62iiivn',
  'z8HCiiigAooooA5Wiiiv2ggKKKKACiiigD4aoor7D+B/wg0TRfDen+MNaht9V1jUYYry28yPfHZI2JI9gYf6z7pL9QeF4yW+AxGI',
  'jh4c0j66nTc3ZHy1p/gzxhq1hHqGl+FNYv7OXPl3FtYyyRvgkHDKpBwQR9QaluPAnjiztJru78G65b28CGSWWXTplSNQMlmJXAAA',
  'ySa/RWivH/taV/hOr6qu5+Y9FfdXxS+EGifELSpri1ht9O8Rp88N+se3ziFACTEDLKQqgHkrgEZGVb4Vr1sNio4iN1o1uc1Sm6bs',
  'z7looor9BPkAooooAKKKKAPhqvub4L/EvTPHHhC00uS5kXxBpdtHFeQ3Mu+ScKAv2gMeXDHBburHB6qzfDNS29xcWd3Dd2k8lvcQ',
  'OJIpYmKvGwOQykcggjIIr8+xWGjiIcr0a2Pr6VR03c/TOivgzT/jf8U9NsI7K38X3DxR5w1zDFcSHJJ5eRGZuvcnA46AVLcfHb4r',
  '3VpNbS+LpFSZDGxitYI3AIwdrKgZT6EEEdQa8X+yqt91+P8Akdf1qHY+vviH8Q9E+HXhttU1RvOupcpZ2KNiS6cdh/dUZG5sYAI6',
  'kqp/PerWoajqGrX8moapfXF/eS48y4uZWkkfAAGWYknAAH0FVa9jCYVYeLV7t7nJVquoz//Z',
].join(''), 'base64');
const PICTURE_INFO = standIn.pictureInfo(PICTURE);

/** A picture's file name as Snap names one (screenshot-capture.ts
 *  generateFilename) for the time `d`. */
function appPictureName(d) {
  return `screenshot-${d.toISOString().replace(/T/, '-').replace(/:/g, '').replace(/\.\d+Z/, '')}.jpg`;
}

// ── the forms ──────────────────────────────────────────────────────────────
const FORMS = [
  { id: 'paste', how: 'paste', folder: 'app', verdict: true },
  { id: 'typed', how: 'typed', folder: 'app', verdict: true },
  { id: 'paste-plain', how: 'paste', folder: 'plain', verdict: false, runs: 1 },
  { id: 'paste-quoted', how: 'paste', folder: 'app', quoted: true, verdict: false, runs: 1 },
];
const CLIS = [{ cli: 'claude', name: 'Claude Code' }, { cli: 'codex', name: 'Codex' }];

/** What is typed for one run, in order: each item is one write, `afterMs`
 *  the wait after it, `look` the composer rows read after that wait. */
function writesFor(form, picturePath, sentence) {
  if (form.how === 'paste') {
    const text = form.quoted ? `"${picturePath}"` : picturePath;
    return [
      { what: 'paste', data: `\u001b[200~${text}\u001b[201~`, afterMs: 1500, look: 'afterPaste' },
      { what: 'sentence', data: ` ${sentence}`, afterMs: 700, look: 'beforeEnter' },
    ];
  }
  return [{ what: 'typed', data: `${sentence} ${picturePath}`, afterMs: 700, look: 'beforeEnter' }];
}

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

// ── processes (copied from p20-probe.cjs) ──────────────────────────────────
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

// ── the screen ─────────────────────────────────────────────────────────────
/** A pane's rows once it has parsed everything written to it, and the
 *  modes the program asked for. */
function screenOf(term) {
  return new Promise((resolve, reject) => term.write('', () => {
    try {
      const buf = term.buffer.active;
      const rows = [];
      for (let y = buf.baseY; y < buf.baseY + term.rows; y++) { const l = buf.getLine(y); rows.push(l ? l.translateToString(true) : ''); }
      resolve({ rows, bracketedPaste: term.modes.bracketedPasteMode === true });
    } catch (e) { reject(e); }
  }));
}
const screenText = async (run) => (await screenOf(run.pane)).rows.join('\n');

/** The composer as it stands: the rows that show an image placeholder, the
 *  picture's file name or the sentence (at most 8), and whether the screen
 *  shows a placeholder or the file name anywhere (a row the width wraps is
 *  read joined to the next). */
async function composerLook(run) {
  const { rows } = await screenOf(run.pane);
  const flat = rows.join('');
  const base = path.basename(run.picturePath);
  const keep = rows.filter((r) => /\[image/i.test(r) || r.includes('p11 probe') || r.includes('screenshot-')).map((r) => r.replace(/\s+$/, '')).slice(0, 8);
  return { rows: keep, placeholder: /\[image/i.test(flat), fileNameShown: flat.includes(base) };
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
  for (const k of ['home', 'appdata', 'localappdata', 'claude', 'codex', 'tmp', 'work']) {
    dirs[k] = path.join(base, k);
    fs.mkdirSync(dirs[k], { recursive: true });
  }
  return dirs;
}

/** The picture written where the form puts it: the app's default
 *  screenshots folder under the run's local app data (spaces in its name),
 *  or, for the plain row, the run's working folder. */
function placePicture(dirs, form, when) {
  const folder = form.folder === 'plain' ? dirs.work : path.join(dirs.localappdata, 'AI Code Conductor', 'resources', 'screenshots');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, appPictureName(when));
  fs.writeFileSync(file, PICTURE);
  return file;
}

const tomlLiteral = (s) => { if (s.includes("'")) throw new CouldNotRun(`a path holds a quote: ${s}`); return `'${s}'`; };

/** The files a run starts from, its arguments and its environment. */
function prepare(ctx, cli, dirs) {
  const env = {};
  const args = [];
  if (cli === 'claude') {
    const proj = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, projectOnboardingSeenCount: 1, allowedTools: [] };
    const version = (/\d+\.\d+\.\d+/.exec(ctx.versions.claude || '') || [''])[0];
    fs.writeFileSync(path.join(dirs.claude, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: true, lastOnboardingVersion: version, theme: 'dark', numStartups: 1, autoUpdates: false,
      hasAcknowledgedCostThreshold: true, customApiKeyResponses: { approved: [API_KEY.slice(-20)], rejected: [] },
      projects: { [dirs.work]: proj, [dirs.work.replace(/\\/g, '/')]: proj },
    }, null, 2));
    Object.assign(env, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${ctx.modelPort}`, ANTHROPIC_API_KEY: API_KEY, DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
  } else {
    const toml = [
      `model = "${CODEX_MODEL}"`, 'model_provider = "p11probe"', 'check_for_update_on_startup = false', '',
      '[model_providers.p11probe]', 'name = "p11 probe"', `base_url = "http://127.0.0.1:${ctx.modelPort}/v1"`, 'env_key = "P11_PROBE_KEY"',
      'wire_api = "responses"', 'request_max_retries = 0', 'stream_max_retries = 0', '',
      `[projects.${tomlLiteral(dirs.work)}]`, 'trust_level = "trusted"', '',
    ];
    fs.writeFileSync(path.join(dirs.codex, 'config.toml'), toml.join('\n'));
    env.P11_PROBE_KEY = 'p11-probe-placeholder-not-a-key';
    args.push('--no-daemon');
  }
  return { args, env: freshEnv(dirs, env) };
}

// ── one run ────────────────────────────────────────────────────────────────
const READY = {
  claude: /(?:^|\n) {0,2}\u2500{8,} *\n {0,2}[\u276f>](?:[ \u00a0][^\n]*)?\n {0,2}\u2500{8,}/u,
  // The composer, and the model's name in the footer under it (the session
  // ready; the composer alone shows before it, P19). Codex 0.157.1 writes the
  // name in capitals there ("GPT-5.5 default ·"), so the name is matched in
  // any case.
  codex: new RegExp(`(?:^|\\n) ?\\u203a(?:[ \\n]|$)[\\s\\S]*\\n {1,4}${CODEX_MODEL.replace(/\./g, '\\.')} [^\\n]*\\u00b7`, 'iu'),
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
    // Codex 0.157.1 with gpt-5.5 offers a newer model first ("Try new model",
    // "Use existing model", "enter/esc confirm"; the test machine, the P11
    // check run): Enter when Use existing model is the one marked, else the
    // next option down, so the run keeps the model it was started with.
    { label: 'new model offer', re: /Use existing model/i, keys: (text) => (/^\s*[›>❯]\s*\d[.)]\s*Use existing model/im.test(text) ? ['\r'] : ['\u001b[B']) },
    { label: 'folder trust', re: /trust the contents|allow Codex to work in this folder|Do you trust/i, keys: ['\r'] },
    { label: 'press Enter', re: /[Pp]ress [Ee]nter to continue/i, keys: ['\r'] },
  ],
};

function note(run, s) { run.notes.push({ t: now() - run.t0, s }); }

function write(run, data) {
  try { run.pty.write(data); } catch (e) { note(run, `a write failed: ${e.message}`); }
}

async function typeKeys(run, keys) {
  for (let i = 0; i < keys.length; i++) {
    if (i > 0) await sleep(250);
    write(run, keys[i]);
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

const turnOf = (ctx, id) => ctx.model.find((e) => e.ev === 'request' && e.kind === 'turn' && e.run === id) || null;

async function runOne(ctx, cli, form, k) {
  const id = `${cli}-${form.id}-${k}`;
  const dirs = makeDirs(path.join(ctx.tempRoot, id));
  const run = { id, cli, form: form.id, k, dirs, t0: now(), answered: [], notes: [], exited: null, known: null, closed: false, bytes: 0, enters: 0, looks: {} };
  run.picturePath = placePicture(dirs, form, new Date());
  const { args, env } = prepare(ctx, cli, dirs);
  run.pane = ctx.newPane();
  const term = ctx.pty.spawn(ctx.commands[cli], args, { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: dirs.work, env, ...ctx.ptyMode.options });
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
  }).catch(() => { /* the run's sweep lists again */ });
  try {
    const why = await untilScreen(run, READY[cli], 'the ready prompt', 90000, RULES[cli]);
    if (why) { run.why = why; return run; }
    await sleep(1500);
    run.bracketedPaste = (await screenOf(run.pane)).bracketedPaste;
    run.sentAt = now();
    for (const w of writesFor(form, run.picturePath, `p11 probe ${id}: please view the image.`)) {
      write(run, w.data);
      await sleep(w.afterMs);
      run.looks[w.look] = await composerLook(run);
    }
    write(run, '\r');
    run.enters = 1;
    let turn = await until(() => turnOf(ctx, id), 20000, run);
    if (!turn && !run.exited) {
      write(run, '\r');
      run.enters = 2;
      turn = await until(() => turnOf(ctx, id), 20000, run);
    }
    if (!turn) { run.why = run.exited ? `the CLI ended (code ${run.exited.code}) before a turn` : 'no turn reached the stand-in within 20 s of either Enter'; return run; }
    await until(() => ctx.model.find((e) => e.ev === 'reply-done' && e.id === turn.id), 10000, run);
    await sleep(1000);
  } finally {
    run.screen = (await screenOf(run.pane).catch(() => ({ rows: [] }))).rows.map((r) => r.replace(/\s+$/, '')).filter(Boolean).slice(-14);
    await endRun(run);
  }
  return run;
}

async function endRun(run) {
  if (!run.exited) {
    for (const k of ['\u0003', '\u0003']) { write(run, k); await sleep(500); }
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
  const rel = (t) => (t == null ? null : t - run.t0);
  const reqs = ctx.model.filter((e) => e.ev === 'request' && e.run === run.id);
  const t = reqs.find((e) => e.kind === 'turn') || null;
  const base = path.basename(run.picturePath || '');
  return {
    id: run.id, cli: run.cli, form: run.form, run: run.k, why: run.why || null, exit: run.exited, end: run.end, bytes: run.bytes, answered: run.answered, notes: run.notes,
    picturePath: run.picturePath, bracketedPaste: run.bracketedPaste ?? null, sentAt: rel(run.sentAt), enters: run.enters, looks: run.looks,
    requests: reqs.map((e) => ({ t: rel(e.t), path: e.path, kind: e.kind, tools: e.tools, stream: e.stream, images: e.images.length })),
    turn: t ? { t: rel(t.t), model: t.model, tools: t.tools, images: t.images, pathInText: !!(t.text && base && t.text.includes(base)), text: t.text } : null,
    screen: run.screen,
  };
}

// ── verdicts ───────────────────────────────────────────────────────────────
/** The probe's picture, or a picture of its width and height (a CLI may
 *  encode it again); `how` says which. */
function samePicture(img, picture = PICTURE_INFO) {
  if (!img) return null;
  if (img.sha256 && img.sha256 === picture.sha256) return 'the same bytes';
  if (Number.isFinite(img.width) && img.width === picture.width && img.height === picture.height) return `its size (${img.kind})`;
  return null;
}

/** One run's outcome: attached, not (a turn with no image), other image (a
 *  turn with images, none the probe's), or no turn. */
function outcomeOf(r, picture = PICTURE_INFO) {
  const t = r.turn;
  if (!t) return 'no turn';
  const imgs = t.images || [];
  if (!imgs.length) return 'not';
  return imgs.some((i) => samePicture(i, picture)) ? 'attached' : 'other image';
}

/** Every outcome the same: that verdict; else NO VERDICT. Only `runs` 3
 *  gives a plan verdict; another count gives CHECK RUN (p20-probe.cjs). */
function overall(outcomes, names, runs) {
  const all = (o) => outcomes.length > 0 && outcomes.every((x) => x === o);
  let v = 'NO VERDICT';
  for (const [o, name] of names) if (all(o)) v = name;
  if (runs !== 3 || outcomes.length !== 3) return `CHECK RUN (${v.toLowerCase()} in ${outcomes.length} runs)`;
  return v;
}
const VERDICTS = [['attached', 'ATTACHES'], ['not', 'NOT'], ['no turn', 'CANNOT MEASURE']];

/** One form of one CLI: its verdict (a verdict form) or its outcomes (a
 *  recorded one), and what the runs showed beside it. */
function formVerdict(form, readings, runs) {
  const outcomes = readings.map((r) => outcomeOf(r));
  const verdict = form.verdict ? overall(outcomes, VERDICTS, runs) : 'RECORDED';
  const sent = readings.filter((r) => r.bracketedPaste !== null);
  const paste = form.how === 'paste' ? readings.filter((r) => r.looks && r.looks.afterPaste) : [];
  const turns = readings.filter((r) => r.turn);
  const matched = readings.map((r) => (r.turn ? (r.turn.images || []).map((i) => samePicture(i)).find(Boolean) || null : null)).filter(Boolean);
  const facts = [
    `outcomes ${outcomes.join(', ')}`,
    `bracketed paste asked for by the CLI in ${sent.filter((r) => r.bracketedPaste).length} of ${sent.length}`,
    ...(form.how === 'paste' ? [`a placeholder after the paste in ${paste.filter((r) => r.looks.afterPaste.placeholder).length} of ${paste.length}`] : []),
    `a placeholder before Enter in ${readings.filter((r) => r.looks && r.looks.beforeEnter && r.looks.beforeEnter.placeholder).length} of ${readings.filter((r) => r.looks && r.looks.beforeEnter).length}`,
    `the file name in the turn's text in ${turns.filter((r) => r.turn.pathInText).length} of ${turns.length}`,
    ...(matched.length ? [`matched by ${[...new Set(matched)].join(', ')}`] : []),
    ...(readings.some((r) => r.enters === 2) ? [`a second Enter in ${readings.filter((r) => r.enters === 2).length}`] : []),
  ];
  const whys = [...new Set(readings.map((r) => r.why).filter(Boolean))];
  if (whys.length) facts.push(`why no turn: ${whys.join(' / ')}`);
  return { form: form.id, verdict, outcomes, summary: `${verdict} (${facts.join('; ')})` };
}

/** What the verdicts mean for X1.2 (the decision lines in the header). */
function forX12(claude) {
  const paste = claude && claude.paste ? claude.paste.verdict : null;
  const typed = claude && claude.typed ? claude.typed.verdict : null;
  if (paste === 'ATTACHES' && typed === 'NOT') return 'BUILD - Claude Code attaches the path as a bracketed paste and not as today\'s typed text';
  if (typed === 'ATTACHES') return 'NO BUILD - Claude Code already attaches today\'s typed form';
  return `NO BUILD - Claude Code paste ${paste || 'not run'}, typed ${typed || 'not run'}; Claude Code keeps today's typed path (declared exception 6)`;
}

// ── the result ─────────────────────────────────────────────────────────────
function codeDigests() {
  const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
  return { probe: sha(__filename), standIn: sha(STAND_IN) };
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
  if (path.dirname(fs.realpathSync(dir)) !== tmp || !path.basename(dir).startsWith('p11-')) return `not removed (not the probe's own folder): ${dir}`;
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch (e) { return `could not be removed: ${e.code || e.message}`; }
  return fs.existsSync(dir) ? 'still there after it was removed' : null;
}

async function main() {
  const [cmdName, ...rest] = process.argv.slice(2);
  if (cmdName !== 'run') throw new CouldNotRun('usage: node p11-probe.cjs run --root <checkout> --out <folder> [--claude <program>] [--codex <program>] [--only claude,codex] [--forms <ids>] [--runs <n>]');
  const args = parseArgs(rest);
  if (!args.root || !args.out) throw new CouldNotRun('run needs --root and --out');
  const runs = args.runs ? Number(args.runs) : 3;
  if (!Number.isInteger(runs) || runs < 1 || runs > 5) throw new CouldNotRun('--runs must be 1 to 5');
  const clis = CLIS.filter((c) => (args.only ? args.only.split(',').includes(c.cli) : true));
  const forms = FORMS.filter((f) => (args.forms ? args.forms.split(',').includes(f.id) : true));
  if (!clis.length || !forms.length) throw new CouldNotRun(`--only or --forms names nothing (CLIs: ${CLIS.map((c) => c.cli).join(', ')}; forms: ${FORMS.map((f) => f.id).join(', ')})`);
  const mods = loadPinned(path.resolve(args.root));
  const { Terminal } = mods['@xterm/headless'].mod;
  const out = path.resolve(args.out);
  fs.mkdirSync(out, { recursive: true });
  const ctx = {
    pty: mods['node-pty'].mod, ptyMode: ptyOptions(mods['node-pty'].dir), known: new Map(), skip: new Set(), incomplete: [], versions: {}, commands: {}, model: [],
    tempRoot: fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'p11-')),
    newPane: () => new Terminal({ cols: COLS, rows: ROWS, scrollback: 1000, allowProposedApi: true }),
    system: `${process.platform} ${os.release()} ${process.arch}`,
  };
  const writeErrors = [];
  process.on('uncaughtException', (e) => {
    if (e && e.syscall === 'write' && ['EAGAIN', 'EPIPE', 'ECONNRESET', 'EOF'].includes(e.code)) { writeErrors.push(`a write failed with ${e.code}`); return; }
    console.error(e.stack);
    ctx.incomplete.push(`an error the probe did not expect: ${e.message}`);
  });
  const result = { probe: 'P11', started: new Date().toISOString(), system: ctx.system, node: process.version, files: codeDigests(), modules: { 'node-pty': mods['node-pty'].version, '@xterm/headless': mods['@xterm/headless'].version }, conpty: ctx.ptyMode.id, runs, picture: PICTURE_INFO, codexModel: CODEX_MODEL, forms, programs: {}, readings: [], verdicts: {}, sweeps: [] };
  const sanitize = () => sanitizer([[ctx.tempRoot, '<temp>'], [os.homedir(), '<home>'], ...Object.entries(ctx.commands).map(([id, c]) => [c, `<${id}>`])]);
  const lines = [];
  let line = null;
  let model = null;
  try {
    if (/[\s'"]/.test(ctx.tempRoot)) throw new CouldNotRun(`the temporary folder's path holds a space or a quote: ${ctx.tempRoot}`);
    model = standIn.createModelStandIn({ onEvent: (e) => ctx.model.push(e) });
    ctx.modelPort = await model.listen();
    for (const c of clis) {
      if (!args[c.cli]) throw new CouldNotRun(`--${c.cli} is needed (or --only without it)`);
      const file = path.resolve(args[c.cli]);
      if (IS_WIN && /\.(cmd|bat)$/i.test(file)) throw new CouldNotRun(`--${c.cli} is a .cmd or .bat file; give the program it runs`);
      if (!fs.existsSync(file)) throw new CouldNotRun(`--${c.cli}: no file at ${file}`);
      ctx.commands[c.cli] = file;
      const vdirs = makeDirs(path.join(ctx.tempRoot, `version-${c.cli}`));
      ctx.versions[c.cli] = await new Promise((resolve) => cp.execFile(file, ['--version'], { env: freshEnv(vdirs), cwd: vdirs.work, windowsHide: true, timeout: 30000 }, (err, so, se) => resolve(`${so || ''}${se || ''}`.trim().split(/\r?\n/)[0] || (err ? err.message : ''))));
      result.programs[c.cli] = { program: file, version: ctx.versions[c.cli] };
    }
    console.log(`P11: node-pty ${mods['node-pty'].version} (${ctx.ptyMode.id} ConPTY), @xterm/headless ${mods['@xterm/headless'].version}, node ${process.version}; model stand-in 127.0.0.1:${ctx.modelPort}; ${Object.entries(ctx.versions).map(([c, v]) => `${c} ${v}`).join(', ')}; the picture ${PICTURE_INFO.kind} ${PICTURE_INFO.width}x${PICTURE_INFO.height} ${PICTURE_INFO.sha256.slice(0, 12)}`);
    for (const c of clis) {
      const byForm = {};
      for (const form of forms) {
        const readings = [];
        for (let k = 1; k <= Math.min(form.runs ?? runs, runs); k++) {
          let r;
          try { r = readingOf(ctx, await runOne(ctx, c.cli, form, k)); } catch (e) { r = { id: `${c.cli}-${form.id}-${k}`, cli: c.cli, form: form.id, run: k, why: `the run failed: ${e.message}`, turn: null, looks: {}, bracketedPaste: null }; }
          result.sweeps.push({ after: r.id, stopped: await sweep(ctx, r.id) });
          readings.push(r);
          result.readings.push(r);
          console.log(`P11: ${r.id}: ${outcomeOf(r)}${r.why ? ` (${r.why})` : ''}${r.turn ? `; ${r.turn.images.length} image(s) in the turn` : ''}`);
        }
        byForm[form.id] = formVerdict(form, readings, runs);
      }
      result.verdicts[c.cli] = byForm;
      lines.push(`P11 ${c.name} (${ctx.versions[c.cli]}): ${forms.map((f) => `${f.id} ${byForm[f.id].summary}`).join(' || ')}`);
    }
    lines.push(`P11 FOR X1.2: ${forX12(result.verdicts.claude)}`);
    line = `P11 RESULT (${ctx.system}; ${ctx.ptyMode.id} ConPTY; ${Object.entries(ctx.versions).map(([c, v]) => `${c} ${v}`).join(', ')}): ${clis.map((c) => `${c.name} ${forms.filter((f) => f.verdict).map((f) => `${f.id}=${result.verdicts[c.cli][f.id].verdict}`).join(' ')}`).join('; ')}`;
  } catch (e) {
    line = `P11 RESULT: COULD NOT RUN - ${e.message}`;
    if (!(e instanceof CouldNotRun)) console.error(e.stack);
  } finally {
    if (model) await model.close().catch(() => {});
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
  fs.writeFileSync(path.join(out, 'p11-result.json'), JSON.stringify(clean(result), null, 2) + '\n');
  for (const l of lines) console.log(clean(l));
  console.log(clean(line));
  return line.includes('COULD NOT RUN') || ctx.incomplete.length ? 2 : 0;
}

// node-pty's Windows output reader can keep the event loop alive after its
// pseudo console is closed, so the probe ends itself.
const finish = (code) => process.stdout.write('', () => process.exit(code));
if (require.main === module) {
  main().then(finish, (e) => { console.log(`P11 RESULT: COULD NOT RUN - ${e.message}`); finish(2); });
}

// For tests/unit/scripts/probe-p11.test.ts, which loads this file without
// running it.
module.exports = {
  FORMS, CLIS, READY, RULES, PICTURE, PICTURE_INFO, appPictureName, writesFor, samePicture, outcomeOf, overall, formVerdict, forX12, ownedProcesses, sanitizer, codeDigests,
};
