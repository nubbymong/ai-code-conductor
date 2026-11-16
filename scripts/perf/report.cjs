// Performance harness (scripts/perf, see README.md): turn one run-matrix.cjs results folder into the
// per-service tables. Reads only that folder; writes report.md and report.json into it, and prints
// report.md. Runs anywhere (it starts nothing), so the folder can be copied off the VM first.
//
//   node scripts/perf/report.cjs <results folder> [--service-map <file>]
//
// CPU for the app's own processes (main, renderers, GPU, network, the service workers) is the app's
// own figure (app.getAppMetrics between a window's two snapshots); for everything else, and for the
// p95, it is Windows' (Win32_Process), which is charged at the clock tick and undercounts processes
// that run in short timer-driven bursts (lib/aggregate.cjs has the measured case).
'use strict'

const fs = require('fs')
const path = require('path')
const A = require('./lib/aggregate.cjs')
const C = require('./lib/classify-process.cjs')

/** Which group a role's CPU adds to: the app's own processes (with the session helper and the
 *  vision browser it starts), the terminals the sessions run in (shell, console host, CLI), or
 *  neither (confounders and the harness itself). */
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

/** What classifies this window's processes: the app's own lists from its snapshots, its Services rows. */
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
 *  nor a process always reported (the helper, Defender, WMI, the vision browser, the harness). */
function roleFunction(parsed, ctx, record, runRec) {
  const harness = new Set([...(record.harnessPids || []), parsed.header && parsed.header.samplerPid].filter(Boolean))
  const c = { ...ctx, harnessPids: harness }
  const procs = new Map()
  for (const r of parsed.rows) { const k = A.procKey(r); if (!procs.has(k)) procs.set(k, r); else if (typeof r.cmd === 'string') procs.get(k).cmd = r.cmd }
  const list = [...procs.values()]
  const mainPid = C.findMainPid(list, runRec && runRec.appPid)
  const tree = mainPid ? C.processTree(list, mainPid) : new Set()
  const always = /^(aicc-helper\.exe|msmpeng\.exe|wmiprvse\.exe)$/i
  return (row) => {
    const role = C.classifyProcess(row, c)
    if (role === 'harness' || tree.has(row.pid)) return role
    if (always.test(row.name) || role === 'vision-chrome') return role
    return null
  }
}

/** The Windows samples of [from, to] by role. Only the range's own ticks: a sample file another run
 *  appended to (a reused results folder) must not add that run's processes as zeros. */
function analyseSamples(parsed, ctx, record, runRec, range) {
  const roleOf = roleFunction(parsed, ctx, record, runRec)
  return { header: parsed.header, roles: A.summarizeByRole(parsed.rows, { ...range, roleOf }).sort(byRoleOrder) }
}

/** CPU per role from the app's own figures between two snapshots, as a plain object. */
function appCpu(a, b, ctx) {
  return Object.fromEntries(A.appCpuByRole(ok(a), ok(b), (m) => C.roleOfAppMetric(m, ctx)))
}

/** The CPU the report shows for a role: the app's figure where it has one, else Windows'. */
function cpuOf(cell, role) {
  if (isElectronRole(role) && cell.appCpu && Number.isFinite(cell.appCpu[role])) return cell.appCpu[role]
  const r = cell.roles.find((x) => x.role === role)
  return r ? r.cpuMean : null
}
function groupCpu(cell, group) {
  const roles = cell.roles.map((r) => r.role).filter((r) => groupOf(r) === group)
  for (const r of Object.keys(cell.appCpu || {})) if (groupOf(r) === group && !roles.includes(r)) roles.push(r)
  return roles.reduce((s, r) => s + (cpuOf(cell, r) || 0), 0)
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
  return s.map((x) => ({
    id: x.id, state: x.state, host: x.host, pid: x.pid,
    eventsPerSec: start.has(x.id) && Number.isFinite(x.eventsTotal) && Number.isFinite(start.get(x.id).eventsTotal) ? (x.eventsTotal - start.get(x.id).eventsTotal) / wall : null,
    measuredCpu: x.measured && Number.isFinite(x.measured.cpuPercent) ? x.measured.cpuPercent : null,
    filesLastScan: x.measured && Number.isFinite(x.measured.filesTouchedLastScan) ? x.measured.filesTouchedLastScan : null,
    stalls: x.mainLoopStallsLastMin,
  }))
}

