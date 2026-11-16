// Performance harness: the arithmetic (scripts/perf, see README.md).
//
// Pure functions: the samples sample-processes.ps1 writes, the renderer's
// Performance.getMetrics readings, the main process's event loop readings and
// V8 CPU profiles in, numbers and tables out. Nothing here reads the disk, so
// the unit suite runs it on any machine (tests/unit/scripts/perf-aggregate.test.ts).
//
// CPU is a percent of ONE core (100 = one core busy for the whole interval),
// as Task Manager's per-process column is not: divide by the core count the
// sample header records for a share of the machine.
'use strict'

const MB = 1024 * 1024

/** One sampled process, as sample-processes.ps1 writes it, in plain units:
 *  t and created in ms since the epoch, CPU in seconds (Win32_Process gives
 *  user and kernel time in 100 ns units), I/O as operation counts. */
function normalizeRow(raw) {
  const n = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v))
  const row = {
    t: n(raw.t),
    pid: n(raw.pid),
    ppid: n(raw.ppid),
    name: String(raw.name || ''),
    created: n(raw.created),
    cpuSec: (n(raw.user) + n(raw.kernel)) / 1e7,
    privateBytes: n(raw.priv),
    workingSet: n(raw.ws),
    handles: n(raw.handles),
    threads: n(raw.threads),
    ioOps: n(raw.rops) + n(raw.wops),
    otherOps: n(raw.oops),
  }
  if (typeof raw.cmd === 'string') row.cmd = raw.cmd
  return row
}

/** A sample file (JSON lines): its header, its ticks and its process rows. */
function parseSampleText(text) {
  const out = { header: null, ticks: [], rows: [] }
  for (const line of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    if (!line.trim()) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    if (o.kind === 'header') out.header = o
    else if (o.kind === 'tick') out.ticks.push(o)
    else if (o.kind === 'p') out.rows.push(normalizeRow(o))
  }
  return out
}

/** A process is its pid AND its start time: Windows reuses pids, and a reused
 *  pid is a new process whose counters start again from zero. */
const procKey = (r) => `${r.pid}@${r.created}`

/** CPU over the interval between two samples of the SAME process, in percent
 *  of one core. Null across a pid reuse, a counter that went back, or no time. */
function cpuPercent(prev, cur) {
  if (!prev || !cur || procKey(prev) !== procKey(cur)) return null
  const dt = (cur.t - prev.t) / 1000
  const dc = cur.cpuSec - prev.cpuSec
  if (!(dt > 0) || !Number.isFinite(dc) || dc < 0) return null
  return (dc / dt) * 100
}

/** A cumulative counter as a rate per second. Null when it went back or no
 *  time passed. */
function ratePerSec(prevCount, curCount, dtMs) {
  const d = curCount - prevCount
  if (!(dtMs > 0) || !Number.isFinite(d) || d < 0) return null
  return d / (dtMs / 1000)
}

function mean(values) {
  const v = values.filter(Number.isFinite)
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
}

/** The nearest-rank percentile (p95 of 20 values is the 19th smallest). */
function percentile(values, p) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return null
  const rank = Math.ceil((p / 100) * v.length)
  return v[Math.min(v.length, Math.max(1, rank)) - 1]
}

/**
 * Per role, over the ticks inside [from, to]: CPU (sum over the role's
 * processes per interval, then mean, p95 and max over the intervals), private
 * and working-set memory, handles and threads (sum per tick, mean over the
 * ticks), and I/O operations per second (read + write, sum per interval).
 *
 * roleOf(row) names a row's role, or null to leave it out; it is asked once
 * per process (pid and start time), with the command line its first sample
 * carried. A process seen for the first time in a tick adds no CPU for the
 * interval before it.
 */
