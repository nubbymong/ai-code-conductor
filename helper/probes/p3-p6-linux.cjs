'use strict';
/*
 * Probes P3 and P6 (ADR-030; plan 2.1.3-beta.13, section C2, aicc_planning#377),
 * on remote Linux hosts, with the static Linux helper (the `helper-linux-musl`
 * artifact of the Helper (ubuntu-latest) CI job).
 *
 *   P3: does a holder outlive the ssh logout that started it?
 *   P6: is the PATH of an ssh exec the same as the login PATH?
 *
 * Where it runs: on the test PC, which runs nothing here but ssh and scp. Every
 * remote step is its own ssh connection (no connection sharing), with key
 * sign-in only (BatchMode: a host that asks for a password is refused, never
 * answered). The hosts are two slots of tests/live/hosts.local.json, read by
 * name in this script: `linuxKey` and `linuxRockyKey`. Of each, only `host` and
 * `username` are read; no other slot and no other field is used, and the file
 * is never printed. The console shows each host and user, then the verdicts.
 *
 * What it does on each host:
 *   1. One connect with an 8 s limit. No answer: NOT RUN (host off), and the
 *      next host. A refused key or an unknown host key: NOT RUN, with which.
 *   2. Records the system, logind's KillUserProcesses and KillExcludeUsers, the
 *      user's Linger, and whether /tmp/aicc-<uid> (the helper's socket folder)
 *      is there; makes a temporary folder (mktemp -d, mode 700).
 *   3. Copies the helper there with scp, and checks its SHA-256 and `version`.
 *   4. P3, six runs, one after the other: each is an ssh session that runs
 *      `aicc-helper hold --detach` (a holder with its own store in the folder,
 *      away clock 300 s) and logs out as the command ends. Three sessions have
 *      a terminal (ssh -tt, the way a session's terminal starts it) and three
 *      do not (ssh -T, an exec). 10 s and 60 s after the last logout, a new
 *      connection checks each holder: alive when its pid still runs with its
 *      own command line (store and session). Its cgroup is recorded too: a
 *      holder in the login's session scope is ended on logout by a logind
 *      with KillUserProcesses=yes.
 *   5. P6, one exec: the exec's PATH, then the PATH of the user's login shell
 *      started from that exec with -l (as D8 starts the CLI: through the
 *      host's login shell), and of an interactive login shell (-il, recorded
 *      only), each with what `command -v` finds for claude, codex and node.
 *   6. Leaves the host as found: ends each holder (only a process with its own
 *      command line), runs `list` (it removes the records and sockets of
 *      holders that are gone), removes the sockets, the copied helper, the
 *      store's files and the folders it made, each by name (no recursive
 *      delete), removes /tmp/aicc-<uid> only if it was not there before and is
 *      empty, and checks nothing of the run is left.
 *
 * Decision lines (written before measuring):
 *   P3 HOLDS on a host when the holder is alive 60 s after the logout that
 *     started it in 3 of 3 runs of each form (with a terminal, and an exec).
 *     DOES NOT HOLD when a holder is gone at 60 s in any run. CANNOT MEASURE
 *     when a form has fewer than 3 runs whose holder started, or a check could
 *     not be read. Recorded beside it: alive at 10 s, KillUserProcesses,
 *     KillExcludeUsers, Linger and each holder's cgroup. ADR-030's fallback
 *     when it does not hold: that host kind is labelled "no re-attach" and
 *     resumes by conversation id.
 *   P6 SAME on a host when the exec's PATH and the login shell's PATH hold the
 *     same entries in the same order once repeats are dropped, and claude,
 *     codex and node each resolve to the same file (or to none) in both.
 *     DIFFERS otherwise, with what differs. CANNOT MEASURE when either was not
 *     read. ADR-030's fallback when it differs: CLI paths come from a
 *     login-shell lookup in the probe report.
 *
 *   node helper/probes/p3-p6-linux.cjs --hosts <hosts.local.json> --helper <aicc-helper> --out <folder>
 *
 * The record is <folder>/p3-p6-result.json; in it the home folder is written
 * as ~ and the user name as <user>, and nothing the holder prints is kept but
 * its pid, session and socket path. Exit 0: every host was measured or not
 * run; 1: a host was not left as found (named on the last line); 2: the
 * probe could not run (its arguments).
 */

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SLOTS = ['linuxKey', 'linuxRockyKey'];
const FORMS = ['tty', 'exec'];
const RUNS_PER_FORM = 3;
const AWAY_SECS = 300;
const CHECK_AT_SECS = [10, 60];
const PROGRAMS = ['claude', 'codex', 'node'];
const SSH_TIMEOUT_MS = 30000;
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=3'];

