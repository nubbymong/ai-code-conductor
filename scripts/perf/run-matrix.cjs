// Performance harness (scripts/perf, see README.md): run the whole measurement grid on the Windows test
// VM against the INSTALLED app, on a README staging root, and leave every reading in one folder for
// report.cjs.
//
//   CCC_PERF_TEST_VM=1 CCC_STAGE_ROOT=<root> node scripts/perf/run-matrix.cjs --prepare --app-version 2.1.3-beta.6 [options]
//
// It runs only on the test VM: Windows, CCC_PERF_TEST_VM=1, and a Hyper-V guest (lib/guard.cjs); it
// refuses anywhere else, a desktop that sets the opt-in included. Start it on the VM from SSH through
// WMI (Invoke-CimMethod Win32_Process Create), so it and the app it starts run in session 0, outside
// the SSH session's job (README.md has the command).
//
// For each N (default 1, 10, 25) it writes N sessions (gen-sessions.cjs, which also puts the seeded
// transcripts and databases back, so no run builds on another), starts the app
// (scripts/readme-shots/stage/launch.js: isolated environment, --remote-debugging-port and --inspect),
// checks that the ports are held by the app it started, presses Resume, opens each session once (a
// resumed tab starts its terminal only when it is first opened), waits until N session CLIs run,
// settles and measures an idle window; then switches the fake CLIs to busy, starts the transcript
// writer (load-sidecar.cjs), settles again and measures a busy window. A window is: the process
// sampler (sample-processes.ps1) every --interval seconds, the renderer's Performance metrics and the
// Services rows over one held CDP session (cdp-sample.cjs), and main's process list and active
// resources at both ends (main-inspector.cjs). At the N in --profile-at it also takes a renderer and a
// main CPU profile after each window (with main's process figures before and after), and at the N in
// --ab-at the reduced-motion A/B/A after a short gap. Then the ablations at N=--ablate-n busy: all
// services on, each of --ablate switched off in turn, and all on again, so the two all-on windows
// give the noise the savings are read against.
// Between runs it records the app's process tree, stops the app (launch.js stop), ends whatever of
// that tree is still alive (by pid and start time) and whatever of the run names the staging root,
// then waits until no app process is left and both debug ports are free; if they do not free up (or
// cannot be checked) it stops the whole grid rather than measure on top of a leftover.
//
// Options (seconds unless named):
//   --prepare            seed the root first (seed.js, a first start and stop, re-seed), --dom-terminals
//   --app-version V      the installed build's version, for the seed (no What's New on start)
//   --n 1,10,25          --settle 300   --window 180   --mode-settle 300   --interval 5
//   --profile 60  --profile-at 25      --ab 60  --ab-at 25  --ab-gap 15
//   --ablate tokenomics,logging,hooks  --ablate-n 25  --ablate-settle 300    (--ablate none: skip them)
//   --sidecar-ms 5000    one transcript line per session per this many ms while busy
//   --out <folder>       inside the staging root; default <root>/perf-out/<time>
//   --dry-run            print the plan and its length, start nothing
//   env CCC_PERF_PORT (9333); main's inspector is launch.js's fixed 9229
'use strict'

const fs = require('fs')
const path = require('path')
const { spawn, execFileSync } = require('child_process')
const { OFF_SETTING, MAX_SESSIONS } = require('./gen-sessions.cjs')

const HERE = __dirname
const REPO = path.resolve(HERE, '..', '..')
const STAGE_DIR = path.resolve(HERE, '..', 'readme-shots', 'stage')

const OPTIONS = Object.freeze(['--prepare', '--dry-run', '--app-version', '--n', '--settle', '--window', '--mode-settle', '--interval', '--profile', '--profile-at', '--ab', '--ab-at', '--ab-gap', '--ablate', '--ablate-n', '--ablate-settle', '--sidecar-ms', '--out'])
const FLAGS = Object.freeze(['--prepare', '--dry-run'])

/** The options, every one checked before anything starts (a typo must not
 *  fail the grid an hour in). Throws with what is wrong. */
