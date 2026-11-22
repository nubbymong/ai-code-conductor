'use strict';
/*
 * Probe P21 (ADR-030; plan 2.1.3-beta.14, section C6, aicc_planning #391): on
 * Windows, can a helper started from the signed-in user's own session capture
 * each display, in physical pixels and at the display's scale, fast enough for
 * Snap; and does a run from a session with no desktop fail cleanly? It gates S8
 * on Windows: Snap on the helper's capture mode and our own overlay (D3, D4).
 *
 * How. `measure` runs `aicc-helper capture --out <a new folder>` --runs times,
 * one after the other, in the session it is started in, and records for each
 * run the exit code, the time from the start of the process to its exit, its
 * stderr, its line on stdout, and, for each display the line names, that file's
 * BMP header (bits a pixel, width, height), its length, whether every pixel is
 * black, and which files the folder holds. A run still going after 10 s is
 * ended and counts as hung. Before the runs it asks Windows, through a
 * PowerShell process of its own (p21-windows.ps1), what it lists itself: each
 * attached display's mode (position and size in physical pixels,
 * EnumDisplaySettings), each display's effective DPI (GetDpiForMonitor in a
 * thread aware of each display's scale), the session id, and whether LogonUI
 * runs in that session (the screen is locked or at sign-in). Each run's
 * pictures are read, then deleted one file at a time; none is kept or sent.
 * `console` starts `measure` in the signed-in console session of the user this
 * runs as, through a scheduled task that runs only while that user is signed
 * in, not elevated; it waits for the reading (3 min at most; it stops sooner
 * when the task has not started 15 s after it was started, as when nobody is
 * signed in there) and removes the task in every case. `scale` reads, or with --set sets, the scale of the
 * primary display in the session it runs in, with the display configuration
 * call the Settings page makes (DisplayConfigSetDeviceInfo, the source's DPI
 * scale); `console-scale` runs `scale` in the console session the same way.
 * `verdict` reads the readings and prints the verdict lines. On WINDOWS_1 the
 * console runs come from user's console session (auto sign-in is on; nobody
 * signs in), the SSH runs from the SSH session itself.
 *
 * Decision lines (written before measuring):
 *   Console session, per scale, over 3 runs:
 *     CAPTURES: in 3 of 3 runs the helper exits 0 within 2 s of its start; its
 *       line names every display Windows lists (EnumDisplaySettings), each at
 *       that display's position and size and with the DPI Windows gives it
 *       (GetDpiForMonitor, read by PowerShell), and nothing else; each file it
 *       names is a 32-bit BMP of that size and of the length that size needs,
 *       whose pixels are not all black; and the folder holds only those files.
 *     DOES NOT CAPTURE: a run with the screen shown fails any of those (each
 *       failure named, the run's time recorded).
 *     CANNOT MEASURE: LogonUI ran in the session (the screen was locked or at
 *       sign-in), or fewer than 3 runs were read.
 *   SSH session, over 3 runs:
 *     FAILS CLEANLY: in 3 of 3 runs the helper exits 3 ("no desktop") within
 *       10 s, with a message on stderr, nothing on stdout and no file in its
 *       folder.
 *     DOES NOT FAIL CLEANLY: any run does otherwise (another exit, a hang ended
 *       at 10 s, a line printed or a file left), each named.
 *     CANNOT MEASURE: fewer than 3 runs were read.
 *   Scales: the console runs at the scale found and at one more the display
 *     allows (console-scale --set), and the scale found is put back after.
 *     When no other scale can be set without a sign-out, the line reads
 *     "second scale: not measured" with why. Mixed scaling (displays at
 *     different scales at once) is measured only on a machine with two
 *     displays; on one display the line reads "mixed scaling: not measured
 *     (one display)".
 *   What it means: CAPTURES at every scale measured and FAILS CLEANLY: S8 builds
 *     Snap's Windows overlay on the capture mode (D3). DOES NOT CAPTURE at a
 *     scale: Electron's desktopCapturer behind our overlay on Windows (D3's
 *     fallback), and the mode's Windows path is planned again. DOES NOT FAIL
 *     CLEANLY: the mode's desktop check is fixed before S8 runs it; the
 *     overlay does not wait for that. CANNOT MEASURE: no verdict; the probe
 *     runs again.
 *
 * Usage (Windows):
 *   node p21-capture.cjs measure --helper <aicc-helper.exe> --out <folder> --label <name> [--session console|ssh] [--runs 3]
 *   node p21-capture.cjs console --helper <aicc-helper.exe> --out <folder> --label <name> [--runs 3]
 *   node p21-capture.cjs scale --out <folder> --label <name> [--set <percent>]
 *   node p21-capture.cjs console-scale --out <folder> --label <name> [--set <percent>]
 *   node p21-capture.cjs verdict --out <folder> --console <label>[,<label>]|none --ssh <label> [--second-scale <why not>] [--console-not-run <why>]
 * --out must be a folder that is there; readings are p21-<label>.json and
 * p21-scale-<label>.json in it. The last lines of `verdict` are "P21 CONSOLE
 * <label>: ...", "P21 SSH: ...", "P21 SCALES: ...", "P21 MIXED SCALING: ..."
 * and "P21 RESULT: ...". Exit 0 when a step ran to its end, 2 when it could not
 * run.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const PS1 = path.join(__dirname, 'p21-windows.ps1');
const RUNS = 3;
const BOUND_MS = 2000;
const HANG_MS = 10000;
const TASK_WAIT_MS = 180000;
const TASK_START_MS = 15000;
const TASK_HAS_NOT_RUN = '0x00041303';
const EXIT_NO_DESKTOP = 3;
const BMP_HEADER = 54;
const MAX_OUTPUT = 64 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CouldNotRun extends Error {}

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

/** A label names files: letters, digits and dashes only. */
function checkLabel(label) {
  if (typeof label !== 'string' || !/^[A-Za-z0-9-]{1,40}$/.test(label)) throw new CouldNotRun('--label must be 1 to 40 letters, digits or dashes');
  return label;
}

