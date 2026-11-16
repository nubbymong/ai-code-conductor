// Performance harness (scripts/perf, see README.md): turn one run-matrix.cjs results folder into the
// per-service tables. Reads only that folder; writes report.md and report.json into it, and prints
// report.md. Runs anywhere (it starts nothing), so the folder can be copied off the VM first.
//
//   node scripts/perf/report.cjs <results folder> [--service-map <file>]
'use strict'

const fs = require('fs')
const path = require('path')
const A = require('./lib/aggregate.cjs')
const C = require('./lib/classify-process.cjs')

/** Which group a role's CPU adds to: the app's own Electron processes, the
 *  terminals the sessions run in (shell, console host, CLI), or neither
 *  (confounders and the harness itself). */
function groupOf(role) {
  if (/^(main|renderer|renderer-other|gpu|network|utility.*|crashpad|helper|helper-hold|vision-chrome)$/.test(role)) return 'app'
  if (/^(pty-host|shell|fake-claude|node)$/.test(role)) return 'terminals'
  return null
}
const ROLE_ORDER = Object.keys(C.ROLE_LABEL)
const roleLabel = (r) => C.ROLE_LABEL[r] || r
const byRoleOrder = (a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)

/** A window's samples with each process's role, and the role summaries. */
function analyseWindow(dir, w, record, runRec) {
  const parsed = A.parseSampleText(fs.readFileSync(path.join(dir, w.samples), 'utf8'))
  return analyseSamples(parsed, w, record, runRec)
}

function roleFunction(parsed, w, record, runRec) {
  const services = [w.renderer && w.renderer.start && w.renderer.start.page && w.renderer.start.page.services, w.renderer && w.renderer.end && w.renderer.end.page && w.renderer.end.page.services].flatMap((s) => (Array.isArray(s) ? s : []))
  const snap = (x) => (x && !x.error ? x : {})
  const ctx = C.contextFrom({
    appMetrics: [...(snap(w.mainStart).appMetrics || []), ...(snap(w.mainEnd).appMetrics || [])],
    webContents: [...(snap(w.mainStart).webContents || []), ...(snap(w.mainEnd).webContents || [])],
    services,
    stageRoot: record.stageRoot,
    harnessPids: new Set([...(record.harnessPids || []), parsed.header && parsed.header.samplerPid].filter(Boolean)),
  })
  const procs = new Map()
  for (const r of parsed.rows) { const k = A.procKey(r); if (!procs.has(k)) procs.set(k, r); else if (typeof r.cmd === 'string') procs.get(k).cmd = r.cmd }
  const list = [...procs.values()]
  const mainPid = C.findMainPid(list, runRec && runRec.appPid)
  const tree = mainPid ? C.processTree(list, mainPid) : new Set()
  const always = /^(aicc-helper\.exe|msmpeng\.exe|wmiprvse\.exe)$/i
  return (row) => {
    const role = C.classifyProcess(row, ctx)
    if (role === 'harness') return role
    if (tree.has(row.pid)) return role
    if (always.test(row.name) || role === 'vision-chrome') return role
    return null
  }
}

function analyseSamples(parsed, w, record, runRec, range = {}) {
  const roleOf = roleFunction(parsed, w, record, runRec)
  const roles = A.summarizeByRole(parsed.rows, { ...range, roleOf }).sort(byRoleOrder)
  const groups = A.summarizeByRole(parsed.rows, { ...range, roleOf: (r) => { const role = roleOf(r); return role ? groupOf(role) : null } })
  return { header: parsed.header, roles, groups }
}

function rendererDelta(w) {
  const r = w.renderer
  if (!r || r.error || !r.start || !r.end) return null
  return A.perfMetricsDelta(r.start.metrics, r.end.metrics)
}

