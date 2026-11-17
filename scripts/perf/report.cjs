// Performance harness (scripts/perf, see README.md): turn run-matrix.cjs results folders into the
// per-service tables. Reads only those folders; writes report.md and report.json into each, and prints
// them. Runs anywhere (it starts nothing), so the folders can be copied off the VM first.
//
//   node scripts/perf/report.cjs <results folder> [<results folder> ...] [--service-map <file>] [--functions a,b]
//
// With two or more folders (the same grid run again), the first folder's report.md also gets each
// cell's spread across the runs, which is the noise any difference between cells is read against.
// --functions names functions whose self and inclusive time each CPU profile reports (B2 judges
// `RateLimitBar` self time and B3 `handleSelectionChanged` inclusive time, in a 90 s renderer
// profile: run the grid with --profile 90 for those).
//
// CPU comes from the sampler's cycle counts for every process (QueryProcessCycleTime, charged
// exactly), mean and p95 alike. A cell without them is marked: `a` when it is the app's own figure
// (app.getAppMetrics between the window's two snapshots, its own processes only), `w` when it is
// Windows' tick-charged time, which undercounts processes that run in short timer-driven bursts and
// is a lower bound (lib/aggregate.cjs has the measured case). A results folder from before the
// sampler read cycles shows every cell marked.
'use strict'

const fs = require('fs')
const path = require('path')
const A = require('./lib/aggregate.cjs')
const C = require('./lib/classify-process.cjs')

/** Which group a role's CPU adds to: the app's own processes (with the session helper and the
 *  vision browser it starts), the terminals the sessions run in (shell, console host, CLI and its
 *  probes), or neither (confounders and the harness itself). */
function groupOf(role) {
  if (/^(main|renderer|renderer-other|gpu|network|utility.*|crashpad|helper|helper-hold|vision-chrome)$/.test(role)) return 'app'
  if (/^(pty-host|shell|fake-claude|node)$/.test(role)) return 'terminals'
  return null
}
/** The roles the app's own process list covers. */
const isElectronRole = (role) => /^(main|renderer|renderer-other|gpu|network|utility.*)$/.test(role)
const ROLE_ORDER = Object.keys(C.ROLE_LABEL)
const roleLabel = (r) => C.ROLE_LABEL[r] || r
const byRoleOrder = (a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)
const ok = (x) => (x && !x.error ? x : null)

/** What classifies a window's processes: the app's own lists from its snapshots, its Services rows. */
function contextOf(w, record, extra = []) {
  const page = (x) => (x && x.page && Array.isArray(x.page.services) ? x.page.services : [])
  const snaps = [ok(w.mainStart), ok(w.mainEnd), ...extra.map(ok)].filter(Boolean)
  return C.contextFrom({
    appMetrics: snaps.flatMap((s) => s.appMetrics || []),
    webContents: snaps.flatMap((s) => s.webContents || []),
    services: w.renderer ? [...page(w.renderer.start), ...page(w.renderer.end)] : [],
    stageRoot: record.stageRoot,
  })
}

/** A window's process rows: each one's role, or null when it is neither in the app's process tree
 *  nor a process always reported: Defender, WMI, the harness, and the staging root's own session
 *  helper and vision browser (their command lines name the root; another install's are not ours). */
function roleFunction(parsed, ctx, record, runRec) {
  const harness = new Set([...(record.harnessPids || []), parsed.header && parsed.header.samplerPid].filter(Boolean))
  const c = { ...ctx, harnessPids: harness }
  const procs = new Map()
  for (const r of parsed.rows) {
    const k = A.procKey(r)
    if (!procs.has(k)) procs.set(k, { ...r })
    else if (typeof r.cmd === 'string') procs.get(k).cmd = r.cmd
  }
  const list = [...procs.values()]
  const mainPid = C.findMainPid(list, runRec && runRec.appPid)
  const tree = mainPid ? C.processTree(list, mainPid) : new Set()
  const root = String(record.stageRoot || '').toLowerCase()
  const always = /^(msmpeng\.exe|wmiprvse\.exe)$/i
  return (row) => {
    const role = C.classifyProcess(row, c)
    if (role === 'harness' || tree.has(row.pid)) return role
    if (always.test(row.name)) return role
    if ((role === 'vision-chrome' || role === 'helper' || role === 'helper-hold') && root && String(row.cmd || '').toLowerCase().includes(root)) return role
    return null
  }
}

/** The samples of [from, to] by role. Only the range's own ticks: a sample file another run appended
 *  to must not add that run's processes as zeros. CPU from the cycle counts where the header gives
 *  the counter's rate. */
function analyseSamples(parsed, ctx, record, runRec, range) {
  const roleOf = roleFunction(parsed, ctx, record, runRec)
  const cyclesPerSec = parsed.header && Number(parsed.header.cyclesPerSec) > 0 ? Number(parsed.header.cyclesPerSec) : null
  return { header: parsed.header, roles: A.summarizeByRole(parsed.rows, { ...range, roleOf, cyclesPerSec }).sort(byRoleOrder) }
}