// ── reading a picture (pure: the unit test runs these) ─────────────────────

/** The header of a BMP file as the capture mode writes it, or why it is not one. */
function parseBmpHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < BMP_HEADER) return { error: 'shorter than a BMP header' };
  if (buf[0] !== 0x42 || buf[1] !== 0x4d) return { error: 'not a BMP file (no BM)' };
  const fileSize = buf.readUInt32LE(2);
  const offset = buf.readUInt32LE(10);
  const dibSize = buf.readUInt32LE(14);
  const width = buf.readInt32LE(18);
  const height = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  return { fileSize, offset, dibSize, width: Math.abs(width), height: Math.abs(height), bottomUp: height > 0, bpp, compression };
}

/** Whether every pixel of a 32-bit picture is black (its colour bytes all 0; the fourth byte is not colour). */
function allBlack(buf, offset) {
  for (let i = offset; i + 3 < buf.length; i += 4) {
    if (buf[i] !== 0 || buf[i + 1] !== 0 || buf[i + 2] !== 0) return false;
  }
  return true;
}

/** What one display's file holds, against the size its line gave. */
function readPicture(buf, width, height) {
  const h = parseBmpHeader(buf);
  if (h.error) return { error: h.error, length: Buffer.isBuffer(buf) ? buf.length : 0 };
  const expectedLength = BMP_HEADER + width * height * 4;
  return { width: h.width, height: h.height, bpp: h.bpp, bottomUp: h.bottomUp, compression: h.compression, offset: h.offset, length: buf.length, expectedLength, allBlack: h.offset === BMP_HEADER ? allBlack(buf, BMP_HEADER) : null };
}

// ── judging the runs (pure) ────────────────────────────────────────────────

const firstLine = (s) => String(s || '').split(/\r?\n/).find((l) => l.trim()) || '';

/**
 * One console run against what Windows listed (`facts`): ok, or the failures.
 * `screenNotShown` when LogonUI ran in the session.
 */