/** CPU per process from the app's own figures (app.getAppMetrics), as a cross-check. */
function appMetricsCpu(w) {
  const a = w.mainStart && w.mainStart.appMetrics
  const b = w.mainEnd && w.mainEnd.appMetrics
  if (!a || !b) return []
  const wall = (w.mainEnd.t - w.mainStart.t) / 1000
  const before = new Map(a.map((m) => [m.pid, m]))
  return b.filter((m) => before.has(m.pid) && Number.isFinite(m.cpuSec) && Number.isFinite(before.get(m.pid).cpuSec))
    .map((m) => ({ pid: m.pid, type: m.type, name: m.name, cpuPct: ((m.cpuSec - before.get(m.pid).cpuSec) / wall) * 100, privateMb: m.privateKb / 1024 }))
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
  const f1 = (v) => A.fixed(v, 1)
  const f0 = (v) => A.fixed(v, 0)
  let header = null

  for (const runRec of record.runs) {
    for (const wref of runRec.windows) {
      const w = JSON.parse(fs.readFileSync(path.join(dir, wref.file), 'utf8'))
      const a = analyseWindow(dir, w, record, runRec)
      header = header || a.header
      const sessions = (a.roles.find((r) => r.role === 'fake-claude') || {}).processes || 0
      json.windows.push({ tag: w.tag, n: w.n, mode: w.mode, off: w.off, from: w.from, to: w.to, sessionsLive: sessions, roles: a.roles, groups: a.groups, renderer: rendererDelta(w), appMetrics: appMetricsCpu(w), services: serviceRows(w), resources: (w.mainEnd && w.mainEnd.resources) || {}, mainMem: w.mainEnd && w.mainEnd.mem, page: w.renderer && w.renderer.end && w.renderer.end.page ? { terminals: w.renderer.end.page.terminals, runningTab: w.renderer.end.page.runningTab } : null, errors: runRec.errors })
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
      const parsed = A.parseSampleText(fs.readFileSync(path.join(dir, ab.samples), 'utf8'))
      const w = JSON.parse(fs.readFileSync(path.join(dir, `window-${ab.tag}.json`), 'utf8'))
      const asIs = analyseSamples(parsed, w, record, runRec, { to: ab.switchAt })
      const reduced = analyseSamples(parsed, w, record, runRec, { from: ab.switchAt })
      const pick = (x, role) => x.roles.find((r) => r.role === role) || {}
      json.ab.push({
        tag: ab.tag, reduceMatched: ab.result.reduceMatched,
        asIs: { renderer: A.perfMetricsDelta(ab.result.asIs.start.metrics, ab.result.asIs.end.metrics), rendererCpu: pick(asIs, 'renderer').cpuMean, gpuCpu: pick(asIs, 'gpu').cpuMean, mainCpu: pick(asIs, 'main').cpuMean },
        reduced: { renderer: A.perfMetricsDelta(ab.result.reduced.start.metrics, ab.result.reduced.end.metrics), rendererCpu: pick(reduced, 'renderer').cpuMean, gpuCpu: pick(reduced, 'gpu').cpuMean, mainCpu: pick(reduced, 'main').cpuMean },
      })
    }
  }

  // ── the document ─────────────────────────────────────────────────────────
  const h = header || {}
  md.push(`# Service overhead baseline: AI Code Conductor ${json.appVersion || '(version not recorded)'}`)
  md.push('')
  md.push(`Measured ${new Date(record.started).toISOString().slice(0, 16).replace('T', ' ')} UTC on the Windows test VM: ${h.logicalCpus || '?'} logical CPUs, ${h.memMb || '?'} MB, ${h.os || '?'}. The installed app ran in session 0 from SSH, on a README staging root, with the fake Claude CLI (scripts/readme-shots/stage/fake-claude.js).${json.aborted ? ` The run was cut short: ${json.aborted}.` : ''}`)
  md.push('')
  md.push(`CPU is a percent of ONE core (100 = one core busy all the time; the VM has ${h.logicalCpus || '?'}), the mean over ${h.intervalSec || '?'} s intervals in each window, summed over every process of the row. Idle: the fake CLIs sit at their prompt. Busy: each redraws a spinner every 120 ms and writes its status file every 2 s, and one transcript line per session is appended every ${(record.options && record.options.sidecarMs) || '?'} ms.`)
  md.push('')
  md.push('Caveats: session 0 forces DOM terminals (`--dom-terminals`) and the VM has no GPU (software GL), so renderer and GPU figures are not comparable to a desktop with WebGL terminals. The fake CLI is not Claude Code (no hook events, its own output rate), so read the numbers as relative between windows, not absolute. Defender is on but the VM does not reproduce desktop file churn; I/O ops/s (read + write operations, which include pipe and socket I/O, not only files) is the proxy.')
  md.push('')

  const cells = json.windows
  const roleSet = new Set()
  for (const wnd of cells) for (const r of wnd.roles) roleSet.add(r.role)
  const roles = [...roleSet].sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b))
  md.push('## CPU per process (mean, % of one core)')
  md.push('')
  const pivotCols = [{ label: 'Process', align: 'left', get: (r) => r.label }, ...cells.map((wnd) => ({ label: wnd.tag, get: (r) => r[wnd.tag] }))]
  const pivotRows = []
  for (const g of ['app', 'terminals']) {
    pivotRows.push({ label: g === 'app' ? '**App total (Electron, helper, vision)**' : '**Terminals total (shell, console host, fake CLI)**', ...Object.fromEntries(cells.map((wnd) => [wnd.tag, f1((wnd.groups.find((x) => x.role === g) || {}).cpuMean)])) })
  }
  for (const role of roles) pivotRows.push({ label: roleLabel(role), ...Object.fromEntries(cells.map((wnd) => [wnd.tag, f1((wnd.roles.find((x) => x.role === role) || {}).cpuMean)])) })
  pivotRows.push({ label: 'Sessions live (fake CLI processes)', ...Object.fromEntries(cells.map((wnd) => [wnd.tag, String(wnd.sessionsLive)])) })
  const profileOf = (tag) => json.profiles.find((p) => p.tag === tag) || {}
  pivotRows.push({ label: 'Main thread busy % (CPU profile, where taken)', ...Object.fromEntries(cells.map((wnd) => [wnd.tag, f1(profileOf(wnd.tag).mainBusyPct)])) })
  pivotRows.push({ label: 'Renderer main thread busy % (CDP task time)', ...Object.fromEntries(cells.map((wnd) => [wnd.tag, f1(wnd.renderer && wnd.renderer.taskBusyPct)])) })
  md.push(A.markdownTable(pivotCols, pivotRows))
  md.push('')

  md.push('## Each window')
  for (const wnd of cells) {
    md.push('')
    md.push(`### ${wnd.tag} (N=${wnd.n}, ${wnd.mode}${wnd.off !== 'none' ? `, ${wnd.off} off` : ''})`)
    md.push('')
    md.push(A.markdownTable([
      { label: 'Process', align: 'left', get: (r) => roleLabel(r.role) },
      { label: 'Count', get: (r) => r.processes },
      { label: 'CPU mean %', get: (r) => f1(r.cpuMean) },
      { label: 'CPU p95 %', get: (r) => f1(r.cpuP95) },
      { label: 'Private MB', get: (r) => f0(r.privateMb) },
      { label: 'I/O ops/s', get: (r) => f1(r.ioOpsPerSec) },
      { label: 'Handles', get: (r) => f0(r.handles) },
      { label: 'Threads', get: (r) => f0(r.threads) },
    ], wnd.roles))
    const r = wnd.renderer
    const notes = []
    if (r) notes.push(`renderer: main thread busy ${f1(r.taskBusyPct)} % (script ${f1(r.scriptBusyPct)} %), ${f1(r.layoutsPerSec)} layouts/s, ${f1(r.recalcStylesPerSec)} style recalcs/s, JS heap ${f0(r.heapMb)} MB, ${f0(r.nodes)} DOM nodes`)
    if (wnd.page) notes.push(`page: ${wnd.page.terminals} terminals, Running tab "${wnd.page.runningTab}"`)
    if (wnd.mainMem) notes.push(`main JS heap ${f0(wnd.mainMem.heapUsedMb)} MB`)
    md.push('')
    md.push(notes.join('; ') + '.')
    const svc = wnd.services.filter((s) => s.id)
    if (svc.length) {
      md.push('')
      md.push(A.markdownTable([
        { label: 'Services row', align: 'left', get: (s) => s.id },
        { label: 'State', align: 'left', get: (s) => s.state },
        { label: 'Host', align: 'left', get: (s) => s.host },
        { label: 'Events/s', get: (s) => A.fixed(s.eventsPerSec, 2) },
        { label: 'Own CPU figure %', get: (s) => f1(s.measuredCpu) },
        { label: 'Files last scan', get: (s) => s.filesLastScan === null ? '-' : s.filesLastScan },
        { label: 'Main stalls/min', get: (s) => s.stalls },
      ], svc))
    }
    if (wnd.errors && wnd.errors.length) { md.push(''); md.push('Errors in this run: ' + wnd.errors.join('; ')) }
  }

  if (json.profiles.length) {
    md.push('')
    md.push('## Main process by service (60 s CPU profile)')
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
      const label = (id) => ((serviceMap.services || []).find((s) => s.id === id) || {}).label || id
      md.push(A.markdownTable([
        { label: 'Service', align: 'left', get: (r) => label(r.id) },
        { label: 'ms per s', get: (r) => A.fixed(r.ms / secs, 1) },
        { label: '% of main busy', get: (r) => f1(busy > 0 ? (r.ms / busy) * 100 : null) },
      ], rows))
      md.push('')
      md.push('Top frames not attributed: ' + (p.main.topUnattributed.slice(0, 8).map((f) => `${f.frame} (${f0(f.ms)} ms)`).join('; ') || 'none') + '.')
    }
    md.push('')
    md.push('## Renderer CPU profile (60 s): top self time')
    for (const p of json.profiles) {
      if (!p.renderer) continue
      const secs = p.renderer.totalMs / 1000
      md.push('')
      md.push(`### ${p.tag}: busy ${f1(p.rendererBusyPct)} % of the thread (GC ${A.fixed(p.renderer.gcMs / secs, 1)} ms/s, native ${A.fixed(p.renderer.programMs / secs, 1)} ms/s)`)
      md.push('')
      md.push(A.markdownTable([
        { label: 'Frame', align: 'left', get: (r) => r.frame },
        { label: 'ms per s', get: (r) => A.fixed(r.ms / secs, 1) },
      ], p.renderer.topSelf.slice(0, 12)))
    }
  }

  if (json.ab.length) {
    md.push('')
    md.push('## Always-on animations: prefers-reduced-motion A/B')
    md.push('')
    md.push(A.markdownTable([
      { label: 'Window', align: 'left', get: (r) => r.tag },
      { label: 'Renderer CPU % as is', get: (r) => f1(r.asIs && r.asIs.rendererCpu) },
      { label: 'with reduce', get: (r) => f1(r.reduced && r.reduced.rendererCpu) },
      { label: 'GPU CPU % as is', get: (r) => f1(r.asIs && r.asIs.gpuCpu) },
      { label: 'with reduce', get: (r) => f1(r.reduced && r.reduced.gpuCpu) },
      { label: 'Main thread busy % as is', get: (r) => f1(r.asIs && r.asIs.renderer && r.asIs.renderer.taskBusyPct) },
      { label: 'with reduce', get: (r) => f1(r.reduced && r.reduced.renderer && r.reduced.renderer.taskBusyPct) },
      { label: 'Style recalcs/s as is', get: (r) => f1(r.asIs && r.asIs.renderer && r.asIs.renderer.recalcStylesPerSec) },
      { label: 'with reduce', get: (r) => f1(r.reduced && r.reduced.renderer && r.reduced.renderer.recalcStylesPerSec) },
    ], json.ab.filter((x) => !x.error)))
    for (const x of json.ab.filter((y) => y.error)) md.push(`\n${x.tag}: A/B failed (${x.error}).`)
  }

  const abl = cells.filter((wnd) => wnd.tag.includes('-off-'))
  const ref = abl.find((wnd) => wnd.off === 'none')
  if (abl.length && ref) {
    md.push('')
    md.push(`## Ablations (N=${ref.n} busy, one service switched off per run)`)
    md.push('')
    const appCpu = (wnd) => (wnd.groups.find((g) => g.role === 'app') || {}).cpuMean
    const roleCpu = (wnd, role) => (wnd.roles.find((r) => r.role === role) || {}).cpuMean
    md.push(A.markdownTable([
      { label: 'Run', align: 'left', get: (w2) => w2.off === 'none' ? 'all services on' : `${w2.off} off` },
      { label: 'App total CPU %', get: (w2) => f1(appCpu(w2)) },
      { label: 'Saved vs all on', get: (w2) => w2 === ref ? '-' : f1(appCpu(ref) - appCpu(w2)) },
      { label: 'Main %', get: (w2) => f1(roleCpu(w2, 'main')) },
      { label: 'Renderer %', get: (w2) => f1(roleCpu(w2, 'renderer')) },
      { label: 'GPU %', get: (w2) => f1(roleCpu(w2, 'gpu')) },
      { label: 'Sessions live', get: (w2) => w2.sessionsLive },
    ], abl))
  }

  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(json, null, 1))
  fs.writeFileSync(path.join(dir, 'report.md'), md.join('\n') + '\n')
  console.log(md.join('\n'))
}

module.exports = { groupOf }

if (require.main === module) {
  try { main() } catch (e) { console.error(e && e.stack ? e.stack : e); process.exit(1) }
}
