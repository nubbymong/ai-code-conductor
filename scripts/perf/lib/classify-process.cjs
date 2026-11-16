// Performance harness: which process is which (scripts/perf, see README.md).
//
// Pure functions over process rows as sample-processes.ps1 writes them
// ({ pid, ppid, name, created, cmd }). Nothing here reads the disk or starts
// anything, so the unit suite runs it on any machine
// (tests/unit/scripts/perf-classify-process.test.ts).
//
// A role comes from the command line first. Electron starts every utility
// process with the same command line (--type=utility
// --utility-sub-type=node.mojom.NodeService), so the three service workers
// (ccc-hooks-gateway, ccc-transcripts, ccc-tokenomics) are told apart by
// their pid instead: the app's own process list (app.getAppMetrics names a
// utility process by the serviceName it was forked with) and the Services
// rows (each supervised row carries its worker's pid).
'use strict'

/** The serviceName each supervised worker is forked with (the fork-*.ts files under src/main). */
const UTILITY_SERVICES = Object.freeze({
  hooks: 'ccc-hooks-gateway',
  logging: 'ccc-transcripts',
  tokenomics: 'ccc-tokenomics',
})

/** Every role, with the name the report prints for it. */
const ROLE_LABEL = Object.freeze({
  main: 'Main process',
  renderer: 'Renderer (app window)',
  'renderer-other': 'Renderer (other)',
  gpu: 'GPU process',
  network: 'Network service',
  'utility:ccc-hooks-gateway': 'Hooks gateway worker',
  'utility:ccc-transcripts': 'Session logging worker',
  'utility:ccc-tokenomics': 'Tokenomics worker',
  utility: 'Utility (other)',
  crashpad: 'Crash reporter',
  'helper-hold': 'Session helper (holder)',
  helper: 'Session helper',
  'pty-host': 'Console host (per terminal)',
  shell: 'Shell (per terminal)',
  'fake-claude': 'Fake Claude CLI (per session)',
  node: 'Node (other)',
  'vision-chrome': 'Vision browser',
  chrome: 'Chrome (other)',
  defender: 'Microsoft Defender (confounder)',
  wmi: 'WMI provider (sampler cost)',
  harness: 'Harness (sampler, runner)',
  other: 'Other',
})

const lower = (s) => String(s || '').toLowerCase()

/** The value of a `--name=value` switch on a command line, or null. */
function switchValue(cmd, name) {
  const m = String(cmd || '').match(new RegExp('(?:^|[\\s"])--' + name.replace(/[-]/g, '\\-') + '=("[^"]*"|[^\\s"]+)'))
  if (!m) return null
  return m[1].replace(/^"|"$/g, '')
}

/**
 * The role of one process.
 *  proc: { pid, name, cmd }
 *  ctx:  { utilityNames?: Map<pid, serviceName>, appRendererPids?: Set<pid>,
 *          stageRoot?: string, harnessPids?: Set<pid> }
 */