function judgeConsoleRun(run, facts, boundMs = BOUND_MS) {
  const failures = [];
  if (facts && facts.logonUi) return { ok: false, screenNotShown: true, failures: ['LogonUI ran in the session: the screen was locked or at sign-in'] };
  if (run.hung) failures.push(`hung: ended after ${HANG_MS / 1000} s`);
  else if (run.code !== 0) failures.push(`exit ${run.code}: ${firstLine(run.stderr)}`);
  if (typeof run.ms !== 'number' || run.ms > boundMs) failures.push(`took ${run.ms} ms, over ${boundMs} ms`);
  if (run.code === 0 && !run.hung) {
    const shown = Array.isArray(run.displays) ? run.displays : null;
    if (!shown) failures.push(`no line it could read: ${run.lineError || 'none'}`);
    else {
      const modes = (facts && facts.modes) || [];
      const dpis = (facts && facts.dpis) || [];
      if (modes.length === 0) failures.push('Windows listed no display mode to check against');
      if (shown.length !== modes.length) failures.push(`the line names ${shown.length} displays, Windows lists ${modes.length}`);
      for (const m of modes) {
        const d = shown.find((x) => x.left === m.left && x.top === m.top);
        if (!d) { failures.push(`the display at ${m.left},${m.top} is not in the line`); continue; }
        if (d.width !== m.width || d.height !== m.height) failures.push(`${d.file}: the line says ${d.width} by ${d.height}, Windows ${m.width} by ${m.height}`);
        const w = dpis.find((x) => x.left === m.left && x.top === m.top);
        if (!w) failures.push(`${d.file}: Windows gave no DPI for the display at ${m.left},${m.top}`);
        else if (d.dpi !== w.dpi) failures.push(`${d.file}: the line says ${d.dpi} DPI, Windows ${w.dpi}`);
        const p = d.picture || {};
        if (p.error) failures.push(`${d.file}: ${p.error}`);
        else {
          if (p.bpp !== 32) failures.push(`${d.file}: ${p.bpp} bits a pixel, not 32`);
          if (p.width !== m.width || p.height !== m.height) failures.push(`${d.file}: the picture is ${p.width} by ${p.height}, Windows ${m.width} by ${m.height}`);
          if (p.length !== BMP_HEADER + m.width * m.height * 4) failures.push(`${d.file}: ${p.length} bytes, ${BMP_HEADER + m.width * m.height * 4} needed`);
          if (p.allBlack !== false) failures.push(`${d.file}: ${p.allBlack === true ? 'every pixel is black' : 'its pixels were not read'}`);
        }
      }
      const named = shown.map((d) => d.file).sort();
      const held = [...(run.files || [])].sort();
      if (JSON.stringify(named) !== JSON.stringify(held)) failures.push(`the folder holds ${held.join(', ') || 'nothing'}, the line names ${named.join(', ') || 'nothing'}`);
    }
  }
  return { ok: failures.length === 0, screenNotShown: false, failures };
}

const msRange = (runs) => {
  const ms = runs.map((r) => r.ms).filter((n) => typeof n === 'number');
  return ms.length ? `${Math.min(...ms)} to ${Math.max(...ms)} ms` : 'no time read';
};

/** The console verdict for one scale, over its runs. */
function verdictConsole(runs, facts, n = RUNS) {
  const list = Array.isArray(runs) ? runs : [];
  if (list.length < n) return { verdict: 'CANNOT MEASURE', why: `${list.length} of ${n} runs read`, failures: [] };
  const judged = list.map((r) => judgeConsoleRun(r, facts));
  if (judged.some((j) => j.screenNotShown)) return { verdict: 'CANNOT MEASURE', why: 'the screen was locked or at sign-in (LogonUI ran in the session)', failures: [] };
  const failures = judged.flatMap((j, i) => j.failures.map((f) => `run ${i + 1}: ${f}`));
  if (failures.length === 0) return { verdict: 'CAPTURES', why: `${list.length} of ${list.length} runs, ${msRange(list)}`, failures };
  return { verdict: 'DOES NOT CAPTURE', why: `${judged.filter((j) => !j.ok).length} of ${list.length} runs failed, ${msRange(list)}`, failures };
}

/** One SSH run: ok when it failed cleanly. */
function judgeSshRun(run) {
  const failures = [];
  if (run.hung) failures.push(`hung: ended after ${HANG_MS / 1000} s`);
  else if (run.code !== EXIT_NO_DESKTOP) failures.push(`exit ${run.code}, not ${EXIT_NO_DESKTOP}${run.stderr ? `: ${firstLine(run.stderr)}` : ''}`);
  if (typeof run.ms !== 'number' || run.ms > HANG_MS) failures.push(`took ${run.ms} ms`);
  if (!String(run.stderr || '').trim()) failures.push('no message on stderr');
  if (String(run.stdout || '').trim()) failures.push(`printed ${firstLine(run.stdout).slice(0, 80)}`);
  if ((run.files || []).length) failures.push(`left ${run.files.join(', ')}`);
  return { ok: failures.length === 0, failures };
}