function parseOptions(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!OPTIONS.includes(a)) throw new Error(`unknown option ${a}`)
    if (!FLAGS.includes(a)) { if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`${a} needs a value`); i++ }
  }
  const opt = (name, d) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : d }
  const num = (name, d, { min = 0, int = false } = {}) => {
    const raw = opt(name, d)
    const v = Number(raw)
    if (!Number.isFinite(v) || v < min || (int && !Number.isInteger(v))) throw new Error(`${name} must be ${int ? 'a whole number' : 'a number'} of at least ${min}, not ${raw}`)
    return v
  }
  const list = (name, d) => String(opt(name, d)).split(',').map((s) => s.trim()).filter(Boolean)
  const counts = (name, d) => list(name, d).filter((s) => s !== 'none').map((s) => {
    const v = Number(s)
    if (!Number.isInteger(v) || v < 1 || v > MAX_SESSIONS) throw new Error(`${name}: ${s} is not a whole number from 1 to ${MAX_SESSIONS}`)
    return v
  })
  const ablate = list('--ablate', 'tokenomics,logging,hooks').filter((s) => s !== 'none')
  for (const s of ablate) if (!OFF_SETTING[s]) throw new Error(`--ablate: ${s} is not one of none, ${Object.keys(OFF_SETTING).join(', ')}`)
  const o = {
    prepare: argv.includes('--prepare'),
    dryRun: argv.includes('--dry-run'),
    appVersion: opt('--app-version', null),
    ns: counts('--n', '1,10,25'),
    settle: num('--settle', 300),
    window: num('--window', 180, { min: 1 }),
    modeSettle: num('--mode-settle', 300),
    interval: num('--interval', 5, { min: 1, int: true }),
    profile: num('--profile', 60),
    profileAt: counts('--profile-at', '25'),
    ab: num('--ab', 60),
    abAt: counts('--ab-at', '25'),
    abGap: num('--ab-gap', 15),
    ablate,
    ablateN: counts('--ablate-n', '25')[0],
    ablateSettle: num('--ablate-settle', 300),
    sidecarMs: num('--sidecar-ms', 5000, { min: 200 }),
    out: opt('--out', null),
  }
  if (!o.ns.length) throw new Error('--n names no session count')
  if (o.window < 2 * o.interval) throw new Error(`--window (${o.window} s) must hold at least two --interval (${o.interval} s) samples`)
  if (o.ablate.length && !o.ablateN) throw new Error('--ablate-n names no session count')
  return o
}

/** The runs, each one app start: its N, what kind of run, the service
 *  switched off, and its windows. The ablations are all on, each service off
 *  in turn, then all on again. */
function planMatrix(o) {
  const runs = o.ns.map((n) => ({
    id: `n${n}`, kind: 'grid', n, off: 'none',
    phases: ['idle', 'busy'].map((mode, i) => ({ tag: `n${n}-${mode}`, mode, settle: i === 0 ? o.settle : o.modeSettle, window: o.window, profile: o.profileAt.includes(n) ? o.profile : 0, ab: o.abAt.includes(n) ? o.ab : 0 })),
  }))
  if (o.ablate.length) {
    const offs = ['none', ...o.ablate, 'none']
    offs.forEach((off, i) => {
      const again = off === 'none' && i > 0 ? '-again' : ''
      runs.push({ id: `n${o.ablateN}-off-${off}${again}`, kind: 'ablation', n: o.ablateN, off, phases: [{ tag: `n${o.ablateN}-busy-off-${off}${again}`, mode: 'busy', settle: o.ablateSettle, window: o.window, profile: 0, ab: 0 }] })
    })
  }
  return runs
}

/** Roughly how long the plan takes, in seconds (starts and stops at about a
 *  minute each, opening the sessions at about a minute more). */
function planSeconds(runs, o) {
  let s = o.prepare ? 120 : 0
  for (const r of runs) {
    s += 120
    for (const p of r.phases) s += p.settle + p.window + o.interval + (p.profile ? p.profile + 10 : 0) + (p.ab ? o.abGap + 3 * p.ab + 10 : 0)
  }
  return s
}

