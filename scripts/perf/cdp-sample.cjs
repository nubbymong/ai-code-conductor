// Performance harness (scripts/perf, see README.md): read the app's renderer over the Chrome DevTools
// Protocol, on the debug port launch.js starts the installed app with (--remote-debugging-port).
//
// Raw CDP over Node's own WebSocket (Node 22 and later), not Playwright: nothing to install on the VM,
// and no domain is switched on beyond the ones a reading needs (Playwright enables several on attach).
// Reads only, except what a run needs: the reduced-motion A/B sets an emulated media feature for its
// second half (CDP drops it when the session detaches), `resume` presses the start-up prompt's Resume
// button and `open` clicks each session card once, as a person would (a resumed tab starts its
// terminal only when it is first opened).
//
//   node cdp-sample.cjs window <seconds> <out.json>     Performance.getMetrics over one held session, plus the Services rows
//   node cdp-sample.cjs profile <seconds> <out.cpuprofile>
//   node cdp-sample.cjs ab <seconds> <out.json>         the same window twice: as is, then prefers-reduced-motion: reduce
//   node cdp-sample.cjs resume [timeoutSec]             press Resume on the "Resume previous sessions?" prompt
//   node cdp-sample.cjs open <n>                        open every resumed session once; wait for n terminals
//   env CCC_PERF_PORT (default 9333)
'use strict'

const fs = require('fs')
const http = require('http')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function getJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let b = ''
      res.on('data', (c) => { b += c })
      res.on('end', () => { try { resolve(JSON.parse(b)) } catch (e) { reject(e) } })
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout reading ${url}`)))
    req.on('error', reject)
  })
}

/** One CDP connection: send(method, params) -> result; on(event, fn). */
class Cdp {
  static async connect(wsUrl, timeoutMs = 10000) {
    if (typeof WebSocket !== 'function') throw new Error('this Node has no WebSocket (Node 22 or later is needed)')
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP: connect timed out')), timeoutMs)
      ws.onopen = () => { clearTimeout(t); resolve() }
      ws.onerror = (e) => { clearTimeout(t); reject(new Error('CDP: ' + ((e && e.message) || 'connect failed'))) }
    })
    return new Cdp(ws)
  }

  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    ws.onmessage = (ev) => {
      let m
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) } catch { return }
      if (m.id !== undefined && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)
        this.pending.delete(m.id)
        if (m.error) p.reject(new Error(`CDP ${p.method}: ${m.error.message}`))
        else p.resolve(m.result)
      } else if (m.method) {
        for (const fn of this.listeners.get(m.method) || []) fn(m.params)
      }
    }
    ws.onclose = () => { for (const p of this.pending.values()) p.reject(new Error('CDP: connection closed')); this.pending.clear() }
  }

  send(method, params = {}, timeoutMs = 60000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method}: timed out`)) }, timeoutMs)
      this.pending.set(id, { method, resolve: (v) => { clearTimeout(t); resolve(v) }, reject: (e) => { clearTimeout(t); reject(e) } })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, [])
    this.listeners.get(method).push(fn)
  }

  close() { try { this.ws.close() } catch { /* already closed */ } }
}

const port = () => Number(process.env.CCC_PERF_PORT) || 9333

/** The app window's page target (renderer/index.html), not DevTools or another window. */
async function appPage(p = port()) {
  const list = await getJson(`http://127.0.0.1:${p}/json/list`)
  const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  const page = pages.find((t) => /renderer\/index\.html/.test(t.url)) || pages.find((t) => !/^devtools:/.test(t.url))
  if (!page) throw new Error(`no app page on port ${p}`)
  return page
}

async function withPage(fn, p = port()) {
  const cdp = await Cdp.connect((await appPage(p)).webSocketDebuggerUrl)
  try { return await fn(cdp) } finally { cdp.close() }
}

/** An expression in the app page (awaited, returned by value). */
async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error('page: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text))
  return r.result ? r.result.value : undefined
}

/** The Services rows (pid, state, counts, the measured block) and what the window shows. */
const PAGE_STATE = `(async () => {
  let services = null
  try {
    const snap = await window.electronAPI.serviceHealth.get()
    services = (snap && snap.services || []).map((s) => ({ id: s.id, host: s.host, state: s.state, pid: s.pid, eventsTotal: s.eventsTotal, throughputPerSec: s.throughputPerSec, restartCount: s.restartCount, mainLoopStallsLastMin: s.mainLoopStallsLastMin, childLoopStallsLastMin: s.childLoopStallsLastMin, measured: s.measured || null, heldSessions: s.heldSessions }))
  } catch (e) { services = { error: String(e && e.message || e) } }
  const running = document.querySelector('[data-testid="panel-tab-running"]')
  return { services, terminals: document.querySelectorAll('.xterm').length, runningTab: running ? running.innerText.replace(/\\s+/g, ' ').trim() : null, visibility: document.visibilityState }
})()`

async function pageState(cdp) { return evaluate(cdp, PAGE_STATE) }

/**
 * One measured window on one held session: Performance.getMetrics at its
 * start and end (the renderer counts task time only while a session has the
 * Performance domain on, so both readings must come from the same session),
 * and the Services rows at both ends.
 */