function summarizeByRole(rows, { from = -Infinity, to = Infinity, roleOf }) {
  const cmdByKey = new Map()
  for (const r of rows) if (typeof r.cmd === 'string' && !cmdByKey.has(procKey(r))) cmdByKey.set(procKey(r), r.cmd)
  const inWindow = rows.filter((r) => r.t >= from && r.t <= to)
  const roleByKey = new Map()
  for (const r of inWindow) {
    const k = procKey(r)
    if (!roleByKey.has(k)) roleByKey.set(k, roleOf({ ...r, cmd: cmdByKey.get(k) }))
  }
  const ticks = [...new Set(inWindow.map((r) => r.t))].sort((a, b) => a - b)
  const byTick = new Map(ticks.map((t) => [t, new Map()]))
  for (const r of inWindow) if (roleByKey.get(procKey(r)) != null) byTick.get(r.t).set(procKey(r), r)
  const roles = [...new Set([...roleByKey.values()].filter((x) => x != null))]
  const acc = new Map(roles.map((role) => [role, { keys: new Set(), cpu: [], io: [], priv: [], ws: [], handles: [], threads: [] }]))
  for (const t of ticks) {
    const sums = new Map(roles.map((role) => [role, { priv: 0, ws: 0, handles: 0, threads: 0 }]))
    for (const [k, r] of byTick.get(t)) {
      const role = roleByKey.get(k)
      acc.get(role).keys.add(k)
      const s = sums.get(role)
      if (Number.isFinite(r.privateBytes)) s.priv += r.privateBytes
      if (Number.isFinite(r.workingSet)) s.ws += r.workingSet
      if (Number.isFinite(r.handles)) s.handles += r.handles
      if (Number.isFinite(r.threads)) s.threads += r.threads
    }
    for (const role of roles) {
      const a = acc.get(role)
      const s = sums.get(role)
      a.priv.push(s.priv); a.ws.push(s.ws); a.handles.push(s.handles); a.threads.push(s.threads)
    }
  }
  for (let i = 1; i < ticks.length; i++) {
    const prev = byTick.get(ticks[i - 1])
    const cur = byTick.get(ticks[i])
    const cpu = new Map(roles.map((role) => [role, 0]))
    const io = new Map(roles.map((role) => [role, 0]))
    for (const [k, r] of cur) {
      const p = prev.get(k)
      if (!p) continue
      const role = roleByKey.get(k)
      const c = cpuPercent(p, r)
      if (c !== null) cpu.set(role, cpu.get(role) + c)
      const o = ratePerSec(p.ioOps, r.ioOps, r.t - p.t)
      if (o !== null) io.set(role, io.get(role) + o)
    }
    for (const role of roles) { acc.get(role).cpu.push(cpu.get(role)); acc.get(role).io.push(io.get(role)) }
  }
  return roles.map((role) => {
    const a = acc.get(role)
    return {
      role,
      processes: a.keys.size,
      intervals: a.cpu.length,
      cpuMean: mean(a.cpu),
      cpuP95: percentile(a.cpu, 95),
      cpuMax: a.cpu.length ? Math.max(...a.cpu) : null,
      privateMb: mean(a.priv) === null ? null : mean(a.priv) / MB,
      workingSetMb: mean(a.ws) === null ? null : mean(a.ws) / MB,
      ioOpsPerSec: mean(a.io),
      handles: mean(a.handles),
      threads: mean(a.threads),
    }
  })
}

/** Performance.getMetrics as a name -> value object (it comes as a list). */
function metricsObject(m) {
  if (!m) return {}
  if (Array.isArray(m)) return Object.fromEntries(m.map((x) => [x.name, x.value]))
  if (Array.isArray(m.metrics)) return metricsObject(m.metrics)
  return m
}

/** The renderer between two Performance.getMetrics readings taken on ONE
 *  attached session (the durations count only while it is attached).
 *  Timestamp and the *Duration metrics are seconds. */