/** How long a run's transcript writer may need to run from the phase it starts in. */
function writerSeconds(run, from, o) {
  let s = 0
  for (const p of run.phases.slice(from)) s += p.settle + p.window + (p.profile ? p.profile + 10 : 0) + (p.ab ? o.abGap + 3 * p.ab + 10 : 0)
  return s
}

module.exports = { parseOptions, planMatrix, planSeconds, writerSeconds }

const S = require(path.join(STAGE_DIR, 'stage-root.js'))
const C = require('./lib/classify-process.cjs')
const G = require('./lib/guard.cjs')
const cdp = require('./cdp-sample.cjs')
const mainInspector = require('./main-inspector.cjs')

let opts = null
const PORT = Number(process.env.CCC_PERF_PORT) || 9333
// launch.js starts main with its default inspector port; it takes no option for it.
const INSPECT = 9229
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')

let OUT = null
let record = null
const log = (m) => {
  const line = `${new Date().toISOString()} ${m}`
  console.log(line)
  if (OUT) fs.appendFileSync(path.join(OUT, 'run.log'), line + '\n')
}
const save = () => fs.writeFileSync(path.join(OUT, 'run.json'), JSON.stringify(record, null, 1))
const writeJson = (name, v) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(v))

/** A node script of the staging or the harness, run to its end; its output goes to the log. */
function node(script, args, timeoutMs = 180000) {
  log(`> node ${path.basename(script)} ${args.join(' ')}`)
  let out
  try {
    out = execFileSync(process.execPath, [script, ...args], { env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, windowsHide: true })
  } catch (e) {
    log(`  failed (exit ${e.status}): ${String(e.stderr || e.stdout || e.message).trim().split(/\r?\n/).slice(-6).join(' / ')}`)
    throw new Error(`${path.basename(script)} ${args[0] || ''} failed`)
  }
  for (const l of String(out).trim().split(/\r?\n/)) if (l.trim()) log('  ' + l)
  return out
}
const seed = (args) => node(path.join(STAGE_DIR, 'seed.js'), args, 300000)
const launch = (args) => node(path.join(STAGE_DIR, 'launch.js'), args, 180000)
const gen = (args) => node(path.join(HERE, 'gen-sessions.cjs'), args)

/** The checkout's commit, and whether tracked files differ from it, for the record. */
function checkout() {
  const git = (args) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim()
  try { return { commit: git(['rev-parse', 'HEAD']), changed: git(['status', '--porcelain', '--untracked-files=no']).length > 0 } } catch { return { commit: null, changed: null } }
}

/** App processes of any build (the installed app, or a development Electron). */
function appProcesses() {
  const out = execFileSync('tasklist', ['/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  return out.split(/\r?\n/).filter((l) => /^"(AI Code Conductor|electron)\.exe"/i.test(l)).length
}

/** Every process now: pid, parent, name, start time (ms) and command line. */
function processSnapshot() {
  const ps = 'Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = $_.Name; created = $(if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds() } else { 0 }); cmd = "$($_.CommandLine)" } } | ConvertTo-Json -Compress'
  try {
    const t = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024 }).trim()
    return t ? [].concat(JSON.parse(t)) : []
  } catch (e) {
    log('  could not list processes: ' + e.message)
    return null
  }
}

/** The app's process tree now, from launch.js's record: main (when it is still the recorded process)
 *  and everything started under it, each with its start time. */
function appTree(rec) {
  const all = processSnapshot() || []
  const main = all.find((r) => r.pid === rec.pid)
  if (!main || main.created < Date.parse(rec.startedAt) - 2000) return []
  const pids = C.processTree(all, rec.pid)
  return all.filter((r) => pids.has(r.pid))
}

/** Processes started since `sinceMs` whose command line names the staging root (the app, its
 *  terminals' shells and CLIs, the vision browser on the staging profile), with their start times. */
function stagedProcesses(stage, sinceMs, all) {
  const root = stage.ROOT.toLowerCase()
  return (all || []).filter((r) => r.created >= sinceMs && /^(AI Code Conductor|aicc-helper|node|cmd|powershell|pwsh|conhost|OpenConsole|chrome)\.exe$/i.test(r.name) && String(r.cmd).toLowerCase().includes(root) && !/scripts[\\/]perf[\\/]/i.test(r.cmd))
}

