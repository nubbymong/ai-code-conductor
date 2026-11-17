import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { IPty } from 'node-pty'

// node-pty is the usual way: the spy shows every terminal that did NOT go
// through the helper, with the exact arguments it was given.
const ptySpawn = vi.hoisted(() => vi.fn())
vi.mock('node-pty', () => ({ spawn: ptySpawn }))

import { HELPER_SENTENCES, SessionHelperManager, offStillHoldingSentence, setSessionHelper, spawnPlainPty, whenHeldKnown } from '../../../src/main/session-helper/manager'
import { HolderConnection } from '../../../src/main/session-helper/connection'
import { HelperPty } from '../../../src/main/session-helper/helper-pty'
import { heldSessionId } from '../../../src/main/session-helper/protocol'
import { versionFolderName } from '../../../src/main/session-helper/install'
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
    spawnDirect: (file, args, o) => ptySpawn(file, args, o), newTabId: () => 'newtab0123456789abcdef01', ...over,
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

  it('a terminal still starting at the quit is ended once its holder is up', async () => {
    const m = await started(makeManager())
    setSessionHelper(m)
    spawnPlainPty({ plain: true, sessionId: 'abcdef0123456789abcdef24' }, SHELL, [], opts())
    const sid = heldSessionId('abcdef0123456789abcdef24')
    const done = m.shutdown()
    expect(done).not.toBeNull()
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