/** CPU per role from the app's own figures between two snapshots, as a plain object; empty when
 *  either snapshot failed. */
function appCpu(a, b, ctx) {
  if (!ok(a) || !ok(b)) return {}
  return Object.fromEntries(A.appCpuByRole(a, b, (m) => C.roleOfAppMetric(m, ctx)))
}

/** The CPU a cell shows for a role, and where it came from: the sampler's cycle counts ('cycles'),
 *  the app's own figure for its own processes ('app'), or Windows' tick-charged time ('windows', a
 *  lower bound). { value: null, source: null } when there is none. */
function cpuOf(cell, role) {
  const r = (cell.roles || []).find((x) => x.role === role)
  if (r && r.cpuSource === 'cycles' && Number.isFinite(r.cpuMean)) return { value: r.cpuMean, source: 'cycles' }
  const app = cell.appCpu && Number.isFinite(cell.appCpu[role]) ? cell.appCpu[role] : null
  if (isElectronRole(role) && app !== null) return { value: app, source: 'app' }
  if (r && Number.isFinite(r.cpuMean)) return { value: r.cpuMean, source: 'windows' }
  if (app !== null) return { value: app, source: 'app' }
  return { value: null, source: null }
}

/** A group's CPU: the sum over its roles, each role once (sampled or only in the app's figures), and
 *  the sources the sum is made of. */
function groupCpu(cell, group) {
  const roles = new Set((cell.roles || []).map((r) => r.role).filter((r) => groupOf(r) === group))
  for (const r of Object.keys(cell.appCpu || {})) if (groupOf(r) === group) roles.add(r)
  let value = 0
  const sources = new Set()
  for (const r of roles) {
    const c = cpuOf(cell, r)
    if (c.value !== null) { value += c.value; sources.add(c.source) }
  }
  return { value, sources: [...sources].sort() }
}

const MARK = Object.freeze({ cycles: '', app: ' a', windows: ' w' })
/** A CPU cell for a table: the value, then its source's mark when it is not the cycle counts. */
const markCpu = (c, d = 2) => (c.value === null ? '-' : A.fixed(c.value, d) + (MARK[c.source] || ''))
const markGroup = (g, d = 2) => A.fixed(g.value, d) + g.sources.map((s) => MARK[s] || '').join('')
const CPU_NOTE = 'Unmarked CPU is from the sampler\'s cycle counts (QueryProcessCycleTime), mean and p95 alike. `a`: the app\'s own figure (app.getAppMetrics), where the samples had no cycle count. `w`: Windows\' tick-charged time, a lower bound for processes that run in short timer-driven bursts.'

/** The runs that failed, and the planned runs that never started (the grid was cut short). */
function failedRuns(record) {
  const out = (record.runs || []).filter((r) => (r.errors && r.errors.length) || !(r.windows && r.windows.length))
    .map((r) => ({ id: r.id, n: r.n, off: r.off, windows: (r.windows || []).length, errors: r.errors || [] }))
  const ran = new Set((record.runs || []).map((r) => r.id))
  for (const p of record.plan || []) if (!ran.has(p.id)) out.push({ id: p.id, n: p.n, off: p.off, windows: 0, errors: ['not run'] })
  return out
}

/**
 * The Tokenomics worker's full sweeps expected in [from, to]. It walks every transcript at start-up,
 * then again once 5 minutes have passed since the last walk began (checked every 5 s), so walk k
 * begins about k x 5 min after the app started: no earlier than appStart + k x 300 s, no later than
 * that plus the start-up (up to 20 s) and 5 s per walk. 'in' when that whole span is inside the
 * window, 'edge' when it straddles an end. An estimate from the schedule: the app does not report
 * when a walk ran.
 */
function expectedSweeps(appStartedAt, from, to, { periodMs = 300000, startupMs = 20000, perWalkMs = 5000 } = {}) {
  const out = []
  if (!Number.isFinite(appStartedAt) || !(to > from)) return out
  for (let k = 1; appStartedAt + k * periodMs <= to; k++) {
    const earliest = appStartedAt + k * periodMs
    const latest = earliest + startupMs + k * perWalkMs
    if (latest < from) continue
    out.push({ k, earliest, latest, where: earliest >= from && latest <= to ? 'in' : 'edge' })
  }
  return out
}
const sweepWord = (s) => (!s.length ? 'no' : s.some((x) => x.where === 'in') ? 'yes' : 'edge')

/**
 * The A/B/A's parts: as is, with prefers-reduced-motion: reduce, and as is again (a record from
 * before the third part has two). Each part's CPU from the samples in its own time range (an
 * interval that spans a switch belongs to neither part) and from the app's figures between the
 * marks around it; its renderer figures from its own Performance readings. The reduced part is
 * valid only when the page took the emulation.
 */