function classifyProcess(proc, ctx = {}) {
  const name = lower(proc && proc.name)
  const cmd = String((proc && proc.cmd) || '')
  const pid = proc && proc.pid
  if (ctx.harnessPids && ctx.harnessPids.has(pid)) return 'harness'
  if (name === 'ai code conductor.exe' || name === 'ai code conductor' || name === 'electron.exe') {
    const type = switchValue(cmd, 'type')
    if (!type) return 'main'
    if (type === 'renderer') {
      // Without the app's list of its windows, every renderer is the app's.
      if (!ctx.appRendererPids || ctx.appRendererPids.size === 0) return 'renderer'
      return ctx.appRendererPids.has(pid) ? 'renderer' : 'renderer-other'
    }
    if (type === 'gpu-process') return 'gpu'
    if (type === 'crashpad-handler') return 'crashpad'
    if (type === 'utility') {
      const sub = lower(switchValue(cmd, 'utility-sub-type'))
      if (sub === 'network.mojom.networkservice') return 'network'
      const named = ctx.utilityNames && ctx.utilityNames.get(pid)
      const known = Object.values(UTILITY_SERVICES)
      if (named && known.includes(named)) return 'utility:' + named
      for (const s of known) if (cmd.includes(s)) return 'utility:' + s
      return 'utility'
    }
    return 'other'
  }
  if (name === 'aicc-helper.exe' || name === 'aicc-helper') {
    // `hold` is a holder; `hold --detach` only starts one and exits.
    return /(?:^|\s|")hold(?:\s|$)/.test(cmd) && !/\s--detach(?:\s|$)/.test(cmd) ? 'helper-hold' : 'helper'
  }
  if (name === 'conhost.exe' || name === 'openconsole.exe') return 'pty-host'
  if (name === 'powershell.exe' || name === 'pwsh.exe' || name === 'cmd.exe') return 'shell'
  if (name === 'node.exe' || name === 'node') {
    if (/fake-claude\.js/i.test(cmd)) return 'fake-claude'
    return 'node'
  }
  if (name === 'chrome.exe') {
    if (ctx.stageRoot && lower(cmd).includes(lower(ctx.stageRoot))) return 'vision-chrome'
    return 'chrome'
  }
  if (name === 'msmpeng.exe') return 'defender'
  if (name === 'wmiprvse.exe') return 'wmi'
  return 'other'
}

/**
 * The app's main process among the rows: the recorded pid when it is there,
 * else the one app process without a --type whose parent is not an app
 * process. Null when there is none.
 */
function findMainPid(procs, recordedPid) {
  const isApp = (p) => /^(ai code conductor(\.exe)?|electron\.exe)$/.test(lower(p.name))
  if (recordedPid && procs.some((p) => p.pid === recordedPid && isApp(p))) return recordedPid
  const apps = procs.filter(isApp)
  const ids = new Set(apps.map((p) => p.pid))
  const roots = apps.filter((p) => !switchValue(p.cmd, 'type') && !ids.has(p.ppid))
  return roots.length === 1 ? roots[0].pid : null
}

/**
 * The pids in the tree under `rootPid` (the root included). A child counts
 * only when it started no earlier than its parent: Windows reuses process
 * ids, and a stale parent id must not pull an unrelated process in.
 * `procs` rows: { pid, ppid, created } (created in ms).
 */
function processTree(procs, rootPid) {
  const byParent = new Map()
  const byPid = new Map()
  for (const p of procs) {
    byPid.set(p.pid, p)
    if (!byParent.has(p.ppid)) byParent.set(p.ppid, [])
    byParent.get(p.ppid).push(p)
  }
  const tree = new Set()
  const root = byPid.get(rootPid)
  if (!root) return tree
  tree.add(rootPid)
  const queue = [root]
  while (queue.length) {
    const parent = queue.shift()
    for (const child of byParent.get(parent.pid) || []) {
      if (tree.has(child.pid) || child.pid === parent.pid) continue
      if (Number.isFinite(child.created) && Number.isFinite(parent.created) && child.created < parent.created) continue
      tree.add(child.pid)
      queue.push(child)
    }
  }
  return tree
}

/**
 * The context classifyProcess needs, from what the run recorded: the app's
 * own process list (main-inspector snapshot), its Services rows (cdp-sample
 * snapshot) and the stage root.
 *   appMetrics: [{ pid, type, name }]   (app.getAppMetrics)
 *   webContents: [{ pid, url, type }]   (webContents.getAllWebContents)
 *   services: [{ id, pid }]             (the Services rows)
 */
function contextFrom({ appMetrics = [], webContents = [], services = [], stageRoot, harnessPids } = {}) {
  const utilityNames = new Map()
  for (const m of appMetrics) {
    if (m && Number.isInteger(m.pid) && /utility/i.test(String(m.type || '')) && m.name) utilityNames.set(m.pid, String(m.name))
  }
  for (const s of services) {
    const svc = s && UTILITY_SERVICES[s.id]
    if (svc && Number.isInteger(s.pid) && s.pid > 0) utilityNames.set(s.pid, svc)
  }
  const appRendererPids = new Set()
  for (const w of webContents) {
    if (w && Number.isInteger(w.pid) && w.pid > 0 && /renderer[\\/]index\.html/i.test(String(w.url || ''))) appRendererPids.add(w.pid)
  }
  return { utilityNames, appRendererPids, stageRoot, harnessPids: harnessPids || new Set() }
}

/** The role of one entry of the app's own process list (app.getAppMetrics:
 *  { pid, type: Browser | Tab | GPU | Utility | ..., name, serviceName }), in
 *  the same terms as classifyProcess. ctx as contextFrom gives it. */
function roleOfAppMetric(m, ctx = {}) {
  const type = String((m && m.type) || '')
  if (type === 'Browser') return 'main'
  if (type === 'GPU') return 'gpu'
  if (type === 'Tab') {
    if (!ctx.appRendererPids || ctx.appRendererPids.size === 0) return 'renderer'
    return ctx.appRendererPids.has(m.pid) ? 'renderer' : 'renderer-other'
  }
  if (type === 'Utility') {
    if (String(m.serviceName || '') === 'network.mojom.NetworkService') return 'network'
    const named = (ctx.utilityNames && ctx.utilityNames.get(m.pid)) || m.name
    return Object.values(UTILITY_SERVICES).includes(named) ? 'utility:' + named : 'utility'
  }
  return 'other'
}

module.exports = { UTILITY_SERVICES, ROLE_LABEL, switchValue, classifyProcess, findMainPid, processTree, contextFrom, roleOfAppMetric }
