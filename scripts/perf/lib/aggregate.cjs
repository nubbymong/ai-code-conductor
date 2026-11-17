// Performance harness: the arithmetic (scripts/perf, see README.md).
//
// Pure functions: the samples sample-processes.ps1 writes, the app's own
// process figures, the renderer's Performance.getMetrics readings and V8 CPU
// profiles in, numbers and tables out. Nothing here reads the disk, so the
// unit suite runs it on any machine (tests/unit/scripts/perf-aggregate.test.ts).
//
// CPU is a percent of ONE core (100 = one core busy for the whole interval),
// as Task Manager's per-process column is not: divide by the core count the
// sample header records for a share of the machine.
//
// Two CPU counters per sampled process. Windows charges a process's user and
// kernel time (Win32_Process) at the clock tick (15.6 ms), so a process that
// runs in short bursts woken by timers is undercounted, by several times on
// the VM (the app window's renderer read 1.2 % while its main thread alone was
// measured 3.7 % busy). The sampler also reads each process's CPU cycle count
// (QueryProcessCycleTime), which is charged exactly, and the cycles per second
// of that counter: CPU is taken from the cycles wherever both samples of an
// interval have them (source 'cycles'), and from the ticks only where they do
// not (source 'windows', a lower bound). Chromium's own per-process figure
// (app.getAppMetrics, appCpuByRole) counts the same cycles.
'use strict'

const MB = 1024 * 1024

/** One sampled process, as sample-processes.ps1 writes it, in plain units:
 *  t and created in ms since the epoch, CPU in seconds (Win32_Process gives
 *  user and kernel time in 100 ns units), cycles as counted, tc the time the
 *  cycle count was read, I/O as read + write operation counts. */
function normalizeRow(raw) {
  const n = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v))
  const row = {
    t: n(raw.t),
    pid: n(raw.pid),
    ppid: n(raw.ppid),
    name: String(raw.name || ''),
    created: n(raw.created),
    cpuSec: (n(raw.user) + n(raw.kernel)) / 1e7,
    cycles: n(raw.cyc),
    tc: n(raw.tc),
    privateBytes: n(raw.priv),
    workingSet: n(raw.ws),
    handles: n(raw.handles),
    threads: n(raw.threads),
    ioOps: n(raw.rops) + n(raw.wops),
  }
  if (typeof raw.cmd === 'string') row.cmd = raw.cmd
  return row
}

/** A sample file (JSON lines): its header, its ticks (each with how long the
 *  process query took) and its process rows. A byte order mark is dropped. */
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

/** CPU over the interval between two samples of the SAME process from
 *  Windows' tick-charged times, in percent of one core. Null across a pid
 *  reuse, a counter that went back, or no time. */
function cpuPercent(prev, cur) {
  if (!prev || !cur || procKey(prev) !== procKey(cur)) return null
  const dt = (cur.t - prev.t) / 1000
  const dc = cur.cpuSec - prev.cpuSec
  if (!(dt > 0) || !Number.isFinite(dc) || dc < 0) return null
  return (dc / dt) * 100
}

/** CPU over the interval between two samples of the SAME process, from the
 *  cycle counts when both samples have one and cyclesPerSec is known
 *  ({ pct, source: 'cycles' }), else from Windows' ticks ({ pct, source:
 *  'windows' }). Null across a pid reuse, a counter that went back, or no
 *  time. */
function cpuSample(prev, cur, cyclesPerSec) {
  if (!prev || !cur || procKey(prev) !== procKey(cur)) return null
  if (cyclesPerSec > 0 && [prev.cycles, cur.cycles, prev.tc, cur.tc].every(Number.isFinite)) {
    const dt = (cur.tc - prev.tc) / 1000
    const dc = cur.cycles - prev.cycles
    if (!(dt > 0) || dc < 0) return null
    return { pct: (dc / cyclesPerSec / dt) * 100, source: 'cycles' }
  }
  const pct = cpuPercent(prev, cur)
  return pct === null ? null : { pct, source: 'windows' }
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

/** The nearest-rank percentile (p95 of 20 values is the 19th smallest, of 21
 *  the 20th). */
function percentile(values, p) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return null
  const rank = Math.ceil((p / 100) * v.length)
  return v[Math.min(v.length, Math.max(1, rank)) - 1]
}

