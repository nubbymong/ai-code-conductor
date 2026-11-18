import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { IPty } from 'node-pty'

// node-pty is the usual way: the spy shows every terminal that did NOT go
// through the helper, with the exact arguments it was given.
const ptySpawn = vi.hoisted(() => vi.fn())
vi.mock('node-pty', () => ({ spawn: ptySpawn }))

import { createRequire } from 'module'
import { HELPER_SENTENCES, SessionHelperManager, agentRecordsIn, crashMarkIn, nodePtyCommandLine, offStillHoldingSentence, setSessionHelper, spawnAgentPty, spawnPlainPty, whenHeldKnown } from '../../../src/main/session-helper/manager'
import { HolderConnection } from '../../../src/main/session-helper/connection'
import { HelperPty } from '../../../src/main/session-helper/helper-pty'
import { heldAgentSessionId, heldIdKind, heldSessionId } from '../../../src/main/session-helper/protocol'
import { versionFolderName } from '../../../src/main/session-helper/install'
import { _resetBundledConptyForTest, bundledConptyChoice } from '../../../src/main/bundled-conpty'
import { sessionHelperRow } from '../../../src/main/services/service-registry'
import { FakeHelper, FakeHolder } from './session-helper-fake-holder'

/** What whenHeldKnown answers now, or undefined while it waits. */
function heldNow(p: unknown): boolean | undefined {
  let known: boolean | undefined
  whenHeldKnown(p, (h) => { known = h })
  return known
}

const SHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const CWD = 'C:\\Users\\someone\\project'
const ENV = { Path: 'C:\\Windows', SECRET_TOKEN: 'do-not-put-me-on-a-command-line' }
const opts = (over: Record<string, unknown> = {}) => ({ name: 'xterm-256color', cols: 120, rows: 30, cwd: CWD, env: { ...ENV }, useConpty: true, ...over })
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await tick(5)
  }
}