function abParts(ab, parsed, ctx, record, runRec) {
  const r = ab.result || {}
  const m = r.marks || {}
  const part = (name, from, to, a, b, metrics) => {
    const cell = { roles: analyseSamples(parsed, ctx, record, runRec, { from, to }).roles, appCpu: appCpu(a, b, ctx) }
    return {
      name, from, to,
      renderer: metrics && metrics.start && metrics.end ? A.perfMetricsDelta(metrics.start.metrics, metrics.end.metrics) : null,
      rendererCpu: cpuOf(cell, 'renderer'), gpuCpu: cpuOf(cell, 'gpu'), mainCpu: cpuOf(cell, 'main'),
      valid: name !== 'reduced' || r.reduceMatched !== false,
    }
  }
  const parts = [part('as is', ab.from, ab.switchAt, m.start, m.switch, r.asIs)]
  if (r.asIs2 && ab.backAt) {
    parts.push(part('reduced', ab.switchAt, ab.backAt, m.switch, m.back, r.reduced))
    parts.push(part('as is again', ab.backAt, ab.to, m.back, m.end, r.asIs2))
  } else {
    parts.push(part('reduced', ab.switchAt, ab.to, m.switch, m.end, r.reduced))
  }
  return parts
}

/** The ablation windows (kind 'ablation', or an older record's '-off-' tags): the all-on windows,
 *  their mean and spread (max - min; null with one), and each switched-off window's saving against
 *  that mean, with whether the saving is larger than the spread. Null without an all-on window. */
function ablationSummary(cells) {
  const abl = cells.filter((c) => c.kind === 'ablation' || (!c.kind && /-off-/.test(c.tag)))
  const refs = abl.filter((c) => c.off === 'none')
  if (!refs.length) return null
  const totals = refs.map((c) => groupCpu(c, 'app').value)
  const refMean = A.mean(totals)
  const spread = totals.length > 1 ? Math.max(...totals) - Math.min(...totals) : null
  const rows = abl.map((c) => {
    const total = groupCpu(c, 'app')
    const saved = c.off === 'none' ? null : refMean - total.value
    return { cell: c, total, saved, aboveNoise: saved === null || spread === null ? null : Math.abs(saved) > spread }
  })
  return { refs, refMean, spread, rows }
}

/** Main's CPU profile split: services, garbage collection, native ('(program)'), not attributed, as
 *  percents of the JS thread's busy time. */
function mainProfileSplit(p) {
  const busy = p.totalMs - p.idleMs
  const services = Object.values(p.byService || {}).reduce((s, v) => s + v, 0)
  const pct = (v) => (busy > 0 ? (v / busy) * 100 : null)
  return { busyMs: busy, servicesPct: pct(services), gcPct: pct(p.gcMs), programPct: pct(p.programMs), unattributedPct: pct(p.unattributedMs) }
}

/** The rows a cell is summarised by in the repeat table: the two totals, then each role. */
function cellFigures(cell) {
  const out = { 'App total': groupCpu(cell, 'app').value, 'Terminals total': groupCpu(cell, 'terminals').value }
  for (const r of cell.roles || []) if (groupOf(r.role)) out[roleLabel(r.role)] = cpuOf(cell, r.role).value
  for (const r of Object.keys(cell.appCpu || {})) if (groupOf(r) && !(roleLabel(r) in out)) out[roleLabel(r)] = cpuOf(cell, r).value
  return out
}

/** Per window tag and row, across several runs of the same grid (each a list of cells): every run's
 *  value, their mean and their spread (max - min). Only tags every run has. */
function repeatSpread(runs) {
  const tags = (runs[0] || []).map((c) => c.tag).filter((t) => runs.every((cells) => cells.some((c) => c.tag === t)))
  const rows = new Map()
  for (const tag of tags) {
    const figs = runs.map((cells) => cellFigures(cells.find((c) => c.tag === tag)))
    for (const label of Object.keys(figs[0])) {
      const values = figs.map((f) => f[label]).filter(Number.isFinite)
      if (!rows.has(label)) rows.set(label, {})
      rows.get(label)[tag] = { values, mean: A.mean(values), spread: values.length > 1 ? Math.max(...values) - Math.min(...values) : null }
    }
  }
  return { tags, rows: [...rows.entries()].map(([label, byTag]) => ({ label, byTag })) }
}

/** A time as ms since the epoch: a number as it is, a date string parsed (an older record). */
const msOf = (v) => (typeof v === 'number' ? v : Date.parse(v))

