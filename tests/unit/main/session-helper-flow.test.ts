/**
 * One terminal through a holder, end to end over the protocol (2.1.3-beta.6,
 * plan section B): typed input paced by pings and sent again when the program
 * was not reading (docs/remote/helper-protocol.md, section 15), a connection
 * that fell behind attached again from the last byte seen, a holder that
 * cannot be shown any more read as ended in its tab and ended too, and the
 * hello and endpoint checks a connection makes before it writes anything.
 *
 * PURE: the real HelperPty and HolderConnection against the fake holder, in
 * memory; the clock for the attach-again budget is the test's own.
 *
 * 2.1.3-beta.8 (plan section B2): the whole round of an app update on
 * Windows, through two managers and the fake helper's away clock (the
 * test's own clock too).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, rmdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { IPty } from 'node-pty'
import { HolderConnection, HolderError, INPUT_FRAMES_PER_PING, unixEndpointFolderProblem } from '../../../src/main/session-helper/connection'
import { EventEmitter } from 'events'
import { HelperPty, LOST_EXIT_CODE, NothingStartedError, type HelperPtyDriver } from '../../../src/main/session-helper/helper-pty'
import { PTY_IO_FAILED_GRACE_MS, PTY_IO_FAILED_TEXT } from '../../../src/main/pty-input-guard'
import { RAW_MAX, heldSessionId, type HolderRecord, type LaunchSpec } from '../../../src/main/session-helper/protocol'
import { SessionHelperManager } from '../../../src/main/session-helper/manager'
import { FakeHelper, FakeHolder, duplexPair, type ConnEvent } from './session-helper-fake-holder'

// The managers below are given their own usual-way spawn; node-pty itself is never loaded.
vi.mock('node-pty', () => ({ spawn: () => { throw new Error('node-pty is not used in this file') } }))

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, what: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await tick(5)
  }
}

function fakeDirect(): IPty {
  return { pid: 1, cols: 80, rows: 24, process: 'x', handleFlowControl: false, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), resize() {}, clear() {}, write() {}, kill() {}, pause() {}, resume() {} } as unknown as IPty
}

interface Rig {
  h: FakeHolder
  p: HelperPty
  seen: string[]
  exits: number[]
  /** Every connection the terminal opened, in order. */
  conns: HolderConnection[]
  direct: ReturnType<typeof vi.fn>
  clock: { now: number }
  text: () => string
  typed: () => string
}

const folders: string[] = []
const rigs: Rig[] = []
let n = 0