/** A host name or address, and a user name, as ssh takes them on its own. */
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/;
const USER_RE = /^[a-z_][a-z0-9_.-]{0,31}$/;
/** A remote folder this probe made, or a file in it: no space, no quote, no `..`. */
const SAFE_PATH_RE = /^\/[A-Za-z0-9._/-]+$/;

function safePath(p) {
  return typeof p === 'string' && SAFE_PATH_RE.test(p) && !p.split('/').includes('..');
}

/** The probe's own temporary folder: made by mktemp from the template below. */
function isProbeDir(p) {
  return safePath(p) && /\/aicc-p3p6\.[A-Za-z0-9]{8}$/.test(p);
}

/** A holder's socket, as the helper names it on Linux (transport/mod.rs). */
function isEndpoint(p, uid, sid) {
  if (typeof p !== 'string' || !/^\d+$/.test(String(uid)) || !/^[A-Za-z0-9_-]+$/.test(String(sid))) return false;
  return new RegExp(`^/tmp/aicc-${uid}/${sid}-[0-9a-f]{16}\\.sock$`).test(p);
}

/**
 * The two slots, by name. Only `host` and `username` are read from each; a
 * slot that is missing or does not hold a usable pair is returned as missing.
 */
function readSlots(json) {
  return SLOTS.map((slot) => {
    const entry = json && typeof json === 'object' ? json[slot] : undefined;
    if (!entry || typeof entry !== 'object') return { slot, missing: 'no such slot in the hosts file' };
    const host = entry.host;
    const username = entry.username;
    if (typeof host !== 'string' || !HOST_RE.test(host)) return { slot, missing: 'the slot has no usable host' };
    if (typeof username !== 'string' || !USER_RE.test(username)) return { slot, missing: 'the slot has no usable username' };
    return { slot, host, username };
  });
}

/** Why an ssh or scp step failed, in the words the report uses. */
function classifyFailure(r) {
  const text = `${r.stderr || ''}`;
  if (r.timedOut) return 'host off (no answer in time)';
  if (/Connection timed out|Operation timed out|No route to host|Network is unreachable|Connection refused|Could not resolve|Name or service not known|timed out/i.test(text)) return 'host off';
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text)) return 'host key not known or changed';
  if (/Permission denied/i.test(text)) return 'key sign-in refused';
  return `failed (exit ${r.status})`;
}

/** The `@@<key> <value>` lines between `@@begin` and `@@end`. */
function parseMarked(text) {
  const out = {};
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const begin = lines.indexOf('@@begin');
  const end = lines.lastIndexOf('@@end');
  if (begin < 0 || end < begin) return null;
  for (const line of lines.slice(begin + 1, end)) {
    const m = /^@@(\S+)(?: (.*))?$/.exec(line);
    if (!m) continue;
    if (m[1] in out) {
      if (!Array.isArray(out[m[1]])) out[m[1]] = [out[m[1]]];
      out[m[1]].push(m[2] ?? '');
    } else out[m[1]] = m[2] ?? '';
  }
  return out;
}

/** The home folder as ~ and the user name as <user>. */
function redact(text, home, user) {
  let s = String(text ?? '');
  if (home && home.length > 1) s = s.split(home).join('~');
  if (user) s = s.replace(new RegExp(`(^|[^A-Za-z0-9_.-])${user.replace(/[.]/g, '\\.')}(?=$|[^A-Za-z0-9_.-])`, 'g'), '$1<user>');
  return s;
}