/** Where a role's CPU came from over its intervals: 'cycles' when every
 *  process-interval had cycle counts, 'windows' when none did, 'mixed'
 *  otherwise, null when there was nothing to measure. */
function sourceOf(counts) {
  if (counts.cycles && !counts.windows) return 'cycles'
  if (counts.windows && !counts.cycles) return 'windows'
  return counts.cycles || counts.windows ? 'mixed' : null
}

/**
 * Per role, over the ticks inside [from, to]: CPU (sum over the role's
 * processes per interval, then mean, p95 and max over the intervals; from the
 * cycle counts where an interval has them, see cpuSample, with cpuSource
 * saying which, and cpuTickMean the same mean from Windows' ticks alone for
 * comparison), private and working-set memory, handles and threads (sum per
 * tick, mean over the ticks), I/O operations per second (read + write, sum per
 * interval), and how many of the role's processes ran at once (fewest and
 * most over the ticks).
 *
 * roleOf(row) names a row's role, or null to leave it out; it is asked once
 * per process (pid and start time), with the command line its first sample
 * carried. A process seen for the first time in a tick adds no CPU for the
 * interval before it. An interval with an end outside [from, to] (one that
 * spans a switch the caller cuts at) belongs to neither side.
 */
function summarizeByRole(rows, { from = -Infinity, to = Infinity, roleOf, cyclesPerSec = null }) {
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
  const acc = new Map(roles.map((role) => [role, { keys: new Set(), cpu: [], tick: [], io: [], priv: [], ws: [], handles: [], threads: [], running: [], counts: { cycles: 0, windows: 0 } }]))
  for (const t of ticks) {
    const sums = new Map(roles.map((role) => [role, { priv: 0, ws: 0, handles: 0, threads: 0, running: 0 }]))
    for (const [k, r] of byTick.get(t)) {
      const role = roleByKey.get(k)
      acc.get(role).keys.add(k)
      const s = sums.get(role)
      s.running++
      if (Number.isFinite(r.privateBytes)) s.priv += r.privateBytes
      if (Number.isFinite(r.workingSet)) s.ws += r.workingSet
      if (Number.isFinite(r.handles)) s.handles += r.handles
      if (Number.isFinite(r.threads)) s.threads += r.threads
    }
    for (const role of roles) {
      const a = acc.get(role)
      const s = sums.get(role)
      a.priv.push(s.priv); a.ws.push(s.ws); a.handles.push(s.handles); a.threads.push(s.threads); a.running.push(s.running)
    }
  }
  for (let i = 1; i < ticks.length; i++) {
    const prev = byTick.get(ticks[i - 1])
    const cur = byTick.get(ticks[i])
    const cpu = new Map(roles.map((role) => [role, 0]))
    const tick = new Map(roles.map((role) => [role, 0]))
    const io = new Map(roles.map((role) => [role, 0]))
    for (const [k, r] of cur) {
      const p = prev.get(k)
      if (!p) continue
      const role = roleByKey.get(k)
      const c = cpuSample(p, r, cyclesPerSec)
      if (c !== null) { cpu.set(role, cpu.get(role) + c.pct); acc.get(role).counts[c.source]++ }
      const w = cpuPercent(p, r)
      if (w !== null) tick.set(role, tick.get(role) + w)
      const o = ratePerSec(p.ioOps, r.ioOps, r.t - p.t)
      if (o !== null) io.set(role, io.get(role) + o)
    }
    for (const role of roles) { const a = acc.get(role); a.cpu.push(cpu.get(role)); a.tick.push(tick.get(role)); a.io.push(io.get(role)) }
  }
  return roles.map((role) => {
    const a = acc.get(role)
    return {
      role,
      processes: a.keys.size,
      minConcurrent: a.running.length ? Math.min(...a.running) : 0,
      maxConcurrent: a.running.length ? Math.max(...a.running) : 0,
      intervals: a.cpu.length,
      cpuMean: mean(a.cpu),
      cpuP95: percentile(a.cpu, 95),
      cpuMax: a.cpu.length ? Math.max(...a.cpu) : null,
      cpuSource: sourceOf(a.counts),
      cpuTickMean: mean(a.tick),
      privateMb: mean(a.priv) === null ? null : mean(a.priv) / MB,
      workingSetMb: mean(a.ws) === null ? null : mean(a.ws) / MB,
      ioOpsPerSec: mean(a.io),
      handles: mean(a.handles),
      threads: mean(a.threads),
    }
  })
}