function perfMetricsDelta(a, b) {
  const A = metricsObject(a)
  const B = metricsObject(b)
  const wall = B.Timestamp - A.Timestamp
  if (!(wall > 0)) return null
  const d = (k) => (Number.isFinite(B[k]) && Number.isFinite(A[k]) ? B[k] - A[k] : NaN)
  return {
    wallSec: wall,
    taskBusyPct: (d('TaskDuration') / wall) * 100,
    scriptBusyPct: (d('ScriptDuration') / wall) * 100,
    layoutMsPerSec: (d('LayoutDuration') * 1000) / wall,
    recalcStyleMsPerSec: (d('RecalcStyleDuration') * 1000) / wall,
    layoutsPerSec: d('LayoutCount') / wall,
    recalcStylesPerSec: d('RecalcStyleCount') / wall,
    heapMb: Number.isFinite(B.JSHeapUsedSize) ? B.JSHeapUsedSize / MB : null,
    nodes: Number.isFinite(B.Nodes) ? B.Nodes : null,
    listeners: Number.isFinite(B.JSEventListeners) ? B.JSEventListeners : null,
  }
}

/** Self time per profile node, in ms. A sample lasts until the next one
 *  (timeDeltas[i + 1], in microseconds); the last one counts nothing. */
function profileSelfTimes(profile) {
  const self = new Map()
  const samples = (profile && profile.samples) || []
  const deltas = (profile && profile.timeDeltas) || []
  for (let i = 0; i < samples.length; i++) {
    const dur = i + 1 < deltas.length ? deltas[i + 1] : 0
    if (dur > 0) self.set(samples[i], (self.get(samples[i]) || 0) + dur / 1000)
  }
  return self
}

const SPECIAL = { '(idle)': 'idle', '(program)': 'program', '(garbage collector)': 'gc', '(root)': 'program' }

/** A frame for a person: its own name (or "anonymous"), the top-level
 *  function or class it sits in, its file and line. */
function frameLabel(cf, topOf) {
  const own = (cf && cf.functionName) || '(anonymous)'
  const top = topOf ? topOf(cf) : ''
  const file = String((cf && cf.url) || '').split(/[\\/]/).slice(-2).join('/')
  const where = file ? ` ${file}:${(cf.lineNumber || 0) + 1}` : ''
  return own + (top && top !== own ? ` in ${top}` : '') + where
}

/**
 * Attribute a V8 CPU profile's self time to services. Each sample's frame,
 * then its callers in turn, are matched against the service map (in its
 * order, the first service that matches a frame wins): a service's
 * `functions` patterns against the frame's own name, its `within` patterns
 * against the top-level function or class the frame sits in (topOf(callFrame),
 * from the bundle's source; none without it) and its `urls` patterns against
 * the frame's script. The nearest matching frame names the service. (idle),
 * (program) and (garbage collector) are kept apart.
 */
function attributeProfile(profile, serviceMap, { topOf, top = 15 } = {}) {
  const nodes = new Map(((profile && profile.nodes) || []).map((n) => [n.id, n]))
  const parent = new Map()
  for (const n of nodes.values()) for (const c of n.children || []) parent.set(c, n.id)
  const services = ((serviceMap && serviceMap.services) || []).map((s) => ({
    id: s.id,
    fn: (s.functions || []).map((r) => new RegExp(r)),
    within: (s.within || []).map((r) => new RegExp(r)),
    url: (s.urls || []).map((r) => new RegExp(r)),
  }))
  const topName = (cf) => (topOf ? topOf(cf) || '' : '')
  const memo = new Map()
  const serviceOf = (id) => {
    const path = []
    let cur = id
    let found = null
    while (cur !== undefined) {
      if (memo.has(cur)) { found = memo.get(cur); break }
      path.push(cur)
      const cf = (nodes.get(cur) && nodes.get(cur).callFrame) || {}
      const own = cf.functionName || ''
      const enclosing = topName(cf)
      const hit = services.find((s) => (own && s.fn.some((r) => r.test(own))) || (enclosing && s.within.some((r) => r.test(enclosing))) || (cf.url && s.url.some((r) => r.test(cf.url))))
      if (hit) { found = hit.id; break }
      cur = parent.get(cur)
    }
    for (const p of path) memo.set(p, found)
    return found
  }
  const out = { totalMs: 0, idleMs: 0, programMs: 0, gcMs: 0, unattributedMs: 0, byService: {}, topUnattributed: [], topSelf: [] }
  const unattributed = new Map()
  const selfByFrame = new Map()
  for (const [id, ms] of profileSelfTimes(profile)) {
    out.totalMs += ms
    const cf = (nodes.get(id) && nodes.get(id).callFrame) || {}
    const special = SPECIAL[cf.functionName]
    if (special) { out[special + 'Ms'] += ms; continue }
    const label = frameLabel(cf, topName)
    selfByFrame.set(label, (selfByFrame.get(label) || 0) + ms)
    const svc = serviceOf(id)
    if (svc) out.byService[svc] = (out.byService[svc] || 0) + ms
    else { out.unattributedMs += ms; unattributed.set(label, (unattributed.get(label) || 0) + ms) }
  }
  const ranked = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([frame, ms]) => ({ frame, ms }))
  out.topUnattributed = ranked(unattributed)
  out.topSelf = ranked(selfByFrame)
  return out
}