afterEach(async () => {
  for (const r of rigs.splice(0)) {
    r.h.vanish()
    for (const c of r.conns) c.close()
  }
  await tick(10)
  for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/**
 * A terminal through one fake holder. `adopt` takes over a holder whose
 * terminal runs already (set it up in `before`); otherwise the terminal is
 * launched. `connect` wraps every connection the terminal opens.
 */
function rig(o: {
  adopt?: boolean
  cols?: number
  rows?: number
  replyTimeoutMs?: number
  /** Launch fields besides argv, cwd, env and the size (the Windows `line` and `conpty`). */
  spec?: Partial<LaunchSpec>
  before?: (h: FakeHolder) => void
  connect?: (record: HolderRecord, open: (record: HolderRecord) => Promise<HolderConnection>) => Promise<HolderConnection>
} = {}): Rig {
  const store = mkdtempSync(join(tmpdir(), 'aicc-helper-flow-'))
  folders.push(store)
  const app = `abcdef0123456789abcdef${String(n++ % 100).padStart(2, '0')}`
  const h = new FakeHolder(heldSessionId(app), app, store)
  o.before?.(h)
  const conns: HolderConnection[] = []
  const clock = { now: 1_000_000 }
  const direct = vi.fn(() => fakeDirect())
  const open = (record: HolderRecord) => HolderConnection.open({
    record,
    os: 'windows',
    openStream: async () => {
      if (h.gone || h.ended) throw new HolderError('io', 'no holder at that endpoint')
      return h.connect()
    },
    replyTimeoutMs: o.replyTimeoutMs ?? 2000,
    pingEveryMs: 0,
  })
  const driver: HelperPtyDriver = {
    hold: async () => {
      h.writeRecord()
      return h.record()
    },
    connect: async (record) => {
      const c = await (o.connect ? o.connect(record, open) : open(record))
      conns.push(c)
      return c
    },
    direct,
    ending: () => {},
    attachedChanged: () => {},
    log: () => {},
    now: () => clock.now,
  }
  const p = new HelperPty({
    sid: h.sid,
    label: app,
    spec: { argv: ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'], cwd: 'C:\\Users\\someone', env: { Path: 'C:\\Windows' }, cols: o.cols ?? 80, rows: o.rows ?? 24, ...o.spec },
    ...(o.adopt ? { adopt: h.record() } : {}),
    driver,
  })
  const seen: string[] = []
  const exits: number[] = []
  p.onData((d) => seen.push(d))
  p.onExit((e) => exits.push(e.exitCode))
  const r: Rig = {
    h, p, seen, exits, conns, direct, clock,
    text: () => seen.join(''),
    typed: () => Buffer.concat(h.input).toString('utf8'),
  }
  rigs.push(r)
  return r
}

async function attached(r: Rig): Promise<void> {
  await until(() => r.p.isAttached, 'the terminal to attach')
}

/** A holder whose terminal runs already, for a take-over. */
const running = (ring = '') => (h: FakeHolder) => {
  h.launch = { t: 'term.launch' }
  h.child = 'running'
  h.ring = Buffer.from(ring, 'utf8')
}

describe('typed input: paced by pings, and sent again when the program was not reading', () => {
  it('every key reaches the program once and in order while the program stops reading for a while, on the one connection', async () => {
    const r = rig()
    await attached(r)
    r.h.inputCapacity = 4
    r.h.reading = false
    const keys = Array.from({ length: 40 }, (_, i) => `k${i};`)
    for (const k of keys) r.p.write(k)
    await until(() => r.h.busies > 0, 'a refusal')
    await tick(60)
    r.h.startReading()
    await until(() => r.typed() === keys.join(''), `every key in order (got ${r.typed().length} of ${keys.join('').length} characters)`)
    expect(r.conns).toHaveLength(1)
    expect(r.h.attaches).toBe(1)
    expect(r.exits).toEqual([])
  })

  it('a ping goes after every 16 frames, and nothing more is typed until its pong', async () => {
    const r = rig()
    await attached(r)
    r.h.pongDelayMs = 30
    for (let i = 0; i < 40; i++) r.p.write(`x${i}`)
    await until(() => r.h.input.length === 40, 'all forty frames')
    const log: ConnEvent[] = r.h.attached!.log
    let run = 0
    let waitingForPong = false
    for (const e of log) {
      if ('raw' in e) {
        expect(waitingForPong, 'no frame between a ping and its pong').toBe(false)
        run++
        expect(run).toBeLessThanOrEqual(INPUT_FRAMES_PER_PING)
      } else if ('t' in e && e.t === 'ping') {
        waitingForPong = true
        run = 0
      } else if ('pong' in e) {
        waitingForPong = false
      }
    }
    expect(log.filter((e) => 't' in e && e.t === 'ping').length).toBeGreaterThanOrEqual(2)
  })

  it('a large paste goes in frames of at most 64 KiB and arrives whole', async () => {
    const r = rig()
    await attached(r)
    const paste = Buffer.alloc(200_000)
    for (let i = 0; i < paste.length; i++) paste[i] = 97 + (i % 26)
    r.p.write(paste)
    await until(() => Buffer.concat(r.h.input).length === paste.length, 'the whole paste')
    expect(Buffer.concat(r.h.input).equals(paste)).toBe(true)
    const sizes = r.h.attached!.log.flatMap((e) => ('raw' in e ? [e.raw] : []))
    expect(Math.max(...sizes)).toBeLessThanOrEqual(RAW_MAX)
  })

  it('what was typed and not sent when a connection dropped goes first on the next one, and nothing is typed twice', async () => {
    const r = rig()
    await attached(r)
    r.h.pongDelayMs = 300
    const keys = Array.from({ length: 20 }, (_, i) => `u${String(i).padStart(2, '0')};`)
    for (const k of keys) r.p.write(k)
    await until(() => r.h.input.length === 16, 'the first sixteen frames')
    await tick(30)
    // The rest waits for the pong.
    expect(r.h.input.length).toBe(16)
    r.h.fallBehind()
    await until(() => r.typed() === keys.join(''), 'the last four on the new connection')
    expect(r.h.attaches).toBe(2)
    expect(r.exits).toEqual([])
  })
})

describe('a connection that drops while the terminal runs is attached again', () => {
  it('falling behind four times, never more than three in a minute: still attached, every byte shown once', async () => {
    const r = rig()
    await attached(r)
    r.h.output('one ')
    await until(() => r.text() === 'one ', 'the first output')
    for (let i = 0; i < 4; i++) {
      r.clock.now += 25_000
      r.h.fallBehind()
      // Written while nobody is attached: in the ring only, shown by the replay.
      r.h.output(`after${i} `)
      await until(() => r.h.attaches === i + 2 && r.p.isAttached, `attach number ${i + 2}`)
    }
    await until(() => r.text() === 'one after0 after1 after2 after3 ', `the output once each (${JSON.stringify(r.text())})`)
    expect(r.exits).toEqual([])
    expect(r.h.ended).toBe(false)
    expect(r.direct).not.toHaveBeenCalled()
  })

  it('a fourth drop inside a minute: the tab reads it as ended and the holder is ended', async () => {
    const r = rig()
    await attached(r)
    for (let i = 0; i < 3; i++) {
      r.clock.now += 1_000
      r.h.fallBehind()
      await until(() => r.h.attaches === i + 2 && r.p.isAttached, `attach number ${i + 2}`)
    }
    r.clock.now += 1_000
    r.h.fallBehind()
    await until(() => r.exits.length === 1 && r.h.ended, 'the exit and the end')
    expect(r.exits).toEqual([LOST_EXIT_CODE])
    expect(r.h.attaches).toBe(4)
    expect(r.direct).not.toHaveBeenCalled()
  })

  it('a character split where the connection dropped is still shown whole', async () => {
    const r = rig()
    await attached(r)
    const bytes = Buffer.from('a\u20acb', 'utf8')
    r.h.outputBytes(bytes.subarray(0, 3))
    await until(() => r.text() === 'a', 'the first character')
    r.h.fallBehind()
    r.h.outputBytes(bytes.subarray(3))
    await until(() => r.p.isAttached && r.text() === 'a\u20acb', `the rest (${JSON.stringify(r.text())})`)
    expect(r.text()).not.toContain('\ufffd')
  })

  it('a holder that is gone: one exit, nothing left connected, and no shell the usual way', async () => {
    const r = rig()
    await attached(r)
    r.h.vanish()
    await until(() => r.exits.length === 1, 'the exit')
    await r.p.ended
    await tick(30)
    expect(r.exits).toEqual([LOST_EXIT_CODE])
    expect(r.conns.every((c) => c.isClosed)).toBe(true)
    expect(r.direct).not.toHaveBeenCalled()
  })

  it('a tab closed while it attaches again: the tab gets its exit and the holder is ended', async () => {
    let gate: Promise<void> | null = null
    let release: () => void = () => {}
    const r = rig({ connect: async (record, open) => { if (gate) await gate; return open(record) } })
    await attached(r)
    gate = new Promise<void>((res) => { release = res })
    r.h.fallBehind()
    await until(() => !r.p.isAttached, 'the drop')
    await tick(10)
    r.p.kill()
    release()
    await until(() => r.exits.length === 1 && r.h.ended, 'the exit and the end')
    await tick(30)
    expect(r.exits).toHaveLength(1)
  })
})

describe('starting and ending', () => {
  it('an attach the holder never answers: the tab reads it as ended and the holder is ended, with no second shell', async () => {
    const r = rig({ replyTimeoutMs: 150, before: (h) => { h.answerAttach = false } })
    await until(() => r.exits.length === 1, 'the exit')
    expect(r.exits).toEqual([LOST_EXIT_CODE])
    await until(() => r.h.ended, 'the end of the holder')
    expect(r.direct).not.toHaveBeenCalled()
  })

  it('nothing the program writes after its exit reaches the tab', async () => {
    const r = rig()
    await attached(r)
    r.h.exitChild(5)
    r.h.output('late')
    await until(() => r.exits.length === 1, 'the exit')
    await tick(30)
    expect(r.exits).toEqual([5])
    expect(r.text()).not.toContain('late')
  })

  it('the launch frame carries exactly the spec: the Windows `line` and `conpty` when given, nothing more when not', async () => {
    const cmd = 'C:\\Windows\\System32\\cmd.exe'
    const line = `${cmd} /d /v:off /s /c ""C:\\Users\\someone\\AppData\\Roaming\\npm\\tool.cmd" resume"`
    const both = rig({ spec: { argv: [cmd], line, conpty: 'bundled' } })
    await attached(both)
    expect(both.h.launch).toEqual({ t: 'term.launch', id: expect.any(Number), argv: [cmd], cwd: 'C:\\Users\\someone', env: { Path: 'C:\\Windows' }, cols: 80, rows: 24, line, conpty: 'bundled' })
    const plain = rig()
    await attached(plain)
    expect(Object.keys(plain.h.launch ?? {}).sort()).toEqual(['argv', 'cols', 'cwd', 'env', 'id', 'rows', 't'])
  })

  it('a resize while the launch is on its way is sent once the terminal is attached', async () => {
    const r = rig()
    r.h.onLaunch = () => r.p.resize(100, 40)
    await attached(r)
    await until(() => r.h.size !== null, 'the resize')
    expect(r.h.launch).toMatchObject({ cols: 80, rows: 24 })
    expect(r.h.size).toEqual({ cols: 100, rows: 40 })
  })

  it('a take-over shows the scrollback, then sends the tab\'s own size', async () => {
    const r = rig({ adopt: true, cols: 132, rows: 50, before: running('kept\r\n') })
    expect(await r.p.adoption).toBe(true)
    await until(() => r.text() === 'kept\r\n', 'the replay')
    await until(() => r.h.size !== null, 'the resize')
    expect(r.h.size).toEqual({ cols: 132, rows: 50 })
  })

  it('a take-over of a terminal over already: its last output, then its exit code, then the holder is ended', async () => {
    const r = rig({ adopt: true, before: (h) => { running('bye\r\n')(h); h.child = 'exited'; h.code = 7 } })
    await until(() => r.exits.length === 1, 'the exit')
    expect(r.text()).toBe('bye\r\n')
    expect(r.exits).toEqual([7])
    await until(() => r.h.ended, 'the end of the holder')
  })
})

/** A terminal whose hold is `hold` and whose usual way is `direct`, with no holder at all. */
function bare(hold: HelperPtyDriver['hold'], direct: () => IPty) {
  const logs: string[] = []
  const seen: string[] = []
  const exits: number[] = []
  const app = 'abcdef0123456789abcdefb0'
  const p = new HelperPty({
    sid: heldSessionId(app),
    label: app,
    spec: { argv: ['C:\\Windows\\System32\\cmd.exe'], cwd: 'C:\\Users\\someone', env: { Path: 'C:\\Windows' }, cols: 80, rows: 24 },
    driver: {
      hold,
      connect: async () => { throw new Error('no holder') },
      direct,
      ending: () => {},
      attachedChanged: () => {},
      log: (m) => logs.push(m),
    },
  })
  p.onData((d) => seen.push(d))
  p.onExit((e) => exits.push(e.exitCode))
  return { p, logs, seen, exits }
}

describe('nothing started, and the usual way after all (PR review)', () => {
  it('a hold that may start nothing (NothingStartedError) is logged as that, never as a start the usual way', async () => {
    const said = fakeDirect()
    const { p, logs } = bare(async () => { throw new NothingStartedError('the holder this tab had before is still running and could not be ended') }, () => said)
    await until(() => !p.throughHelper, 'the hand-over')
    expect(logs).toEqual([`[session-helper] ${p.sid}: nothing is started for this terminal, because the holder this tab had before is still running and could not be ended`])
  })

  it('a terminal ended while its hold waited: nothing is asked of the usual way, and the log says nothing was started', async () => {
    let fail!: (err: Error) => void
    const direct = vi.fn(() => fakeDirect())
    const { p, logs, exits } = bare((_sid, _label, abandoned) => new Promise((_resolve, reject) => {
      fail = (err) => { expect(abandoned()).toBe(true); reject(err) }
    }), direct)
    await tick(5)
    p.kill()
    fail(new NothingStartedError('it was ended before its holder started'))
    await until(() => exits.length === 1, 'the exit')
    expect(direct).not.toHaveBeenCalled()
    expect(logs).toEqual([`[session-helper] ${p.sid}: nothing is started for this terminal, because it was ended before its holder started`])
  })

  it('the usual-way terminal\'s input and output never throw (P3.15): each side is logged once, and one that does not end is ended after the grace, saying why', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      // node-pty's Windows terminal: its input socket, and its own `on` for the output's.
      const inSocket = new EventEmitter()
      const output = new EventEmitter()
      const kill = vi.fn()
      const inner = { ...fakeDirect(), _agent: { inSocket }, on: (event: string, l: (...a: unknown[]) => void) => { output.on(event, l) }, kill } as unknown as IPty
      const { p, logs, seen } = bare(async () => { throw new Error('the helper is not installed') }, () => inner)
      for (let i = 0; i < 10 && p.throughHelper; i++) await Promise.resolve()
      expect(p.throughHelper).toBe(false)
      const eagain = Object.assign(new Error('write EAGAIN'), { code: 'EAGAIN' })
      expect(() => inSocket.emit('error', eagain)).not.toThrow()
      expect(() => inSocket.emit('error', eagain)).not.toThrow()
      expect(() => output.emit('error', Object.assign(new Error('read EPIPE'), { code: 'EPIPE' }))).not.toThrow()
      expect(logs.filter((l) => l.includes('input to the usual-way terminal failed (EAGAIN)'))).toHaveLength(1)
      expect(logs.filter((l) => l.includes('output of the usual-way terminal failed (EPIPE)'))).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(PTY_IO_FAILED_GRACE_MS - 1)
      expect(kill).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(kill).toHaveBeenCalledTimes(1)
      expect(seen.join('')).toBe(PTY_IO_FAILED_TEXT)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a connection checks the holder before it writes anything', () => {
  const record = () => new FakeHolder(heldSessionId('abcdef0123456789abcdef99'), 'x', join(tmpdir(), 'unused')).record()

  it('a hello line over 4 KiB is refused, and so is one that never comes', async () => {
    const big = async () => {
      const [app, mine] = duplexPair()
      mine.write(`AICC-HELLO ${'x'.repeat(5000)}`)
      return app
    }
    await expect(HolderConnection.open({ record: record(), os: 'windows', openStream: big })).rejects.toMatchObject({ code: 'no-hello' })
    const silent = async () => duplexPair()[0]
    await expect(HolderConnection.open({ record: record(), os: 'windows', openStream: silent, helloTimeoutMs: 50 })).rejects.toMatchObject({ code: 'timeout' })
  })

  it('a quiet connection pings to stay open, and one whose pong does not come is closed', async () => {
    const store = mkdtempSync(join(tmpdir(), 'aicc-helper-flow-'))
    folders.push(store)
    const h = new FakeHolder(heldSessionId('abcdef0123456789abcdef98'), 'x', store)
    const c = await HolderConnection.open({ record: h.record(), os: 'windows', openStream: async () => h.connect(), pingEveryMs: 30, replyTimeoutMs: 100 })
    try {
      await until(() => [...h.conns].some((x) => x.log.some((e) => 'pong' in e)), 'a keep-alive ping and its pong')
      expect(c.isClosed).toBe(false)
      h.answerPing = false
      await until(() => c.isClosed, 'the close once a pong did not come')
    } finally {
      c.close()
      h.dropAll()
    }
  })

  it('an endpoint outside this user\'s own folder is refused', () => {
    expect(unixEndpointFolderProblem('/tmp/elsewhere/aicc-helper.sock')).toBe("the endpoint is not in this user's folder")
    expect(unixEndpointFolderProblem('/tmp/aicc-4000000000/aicc-helper.sock')).toBe("the endpoint is not in this user's folder")
  })

  // Unix only: the folder checks need Unix owners and modes, and /tmp on
  // Windows would be a folder at the root of the drive.
  it.skipIf(process.platform === 'win32')('on Unix: a folder open to others, a file in its place or a missing folder is refused; one only this user can open is not', () => {
    const uid = process.getuid!()
    const base = `/tmp/aicc-${uid}`
    const made = !existsSync(base)
    if (made) mkdirSync(base, { mode: 0o700 })
    const dir = mkdtempSync(join(base, 'flow-test-'))
    const file = `${dir}-file`
    try {
      chmodSync(dir, 0o700)
      expect(unixEndpointFolderProblem(`${dir}/x.sock`)).toBeNull()
      chmodSync(dir, 0o755)
      expect(unixEndpointFolderProblem(`${dir}/x.sock`)).toBe('the endpoint folder is open to other users')
      chmodSync(dir, 0o700)
      writeFileSync(file, 'not a folder')
      expect(unixEndpointFolderProblem(`${file}/x.sock`)).toBe('the endpoint folder is not a real folder')
      expect(unixEndpointFolderProblem(`${dir}-missing/x.sock`)).toBe('the endpoint folder cannot be read')
    } finally {
      rmSync(file, { force: true })
      rmSync(dir, { recursive: true, force: true })
      if (made) {
        try { rmdirSync(base) } catch { /* something else is in it now */ }
      }
    }
  })
})

describe('an app update on Windows, the whole round (plan section B2)', () => {
  const TAB = 'abcdef0123456789abcdefd1'
  const SID = heldSessionId(TAB)
  const SHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  const spawnOpts = () => ({ name: 'xterm-256color', cols: 120, rows: 30, cwd: 'C:\\Users\\someone', env: { Path: 'C:\\Windows' }, useConpty: true })

  /** The managers each test made, and the starts they began, for the teardown. */
  const made: SessionHelperManager[] = []
  const starts: Promise<unknown>[] = []
  let fake: FakeHelper | null = null

  afterEach(async () => {
    const quits = made.splice(0).map((m) => { try { return m.shutdown() } catch { return null } })
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      Promise.allSettled([...quits, ...starts.splice(0)]),
      new Promise<void>((r) => { timer = setTimeout(r, 3000) }),
    ]).finally(() => clearTimeout(timer))
    for (const h of fake?.holders.values() ?? []) h.vanish()
    fake = null
  })

  /** One computer: the installed helper, its per-user folder, the fake helper
   *  with an away clock on the test's own clock, and the app run by run. */
  function computer() {
    const dir = mkdtempSync(join(tmpdir(), 'aicc-helper-update-'))
    folders.push(dir)
    mkdirSync(join(dir, 'install'), { recursive: true })
    const bundled = join(dir, 'install', 'aicc-helper.exe')
    writeFileSync(bundled, 'MZ the installed helper')
    const root = join(dir, 'user', 'helper')
    const helper = new FakeHelper()
    fake = helper
    const clock = { now: 5_000_000 }
    helper.awayClock = () => clock.now
    const logs: string[] = []
    const gone = new Set<SessionHelperManager>()
    /** A run of the app: its manager, with the plain terminals' setting on. */
    const run = (): SessionHelperManager => {
      let self: SessionHelperManager | undefined
      const alive = () => { if (self && gone.has(self)) throw new Error('this app is gone') }
      const m = new SessionHelperManager({
        platform: 'win32', root, bundled,
        exec: async (file, args) => { alive(); return helper.exec(file, args) },
        openStream: async (endpoint) => { alive(); return helper.openStream(endpoint) },
        spawnDirect: () => fakeDirect(),
        conptySource: () => null,
        log: (line) => logs.push(line),
      })
      self = m
      made.push(m)
      starts.push(m.start({ atStartup: true, plain: true }))
      return m
    }
    /** The app exits for the installer (app.exit): no quit, so nothing more
     *  reaches a holder from it, and every connection it had drops. */
    const exit = (m: SessionHelperManager) => {
      made.splice(made.indexOf(m), 1)
      gone.add(m)
      for (const h of helper.holders.values()) h.dropAll()
    }
    return { helper, clock, logs, run, exit }
  }

  /** Run 1: a Terminal only tab through a holder, its output, then the update
   *  lets go of it, every PTY is killed, and the app exits. */
  async function updateWithOneHeld(c: ReturnType<typeof computer>): Promise<FakeHolder> {
    const m1 = c.run()
    await until(() => m1.serviceState().state === 'ready', 'the helper to be ready')
    const p1 = m1.spawn({ plain: true, sessionId: TAB }, SHELL, [], spawnOpts())
    await until(() => !!c.helper.holders.get(SID)?.attached, 'the terminal to attach')
    const h = c.helper.holders.get(SID)!
    const seen1: string[] = []
    p1.onData((d) => seen1.push(d))
    h.output('before the update\r\n')
    await until(() => seen1.join('') === 'before the update\r\n', 'the output in run 1')
    m1.noteSavedTabs([{ id: TAB, label: 'Build' }])
    expect(m1.releaseForUpdate(new Set([TAB]))).toBe(1)
    p1.kill()
    c.exit(m1)
    await until(() => h.conns.size === 0 && h.awaySince !== null, 'the app to let go')
    expect(h.endsAsked).toBe(0)
    return h
  }

  it('within two minutes: the new version\'s restored tab shows the terminal again, with what it wrote before the update and while the app was away, once each, from the start of its output', async () => {
    const c = computer()
    const h = await updateWithOneHeld(c)
    // The installer runs for a minute, and the program writes on.
    c.clock.now += 60_000
    h.output('while the app was away\r\n')
    c.helper.tick()
    expect(h.ended).toBe(false)

    const m2 = c.run()
    expect(m2.holdsFor(TAB)).toBe(true)
    expect(c.logs).toContain('[session-helper] the app was updated; 1 held terminal(s) may be shown again, and 0 agent session(s) it held are ended')
    const p2 = m2.spawn({ plain: true, sessionId: TAB }, SHELL, [], spawnOpts())
    const seen2: string[] = []
    p2.onData((d) => seen2.push(d))
    expect(await (p2 as HelperPty).adoption).toBe(true)
    await until(() => seen2.join('') === 'before the update\r\nwhile the app was away\r\n', `the replay (${JSON.stringify(seen2.join(''))})`)
    // The tab's own attach asked for the output from its start: run 1's
    // attach, run 2's keeper, then the tab.
    await until(() => h.attaches === 3, 'the tab to replace the keeper')
    expect(h.requests.filter((r) => r.t === 'term.attach').map((r) => r.from)).toEqual([0, 0, 0])
    h.output('after\r\n')
    await until(() => seen2.join('').endsWith('after\r\n'), 'new output')
    expect(seen2.join('')).toBe('before the update\r\nwhile the app was away\r\nafter\r\n')
    // The same holder throughout: one hold, one launch, never an end.
    expect(c.helper.made).toEqual([h])
    expect(h.requests.filter((r) => r.t === 'term.launch')).toHaveLength(1)
    expect(h.endsAsked).toBe(0)
  })

  it('more than two minutes: the holder ended by its away clock, nothing is kept, and the restored tab starts a fresh terminal', async () => {
    const c = computer()
    const h = await updateWithOneHeld(c)
    c.clock.now += 120_001
    c.helper.tick()
    expect(h.endedAway).toBe(true)

    const m2 = c.run()
    expect(m2.holdsFor(TAB)).toBe(false)
    expect(c.logs).toContain('[session-helper] the app was updated; 0 held terminal(s) may be shown again, and 0 agent session(s) it held are ended')
    const p2 = m2.spawn({ plain: true, sessionId: TAB }, SHELL, [], spawnOpts())
    const seen2: string[] = []
    p2.onData((d) => seen2.push(d))
    expect(await (p2 as HelperPty).adoption).toBe(false)
    await until(() => c.helper.made.length === 2 && !!c.helper.holders.get(SID)?.attached, 'a fresh terminal')
    const fresh = c.helper.holders.get(SID)!
    expect(fresh).not.toBe(h)
    expect(fresh.launch).toMatchObject({ t: 'term.launch', argv: [SHELL] })
    fresh.output('a new shell\r\n')
    await until(() => seen2.join('') === 'a new shell\r\n', 'the fresh terminal\'s output')
    expect(seen2.join('')).not.toContain('before the update')
  })

  // The resume prompt was declined, so no tab shows the kept terminal. Then
  // the update: Save of another tab only; or no tab open at all, so no close
  // dialog and no choice ("Don't open" cleared the saved file, and app-wiring
  // passes an empty set, since no discard came with the install call).
  const updates: Array<[string, (m: SessionHelperManager) => number]> = [
    ['an update with Save', (m) => {
      m.noteSavedTabs([{ id: 'abcdef0123456789abcdefd2', label: 'Other' }])
      return m.releaseForUpdate(new Set(['abcdef0123456789abcdefd2']))
    }],
    ['an update with no tab open after "Don\'t open" (no dialog, no choice)', (m) => m.releaseForUpdate(new Set())],
  ]
  for (const [what, update] of updates) it(`kept after a crash and shown in no tab, then ${what}: it runs on, the same holder, and the next start keeps it again and lists it on the Machines page (section B3)`, async () => {
    const c = computer()
    // Run 1: a Terminal only tab through a holder, then the app crashes.
    const m1 = c.run()
    await until(() => m1.serviceState().state === 'ready', 'the helper to be ready')
    m1.spawn({ plain: true, sessionId: TAB }, SHELL, [], spawnOpts())
    await until(() => !!c.helper.holders.get(SID)?.attached, 'the terminal to attach')
    const h = c.helper.holders.get(SID)!
    h.output('before the crash\r\n')
    c.exit(m1)
    // Run 2: the crash path keeps it; no tab shows it. Then the update.
    const m2 = c.run()
    expect(m2.holdsFor(TAB)).toBe(true)
    await until(() => m2.serviceState().state === 'ready' && h.attaches === 2, 'run 2 ready, with the keeper')
    expect(update(m2)).toBe(0)
    await m2.endsForUpdate()
    c.exit(m2)
    await until(() => h.conns.size === 0 && h.awaySince !== null, 'the app to let go')
    expect(h.endsAsked).toBe(0)
    // The installer runs for a minute.
    c.clock.now += 60_000
    c.helper.tick()
    expect(h.ended).toBe(false)
    // Run 3, the new version: the update's mark takes the crash path's listing.
    const m3 = c.run()
    expect(m3.holdsFor(TAB)).toBe(true)
    expect(c.logs).toContain('[session-helper] the app was updated; 1 held terminal(s) may be shown again, and 0 agent session(s) it held are ended')
    await until(() => h.attaches === 3, 'run 3\'s keeper')
    const status = await m3.status()
    expect(status.sessions.find((x) => x.id === SID)).toMatchObject({ kind: 'plain', attached: false })
    // The same holder throughout: one hold, one launch, never an end.
    expect(c.helper.made).toEqual([h])
    expect(h.requests.filter((r) => r.t === 'term.launch')).toHaveLength(1)
    expect(h.endsAsked).toBe(0)
    expect(h.ended).toBe(false)
  })
})

describe('let go of for an update while it attaches again (plan section B2, PR review)', () => {
  /** A terminal whose connection dropped: its attach again waits at a gate
   *  until the test opens it. `next` decides that connection (by default it
   *  is made as usual). */
  async function droppedRig(next?: (record: HolderRecord, open: (record: HolderRecord) => Promise<HolderConnection>) => Promise<HolderConnection>) {
    let gate: Promise<void> | null = null
    let go: () => void = () => {}
    let wrap: typeof next | null = null
    const r = rig({
      connect: async (record, open) => {
        if (!gate) return open(record)
        const g = gate
        const w = wrap
        gate = null
        wrap = null
        await g
        return w ? w(record, open) : open(record)
      },
    })
    await attached(r)
    gate = new Promise<void>((res) => { go = res })
    wrap = next ?? null
    r.h.dropAll()
    await until(() => !r.p.isAttached, 'the drop')
    await tick(10)
    return { r, go: () => go() }
  }

  /** The update's kill that follows: the exit is the terminal's alone, and its holder runs on. */
  async function killedLocally(r: Rig): Promise<void> {
    r.p.kill()
    await until(() => r.exits.length === 1, 'the exit')
    await tick(30)
    expect(r.exits).toEqual([0])
    expect(r.h.endsAsked).toBe(0)
    expect(r.h.ended).toBe(false)
  }

  it('the connection made after the release closes without attaching, and nothing ends the holder', async () => {
    const { r, go } = await droppedRig()
    expect(r.p.release()).toBe(true)
    go()
    await until(() => r.conns.length === 2 && r.conns[1].isClosed, 'the new connection to close')
    await until(() => r.h.conns.size === 0, 'the holder to have no connection')
    await tick(30)
    expect(r.h.attaches).toBe(1)
    expect(r.h.attached).toBeNull()
    expect(r.exits).toEqual([])
    await killedLocally(r)
  })

  it('a connection that cannot be made after the release does not end the holder: it runs on for the next version', async () => {
    const { r, go } = await droppedRig(async () => { throw new HolderError('io', 'the holder could not be reached') })
    expect(r.p.release()).toBe(true)
    go()
    await tick(60)
    expect(r.h.endsAsked).toBe(0)
    expect(r.exits).toEqual([])
    expect(r.conns).toHaveLength(1)
    await killedLocally(r)
  })

  it('let go of just as its attach again goes out: the attach fails on the closed connection, and nothing more is tried', async () => {
    let released: boolean | null = null
    const { r, go } = await droppedRig(async (record, open) => {
      const c = await open(record)
      const request = c.request.bind(c)
      c.request = (msg, onReply) => {
        if (msg.t === 'term.attach') released = r.p.release()
        return request(msg, onReply)
      }
      return c
    })
    go()
    await until(() => released !== null, 'the release')
    await tick(60)
    expect(released).toBe(true)
    expect(r.conns).toHaveLength(2)
    expect(r.h.attaches).toBe(1)
    expect(r.h.conns.size).toBe(0)
    await killedLocally(r)
  })

  it('let go of once its attach again was answered: that connection closes, and nothing attaches again or ends', async () => {
    let released: boolean | null = null
    const { r, go } = await droppedRig(async (record, open) => {
      const c = await open(record)
      const request = c.request.bind(c)
      c.request = (msg, onReply) => {
        const answer = request(msg, onReply)
        // The update lets go after the answer came in, before the terminal acts on it.
        return msg.t === 'term.attach' ? answer.then((v) => { released = r.p.release(); return v }) : answer
      }
      return c
    })
    go()
    await until(() => released !== null, 'the release')
    await tick(60)
    expect(released).toBe(true)
    expect(r.conns).toHaveLength(2)
    expect(r.h.attaches).toBe(2)
    expect(r.p.isAttached).toBe(false)
    await until(() => r.h.conns.size === 0, 'the holder to have no connection')
    await killedLocally(r)
  })
})