/** The SSH verdict over its runs. */
function verdictSsh(runs, n = RUNS) {
  const list = Array.isArray(runs) ? runs : [];
  if (list.length < n) return { verdict: 'CANNOT MEASURE', why: `${list.length} of ${n} runs read`, failures: [] };
  const judged = list.map(judgeSshRun);
  const failures = judged.flatMap((j, i) => j.failures.map((f) => `run ${i + 1}: ${f}`));
  if (failures.length === 0) return { verdict: 'FAILS CLEANLY', why: `${list.length} of ${list.length} runs exited ${EXIT_NO_DESKTOP} with "${firstLine(list[0].stderr).slice(0, 160)}", ${msRange(list)}`, failures };
  return { verdict: 'DOES NOT FAIL CLEANLY', why: `${judged.filter((j) => !j.ok).length} of ${list.length} runs did not`, failures };
}

/** The scale (percent) Windows gave the primary display, or the first, in a reading. */
function scaleOf(facts) {
  const dpis = (facts && facts.dpis) || [];
  const d = dpis.find((x) => x.primary) || dpis[0];
  return d ? Math.round((d.dpi * 100) / 96) : null;
}

/** "mixed scaling: ..." from the readings' facts. */
function mixedLine(readings) {
  const most = Math.max(0, ...readings.map((r) => ((r.facts && r.facts.modes) || []).length));
  if (most < 2) return `mixed scaling: not measured (${most === 1 ? 'one display' : 'no display listed'})`;
  const mixed = readings.find((r) => new Set(((r.facts && r.facts.dpis) || []).map((d) => d.dpi)).size > 1);
  return mixed ? `mixed scaling: measured in ${mixed.label}` : `mixed scaling: not measured (${most} displays, all at one scale)`;
}

/** The verdict lines for the console readings (one a scale) and the SSH reading. */
function verdictLines(consoleReadings, sshReading, secondScaleWhy, consoleWhy) {
  const lines = [];
  const byScale = consoleReadings.map((r) => ({ label: r.label, scale: scaleOf(r.facts), v: verdictConsole(r.runs, r.facts) }));
  if (byScale.length === 0) lines.push(`P21 CONSOLE: CANNOT MEASURE - ${consoleWhy || 'no console reading'}`);
  for (const c of byScale) {
    lines.push(`P21 CONSOLE ${c.label} (${c.scale === null ? 'scale not read' : `${c.scale}%`}): ${c.v.verdict} - ${c.v.why}`);
    for (const f of c.v.failures) lines.push(`  ${f}`);
  }
  const ssh = verdictSsh(sshReading ? sshReading.runs : []);
  lines.push(`P21 SSH: ${ssh.verdict} - ${ssh.why}`);
  for (const f of ssh.failures) lines.push(`  ${f}`);
  const scales = [...new Set(byScale.map((c) => c.scale).filter((s) => s !== null))];
  const second = scales.length >= 2 ? 'two scales measured' : `second scale: not measured (${secondScaleWhy || 'no second reading'})`;
  lines.push(`P21 SCALES: ${scales.map((s) => `${s}%`).join(' and ') || 'none read'}; ${second}`);
  const mixed = mixedLine([...consoleReadings, ...(sshReading ? [sshReading] : [])]);
  lines.push(`P21 MIXED SCALING: ${mixed}`);
  let overall;
  if (byScale.length === 0 || byScale.every((c) => c.v.verdict === 'CANNOT MEASURE')) overall = 'CANNOT MEASURE';
  else if (byScale.some((c) => c.v.verdict === 'DOES NOT CAPTURE')) overall = 'DOES NOT CAPTURE';
  else if (byScale.some((c) => c.v.verdict === 'CANNOT MEASURE')) overall = 'CANNOT MEASURE';
  else overall = 'CAPTURES';
  const at = scales.length ? ` at ${scales.map((s) => `${s}%`).join(' and ')}` : '';
  lines.push(`P21 RESULT: ${overall}${at} from the console session; ${ssh.verdict} from the SSH session; ${second}; ${mixed}`);
  return lines;
}

// ── running things (Windows) ───────────────────────────────────────────────