/**
 * CPU per role from two readings of the app's own process list
 * (app.getAppMetrics: { t, appMetrics: [{ pid, creationTime, cpuSec }] },
 * cpuSec cumulative), in percent of one core over the time between them,
 * summed per role. A process counts only when both readings hold it (same
 * pid and start time) and its figure did not go back: one that started or
 * ended between them is left out. roleOf(metric) names a process's role
 * (null leaves it out).
 */
function appCpuByRole(a, b, roleOf) {
  const out = new Map()
  if (!a || !b || !Array.isArray(a.appMetrics) || !Array.isArray(b.appMetrics)) return out
  const wall = (b.t - a.t) / 1000
  if (!(wall > 0)) return out
  const key = (m) => `${m.pid}@${Math.round(Number(m.creationTime) || 0)}`
  const before = new Map(a.appMetrics.map((m) => [key(m), m]))
  for (const m of b.appMetrics) {
    const p = before.get(key(m))
    if (!p || !Number.isFinite(m.cpuSec) || !Number.isFinite(p.cpuSec) || m.cpuSec < p.cpuSec) continue
    const role = roleOf(m)
    if (role == null) continue
    out.set(role, (out.get(role) || 0) + ((m.cpuSec - p.cpuSec) / wall) * 100)
  }
  return out
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

/**
 * Self and inclusive time of named functions in a V8 CPU profile, in ms (B2
 * and B3 judge `RateLimitBar` self time and `handleSelectionChanged`
 * inclusive time). A name matches a frame's own function name exactly. A
 * sample adds to a name's inclusive time once, however often the name is on
 * its stack (recursion), and to its self time when it is the sampled frame.
 */
function functionTimes(profile, names) {
  const nodes = new Map(((profile && profile.nodes) || []).map((n) => [n.id, n]))
  const parent = new Map()
  for (const n of nodes.values()) for (const c of n.children || []) parent.set(c, n.id)
  const wanted = [...new Set((names || []).map(String).filter(Boolean))]
  const byName = Object.fromEntries(wanted.map((n) => [n, { selfMs: 0, inclusiveMs: 0 }]))
  const nameOf = (id) => { const n = nodes.get(id); return (n && n.callFrame && n.callFrame.functionName) || '' }
  // The wanted names on the stack from a node up to the root, memoized per node.
  const onStack = new Map()
  const stackNames = (id) => {
    if (onStack.has(id)) return onStack.get(id)
    const own = nameOf(id)
    const up = parent.has(id) ? stackNames(parent.get(id)) : new Set()
    const set = own && byName[own] && !up.has(own) ? new Set([...up, own]) : up
    onStack.set(id, set)
    return set
  }
  let totalMs = 0
  for (const [id, ms] of profileSelfTimes(profile)) {
    totalMs += ms
    const own = nameOf(id)
    if (byName[own]) byName[own].selfMs += ms
    for (const n of stackNames(id)) byName[n].inclusiveMs += ms
  }
  return { totalMs, byName }
}

const TOP_DECLARATION = /^(?:export\s+)?(?:async\s+)?(?:function\s*\*?\s*|class\s+|const\s+|let\s+|var\s+)([A-Za-z_$][\w$]*)/

/** How many backticks on a line are not escaped (a template literal's
 *  delimiters, near enough: one in a string or a comment counts too). */
function unescapedBackticks(s) {
  let n = 0
  for (let i = s.indexOf('`'); i >= 0; i = s.indexOf('`', i + 1)) {
    let slashes = 0
    for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) slashes++
    if (slashes % 2 === 0) n++
  }
  return n
}