// Under fake timers (vi.useFakeTimers with setTimeout, clearTimeout and Date):
// the test's clock moves on in steps, and real time passes briefly between
// them, so file reads (the helper copy's hash) and the in-memory streams move
// on too. Real time is the real setTimeout, kept from before any faking, and
// performance.now, which is never faked here.
const realSetTimeout = globalThis.setTimeout
const realWait = (ms: number) => new Promise<void>((r) => { realSetTimeout(r, ms) })
async function step(ms = 50): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await realWait(2)
}
async function stepFor(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 50) await step(50)
}
async function stepUntil(cond: () => boolean, what: string, realMs = 10_000): Promise<void> {
  const end = performance.now() + realMs
  while (!cond()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`)
    await step(50)
  }
}

/** A stand-in for node-pty's terminal, for the usual-way spawns. */
function fakeDirect(): IPty {
  return { pid: 1, cols: 80, rows: 24, process: 'x', handleFlowControl: false, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), resize() {}, clear() {}, write() {}, kill() {}, pause() {}, resume() {} } as unknown as IPty
}

let dir: string
let bundled: string
let root: string
let helper: FakeHelper
const managers: SessionHelperManager[] = []
/** Every start a test began, awaited or not: the teardown waits for them. */
const starts: Promise<unknown>[] = []

/** Managers whose app is gone (a crash): they reach no helper and no holder again. */
const crashed = new WeakSet<SessionHelperManager>()

function makeManager(over: Partial<ConstructorParameters<typeof SessionHelperManager>[0]> = {}): SessionHelperManager {
  let self: SessionHelperManager | undefined
  const alive = () => { if (self && crashed.has(self)) throw new Error('this app is gone') }
  const m = new SessionHelperManager({
    platform: 'win32', root, bundled,
    exec: async (file, args) => { alive(); return helper.exec(file, args) },
    openStream: async (endpoint) => { alive(); return helper.openStream(endpoint) },
    // node-pty's bundled ConPTY is not copied unless a test names a folder for it.
    spawnDirect: (file, args, o) => ptySpawn(file, args, o), newTabId: () => 'newtab0123456789abcdef01', conptySource: () => null, ...over,
  })
  self = m
  managers.push(m)
  const start = m.start.bind(m)
  m.start = (o) => {
    const p = start(o)
    starts.push(p)
    return p
  }
  return m
}

beforeEach(() => {
  ptySpawn.mockReset()
  ptySpawn.mockImplementation(() => fakeDirect())
  dir = mkdtempSync(join(tmpdir(), 'aicc-helper-mgr-'))
  mkdirSync(join(dir, 'install', 'helper'), { recursive: true })
  bundled = join(dir, 'install', 'helper', 'aicc-helper.exe')
  writeFileSync(bundled, 'MZ the installed helper')
  root = join(dir, 'user', 'helper')
  helper = new FakeHelper()
})

afterEach(async () => {
  const quits = managers.splice(0).map((m) => { try { return m.shutdown() } catch { return null } })
  setSessionHelper(null)
  for (const h of helper.holders.values()) h.dropAll()
  // The managers' own work (a start still copying, a self-test still hashing)
  // settles first: on Windows a file still open keeps its folder in use.
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    Promise.allSettled([...quits, ...starts.splice(0)]),
    new Promise<void>((r) => { timer = setTimeout(r, 3000) }),
  ]).finally(() => clearTimeout(timer))
  // Real-time scanning on Windows can hold a just-written .exe for seconds
  // (Windows CI: still busy after 5 s of retries; tests/wp1/fake-cli.test.ts
  // saw the same). A folder that still cannot go is left in this run's own
  // temp folder, which the run's teardown removes: every test makes its own
  // folder, and cleanup of a disposable folder is not a test result.
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 })
  } catch (err) {
    process.stderr.write(`session-helper-manager: left ${dir} behind (${(err as NodeJS.ErrnoException).code ?? String(err)})\n`)
  }
})

/** The app is gone without a quit: its terminals cannot reach their holders
 *  again, and every connection drops; the holders stay. */
function crash(m: SessionHelperManager): void {
  managers.splice(managers.indexOf(m), 1)
  crashed.add(m)
  for (const h of helper.holders.values()) h.dropAll()
}

async function started(m: SessionHelperManager, atStartup = true): Promise<SessionHelperManager> {
  await m.start({ atStartup })
  await until(() => m.serviceState().state === 'ready', 'the helper to be ready')
  return m
}

describe('the switch: off is exactly today\'s launch', () => {
  it('with no helper this run, spawnPlainPty is node-pty\'s spawn with the very same arguments', () => {
    setSessionHelper(null)
    const o = opts()
    const args = ['-NoLogo']
    spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef01' }, SHELL, args, o)
    expect(ptySpawn).toHaveBeenCalledTimes(1)
    expect(ptySpawn.mock.calls[0][0]).toBe(SHELL)
    expect(ptySpawn.mock.calls[0][1]).toBe(args)
    expect(ptySpawn.mock.calls[0][2]).toBe(o)
  })

  it('with the helper switched off again, the same: nothing is held, nothing is run', async () => {
    const m = await started(makeManager())
    setSessionHelper(m)
    m.stopRouting()
    const calls = helper.calls.length
    const o = opts()
    const p = spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef01' }, SHELL, [], o)
    expect(p).not.toBeInstanceOf(HelperPty)
    expect(ptySpawn.mock.calls[0][2]).toBe(o)
    expect(helper.calls.length).toBe(calls)
    expect((await m.status()).helper.state).toBe('off')
  })
})

describe('the branch: on, a plain or partner terminal goes through a holder', () => {
  it('launches with the spawn\'s own argv, folder, environment and size, and the environment never on a command line', async () => {
    const m = await started(makeManager())
    setSessionHelper(m)
    const p = spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef01' }, SHELL, ['-NoLogo'], opts())
    expect(p).toBeInstanceOf(HelperPty)
    expect(ptySpawn).not.toHaveBeenCalled()
    const sid = heldSessionId('abcdef0123456789abcdef01')
    await until(() => !!helper.holders.get(sid)?.attached, 'the terminal to attach')
    const h = helper.holders.get(sid)!
    expect(h.label).toBe('abcdef0123456789abcdef01')
    expect(h.launch).toMatchObject({ t: 'term.launch', argv: [SHELL, '-NoLogo'], cwd: CWD, env: ENV, cols: 120, rows: 30 })
    for (const c of helper.calls) expect(c.args.join(' ')).not.toContain('do-not-put-me-on-a-command-line')
    // Output reaches the tab, input reaches the program, a resize reaches the holder.
    const seen: string[] = []
    p.onData((d) => seen.push(d))
    h.output('hello from the shell\r\n')
    await until(() => seen.join('').includes('hello from the shell'), 'output')
    p.write('dir\r')
    await until(() => Buffer.concat(h.input).toString() === 'dir\r', 'input')
    p.resize(100, 40)
    await until(() => h.size?.cols === 100, 'the resize')
    expect(h.size).toEqual({ cols: 100, rows: 40 })
    // A new terminal, not a take-over: the launch lines are typed at once.
    expect(heldNow(p)).toBe(false)
    expect(heldNow(fakeDirect())).toBe(false)
  })

  it('an elevated tab, a string argument line or an environment the holder would refuse goes the usual way', async () => {
    const m = await started(makeManager())
    setSessionHelper(m)
    expect(spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef01', elevated: true }, SHELL, [], opts())).not.toBeInstanceOf(HelperPty)
    expect(spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef02' }, SHELL, '-NoLogo', opts())).not.toBeInstanceOf(HelperPty)
    expect(spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef03' }, SHELL, [], opts({ env: { http_proxy: 'a', HTTP_PROXY: 'b' } }))).not.toBeInstanceOf(HelperPty)
    expect(spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef04' }, 'powershell.exe', [], opts())).not.toBeInstanceOf(HelperPty)
    // gsudo as the program is an elevated tab, even when the flag did not come along.
    expect(spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef4a' }, 'C:\\Program Files\\gsudo\\Current\\gsudo.exe', [SHELL], opts())).not.toBeInstanceOf(HelperPty)
    expect(ptySpawn).toHaveBeenCalledTimes(5)
    expect(helper.holds()).toBe(0)
  })

  it('a holder that refuses the launch: the terminal starts the usual way, with what was typed meanwhile', async () => {
    const m = await started(makeManager())
    setSessionHelper(m)
    const writes: string[] = []
    ptySpawn.mockImplementation(() => ({ ...fakeDirect(), write: (d: string) => writes.push(d) }))
    const sid = heldSessionId('abcdef0123456789abcdef05')
    // A holder that launched already (busy) refuses this launch.
    helper.holdBusy = true
    const p = spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef05' }, SHELL, [], opts())
    p.write('typed early\r')
    await until(() => ptySpawn.mock.calls.length === 1, 'the usual start')
    expect(writes).toEqual(['typed early\r'])
    expect((p as HelperPty).throughHelper).toBe(false)
    // The refused holder is ended, not left behind.
    await until(() => helper.holders.get(sid)!.ended, 'the refused holder to end')
  })

  it('a Unix terminal gets PWD and TERM as node-pty gives them; Windows keeps the environment as it is', () => {
    const unix = makeManager({ platform: 'linux' }) as unknown as { launchSpec: (f: string, a: string[], o: object) => unknown }
    expect(unix.launchSpec('/bin/bash', ['-l'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: '/home/u', env: { PATH: '/bin', N: undefined } })).toEqual({
      argv: ['/bin/bash', '-l'], cwd: '/home/u', env: { PATH: '/bin', PWD: '/home/u', TERM: 'xterm-256color' }, cols: 80, rows: 24,
    })
    const win = makeManager() as unknown as { launchSpec: (f: string, a: string[], o: object) => unknown }
    expect(win.launchSpec(SHELL, [], opts())).toEqual({ argv: [SHELL], cwd: CWD, env: ENV, cols: 120, rows: 30 })
  })

  it('a record from the helper that is not of this OS shape: nothing is started through it', async () => {
    const m = await started(makeManager({ platform: 'linux', checkEndpointFolder: () => null }))
    const p = m.spawn({ plain: true, sessionId: 'abcdef0123456789abcdef06' }, '/bin/bash', ['-l'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: '/home/u', env: { PATH: '/bin' } })
    expect(p).toBeInstanceOf(HelperPty)
    await until(() => ptySpawn.mock.calls.length === 1, 'the usual start')
    expect((p as HelperPty).throughHelper).toBe(false)
  })
})

describe('the helper copy: checked before every holder start', () => {
  it('a quit while the helper is being set up: no copy is made, and it never reads ready', async () => {
    let answer!: () => void
    let asked = false
    const gate = new Promise<void>((r) => { answer = r })
    const m = makeManager({
      exec: async (file, args) => {
        if (args[0] === 'version') { asked = true; await gate }
        return helper.exec(file, args)
      },
    })
    const starting = m.start({ atStartup: true })
    await until(() => asked, 'the version question')
    expect(m.shutdown()).toBeNull()
    answer()
    await starting
    expect(readdirSync(root).filter((n) => /^0\.1\.0-[0-9a-f]{12}$/.test(n))).toEqual([])
    expect(m.serviceState().state).not.toBe('ready')
  })

  it('is copied into a version folder outside the install folder, and matches', async () => {
    const m = await started(makeManager())
    const status = await m.status()
    expect(status.helper.state).toBe('ready')
    expect(status.helper.version).toBe('0.1.0')
    const folders = readdirSync(root).filter((n) => /^0\.1\.0-[0-9a-f]{12}$/.test(n))
    expect(folders).toHaveLength(1)
    const hold = helper.calls.find((c) => c.args[0] === 'list')!
    expect(hold.file.startsWith(join(root, folders[0]))).toBe(true)
    expect(hold.file.startsWith(join(dir, 'install'))).toBe(false)
  })

  it('a copy that no longer matches is made again once, and the terminal still goes through it', async () => {
    // What the copy holds when the holder starts from it: the installed helper again.
    const atHold: string[] = []
    const m = await started(makeManager({
      exec: async (file, args) => {
        if (args[0] === 'hold') atHold.push(readFileSync(file, 'utf8'))
        return helper.exec(file, args)
      },
    }))
    setSessionHelper(m)
    const folder = readdirSync(root).find((n) => /^0\.1\.0-/.test(n))!
    writeFileSync(join(root, folder, 'aicc-helper.exe'), 'MZ something else')
    const logs: string[] = []
    ;(m as unknown as { deps: { log: (s: string) => void } }).deps.log = (s) => logs.push(s)
    const p = spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef07' }, SHELL, [], opts())
    await until(() => helper.holds() === 1, `the hold (${logs.join(' | ')})`)
    expect(p).toBeInstanceOf(HelperPty)
    expect(atHold).toEqual(['MZ the installed helper'])
    expect((await m.status()).helper.state).toBe('ready')
  })

  it('a second mismatch: the helper reads failed, nothing is started through it, the terminal starts the usual way', async () => {
    const m = await started(makeManager())
    setSessionHelper(m)
    const folder = readdirSync(root).find((n) => /^0\.1\.0-/.test(n))!
    writeFileSync(join(root, folder, 'aicc-helper.exe'), 'MZ something else')
    // The installed file changed under the app: the copy made again cannot match what was checked at start.
    writeFileSync(bundled, 'MZ replaced while running')
    const p = spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef08' }, SHELL, [], opts())
    await until(() => ptySpawn.mock.calls.length === 1, 'the usual start')
    expect(helper.holds()).toBe(0)
    expect((p as HelperPty).throughHelper).toBe(false)
    const status = await m.status()
    expect(status.helper.state).toBe('failed')
    expect(status.helper.detail).toMatch(/does not match/)
    // And the next terminal does not even try.
    expect(spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef09' }, SHELL, [], opts())).not.toBeInstanceOf(HelperPty)
  })

  it('no helper in the installation reads not installed; a failed self-test reads failed until one passes', async () => {
    rmSync(bundled)
    const m = makeManager()
    await m.start({ atStartup: true })
    await until(() => m.serviceState().state === 'not-installed', 'not installed')
    writeFileSync(bundled, 'MZ the installed helper')
    helper.selfTestOk = false
    const m2 = makeManager({ root: join(dir, 'user2', 'helper') })
    await m2.start({ atStartup: true })
    await until(() => m2.serviceState().state === 'failed', 'the failed self-test')
    expect((await m2.status()).helper.selfTest).toMatchObject({ ok: false, detail: expect.stringContaining('local-transport') })
    helper.selfTestOk = true
    expect(await m2.runSelfTest()).toMatchObject({ ok: true })
    expect(m2.serviceState().state).toBe('ready')
  })

  it('a note on the self-test\'s standard error goes in the log line, never in its result (#317)', async () => {
    // What the Windows self-test writes when its job could not be made: it
    // still runs and passes, but what it starts may outlive it.
    // Longer than the 200 characters the log takes of it.
    const NOTE = `aicc-helper: note: what the self-test starts may outlive it: AssignProcessToJobObject (this process): Access is denied. (os error 5)${' and more'.repeat(12)}`
    expect(NOTE.length).toBeGreaterThan(200)
    let note = `${NOTE}\r\nsecond line\r\n`
    const logs: string[] = []
    const m = await started(makeManager({
      exec: async (file, args) => {
        const r = await helper.exec(file, args)
        return args[0] === 'selftest' ? { ...r, stderr: note } : r
      },
      log: (s) => logs.push(s),
    }))
    await until(() => logs.some((l) => l.startsWith('[session-helper] self-test:')), 'the self-test line')
    const line = logs.find((l) => l.startsWith('[session-helper] self-test:'))!
    // Before: the line had no trace of it, so a self-test without its job
    // went unseen. Its first line only, cut to 200 characters.
    expect(line).toBe(`[session-helper] self-test: passed: All 2 checks passed. Its note: ${NOTE.slice(0, 200)}`)
    expect((await m.status()).helper.selfTest).toMatchObject({ ok: true, detail: 'All 2 checks passed.' })
    // With nothing on standard error, the line is as before.
    note = ''
    logs.length = 0
    await m.runSelfTest()
    expect(logs).toContain('[session-helper] self-test: passed: All 2 checks passed.')
  })

  it('old version folders no holder runs from are removed', async () => {
    mkdirSync(join(root, '0.0.9-aaaaaaaaaaaa'), { recursive: true })
    writeFileSync(join(root, '0.0.9-aaaaaaaaaaaa', 'aicc-helper.exe'), 'old')
    mkdirSync(join(root, 'store'), { recursive: true })
    const m = await started(makeManager())
    await until(() => !existsSync(join(root, '0.0.9-aaaaaaaaaaaa')), 'the old folder to go')
    expect(existsSync(join(root, 'store'))).toBe(true)
    expect(m.serviceState().state).toBe('ready')
  })
})

describe('a crash: held terminals come back', () => {
  it('lists and attaches every held terminal at start, and the restored tab shows its scrollback instead of a new shell', async () => {
    // First run: a Terminal only tab and a partner terminal, then the app is gone.
    const first = await started(makeManager())
    setSessionHelper(first)
    spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef10' }, SHELL, [], opts())
    spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef11-partner' }, SHELL, [], opts())
    const plain = heldSessionId('abcdef0123456789abcdef10')
    const partner = heldSessionId('abcdef0123456789abcdef11-partner')
    await until(() => !!helper.holders.get(plain)?.attached && !!helper.holders.get(partner)?.attached, 'both attached')
    helper.holders.get(plain)!.output('PS C:\\> echo before the crash\r\nbefore the crash\r\n')
    crash(first)
    expect(existsSync(join(root, 'app-running.json'))).toBe(true)

    // Second run: every held terminal is attached at once, before any tab asks
    // (the away clock itself is the holder's: helper/src/serve.rs tests it).
    const second = makeManager()
    setSessionHelper(second)
    void second.start({ atStartup: true })
    await until(() => helper.holders.get(plain)!.attaches === 2 && helper.holders.get(partner)!.attaches === 2, 'the keepers')

    // The restored tab with the same id: its terminal again, not a new shell.
    const p = spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef10' }, SHELL, [], opts())
    const seen: string[] = []
    p.onData((d) => seen.push(d))
    // Not known until the take-over attached; then no launch line is typed.
    expect(heldNow(p)).toBeUndefined()
    expect(await (p as HelperPty).adoption).toBe(true)
    expect(heldNow(p)).toBe(true)
    await until(() => seen.join('').includes('before the crash'), 'the replay')
    expect(helper.holds()).toBe(2)
    expect(helper.holders.get(plain)!.requests.filter((r) => r.t === 'term.launch')).toHaveLength(1)
    // The tab's attach replaced the keeper's.
    await until(() => helper.holders.get(plain)!.attaches === 3, 'the tab to replace the keeper')
  })

  it('the held terminals are kept from their records at once, even when the listing fails', async () => {
    const first = await started(makeManager())
    setSessionHelper(first)
    spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef20' }, SHELL, [], opts())
    const sid = heldSessionId('abcdef0123456789abcdef20')
    await until(() => !!helper.holders.get(sid)?.attached, 'attached')
    crash(first)
    helper.listFails = true
    const second = makeManager()
    setSessionHelper(second)
    void second.start({ atStartup: true })
    await until(() => helper.holders.get(sid)!.attaches === 2, 'the keeper')
    const p = spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef20' }, SHELL, [], opts())
    expect(await (p as HelperPty).adoption).toBe(true)
  })

  it('a take-over that cannot reach its holder: a new shell the usual way, and the launch lines are typed', async () => {
    const first = await started(makeManager())
    setSessionHelper(first)
    spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef21' }, SHELL, [], opts())
    const sid = heldSessionId('abcdef0123456789abcdef21')
    await until(() => !!helper.holders.get(sid)?.attached, 'attached')
    crash(first)
    const second = makeManager()
    setSessionHelper(second)
    void second.start({ atStartup: true })
    await until(() => helper.holders.get(sid)!.attaches === 2, 'the keeper')
    // The holder goes after the keeper reached it, before the tab asks.
    const h = helper.holders.get(sid)!
    h.ended = true
    h.dropAll()
    const writes: string[] = []
    ptySpawn.mockImplementation(() => ({ ...fakeDirect(), write: (d: string) => writes.push(d) }))
    const p = spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef21' }, SHELL, [], opts())
    expect(p).toBeInstanceOf(HelperPty)
    expect(await (p as HelperPty).adoption).toBe(false)
    expect(heldNow(p)).toBe(false)
    expect(ptySpawn).toHaveBeenCalledTimes(1)
    // What pty-manager types once it knows goes to the new shell.
    p.write('Set-Location -LiteralPath x\r')
    expect(writes).toEqual(['Set-Location -LiteralPath x\r'])
  })

  it('a take-over the holder will not attach: the same, a new shell and its launch lines', async () => {
    // A holder whose terminal was never launched answers an attach with not-found.
    const store = join(root, 'store')
    const h = new FakeHolder(heldSessionId('abcdef0123456789abcdef22'), 'abcdef0123456789abcdef22', store)
    helper.holders.set(h.sid, h)
    const record = h.record()
    const direct = vi.fn(() => fakeDirect())
    const p = new HelperPty({
      sid: h.sid, label: h.label, adopt: record,
      spec: { argv: [SHELL], cwd: CWD, env: ENV, cols: 80, rows: 24 },
      driver: {
        hold: async () => { throw new Error('not used') },
        connect: (r) => HolderConnection.open({ record: r, os: 'windows', openStream: helper.openStream }),
        direct, ending: () => {}, attachedChanged: () => {}, log: () => {},
      },
    })
    expect(heldNow(p)).toBeUndefined()
    expect(await p.adoption).toBe(false)
    expect(direct).toHaveBeenCalledTimes(1)
    expect(p.throughHelper).toBe(false)
  })

  it('a held terminal no tab shows is listed tabless, and Re-attach opens a Terminal only tab bound to it', async () => {
    const first = await started(makeManager())
    setSessionHelper(first)
    spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef12' }, SHELL, [], opts())
    const sid = heldSessionId('abcdef0123456789abcdef12')
    await until(() => !!helper.holders.get(sid)?.attached, 'attached')
    helper.holders.get(sid)!.output('kept output\r\n')
    crash(first)

    const second = await started(makeManager())
    setSessionHelper(second)
    second.noteSavedTabs([])
    const status = await second.status()
    expect(status.sessions).toEqual([{ id: sid, kind: 'plain', label: 'Terminal', startedAt: helper.holders.get(sid)!.started, attached: false, tabOpen: false }])
    const r = await second.reattach(sid)
    expect(r).toEqual({ ok: true, tab: { id: 'newtab0123456789abcdef01', label: 'Terminal', open: true, partner: false } })
    const p = spawnPlainPty({ plain: true, sessionId: 'newtab0123456789abcdef01' }, SHELL, [], opts())
    const seen: string[] = []
    p.onData((d) => seen.push(d))
    expect(await (p as HelperPty).adoption).toBe(true)
    await until(() => seen.join('').includes('kept output'), 'the replay in the new tab')
    second.noteSavedTabs([{ id: 'newtab0123456789abcdef01', label: 'Terminal' }])
    await until(() => (second as unknown as { live: Map<string, HelperPty> }).live.get(sid)?.isAttached === true, 'attached')
    const after = await second.status()
    expect(after.sessions[0]).toMatchObject({ id: sid, attached: true, tabOpen: true })
    expect(await second.reattach(sid)).toEqual({ ok: false, message: 'That terminal is already showing in a tab.' })
    // Its first tab, if it comes back, starts a terminal of its own and leaves this one alone.
    expect(second.sidFor('abcdef0123456789abcdef12')).not.toBe(sid)
  })

  it('a partner terminal with its tab open: Re-attach brings that tab forward on its partner', async () => {
    const first = await started(makeManager())
    setSessionHelper(first)
    spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef13-partner' }, SHELL, [], opts())
    const sid = heldSessionId('abcdef0123456789abcdef13-partner')
    await until(() => !!helper.holders.get(sid)?.attached, 'attached')
    crash(first)
    const second = await started(makeManager())
    second.noteSavedTabs([{ id: 'abcdef0123456789abcdef13', label: 'API', customName: 'Payments' }])
    const status = await second.status()
    expect(status.sessions[0]).toMatchObject({ id: sid, kind: 'partner', label: 'Payments, partner terminal', attached: false, tabOpen: true })
    expect(await second.reattach(sid)).toEqual({ ok: true, tab: { id: 'abcdef0123456789abcdef13', label: 'Payments, partner terminal', open: false, partner: true } })
  })
})

describe('a normal quit ends every terminal through the helper', () => {
  it('ends the tabs\' holders and the kept ones, and removes the running mark', async () => {
    const m = await started(makeManager())
    setSessionHelper(m)
    spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef14' }, SHELL, [], opts())
    const sid = heldSessionId('abcdef0123456789abcdef14')
    await until(() => !!helper.holders.get(sid)?.attached, 'attached')
    const done = m.shutdown()
    // The mark goes at once: a normal quit, so nothing is taken over next time.
    expect(existsSync(join(root, 'app-running.json'))).toBe(false)
    expect(done).not.toBeNull()
    await done
    expect(helper.holders.get(sid)!.ended).toBe(true)
    // And nothing new goes through the helper after the quit began.
    expect(spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef1f' }, SHELL, [], opts())).not.toBeInstanceOf(HelperPty)
  })

  it('a quit with nothing through the helper waits for nothing', async () => {
    const m = await started(makeManager())
    expect(m.shutdown()).toBeNull()
  })

  it('a quit right after a crash start: the keepers still connecting are ended once they are up, and the quit\'s answer waits for them', async () => {
    const first = await started(makeManager())
    setSessionHelper(first)
    spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef23' }, SHELL, [], opts())
    const sid = heldSessionId('abcdef0123456789abcdef23')
    await until(() => !!helper.holders.get(sid)?.attached, 'attached')
    crash(first)
    const second = makeManager()
    void second.start({ atStartup: true })
    // No wait: the keeper is still connecting.
    const done = second.shutdown()
    expect(done).not.toBeNull()
    await done
    expect(helper.holders.get(sid)!.ended).toBe(true)
  })

  it('a terminal still starting at the quit starts no holder at all (PR review: a start no longer wanted starts nothing)', async () => {
    const m = await started(makeManager())
    setSessionHelper(m)
    const before = helper.holds()
    const p = spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef24' }, SHELL, [], opts())
    const sid = heldSessionId('abcdef0123456789abcdef24')
    const exits: number[] = []
    p.onExit((e) => exits.push(e.exitCode))
    const done = m.shutdown()
    expect(done).not.toBeNull()
    await done
    await tick(50)
    expect(helper.holds()).toBe(before)
    expect(helper.holders.get(sid)).toBeUndefined()
    expect(exits).toHaveLength(1)
    expect(ptySpawn).not.toHaveBeenCalled()
  })

  it('a terminal whose holder was already being started at the quit is ended once its holder is up', async () => {
    const m = await started(makeManager())
    setSessionHelper(m)
    let open!: () => void
    helper.holdGate = new Promise<void>((r) => { open = r })
    spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef25' }, SHELL, [], opts())
    const sid = heldSessionId('abcdef0123456789abcdef25')
    await until(() => helper.holds() === 1, 'the hold under way')
    const done = m.shutdown()
    expect(done).not.toBeNull()
    helper.holdGate = null
    open()
    await done
    await until(() => helper.holders.get(sid)?.ended === true, 'the end of the late holder')
  })

  it('one a normal quit could not reach is ended at the next start, not kept', async () => {
    const m = await started(makeManager())
    setSessionHelper(m)
    spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef15' }, SHELL, [], opts())
    const sid = heldSessionId('abcdef0123456789abcdef15')
    await until(() => !!helper.holders.get(sid)?.attached, 'attached')
    // The quit's end never arrived.
    crash(m)
    rmSync(join(root, 'app-running.json'))
    const next = await started(makeManager())
    await until(() => helper.holders.get(sid)!.ended, 'the leftover to end')
    expect(next.serviceState().held).toBe(0)
  })

  it('a tab closed ends its holder; End on the page ends one too', async () => {
    const m = await started(makeManager())
    setSessionHelper(m)
    const p = spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef16' }, SHELL, [], opts())
    const sid = heldSessionId('abcdef0123456789abcdef16')
    await until(() => !!helper.holders.get(sid)?.attached, 'attached')
    const exits: number[] = []
    p.onExit((e) => exits.push(e.exitCode))
    expect(m.serviceState().held).toBe(1)
    p.kill()
    await until(() => helper.holders.get(sid)!.ended && exits.length === 1, 'the end')

    const q = spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef17' }, SHELL, [], opts())
    const sid2 = heldSessionId('abcdef0123456789abcdef17')
    await until(() => !!helper.holders.get(sid2)?.attached, 'attached')
    const qExits: number[] = []
    q.onExit((e) => qExits.push(e.exitCode))
    expect(await m.endSession(sid2)).toEqual({ ok: true })
    expect(helper.holders.get(sid2)!.ended).toBe(true)
    expect(qExits).toHaveLength(1)
  })

  it('a program that ends by itself: the tab sees its exit code and the holder is ended', async () => {
    const m = await started(makeManager())
    setSessionHelper(m)
    const p = spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef18' }, SHELL, [], opts())
    const sid = heldSessionId('abcdef0123456789abcdef18')
    await until(() => !!helper.holders.get(sid)?.attached, 'attached')
    const exits: number[] = []
    p.onExit((e) => exits.push(e.exitCode))
    helper.holders.get(sid)!.exitChild(3)
    await until(() => exits.length === 1 && helper.holders.get(sid)!.ended, 'the exit')
    expect(exits).toEqual([3])
  })
})

describe('which terminals, and the hold step', () => {
  it('a terminal without the plain mark (a sign-in, an install or update command, the first-run install) starts the usual way with the helper on', async () => {
    const m = await started(makeManager())
    setSessionHelper(m)
    expect(spawnPlainPty({ sessionId: 'abcdef0123456789abcdef40' }, SHELL, [], opts())).not.toBeInstanceOf(HelperPty)
    expect(spawnPlainPty({ sessionId: 'abcdef0123456789abcdef41', plain: false }, SHELL, [], opts())).not.toBeInstanceOf(HelperPty)
    expect(m.spawn({ sessionId: 'abcdef0123456789abcdef42' }, SHELL, [], opts())).not.toBeInstanceOf(HelperPty)
    expect(ptySpawn).toHaveBeenCalledTimes(3)
    expect(helper.holds()).toBe(0)
  })

  it('a holder that runs already for the terminal (hold exits 3) is used, not refused', async () => {
    const m = await started(makeManager({
      exec: async (file, args) => {
        if (args[0] !== 'hold') return helper.exec(file, args)
        // It started meanwhile: the helper says so and the app connects to it.
        await helper.exec(file, args)
        return { code: 3, stdout: '', stderr: 'aicc-helper: a holder for this session is already running\n' }
      },
    }))
    setSessionHelper(m)
    const p = spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef43' }, SHELL, [], opts())
    const sid = heldSessionId('abcdef0123456789abcdef43')
    await until(() => !!helper.holders.get(sid)?.attached, 'attached')
    expect((p as HelperPty).throughHelper).toBe(true)
    expect(ptySpawn).not.toHaveBeenCalled()
  })

  it('a record left for the terminal whose holder is gone does not stop a new holder', async () => {
    const m = await started(makeManager())
    setSessionHelper(m)
    const sid = heldSessionId('abcdef0123456789abcdef44')
    // Nobody answers at its endpoint.
    new FakeHolder(sid, 'abcdef0123456789abcdef44', join(root, 'store')).writeRecord()
    const p = spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef44' }, SHELL, [], opts())
    await until(() => !!helper.holders.get(sid)?.attached, 'a new holder attached')
    expect((p as HelperPty).throughHelper).toBe(true)
    expect(ptySpawn).not.toHaveBeenCalled()
  })

  it('a holder Windows keeps inside the app\'s job: the page says a held terminal does not survive a crash', async () => {
    helper.insideJob = true
    const m = await started(makeManager())
    setSessionHelper(m)
    spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef45' }, SHELL, [], opts())
    await until(() => !!helper.holders.get(heldSessionId('abcdef0123456789abcdef45'))?.attached, 'attached')
    expect((await m.status()).helper.detail).toBe(HELPER_SENTENCES.insideJob)
  })

  it('a copy that could not be put in place is tried again by a terminal started a minute later', async () => {
    let now = 1_000_000
    writeFileSync(join(dir, 'blocker'), 'a file where the folder should be')
    const m = makeManager({ root: join(dir, 'blocker', 'helper'), now: () => now })
    setSessionHelper(m)
    await m.start({ atStartup: true })
    await until(() => m.serviceState().state === 'failed', 'the failed copy')
    expect((await m.status()).helper.detail).toMatch(/could not be copied into place/)
    rmSync(join(dir, 'blocker'))
    now += 30_000
    expect(spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef46' }, SHELL, [], opts())).not.toBeInstanceOf(HelperPty)
    now += 31_000
    const p = spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef47' }, SHELL, [], opts())
    expect(p).toBeInstanceOf(HelperPty)
    await until(() => (p as HelperPty).isAttached, 'the terminal through the helper')
    await until(() => m.serviceState().state === 'ready', 'ready after the second copy')
  })

  it('switching on again tests a helper that failed its self-test again, and a pass makes it ready', async () => {
    helper.selfTestOk = false
    const m = makeManager()
    await m.start({ atStartup: true })
    await until(() => m.serviceState().state === 'failed', 'the failed self-test')
    m.stopRouting()
    const selfTests = () => helper.calls.filter((c) => c.args[0] === 'selftest').length
    const before = selfTests()
    helper.selfTestOk = true
    await m.start({ atStartup: false })
    await until(() => m.serviceState().state === 'ready', 'ready after the new self-test')
    expect(selfTests()).toBe(before + 1)
  })

  it('a quit waits only for terminals still through a holder, not for one that started the usual way', async () => {
    const m = await started(makeManager())
    setSessionHelper(m)
    helper.holdBusy = true
    const p = spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef48' }, SHELL, [], opts())
    await until(() => ptySpawn.mock.calls.length === 1, 'the usual start')
    expect((p as HelperPty).throughHelper).toBe(false)
    expect(m.shutdown()).toBeNull()
  })
})

describe('switched off, or not set up, while it holds terminals', () => {
  it('switched off while it holds a terminal: the page lists it, End still works, and the Services row reads off only after', async () => {
    const m = await started(makeManager())
    setSessionHelper(m)
    spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef50' }, SHELL, [], opts())
    const sid = heldSessionId('abcdef0123456789abcdef50')
    await until(() => !!helper.holders.get(sid)?.attached, 'attached')
    m.stopRouting()
    expect(m.serviceState()).toMatchObject({ state: 'ready', held: 1 })
    const s = await m.status()
    expect(s.helper.state).toBe('off')
    expect(s.helper.detail).toBe(offStillHoldingSentence(1))
    expect(s.sessions.map((x) => x.id)).toEqual([sid])
    // A new terminal starts the usual way meanwhile.
    expect(spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef51' }, SHELL, [], opts())).not.toBeInstanceOf(HelperPty)
    expect(await m.endSession(sid)).toEqual({ ok: true })
    expect(helper.holders.get(sid)!.ended).toBe(true)
    await until(() => m.serviceState().state === 'off', 'off once nothing is held')
    expect(await m.status()).toEqual({ id: 'this-computer', name: 'This computer', helper: { state: 'off' }, sessions: [] })
    expect(offStillHoldingSentence(2)).toBe('Switched off. It still holds 2 terminals until their tabs close or you end them here.')
  })

  it('after a crash with a helper that cannot be set up, a restored tab still shows its held terminal, and the page lists it', async () => {
    const first = await started(makeManager())
    setSessionHelper(first)
    spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef52' }, SHELL, [], opts())
    const sid = heldSessionId('abcdef0123456789abcdef52')
    await until(() => !!helper.holders.get(sid)?.attached, 'attached')
    helper.holders.get(sid)!.output('still here\r\n')
    crash(first)
    // The installation lost its helper meanwhile.
    rmSync(bundled)
    const second = makeManager()
    setSessionHelper(second)
    void second.start({ atStartup: true })
    await until(() => second.serviceState().state === 'not-installed', 'not installed')
    await until(() => helper.holders.get(sid)!.attaches === 2, 'the keeper')
    const s = await second.status()
    expect(s.helper.state).toBe('not-installed')
    expect(s.sessions.map((x) => x.id)).toEqual([sid])
    const p = spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef52' }, SHELL, [], opts())
    const seen: string[] = []
    p.onData((d) => seen.push(d))
    expect(await (p as HelperPty).adoption).toBe(true)
    await until(() => seen.join('').includes('still here'), 'the replay')
    expect(ptySpawn).not.toHaveBeenCalled()
  })
})

describe('the Machines page and the Services row', () => {
  it('status maps the helper and its held terminals; off says off', async () => {
    const m = await started(makeManager())
    await until(() => !!(m as unknown as { selfTest?: unknown }).selfTest, 'the self-test')
    const s = await m.status()
    expect(s).toMatchObject({ id: 'this-computer', name: 'This computer', helper: { state: 'ready', version: '0.1.0', selfTest: { ok: true, detail: 'All 2 checks passed.' } }, sessions: [] })
    expect(versionFolderName('0.1.0', 'a'.repeat(64))).toBe('0.1.0-aaaaaaaaaaaa')
    m.stopRouting()
    expect(await m.status()).toEqual({ id: 'this-computer', name: 'This computer', helper: { state: 'off' }, sessions: [] })
    expect(await m.endSession('pt0123456789abcdef0123456789abcd')).toEqual({ ok: false, message: 'The session helper is off, so it holds no terminal to end.' })
    expect(await m.reattach('pt0123456789abcdef0123456789abcd')).toEqual({ ok: false, message: 'The session helper is off, so it holds no terminal to re-attach.' })
    expect(await m.runSelfTest()).toMatchObject({ ok: false, detail: 'The session helper is off, so there is nothing to test.' })
  })

  it('the Services row: the state, how many it holds, and no restart', () => {
    expect(sessionHelperRow({ state: 'ready', held: 2, lastError: null })).toMatchObject({ id: 'helper', label: 'Session helper', host: 'helper', state: 'listening', heldSessions: 2, lastError: null })
    expect(sessionHelperRow({ state: 'starting', held: 0, lastError: null }).state).toBe('starting')
    expect(sessionHelperRow({ state: 'off', held: 0, lastError: null }).state).toBe('stopped')
    const failed = sessionHelperRow({ state: 'failed', held: 0, lastError: { message: 'does not match', ts: 5 } })
    expect(failed).toMatchObject({ state: 'crashed', lastError: { message: 'does not match', ts: 5 } })
    expect(sessionHelperRow({ state: 'not-installed', held: 0, lastError: null }).state).toBe('crashed')
  })
})

// ── 2.1.3-beta.7 (plan section A3): local agent sessions through the helper ──

const CMD = 'C:\\Windows\\System32\\cmd.exe'
/** What the PTY manager hands an agent spawn: the account by USERPROFILE, the
 *  session's own id and worktree, and the colour hint (pty-manager.ts). */
const AGENT_ENV = {
  Path: 'C:\\Windows',
  USERPROFILE: 'C:\\Users\\someone\\.claude-profiles\\work',
  CLAUDE_MULTI_SESSION_ID: 'abcdef0123456789abcdef60',
  CCC_SESSION_WORKTREE: 'C:\\Users\\someone\\project\\.wt\\one',
  COLORFGBG: '15;0',
}
const agentOpts = (over: Record<string, unknown> = {}) => ({ name: 'xterm-256color', cols: 120, rows: 30, cwd: CWD, env: { ...AGENT_ENV }, useConpty: true, ...over })
/** The line an npm codex.cmd runs by (providers/codex/spawn.ts codexCmdExeTarget). */
const NPM_LINE = '/d /v:off /s /c ""C:\\Users\\someone\\AppData\\Roaming\\npm\\codex.cmd" --no-alt-screen"'
const claudeTab = (sessionId: string) => ({ sessionId, kind: 'claude' as const })
const codexTab = (sessionId: string) => ({ sessionId, kind: 'codex' as const })
const ON_AGENTS = { atStartup: true, plain: false, agents: true }
const ON_BOTH = { atStartup: true, plain: true, agents: true }

async function startedWith(m: SessionHelperManager, o: { atStartup: boolean; plain?: boolean; agents?: boolean }): Promise<SessionHelperManager> {
  await m.start(o)
  await until(() => m.serviceState().state === 'ready', 'the helper to be ready')
  return m
}

/** A node-pty `conpty` folder with the two files, as installHelperCopy reads it. */
function conptyFolder(): string {
  const d = join(dir, 'node-pty', 'conpty')
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'conpty.dll'), 'MZ conpty')
  writeFileSync(join(d, 'OpenConsole.exe'), 'MZ console')
  return d
}

describe('agent sessions: the setting off is exactly today\'s launch', () => {
  it('with no helper this run, or with the helper on for plain terminals only, spawnAgentPty is node-pty\'s spawn with the very same arguments', async () => {
    setSessionHelper(null)
    const o = agentOpts()
    const args = ['-NoLogo']
    spawnAgentPty(claudeTab('abcdef0123456789abcdef60'), SHELL, args, o)
    expect(ptySpawn).toHaveBeenCalledTimes(1)
    expect(ptySpawn.mock.calls[0]).toEqual([SHELL, args, o])
    expect(ptySpawn.mock.calls[0][1]).toBe(args)
    expect(ptySpawn.mock.calls[0][2]).toBe(o)
    // The helper on for plain terminals: an agent start is still node-pty's own,
    // a string line and the bundled ConPTY included.
    const m = await started(makeManager())
    setSessionHelper(m)
    const c = agentOpts({ useConptyDll: true })
    const p = spawnAgentPty(codexTab('abcdef0123456789abcdef61'), CMD, NPM_LINE, c)
    expect(p).not.toBeInstanceOf(HelperPty)
    expect(ptySpawn.mock.calls[1]).toEqual([CMD, NPM_LINE, c])
    expect(ptySpawn.mock.calls[1][2]).toBe(c)
    expect(helper.holds()).toBe(0)
  })

  it('the agent setting alone carries no plain terminal', async () => {
    const m = await startedWith(makeManager(), ON_AGENTS)
    setSessionHelper(m)
    const o = opts()
    expect(spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef62' }, SHELL, [], o)).not.toBeInstanceOf(HelperPty)
    expect(ptySpawn.mock.calls[0][2]).toBe(o)
    expect(helper.holds()).toBe(0)
  })
})

describe('agent sessions: the setting on', () => {
  it('a Claude Code session: the launch carries the spawn\'s own program, arguments, folder and environment, and the typed launch line reaches the program', async () => {
    const m = await startedWith(makeManager(), ON_AGENTS)
    setSessionHelper(m)
    const id = 'abcdef0123456789abcdef63'
    const p = spawnAgentPty(claudeTab(id), SHELL, ['-NoLogo'], agentOpts())
    expect(p).toBeInstanceOf(HelperPty)
    expect(ptySpawn).not.toHaveBeenCalled()
    // An id of its own kind, never a plain terminal's.
    const sid = heldAgentSessionId(id, 'claude')
    expect(heldIdKind(sid)).toBe('agent')
    expect(heldIdKind(heldSessionId(id))).toBe('plain')
    expect(sid).not.toBe(heldAgentSessionId(id, 'codex'))
    await until(() => !!helper.holders.get(sid)?.attached, 'the session to attach')
    const h = helper.holders.get(sid)!
    expect(h.label).toBe(id)
    expect(h.launch).toEqual({ t: 'term.launch', id: expect.anything(), argv: [SHELL, '-NoLogo'], cwd: CWD, env: AGENT_ENV, cols: 120, rows: 30 })
    // What the PTY manager types 300 ms after the spawn, then the program's own output.
    const line = "Set-Location -LiteralPath 'C:\\Users\\someone\\project'; & 'C:\\Users\\someone\\.local\\bin\\claude.exe' --settings x; exit"
    p.write(line + '\r')
    await until(() => Buffer.concat(h.input).toString() === line + '\r', 'the launch line')
    const seen: string[] = []
    p.onData((d) => seen.push(d))
    h.output('Claude Code\r\n')
    await until(() => seen.join('').includes('Claude Code'), 'output')
    // A new session, never a take-over.
    expect(heldNow(p)).toBe(false)
    expect(m.serviceState().held).toBe(1)
  })

  it('a Codex session by its npm launcher: the string line goes as `line`, as node-pty would make it, with the program alone, and the bundled ConPTY as the helper\'s', async () => {
    const source = conptyFolder()
    const m = await startedWith(makeManager({ conptySource: () => source }), ON_AGENTS)
    setSessionHelper(m)
    const id = 'abcdef0123456789abcdef64'
    const p = spawnAgentPty(codexTab(id), CMD, NPM_LINE, agentOpts({ useConptyDll: true }))
    expect(p).toBeInstanceOf(HelperPty)
    const sid = heldAgentSessionId(id, 'codex')
    await until(() => !!helper.holders.get(sid)?.attached, 'the session to attach')
    expect(helper.holders.get(sid)!.launch).toEqual({
      t: 'term.launch', id: expect.anything(), argv: [CMD], cwd: CWD, env: AGENT_ENV, cols: 120, rows: 30, line: `${CMD} ${NPM_LINE}`, conpty: 'bundled',
    })
    expect(ptySpawn).not.toHaveBeenCalled()
    // The two files went beside the helper's copy, checked before the launch.
    const folder = readdirSync(root).find((n) => /^0\.1\.0-/.test(n))!
    expect(readFileSync(join(root, folder, 'conpty', 'conpty.dll'), 'utf8')).toBe('MZ conpty')
    // A native codex.exe (an argument list) on the system ConPTY: neither field.
    const q = spawnAgentPty(codexTab('abcdef0123456789abcdef65'), 'C:\\Users\\someone\\bin\\codex.exe', ['--no-alt-screen'], agentOpts())
    const qsid = heldAgentSessionId('abcdef0123456789abcdef65', 'codex')
    await until(() => !!helper.holders.get(qsid)?.attached, 'the second session to attach')
    expect(q).toBeInstanceOf(HelperPty)
    expect(helper.holders.get(qsid)!.launch).toEqual({ t: 'term.launch', id: expect.anything(), argv: ['C:\\Users\\someone\\bin\\codex.exe', '--no-alt-screen'], cwd: CWD, env: AGENT_ENV, cols: 120, rows: 30 })
  })

  it('the command line is node-pty\'s own for the same program and line', () => {
    const { argsToCommandLine } = createRequire(__filename)('node-pty/lib/windowsPtyAgent.js') as { argsToCommandLine: (f: string, a: string) => string }
    const programs = [CMD, 'C:\\Program Files\\Tools\\cmd.exe', 'C:\\odd "name"\\x.exe', 'C:\\trailing\\', 'C:\\with tab\t\\x.exe', '"C:\\Already Quoted\\cmd.exe"', '"C:\\lopsided\\cmd.exe']
    for (const file of programs) {
      for (const line of [NPM_LINE, '', '/c echo hi']) expect(nodePtyCommandLine(file, line), `${file} | ${line}`).toBe(argsToCommandLine(file, line))
    }
  })

  it('no bundled ConPTY copy beside the helper: the Codex session starts the usual way, on node-pty\'s own, and no holder starts', async () => {
    const m = await startedWith(makeManager(), ON_AGENTS)
    setSessionHelper(m)
    const o = agentOpts({ useConptyDll: true })
    const p = spawnAgentPty(codexTab('abcdef0123456789abcdef66'), CMD, NPM_LINE, o)
    expect(p).toBeInstanceOf(HelperPty)
    await until(() => ptySpawn.mock.calls.length === 1, 'the usual start')
    expect(ptySpawn.mock.calls[0]).toEqual([CMD, NPM_LINE, o])
    expect(ptySpawn.mock.calls[0][2]).toBe(o)
    expect((p as HelperPty).throughHelper).toBe(false)
    expect(helper.holds()).toBe(0)
  })

  it('node-pty failing on its bundled ConPTY in that usual start: started on the system ConPTY, and the rest of the run uses it', async () => {
    _resetBundledConptyForTest({ platform: 'win32', arch: 'x64', nodePtyLibDir: join(dir, 'node-pty', 'lib'), exists: () => true })
    try {
      expect(bundledConptyChoice().kind).toBe('bundled')
      ptySpawn.mockImplementation((_f: string, _a: unknown, o: { useConptyDll?: boolean }) => {
        if (o.useConptyDll) throw new Error('conpty.dll would not load')
        return fakeDirect()
      })
      const m = await startedWith(makeManager(), ON_AGENTS)
      setSessionHelper(m)
      const p = spawnAgentPty(codexTab('abcdef0123456789abcdef67'), CMD, NPM_LINE, agentOpts({ useConptyDll: true }))
      await until(() => ptySpawn.mock.calls.length === 2, 'the system ConPTY start')
      expect(ptySpawn.mock.calls[1]).toEqual([CMD, NPM_LINE, agentOpts()])
      expect((p as HelperPty).throughHelper).toBe(false)
      expect(bundledConptyChoice().kind).toBe('system')
    } finally {
      _resetBundledConptyForTest(null)
    }
  })

  it('off Windows a string line or the bundled ConPTY is never sent: the session starts the usual way', async () => {
    const m = await startedWith(makeManager({ platform: 'linux', checkEndpointFolder: () => null }), ON_AGENTS)
    const o = { name: 'xterm-256color', cols: 80, rows: 24, cwd: '/home/u', env: { PATH: '/bin' } }
    expect(m.spawnAgent(codexTab('abcdef0123456789abcdef68'), '/bin/sh', '-c codex', o)).not.toBeInstanceOf(HelperPty)
    const b = { ...o, useConptyDll: true }
    expect(m.spawnAgent(codexTab('abcdef0123456789abcdef69'), '/usr/bin/codex', [], b)).not.toBeInstanceOf(HelperPty)
    expect(ptySpawn.mock.calls).toEqual([['/bin/sh', '-c codex', o], ['/usr/bin/codex', [], b]])
    expect(helper.holds()).toBe(0)
  })

  it('a normal quit: Escape, Ctrl-C and /exit reach a held Claude Code session in order, then its holder is ended', async () => {
    const m = await startedWith(makeManager(), ON_AGENTS)
    setSessionHelper(m)
    const p = spawnAgentPty(claudeTab('abcdef0123456789abcdef6a'), SHELL, [], agentOpts())
    const sid = heldAgentSessionId('abcdef0123456789abcdef6a', 'claude')
    await until(() => !!helper.holders.get(sid)?.attached, 'attached')
    const h = helper.holders.get(sid)!
    // gracefulExitPty's keys (pty-manager.ts), through the helper's terminal.
    p.write('\x1b')
    p.write('\x03')
    p.write('/exit\r')
    await until(() => Buffer.concat(h.input).toString() === '\x1b\x03/exit\r', 'the exit keys')
    expect(h.ended).toBe(false)
    const done = m.shutdown()
    expect(done).not.toBeNull()
    await done
    expect(h.ended).toBe(true)
    expect(h.requests.map((r) => r.t).filter((t) => t !== 'ping')).toEqual(['term.launch', 'term.attach', 'term.end'])
  })
})

describe('agent sessions after a crash (plan s11, Q1): ended, never shown again', () => {
  async function crashedWith(): Promise<{ plainSid: string; claudeSid: string }> {
    const first = await startedWith(makeManager(), ON_BOTH)
    setSessionHelper(first)
    spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef70' }, SHELL, [], opts())
    spawnAgentPty(claudeTab('abcdef0123456789abcdef71'), SHELL, [], agentOpts())
    const plainSid = heldSessionId('abcdef0123456789abcdef70')
    const claudeSid = heldAgentSessionId('abcdef0123456789abcdef71', 'claude')
    await until(() => !!helper.holders.get(plainSid)?.attached && !!helper.holders.get(claudeSid)?.attached, 'both attached')
    crash(first)
    return { plainSid, claudeSid }
  }

  it('a store with one plain and one Claude Code record keeps the plain one for its tab and ends the Claude one, which its tab never takes over', async () => {
    const { plainSid, claudeSid } = await crashedWith()
    const oldClaude = helper.holders.get(claudeSid)!
    const second = makeManager()
    setSessionHelper(second)
    void second.start(ON_BOTH)
    await until(() => helper.holders.get(plainSid)!.attaches === 2 && oldClaude.ended, 'the keeper and the end')
    expect(oldClaude.attaches).toBe(1)
    expect(second.holdsFor('abcdef0123456789abcdef70')).toBe(true)
    // The plain tab shows its terminal again.
    const plain = spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef70' }, SHELL, [], opts())
    expect(await (plain as HelperPty).adoption).toBe(true)
    // The Claude tab, restored, starts a new session (and resumes its conversation by its launch line).
    const p = spawnAgentPty(claudeTab('abcdef0123456789abcdef71'), SHELL, [], agentOpts())
    expect(heldNow(p)).toBe(false)
    await until(() => helper.holders.get(claudeSid) !== oldClaude && !!helper.holders.get(claudeSid)?.attached, 'a new holder')
    expect(helper.holders.get(claudeSid)!.requests.filter((r) => r.t === 'term.launch')).toHaveLength(1)
    expect(ptySpawn).not.toHaveBeenCalled()
  })

  it('a Claude Code tab that starts again while that end is under way waits for it, then launches anew', async () => {
    const { claudeSid } = await crashedWith()
    const oldClaude = helper.holders.get(claudeSid)!
    let release!: () => void
    oldClaude.endGate = new Promise<void>((r) => { release = r })
    const second = makeManager()
    setSessionHelper(second)
    void second.start(ON_AGENTS)
    await until(() => oldClaude.endsAsked === 1, 'the end to be asked')
    const holdsBefore = helper.holds()
    const p = spawnAgentPty(claudeTab('abcdef0123456789abcdef71'), SHELL, [], agentOpts())
    await tick(150)
    // Nothing started for the tab while the old session still runs.
    expect(helper.holds()).toBe(holdsBefore)
    expect(ptySpawn).not.toHaveBeenCalled()
    // The page lists the old one as no tab's, being ended, though its tab
    // waits under the same id to start a new one (PR review).
    expect((await second.status()).sessions.find((s) => s.id === claudeSid)).toMatchObject({ kind: 'claude', attached: false, tabOpen: false })
    release()
    await until(() => helper.holders.get(claudeSid) !== oldClaude && !!helper.holders.get(claudeSid)?.attached, 'the new holder')
    expect(oldClaude.ended).toBe(true)
    expect((p as HelperPty).throughHelper).toBe(true)
    expect(ptySpawn).not.toHaveBeenCalled()
  })

  it('a tab that starts again waits past five seconds for that end (PR review: no start before the old CLI is gone)', async () => {
    const { claudeSid } = await crashedWith()
    const oldClaude = helper.holders.get(claudeSid)!
    let release!: () => void
    oldClaude.endGate = new Promise<void>((r) => { release = r })
    // The end's answer times out quickly, so a start that went ahead after a
    // five-second wait and one unanswered end would have gone ahead by then.
    const second = makeManager({ replyTimeoutMs: 500 })
    setSessionHelper(second)
    void second.start(ON_AGENTS)
    await until(() => oldClaude.endsAsked >= 1 && second.serviceState().state === 'ready', 'the end to be asked, and the helper ready')
    // From here the timers are the test's: more than five seconds
    // (ENDING_WAIT_MS) pass in steps, with no real waiting beyond what the
    // file reads need.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const holdsBefore = helper.holds()
      const p = spawnAgentPty(claudeTab('abcdef0123456789abcdef71'), SHELL, [], agentOpts())
      await stepFor(6500)
      await realWait(300)
      expect(helper.holds()).toBe(holdsBefore)
      expect(ptySpawn).not.toHaveBeenCalled()
      expect(oldClaude.ended).toBe(false)
      release()
      // The next try (every 2 s) finds it gone.
      await stepUntil(() => helper.holders.get(claudeSid) !== oldClaude && !!helper.holders.get(claudeSid)?.attached, 'the new holder')
      expect((p as HelperPty).throughHelper).toBe(true)
      expect(ptySpawn).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('an earlier holder that still runs and cannot be reached: the tab starts nothing and says why; once the helper no longer lists it, the next start goes ahead', async () => {
    const { claudeSid } = await crashedWith()
    const oldClaude = helper.holders.get(claudeSid)!
    oldClaude.unreachable = true
    // The away clock passes in a few fake steps: each wait between tries moves the clock on 30 s.
    let clock = Date.now()
    const second = makeManager({ now: () => clock, sleep: async () => { clock += 30_000 } })
    setSessionHelper(second)
    void second.start(ON_AGENTS)
    const holdsBefore = helper.holds()
    const p = spawnAgentPty(claudeTab('abcdef0123456789abcdef71'), SHELL, [], agentOpts())
    const seen: string[] = []
    const exits: number[] = []
    p.onData((d) => seen.push(d))
    p.onExit((e) => exits.push(e.exitCode))
    await until(() => exits.length === 1, 'the tab to end with nothing started')
    expect(exits).toEqual([1])
    expect(seen.join('')).toContain(HELPER_SENTENCES.agentNotCleared)
    expect(ptySpawn).not.toHaveBeenCalled()
    expect(helper.holds()).toBe(holdsBefore)
    // The gate stays: any later start for this tab, with the setting off too, asks again first.
    expect(second.endingFor(claudeTab('abcdef0123456789abcdef71'))).toBe(true)
    // It is gone at last (its away clock ended it): the next start goes ahead.
    oldClaude.vanish()
    const q = spawnAgentPty(claudeTab('abcdef0123456789abcdef71'), SHELL, [], agentOpts())
    await until(() => helper.holders.get(claudeSid) !== oldClaude && !!helper.holders.get(claudeSid)?.attached, 'the new holder')
    expect((q as HelperPty).throughHelper).toBe(true)
    expect(ptySpawn).not.toHaveBeenCalled()
  })

  it('with both settings off and the crash mark there, the agent session is still ended, and a tab that starts meanwhile waits for it, then starts node-pty\'s own way', async () => {
    const { plainSid, claudeSid } = await crashedWith()
    const oldClaude = helper.holders.get(claudeSid)!
    let release!: () => void
    oldClaude.endGate = new Promise<void>((r) => { release = r })
    const second = makeManager()
    setSessionHelper(second)
    void second.start({ atStartup: true, plain: false, agents: false })
    await until(() => oldClaude.endsAsked === 1, 'the end to be asked')
    expect(second.isEnabled()).toBe(false)
    const o = agentOpts()
    const p = spawnAgentPty(claudeTab('abcdef0123456789abcdef71'), SHELL, [], o)
    await tick(150)
    expect(ptySpawn).not.toHaveBeenCalled()
    release()
    await until(() => ptySpawn.mock.calls.length === 1, 'the usual start')
    expect(oldClaude.ended).toBe(true)
    expect(ptySpawn.mock.calls[0]).toEqual([SHELL, [], o])
    expect(ptySpawn.mock.calls[0][2]).toBe(o)
    expect((p as HelperPty).throughHelper).toBe(false)
    // Its plain terminal is still kept for its tab, as with the setting on.
    await until(() => helper.holders.get(plainSid)!.attaches === 2, 'the keeper')
    // Once the end is over, a start is node-pty's own straight away.
    expect(spawnAgentPty(claudeTab('abcdef0123456789abcdef72'), SHELL, [], o)).not.toBeInstanceOf(HelperPty)
    // And the page lists no agent session left.
    expect((await second.status()).sessions.map((s) => s.id)).toEqual([plainSid])
  })
})

describe('agent sessions on the Machines page', () => {
  it('listed by provider under their tab names and counted on the Services row; End ends one, Re-attach is refused', async () => {
    const m = await startedWith(makeManager(), ON_AGENTS)
    setSessionHelper(m)
    m.noteSavedTabs([{ id: 'abcdef0123456789abcdef80', label: 'API', customName: 'Payments' }, { id: 'abcdef0123456789abcdef81', label: 'Docs' }])
    spawnAgentPty(claudeTab('abcdef0123456789abcdef80'), SHELL, [], agentOpts())
    const q = spawnAgentPty(codexTab('abcdef0123456789abcdef81'), 'C:\\Users\\someone\\bin\\codex.exe', [], agentOpts())
    const c = heldAgentSessionId('abcdef0123456789abcdef80', 'claude')
    const x = heldAgentSessionId('abcdef0123456789abcdef81', 'codex')
    await until(() => !!helper.holders.get(c)?.attached && !!helper.holders.get(x)?.attached, 'both attached')
    // A record with an agent id no provider of this app makes for its label is not listed.
    const stray = new FakeHolder(`ag${'0'.repeat(30)}`, 'abcdef0123456789abcdef82', join(root, 'store'))
    helper.holders.set(stray.sid, stray)
    const s = await m.status()
    const byId = new Map(s.sessions.map((x) => [x.id, x]))
    expect(s.sessions).toHaveLength(2)
    expect(byId.get(c)).toEqual({ id: c, kind: 'claude', label: 'Payments', startedAt: helper.holders.get(c)!.started, attached: true, tabOpen: true })
    expect(byId.get(x)).toEqual({ id: x, kind: 'codex', label: 'Docs', startedAt: helper.holders.get(x)!.started, attached: true, tabOpen: true })
    expect(m.serviceState().held).toBe(2)
    expect(await m.reattach(c)).toEqual({ ok: false, message: HELPER_SENTENCES.agentNotReattached })
    const exits: number[] = []
    q.onExit((e) => exits.push(e.exitCode))
    expect(await m.endSession(x)).toEqual({ ok: true })
    expect(helper.holders.get(x)!.ended).toBe(true)
    expect(exits).toHaveLength(1)
    await until(() => m.serviceState().held === 1, 'one left')
  })
})

// ── PR #705 review: the branches each fix or check below rests on ────────────

describe('agent sessions: the switches, the marks and the waits (PR review)', () => {
  const TAB = 'abcdef0123456789abcdefa1'
  const SID = heldAgentSessionId(TAB, 'claude')

  /** A held Claude Code session the last run left: by a crash (its running
   *  mark stays), or by a normal quit whose end never arrived (it went). */
  async function leftHeld(how: 'crash' | 'quit'): Promise<FakeHolder> {
    const first = await startedWith(makeManager(), ON_AGENTS)
    setSessionHelper(first)
    spawnAgentPty(claudeTab(TAB), SHELL, [], agentOpts())
    await until(() => !!helper.holders.get(SID)?.attached, 'the session to attach')
    crash(first)
    if (how === 'quit') rmSync(join(root, 'app-running.json'))
    return helper.holders.get(SID)!
  }

  it('the crash mark is the file start() writes and a normal quit removes; an agent session\'s record in the store is found, a plain one\'s is not', async () => {
    expect(crashMarkIn(root)).toBe(false)
    expect(agentRecordsIn(root, 'win32')).toBe(false)
    const m = await started(makeManager(), false)
    expect(crashMarkIn(root)).toBe(true)
    setSessionHelper(m)
    m.setRouting({ plain: true, agents: true })
    spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdefa2' }, SHELL, [], opts())
    await until(() => !!helper.holders.get(heldSessionId('abcdef0123456789abcdefa2'))?.attached, 'the plain terminal')
    expect(agentRecordsIn(root, 'win32')).toBe(false)
    spawnAgentPty(claudeTab(TAB), SHELL, [], agentOpts())
    await until(() => !!helper.holders.get(SID)?.attached, 'the agent session')
    expect(agentRecordsIn(root, 'win32')).toBe(true)
    await m.shutdown()
    expect(crashMarkIn(root)).toBe(false)
    expect(agentRecordsIn(root, 'win32')).toBe(false)
  })

  it('setRouting decides each kind on its own, and once a quit began nothing new is carried, whatever a late save says', async () => {
    const m = await started(makeManager())
    setSessionHelper(m)
    m.setRouting({ plain: false, agents: true })
    expect(spawnAgentPty(claudeTab('abcdef0123456789abcdefa3'), SHELL, [], agentOpts())).toBeInstanceOf(HelperPty)
    expect(spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdefa4' }, SHELL, [], opts())).not.toBeInstanceOf(HelperPty)
    m.setRouting({ plain: true, agents: false })
    expect(spawnAgentPty(claudeTab('abcdef0123456789abcdefa5'), SHELL, [], agentOpts())).not.toBeInstanceOf(HelperPty)
    expect(spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdefa6' }, SHELL, [], opts())).toBeInstanceOf(HelperPty)
    await m.shutdown()
    m.setRouting({ plain: true, agents: true })
    expect(m.routesAgents()).toBe(false)
    expect(m.routesPlain()).toBe(false)
    expect(spawnAgentPty(claudeTab('abcdef0123456789abcdefa7'), SHELL, [], agentOpts())).not.toBeInstanceOf(HelperPty)
    expect(spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdefa8' }, SHELL, [], opts())).not.toBeInstanceOf(HelperPty)
  })

  it('a start the tab ends while it waits for the earlier holder starts nothing, and the next start gets a holder of its own whose launch is never ended', async () => {
    const old = await leftHeld('crash')
    let release!: () => void
    old.endGate = new Promise<void>((r) => { release = r })
    const second = makeManager()
    setSessionHelper(second)
    void second.start(ON_AGENTS)
    await until(() => old.endsAsked === 1 && second.serviceState().state === 'ready', 'the end to be asked, and the helper ready')
    const madeBefore = helper.made.length
    const holdsBefore = helper.holds()
    const first = spawnAgentPty(claudeTab(TAB), SHELL, [], agentOpts())
    const firstExits: number[] = []
    first.onExit((e) => firstExits.push(e.exitCode))
    await tick(50)
    // A Restart: the waiting start is ended, and the tab starts again at once.
    first.kill()
    const next = spawnAgentPty(claudeTab(TAB), SHELL, [], agentOpts())
    release()
    await until(() => helper.holders.get(SID) !== old && !!helper.holders.get(SID)?.attached, 'the new holder')
    await tick(100)
    // One hold, for the next start: the ended one asked for none.
    expect(helper.holds() - holdsBefore).toBe(1)
    expect(helper.made.length - madeBefore).toBe(1)
    const fresh = helper.holders.get(SID)!
    expect(fresh.ended).toBe(false)
    expect(fresh.requests.filter((r) => r.t === 'term.launch')).toHaveLength(1)
    expect(fresh.requests.filter((r) => r.t === 'term.end')).toHaveLength(0)
    expect((next as HelperPty).throughHelper).toBe(true)
    expect(firstExits).toHaveLength(1)
    expect(ptySpawn).not.toHaveBeenCalled()
  })

  it('Restart of a held Claude Code session still starting: the new start waits until the old holder is up and ended, then starts its own', async () => {
    const m = await startedWith(makeManager(), ON_AGENTS)
    setSessionHelper(m)
    let open!: () => void
    helper.holdGate = new Promise<void>((r) => { open = r })
    const first = spawnAgentPty(claudeTab(TAB), SHELL, [], agentOpts())
    await until(() => helper.holds() === 1, 'the first hold under way')
    first.kill()
    const next = spawnAgentPty(claudeTab(TAB), SHELL, [], agentOpts())
    await tick(100)
    expect(helper.holds()).toBe(1)
    // The ended flag of every holder started so far, at each later hold.
    const seenAtHold: boolean[][] = []
    const exec = helper.exec
    helper.exec = async (file, args) => {
      if (args[0] === 'hold') seenAtHold.push(helper.made.map((h) => h.ended))
      return exec(file, args)
    }
    helper.holdGate = null
    open()
    await until(() => helper.made.length === 2 && !!helper.made[1].attached, 'the second holder')
    await tick(100)
    expect(seenAtHold).toEqual([[true]])
    expect(helper.made[0].ended).toBe(true)
    expect(helper.made[0].requests.filter((r) => r.t === 'term.launch')).toHaveLength(0)
    expect(helper.made[1].ended).toBe(false)
    expect(helper.made[1].requests.filter((r) => r.t === 'term.launch')).toHaveLength(1)
    expect(helper.made[1].requests.filter((r) => r.t === 'term.end')).toHaveLength(0)
    expect((next as HelperPty).throughHelper).toBe(true)
    expect(ptySpawn).not.toHaveBeenCalled()
  })

  it('an agent session a normal quit could not end is ended at the next start, with its setting off too, and its tab, restored at once, waits for that end', async () => {
    const old = await leftHeld('quit')
    let release!: () => void
    old.endGate = new Promise<void>((r) => { release = r })
    // The start-up makes a manager for it (app-wiring), whatever the settings say.
    expect(crashMarkIn(root)).toBe(false)
    expect(agentRecordsIn(root, 'win32')).toBe(true)
    const second = makeManager()
    setSessionHelper(second)
    void second.start({ atStartup: true, plain: true, agents: false })
    const o = agentOpts()
    const p = spawnAgentPty(claudeTab(TAB), SHELL, [], o)
    await tick(150)
    expect(ptySpawn).not.toHaveBeenCalled()
    release()
    await until(() => ptySpawn.mock.calls.length === 1, 'the usual start')
    expect(old.ended).toBe(true)
    expect(ptySpawn.mock.calls[0][2]).toBe(o)
    expect((p as HelperPty).throughHelper).toBe(false)
  })

  it('a quit\'s leftover whose store record does not read is still ended, from the listing', async () => {
    const old = await leftHeld('quit')
    writeFileSync(join(root, 'store', `${SID}.json`), 'not a record')
    const second = makeManager()
    setSessionHelper(second)
    void second.start({ atStartup: true, plain: false, agents: false })
    await until(() => old.ended, 'the end from the listing')
  })

  it('after a crash, an agent session the store read missed but the listing has is ended too, never kept', async () => {
    const old = await leftHeld('crash')
    writeFileSync(join(root, 'store', `${SID}.json`), 'not a record')
    const second = makeManager()
    setSessionHelper(second)
    void second.start(ON_AGENTS)
    await until(() => old.ended, 'the end from the listing')
    expect(old.attaches).toBe(1)
  })

  it('an unreachable earlier holder while the helper cannot list: the start waits until no process has its id, then goes ahead', async () => {
    const old = await leftHeld('crash')
    old.unreachable = true
    helper.listFails = true
    let clock = Date.now()
    let tries = 0
    const asked: number[] = []
    const second = makeManager({
      now: () => clock,
      // Its process goes after the third wait between tries.
      sleep: async () => { clock += 2_000; if (++tries === 3) old.vanish() },
      processGone: (pid) => { asked.push(pid); return old.gone },
    })
    setSessionHelper(second)
    void second.start(ON_AGENTS)
    const p = spawnAgentPty(claudeTab(TAB), SHELL, [], agentOpts())
    await until(() => helper.holders.get(SID) !== old && !!helper.holders.get(SID)?.attached, 'the new holder')
    expect(asked.length).toBeGreaterThanOrEqual(4)
    expect(new Set(asked)).toEqual(new Set([old.pid]))
    expect((p as HelperPty).throughHelper).toBe(true)
    expect(ptySpawn).not.toHaveBeenCalled()
  })

  it('an earlier holder with a long away clock is waited for 5 minutes and 10 s at most, then the tab starts nothing', async () => {
    const old = await leftHeld('crash')
    old.unreachable = true
    old.away = 3600
    old.writeRecord()
    const t0 = Date.now()
    let clock = t0
    const second = makeManager({ now: () => clock, sleep: async () => { clock += 30_000 } })
    setSessionHelper(second)
    void second.start(ON_AGENTS)
    const p = spawnAgentPty(claudeTab(TAB), SHELL, [], agentOpts())
    let gaveUpAt = 0
    p.onExit(() => { gaveUpAt = clock })
    await until(() => gaveUpAt > 0, 'the tab to end with nothing started')
    expect(gaveUpAt - t0).toBeGreaterThanOrEqual(5 * 60_000 + 10_000)
    expect(gaveUpAt - t0).toBeLessThan(5 * 60_000 + 10_000 + 30_000)
    expect(ptySpawn).not.toHaveBeenCalled()
  })
})

describe('an app update on Windows: held plain and partner terminals are let go of, not ended (plan section B2)', () => {
  const PLAIN = 'abcdef0123456789abcdefc1'
  const PARENT = 'abcdef0123456789abcdefc2'
  const PARTNER = `${PARENT}-partner`
  const UNSAVED = 'abcdef0123456789abcdefc3'
  const AGENT = 'abcdef0123456789abcdefc4'
  /** The tabs in the saved file the next start restores from. */
  const SAVED = new Set([PLAIN, PARENT, AGENT])
  const sids = () => ({ plain: heldSessionId(PLAIN), partner: heldSessionId(PARTNER), unsaved: heldSessionId(UNSAVED), agent: heldAgentSessionId(AGENT, 'claude') })
  const mark = () => JSON.parse(readFileSync(join(root, 'app-running.json'), 'utf8')) as Record<string, unknown>
  const liveOf = (m: SessionHelperManager) => (m as unknown as { live: Map<string, HelperPty> }).live

  /** A plain terminal, a partner terminal, a plain terminal whose tab is not
   *  saved, and a Claude Code session, each through a holder and attached;
   *  the app saved the other three tabs. */
  async function fourHeld(m: SessionHelperManager): Promise<Record<'plain' | 'partner' | 'unsaved' | 'agent', IPty>> {
    setSessionHelper(m)
    const ptys = {
      plain: spawnPlainPty({ plain: true, sessionId: PLAIN }, SHELL, [], opts()),
      partner: spawnPlainPty({ plain: true, sessionId: PARTNER }, SHELL, [], opts()),
      unsaved: spawnPlainPty({ plain: true, sessionId: UNSAVED }, SHELL, [], opts()),
      agent: spawnAgentPty(claudeTab(AGENT), SHELL, [], agentOpts()),
    }
    const s = sids()
    await until(() => Object.values(s).every((sid) => !!helper.holders.get(sid)?.attached), 'all four to attach')
    m.noteSavedTabs([{ id: PLAIN, label: 'Build' }, { id: PARENT, label: 'API' }, { id: AGENT, label: 'Claude' }])
    return ptys
  }

  /** What update-handlers.ts does next: killAllPty. */
  const killAll = (ptys: Record<string, IPty>) => { for (const p of Object.values(ptys)) p.kill() }

  it('after the release and a kill of every PTY: the saved plain and partner terminals get no end, still run, and their connections are closed; the unsaved one and the Claude session are ended; the mark says update', async () => {
    const m = await startedWith(makeManager(), ON_BOTH)
    const ptys = await fourHeld(m)
    const exits: string[] = []
    for (const [k, p] of Object.entries(ptys)) p.onExit(() => exits.push(k))
    expect(m.releaseForUpdate(SAVED)).toBe(2)
    killAll(ptys)
    const s = sids()
    const [plain, partner, unsaved, agent] = [s.plain, s.partner, s.unsaved, s.agent].map((sid) => helper.holders.get(sid)!)
    await until(() => unsaved.ended && agent.ended, 'the unsaved terminal and the Claude session to end')
    await until(() => plain.conns.size === 0 && partner.conns.size === 0, 'the released connections to close')
    // Every tab reads its terminal as ended, so the PTY manager drops each one.
    await until(() => exits.length === 4, 'four exits')
    for (const h of [plain, partner]) {
      expect(h.endsAsked).toBe(0)
      expect(h.ended).toBe(false)
      expect(h.child).toBe('running')
      expect(h.attached).toBeNull()
    }
    expect(unsaved.endsAsked).toBe(1)
    expect(agent.endsAsked).toBe(1)
    expect(mark()).toMatchObject({ v: 1, reason: 'update' })
    // While the update goes on nothing new is held, and a tab started again
    // meanwhile does not touch the holder it let go of.
    expect(spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdefc5' }, SHELL, [], opts())).not.toBeInstanceOf(HelperPty)
    expect(spawnPlainPty({ plain: true, sessionId: PLAIN }, SHELL, [], opts())).not.toBeInstanceOf(HelperPty)
    await tick(30)
    expect(plain.endsAsked).toBe(0)
    expect(liveOf(m).size).toBe(0)
    crash(m)
  })

  it('the installer could not start: reclaim keeps them for their tabs and lists them on the Machines page; the mark is the usual one again, and a tab started again takes its terminal over', async () => {
    const m = await startedWith(makeManager(), ON_BOTH)
    const ptys = await fourHeld(m)
    const s = sids()
    helper.holders.get(s.plain)!.output('before the update\r\n')
    expect(m.releaseForUpdate(SAVED)).toBe(2)
    killAll(ptys)
    expect(m.reclaim()).toBe(2)
    expect(m.holdsFor(PLAIN)).toBe(true)
    expect(m.holdsFor(PARTNER)).toBe(true)
    expect(m.holdsFor(UNSAVED)).toBe(false)
    await until(() => helper.holders.get(s.plain)!.attaches === 2 && helper.holders.get(s.partner)!.attaches === 2, 'the keepers')
    const status = await m.status()
    expect(status.sessions.find((x) => x.id === s.plain)).toMatchObject({ kind: 'plain', label: 'Build', attached: false, tabOpen: true })
    expect(status.sessions.find((x) => x.id === s.partner)).toMatchObject({ kind: 'partner', label: 'API, partner terminal', attached: false, tabOpen: true })
    expect(mark().reason).toBeUndefined()
    expect(m.routesPlain()).toBe(true)
    // Its tab, started again, takes it over with what it wrote before.
    const again = spawnPlainPty({ plain: true, sessionId: PLAIN }, SHELL, [], opts())
    const seen: string[] = []
    again.onData((d) => seen.push(d))
    expect(await (again as HelperPty).adoption).toBe(true)
    await until(() => seen.join('').includes('before the update'), 'the replay')
    expect(helper.holders.get(s.plain)!.endsAsked).toBe(0)
  })

  it('after reclaim, Re-attach opens a new Terminal only tab on it (its own tab\'s terminal read as ended, so bringing that tab forward would show nothing), and that tab shows it with its output (PR review)', async () => {
    let k = 0
    const m = await startedWith(makeManager({ newTabId: () => `newtab0123456789abcdef${String(k++).padStart(2, '0')}` }), ON_BOTH)
    const ptys = await fourHeld(m)
    const s = sids()
    helper.holders.get(s.partner)!.output('partner before the update\r\n')
    m.releaseForUpdate(SAVED)
    killAll(ptys)
    m.reclaim()
    await until(() => helper.holders.get(s.plain)!.attaches === 2 && helper.holders.get(s.partner)!.attaches === 2, 'the keepers')
    expect(await m.reattach(s.plain)).toEqual({ ok: true, tab: { id: 'newtab0123456789abcdef00', label: 'Build', open: true, partner: false } })
    expect(await m.reattach(s.partner)).toEqual({ ok: true, tab: { id: 'newtab0123456789abcdef01', label: 'API, partner terminal', open: true, partner: false } })
    const p = spawnPlainPty({ plain: true, sessionId: 'newtab0123456789abcdef01' }, SHELL, [], opts())
    const seen: string[] = []
    p.onData((d) => seen.push(d))
    expect(await (p as HelperPty).adoption).toBe(true)
    await until(() => seen.join('').includes('partner before the update'), 'the replay in the new tab')
    // Shown again: Re-attach now says so, as for any terminal a tab shows.
    await until(() => liveOf(m).get(s.partner)?.isAttached === true, 'attached')
    expect(await m.reattach(s.partner)).toEqual({ ok: false, message: 'That terminal is already showing in a tab.' })
    expect(helper.holders.get(s.partner)!.endsAsked).toBe(0)
  })

  it('Re-attach moves the binding: a tab an earlier Re-attach bound to the terminal gets a terminal of its own when it starts again, and never takes or ends this one (PR review)', async () => {
    // A crash, then Re-attach moves the held terminal to tab N1.
    const first = await started(makeManager())
    setSessionHelper(first)
    spawnPlainPty({ plain: true, sessionId: PLAIN }, SHELL, [], opts())
    const sid = heldSessionId(PLAIN)
    await until(() => !!helper.holders.get(sid)?.attached, 'attached')
    helper.holders.get(sid)!.output('kept output\r\n')
    crash(first)
    let k = 0
    const second = await started(makeManager({ newTabId: () => `newtab0123456789abcdef${String(k++).padStart(2, '0')}` }))
    setSessionHelper(second)
    second.noteSavedTabs([])
    const N1 = 'newtab0123456789abcdef00'
    const N2 = 'newtab0123456789abcdef01'
    expect(await second.reattach(sid)).toMatchObject({ ok: true, tab: { id: N1, open: true } })
    const p1 = spawnPlainPty({ plain: true, sessionId: N1 }, SHELL, [], opts())
    expect(await (p1 as HelperPty).adoption).toBe(true)
    await until(() => liveOf(second).get(sid)?.isAttached === true, 'attached in N1')
    // The first tab, started again, runs a shell of its own under an id
    // derived from N1 (PR review, round 3: that id must not change later).
    const a = spawnPlainPty({ plain: true, sessionId: PLAIN }, SHELL, [], opts())
    const aSid = (a as HelperPty).sid
    expect(aSid).toBe(heldSessionId(`${PLAIN}/after/${N1}`))
    await until(() => !!helper.holders.get(aSid)?.attached, 'the first tab\'s own shell')
    helper.holders.get(aSid)!.output('its own shell\r\n')
    // An update that does not start: released, killed, reclaimed; then Re-attach to N2.
    second.noteSavedTabs([{ id: N1, label: 'Terminal' }, { id: PLAIN, label: 'Build' }])
    expect(second.releaseForUpdate(new Set([N1, PLAIN]))).toBe(2)
    p1.kill()
    a.kill()
    second.reclaim()
    // Attaches: run 1, run 2's keeper, N1, then reclaim's keeper.
    await until(() => !liveOf(second).has(sid) && helper.holders.get(sid)!.attaches === 4, 'the keeper')
    expect(await second.reattach(sid)).toMatchObject({ ok: true, tab: { id: N2, open: true } })
    expect(JSON.parse(readFileSync(join(root, 'bindings.json'), 'utf8')).bindings).toEqual({ [N2]: sid, [PLAIN]: aSid })
    // The first tab still finds its own shell, not a fresh one.
    expect(second.sidFor(PLAIN)).toBe(aSid)
    const a2 = spawnPlainPty({ plain: true, sessionId: PLAIN }, SHELL, [], opts())
    const aSeen: string[] = []
    a2.onData((d) => aSeen.push(d))
    expect(await (a2 as HelperPty).adoption).toBe(true)
    await until(() => aSeen.join('').includes('its own shell'), 'the first tab\'s replay')
    // N1 started again: a terminal of its own, not this one.
    const again = spawnPlainPty({ plain: true, sessionId: N1 }, SHELL, [], opts())
    expect(second.sidFor(N1)).not.toBe(sid)
    const p2 = spawnPlainPty({ plain: true, sessionId: N2 }, SHELL, [], opts())
    const seen: string[] = []
    p2.onData((d) => seen.push(d))
    expect(await (p2 as HelperPty).adoption).toBe(true)
    await until(() => seen.join('').includes('kept output'), 'the replay in N2')
    expect(await (again as HelperPty).adoption).toBe(false)
    await tick(50)
    expect(helper.holders.get(sid)!.endsAsked).toBe(0)
    expect(helper.holders.get(aSid)!.endsAsked).toBe(0)
  })

  it('a chain of moves: the first tab\'s shell moved, then its replacement moved too; the first tab then gets a third id of its own and takes neither (PR review)', async () => {
    let k = 0
    const tabs = () => `newtab0123456789abcdef${String(k++).padStart(2, '0')}`
    // Run 1: the tab's shell, then the app is gone.
    const first = await started(makeManager())
    setSessionHelper(first)
    spawnPlainPty({ plain: true, sessionId: PLAIN }, SHELL, [], opts())
    const s0 = heldSessionId(PLAIN)
    await until(() => !!helper.holders.get(s0)?.attached, 'attached')
    crash(first)
    // Run 2: Re-attach moves it to N1; the first tab starts a replacement; the app is gone.
    const second = await started(makeManager({ newTabId: tabs }))
    setSessionHelper(second)
    second.noteSavedTabs([])
    const N1 = 'newtab0123456789abcdef00'
    expect(await second.reattach(s0)).toMatchObject({ ok: true, tab: { id: N1 } })
    const p1 = spawnPlainPty({ plain: true, sessionId: N1 }, SHELL, [], opts())
    expect(await (p1 as HelperPty).adoption).toBe(true)
    const a = spawnPlainPty({ plain: true, sessionId: PLAIN }, SHELL, [], opts())
    const s1 = (a as HelperPty).sid
    expect(s1).toBe(heldSessionId(`${PLAIN}/after/${N1}`))
    await until(() => !!helper.holders.get(s1)?.attached && liveOf(second).get(s0)?.isAttached === true, 'both attached')
    crash(second)
    // Run 3: no tab restored; Re-attach moves the replacement to N2.
    k = 2
    const third = await started(makeManager({ newTabId: tabs }))
    setSessionHelper(third)
    third.noteSavedTabs([])
    const N2 = 'newtab0123456789abcdef02'
    expect(await third.reattach(s1)).toMatchObject({ ok: true, tab: { id: N2 } })
    // The first tab: neither the original (N1's) nor the replacement (N2's).
    const s2 = third.sidFor(PLAIN)
    expect(s2).not.toBe(s0)
    expect(s2).not.toBe(s1)
    expect(s2).toBe(heldSessionId(`${PLAIN}/after/${N1}/after/${N2}`))
    const a2 = spawnPlainPty({ plain: true, sessionId: PLAIN }, SHELL, [], opts())
    expect(await (a2 as HelperPty).adoption).toBe(false)
    const p2 = spawnPlainPty({ plain: true, sessionId: N2 }, SHELL, [], opts())
    expect(await (p2 as HelperPty).adoption).toBe(true)
    await tick(50)
    expect(helper.holders.get(s1)!.endsAsked).toBe(0)
    expect(helper.holders.get(s0)!.endsAsked).toBe(0)
  })

  it('a tab started again before its earlier terminal finished ending keeps the binding its new terminal runs under (PR review)', async () => {
    const first = await started(makeManager())
    setSessionHelper(first)
    spawnPlainPty({ plain: true, sessionId: PLAIN }, SHELL, [], opts())
    const s0 = heldSessionId(PLAIN)
    await until(() => !!helper.holders.get(s0)?.attached, 'attached')
    crash(first)
    const second = await started(makeManager())
    setSessionHelper(second)
    second.noteSavedTabs([])
    const N1 = 'newtab0123456789abcdef01'
    await second.reattach(s0)
    const p1 = spawnPlainPty({ plain: true, sessionId: N1 }, SHELL, [], opts())
    expect(await (p1 as HelperPty).adoption).toBe(true)
    // The first tab's own shell, under its derived id (kept as its binding).
    const a = spawnPlainPty({ plain: true, sessionId: PLAIN }, SHELL, [], opts())
    const s1 = (a as HelperPty).sid
    await until(() => !!helper.holders.get(s1)?.attached, 'attached')
    // A Restart: the old terminal's end is slow to be answered.
    let answer!: () => void
    helper.holders.get(s1)!.endGate = new Promise<void>((r) => { answer = r })
    a.kill()
    const again = spawnPlainPty({ plain: true, sessionId: PLAIN }, SHELL, [], opts())
    expect((again as HelperPty).sid).toBe(s1)
    answer()
    await until(() => helper.made.filter((h) => h.sid === s1).length === 2 && !!helper.holders.get(s1)?.attached, 'the new terminal')
    await tick(50)
    // The old terminal's end left the new one's binding alone.
    expect(JSON.parse(readFileSync(join(root, 'bindings.json'), 'utf8')).bindings).toEqual({ [N1]: s0, [PLAIN]: s1 })
    expect(second.sidFor(PLAIN)).toBe(s1)
  })

  it('Re-attach is refused while an update goes on, also when the update began while its listing ran (PR review)', async () => {
    const m = await startedWith(makeManager(), ON_BOTH)
    const ptys = await fourHeld(m)
    const s = sids()
    m.releaseForUpdate(SAVED)
    killAll(ptys)
    m.reclaim()
    await until(() => helper.holders.get(s.plain)!.attaches === 2, 'the keeper')
    let open!: () => void
    helper.listGate = new Promise<void>((r) => { open = r })
    const asked = m.reattach(s.plain)
    await until(() => helper.calls.filter((c) => c.args[0] === 'list').length > 0 && !!helper.listGate, 'the listing under way')
    // A retry begins while the listing runs.
    expect(m.releaseForUpdate(SAVED)).toBe(0)
    helper.listGate = null
    open()
    expect(await asked).toEqual({ ok: false, message: HELPER_SENTENCES.updating })
    expect(await m.reattach(s.plain)).toEqual({ ok: false, message: HELPER_SENTENCES.updating })
    expect(JSON.parse(readFileSync(join(root, 'bindings.json'), 'utf8')).bindings).toEqual({})
    expect(m.holdsFor(PLAIN)).toBe(true)
  })

  it('while an update goes on, a tab started again does not take over a terminal kept for it, so the kill that follows cannot end it (PR review)', async () => {
    const m = await startedWith(makeManager(), ON_BOTH)
    const ptys = await fourHeld(m)
    const s = sids()
    m.releaseForUpdate(SAVED)
    killAll(ptys)
    m.reclaim()
    await until(() => helper.holders.get(s.plain)!.attaches === 2, 'the keeper')
    // A retry, its tab still saved: the kept terminal stays kept.
    expect(m.releaseForUpdate(SAVED)).toBe(0)
    const p = spawnPlainPty({ plain: true, sessionId: PLAIN }, SHELL, [], opts())
    expect(p).not.toBeInstanceOf(HelperPty)
    p.kill()
    await tick(50)
    expect(helper.holders.get(s.plain)!.endsAsked).toBe(0)
    expect(helper.holders.get(s.plain)!.ended).toBe(false)
    expect(m.holdsFor(PLAIN)).toBe(true)
  })

  it('after an update that did not start, a retry with Save leaves what reclaim kept running, its tab saved or not; a retry with "Close sessions" ends it (PR review, section B3)', async () => {
    const m = await startedWith(makeManager(), ON_BOTH)
    const ptys = await fourHeld(m)
    const s = sids()
    m.releaseForUpdate(SAVED)
    killAll(ptys)
    m.reclaim()
    await until(() => helper.holders.get(s.plain)!.attaches === 2 && helper.holders.get(s.partner)!.attaches === 2, 'the keepers')
    // The retry with Save: only the plain terminal's tab is still saved.
    // Neither kept terminal is ended: both run on past the exit.
    m.noteSavedTabs([{ id: PLAIN, label: 'Build' }])
    expect(m.releaseForUpdate(new Set([PLAIN]))).toBe(0)
    await m.endsForUpdate()
    await tick(30)
    for (const sid of [s.plain, s.partner]) {
      expect(helper.holders.get(sid)!.endsAsked).toBe(0)
      expect(helper.holders.get(sid)!.ended).toBe(false)
    }
    expect(m.holdsFor(PARTNER)).toBe(true)
    expect(m.holdsFor(PLAIN)).toBe(true)
    // The retry with "Close sessions": the saved file is cleared, so both go.
    // The ends are answered by the time endsForUpdate settles (app-wiring
    // waits for it, bounded, before the update goes on).
    expect(m.releaseForUpdate(null)).toBe(0)
    await m.endsForUpdate()
    expect(helper.holders.get(s.partner)!.ended).toBe(true)
    expect(helper.holders.get(s.plain)!.ended).toBe(true)
    expect(m.holdsFor(PARTNER)).toBe(false)
    expect(m.holdsFor(PLAIN)).toBe(false)
  })

  it('a normal quit that overtakes the update ends what was let go of too (PR review)', async () => {
    const m = await startedWith(makeManager(), ON_BOTH)
    const ptys = await fourHeld(m)
    const s = sids()
    expect(m.releaseForUpdate(SAVED)).toBe(2)
    killAll(ptys)
    const done = m.shutdown()
    expect(done).not.toBeNull()
    await done
    expect(helper.holders.get(s.plain)!.ended).toBe(true)
    expect(helper.holders.get(s.partner)!.ended).toBe(true)
    expect(existsSync(join(root, 'app-running.json'))).toBe(false)
  })

  it('a start-up listing that answers after the release neither ends what was let go of nor keeps it (PR review)', async () => {
    let open!: () => void
    helper.listGate = new Promise<void>((r) => { open = r })
    const m = makeManager()
    setSessionHelper(m)
    void m.start({ atStartup: true })
    await until(() => helper.calls.some((c) => c.args[0] === 'list'), 'the start-up listing under way')
    const p = spawnPlainPty({ plain: true, sessionId: PLAIN }, SHELL, [], opts())
    const sid = heldSessionId(PLAIN)
    await until(() => !!helper.holders.get(sid)?.attached, 'attached')
    m.noteSavedTabs([{ id: PLAIN, label: 'Build' }])
    expect(m.releaseForUpdate(new Set([PLAIN]))).toBe(1)
    p.kill()
    await until(() => !liveOf(m).has(sid), 'the tab\'s terminal to drop')
    helper.listGate = null
    open()
    await until(() => m.serviceState().state === 'ready', 'the listing to answer')
    await tick(50)
    const h = helper.holders.get(sid)!
    expect(h.endsAsked).toBe(0)
    expect(h.ended).toBe(false)
    expect(h.attaches).toBe(1)
    expect(m.holdsFor(PLAIN)).toBe(false)
  })

  it('a tab in the app\'s last save but not in the saved file (Close without saving cleared it), or the other way round: not let go of, and ended as before', async () => {
    const m = await started(makeManager())
    setSessionHelper(m)
    const p = spawnPlainPty({ plain: true, sessionId: PLAIN }, SHELL, [], opts())
    const sid = heldSessionId(PLAIN)
    await until(() => !!helper.holders.get(sid)?.attached, 'attached')
    m.noteSavedTabs([{ id: PLAIN, label: 'Build' }])
    expect(m.releaseForUpdate(null)).toBe(0)
    p.kill()
    await until(() => helper.holders.get(sid)!.ended, 'the end')
    expect(m.reclaim()).toBe(0)
    const q = spawnPlainPty({ plain: true, sessionId: UNSAVED }, SHELL, [], opts())
    const sid2 = heldSessionId(UNSAVED)
    await until(() => !!helper.holders.get(sid2)?.attached, 'attached')
    m.noteSavedTabs([])
    expect(m.releaseForUpdate(new Set([UNSAVED]))).toBe(0)
    q.kill()
    await until(() => helper.holders.get(sid2)!.ended, 'the end')
  })

  it('a terminal still starting at the update is not let go of: the kill ends it once its holder is up', async () => {
    const m = await started(makeManager())
    setSessionHelper(m)
    let open!: () => void
    helper.holdGate = new Promise<void>((r) => { open = r })
    const p = spawnPlainPty({ plain: true, sessionId: PLAIN }, SHELL, [], opts())
    m.noteSavedTabs([{ id: PLAIN, label: 'Build' }])
    await until(() => helper.holds() === 1, 'the hold under way')
    expect(m.releaseForUpdate(new Set([PLAIN]))).toBe(0)
    p.kill()
    helper.holdGate = null
    open()
    await until(() => helper.holders.get(heldSessionId(PLAIN))?.ended === true, 'the late holder to end')
  })

  it('off Windows nothing is let go of: new terminals still go through the helper, and the mark is left as it was', async () => {
    const m = await started(makeManager({ platform: 'linux', checkEndpointFolder: () => null }))
    const before = readFileSync(join(root, 'app-running.json'), 'utf8')
    m.noteSavedTabs([{ id: PLAIN, label: 'Build' }])
    expect(m.releaseForUpdate(new Set([PLAIN]))).toBe(0)
    expect(m.routesPlain()).toBe(true)
    expect(readFileSync(join(root, 'app-running.json'), 'utf8')).toBe(before)
  })

  it('a tab Re-attach opened keeps its terminal through the update: its binding stays, and the next start shows the terminal in that tab', async () => {
    const first = await started(makeManager())
    setSessionHelper(first)
    spawnPlainPty({ plain: true, sessionId: PLAIN }, SHELL, [], opts())
    const sid = heldSessionId(PLAIN)
    await until(() => !!helper.holders.get(sid)?.attached, 'attached')
    helper.holders.get(sid)!.output('kept output\r\n')
    crash(first)
    const second = await started(makeManager())
    setSessionHelper(second)
    second.noteSavedTabs([])
    const NEW = 'newtab0123456789abcdef01'
    expect(await second.reattach(sid)).toMatchObject({ ok: true, tab: { id: NEW, open: true } })
    const p = spawnPlainPty({ plain: true, sessionId: NEW }, SHELL, [], opts())
    expect(await (p as HelperPty).adoption).toBe(true)
    await until(() => liveOf(second).get(sid)?.isAttached === true, 'attached in the new tab')
    second.noteSavedTabs([{ id: NEW, label: 'Terminal' }])
    expect(second.releaseForUpdate(new Set([NEW]))).toBe(1)
    p.kill()
    await until(() => !liveOf(second).has(sid), 'the tab\'s terminal to drop')
    expect(JSON.parse(readFileSync(join(root, 'bindings.json'), 'utf8')).bindings).toEqual({ [NEW]: sid })
    crash(second)
    const third = makeManager()
    setSessionHelper(third)
    void third.start({ atStartup: true })
    const q = spawnPlainPty({ plain: true, sessionId: NEW }, SHELL, [], opts())
    const seen: string[] = []
    q.onData((d) => seen.push(d))
    expect(await (q as HelperPty).adoption).toBe(true)
    await until(() => seen.join('').includes('kept output'), 'the replay in that tab')
    expect(helper.holders.get(sid)!.endsAsked).toBe(0)
  })

  /** Run 1 holds a terminal for each tab, then the app is gone; run 2 takes
   *  the crash path and keeps each one, with no tab of its own showing it. */
  async function keptAfterCrash(tabs: string[], over: Parameters<typeof makeManager>[0] = {}): Promise<SessionHelperManager> {
    const first = await started(makeManager())
    setSessionHelper(first)
    for (const tab of tabs) spawnPlainPty({ plain: true, sessionId: tab }, SHELL, [], opts())
    await until(() => tabs.every((tab) => !!helper.holders.get(heldSessionId(tab))?.attached), 'all attached')
    crash(first)
    const second = await started(makeManager(over))
    setSessionHelper(second)
    await until(() => tabs.every((tab) => helper.holders.get(heldSessionId(tab))!.attaches === 2), 'the keepers')
    for (const tab of tabs) expect(second.holdsFor(tab)).toBe(true)
    return second
  }

  it('kept for a tab that no tab took over (after a crash): with Save it runs on through the update, its tab saved or not, and the log says so; with "Close sessions" every one is ended, so none is left held (PR review, section B3)', async () => {
    const logs: string[] = []
    const second = await keptAfterCrash([PLAIN, UNSAVED], { log: (l) => logs.push(l) })
    const s = sids()
    // "Save sessions" with only the plain terminal's tab saved.
    second.noteSavedTabs([{ id: PLAIN, label: 'Build' }])
    expect(second.releaseForUpdate(new Set([PLAIN]))).toBe(0)
    await second.endsForUpdate()
    await tick(30)
    for (const sid of [s.plain, s.unsaved]) {
      expect(helper.holders.get(sid)!.endsAsked).toBe(0)
      expect(helper.holders.get(sid)!.ended).toBe(false)
    }
    expect(second.holdsFor(UNSAVED)).toBe(true)
    expect(second.holdsFor(PLAIN)).toBe(true)
    expect(logs).toContain(`[session-helper] ${s.unsaved}: kept with no tab showing it; left running through the update, for the next start to keep again`)
    expect(logs).toContain('[session-helper] an app update: 0 held terminal(s) are let go of, for the new version to show again; 2 kept terminal(s) are left running')
    // A retry with "Close sessions": the saved file is cleared, so both go,
    // the one whose tab the last save still names too.
    expect(second.releaseForUpdate(null)).toBe(0)
    await second.endsForUpdate()
    for (const sid of [s.plain, s.unsaved]) {
      expect(helper.holders.get(sid)!.endsAsked).toBe(1)
      expect(helper.holders.get(sid)!.ended).toBe(true)
    }
    expect(second.holdsFor(PLAIN)).toBe(false)
    expect(second.holdsFor(UNSAVED)).toBe(false)
    expect(logs).toContain('[session-helper] an app update: 0 held terminal(s) are let go of, for the new version to show again; the sessions were discarded, so 2 kept terminal(s) are ended')
  })

  it('Save with no tab saved at all: a kept terminal no tab shows still runs on through the update (the choice is the user\'s, never read from an empty set) (section B3)', async () => {
    const second = await keptAfterCrash([UNSAVED])
    const sid = heldSessionId(UNSAVED)
    second.noteSavedTabs([])
    expect(second.releaseForUpdate(new Set())).toBe(0)
    await second.endsForUpdate()
    await tick(30)
    expect(helper.holders.get(sid)!.endsAsked).toBe(0)
    expect(helper.holders.get(sid)!.ended).toBe(false)
    expect(second.holdsFor(UNSAVED)).toBe(true)
  })

  it('a saved file that did not read (app-wiring passes an empty set): nothing is let go of, and a kept terminal no tab shows is not ended (section B3)', async () => {
    const second = await keptAfterCrash([UNSAVED])
    const kept = heldSessionId(UNSAVED)
    // A tab of this run, in its last save, through a holder.
    const p = spawnPlainPty({ plain: true, sessionId: PLAIN }, SHELL, [], opts())
    const live = heldSessionId(PLAIN)
    await until(() => !!helper.holders.get(live)?.attached, 'attached')
    second.noteSavedTabs([{ id: PLAIN, label: 'Build' }])
    expect(second.releaseForUpdate(new Set())).toBe(0)
    p.kill()
    await until(() => helper.holders.get(live)!.ended, 'the tab\'s terminal to end with the kill, as before')
    await second.endsForUpdate()
    await tick(30)
    expect(helper.holders.get(kept)!.endsAsked).toBe(0)
    expect(helper.holders.get(kept)!.ended).toBe(false)
    expect(second.holdsFor(UNSAVED)).toBe(true)
  })

  it('after a crash, a start-up listing that answers after the release neither keeps what was let go of nor ends it (PR review)', async () => {
    // The last run did not quit normally, so this start takes the crash path.
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'app-running.json'), JSON.stringify({ v: 1, pid: 1, at: 1 }))
    let open!: () => void
    helper.listGate = new Promise<void>((r) => { open = r })
    const m = makeManager()
    setSessionHelper(m)
    void m.start({ atStartup: true })
    await until(() => helper.calls.some((c) => c.args[0] === 'list'), 'the start-up listing under way')
    const p = spawnPlainPty({ plain: true, sessionId: PLAIN }, SHELL, [], opts())
    const sid = heldSessionId(PLAIN)
    await until(() => !!helper.holders.get(sid)?.attached, 'attached')
    m.noteSavedTabs([{ id: PLAIN, label: 'Build' }])
    expect(m.releaseForUpdate(new Set([PLAIN]))).toBe(1)
    p.kill()
    await until(() => !liveOf(m).has(sid), 'the tab\'s terminal to drop')
    helper.listGate = null
    open()
    await until(() => m.serviceState().state === 'ready', 'the listing to answer')
    await tick(50)
    const h = helper.holders.get(sid)!
    expect(h.endsAsked).toBe(0)
    expect(h.ended).toBe(false)
    expect(h.attaches).toBe(1)
    expect(m.holdsFor(PLAIN)).toBe(false)
    expect((m as unknown as { keepers: Map<string, unknown> }).keepers.has(sid)).toBe(false)
  })

  it('a chain of moves deeper than any fixed limit: the first tab still gets an id no other tab is bound to (PR review)', async () => {
    const m = await started(makeManager())
    const bindings = (m as unknown as { bindings: Map<string, string> }).bindings
    // Twenty Re-attach moves, each tab's replacement moved again.
    let seed = PLAIN
    for (let i = 0; i < 20; i++) {
      const tab = `newtab0123456789abcd${String(i).padStart(4, '0')}`
      bindings.set(tab, heldSessionId(seed))
      seed = `${seed}/after/${tab}`
    }
    const sid = m.sidFor(PLAIN)
    expect([...bindings.values()]).not.toContain(sid)
    expect(sid).toBe(heldSessionId(seed))
  })
})