function powershell(args, timeoutMs = 60000) {
  const r = cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1, ...args], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if (r.error) throw new CouldNotRun(`PowerShell did not run: ${r.error.message}`);
  const out = String(r.stdout || '').trim();
  const last = out.split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop();
  if (r.status !== 0 || !last) throw new CouldNotRun(`p21-windows.ps1 ${args.join(' ')} exited ${r.status}: ${firstLine(r.stderr) || firstLine(out)}`);
  return JSON.parse(last);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** One capture run into `dir`, a new empty folder. */
function captureOnce(helper, dir) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const child = cp.spawn(helper, ['capture', '--out', dir], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let hung = false;
    child.stdout.on('data', (c) => { if (stdout.length < MAX_OUTPUT) stdout += c; });
    child.stderr.on('data', (c) => { if (stderr.length < MAX_OUTPUT) stderr += c; });
    const timer = setTimeout(() => { hung = true; child.kill(); }, HANG_MS);
    const done = (code, signal, error) => {
      clearTimeout(timer);
      const ms = Number((process.hrtime.bigint() - started) / 1000000n);
      resolve({ code, signal: signal || null, error: error || null, ms, hung, stdout, stderr });
    };
    child.on('error', (e) => done(null, null, e.message));
    child.on('close', (code, signal) => done(code, signal));
  });
}

/** Read a run's line and files, then delete its pictures and its folder (one name at a time). */
function readRun(run, dir) {
  run.files = fs.readdirSync(dir).sort();
  if (run.code === 0 && !run.hung) {
    try {
      const line = JSON.parse(run.stdout.trim());
      run.displays = (line.displays || []).map((d) => {
        let picture;
        try { picture = readPicture(fs.readFileSync(path.join(dir, String(d.file))), d.width, d.height); } catch (e) { picture = { error: `not read: ${e.message}` }; }
        return { ...d, picture };
      });
    } catch (e) {
      run.lineError = e.message;
    }
  }
  for (const name of run.files) {
    if (/^display-\d{1,2}\.bmp$/.test(name)) fs.unlinkSync(path.join(dir, name));
  }
  const left = fs.readdirSync(dir);
  if (left.length === 0) fs.rmdirSync(dir);
  else run.leftInFolder = left;
  return run;
}

function writeReading(out, name, value) {
  const file = path.join(out, name);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 1));
  fs.renameSync(`${file}.tmp`, file);
  return file;
}

async function measure(a) {
  const helper = a.helper;
  const out = a.out;
  const label = checkLabel(a.label);
  const runs = Number(a.runs || RUNS);
  if (!helper || !fs.existsSync(helper)) throw new CouldNotRun('--helper must name the helper program');
  if (!out || !fs.statSync(out).isDirectory()) throw new CouldNotRun('--out must be a folder that is there');
  const facts = powershell(['-Mode', 'facts']);
  const reading = { probe: 'P21', label, session: a.session || null, at: new Date().toISOString(), helperSha256: sha256(helper), facts, runs: [] };
  for (let i = 1; i <= runs; i++) {
    const dir = path.join(out, `${label}-run${i}`);
    fs.mkdirSync(dir);
    const run = await captureOnce(helper, dir);
    reading.runs.push(readRun(run, dir));
    console.log(`P21 ${label} run ${i}: exit ${run.code}${run.hung ? ' (hung)' : ''} in ${run.ms} ms; ${firstLine(run.stderr) || `${(run.displays || []).length} displays`}`);
    await sleep(500);
  }
  // LogonUI is read again after the runs: a screen locked in between counts too.
  reading.factsAfter = powershell(['-Mode', 'facts']);
  if (reading.factsAfter.logonUi) reading.facts.logonUi = true;
  writeReading(out, `p21-${label}.json`, reading);
  return reading;
}

function scale(a) {
  const out = a.out;
  const label = checkLabel(a.label);
  if (!out || !fs.statSync(out).isDirectory()) throw new CouldNotRun('--out must be a folder that is there');
  const args = ['-Mode', 'scale'];
  if (a.set !== undefined) {
    if (!/^\d{3}$/.test(String(a.set))) throw new CouldNotRun('--set must be a percentage such as 125');
    args.push('-Set', String(a.set));
  }
  const result = powershell(args);
  writeReading(out, `p21-scale-${label}.json`, { probe: 'P21', label, at: new Date().toISOString(), ...result });
  return result;
}