/** One results folder as cells, profiles and A/Bs (nothing written). */
function analyseFolder(dir, serviceMap, { functions = [] } = {}) {
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'))
  const sourcesFile = path.join(dir, 'main-sources.json')
  const topOf = fs.existsSync(sourcesFile) ? A.topLevelNamer(JSON.parse(fs.readFileSync(sourcesFile, 'utf8'))) : null
  const json = {
    dir, appVersion: record.options && record.options.appVersion, checkout: record.checkout || null, started: record.started, finished: record.finished,
    aborted: record.aborted || null, header: null, windows: [], profiles: [], ab: [], failed: failedRuns(record), cleanup: [],
  }
  for (const runRec of record.runs) {
    if (runRec.stopWarning || (runRec.leftovers && runRec.leftovers.length)) json.cleanup.push({ id: runRec.id, stopWarning: runRec.stopWarning || null, leftovers: runRec.leftovers || [] })
    for (const wref of runRec.windows) {
      const w = JSON.parse(fs.readFileSync(path.join(dir, wref.file), 'utf8'))
      const ctx = contextOf(w, record)
      const parsed = A.parseSampleText(fs.readFileSync(path.join(dir, w.samples), 'utf8'))
      const a = analyseSamples(parsed, ctx, record, runRec, { from: w.from, to: w.to })
      json.header = json.header || a.header
      const cli = a.roles.find((r) => r.role === 'fake-claude') || {}
      const queryMs = A.mean(parsed.ticks.filter((t) => t.t >= w.from && t.t <= w.to).map((t) => Number(t.queryMs)))
      json.windows.push({
        tag: w.tag, kind: w.kind || null, n: w.n, mode: w.mode, off: w.off, from: w.from, to: w.to,
        sessionsLive: { min: cli.minConcurrent || 0, max: cli.maxConcurrent || 0 },
        roles: a.roles, appCpu: appCpu(w.mainStart, w.mainEnd, ctx), renderer: rendererDelta(w), services: serviceRows(w),
        sweeps: expectedSweeps(msOf(w.appStartedAt !== undefined ? w.appStartedAt : runRec.appStartedAt), w.from, w.to),
        queryMs, cyclesPerSec: (a.header && a.header.cyclesPerSec) || null,
        resources: (ok(w.mainEnd) && w.mainEnd.resources) || {}, mainMem: ok(w.mainEnd) && w.mainEnd.mem,
        page: w.renderer && w.renderer.end && w.renderer.end.page ? { terminals: w.renderer.end.page.terminals, runningTab: w.renderer.end.page.runningTab } : null,
        errors: runRec.errors,
      })
    }
    for (const p of runRec.profiles) {
      const readProfile = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      const mainProfile = p.main ? readProfile(p.main) : null
      const rendererProfile = p.renderer ? readProfile(p.renderer) : null
      const main = mainProfile ? A.attributeProfile(mainProfile, serviceMap, { topOf }) : null
      const renderer = rendererProfile ? A.attributeProfile(rendererProfile, { services: [] }, {}) : null
      const busyPct = (x) => (x && x.totalMs > 0 ? ((x.totalMs - x.idleMs) / x.totalMs) * 100 : null)
      let mainProcessCpu = null
      if (p.marks && fs.existsSync(path.join(dir, p.marks))) {
        const marks = JSON.parse(fs.readFileSync(path.join(dir, p.marks), 'utf8'))
        const cpu = appCpu(marks.mainStart, marks.mainEnd, C.contextFrom({}))
        mainProcessCpu = Number.isFinite(cpu.main) ? cpu.main : null
      }
      json.profiles.push({
        tag: p.tag, mainBusyPct: busyPct(main), rendererBusyPct: busyPct(renderer), mainProcessCpu, main, renderer,
        functions: functions.length ? { main: mainProfile ? A.functionTimes(mainProfile, functions) : null, renderer: rendererProfile ? A.functionTimes(rendererProfile, functions) : null } : null,
      })
    }
    for (const abRef of runRec.ab) {
      const ab = JSON.parse(fs.readFileSync(path.join(dir, abRef.file), 'utf8'))
      if (!ab.result || ab.result.error || !ab.switchAt) { json.ab.push({ tag: ab.tag, error: (ab.result && ab.result.error) || 'no switch time' }); continue }
      const w = JSON.parse(fs.readFileSync(path.join(dir, `window-${ab.tag}.json`), 'utf8'))
      const m = ab.result.marks || {}
      const ctx = contextOf(w, record, [m.start, m.switch, m.back, m.end])
      const parsed = A.parseSampleText(fs.readFileSync(path.join(dir, ab.samples), 'utf8'))
      json.ab.push({ tag: ab.tag, reduceMatched: ab.result.reduceMatched, parts: abParts(ab, parsed, ctx, record, runRec) })
    }
  }
  return { record, json }
}

function rendererDelta(w) {
  const r = w.renderer
  if (!r || r.error || !r.start || !r.end) return null
  return A.perfMetricsDelta(r.start.metrics, r.end.metrics)
}