/** The fake Claude CLIs running now for this run: one per live session (started with --resume; the
 *  app's short --version and auth probes of the same file are not sessions). */
const liveSessions = (stage, sinceMs) => stagedProcesses(stage, sinceMs, processSnapshot()).filter((r) => C.classifyProcess(r) === 'fake-claude').length

/** Stop each process in `rows`, only while it is still the same process (pid and start time). */
function stopLeftovers(rows) {
  if (!rows.length) return []
  const pairs = rows.map((r) => `@(${Number(r.pid)},${Number(r.created)})`).join(',')
  const ps = `foreach ($w in @(${pairs})) { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($w[0])"; if ($p -and $p.CreationDate -and [DateTimeOffset]::new($p.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds() -eq $w[1]) { Stop-Process -Id $w[0] -Force -ErrorAction SilentlyContinue; "$($w[0]) stopped" } else { "$($w[0]) gone or reused" } }`
  let out = ''
  try { out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 120000 }) } catch (e) { out = rows.map((r) => `${r.pid} failed: ${e.message}`).join('\n') }
  const said = new Map(out.split(/\r?\n/).filter(Boolean).map((l) => { const i = l.indexOf(' '); return [Number(l.slice(0, i)), l.slice(i + 1)] }))
  return rows.map((r) => ({ pid: r.pid, name: r.name, outcome: said.get(Number(r.pid)) || 'not reported' }))
}

const portsFree = () => [PORT, INSPECT].every((p) => S.portOwnerPid(p) === null)
const portState = () => [PORT, INSPECT].map((p) => { const o = S.portOwnerPid(p); return o === null ? null : `port ${p} ${o === undefined ? 'could not be checked' : 'held by pid ' + o}` }).filter(Boolean)

/** After a stop: end what is left of the app's tree (`tree`, recorded before the stop) and of the run
 *  (its command line names the staging root), then no app process and both debug ports free. Throws
 *  when not. What was ended goes into runRec.leftovers. */
async function waitClean(stage, sinceMs, runRec, tree = []) {
  for (let i = 0; i < 60; i++) {
    if (appProcesses() === 0 && portsFree()) break
    await sleep(1000)
  }
  const now = processSnapshot() || []
  const alive = new Set(now.map((r) => `${r.pid}@${r.created}`))
  const left = new Map()
  for (const r of tree) if (alive.has(`${r.pid}@${r.created}`)) left.set(`${r.pid}@${r.created}`, r)
  for (const r of stagedProcesses(stage, sinceMs, now)) left.set(`${r.pid}@${r.created}`, r)
  const ended = stopLeftovers([...left.values()])
  for (const e of ended) log(`  leftover ${e.pid} ${e.name}: ${e.outcome}`)
  if (runRec) { runRec.leftovers = (runRec.leftovers || []).concat(ended); save() }
  let clean = false
  for (let i = 0; i < 15 && !clean; i++) {
    clean = appProcesses() === 0 && portsFree()
    if (!clean) await sleep(1000)
  }
  if (!clean) {
    const apps = appProcesses()
    throw new Error(`not clean after the stop: ${apps} app processes; ${portState().join(', ') || 'ports free'}`)
  }
  log('  clean: no app process, ports free')
}

/** A child process whose output goes to the log. `done` resolves with its exit code (-1 when it could
 *  not start); killAfterMs stops it when it runs that long. */
function startChild(cmd, args, name, { stdin = 'ignore', killAfterMs = 0 } = {}) {
  const child = spawn(cmd, args, { env: process.env, stdio: [stdin, 'pipe', 'pipe'], windowsHide: true })
  const tail = (d) => { for (const l of String(d).trim().split(/\r?\n/)) if (l.trim()) log(`  [${name}] ${l}`) }
  child.stdout.on('data', tail)
  child.stderr.on('data', tail)
  let timer = null
  child.done = new Promise((resolve) => {
    child.on('error', (e) => { clearTimeout(timer); log(`  [${name}] could not start: ${e.message}`); resolve(-1) })
    child.on('exit', (code) => { clearTimeout(timer); resolve(code) })
  })
  if (killAfterMs > 0) timer = setTimeout(() => { log(`  [${name}] still running after ${Math.round(killAfterMs / 1000)} s: stopped`); child.kill() }, killAfterMs)
  return child
}

