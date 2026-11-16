// Performance harness (scripts/perf, see README.md): run the whole measurement grid on the Windows test
// VM against the INSTALLED app, on a README staging root, and leave every reading in one folder for
// report.cjs.
//
//   CCC_STAGE_ROOT=<root> node scripts/perf/run-matrix.cjs --prepare --app-version 2.1.3-beta.6 [options]
//
// Start it on the VM from SSH through WMI (Invoke-CimMethod Win32_Process Create), so it and the app
// it starts run in session 0, outside the SSH session's job (README.md has the command).
//
// For each N (default 1, 10, 25) it writes N sessions (gen-sessions.cjs), starts the app
// (scripts/readme-shots/stage/launch.js: isolated environment, --remote-debugging-port and --inspect),
// presses Resume, opens each session once (a resumed tab starts its terminal only when it is first
// opened), waits for things to settle, and measures an idle window; then switches the fake CLIs
// to busy, starts the transcript writer (load-sidecar.cjs), settles again and measures a busy window.
// A window is: the process sampler (sample-processes.ps1) every --interval seconds, the renderer's
// Performance metrics over one held CDP session (cdp-sample.cjs), and main's event loop and process
// list at both ends (main-inspector.cjs). At the N in --profile-at it also takes a renderer and a main
// CPU profile after each window, and at the N in --ab-at the reduced-motion A/B. Then the ablations:
// N=--ablate-n busy, once with every service on and once with each of --ablate switched off.
// Between runs it stops the app (launch.js stop), then waits until no app process is left and both
// debug ports are free; if they do not free up it stops the whole grid rather than measure on top of
// a leftover.
//
// Options (seconds unless named):
//   --prepare            seed the root first (seed.js, a first start and stop, re-seed), --dom-terminals
//   --app-version V      the installed build's version, for the seed (no What's New on start)
//   --n 1,10,25          --settle 300   --window 180   --mode-settle 90   --interval 5
//   --profile 60  --profile-at 25      --ab 60  --ab-at 25
//   --ablate tokenomics,logging,hooks  --ablate-n 25  --ablate-settle 240    (--ablate none: skip them)
//   --sidecar-ms 5000    one transcript line per session per this many ms while busy
//   --out <folder>       default <root>/perf-out/<time>
//   --dry-run            print the plan and its length, start nothing
//   env CCC_PERF_PORT (9333); main's inspector is launch.js's fixed 9229
'use strict'

const fs = require('fs')
const path = require('path')
const { spawn, execFileSync } = require('child_process')

const HERE = __dirname
const STAGE_DIR = path.resolve(HERE, '..', 'readme-shots', 'stage')

function parseOptions(argv) {
  const opt = (name, d) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : d }
  const num = (name, d) => { const v = Number(opt(name, d)); if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be a number`); return v }
  const list = (name, d) => String(opt(name, d)).split(',').map((s) => s.trim()).filter(Boolean)
  const ablate = list('--ablate', 'tokenomics,logging,hooks').filter((s) => s !== 'none')
  return {
    prepare: argv.includes('--prepare'),
    dryRun: argv.includes('--dry-run'),
    appVersion: opt('--app-version', null),
    ns: list('--n', '1,10,25').map(Number),
    settle: num('--settle', 300),
    window: num('--window', 180),
    modeSettle: num('--mode-settle', 90),
    interval: num('--interval', 5),
    profile: num('--profile', 60),
    profileAt: list('--profile-at', '25').map(Number),
    ab: num('--ab', 60),
    abAt: list('--ab-at', '25').map(Number),
    ablate,
    ablateN: num('--ablate-n', 25),
    ablateSettle: num('--ablate-settle', 240),
    sidecarMs: num('--sidecar-ms', 5000),
    out: opt('--out', null),
  }
}

/** The runs, each one app start: its N, the service switched off, and its windows. */
function planMatrix(o) {
  const runs = o.ns.map((n) => ({
    id: `n${n}`, n, off: 'none',
    phases: ['idle', 'busy'].map((mode, i) => ({ tag: `n${n}-${mode}`, mode, settle: i === 0 ? o.settle : o.modeSettle, window: o.window, profile: o.profileAt.includes(n) ? o.profile : 0, ab: o.abAt.includes(n) ? o.ab : 0 })),
  }))
  if (o.ablate.length) {
    for (const off of ['none', ...o.ablate]) {
      runs.push({ id: `n${o.ablateN}-off-${off}`, n: o.ablateN, off, phases: [{ tag: `n${o.ablateN}-busy-off-${off}`, mode: 'busy', settle: o.ablateSettle, window: o.window, profile: 0, ab: 0 }] })
    }
  }
  return runs
}

/** Roughly how long the plan takes, in seconds (starts and stops at about a minute each). */
function planSeconds(runs, o) {
  let s = o.prepare ? 120 : 0
  for (const r of runs) {
    s += 60
    for (const p of r.phases) s += p.settle + p.window + o.interval + p.profile + (p.ab ? 2 * p.ab + o.interval : 0)
  }
  return s
}

module.exports = { parseOptions, planMatrix, planSeconds }

const S = require(path.join(STAGE_DIR, 'stage-root.js'))
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

function appProcesses() {
  const out = execFileSync('tasklist', ['/fi', 'IMAGENAME eq AI Code Conductor.exe', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true })
  return out.split(/\r?\n/).filter((l) => /AI Code Conductor\.exe/i.test(l)).length
}

/** Processes started since `sinceMs` whose command line names the staging root (the app, its
 *  terminals' CLIs, the vision browser on the staging profile), with their start times. */
function stagedProcesses(stage, sinceMs) {
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CreationDate -and $_.CreationDate.ToUniversalTime() -ge [DateTime]::Parse('${new Date(sinceMs).toISOString()}').ToUniversalTime() } | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; name = $_.Name; created = $_.CreationDate.ToUniversalTime().ToString('o'); cmd = "$($_.CommandLine)" } } | ConvertTo-Json -Compress`
  let rows = []
  try { const t = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 60000 }).trim(); rows = t ? [].concat(JSON.parse(t)) : [] } catch (e) { log('  could not list processes: ' + e.message) }
  const root = stage.ROOT.toLowerCase()
  return rows.filter((r) => /^(AI Code Conductor|aicc-helper|node|cmd|conhost|chrome)\.exe$/i.test(r.name) && String(r.cmd).toLowerCase().includes(root) && !/scripts[\\/]perf[\\/]/i.test(r.cmd))
}
const leftovers = stagedProcesses