/** A PATH's entries in order, empty ones and repeats dropped. */
function pathEntries(p) {
  const seen = new Set();
  const out = [];
  for (const e of String(p ?? '').split(':')) {
    if (e === '' || seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
}

/** P3, from its runs: { form, started, alive: { 10: bool|null, 60: bool|null } }. */
function p3Verdict(runs) {
  const reasons = [];
  for (const form of FORMS) {
    const started = runs.filter((r) => r.form === form && r.started);
    const gone = started.filter((r) => r.alive && r.alive[60] === false);
    if (gone.length > 0) return { verdict: 'DOES NOT HOLD', why: `${gone.length} of ${started.length} ${form} run(s) gone at 60 s` };
    if (started.length < RUNS_PER_FORM) reasons.push(`${started.length} of ${RUNS_PER_FORM} ${form} runs started`);
    const unread = started.filter((r) => !r.alive || typeof r.alive[60] !== 'boolean');
    if (unread.length > 0) reasons.push(`${unread.length} ${form} run(s) not checked at 60 s`);
  }
  if (reasons.length > 0) return { verdict: 'CANNOT MEASURE', why: reasons.join('; ') };
  return { verdict: 'HOLDS', why: `alive at 60 s in ${RUNS_PER_FORM} of ${RUNS_PER_FORM} runs of each form` };
}

/** P6, from the exec's and the login shell's PATH and lookups. */
function p6Verdict(exec, login) {
  if (!exec || typeof exec.path !== 'string' || !login || typeof login.path !== 'string') return { verdict: 'CANNOT MEASURE', why: 'a PATH was not read', differences: [] };
  const a = pathEntries(exec.path);
  const b = pathEntries(login.path);
  const differences = [];
  const onlyLogin = b.filter((e) => !a.includes(e));
  const onlyExec = a.filter((e) => !b.includes(e));
  if (onlyLogin.length) differences.push(`only in the login PATH: ${onlyLogin.join(', ')}`);
  if (onlyExec.length) differences.push(`only in the exec PATH: ${onlyExec.join(', ')}`);
  if (!onlyLogin.length && !onlyExec.length && a.join(':') !== b.join(':')) differences.push('the same entries in another order');
  for (const c of PROGRAMS) {
    const x = (exec.found && exec.found[c]) || '';
    const y = (login.found && login.found[c]) || '';
    if (x !== y) differences.push(`${c}: exec finds ${x || 'nothing'}, login finds ${y || 'nothing'}`);
  }
  return differences.length ? { verdict: 'DIFFERS', why: differences.join('; '), differences } : { verdict: 'SAME', why: 'the same PATH entries in order, and the same file (or none) for each program', differences };
}

// ---------------------------------------------------------------- remote steps

/** One ssh connection that runs `command` on the host, with `input` on its standard input. */
function ssh(target, flags, command, input) {
  const r = spawnSync('ssh', [...SSH_OPTS, ...flags, target.dest, command], { input: input ?? '', encoding: 'utf8', timeout: SSH_TIMEOUT_MS, windowsHide: true });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', timedOut: Boolean(r.error && r.error.code === 'ETIMEDOUT') };
}

/** A script for `sh -s` on the host, through an exec with no terminal. */
function runScript(target, script) {
  const r = ssh(target, ['-T'], 'sh -s', script);
  return { ...r, marked: parseMarked(r.stdout) };
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const PREP = `
echo @@begin
echo "@@uid $(id -u)"
echo "@@user $(id -un)"
echo "@@home $HOME"
echo "@@os $( (. /etc/os-release 2>/dev/null; printf %s "\${PRETTY_NAME:-unknown}") )"
echo "@@kernel $(uname -sr)"
if [ -e "/tmp/aicc-$(id -u)" ]; then echo "@@rundir present"; else echo "@@rundir absent"; fi
echo "@@kill-user-processes $(loginctl show-session -p KillUserProcesses --value 2>/dev/null || echo unknown)"
echo "@@kill-exclude-users $(loginctl show-session -p KillExcludeUsers --value 2>/dev/null || echo unknown)"
echo "@@linger $(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo unknown)"
d=$(mktemp -d "\${TMPDIR:-/tmp}/aicc-p3p6.XXXXXXXX") && chmod 700 "$d" && echo "@@dir $d"
echo @@end
`;

const verifyScript = (dir) => `
d=${q(dir)}
echo @@begin
chmod 700 "$d/aicc-helper" && echo "@@sha $(sha256sum "$d/aicc-helper" | cut -d' ' -f1)"
echo "@@version $("$d/aicc-helper" version 2>&1 | head -n 1)"
echo @@end
`;

const holdCommand = (dir, sid) => `${dir}/aicc-helper hold --store ${dir}/store --session ${sid} --away ${AWAY_SECS} --detach`;

/** Each holder: alive when its pid runs with its own command line. */
const checkScript = (dir, holders) => `
d=${q(dir)}
echo @@begin
for x in ${holders.map((h) => q(`${h.pid}:${h.sid}`)).join(' ')}; do
  p=\${x%%:*}; s=\${x#*:}
  if [ -r "/proc/$p/cmdline" ] && tr '\\0' ' ' < "/proc/$p/cmdline" | grep -qF -- "--store $d/store --session $s "; then a=alive; else a=gone; fi
  cg=$(cut -d: -f3- "/proc/$p/cgroup" 2>/dev/null | head -n 1)
  echo "@@run $s $a \${cg:-none}"
done
echo "@@list $("$d/aicc-helper" list --store "$d/store" 2>&1 | head -c 4000 | tr '\\n' ' ')"
echo @@end
`;

const P6_LOOKUP = (tag) => `echo "@@${tag}-path $PATH"; for c in ${PROGRAMS.join(' ')}; do echo "@@${tag}-$c $(command -v "$c" 2>/dev/null)"; done`;
const P6 = `
S=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)
[ -n "$S" ] || S=\${SHELL:-/bin/sh}
echo @@begin
echo "@@shell $S"
${P6_LOOKUP('exec')}
"$S" -lc ${q(P6_LOOKUP('login'))} </dev/null 2>/dev/null
"$S" -ilc ${q(P6_LOOKUP('ilogin'))} </dev/null 2>/dev/null
echo @@end
`;

/** End each holder (only a process with its own command line), then remove what the run made, each by name. */
const cleanScript = (dir, holders, endpoints, uid, rundirBefore) => `
d=${q(dir)}
own() { [ -r "/proc/$1/cmdline" ] && tr '\\0' ' ' < "/proc/$1/cmdline" | grep -qF -- "--store $d/store --session $2 "; }
echo @@begin
for x in ${holders.map((h) => q(`${h.pid}:${h.sid}`)).join(' ') || "''"}; do
  [ -n "$x" ] || continue; p=\${x%%:*}; s=\${x#*:}
  own "$p" "$s" && kill -TERM "$p" 2>/dev/null
done
sleep 2
for x in ${holders.map((h) => q(`${h.pid}:${h.sid}`)).join(' ') || "''"}; do
  [ -n "$x" ] || continue; p=\${x%%:*}; s=\${x#*:}
  own "$p" "$s" && kill -KILL "$p" 2>/dev/null
done
sleep 1
[ -x "$d/aicc-helper" ] && "$d/aicc-helper" list --store "$d/store" >/dev/null 2>&1
for e in ${endpoints.map(q).join(' ') || "''"}; do [ -n "$e" ] && rm -f -- "$e"; done
rm -f -- "\${d:?}/aicc-helper" "\${d:?}/store/.lock" "\${d:?}/store/"*.json
[ -d "\${d:?}/store" ] && rmdir -- "\${d:?}/store"
rmdir -- "\${d:?}"
${rundirBefore === 'absent' ? `rmdir -- /tmp/aicc-${uid} 2>/dev/null` : ':'}
echo "@@left $(pgrep -f -- "$d/" | wc -l)"
if [ -e "$d" ]; then echo "@@dir present $(ls -A "$d" "$d/store" 2>/dev/null | tr '\\n' ' ')"; else echo "@@dir gone"; fi
if [ -e "/tmp/aicc-${uid}" ]; then echo "@@rundir present"; else echo "@@rundir absent"; fi
echo @@end
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

async function probeHost(target, helper) {
  const res = { slot: target.slot, host: target.host, verdicts: {} };
  // One connect, with the 8 s limit, before anything else.
  const reach = ssh(target, ['-T'], 'true');
  if (reach.status !== 0) {
    res.notRun = classifyFailure(reach);
    res.verdicts = { P3: `NOT RUN: ${res.notRun}`, P6: `NOT RUN: ${res.notRun}` };
    res.leftAsFound = true;
    return res;
  }
  const prep = runScript(target, PREP);
  const m = prep.marked;
  if (!m || !isProbeDir(m.dir) || !/^\d+$/.test(m.uid || '')) {
    res.couldNotRun = `the host could not be prepared (${prep.status === 0 ? 'no temporary folder' : classifyFailure(prep)})`;
    res.verdicts = { P3: `COULD NOT RUN: ${res.couldNotRun}`, P6: `COULD NOT RUN: ${res.couldNotRun}` };
    res.leftAsFound = !m || !m.dir;
    return res;
  }
  const { uid, home, user, dir } = { uid: m.uid, home: m.home, user: m.user, dir: m.dir };
  const red = (s) => redact(s, home, user);
  res.system = { os: m.os, kernel: m.kernel, killUserProcesses: m['kill-user-processes'], killExcludeUsers: red(m['kill-exclude-users']), linger: m.linger };
  const holders = [];
  const endpoints = [];
  try {
    const cp = spawnSync('scp', ['-q', ...SSH_OPTS, path.basename(helper), `${target.dest}:${dir}/aicc-helper`], { cwd: path.dirname(helper), encoding: 'utf8', timeout: 120000, windowsHide: true });
    const want = crypto.createHash('sha256').update(fs.readFileSync(helper)).digest('hex');
    const v = runScript(target, verifyScript(dir)).marked;
    if (cp.status !== 0 || !v || v.sha !== want) throw new Error(`the helper could not be copied (${cp.status !== 0 ? classifyFailure({ status: cp.status, stderr: cp.stderr }) : 'its SHA-256 differs'})`);
    res.helperVersion = v.version;
    if (!/^aicc-helper \d+\.\d+\.\d+$/.test(v.version || '')) throw new Error(`the helper does not run there (${red(v.version).slice(0, 200)})`);

    // P3: six sessions, each logs out as its command ends.
    const runs = [];
    for (let i = 1; i <= RUNS_PER_FORM; i++) {
      for (const form of FORMS) {
        const sid = `p3-${form}-${i}`;
        const started = ssh(target, [form === 'tty' ? '-tt' : '-T'], holdCommand(dir, sid));
        const loggedOut = Date.now();
        const line = started.stdout.replace(/\r/g, '').split('\n').find((l) => l.startsWith('{'));
        let rec = null;
        try {
          rec = line ? JSON.parse(line) : null;
        } catch {
          rec = null;
        }
        const ok = started.status === 0 && rec && rec.session === sid && Number.isInteger(rec.pid) && rec.pid > 1;
        const run = { form, sid, started: Boolean(ok), loggedOut, alive: {}, cgroup: {} };
        if (ok) {
          holders.push({ pid: rec.pid, sid });
          if (isEndpoint(rec.endpoint, uid, sid)) endpoints.push(rec.endpoint);
          run.pid = rec.pid;
        } else run.why = red(`${started.status}: ${(started.stderr || started.stdout).trim().slice(0, 300)}`);
        runs.push(run);
      }
    }
    const last = Math.max(...runs.map((r) => r.loggedOut));
    for (const at of CHECK_AT_SECS) {
      await sleep(last + at * 1000 - Date.now());
      const checkedAt = Date.now();
      const c = holders.length ? runScript(target, checkScript(dir, holders)).marked : null;
      const rows = c ? [].concat(c.run || []) : [];
      for (const run of runs.filter((r) => r.started)) {
        const row = rows.map((x) => x.split(' ')).find((x) => x[0] === run.sid);
        run.alive[at] = row ? row[1] === 'alive' : null;
        run.cgroup[at] = row ? red(row.slice(2).join(' ')) : null;
        run[`secondsAfterLogout${at}`] = Math.round((checkedAt - run.loggedOut) / 100) / 10;
      }
      if (c) res[`list${at}`] = red(c.list);
    }
    const v3 = p3Verdict(runs);
    for (const run of runs) delete run.loggedOut;
    res.p3 = runs;
    res.verdicts.P3 = `${v3.verdict} - ${v3.why}`;

    // P6: one exec.
    const p6 = runScript(target, P6).marked;
    const side = (tag) => (p6 && typeof p6[`${tag}-path`] === 'string' ? { path: red(p6[`${tag}-path`]), found: Object.fromEntries(PROGRAMS.map((c) => [c, red(p6[`${tag}-${c}`] || '')])) } : null);
    res.p6 = { shell: p6 ? p6.shell : null, exec: side('exec'), login: side('login'), interactiveLogin: side('ilogin') };
    const v6 = p6Verdict(res.p6.exec, res.p6.login);
    res.verdicts.P6 = `${v6.verdict} - ${v6.why}`;
  } catch (e) {
    res.couldNotRun = e.message;
    if (!res.verdicts.P3) res.verdicts.P3 = `COULD NOT RUN: ${e.message}`;
    if (!res.verdicts.P6) res.verdicts.P6 = `COULD NOT RUN: ${e.message}`;
  } finally {
    const c = runScript(target, cleanScript(dir, holders, endpoints, uid, m.rundir)).marked;
    res.cleanUp = c ? { left: c.left, dir: red(c.dir), rundir: c.rundir, rundirBefore: m.rundir } : { error: 'the clean-up did not report' };
    res.leftAsFound = Boolean(c && c.left === '0' && c.dir === 'gone' && c.rundir === m.rundir);
  }
  return res;
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!['--hosts', '--helper', '--out'].includes(k) || argv[i + 1] === undefined) return null;
    out[k.slice(2)] = argv[i + 1];
  }
  return out.hosts && out.helper && out.out ? out : null;
}

async function main(argv, log = (s) => console.log(s)) {
  const a = args(argv);
  if (!a) {
    log('usage: node helper/probes/p3-p6-linux.cjs --hosts <hosts.local.json> --helper <aicc-helper> --out <folder>');
    return 2;
  }
  let json;
  try {
    json = JSON.parse(fs.readFileSync(a.hosts, 'utf8'));
  } catch {
    log('P3/P6 COULD NOT RUN - the hosts file cannot be read as JSON');
    return 2;
  }
  if (!fs.existsSync(a.helper) || fs.statSync(a.helper).size < 1024) {
    log('P3/P6 COULD NOT RUN - the helper file is missing');
    return 2;
  }
  fs.mkdirSync(a.out, { recursive: true });
  const slots = readSlots(json);
  json = undefined;
  const results = [];
  for (const slot of slots) {
    if (slot.missing) {
      log(`${slot.slot}: NOT RUN - ${slot.missing}`);
      results.push({ slot: slot.slot, verdicts: { P3: `NOT RUN: ${slot.missing}`, P6: `NOT RUN: ${slot.missing}` }, leftAsFound: true });
      continue;
    }
    log(`${slot.slot}: ${slot.host} as ${slot.username}`);
    const r = await probeHost({ ...slot, dest: `${slot.username}@${slot.host}` }, a.helper);
    log(`  P3 ${r.verdicts.P3}`);
    log(`  P6 ${r.verdicts.P6}`);
    log(`  left as found: ${r.leftAsFound ? 'yes' : 'NO'}`);
    results.push(r);
  }
  fs.writeFileSync(path.join(a.out, 'p3-p6-result.json'), `${JSON.stringify({ probe: 'P3 and P6', at: new Date().toISOString(), results }, null, 2)}\n`);
  const notLeft = results.filter((r) => !r.leftAsFound).map((r) => r.slot);
  log(notLeft.length ? `P3/P6 DONE; clean-up incomplete on: ${notLeft.join(', ')}` : 'P3/P6 DONE');
  return notLeft.length ? 1 : 0;
}

module.exports = { SLOTS, SSH_OPTS, readSlots, classifyFailure, parseMarked, redact, pathEntries, p3Verdict, p6Verdict, safePath, isProbeDir, isEndpoint, holdCommand, checkScript, cleanScript, P6, PREP };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