/** Run this script's `sub` in the signed-in console session of this user, through a scheduled task; wait for `wantFile`. */
async function inConsole(sub, a, wantFile) {
  const out = path.resolve(a.out);
  const target = path.join(out, wantFile);
  if (fs.existsSync(target)) throw new CouldNotRun(`${wantFile} is there already`);
  const name = `aicc-p21-${checkLabel(a.label)}`;
  const parts = [`"${__filename}"`, sub, '--out', `"${out}"`, '--label', a.label];
  if (a.helper) parts.push('--helper', `"${path.resolve(a.helper)}"`);
  if (a.runs) parts.push('--runs', String(Number(a.runs)));
  if (a.set) parts.push('--set', String(Number(a.set)));
  if (sub === 'measure') parts.push('--session', 'console');
  const started = Date.now();
  try {
    powershell(['-Mode', 'task-run', '-Name', name, '-Exe', process.execPath, '-Arguments', parts.join(' '), '-Dir', out]);
    while (!fs.existsSync(target)) {
      if (Date.now() - started > TASK_WAIT_MS) throw new CouldNotRun(`the console session's ${sub} did not finish within ${TASK_WAIT_MS / 1000} s (is ${process.env.USERNAME} signed in there, and the screen shown?)`);
      await sleep(1000);
      // A task that runs only while its user is signed in never starts when
      // nobody is: Windows keeps "has not run" (0x00041303) as its result.
      if (Date.now() - started > TASK_START_MS && !fs.existsSync(target)) {
        const info = powershell(['-Mode', 'task-info', '-Name', name]);
        if (info.lastResult === TASK_HAS_NOT_RUN) throw new CouldNotRun(`the console session's task did not start in ${TASK_START_MS / 1000} s (${info.state}, ${info.lastResult}: the task has not run): nobody is signed in on the console`);
      }
    }
  } finally {
    try { powershell(['-Mode', 'task-remove', '-Name', name]); } catch (e) { console.log(`P21 note: the task ${name} was not removed: ${e.message}`); }
  }
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

function verdict(a) {
  const out = a.out;
  const read = (label) => JSON.parse(fs.readFileSync(path.join(out, `p21-${checkLabel(label)}.json`), 'utf8'));
  const consoleReadings = String(a.console === 'none' ? '' : a.console || '').split(',').filter(Boolean).map(read);
  const sshReading = a.ssh ? read(a.ssh) : null;
  const lines = verdictLines(consoleReadings, sshReading, a['second-scale'], a['console-not-run']);
  for (const l of lines) console.log(l);
  writeReading(out, 'p21-verdict.json', { probe: 'P21', at: new Date().toISOString(), lines });
  return lines;
}

async function main(argv) {
  const a = parseArgs(argv);
  const sub = a._[0];
  if (process.platform !== 'win32' && sub !== 'verdict') throw new CouldNotRun('P21 runs on Windows');
  if (sub === 'measure') return measure(a);
  if (sub === 'console') {
    const r = await inConsole('measure', a, `p21-${checkLabel(a.label)}.json`);
    for (const [i, run] of r.runs.entries()) console.log(`P21 ${r.label} run ${i + 1}: exit ${run.code}${run.hung ? ' (hung)' : ''} in ${run.ms} ms; ${firstLine(run.stderr) || `${(run.displays || []).length} displays`}`);
    console.log(`P21 ${r.label}: session ${r.facts.sessionId}, LogonUI ${r.facts.logonUi}, ${r.facts.modes.length} displays, scale ${scaleOf(r.facts)}%`);
    return r;
  }
  if (sub === 'scale') { const r = scale(a); console.log(JSON.stringify(r)); return r; }
  if (sub === 'console-scale') { const r = await inConsole('scale', a, `p21-scale-${checkLabel(a.label)}.json`); console.log(JSON.stringify(r)); return r; }
  if (sub === 'verdict') return verdict(a);
  throw new CouldNotRun('the step is one of measure, console, scale, console-scale, verdict');
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (e) => { console.log(`P21 RESULT: COULD NOT RUN - ${e instanceof CouldNotRun ? e.message : (e && e.stack) || e}`); process.exit(2); },
  );
}

module.exports = { parseBmpHeader, allBlack, readPicture, judgeConsoleRun, verdictConsole, judgeSshRun, verdictSsh, scaleOf, mixedLine, verdictLines, checkLabel, BOUND_MS, HANG_MS, RUNS };