/** The fake Claude CLIs running now for this run (one per live session). */
const liveSessions = (stage, sinceMs) => stagedProcesses(stage, sinceMs).filter((r) => /^node\.exe$/i.test(r.name) && /fake-claude\.js/i.test(r.cmd)).length

/** Stop one leftover, only if it is still the same process (pid and start time). */
function stopLeftover(r) {
  const ps = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(r.pid)}"; if ($p -and $p.CreationDate.ToUniversalTime().ToString('o') -eq '${r.created}') { Stop-Process -Id ${Number(r.pid)} -Force; 'stopped' } else { 'gone or reused' }`
  try { return execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim() } catch (e) { return 'failed: ' + e.message }
}

/** After a stop: no app process, both debug ports free, nothing of this run left. Throws when not. */
async function waitClean(stage, sinceMs) {
  for (let i = 0; i < 60; i++) {
    if (appProcesses() === 0 && S.portOwnerPid(PORT) === null && S.portOwnerPid(INSPECT) === null) break
    await sleep(1000)
  }
  const left = leftovers(stage, sinceMs)
  for (const r of left) log(`  leftover ${r.pid} ${r.name}: ${stopLeftover(r)}`)
  const apps = appProcesses()
  const owners = [PORT, INSPECT].map((p) => [p, S.portOwnerPid(p)]).filter(([, o]) => o !== null)
  if (apps || owners.length) throw new Error(`not clean after the stop: ${apps} app processes; ${owners.map(([p, o]) => `port ${p} held by pid ${o}`).join(', ') || 'ports free'}`)
  log('  clean: no app process, ports free')
}