function serviceRows(w) {
  const s = w.renderer && w.renderer.end && w.renderer.end.page && w.renderer.end.page.services
  const s0 = w.renderer && w.renderer.start && w.renderer.start.page && w.renderer.start.page.services
  if (!Array.isArray(s)) return []
  const start = new Map((Array.isArray(s0) ? s0 : []).map((x) => [x.id, x]))
  const wall = (w.renderer.end.t - w.renderer.start.t) / 1000
  return s.map((x) => {
    const before = start.get(x.id)
    const files = (y) => (y && y.measured && Number.isFinite(y.measured.filesTouchedLastScan) ? y.measured.filesTouchedLastScan : null)
    return {
      id: x.id, state: x.state, host: x.host, pid: x.pid,
      eventsPerSec: before && Number.isFinite(x.eventsTotal) && Number.isFinite(before.eventsTotal) ? (x.eventsTotal - before.eventsTotal) / wall : null,
      measuredCpu: x.measured && Number.isFinite(x.measured.cpuPercent) ? x.measured.cpuPercent : null,
      filesLastScanStart: files(before), filesLastScan: files(x),
      stalls: x.mainLoopStallsLastMin,
    }
  })
}

/** report.md for one folder. */
function renderFolder(record, json, serviceMap, { functions = [] } = {}) {
  const md = []
  const f0 = (v) => A.fixed(v, 0)
  const f1 = (v) => A.fixed(v, 1)
  const f2 = (v) => A.fixed(v, 2)
  const h = json.header || {}
  const co = json.checkout || {}
  md.push(`# Service overhead: AI Code Conductor ${json.appVersion || '(version not recorded)'}`)
  md.push('')
  md.push(`Measured ${new Date(record.started).toISOString().slice(0, 16).replace('T', ' ')} UTC on the Windows test VM: ${h.logicalCpus || '?'} logical CPUs, ${h.memMb || '?'} MB, ${h.os || '?'}. Harness at commit ${co.commit || '(not recorded)'}${co.changed ? ' with local changes' : ''}. The installed app ran in session 0 from SSH, on a README staging root, with the fake Claude CLI (scripts/readme-shots/stage/fake-claude.js).${json.aborted ? ` The run was cut short: ${json.aborted}.` : ''}`)
  md.push('')
  md.push(`CPU is a percent of ONE core (100 = one core busy all the time; the VM has ${h.logicalCpus || '?'}), the mean over each window, summed over every process of the row. ${CPU_NOTE} The sampler reads every ${h.intervalSec || '?'} s; its cycle counter ran at ${h.cyclesPerSec ? f0(h.cyclesPerSec / 1e6) + ' million cycles per second' : '(not measured: an older sampler)'}${h.mhz ? ` (Windows reports ${h.mhz} MHz)` : ''}. Idle: the fake CLIs rest at their prompt. Busy: each redraws a spinner every 120 ms and writes its status file every 2 s, and one transcript line per session is appended every ${(record.options && record.options.sidecarMs) || '?'} ms.`)
  md.push('')
  md.push('Caveats: session 0 forces DOM terminals (`--dom-terminals`) and the VM has no GPU (software GL), so renderer and GPU figures are not comparable to a desktop with WebGL terminals. The fake CLI is not Claude Code (no hook events, its own output rate), so read the numbers as relative between windows, not absolute. Defender is on but the VM does not reproduce desktop file churn; I/O ops/s (read + write operations, which include pipe and socket I/O, not only files) is the proxy.')
  md.push('')

  if (json.failed.length) {
    md.push('## Runs that failed')
    md.push('')
    md.push(A.markdownTable([
      { label: 'Run', align: 'left', get: (r) => r.id },
      { label: 'Windows measured', get: (r) => r.windows },
      { label: 'Errors', align: 'left', get: (r) => r.errors.join('; ') || '(none recorded)' },
    ], json.failed))
    md.push('')
  }

  const cells = json.windows
  const roleSet = new Set()
  for (const cell of cells) { for (const r of cell.roles) roleSet.add(r.role); for (const r of Object.keys(cell.appCpu || {})) roleSet.add(r) }
  const roles = [...roleSet].sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b))
  const profileOf = (tag) => json.profiles.find((p) => p.tag === tag) || {}
  md.push('## CPU per process (mean, % of one core)')
  md.push('')
  const pivotCols = [{ label: 'Process', align: 'left', get: (r) => r.label }, ...cells.map((cell) => ({ label: cell.tag, get: (r) => r[cell.tag] }))]
  const row = (label, f) => ({ label, ...Object.fromEntries(cells.map((cell) => [cell.tag, f(cell)])) })
  const pivotRows = [
    row('**App total (Electron, helper, vision)**', (cell) => markGroup(groupCpu(cell, 'app'))),
    row('**Terminals total (shell, console host, CLI)**', (cell) => markGroup(groupCpu(cell, 'terminals'))),
    ...roles.map((role) => row(roleLabel(role), (cell) => markCpu(cpuOf(cell, role)))),
    row('Sessions live (CLIs running at once, fewest to most)', (cell) => (cell.sessionsLive.min === cell.sessionsLive.max ? String(cell.sessionsLive.min) : `${cell.sessionsLive.min} to ${cell.sessionsLive.max}`)),
    row('Main JS thread busy % (CPU profile, where taken)', (cell) => f1(profileOf(cell.tag).mainBusyPct)),
    row('Renderer main thread busy % (CDP task time)', (cell) => f1(cell.renderer && cell.renderer.taskBusyPct)),
    row('Tokenomics full sweep in the window (estimated)', (cell) => sweepWord(cell.sweeps)),
  ]
  md.push(A.markdownTable(pivotCols, pivotRows))
  md.push('')
  md.push(CPU_NOTE + ' The sweep row is estimated from the worker\'s 5-minute schedule and the app\'s start (yes: inside the window; edge: it may fall at either end).')
  md.push('')

  md.push('## Each window')
  for (const cell of cells) {
    md.push('')
    md.push(`### ${cell.tag} (N=${cell.n}, ${cell.mode}${cell.off !== 'none' ? `, ${cell.off} off` : ''})`)
    md.push('')
    const rowsOf = [...cell.roles]
    for (const r of Object.keys(cell.appCpu || {})) if (!rowsOf.some((x) => x.role === r)) rowsOf.push({ role: r })
    rowsOf.sort(byRoleOrder)
    md.push(A.markdownTable([
      { label: 'Process', align: 'left', get: (r) => roleLabel(r.role) },
      { label: 'Count', get: (r) => r.processes },
      { label: 'CPU %', get: (r) => markCpu(cpuOf(cell, r.role)) },
      { label: 'p95 %', get: (r) => (Number.isFinite(r.cpuP95) ? f2(r.cpuP95) + (r.cpuSource === 'cycles' ? '' : MARK.windows) : '-') },
      { label: 'App figure %', get: (r) => (isElectronRole(r.role) && cell.appCpu ? f2(cell.appCpu[r.role]) : '') },
      { label: 'Windows tick %', get: (r) => f2(r.cpuTickMean) },
      { label: 'Private MB', get: (r) => f0(r.privateMb) },
      { label: 'I/O ops/s', get: (r) => f1(r.ioOpsPerSec) },
      { label: 'Handles', get: (r) => f0(r.handles) },
      { label: 'Threads', get: (r) => f0(r.threads) },
    ], rowsOf))
    const r = cell.renderer
    const notes = []
    if (r) notes.push(`renderer: main thread busy ${f1(r.taskBusyPct)} % (script ${f1(r.scriptBusyPct)} %), ${f1(r.layoutsPerSec)} layouts/s, ${f1(r.recalcStylesPerSec)} style recalcs/s, JS heap ${f0(r.heapMb)} MB, ${f0(r.nodes)} DOM nodes`)
    if (cell.page) notes.push(`page: ${cell.page.terminals} terminals, Running tab "${cell.page.runningTab}"`)
    if (cell.mainMem) notes.push(`main JS heap ${f0(cell.mainMem.heapUsedMb)} MB`)
    notes.push(`Tokenomics full sweep: ${cell.sweeps.length ? cell.sweeps.map((s) => `walk ${s.k} ${s.where === 'in' ? 'inside' : 'possibly at an end'}, ${f0((s.earliest - cell.from) / 1000)} to ${f0((s.latest - cell.from) / 1000)} s into the window`).join('; ') : 'none expected'}`)
    if (Number.isFinite(cell.queryMs)) notes.push(`the sampler's process query took ${f0(cell.queryMs)} ms on average (each row is stamped at its middle)`)
    md.push('')
    md.push(notes.join('; ') + '.')
    const svc = cell.services.filter((s) => s.id)
    if (svc.length) {
      md.push('')
      md.push(A.markdownTable([
        { label: 'Services row', align: 'left', get: (s) => s.id },
        { label: 'State', align: 'left', get: (s) => s.state },
        { label: 'Host', align: 'left', get: (s) => s.host },
        { label: 'Events/s', get: (s) => A.fixed(s.eventsPerSec, 2) },
        { label: 'Own CPU figure %', get: (s) => f1(s.measuredCpu) },
        { label: 'Files last scan (start, end)', get: (s) => (s.filesLastScan === null && s.filesLastScanStart === null ? '-' : `${s.filesLastScanStart === null ? '-' : s.filesLastScanStart}, ${s.filesLastScan === null ? '-' : s.filesLastScan}`) },
        { label: 'Main stalls/min', get: (s) => s.stalls },
      ], svc))
    }
    if (cell.errors && cell.errors.length) { md.push(''); md.push('Errors in this run: ' + cell.errors.join('; ')) }
  }

  if (json.profiles.length) {
    md.push('')
    md.push('## Main process by service (CPU profile)')
    md.push('')
    md.push('The profile covers main\'s JavaScript thread only. The rest of the main process\'s CPU (Chromium\'s browser-process threads for I/O, IPC and the thread pool, and any Node worker threads) is not attributed by this harness: the heading of each profile gives the whole process\'s figure next to the thread\'s.')
    const label = (id) => ((serviceMap.services || []).find((s) => s.id === id) || {}).label || id
    for (const p of json.profiles) {
      if (!p.main) continue
      const busy = p.main.totalMs - p.main.idleMs
      const secs = p.main.totalMs / 1000
      const split = mainProfileSplit(p.main)
      md.push('')
      md.push(`### ${p.tag}: main process ${f2(p.mainProcessCpu)} % of a core (app figure over the profile); its JS thread ${f1(p.mainBusyPct)} % busy (${f1(busy / secs)} ms per second)`)
      md.push('')
      md.push(`Of the JS thread's busy time: services ${f1(split.servicesPct)} %, garbage collection ${f1(split.gcPct)} %, native outside JS ${f1(split.programPct)} %, not attributed ${f1(split.unattributedPct)} %.`)
      md.push('')
      const rows = Object.entries(p.main.byService).map(([id, ms]) => ({ id, ms }))
      rows.push({ id: '(not attributed)', ms: p.main.unattributedMs }, { id: '(garbage collection)', ms: p.main.gcMs }, { id: '(program: native, outside JS)', ms: p.main.programMs })
      rows.sort((a, b) => b.ms - a.ms)
      md.push(A.markdownTable([
        { label: 'Service', align: 'left', get: (x) => label(x.id) },
        { label: 'ms per s', get: (x) => A.fixed(x.ms / secs, 2) },
        { label: '% of the JS thread busy', get: (x) => f1(busy > 0 ? (x.ms / busy) * 100 : null) },
      ], rows))
      md.push('')
      md.push('Top frames not attributed: ' + (p.main.topUnattributed.slice(0, 8).map((f) => `${f.frame} (${f0(f.ms)} ms)`).join('; ') || 'none') + '.')
    }
    md.push('')
    md.push('## Renderer CPU profile: top self time')
    for (const p of json.profiles) {
      if (!p.renderer) continue
      const secs = p.renderer.totalMs / 1000
      md.push('')
      md.push(`### ${p.tag}: busy ${f1(p.rendererBusyPct)} % of the thread (GC ${A.fixed(p.renderer.gcMs / secs, 1)} ms/s, native ${A.fixed(p.renderer.programMs / secs, 1)} ms/s)`)
      md.push('')
      md.push(A.markdownTable([
        { label: 'Frame', align: 'left', get: (x) => x.frame },
        { label: 'ms per s', get: (x) => A.fixed(x.ms / secs, 2) },
      ], p.renderer.topSelf.slice(0, 12)))
    }
    if (functions.length) {
      md.push('')
      md.push(`## Named functions (--functions)`)
      md.push('')
      const fnRows = []
      for (const p of json.profiles) for (const which of ['renderer', 'main']) {
        const t = p.functions && p.functions[which]
        if (!t) continue
        for (const name of functions) fnRows.push({ tag: p.tag, which, name, secs: t.totalMs / 1000, ...t.byName[name] })
      }
      md.push(A.markdownTable([
        { label: 'Profile', align: 'left', get: (x) => `${x.tag} ${x.which} (${f0(x.secs)} s)` },
        { label: 'Function', align: 'left', get: (x) => x.name },
        { label: 'Self ms', get: (x) => f1(x.selfMs) },
        { label: 'Inclusive ms', get: (x) => f1(x.inclusiveMs) },
        { label: 'Self ms per s', get: (x) => f2(x.secs > 0 ? x.selfMs / x.secs : null) },
        { label: 'Inclusive ms per s', get: (x) => f2(x.secs > 0 ? x.inclusiveMs / x.secs : null) },
      ], fnRows))
    }
  }

  if (json.ab.length) {
    md.push('')
    md.push('## Always-on animations: prefers-reduced-motion A/B/A')
    md.push('')
    const abRows = json.ab.filter((x) => !x.error).flatMap((x) => x.parts.map((p) => ({ tag: x.tag, ...p })))
    md.push(A.markdownTable([
      { label: 'Window', align: 'left', get: (x) => x.tag },
      { label: 'Part', align: 'left', get: (x) => x.name + (x.valid ? '' : ' (not valid: the page did not take reduce)') },
      { label: 'Renderer CPU %', get: (x) => markCpu(x.rendererCpu) },
      { label: 'GPU CPU %', get: (x) => markCpu(x.gpuCpu) },
      { label: 'Main CPU %', get: (x) => markCpu(x.mainCpu) },
      { label: 'Renderer thread busy %', get: (x) => f1(x.renderer && x.renderer.taskBusyPct) },
      { label: 'Style recalcs/s', get: (x) => f1(x.renderer && x.renderer.recalcStylesPerSec) },
    ], abRows))
    md.push('')
    md.push('Each part is cut by its own times; a sampler interval that spans a switch belongs to neither part. The two as-is parts bracket the reduced one, so drift over the parts shows as a difference between them.')
    for (const x of json.ab.filter((y) => y.error)) md.push(`\n${x.tag}: A/B failed (${x.error}).`)
  }

  const abl = ablationSummary(cells)
  if (abl) {
    md.push('')
    md.push(`## Ablations (N=${abl.refs[0].n} busy, one service switched off per run)`)
    md.push('')
    md.push(A.markdownTable([
      { label: 'Run', align: 'left', get: (x) => (x.cell.off === 'none' ? `all services on (${x.cell.tag})` : `${x.cell.off} off`) },
      { label: 'App total CPU %', get: (x) => markGroup(x.total) },
      { label: 'Saved vs all on', get: (x) => (x.saved === null ? '-' : f2(x.saved)) },
      { label: 'Larger than the all-on spread', align: 'left', get: (x) => (x.aboveNoise === null ? '-' : x.aboveNoise ? 'yes' : 'no') },
      { label: 'Main %', get: (x) => markCpu(cpuOf(x.cell, 'main')) },
      { label: 'Renderer %', get: (x) => markCpu(cpuOf(x.cell, 'renderer')) },
      { label: 'GPU %', get: (x) => markCpu(cpuOf(x.cell, 'gpu')) },
    ], abl.rows))
    md.push('')
    md.push(abl.spread === null
      ? 'One all-on window only: there is no noise figure to read the savings against.'
      : `The all-on windows average ${f2(abl.refMean)} and differ by ${f2(abl.spread)}: a saving no larger than that is within the noise.`)
  }

  if (json.cleanup.length) {
    md.push('')
    md.push('## Clean-up between runs')
    md.push('')
    md.push(A.markdownTable([
      { label: 'Run', align: 'left', get: (c) => c.id },
      { label: 'launch.js stop', align: 'left', get: (c) => c.stopWarning || 'ended the app' },
      { label: 'Left after the stop and ended by the harness', align: 'left', get: (c) => c.leftovers.map((l) => `${l.name} ${l.pid} (${l.outcome})`).join(', ') || 'none' },
    ], json.cleanup))
  }
  return md
}

