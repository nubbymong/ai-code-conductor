/**
 * [host] The performance harness's process roles and main-process service
 * attribution (scripts/perf/lib/classify-process.cjs, scripts/perf/service-map.json,
 * the attribution in scripts/perf/lib/aggregate.cjs).
 *
 * A table of real command lines from the Windows test VM (2.1.3-beta.6,
 * installed app on a staging root) maps to roles; the three service workers,
 * whose command lines are identical, are told apart by the app's own process
 * list and its Services rows; a process tree never takes in a process with a
 * stale parent id; and the committed service map attributes a canned V8
 * profile of a main-like bundle to the expected services, nearest frame
 * first. Pure functions on in-memory data: nothing is read but the service
 * map and the command-line fixture, nothing is written or started.
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'

const PERF = resolve(__dirname, '..', '..', '..', 'scripts', 'perf')
const req = createRequire(join(PERF, 'report.cjs'))
type Proc = { pid: number; ppid?: number; name: string; cmd?: string; created?: number }
const C = req('./lib/classify-process.cjs') as {
  classifyProcess: (p: Proc, ctx?: Record<string, unknown>) => string
  contextFrom: (o: Record<string, unknown>) => Record<string, unknown>
  findMainPid: (procs: Proc[], recorded?: number) => number | null
  processTree: (procs: Proc[], root: number) => Set<number>
  switchValue: (cmd: string, name: string) => string | null
  roleOfAppMetric: (m: { pid: number; type: string; name?: string | null; serviceName?: string | null }, ctx?: Record<string, unknown>) => string
  ROLE_LABEL: Record<string, string>
}
const A = req('./lib/aggregate.cjs') as {
  attributeProfile: (profile: unknown, map: unknown, o?: Record<string, unknown>) => { totalMs: number; idleMs: number; gcMs: number; unattributedMs: number; byService: Record<string, number>; topUnattributed: Array<{ frame: string; ms: number }> }
  topLevelName: (lines: string[], line: number) => string
  topLevelNamer: (files: Record<string, string>) => (cf: { url?: string; lineNumber?: number }) => string
  unescapedBackticks: (s: string) => number
}
const SERVICE_MAP = JSON.parse(readFileSync(join(PERF, 'service-map.json'), 'utf8'))

// Real command lines from the VM (tests/fixtures/perf/vm-cmdlines.json): the
// installed 2.1.3-beta.6 on a staging root.
const VM = JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'fixtures', 'perf', 'vm-cmdlines.json'), 'utf8')) as Record<string, string>
const APP = 'C:\\Users\\User\\AppData\\Local\\Programs\\AI Code Conductor\\AI Code Conductor.exe'
const STAGE = 'C:\\Users\\User\\b7p-smoke'
const UD = `--user-data-dir="${STAGE}\\data\\electron-userdata"`
// The helper is off in the harness runs, so its two lines are built from its
// own argument order (helper/src/main.rs: `hold --detach` starts a holder,
// which runs as `hold --store ... --session ...`); the other Chrome is a plain
// one; Defender's command line is not readable.
const HELPER = '"C:\\Users\\User\\AppData\\Local\\Programs\\AI Code Conductor\\resources\\helper\\aicc-helper.exe"'
const LINES: Array<[string, Proc]> = [
  ['main', { pid: 100, name: 'AI Code Conductor.exe', cmd: VM.main }],
  ['renderer', { pid: 110, name: 'AI Code Conductor.exe', cmd: VM.renderer }],
  ['gpu', { pid: 111, name: 'AI Code Conductor.exe', cmd: VM.gpu }],
  ['network', { pid: 112, name: 'AI Code Conductor.exe', cmd: VM.network }],
  ['utility:ccc-tokenomics', { pid: 120, name: 'AI Code Conductor.exe', cmd: VM.nodeService }],
  ['utility:ccc-transcripts', { pid: 121, name: 'AI Code Conductor.exe', cmd: VM.nodeService }],
  ['utility:ccc-hooks-gateway', { pid: 122, name: 'AI Code Conductor.exe', cmd: VM.nodeService }],
  ['helper-hold', { pid: 130, name: 'aicc-helper.exe', cmd: `${HELPER} hold --store ${STAGE}\\data\\home\\AppData\\Local\\aicc-helper\\store --session 4f1c2b3a --label infra --away 120 --ring-bytes 1048576` }],
  ['helper', { pid: 131, name: 'aicc-helper.exe', cmd: `${HELPER} hold --detach --store ${STAGE}\\data\\home\\AppData\\Local\\aicc-helper\\store --session 4f1c2b3a` }],
  ['pty-host', { pid: 140, name: 'conhost.exe', cmd: VM.conhost }],
  ['shell', { pid: 141, name: 'powershell.exe', cmd: VM.powershell }],
  ['shell', { pid: 142, name: 'cmd.exe', cmd: VM.claudeCmd }],
  ['fake-claude', { pid: 143, name: 'node.exe', cmd: VM.fakeClaude }],
  // The app's short probes of the same CLI are not sessions (they would count as live ones).
  ['node', { pid: 144, name: 'node.exe', cmd: VM.fakeClaude.replace(/--resume .*$/, '--version') }],
  ['node', { pid: 145, name: 'node.exe', cmd: VM.fakeClaude.replace(/--resume .*$/, 'auth status') }],
  ['vision-chrome', { pid: 150, name: 'chrome.exe', cmd: VM.visionChrome }],
  ['chrome', { pid: 151, name: 'chrome.exe', cmd: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --type=renderer' }],
  ['defender', { pid: 160, name: 'MsMpEng.exe', cmd: '' }],
  ['wmi', { pid: 161, name: 'WmiPrvSE.exe', cmd: VM.wmi }],
]

describe('roles from real command lines', () => {
  const ctx = C.contextFrom({
    // app.getAppMetrics names a utility process by the serviceName it was forked with...
    appMetrics: [{ pid: 120, type: 'Utility', name: 'ccc-tokenomics' }, { pid: 112, type: 'Utility', name: 'Network Service' }, { pid: 110, type: 'Tab' }],
    // ...and a Services row carries its worker's pid.
    services: [{ id: 'logging', pid: 121 }, { id: 'hooks', pid: 122 }, { id: 'mcp', pid: null }],
    webContents: [{ pid: 110, url: 'file:///C:/Users/User/AppData/Local/Programs/AI%20Code%20Conductor/resources/app.asar/out/renderer/index.html' }],
    stageRoot: STAGE,
  })

  it.each(LINES)('%s', (role, proc) => {
    expect(C.classifyProcess(proc, ctx)).toBe(role)
    expect(C.ROLE_LABEL[role], `no label for ${role}`).toBeTruthy()
  })

  it('cannot tell the service workers apart by command line alone', () => {
    const bare = C.contextFrom({})
    for (const pid of [120, 121, 122]) expect(C.classifyProcess(LINES.find(([, p]) => p.pid === pid)![1], bare)).toBe('utility')
  })

  it('names a second renderer (another window) apart from the app window', () => {
    const other = { pid: 115, name: 'AI Code Conductor.exe', cmd: VM.renderer.replace('--renderer-client-id=4', '--renderer-client-id=9') }
    expect(C.classifyProcess(other, ctx)).toBe('renderer-other')
  })

  it("names the app's own process list in the same roles", () => {
    // The entries as app.getAppMetrics gave them on the VM (2.1.3-beta.6).
    const list: Array<[string, { pid: number; type: string; name?: string | null; serviceName?: string | null }]> = [
      ['main', { pid: 100, type: 'Browser', name: null, serviceName: null }],
      ['gpu', { pid: 111, type: 'GPU', name: null, serviceName: 'GPU' }],
      ['network', { pid: 112, type: 'Utility', name: 'Network Service', serviceName: 'network.mojom.NetworkService' }],
      ['renderer', { pid: 110, type: 'Tab', name: null, serviceName: null }],
      ['renderer-other', { pid: 115, type: 'Tab', name: null, serviceName: null }],
      ['utility:ccc-tokenomics', { pid: 120, type: 'Utility', name: 'ccc-tokenomics', serviceName: 'node.mojom.NodeService' }],
      ['utility:ccc-transcripts', { pid: 121, type: 'Utility', name: null, serviceName: 'node.mojom.NodeService' }], // named by its Services row
      ['utility', { pid: 129, type: 'Utility', name: 'Node Utility Process', serviceName: 'node.mojom.NodeService' }],
    ]
    for (const [role, m] of list) expect(C.roleOfAppMetric(m, ctx), `${m.type} ${m.pid}`).toBe(role)
  })

  it('names the harness by pid before anything else', () => {
    const h = C.contextFrom({ harnessPids: new Set([143]) })
    expect(C.classifyProcess(LINES.find(([, p]) => p.pid === 143)![1], h)).toBe('harness')
  })

  it('reads a quoted switch value', () => {
    expect(C.switchValue(VM.renderer, 'user-data-dir')).toBe(`${STAGE}\\data\\electron-userdata`)
    expect(C.switchValue(`"${APP}" --type=renderer ${UD}`, 'type')).toBe('renderer')
    expect(C.switchValue(VM.main, 'type')).toBeNull()
  })
})

describe('the app tree', () => {
  const procs: Proc[] = [
    { pid: 100, ppid: 4, name: 'AI Code Conductor.exe', cmd: LINES[0][1].cmd, created: 1_000 },
    { pid: 110, ppid: 100, name: 'AI Code Conductor.exe', cmd: LINES[1][1].cmd, created: 1_100 },
    { pid: 141, ppid: 100, name: 'powershell.exe', created: 2_000 },
    { pid: 142, ppid: 141, name: 'cmd.exe', created: 2_100 },
    { pid: 143, ppid: 142, name: 'node.exe', created: 2_200 },
    // A process whose parent id is 100 from before the app started: pid 100 was reused.
    { pid: 900, ppid: 100, name: 'node.exe', created: 500 },
    { pid: 901, ppid: 900, name: 'conhost.exe', created: 600 },
  ]

  it('finds the main process and takes in its descendants only', () => {
    expect(C.findMainPid(procs)).toBe(100)
    expect([...C.processTree(procs, 100)].sort()).toEqual([100, 110, 141, 142, 143])
  })

  it('prefers the recorded pid', () => {
    expect(C.findMainPid(procs, 100)).toBe(100)
    expect(C.findMainPid([...procs, { pid: 200, ppid: 4, name: 'AI Code Conductor.exe', cmd: `"${APP}"` }])).toBeNull()
  })
})

describe('main-process attribution with the committed service map', () => {
  // A main-like bundle: not minified, its indentation kept.
  const BUNDLE = [
    '"use strict";',                                       // 0
    'const electron = require("electron");',               // 1
    'function stripAnsi(s) {',                             // 2
    '  return s.replace(/\\x1b\\[[0-9;]*m/g, "");',        // 3
    '}',                                                   // 4
    'class WatchdogManager {',                             // 5
    '  constructor(host) {',                               // 6
    '    this.host = host;',                               // 7
    '  }',                                                 // 8
    '  feedData(sessionId, data) {',                       // 9
    '    const tail = stripAnsi(data);',                   // 10
    '    this.entries.forEach((e) => {',                   // 11
    '      e.feed(tail);',                                 // 12
    '    });',                                             // 13
    '  }',                                                 // 14
    '}',                                                   // 15
    'function startStatuslineWatcher(dir) {',              // 16
    '  const pollTimer = setInterval(() => {',             // 17
    '    fanOut(dir);',                                    // 18
    '  }, 1e3);',                                          // 19
    '}',                                                   // 20
    'function unrelatedThing() {',                         // 21
    '  return 1;',                                         // 22
    '}',                                                   // 23
    'function registerPtyHandlers(ipcMain) {',             // 24
    '  ipcMain.handle("pty:write", async (_e, id, d) => {',// 25
    '    return manager.feedData(id, d);',                 // 26
    '  });',                                               // 27
    '}',                                                   // 28
    'class TokenomicsSupervisor {',                        // 29
    '  onMessage(m) {',                                    // 30
    '    this.sup.noteBeat(m);',                           // 31
    '  }',                                                 // 32
    '}',                                                   // 33
    'class LogSupervisor {',                               // 34
    '  flush() {',                                         // 35
    '    return 1;',                                       // 36
    '  }',                                                 // 37
    '}',                                                   // 38
    'class HooksGatewayProxy {',                           // 39
    '  forward(e) {',                                      // 40
    '    return e;',                                       // 41
    '  }',                                                 // 42
    '}',                                                   // 43
    'async function startMcpServer(port) {',               // 44
    '  const server = http.createServer((req, res) => {',  // 45
    '    res.end();',                                      // 46
    '  });',                                               // 47
    '}',                                                   // 48
    'class Supervisor {',                                  // 49
    '  noteBeat(m) {',                                     // 50
    '    this.lastBeat = Date.now();',                     // 51
    '  }',                                                 // 52
    '}',                                                   // 53
    'function buildScript(x) {',                           // 54
    '  const s = `',                                     // 55: a template literal main embeds...
    'if ($x) {',                                           // 56: ...whose lines start in column 0
    '  Write-Host \\`n',                               // 57: an escaped backtick inside it
    '}',                                                   // 58
    '`;',                                                // 59
    '  return s.trim();',                                  // 60
    '}',                                                   // 61
    'app.on("ready", () => {',                             // 62: a top-level statement...
    '  const t = `x`;',                                // 63: ...with a template of its own
    '  startWork();',                                      // 64
    '});',                                                 // 65
  ].join('\n')
  // A chunk the bundler split out (out/main/chunks), as the real build has.
  const CHUNK = ['"use strict";', 'class LoopStallMonitor {', '  tick() {', '    this.prune(Date.now());', '  }', '}'].join('\n')
  const SOURCES = { 'index.js': BUNDLE, 'chunks/loop-stall-monitor-DTsNW8F7.js': CHUNK }
  const URL = 'file:///C:/Users/User/AppData/Local/Programs/AI%20Code%20Conductor/resources/app.asar/out/main/index.js'
  const CHUNK_URL = URL.replace('index.js', 'chunks/loop-stall-monitor-DTsNW8F7.js')
  const f = (functionName: string, lineNumber: number, url = URL) => ({ functionName, url, lineNumber, columnNumber: 0, scriptId: '1' })
  const profile = {
    nodes: [
      { id: 1, callFrame: f('(root)', -1, ''), children: [2, 9, 12, 13, 20, 30, 40, 42, 43, 44, 46] },
      { id: 30, callFrame: f('tick', 2, CHUNK_URL), children: [] }, // a method in a chunk
      { id: 2, callFrame: f('processTimers', 500, 'node:internal/timers'), children: [3] },
      { id: 3, callFrame: f('listOnTimeout', 520, 'node:internal/timers'), children: [4] },
      { id: 4, callFrame: f('', 17), children: [5] },              // the statusline poll arrow
      { id: 5, callFrame: f('readFileSync', 400, 'node:fs'), children: [] },
      { id: 9, callFrame: f('(idle)', -1, ''), children: [] },
      { id: 12, callFrame: f('(garbage collector)', -1, ''), children: [] },
      { id: 13, callFrame: f('unrelatedThing', 21), children: [] },
      { id: 20, callFrame: f('', 25), children: [21] },            // an IPC handler (ipc-handlers)...
      { id: 21, callFrame: f('feedData', 9), children: [22, 23] }, // ...calling the Watchdog
      { id: 22, callFrame: f('stripAnsi', 2), children: [] },
      { id: 23, callFrame: f('', 11), children: [] },              // forEach arrow inside the method
      { id: 40, callFrame: f('onMessage', 30), children: [41] },   // Tokenomics' supervisor...
      { id: 41, callFrame: f('noteBeat', 50), children: [] },      // ...calling the shared Supervisor
      { id: 42, callFrame: f('flush', 35), children: [] },         // session logging
      { id: 43, callFrame: f('forward', 40), children: [] },       // the hooks gateway
      { id: 44, callFrame: f('', 45), children: [] },              // the MCP server's request handler
      { id: 46, callFrame: f('handlePostMessage', 80, 'file:///C:/x/resources/app.asar/node_modules/@modelcontextprotocol/sdk/dist/cjs/server/sse.js'), children: [] },
    ],
    // Each sample lasts until the next one (timeDeltas[i + 1], microseconds).
    samples: [5, 5, 9, 9, 9, 22, 23, 13, 12, 20, 30, 40, 41, 42, 43, 44, 46, 5],
    timeDeltas: [0, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000],
  }

  it('names each frame by the top-level function or class it sits in', () => {
    const lines = BUNDLE.split('\n')
    expect(A.topLevelName(lines, 17)).toBe('startStatuslineWatcher')
    expect(A.topLevelName(lines, 11)).toBe('WatchdogManager')
    expect(A.topLevelName(lines, 2)).toBe('stripAnsi')
    expect(A.topLevelName(lines, 26)).toBe('registerPtyHandlers')
    expect(A.topLevelName(lines, 1)).toBe('electron')
    const topOf = A.topLevelNamer(SOURCES)
    expect(topOf(f('', 17))).toBe('startStatuslineWatcher') // the url's %20 read as a space
    expect(topOf(f('tick', 2, CHUNK_URL))).toBe('LoopStallMonitor')
    expect(topOf(f('readFileSync', 400, 'node:fs'))).toBe('')
    // A url that is not valid percent-encoding is matched as it is, not thrown on.
    expect(topOf(f('', 17, 'file:///C:/odd%zz/resources/app.asar/out/main/index.js'))).toBe('startStatuslineWatcher')
  })

  it('passes over column-0 lines inside a template literal, and still names a top-level statement', () => {
    const lines = BUNDLE.split('\n')
    // Inside the template: '`;' and 'if ($x) {' start in column 0 but are text.
    expect(A.topLevelName(lines, 60)).toBe('buildScript')
    // A top-level statement with a template of its own (an even number of backticks above the frame).
    expect(A.topLevelName(lines, 64)).toBe('app.on("ready", () => {')
    expect(A.topLevelNamer(SOURCES)(f('trim', 60))).toBe('buildScript')
    expect(A.unescapedBackticks('a \\` b ` c')).toBe(1)
  })

  it('attributes the self time to services, the nearest matching frame first', () => {
    const r = A.attributeProfile(profile, SERVICE_MAP, { topOf: A.topLevelNamer(SOURCES) })
    // readFileSync under the statusline arrow: 2 samples of 1 ms (the last sample counts nothing).
    expect(r.byService.statusline).toBeCloseTo(2, 6)
    // stripAnsi 1 ms + the forEach arrow 1 ms; the IPC handler above them is farther away.
    expect(r.byService.watchdog).toBeCloseTo(2, 6)
    // the IPC handler's own frame.
    expect(r.byService['ipc-handlers']).toBeCloseTo(1, 6)
    // the chunk's method, by the class it sits in.
    expect(r.byService['services-panel']).toBeCloseTo(1, 6)
    expect(r.idleMs).toBeCloseTo(3, 6)
    expect(r.gcMs).toBeCloseTo(1, 6)
    expect(r.unattributedMs).toBeCloseTo(1, 6)
    expect(r.topUnattributed[0].frame).toMatch(/^unrelatedThing .*index\.js:22$/)
    // The three service workers' main-side code, and the MCP server (a Services row) by name and by its package.
    expect(r.byService.tokenomics).toBeCloseTo(1, 6)
    expect(r.byService.logging).toBeCloseTo(1, 6)
    expect(r.byService.hooks).toBeCloseTo(1, 6)
    expect(r.byService.mcp).toBeCloseTo(2, 6)
    // The shared Supervisor's own frame is the nearest: its own row, not services-panel and not a guess at which worker.
    expect(r.byService.supervision).toBeCloseTo(1, 6)
    expect(r.totalMs).toBeCloseTo(17, 6)
  })

  it('has a row for every Services registry row that runs in main', () => {
    const ids = (SERVICE_MAP.services as Array<{ id: string }>).map((s) => s.id)
    // src/shared/service-health.ts SERVICE_ID: the helper is its own program and has its connection row.
    for (const id of ['hooks', 'logging', 'tokenomics', 'watchdog', 'mcp', 'session-helper']) expect(ids).toContain(id)
  })

  it('attributes nothing to a service when the bundle source is missing (names alone)', () => {
    const r = A.attributeProfile(profile, SERVICE_MAP, {})
    expect(r.byService.statusline).toBeUndefined()
    expect(r.byService.watchdog).toBeUndefined()
  })
})
