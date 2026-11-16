// Performance harness (scripts/perf, see README.md): read the app's MAIN process through its Node
// inspector, on the port launch.js starts the installed app with (--inspect, default 9229).
//
// Reads only. A snapshot is: the app's own list of its processes with their CPU and memory
// (app.getAppMetrics: it names each utility process by the serviceName it was forked with, which the
// command line does not show), which process draws which window (webContents), the kinds of handle
// keeping main's loop alive, and main's memory. A profile is a sampling CPU profile of main (its busy
// share is the main thread's: Electron runs Node's loop inside its own, so
// performance.eventLoopUtilization reads zero there). Main is bundled (out/main/index.js and its
// chunks) but neither minified nor source-mapped, so function names, and the top-level function or
// class each frame sits in (`sources`), are how report.cjs attributes it to services (service-map.json).
//
//   node main-inspector.cjs snapshot <out.json>
//   node main-inspector.cjs profile <seconds> <out.cpuprofile>
//   node main-inspector.cjs sources <out.json>   the main bundle's files, for naming frames
//   env CCC_PERF_INSPECT_PORT (default 9229)
'use strict'

const fs = require('fs')
const { Cdp, getJson, sleep } = require('./cdp-sample.cjs')

const port = () => Number(process.env.CCC_PERF_INSPECT_PORT) || 9229

async function withMain(fn, p = port()) {
  const list = await getJson(`http://127.0.0.1:${p}/json/list`)
  const target = list.find((t) => t.webSocketDebuggerUrl)
  if (!target) throw new Error(`no inspector target on port ${p}`)
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl)
  try { return await fn(cdp) } finally { cdp.close() }
}

/** An expression in main, with `require` (main's own) in scope. */
async function mainEval(cdp, body) {
  const expression = `(async () => { const require = process.mainModule ? process.mainModule.require.bind(process.mainModule) : globalThis.require; ${body} })()`
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true })
  if (r.exceptionDetails) throw new Error('main: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text))
  return r.result ? r.result.value : undefined
}

const SNAPSHOT = `
const { app, webContents, BrowserWindow } = require('electron')
const appMetrics = app.getAppMetrics().map((m) => ({
  pid: m.pid, type: m.type, name: m.name || null, serviceName: m.serviceName || null, creationTime: m.creationTime,
  cpuSec: m.cpu ? m.cpu.cumulativeCPUUsage : null, cpuPercent: m.cpu ? m.cpu.percentCPUUsage : null,
  idleWakeupsPerSecond: m.cpu ? m.cpu.idleWakeupsPerSecond : null,
  privateKb: m.memory ? m.memory.privateBytes : null, workingSetKb: m.memory ? m.memory.workingSetSize : null,
}))
const wcs = webContents.getAllWebContents().map((w) => {
  let pid = null; try { pid = w.getOSProcessId() } catch {}
  let visible = null; try { const bw = BrowserWindow.fromWebContents(w); visible = bw ? bw.isVisible() : null } catch {}
  return { id: w.id, type: w.getType(), url: String(w.getURL()).slice(0, 160), pid, visible }
})
const resources = {}
try { for (const r of process.getActiveResourcesInfo()) resources[r] = (resources[r] || 0) + 1 } catch {}
const mem = process.memoryUsage()
return { t: Date.now(), pid: process.pid, appMetrics, webContents: wcs, resources, mem: { rssMb: mem.rss / 1048576, heapUsedMb: mem.heapUsed / 1048576, externalMb: mem.external / 1048576 } }
`

async function snapshot(p = port()) { return withMain((cdp) => mainEval(cdp, SNAPSHOT), p) }

async function profile(seconds, p = port()) {
  return withMain(async (cdp) => {
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 1000 })
    await cdp.send('Profiler.start')
    await sleep(seconds * 1000)
    const r = await cdp.send('Profiler.stop', {}, 120000)
    await cdp.send('Profiler.disable').catch(() => {})
    return r.profile
  }, p)
}

/** The main bundle's files ({ 'index.js': text, 'chunks/<name>.js': text }), read from
 *  out/main inside app.asar (Electron's fs reads it). */
async function sources(p = port()) {
  return withMain((cdp) => mainEval(cdp, `
    const fs = require('fs'); const path = require('path')
    const dir = path.dirname(process.mainModule.filename)
    const files = {}
    for (const sub of ['', 'chunks']) {
      let names = []; try { names = fs.readdirSync(path.join(dir, sub)) } catch {}
      for (const n of names) if (n.endsWith('.js')) files[sub ? sub + '/' + n : n] = fs.readFileSync(path.join(dir, sub, n), 'utf8')
    }
    return { dir, files }`), p)
}

module.exports = { snapshot, profile, sources }

if (require.main === module) {
  const [cmd, a1, a2] = process.argv.slice(2)
  const run = {
    snapshot: async () => { fs.writeFileSync(a1, JSON.stringify(await snapshot())); console.log('wrote ' + a1) },
    profile: async () => { fs.writeFileSync(a2, JSON.stringify(await profile(Number(a1) || 60))); console.log('wrote ' + a2) },
    sources: async () => { const s = await sources(); fs.writeFileSync(a1, JSON.stringify(s.files)); console.log(`wrote ${a1} (${Object.keys(s.files).length} files from ${s.dir})`) },
  }[cmd]
  if (!run) { console.error('usage: node main-inspector.cjs snapshot <out> | profile <seconds> <out> | sources <out>'); process.exit(64) }
  run().then(() => process.exit(0), (e) => { console.error(e && e.stack ? e.stack : e); process.exit(1) })
}