/** Running backtick counts: bt[i] is the number before line i. */
function backtickCounts(lines) {
  const bt = new Array(lines.length + 1)
  bt[0] = 0
  for (let i = 0; i < lines.length; i++) bt[i + 1] = bt[i] + unescapedBackticks(String(lines[i] || ''))
  return bt
}

/**
 * The top-level function, class or variable of the bundle that line `line`
 * (0-based, as a V8 call frame's lineNumber) sits in. Main is bundled but
 * neither minified nor source-mapped, so the bundle keeps its indentation:
 * the nearest line above (or the line itself) that starts in column 0 and is
 * not a closing bracket opens the declaration or statement it is in. A
 * top-level statement (an app.on(...) block, say) is named by its first 48
 * characters. A column-0 line inside a multi-line template literal (main
 * embeds scripts that way) is text, not code, and is passed over: an odd
 * number of backticks between it and the frame's line says it is inside one.
 * '' when there is none within maxScan lines. bt: backtickCounts(lines), when
 * the caller already has it.
 */
function topLevelName(lines, line, maxScan = 40000, bt = null) {
  if (!Array.isArray(lines) || !(line >= 0) || line >= lines.length) return ''
  const counts = bt || backtickCounts(lines)
  for (let i = line; i >= 0 && i >= line - maxScan; i--) {
    const s = lines[i]
    if (!s || /^[\s}\])]/.test(s) || /^\/[/*]/.test(s)) continue
    if ((counts[line] - counts[i]) % 2 === 1) continue
    const m = s.match(TOP_DECLARATION)
    return m ? m[1] : s.trim().slice(0, 48)
  }
  return ''
}

/** topOf for attributeProfile and frameLabel, over the bundle's files
 *  ({ 'index.js': text, 'chunks/<name>.js': text }, as main-inspector reads
 *  them from out/main): a frame whose script url ends with out/main/<file>
 *  gets its top-level name in that file; other frames none. A url that is not
 *  valid percent-encoding is matched as it is. Memoized. */
function topLevelNamer(files, base = 'out/main/') {
  const lines = new Map(Object.entries(files || {}).map(([k, text]) => {
    const l = String(text || '').split(/\r?\n/)
    return [base + k.replace(/\\/g, '/'), { lines: l, bt: backtickCounts(l) }]
  }))
  const memo = new Map()
  return (cf) => {
    if (!cf || !cf.url) return ''
    let url = String(cf.url)
    try { url = decodeURI(url) } catch { /* a stray %: match it as it is */ }
    url = url.replace(/\\/g, '/')
    const key = `${url}:${cf.lineNumber}`
    if (memo.has(key)) return memo.get(key)
    let name = ''
    for (const [suffix, f] of lines) if (url.endsWith('/' + suffix)) { name = topLevelName(f.lines, cf.lineNumber, 40000, f.bt); break }
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
  MB, normalizeRow, parseSampleText, procKey, cpuPercent, cpuSample, ratePerSec, mean, percentile, summarizeByRole,
  appCpuByRole, metricsObject, perfMetricsDelta, profileSelfTimes, attributeProfile, functionTimes, frameLabel,
  unescapedBackticks, backtickCounts, topLevelName, topLevelNamer, markdownTable, fixed,
}