/** The process sampler for `seconds`; stopped if it is still running a minute after that. */
function sampler(tag, seconds) {
  const file = path.join(OUT, `samples-${tag}.jsonl`)
  const child = startChild('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'sample-processes.ps1'), '-Out', file, '-IntervalSec', String(opts.interval), '-DurationSec', String(Math.ceil(seconds)), '-Tag', tag], 'sampler', { killAfterMs: (seconds + 60) * 1000 })
  return { child, file: path.basename(file) }
}

const snap = () => mainInspector.snapshot(INSPECT).catch((e) => ({ error: e.message }))

async function measureWindow(run, phase, runRec) {
  const tag = phase.tag
  log(`window ${tag}: ${phase.window} s`)
  const mainStart = await snap()
  const s = sampler(tag, phase.window)
  const from = Date.now()
  const [renderer, samplerExit] = await Promise.all([cdp.measureWindow(phase.window, PORT).catch((e) => ({ error: e.message })), s.child.done])
  const mainEnd = await snap()
  const w = { tag, run: run.id, kind: run.kind, n: run.n, mode: phase.mode, off: run.off, appStartedAt: runRec.appStartedAt, from, to: Date.now(), samples: s.file, samplerExit, renderer, mainStart, mainEnd }
  writeJson(`window-${tag}.json`, w)
  // A window whose sampler failed has no process figures: it is kept on disk but not reported.
  if (samplerExit !== 0) throw new Error(`window ${tag}: the process sampler exited ${samplerExit}`)
  runRec.windows.push({ tag, mode: phase.mode, file: `window-${tag}.json` })
  if (renderer.error) log(`  renderer window failed: ${renderer.error}`)
  save()
}

async function profiles(phase, runRec) {
  log(`profiles ${phase.tag}: ${phase.profile} s`)
  if (!fs.existsSync(path.join(OUT, 'main-sources.json'))) {
    try { const src = await mainInspector.sources(INSPECT); writeJson('main-sources.json', src.files); record.mainDir = src.dir; save() } catch (e) { log('  main sources not read: ' + e.message) }
  }
  // main's process figures around the profile: what the whole main process used while its JS thread was profiled.
  const mainStart = await snap()
  const from = Date.now()
  const [r, m] = await Promise.all([
    cdp.profile(phase.profile, PORT).catch((e) => ({ error: e.message })),
    mainInspector.profile(phase.profile, INSPECT).catch((e) => ({ error: e.message })),
  ])
  const to = Date.now()
  const mainEnd = await snap()
  if (!r.error) writeJson(`renderer-${phase.tag}.cpuprofile`, r); else log('  renderer profile failed: ' + r.error)
  if (!m.error) writeJson(`main-${phase.tag}.cpuprofile`, m); else log('  main profile failed: ' + m.error)
  writeJson(`profile-${phase.tag}.json`, { tag: phase.tag, from, to, mainStart, mainEnd })
  runRec.profiles.push({ tag: phase.tag, renderer: r.error ? null : `renderer-${phase.tag}.cpuprofile`, main: m.error ? null : `main-${phase.tag}.cpuprofile`, marks: `profile-${phase.tag}.json` })
  save()
}

async function abTest(phase, runRec) {
  log(`reduced-motion A/B/A ${phase.tag}: ${phase.ab} s each part, after ${opts.abGap} s`)
  // The profilers have just let go of both processes: a short gap before the first part.
  await sleep(opts.abGap * 1000)
  // The parts are cut by their times, so the sampler runs a margin past the end.
  const s = sampler(`${phase.tag}-ab`, 3 * phase.ab + 30)
  let switchAt = null
  let backAt = null
  const from = Date.now()
  // main's process figures at the start, each switch and the end: each part's CPU from the app's own figures.
  const marks = { start: snap, switch: () => { switchAt = Date.now(); return snap() }, back: () => { backAt = Date.now(); return snap() }, end: snap }
  const result = await cdp.reducedMotionAB(phase.ab, marks, PORT).catch((e) => ({ error: e.message }))
  const to = Date.now()
  const samplerExit = await s.child.done
  writeJson(`ab-${phase.tag}.json`, { tag: phase.tag, from, switchAt, backAt, to, samples: s.file, samplerExit, result })
  if (samplerExit !== 0) throw new Error(`A/B ${phase.tag}: the process sampler exited ${samplerExit}`)
  runRec.ab.push({ tag: phase.tag, file: `ab-${phase.tag}.json` })
  if (result.error) log('  A/B failed: ' + result.error)
  else if (result.reduceMatched === false) log('  A/B: the page did not take prefers-reduced-motion: reduce')
  save()
}

async function doRun(run, stage) {
  log(`== run ${run.id}: N=${run.n}, off: ${run.off}`)
  const runRec = { id: run.id, kind: run.kind, n: run.n, off: run.off, started: Date.now(), windows: [], profiles: [], ab: [], errors: [], leftovers: [] }
  record.runs.push(runRec)
  save()
  let sidecar = null
  let rec = null
  let tree = []
  const stopSidecar = async () => {
    if (!sidecar) return
    try { sidecar.stdin.end() } catch { /* already closed */ }
    sidecar.kill()
    await sidecar.done
    log('  transcript writer stopped')
    sidecar = null
  }
  try {
    gen(['--n', String(run.n), '--mode', run.phases[0].mode, '--off', run.off])
    launch(['start', '--port', String(PORT)])
    rec = S.readLaunchRecord(stage)
    runRec.appPid = rec.pid
    runRec.appStartedAt = Date.parse(rec.startedAt)
    // Only the app launch.js just started: it is the recorded process and holds both ports.
    G.checkStagedApp(S, rec, [PORT, INSPECT])
    await sleep(5000)
    runRec.resume = await cdp.resume(120, PORT)
    log('  resume: ' + JSON.stringify(runRec.resume))
    // A resumed tab starts its terminal only when it is first opened.
    runRec.opened = await cdp.openAllSessions(run.n, {}, PORT).catch((e) => ({ error: e.message }))
    log('  opened: ' + JSON.stringify(runRec.opened))
    // Measured only with every session's CLI running: a terminal on the page is not proof of one.
    let live = 0
    for (let i = 0; i < 24 && live < run.n; i++) { live = liveSessions(stage, runRec.started); if (live < run.n) await sleep(5000) }
    runRec.liveSessions = live
    log(`  live sessions (fake CLI processes with --resume): ${live} of ${run.n}`)
    if (live < run.n) throw new Error(`only ${live} of ${run.n} sessions started`)
    for (let i = 0; i < run.phases.length; i++) {
      const phase = run.phases[i]
      if (i > 0 && phase.mode !== run.phases[i - 1].mode) gen(['--mode', phase.mode])
      if (phase.mode === 'busy' && !sidecar) {
        // Ends on its own after the run's remaining phases and a margin, and with this runner (its input closes).
        const seconds = Math.ceil(writerSeconds(run, i, opts) + 300)
        sidecar = startChild(process.execPath, [path.join(HERE, 'load-sidecar.cjs'), '--every-ms', String(opts.sidecarMs), '--seconds', String(seconds), '--exit-on-stdin-close'], 'writer', { stdin: 'pipe' })
        record.harnessPids.push(sidecar.pid)
      }
      if (phase.mode !== 'busy') await stopSidecar()
      log(`settle ${phase.settle} s (${phase.mode})`)
      await sleep(phase.settle * 1000)
      runRec.state = await cdp.state(PORT).catch((e) => ({ error: e.message }))
      log('  page: ' + JSON.stringify({ terminals: runRec.state.terminals, runningTab: runRec.state.runningTab }))
      await measureWindow(run, phase, runRec)
      if (phase.profile) await profiles(phase, runRec)
      if (phase.ab) await abTest(phase, runRec)
    }
  } catch (e) {
    runRec.errors.push(e.message)
    log(`run ${run.id} failed: ${e.message}`)
  } finally {
    await stopSidecar()
    // The tree before the stop: what of it is still alive afterwards is ended by pid and start time.
    tree = rec ? appTree(rec) : []
    runRec.treeAtStop = tree.length
    try {
      const said = String(launch(['stop'])).split(/\r?\n/).find((l) => /taskkill exited/.test(l))
      if (said) runRec.stopNote = said.trim()
    } catch (e) { runRec.stopWarning = e.message }
    runRec.ended = Date.now()
    save()
  }
  await waitClean(stage, runRec.started, runRec, tree)
}

async function cli() {
  try { opts = parseOptions(process.argv.slice(2)) } catch (e) { throw new S.StageRefusal(e.message) }
  const runs = planMatrix(opts)
  const mins = Math.round(planSeconds(runs, opts) / 60)
  if (opts.dryRun) {
    for (const r of runs) console.log(`${r.id}: N=${r.n} off=${r.off} ${r.phases.map((p) => `${p.tag}(settle ${p.settle}, window ${p.window}${p.profile ? ', profile ' + p.profile : ''}${p.ab ? ', A/B/A ' + p.ab : ''})`).join(' then ')}`)
    console.log(`about ${mins} min`)
    return
  }
  const refusal = G.testVmRefusal({ platform: process.platform, env: process.env, ...(process.platform === 'win32' ? G.machineModel() : {}) })
  if (refusal) throw new S.StageRefusal(refusal)
  const stage = S.resolveStage(process.env)
  if (!opts.prepare) S.ensureMarker(stage.ROOT, { create: false })
  if (appProcesses()) throw new S.StageRefusal('an app instance is already running: one app at a time')
  for (const p of [PORT, INSPECT]) { const o = S.portOwnerPid(p); if (o !== null) throw new S.StageRefusal(o === undefined ? `could not tell whether port ${p} is free` : `port ${p} is in use (pid ${o})`) }
  const out = G.resultsDir(S, stage, opts.out, stamp())
  // The sampler appends: a results folder from an earlier run would mix two runs' samples.
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new S.StageRefusal(`the results folder ${out} is not empty: give a new one`)
  if (opts.prepare) {
    if (!opts.appVersion) throw new S.StageRefusal('--prepare needs --app-version (the installed build)')
    seed(['--app-version', opts.appVersion, '--dom-terminals'])
  }
  OUT = out
  fs.mkdirSync(OUT, { recursive: true })
  record = { started: Date.now(), options: opts, ports: { cdp: PORT, inspect: INSPECT }, stageRoot: stage.ROOT, checkout: checkout(), harnessPids: [process.pid], plan: runs, runs: [] }
  save()
  log(`perf matrix: ${runs.length} runs, about ${mins} min; results in ${OUT}; checkout ${record.checkout.commit || '?'}${record.checkout.changed ? ' (with changes)' : ''}`)
  try {
    if (opts.prepare) {
      log('prepare: first start and stop, then re-seed')
      const since = Date.now()
      launch(['start', '--port', String(PORT)])
      await sleep(15000)
      const rec = S.readLaunchRecord(stage)
      const tree = appTree(rec)
      record.prepare = { leftovers: [] }
      try { launch(['stop']) } catch (e) { record.prepare.stopWarning = e.message }
      await waitClean(stage, since, record.prepare, tree)
      seed(['--app-version', opts.appVersion, '--reuse-backup', '--dom-terminals'])
    }
    for (const run of runs) await doRun(run, stage)
  } catch (e) {
    record.aborted = e.message
    log('ABORTED: ' + e.message)
  } finally {
    record.finished = Date.now()
    save()
    log(`DONE ${record.aborted ? 'aborted' : 'complete'}: node scripts/perf/report.cjs "${OUT}"`)
  }
}

if (require.main === module) {
  cli().catch((e) => {
    if (e instanceof S.StageRefusal) { console.error('refusing: ' + e.message); process.exit(2) }
    console.error(e && e.stack ? e.stack : e)
    process.exit(1)
  })
}