function main() {
  const argv = process.argv.slice(2)
  const dir = path.resolve(argv[0] || '.')
  const mi = argv.indexOf('--service-map')
  const serviceMap = JSON.parse(fs.readFileSync(mi >= 0 ? argv[mi + 1] : path.join(__dirname, 'service-map.json'), 'utf8'))
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'))
  const sourcesFile = path.join(dir, 'main-sources.json')
  const topOf = fs.existsSync(sourcesFile) ? A.topLevelNamer(JSON.parse(fs.readFileSync(sourcesFile, 'utf8'))) : null
  const json = { appVersion: record.options && record.options.appVersion, started: record.started, finished: record.finished, aborted: record.aborted || null, windows: [], profiles: [], ab: [] }
  const md = []
  const f0 = (v) => A.fixed(v, 0)
  const f1 = (v) => A.fixed(v, 1)
  const f2 = (v) => A.fixed(v, 2)
  let header = null

  for (const runRec of record.runs) {
    for (const wref of runRec.windows) {
      const w = JSON.parse(fs.readFileSync(path.join(dir, wref.file), 'utf8'))
      const ctx = contextOf(w, record)
      const parsed = A.parseSampleText(fs.readFileSync(path.join(dir, w.samples), 'utf8'))
      const a = analyseSamples(parsed, ctx, record, runRec, { from: w.from, to: w.to })
      header = header || a.header
      const sessions = (a.roles.find((r) => r.role === 'fake-claude') || {}).processes || 0
      json.windows.push({
        tag: w.tag, n: w.n, mode: w.mode, off: w.off, from: w.from, to: w.to, sessionsLive: sessions,
        roles: a.roles, appCpu: appCpu(w.mainStart, w.mainEnd, ctx), renderer: rendererDelta(w), services: serviceRows(w),
        resources: (ok(w.mainEnd) && w.mainEnd.resources) || {}, mainMem: ok(w.mainEnd) && w.mainEnd.mem,
        page: w.renderer && w.renderer.end && w.renderer.end.page ? { terminals: w.renderer.end.page.terminals, runningTab: w.renderer.end.page.runningTab } : null,
        errors: runRec.errors,
      })
    }
    for (const p of runRec.profiles) {
      const main = p.main ? A.attributeProfile(JSON.parse(fs.readFileSync(path.join(dir, p.main), 'utf8')), serviceMap, { topOf }) : null
      const renderer = p.renderer ? A.attributeProfile(JSON.parse(fs.readFileSync(path.join(dir, p.renderer), 'utf8')), { services: [] }, {}) : null
      const busyPct = (x) => (x && x.totalMs > 0 ? ((x.totalMs - x.idleMs) / x.totalMs) * 100 : null)
      json.profiles.push({ tag: p.tag, mainBusyPct: busyPct(main), rendererBusyPct: busyPct(renderer), main, renderer })
    }
    for (const abRef of runRec.ab) {
      const ab = JSON.parse(fs.readFileSync(path.join(dir, abRef.file), 'utf8'))
      if (!ab.result || ab.result.error || !ab.switchAt) { json.ab.push({ tag: ab.tag, error: (ab.result && ab.result.error) || 'no switch time' }); continue }
      const w = JSON.parse(fs.readFileSync(path.join(dir, `window-${ab.tag}.json`), 'utf8'))
      const m = ab.result.marks || {}
      const ctx = contextOf(w, record, [m.start, m.switch, m.end])
      const parsed = A.parseSampleText(fs.readFileSync(path.join(dir, ab.samples), 'utf8'))
      const half = (from, to, a, b) => {
        const cell = { roles: analyseSamples(parsed, ctx, record, runRec, { from, to }).roles, appCpu: a && b ? appCpu(a, b, ctx) : {} }
        return { rendererCpu: cpuOf(cell, 'renderer'), gpuCpu: cpuOf(cell, 'gpu'), mainCpu: cpuOf(cell, 'main'), source: a && b ? 'app' : 'windows' }
      }
      json.ab.push({
        tag: ab.tag, reduceMatched: ab.result.reduceMatched,
        asIs: { renderer: A.perfMetricsDelta(ab.result.asIs.start.metrics, ab.result.asIs.end.metrics), ...half(ab.from, ab.switchAt, m.start, m.switch) },
        reduced: { renderer: A.perfMetricsDelta(ab.result.reduced.start.metrics, ab.result.reduced.end.metrics), ...half(ab.switchAt, ab.to, m.switch, m.end) },
      })
    }
  }

  // ── the document ─────────────────────────────────────────────────────────
  const h = header || {}
  md.push(`# Service overhead baseline: AI Code Conductor ${json.appVersion || '(version not recorded)'}`)
  md.push('')
  md.push(`Measured ${new Date(record.started).toISOString().slice(0, 16).replace('T', ' ')} UTC on the Windows test VM: ${h.logicalCpus || '?'} logical CPUs, ${h.memMb || '?'} MB, ${h.os || '?'}. The installed app ran in session 0 from SSH, on a README staging root, with the fake Claude CLI (scripts/readme-shots/stage/fake-claude.js).${json.aborted ? ` The run was cut short: ${json.aborted}.` : ''}`)
  md.push('')
  md.push(`CPU is a percent of ONE core (100 = one core busy all the time; the VM has ${h.logicalCpus || '?'}), the mean over each window, summed over every process of the row. For the app's own processes it is the app's figure (app.getAppMetrics); for the others, and every p95, it is Windows' per-process time sampled every ${h.intervalSec || '?'} s, which is charged at the clock tick and undercounts processes that run in short timer-driven bursts. Idle: the fake CLIs rest at their prompt. Busy: each redraws a spinner every 120 ms and writes its status file every 2 s, and one transcript line per session is appended every ${(record.options && record.options.sidecarMs) || '?'} ms.`)
  md.push('')
  md.push('Caveats: session 0 forces DOM terminals (`--dom-terminals`) and the VM has no GPU (software GL), so renderer and GPU figures are not comparable to a desktop with WebGL terminals. The fake CLI is not Claude Code (no hook events, its own output rate), so read the numbers as relative between windows, not absolute. Defender is on but the VM does not reproduce desktop file churn; I/O ops/s (read + write operations, which include pipe and socket I/O, not only files) is the proxy.')
  md.push('')

  const cells = json.windows
  const roleSet = new Set()
  for (const cell of cells) { for (const r of cell.roles) roleSet.add(r.role); for (const r of Object.keys(cell.appCpu || {})) roleSet.add(r) }
  const roles = [...roleSet].sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b))
  const profileOf = (tag) => json.profiles.find((p) => p.tag === tag) || {}
  md.push('## CPU per process (mean, % of one core)')
  md.push('')
  const pivotCols = [{ label: 'Process', align: 'left', get: (r) => r.label }, { label: 'Source', align: 'left', get: (r) => r.source }, ...cells.map((cell) => ({ label: cell.tag, get: (r) => r[cell.tag] }))]
  const row = (label, source, f) => ({ label, source, ...Object.fromEntries(cells.map((cell) => [cell.tag, f(cell)])) })
  const pivotRows = [
    row('**App total (Electron, helper, vision)**', 'both', (cell) => f2(groupCpu(cell, 'app'))),
    row('**Terminals total (shell, console host, fake CLI)**', 'Windows', (cell) => f2(groupCpu(cell, 'terminals'))),
    ...roles.map((role) => row(roleLabel(role), isElectronRole(role) ? 'app' : 'Windows', (cell) => f2(cpuOf(cell, role)))),
    row('Sessions live (fake CLI processes)', '', (cell) => String(cell.sessionsLive)),
    row('Main thread busy % (CPU profile, where taken)', 'profile', (cell) => f1(profileOf(cell.tag).mainBusyPct)),
    row('Renderer main thread busy % (task time)', 'CDP', (cell) => f1(cell.renderer && cell.renderer.taskBusyPct)),
  ]
  md.push(A.markdownTable(pivotCols, pivotRows))
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
      { label: 'CPU % (app)', get: (r) => (isElectronRole(r.role) ? f2(cell.appCpu[r.role]) : '') },
      { label: 'CPU % (Windows)', get: (r) => f2(r.cpuMean) },
      { label: 'p95 % (Windows)', get: (r) => f2(r.cpuP95) },
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
        { label: 'Files last scan', get: (s) => (s.filesLastScan === null ? '-' : s.filesLastScan) },
        { label: 'Main stalls/min', get: (s) => s.stalls },
      ], svc))
    }
    if (cell.errors && cell.errors.length) { md.push(''); md.push('Errors in this run: ' + cell.errors.join('; ')) }
  }

  if (json.profiles.length) {
    md.push('')
    md.push('## Main process by service (CPU profile)')
    const label = (id) => ((serviceMap.services || []).find((s) => s.id === id) || {}).label || id
    for (const p of json.profiles) {
      if (!p.main) continue
      const busy = p.main.totalMs - p.main.idleMs
      const secs = p.main.totalMs / 1000
      md.push('')
      md.push(`### ${p.tag}: main thread busy ${f1(p.mainBusyPct)} %`)
      md.push('')
      const rows = Object.entries(p.main.byService).map(([id, ms]) => ({ id, ms }))
      rows.push({ id: '(not attributed)', ms: p.main.unattributedMs }, { id: '(garbage collection)', ms: p.main.gcMs }, { id: '(program: native, outside JS)', ms: p.main.programMs })
      rows.sort((a, b) => b.ms - a.ms)
      md.push(A.markdownTable([
        { label: 'Service', align: 'left', get: (x) => label(x.id) },
        { label: 'ms per s', get: (x) => A.fixed(x.ms / secs, 2) },
        { label: '% of main busy', get: (x) => f1(busy > 0 ? (x.ms / busy) * 100 : null) },
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
  }

  if (json.ab.length) {
    md.push('')
    md.push('## Always-on animations: prefers-reduced-motion A/B')
    md.push('')
    md.push(A.markdownTable([
      { label: 'Window', align: 'left', get: (x) => x.tag },
      { label: 'CPU source', align: 'left', get: (x) => (x.asIs && x.asIs.source) || '' },
      { label: 'Renderer CPU % as is', get: (x) => f2(x.asIs && x.asIs.rendererCpu) },
      { label: 'with reduce', get: (x) => f2(x.reduced && x.reduced.rendererCpu) },
      { label: 'GPU CPU % as is', get: (x) => f2(x.asIs && x.asIs.gpuCpu) },
      { label: 'with reduce', get: (x) => f2(x.reduced && x.reduced.gpuCpu) },
      { label: 'Main thread busy % as is', get: (x) => f1(x.asIs && x.asIs.renderer && x.asIs.renderer.taskBusyPct) },
      { label: 'with reduce', get: (x) => f1(x.reduced && x.reduced.renderer && x.reduced.renderer.taskBusyPct) },
      { label: 'Style recalcs/s as is', get: (x) => f1(x.asIs && x.asIs.renderer && x.asIs.renderer.recalcStylesPerSec) },
      { label: 'with reduce', get: (x) => f1(x.reduced && x.reduced.renderer && x.reduced.renderer.recalcStylesPerSec) },
    ], json.ab.filter((x) => !x.error)))
    for (const x of json.ab.filter((y) => y.error)) md.push(`\n${x.tag}: A/B failed (${x.error}).`)
  }

  const abl = cells.filter((cell) => cell.tag.includes('-off-'))
  const ref = abl.find((cell) => cell.off === 'none')
  if (abl.length && ref) {
    md.push('')
    md.push(`## Ablations (N=${ref.n} busy, one service switched off per run)`)
    md.push('')
    md.push(A.markdownTable([
      { label: 'Run', align: 'left', get: (c) => (c.off === 'none' ? 'all services on' : `${c.off} off`) },
      { label: 'App total CPU %', get: (c) => f2(groupCpu(c, 'app')) },
      { label: 'Saved vs all on', get: (c) => (c === ref ? '-' : f2(groupCpu(ref, 'app') - groupCpu(c, 'app'))) },
      { label: 'Main %', get: (c) => f2(cpuOf(c, 'main')) },
      { label: 'Renderer %', get: (c) => f2(cpuOf(c, 'renderer')) },
      { label: 'GPU %', get: (c) => f2(cpuOf(c, 'gpu')) },
      { label: 'Sessions live', get: (c) => c.sessionsLive },
    ], abl))
  }

  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(json, null, 1))
  fs.writeFileSync(path.join(dir, 'report.md'), md.join('\n') + '\n')
  console.log(md.join('\n'))
}

module.exports = { groupOf, cpuOf, groupCpu }

if (require.main === module) {
  try { main() } catch (e) { console.error(e && e.stack ? e.stack : e); process.exit(1) }
}