async function measureWindow(seconds, p = port()) {
  return withPage(async (cdp) => {
    await cdp.send('Performance.enable', { timeDomain: 'timeTicks' })
    const start = { t: Date.now(), metrics: (await cdp.send('Performance.getMetrics')).metrics, page: await pageState(cdp) }
    await sleep(seconds * 1000)
    const end = { t: Date.now(), metrics: (await cdp.send('Performance.getMetrics')).metrics, page: await pageState(cdp) }
    await cdp.send('Performance.disable').catch(() => {})
    return { kind: 'renderer-window', seconds, start, end }
  }, p)
}

/** A sampling CPU profile of the app window's renderer (1 ms interval). */
async function profile(seconds, p = port()) {
  return withPage(async (cdp) => {
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 1000 })
    await cdp.send('Profiler.start')
    await sleep(seconds * 1000)
    const r = await cdp.send('Profiler.stop', {}, 120000)
    await cdp.send('Profiler.disable').catch(() => {})
    return r.profile
  }, p)
}

/**
 * The reduced-motion A/B: the same held session measures `seconds` as the
 * page is, then `seconds` with prefers-reduced-motion: reduce emulated (the
 * app's always-on sidebar animations stop under it). onSwitch(t) is told the
 * moment the second half starts, so the process samples can be split there.
 */
async function reducedMotionAB(seconds, onSwitch, p = port()) {
  return withPage(async (cdp) => {
    await cdp.send('Performance.enable', { timeDomain: 'timeTicks' })
    const read = async () => ({ t: Date.now(), metrics: (await cdp.send('Performance.getMetrics')).metrics })
    const a0 = await read()
    await sleep(seconds * 1000)
    const a1 = await read()
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    const matches = await evaluate(cdp, `matchMedia('(prefers-reduced-motion: reduce)').matches`)
    if (onSwitch) onSwitch(Date.now())
    const b0 = await read()
    await sleep(seconds * 1000)
    const b1 = await read()
    await cdp.send('Emulation.setEmulatedMedia', { features: [] }).catch(() => {})
    await cdp.send('Performance.disable').catch(() => {})
    return { kind: 'reduced-motion-ab', seconds, reduceMatched: matches, asIs: { start: a0, end: a1 }, reduced: { start: b0, end: b1 } }
  }, p)
}

/** Press Resume on the start-up prompt; waits for it up to timeoutSec. */
async function resume(timeoutSec = 90, p = port()) {
  const deadline = Date.now() + timeoutSec * 1000
  let last = null
  while (Date.now() < deadline) {
    try {
      last = await withPage((cdp) => evaluate(cdp, `(() => {
        const visible = (e) => !!(e && e.getClientRects().length);
        for (const b of document.querySelectorAll('button')) { const t = (b.textContent || '').trim(); if ((t === 'Later' || t === 'Not now') && visible(b)) b.click() }
        const text = document.body ? document.body.innerText : '';
        if (!/resume previous sessions/i.test(text)) return { shown: false };
        const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Resume' && visible(b));
        if (!btn) return { shown: true, clicked: false };
        btn.click();
        return { shown: true, clicked: true };
      })()`), p)
      if (last && last.clicked) return last
    } catch (e) { last = { error: e.message } }
    await sleep(2000)
  }
  return last || { shown: false }
}

/**
 * Open every resumed session once. A resumed tab starts its terminal only
 * when it is first opened, so Resume alone starts one. This clicks each
 * session card on the Running tab in turn (stepMs apart), then the first
 * again, and waits until `expected` terminals are mounted (or timeoutSec).
 */
async function openAllSessions(expected, { stepMs = 1200, timeoutSec = 180 } = {}, p = port()) {
  const cards = await withPage((cdp) => evaluate(cdp, `(async () => {
    const tab = document.querySelector('[data-testid="panel-tab-running"]'); if (tab) tab.click();
    await new Promise((r) => setTimeout(r, 800));
    const cards = [...document.querySelectorAll('button.session-card')];
    for (const c of cards) { c.click(); await new Promise((r) => setTimeout(r, ${Number(stepMs)})) }
    if (cards[0]) cards[0].click();
    return cards.length;
  })()`), p)
  const deadline = Date.now() + timeoutSec * 1000
  let s = null
  while (Date.now() < deadline) {
    s = await state(p).catch(() => null)
    if (s && s.terminals >= expected) break
    await sleep(3000)
  }
  return { cards, terminals: s ? s.terminals : null, runningTab: s ? s.runningTab : null }
}

/** The page's state now (a short connection). */
async function state(p = port()) { return withPage((cdp) => pageState(cdp), p) }

module.exports = { Cdp, getJson, appPage, evaluate, measureWindow, profile, reducedMotionAB, resume, openAllSessions, state, sleep }

if (require.main === module) {
  const [cmd, a1, a2] = process.argv.slice(2)
  const write = (file, v) => { fs.writeFileSync(file, JSON.stringify(v)); console.log('wrote ' + file) }
  const run = {
    window: async () => write(a2, await measureWindow(Number(a1) || 60)),
    profile: async () => write(a2, await profile(Number(a1) || 60)),
    ab: async () => write(a2, await reducedMotionAB(Number(a1) || 60)),
    resume: async () => console.log(JSON.stringify(await resume(Number(a1) || 90))),
    open: async () => console.log(JSON.stringify(await openAllSessions(Number(a1) || 1))),
    state: async () => console.log(JSON.stringify(await state(), null, 1)),
  }[cmd]
  if (!run) { console.error('usage: node cdp-sample.cjs window|profile|ab <seconds> <out> | resume [timeoutSec] | open <n> | state'); process.exit(64) }
  run().then(() => process.exit(0), (e) => { console.error(e && e.stack ? e.stack : e); process.exit(1) })
}