function startChild(cmd, args, name) {
  const child = spawn(cmd, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const tail = (d) => { for (const l of String(d).trim().split(/\r?\n/)) if (l.trim()) log(`  [${name}] ${l}`) }
  child.stdout.on('data', tail)
  child.stderr.on('data', tail)
  child.done = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
  return child
}

function sampler(tag, seconds) {
  const file = path.join(OUT, `samples-${tag}.jsonl`)
  const child = startChild('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'sample-processes.ps1'), '-Out', file, '-IntervalSec', String(opts.interval), '-DurationSec', String(seconds), '-Tag', tag], 'sampler')
  return { child, file: path.basename(file) }
}

async function measureWindow(run, phase, runRec) {
  const tag = phase.tag
  log(`window ${tag}: ${phase.window} s`)
  const mainStart = await mainInspector.snapshot(INSPECT).catch((e) => ({ error: e.message }))
  const s = sampler(tag, phase.window)
  const from = Date.now()
  const [renderer, samplerExit] = await Promise.all([cdp.measureWindow(phase.window, PORT).catch((e) => ({ error: e.message })), s.child.done])
  const mainEnd = await mainInspector.snapshot(INSPECT).catch((e) => ({ error: e.message }))
  const w = { tag, run: run.id, n: run.n, mode: phase.mode, off: run.off, from, to: Date.now(), samples: s.file, samplerExit, renderer, mainStart, mainEnd }
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
  const [r, m] = await Promise.all([
    cdp.profile(phase.profile, PORT).catch((e) => ({ error: e.message })),
    mainInspector.profile(phase.profile, INSPECT).catch((e) => ({ error: e.message })),
  ])
  if (!r.error) writeJson(`renderer-${phase.tag}.cpuprofile`, r); else log('  renderer profile failed: ' + r.error)
  if (!m.error) writeJson(`main-${phase.tag}.cpuprofile`, m); else log('  main profile failed: ' + m.error)
  runRec.profiles.push({ tag: phase.tag, renderer: r.error ? null : `renderer-${phase.tag}.cpuprofile`, main: m.error ? null : `main-${phase.tag}.cpuprofile` })
  save()
}

async function abTest(phase, runRec) {
  log(`reduced-motion A/B ${phase.tag}: ${phase.ab} s each half`)
  const s = sampler(`${phase.tag}-ab`, 2 * phase.ab + 2)
  let switchAt = null
  const from = Date.now()
  const [result, samplerExit] = await Promise.all([cdp.reducedMotionAB(phase.ab, (t) => { switchAt = t }, PORT).catch((e) => ({ error: e.message })), s.child.done])
  writeJson(`ab-${phase.tag}.json`, { tag: phase.tag, from, switchAt, to: Date.now(), samples: s.file, samplerExit, result })
  if (samplerExit !== 0) throw new Error(`A/B ${phase.tag}: the process sampler exited ${samplerExit}`)
  runRec.ab.push({ tag: phase.tag, file: `ab-${phase.tag}.json` })
  if (result.error) log('  A/B failed: ' + result.error)
  save()
}

async function doRun(run, stage) {
  log(`== run ${run.id}: N=${run.n}, off: ${run.off}`)
  const runRec = { id: run.id, n: run.n, off: run.off, started: Date.now(), windows: [], profiles: [], ab: [], errors: [] }
  record.runs.push(runRec)
  save()
  gen(['--n', String(run.n), '--mode', run.phases[0].mode, '--off', run.off])
  let sidecar = null
  const stopSidecar = async () => { if (sidecar) { sidecar.kill(); await sidecar.done; log('  transcript writer stopped'); sidecar = null } }
  try {
    launch(['start', '--port', String(PORT)])
    const rec = S.readLaunchRecord(stage)
    runRec.appPid = rec.pid
    runRec.appStartedAt = rec.startedAt
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
    log(`  live sessions (fake CLI processes): ${live} of ${run.n}`)
    if (live < run.n) throw new Error(`only ${live} of ${run.n} sessions started`)
    for (let i = 0; i < run.phases.length; i++) {
      const phase = run.phases[i]
      if (i > 0 && phase.mode !== run.phases[i - 1].mode) gen(['--mode', phase.mode])
      if (phase.mode === 'busy' && !sidecar) {
        sidecar = startChild(process.execPath, [path.join(HERE, 'load-sidecar.cjs'), '--every-ms', String(opts.sidecarMs)], 'writer')
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
    try { launch(['stop']) } catch (e) { runRec.errors.push(e.message) }
    runRec.ended = Date.now()
    save()
  }
  await waitClean(stage, runRec.started)
}

async function cli() {
  opts = parseOptions(process.argv.slice(2))
  const runs = planMatrix(opts)
  const mins = Math.round(planSeconds(runs, opts) / 60)
  if (opts.dryRun) {
    for (const r of runs) console.log(`${r.id}: N=${r.n} off=${r.off} ${r.phases.map((p) => `${p.tag}(settle ${p.settle}, window ${p.window}${p.profile ? ', profile ' + p.profile : ''}${p.ab ? ', A/B ' + p.ab : ''})`).join(' then ')}`)
    console.log(`about ${mins} min`)
    return
  }
  if (process.platform !== 'win32') throw new S.StageRefusal('the harness runs on the Windows test VM')
  const stage = S.resolveStage(process.env)
  if (!opts.prepare) S.ensureMarker(stage.ROOT, { create: false })
  if (appProcesses()) throw new S.StageRefusal('an app instance is already running: one app at a time')
  for (const p of [PORT, INSPECT]) { const o = S.portOwnerPid(p); if (o !== null) throw new S.StageRefusal(`port ${p} is in use (pid ${o})`) }
  if (opts.prepare) {
    if (!opts.appVersion) throw new S.StageRefusal('--prepare needs --app-version (the installed build)')
    const args = ['--app-version', opts.appVersion, '--dom-terminals']
    seed(args)
  }
  OUT = path.resolve(opts.out || path.join(stage.ROOT, 'perf-out', stamp()))
  fs.mkdirSync(OUT, { recursive: true })
  record = { started: Date.now(), options: opts, ports: { cdp: PORT, inspect: INSPECT }, stageRoot: stage.ROOT, harnessPids: [process.pid], plan: runs, runs: [] }
  save()
  log(`perf matrix: ${runs.length} runs, about ${mins} min; results in ${OUT}`)
  try {
    if (opts.prepare) {
      log('prepare: first start and stop, then re-seed')
      const since = Date.now()
      launch(['start', '--port', String(PORT)])
      await sleep(15000)
      launch(['stop'])
      await waitClean(stage, since)
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