const TOP_DECLARATION = /^(?:export\s+)?(?:async\s+)?(?:function\s*\*?\s*|class\s+|const\s+|let\s+|var\s+)([A-Za-z_$][\w$]*)/

/**
 * The top-level function, class or variable of the bundle that line `line`
 * (0-based, as a V8 call frame's lineNumber) sits in. Main is bundled but
 * neither minified nor source-mapped, so the bundle keeps its indentation:
 * the nearest line above (or the line itself) that starts in column 0 and is
 * not a closing bracket opens the declaration or statement it is in. A
 * top-level statement (an app.on(...) block, say) is named by its first 48
 * characters. '' when there is none within maxScan lines.
 */
function topLevelName(lines, line, maxScan = 40000) {
  if (!Array.isArray(lines) || !(line >= 0) || line >= lines.length) return ''
  for (let i = line; i >= 0 && i >= line - maxScan; i--) {
    const s = lines[i]
    if (!s || /^[\s}\])]/.test(s) || /^\/[/*]/.test(s)) continue
    const m = s.match(TOP_DECLARATION)
    return m ? m[1] : s.trim().slice(0, 48)
  }
  return ''
}

/** topOf for attributeProfile and frameLabel, over the bundle's files
 *  ({ 'index.js': text, 'chunks/<name>.js': text }, as main-inspector reads
 *  them from out/main): a frame whose script url ends with out/main/<file>
 *  gets its top-level name in that file; other frames none. Memoized. */
function topLevelNamer(files, base = 'out/main/') {
  const lines = new Map(Object.entries(files || {}).map(([k, text]) => [base + k.replace(/\\/g, '/'), String(text || '').split(/\r?\n/)]))
  const memo = new Map()
  return (cf) => {
    if (!cf || !cf.url) return ''
    const url = decodeURI(String(cf.url)).replace(/\\/g, '/')
    const key = `${url}:${cf.lineNumber}`
    if (memo.has(key)) return memo.get(key)
    let name = ''
    for (const [suffix, l] of lines) if (url.endsWith('/' + suffix)) { name = topLevelName(l, cf.lineNumber); break }
    memo.set(key, name)
    return name
  }
}

/** A Markdown table. columns: [{ label, get(row), align: 'left'|'right' }]. */
function markdownTable(columns, rows) {
  const cell = (v) => String(v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v)) ? '-' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const head = '| ' + columns.map((c) => c.label).join(' | ') + ' |'
  const rule = '| ' + columns.map((c) => (c.align === 'left' ? ':--' : '--:')).join(' | ') + ' |'
  const body = rows.map((r) => '| ' + columns.map((c) => cell(c.get(r))).join(' | ') + ' |')
  return [head, rule, ...body].join('\n')
}

/** A number for a table: d decimals, '-' when there is none. */
function fixed(v, d = 1) {
  return v === null || v === undefined || !Number.isFinite(v) ? '-' : v.toFixed(d)
}

module.exports = {
  MB, normalizeRow, parseSampleText, procKey, cpuPercent, ratePerSec, mean, percentile, summarizeByRole,
  metricsObject, perfMetricsDelta, profileSelfTimes, attributeProfile, frameLabel,
  topLevelName, topLevelNamer, markdownTable, fixed,
}