/** The spread table for several folders' cells. */
function renderSpread(folders) {
  const sp = repeatSpread(folders.map((f) => f.json.windows))
  const md = ['', `## The same grid run ${folders.length} times: mean and spread per cell`, '']
  md.push(`Each cell is the mean of the runs (% of one core), then in brackets the spread between them (largest minus smallest), which is the noise a difference between cells is read against. Runs: ${folders.map((f) => `${path.basename(f.json.dir)} at ${(f.json.checkout && f.json.checkout.commit) || '?'}`).join('; ')}.`)
  md.push('')
  md.push(A.markdownTable([
    { label: 'Process', align: 'left', get: (r) => r.label },
    ...sp.tags.map((t) => ({ label: t, get: (r) => (r.byTag[t] ? `${A.fixed(r.byTag[t].mean, 2)} (${A.fixed(r.byTag[t].spread, 2)})` : '-') })),
  ], sp.rows))
  return md
}

function main() {
  const argv = process.argv.slice(2)
  const valueOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
  const dirs = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')))
  if (!dirs.length) dirs.push('.')
  const serviceMap = JSON.parse(fs.readFileSync(valueOf('--service-map') || path.join(__dirname, 'service-map.json'), 'utf8'))
  const functions = String(valueOf('--functions') || '').split(',').map((s) => s.trim()).filter(Boolean)
  const folders = dirs.map((d) => analyseFolder(path.resolve(d), serviceMap, { functions }))
  folders.forEach((f, i) => {
    const md = renderFolder(f.record, f.json, serviceMap, { functions })
    if (i === 0 && folders.length > 1) md.push(...renderSpread(folders))
    fs.writeFileSync(path.join(f.json.dir, 'report.json'), JSON.stringify(f.json, null, 1))
    fs.writeFileSync(path.join(f.json.dir, 'report.md'), md.join('\n') + '\n')
    console.log(md.join('\n'))
  })
}

module.exports = { groupOf, isElectronRole, roleFunction, analyseSamples, appCpu, cpuOf, groupCpu, markCpu, markGroup, failedRuns, expectedSweeps, abParts, ablationSummary, mainProfileSplit, repeatSpread }

if (require.main === module) {
  try { main() } catch (e) { console.error(e && e.stack ? e.stack : e); process.exit(1) }
}
