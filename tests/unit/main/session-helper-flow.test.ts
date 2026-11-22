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
 *
 * 2.1.3-beta.12 (plan section A1): a terminal shown again from the middle of
 * its output (the holder no longer held the offset asked for) says so, and
 * its program is asked to redraw; vitest's clock counts the 300 ms. Its
 * replay is held until its end and shown in one piece, the notice first and
 * then no more than the tab keeps, so the notice stays within reach (the VM
 * smoke of the release PR found 2 MiB of plain text pushed it out).
 *
 * 2.1.3-beta.13 (plan section A1, aicc_planning#374): a take-over whose
 * holder offers the screen reads shows its replay only once its tab is at
 * the holder's size (or at the wait's cap), and sends the holder no size
 * meanwhile.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Terminal } from '@xterm/headless'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, rmdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { IPty } from 'node-pty'
import { HolderConnection, HolderError, INPUT_FRAMES_PER_PING, unixEndpointFolderProblem } from '../../../src/main/session-helper/connection'
import { EventEmitter } from 'events'
import { HOLD_MAX_MS, HelperPty, LOST_EXIT_CODE, NothingStartedError, SIZE_WAIT_MAX_MS, type HelperPtyDriver } from '../../../src/main/session-helper/helper-pty'
import { TERMINAL_SCROLLBACK_LINES } from '../../../src/shared/terminal-scrollback'
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
  /** What the terminal logged, in order. */
  logs: string[]
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
  /** Its connections ask for the screen reads, as the manager's do for a plain terminal. */
  screen?: boolean
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
  const logs: string[] = []
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
    ...(o.screen ? { screen: true } : {}),
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
    log: (m) => logs.push(m),
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
    h, p, seen, exits, conns, direct, clock, logs,
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

/**
 * 2.1.3-beta.12, plan section A1: the holder's ring keeps the last 2 MiB, so
 * an attach can ask for an offset it no longer holds. It answers from the
 * ring's start with `truncated` true; the tab then gets the cancel character,
 * the attribute reset and one line saying earlier output is not shown, then
 * the replay, and once the replay is shown and the program runs, the holder
 * gets one resize one row shorter and, 300 ms later, one at the tab's size
 * (probe P19's redraw). No clear and no terminal reset: shown again, the
 * tab's terminal keeps the modes its program set.
 *
 * On vitest's clock (setTimeout and clearTimeout only), so the 300 ms are
 * counted exactly; `settle` gives the in-memory streams a real turn of the
 * event loop between steps.
 */
describe('shown again from the middle of its output (2.1.3-beta.12, plan section A1)', () => {
  const CANCEL = '\x18'
  const ATTRIBUTE_RESET = '\x1b[0m'
  const NOTICE = '[Earlier output of this terminal is no longer held, so it is not shown.]'
  /** A reset or clear of the terminal or its view, or a screen switch: none may be written. */
  const RESETS = ['\x1bc', '\x1b[!p', '\x1b[J', '\x1b[0J', '\x1b[1J', '\x1b[2J', '\x1b[3J', '\x1b[?1049h', '\x1b[?1049l', '\x1b[?47h', '\x1b[?1047h']

  /** Runs `body` on vitest's clock. */
  const onFakeClock = (body: () => Promise<void>) => async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await body()
    } finally {
      vi.useRealTimers()
    }
  }

  /** A real turn of the event loop, then what is due now on the fake clock, until `cond`. */
  async function settle(cond: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 400; i++) {
      if (cond()) return
      await new Promise<void>((res) => setImmediate(res))
      await vi.advanceTimersByTimeAsync(0)
    }
    throw new Error(`timed out waiting for ${what}`)
  }

  /** A term.resize the app sent, with what the tab had been shown when it went. */
  type Sent = { cols: unknown; rows: unknown; shown: string }
  /** A rig whose connections note each term.resize the app sends; `onResize`
   *  runs as each one goes, before it is sent (the rig, and how many went),
   *  and `onEnd` as each term.end goes. */
  function watched(o: Parameters<typeof rig>[0] = {}, onResize?: (r: Rig, n: number) => void, onEnd?: (r: Rig) => void): { r: Rig; sent: Sent[] } {
    const sent: Sent[] = []
    const box: { r?: Rig } = {}
    const r = rig({
      ...o,
      connect: async (record, open) => {
        const c = await open(record)
        const request = c.request.bind(c)
        c.request = (msg, onReply) => {
          if (msg.t === 'term.resize') {
            sent.push({ cols: msg.cols, rows: msg.rows, shown: box.r?.text() ?? '' })
            if (box.r) onResize?.(box.r, sent.length)
          }
          if (msg.t === 'term.end' && box.r) onEnd?.(box.r)
          return request(msg, onReply)
        }
        return c
      },
    })
    box.r = r
    return { r, sent }
  }
  const sizes = (sent: Sent[]) => sent.map(({ cols, rows }) => ({ cols, rows }))
  /** The resizes the holder was asked for, from any connection. */
  const resizes = (h: FakeHolder) => h.requests.filter((m) => m.t === 'term.resize').map((m) => ({ cols: m.cols, rows: m.rows }))

  /** A holder whose terminal runs, and whose ring no longer holds the first `lost` bytes of its output. */
  const heldFrom = (lost: number, ring: string | Buffer) => (h: FakeHolder) => {
    running()(h)
    h.ring = typeof ring === 'string' ? Buffer.from(ring, 'utf8') : ring
    h.ringStart = lost
  }

  it('taken over again with the start of its output gone: the cancel character, the attribute reset, the notice, then the replay; after its last byte one row shorter, and 300 ms later the tab\'s size', onFakeClock(async () => {
    const { r, sent } = watched({ adopt: true, cols: 132, rows: 50, before: heldFrom(5000, 'the last screen\r\n') })
    await settle(() => sent.length > 0, 'a resize')
    expect(r.text()).toBe(`${CANCEL}${ATTRIBUTE_RESET}${NOTICE}\r\nthe last screen\r\n`)
    // The first half went once the tab had been shown the whole replay.
    expect(sent).toEqual([{ cols: 132, rows: 49, shown: r.text() }])
    await vi.advanceTimersByTimeAsync(299)
    expect(sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(sizes(sent)).toEqual([{ cols: 132, rows: 49 }, { cols: 132, rows: 50 }])
    await settle(() => resizes(r.h).length === 2, 'the holder to get both')
    expect(resizes(r.h)).toEqual([{ cols: 132, rows: 49 }, { cols: 132, rows: 50 }])
    expect(r.h.size).toEqual({ cols: 132, rows: 50 })
    expect(r.exits).toEqual([])
  }))

  for (const [what, cut] of [
    ['an unfinished title sequence', '\x1b]0;a title that never en'],
    ['an unfinished colour sequence', '\x1b[38;5;1'],
  ] as const) {
    it(`attached again with bytes lost, the old stream cut inside ${what}: the same notice and redraw, no reset anywhere, and on screen the notice, then the replay, nothing swallowed`, onFakeClock(async () => {
      const { r, sent } = watched()
      await settle(() => r.p.isAttached, 'the attach')
      const before = `before\r\n${cut}`
      r.h.output(before)
      await settle(() => r.text() === before, 'the output cut short')
      r.h.fallBehind()
      // Nobody attached: the program writes on, and the ring forgets what the tab was never shown.
      r.h.output('x'.repeat(3000))
      r.h.output('\r\nafter the gap\r\n')
      r.h.forget(Buffer.byteLength(before) + 3000)
      await settle(() => sent.length > 0, 'the first half of the redraw')
      const stream = r.text()
      expect(stream).toBe(`${before}${CANCEL}${ATTRIBUTE_RESET}\r\n${NOTICE}\r\n\r\nafter the gap\r\n`)
      expect(RESETS.filter((s) => stream.includes(s))).toEqual([])
      await vi.advanceTimersByTimeAsync(300)
      expect(sizes(sent)).toEqual([{ cols: 80, rows: 23 }, { cols: 80, rows: 24 }])
      expect(r.h.attaches).toBe(2)
      // The real clock again: xterm's write buffer runs on setTimeout.
      vi.useRealTimers()
      const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
      try {
        // The cancel character aborts a cut title; the reset's ESC alone would end it as a whole one.
        const titles: string[] = []
        term.onTitleChange((t) => titles.push(t))
        await new Promise<void>((res) => term.write(stream, res))
        expect(titles).toEqual([])
        const b = term.buffer.active
        const rows = Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true) ?? '')
        const at = rows.indexOf(NOTICE)
        expect(at, JSON.stringify(rows.slice(0, 6))).toBeGreaterThan(0)
        expect(rows.slice(at + 1, at + 3)).toEqual(['', 'after the gap'])
      } finally {
        term.dispose()
      }
    }))
  }

  it('not truncated, exactly as before: taken over with the whole ring, the replay and one resize at the tab\'s size; attached again with no gap, the output and no resize', onFakeClock(async () => {
    const whole = watched({ adopt: true, cols: 132, rows: 50, before: running('kept\r\n') })
    await settle(() => whole.sent.length > 0, 'the resize')
    await vi.advanceTimersByTimeAsync(1000)
    expect(whole.r.text()).toBe('kept\r\n')
    expect(sizes(whole.sent)).toEqual([{ cols: 132, rows: 50 }])
    expect(whole.r.logs).toEqual([])

    const again = watched()
    await settle(() => again.r.p.isAttached, 'the attach')
    again.r.h.output('one ')
    await settle(() => again.r.text() === 'one ', 'the first output')
    again.r.h.fallBehind()
    again.r.h.output('two ')
    await settle(() => again.r.h.attaches === 2 && again.r.p.isAttached && again.r.text() === 'one two ', 'the attach again')
    await vi.advanceTimersByTimeAsync(1000)
    expect(again.r.text()).toBe('one two ')
    expect(again.sent).toEqual([])
  }))

  it('a resize from the tab inside the 300 ms goes out at once, and the second half sends the tab\'s newest size again', onFakeClock(async () => {
    const { r, sent } = watched({ adopt: true, cols: 132, rows: 50, before: heldFrom(5000, 'the last screen\r\n') })
    await settle(() => sent.length > 0, 'the first half')
    await vi.advanceTimersByTimeAsync(100)
    r.p.resize(100, 40)
    expect(sizes(sent)).toEqual([{ cols: 132, rows: 49 }, { cols: 100, rows: 40 }])
    await vi.advanceTimersByTimeAsync(200)
    expect(sizes(sent)).toEqual([{ cols: 132, rows: 49 }, { cols: 100, rows: 40 }, { cols: 100, rows: 40 }])
    await settle(() => resizes(r.h).length === 3, 'the holder to get all three')
    expect(r.h.size).toEqual({ cols: 100, rows: 40 })
  }))

  it('a program that had already exited: the notice and the replay, then its exit code, and no redraw', onFakeClock(async () => {
    const { r, sent } = watched({ adopt: true, before: (h) => { heldFrom(5000, 'bye\r\n')(h); h.child = 'exited'; h.code = 7 } })
    await settle(() => r.exits.length === 1, 'the exit')
    await vi.advanceTimersByTimeAsync(1000)
    expect(r.text()).toBe(`${CANCEL}${ATTRIBUTE_RESET}${NOTICE}\r\nbye\r\n`)
    expect(r.exits).toEqual([7])
    expect(sent).toEqual([])
  }))

  const stops: Array<[string, (r: Rig) => Promise<void>]> = [
    ['ended', async (r) => { r.p.kill() }],
    ['let go of for an update', async (r) => { expect(r.p.release()).toBe(true) }],
    ['replaced by another connection', async (r) => {
      const other = await HolderConnection.open({ record: r.h.record(), os: 'windows', openStream: async () => r.h.connect(), replyTimeoutMs: 2000, pingEveryMs: 0 })
      r.conns.push(other)
      await other.request({ t: 'term.attach', from: 5000 })
    }],
  ]
  for (const [what, stop] of stops) {
    it(`${what} inside the 300 ms: no second resize`, onFakeClock(async () => {
      const { r, sent } = watched({ adopt: true, cols: 132, rows: 50, before: heldFrom(5000, 'the last screen\r\n') })
      await settle(() => sent.length > 0, 'the first half')
      await vi.advanceTimersByTimeAsync(100)
      await stop(r)
      await settle(() => !r.p.isAttached, 'the terminal to let go')
      await vi.advanceTimersByTimeAsync(1000)
      expect(sizes(sent)).toEqual([{ cols: 132, rows: 49 }])
      expect(resizes(r.h)).toEqual([{ cols: 132, rows: 49 }])
    }))
  }

  it('the connection drops inside the 300 ms: no second resize on it, and the attach again sends the tab\'s size', onFakeClock(async () => {
    const { r, sent } = watched()
    await settle(() => r.p.isAttached, 'the attach')
    r.h.output('before\r\n')
    await settle(() => r.text() === 'before\r\n', 'the first output')
    r.h.fallBehind()
    r.h.output('x'.repeat(3000))
    r.h.output('\r\nafter the gap\r\n')
    r.h.forget(8 + 3000)
    await settle(() => sent.length > 0, 'the first half')
    await vi.advanceTimersByTimeAsync(100)
    r.h.dropAll()
    await settle(() => r.h.attaches === 3 && r.p.isAttached, 'the attach again')
    await vi.advanceTimersByTimeAsync(1000)
    await settle(() => sent.length >= 2, 'the tab\'s size on the attach again')
    // The only resize at the tab's size is the attach again's: none went on the dropped connection.
    expect(sizes(sent)).toEqual([{ cols: 80, rows: 23 }, { cols: 80, rows: 24 }])
    await settle(() => r.h.size?.rows === 24, 'the holder at the tab\'s size')
    expect(resizes(r.h).at(-1)).toEqual({ cols: 80, rows: 24 })
  }))

  it('the connection closes with the second half unread: the attach again sends the tab\'s size', onFakeClock(async () => {
    // The holder lets go as the second half goes, so that frame is never taken.
    const { r, sent } = watched({ adopt: true, cols: 132, rows: 50, before: heldFrom(5000, 'the last screen\r\n') }, (rr, n) => { if (n === 2) rr.h.dropAll() })
    await settle(() => sent.length > 0, 'the first half')
    await vi.advanceTimersByTimeAsync(300)
    await settle(() => r.h.attaches === 2 && r.p.isAttached, 'the attach again')
    await settle(() => sent.length >= 3, 'the tab\'s size on the attach again')
    expect(sizes(sent)).toEqual([{ cols: 132, rows: 49 }, { cols: 132, rows: 50 }, { cols: 132, rows: 50 }])
    await settle(() => r.h.size?.rows === 50, 'the holder at the tab\'s size')
    expect(r.h.size).toEqual({ cols: 132, rows: 50 })
  }))

  it('a tab one row high: the redraw goes to two rows and back', onFakeClock(async () => {
    const { sent } = watched({ adopt: true, cols: 80, rows: 1, before: heldFrom(5000, 'x\r\n') })
    await settle(() => sent.length > 0, 'the first half')
    await vi.advanceTimersByTimeAsync(300)
    expect(sizes(sent)).toEqual([{ cols: 80, rows: 2 }, { cols: 80, rows: 1 }])
  }))

  it('a replay that starts with two bytes of a character cut in half: they are dropped, and the next character is whole', onFakeClock(async () => {
    const euro = Buffer.from('€', 'utf8')
    const ring = Buffer.concat([euro.subarray(1), Buffer.from('éz\r\n', 'utf8')])
    const { r, sent } = watched({ adopt: true, before: heldFrom(4999, ring) })
    await settle(() => sent.length > 0, 'the redraw')
    expect(r.text()).toBe(`${CANCEL}${ATTRIBUTE_RESET}${NOTICE}\r\néz\r\n`)
    expect(r.text()).not.toContain('�')
  }))

  // The holder closes a connection that falls behind, also in the middle of a replay.
  it('closed in the middle of the replay: the attach again, not truncated, still gets the redraw once its replay is shown', onFakeClock(async () => {
    const { r, sent } = watched({ adopt: true, cols: 132, rows: 50, before: (h) => { heldFrom(5000, 'first half second half\r\n')(h); h.cutReplay = { at: 11 } } })
    await settle(() => r.h.attaches === 2 && sent.length > 0, 'the attach again and the first half')
    expect(r.text()).toBe(`${CANCEL}${ATTRIBUTE_RESET}${NOTICE}\r\nfirst half second half\r\n`)
    expect(sent).toEqual([{ cols: 132, rows: 49, shown: r.text() }])
    await vi.advanceTimersByTimeAsync(300)
    expect(sizes(sent)).toEqual([{ cols: 132, rows: 49 }, { cols: 132, rows: 50 }])
    await settle(() => resizes(r.h).length === 2, 'the holder to get both')
    expect(resizes(r.h)).toEqual([{ cols: 132, rows: 49 }, { cols: 132, rows: 50 }])
  }))

  it('closed before any byte of the replay: the attach again still drops the bytes of the cut character, and still gets the redraw', onFakeClock(async () => {
    const euro = Buffer.from('€', 'utf8')
    const ring = Buffer.concat([euro.subarray(1), Buffer.from('éz\r\n', 'utf8')])
    const { r, sent } = watched({ adopt: true, before: (h) => { heldFrom(4999, ring)(h); h.cutReplay = { at: 0 } } })
    await settle(() => r.h.attaches === 2 && sent.length > 0, 'the attach again and the first half')
    expect(r.text()).toBe(`${CANCEL}${ATTRIBUTE_RESET}${NOTICE}\r\néz\r\n`)
    await vi.advanceTimersByTimeAsync(300)
    expect(sizes(sent)).toEqual([{ cols: 80, rows: 23 }, { cols: 80, rows: 24 }])
  }))

  it('closed in the middle of the replay, then attached again from the middle once more: a second notice, one redraw, and the log counts the bytes of both gaps', onFakeClock(async () => {
    const { r, sent } = watched({ adopt: true, cols: 132, rows: 50, before: (h) => {
      heldFrom(5000, `${'A'.repeat(10)}${'B'.repeat(10)}\r\n`)(h)
      // Nobody attached: the program writes on, and the ring forgets the rest of the first replay and 50 bytes more.
      h.cutReplay = { at: 10, then: () => { h.output(`${'C'.repeat(100)}\r\nlive\r\n`); h.forget(72) } }
    } })
    await settle(() => r.h.attaches === 2 && sent.length > 0, 'the attach again and the first half')
    expect(r.text()).toBe(`${CANCEL}${ATTRIBUTE_RESET}${NOTICE}\r\n${'A'.repeat(10)}${CANCEL}${ATTRIBUTE_RESET}\r\n${NOTICE}\r\n${'C'.repeat(50)}\r\nlive\r\n`)
    await vi.advanceTimersByTimeAsync(300)
    expect(sizes(sent)).toEqual([{ cols: 132, rows: 49 }, { cols: 132, rows: 50 }])
    // 5000 bytes before the first replay, and 62 between what it showed and the second one.
    expect(r.logs.filter((l) => l.includes('no longer held'))).toEqual([`[session-helper] ${r.h.sid}: 5062 bytes of earlier output are no longer held, so they are not shown; asked its program to redraw`])
  }))

  it('closed in the middle of the replay, and the program ends before the attach again: the rest of the replay, its exit code, no redraw, and the log line says so', onFakeClock(async () => {
    const { r, sent } = watched({ adopt: true, before: (h) => { heldFrom(5000, 'first half second half\r\n')(h); h.cutReplay = { at: 11, then: () => h.exitChild(3) } } })
    await settle(() => r.exits.length === 1, 'the exit')
    await vi.advanceTimersByTimeAsync(1000)
    expect(r.text()).toBe(`${CANCEL}${ATTRIBUTE_RESET}${NOTICE}\r\nfirst half second half\r\n`)
    expect(r.exits).toEqual([3])
    expect(sent).toEqual([])
    expect(r.logs.filter((l) => l.includes('no longer held'))).toEqual([`[session-helper] ${r.h.sid}: 5000 bytes of earlier output are no longer held, so they are not shown; its program is over, so no redraw is asked for`])
  }))

  it('one log line: the session, how many bytes are no longer held, and that a redraw was asked for; no output text', onFakeClock(async () => {
    const { r, sent } = watched({ adopt: true, before: heldFrom(5000, 'what the program printed\r\n') })
    await settle(() => sent.length > 0, 'the redraw')
    await vi.advanceTimersByTimeAsync(300)
    expect(r.logs).toEqual([`[session-helper] ${r.h.sid}: 5000 bytes of earlier output are no longer held, so they are not shown; asked its program to redraw`])
    expect(r.logs.join('\n')).not.toContain('printed')
  }))

  /*
   * The replay after a gap is held until its end, over a dropped connection
   * too, and shown in one piece: the notice first, then no more of it than
   * the tab keeps (its scrollback, TERMINAL_SCROLLBACK_LINES, less a screen's
   * rows and the notice's own), cut at a line start, so the notice is not
   * pushed out of reach (the release smoke: 2 MiB of plain text is some
   * 28,700 lines, a tab keeps 10,000). The text after the replay's last line
   * break is a row too: the row the cursor is on. What the left-out part did
   * to the terminal's screen and modes is carried across the cut
   * (replay-tail.ts; its own tests check the counting against xterm.js).
   */

  /** `n` numbered lines, from `line <from>`, each ending CRLF. */
  const numbered = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `line ${from + i}\r\n`).join('')
  /** The rows the notice takes at `cols` columns. */
  const noticeRows = (cols: number) => Math.ceil(NOTICE.length / cols)
  /** How many whole lines of one row each the tab is shown after the notice, for a tab `rows` high and `cols` wide. */
  const fits = (rows: number, cols = 80) => TERMINAL_SCROLLBACK_LINES - rows - noticeRows(cols) - 1
  /** What a hold shows: the cancel character, the attribute reset, the notice, then `tail`. */
  const piece = (tail: string) => `${CANCEL}${ATTRIBUTE_RESET}${NOTICE}\r\n${tail}`
  /** Real turns of the event loop, so the in-memory streams deliver what was sent. */
  const turns = async (n = 50) => { for (let i = 0; i < n; i++) await new Promise<void>((res) => setImmediate(res)) }
  /** Every row a terminal that keeps what a tab keeps holds after `stream`, scrollback first. On the real clock. */
  async function rowsAfter(stream: string, cols: number, rows: number): Promise<string[]> {
    const term = new Terminal({ cols, rows, scrollback: TERMINAL_SCROLLBACK_LINES, allowProposedApi: true })
    try {
      await new Promise<void>((res) => term.write(stream, res))
      const b = term.buffer.active
      return Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true) ?? '')
    } finally {
      term.dispose()
    }
  }

  it('a replay of more rows than the tab keeps: in one piece, the notice first, then only its last lines, so the notice is the first line the tab keeps', onFakeClock(async () => {
    const total = 12_000
    const kept = fits(24)
    const { r, sent } = watched({ adopt: true, cols: 80, rows: 24, before: heldFrom(5000, numbered(total)) })
    await settle(() => sent.length > 0, 'the redraw')
    expect(r.seen).toEqual([piece(numbered(kept, total - kept + 1))])
    expect(r.text()).not.toContain(`line ${total - kept}\r\n`)
    expect(sent[0].shown).toBe(r.text())
    expect(r.logs).toContain(`[session-helper] ${r.h.sid}: the oldest ${total - kept} lines of its replay are not shown either, so the line saying so stays within the ${TERMINAL_SCROLLBACK_LINES} lines the tab keeps (rows counted at 80x24)`)
    // The redraw's log line keeps its start (the release smoke reads it).
    expect(r.logs.filter((l) => l.includes('no longer held'))).toEqual([`[session-helper] ${r.h.sid}: 5000 bytes of earlier output are no longer held, so they are not shown; asked its program to redraw`])
    vi.useRealTimers()
    const rows = await rowsAfter(r.text(), 80, 24)
    expect(rows[0]).toBe(NOTICE)
    expect(rows[1]).toBe(`line ${total - kept + 1}`)
    expect(rows).toContain(`line ${total}`)
  }))

  it('a short replay, and one of exactly what the tab keeps: the notice, then all of it, in one piece once its end is in', onFakeClock(async () => {
    const short = watched({ adopt: true, cols: 80, rows: 24, before: heldFrom(5000, numbered(50)) })
    await settle(() => short.sent.length > 0, 'the redraw')
    expect(short.r.seen).toEqual([piece(numbered(50))])
    const full = watched({ adopt: true, cols: 80, rows: 24, before: heldFrom(5000, numbered(fits(24))) })
    await settle(() => full.sent.length > 0, 'the redraw')
    expect(full.r.seen).toEqual([piece(numbered(fits(24)))])
    expect([...short.r.logs, ...full.r.logs].filter((l) => l.includes('not shown either'))).toEqual([])
  }))

  it('a line three times the terminal\'s width counts as three rows', onFakeClock(async () => {
    const cols = 40
    const rows = 10
    const wide = (i: number) => `${String(i).padStart(5, '0')}${'w'.repeat(3 * cols - 5)}\r\n`
    const total = 4000
    const { r, sent } = watched({ adopt: true, cols, rows, before: heldFrom(5000, Array.from({ length: total }, (_, i) => wide(i + 1)).join('')) })
    await settle(() => sent.length > 0, 'the redraw')
    // 10,000 less a screen (10) and the notice's two rows is 9,988 rows: the cursor's row, and 3,329 lines of three rows.
    const kept = Math.floor(fits(rows, cols) / 3)
    expect(kept).toBe(3329)
    expect(r.seen).toEqual([piece(Array.from({ length: kept }, (_, i) => wide(total - kept + 1 + i)).join(''))])
    vi.useRealTimers()
    const shown = await rowsAfter(r.text(), cols, rows)
    // The notice, 72 characters, takes two rows at 40 columns.
    expect(`${shown[0]}${shown[1]}`.replace(/ /g, '')).toBe(NOTICE.replace(/ /g, ''))
    expect(shown[2]).toBe(wide(total - kept + 1).slice(0, cols))
  }))

  it('a wide character counts two columns, and a tab moves to the next multiple of 8', onFakeClock(async () => {
    const cols = 40
    const rows = 10
    // 45 columns each: two rows at 40, where one column a character would make them one.
    const wideChars = (i: number) => `${String(i).padStart(5, '0')}${String.fromCodePoint(0x4e2d).repeat(20)}\r\n`
    // 41 columns each (tabs to 8, 16, 24 and 32, then nine more): two rows, where a column a tab would make them one.
    const tabs = (i: number) => `${String(i).padStart(5, '0')}\t\t\t\t${'x'.repeat(9)}\r\n`
    const total = 6000
    const kept = Math.floor(fits(rows, cols) / 2)
    for (const line of [wideChars, tabs]) {
      const { r, sent } = watched({ adopt: true, cols, rows, before: heldFrom(5000, Array.from({ length: total }, (_, i) => line(i + 1)).join('')) })
      await settle(() => sent.length > 0, 'the redraw')
      expect(r.seen).toEqual([piece(Array.from({ length: kept }, (_, i) => line(total - kept + 1 + i)).join(''))])
    }
  }))

  it('escape sequences take no width, and the cut never lands inside one: a title string holding a line break stays whole', onFakeClock(async () => {
    const budget = TERMINAL_SCROLLBACK_LINES - 24 - noticeRows(80)
    // 70 columns drawn in 85 characters: two rows each if its colour sequences counted.
    const coloured = (i: number) => `\x1b[38;5;123m${String(i).padStart(5, '0')}${'c'.repeat(65)}\x1b[0m\r\n`
    const title = '\x1b]0;title one\ntitle two\x07a line after a title\r\n'
    const older = Array.from({ length: 3000 }, (_, i) => `older ${i + 1}\r\n`).join('')
    // After the title's line, as many lines as fit with it and the cursor's row.
    const after = Array.from({ length: budget - 2 }, (_, i) => coloured(i + 1)).join('')
    const { r, sent } = watched({ adopt: true, cols: 80, rows: 24, before: heldFrom(5000, `${older}${title}${after}`) })
    await settle(() => sent.length > 0, 'the redraw')
    expect(r.seen).toEqual([piece(`${title}${after}`)])
    vi.useRealTimers()
    const rows = await rowsAfter(r.text(), 80, 24)
    expect(rows.slice(0, 2)).toEqual([NOTICE, 'a line after a title'])
  }))

  it('the connection closes in the middle of a long replay: it stays held through the attach again, which brings the rest, then all of it is shown in one piece, notice first, trimmed to what the tab keeps', onFakeClock(async () => {
    const total = 12_000
    const kept = fits(50, 132)
    const { r, sent } = watched({ adopt: true, cols: 132, rows: 50, before: (h) => { heldFrom(5000, numbered(total))(h); h.cutReplay = { at: Buffer.byteLength(numbered(11_000)) } } })
    await settle(() => r.h.attaches === 2 && sent.length > 0, 'the attach again and the first half')
    expect(r.seen).toEqual([piece(numbered(kept, total - kept + 1))])
    // The redraw waited for the attach again's replay to end, and went after it.
    expect(sent).toEqual([{ cols: 132, rows: 49, shown: r.text() }])
    await vi.advanceTimersByTimeAsync(300)
    expect(sizes(sent)).toEqual([{ cols: 132, rows: 49 }, { cols: 132, rows: 50 }])
    vi.useRealTimers()
    const rows = await rowsAfter(r.text(), 132, 50)
    expect(rows[0]).toBe(NOTICE)
    expect(rows).toContain(`line ${total}`)
  }))

  it('closed in the middle of a held replay, then attached again with a gap of its own: the first hold is shown, notice first, then the second, each trimmed', onFakeClock(async () => {
    const kept = fits(24)
    const { r, sent } = watched({ adopt: true, before: (h) => {
      heldFrom(5000, numbered(12_000))(h)
      // Nobody attached: 12,000 more lines, and the ring forgets the rest of the first replay and a line more.
      h.cutReplay = { at: Buffer.byteLength(numbered(11_000)), then: () => { h.output(numbered(12_000, 20_001)); h.forget(Buffer.byteLength(numbered(11_000)) + Buffer.byteLength(numbered(1_000, 11_001)) + Buffer.byteLength(numbered(1, 20_001))) } }
    } })
    await settle(() => r.h.attaches === 2 && sent.length > 0, 'the attach again and the redraw')
    expect(r.seen).toEqual([
      piece(numbered(kept, 11_000 - kept + 1)),
      `${CANCEL}${ATTRIBUTE_RESET}\r\n${NOTICE}\r\n${numbered(kept, 32_000 - kept + 1)}`,
    ])
  }))

  it('the program is over and its replay stops short: what was held is shown, notice first, before the holder is ended', onFakeClock(async () => {
    const kept = fits(24)
    const shownAtEnd: string[] = []
    const { r, sent } = watched({ adopt: true, before: (h) => {
      heldFrom(5000, numbered(12_000))(h)
      h.child = 'exited'
      h.code = 7
      h.stallReplay = { at: Buffer.byteLength(numbered(11_000)) }
    } }, undefined, (rr) => shownAtEnd.push(rr.text()))
    await settle(() => r.p.isAttached, 'the attach')
    await turns()
    expect(r.text()).toBe('')
    // The exit waits 500 ms for the rest of the replay, then ends the holder.
    await vi.advanceTimersByTimeAsync(500)
    await settle(() => r.exits.length === 1, 'the exit')
    expect(r.seen).toEqual([piece(numbered(kept, 11_000 - kept + 1))])
    expect(shownAtEnd).toEqual([r.text()])
    expect(r.exits).toEqual([7])
    expect(sent).toEqual([])
  }))

  it(`a replay whose end never comes: what came of it is shown ${HOLD_MAX_MS} ms after the hold began, notice first, and output after it as usual`, onFakeClock(async () => {
    const kept = fits(24)
    const { r } = watched({ adopt: true, before: (h) => { heldFrom(5000, numbered(12_000))(h); h.stallReplay = { at: Buffer.byteLength(numbered(11_000)) } } })
    await settle(() => r.p.isAttached, 'the attach')
    await turns()
    await vi.advanceTimersByTimeAsync(HOLD_MAX_MS - 1)
    expect(r.text()).toBe('')
    await vi.advanceTimersByTimeAsync(1)
    expect(r.seen).toEqual([piece(numbered(kept, 11_000 - kept + 1))])
    expect(r.logs).toContain(`[session-helper] ${r.h.sid}: its replay did not end within ${HOLD_MAX_MS} ms, so what came of it is shown now`)
    r.h.output('live\r\n')
    await settle(() => r.seen.length === 2, 'the live output')
    expect(r.seen[1]).toBe('live\r\n')
    expect(r.exits).toEqual([])
  }))

  it('while a replay is held, typed input and a resize from the tab go out at once; the redraw goes only once the held text is shown', onFakeClock(async () => {
    const total = 12_000
    const { r, sent } = watched({ adopt: true, cols: 132, rows: 50, before: (h) => { heldFrom(5000, numbered(total))(h); h.stallReplay = { at: Buffer.byteLength(numbered(11_000)) } } })
    await settle(() => r.p.isAttached, 'the attach')
    await turns()
    r.p.write('typed\r')
    r.p.resize(100, 40)
    await settle(() => r.typed() === 'typed\r' && resizes(r.h).length === 1, 'the input and the resize')
    expect(r.text()).toBe('')
    expect(sent).toEqual([{ cols: 100, rows: 40, shown: '' }])
    // The connection drops: what was held stays held, and the attach again
    // brings the rest; then all of it is shown at the tab's newest size, and
    // the redraw goes after it.
    r.h.dropAll()
    await settle(() => r.h.attaches === 2 && sent.length > 1, 'the attach again and the redraw')
    const kept = fits(40, 100)
    expect(r.seen).toEqual([piece(numbered(kept, total - kept + 1))])
    expect(sent.slice(1)).toEqual([{ cols: 100, rows: 39, shown: r.text() }])
  }))

  for (const [what, stop] of stops) {
    it(`${what} while its replay is held: what was held is shown, notice first, once`, onFakeClock(async () => {
      const { r } = watched({ adopt: true, cols: 132, rows: 50, before: (h) => { heldFrom(5000, 'first half second half\r\n')(h); h.stallReplay = { at: 11 } } })
      await settle(() => r.p.isAttached, 'the attach')
      await turns()
      expect(r.text()).toBe('')
      await stop(r)
      await settle(() => !r.p.isAttached, 'the terminal to let go')
      await vi.advanceTimersByTimeAsync(HOLD_MAX_MS)
      expect(r.seen[0]).toBe(piece('first half '))
      expect(r.text().split(NOTICE)).toHaveLength(2)
    }))
  }

  it('an empty replay after a gap: the notice alone, at once, not at the cap; for a program still running and for one that is over', onFakeClock(async () => {
    const live = watched({ adopt: true, before: heldFrom(5000, '') })
    await settle(() => live.r.seen.length > 0 && live.sent.length > 0, 'the notice and the redraw')
    expect(live.r.seen).toEqual([piece('')])
    const over = watched({ adopt: true, before: (h) => { heldFrom(5000, '')(h); h.child = 'exited'; h.code = 4 } })
    await settle(() => over.r.exits.length === 1, 'the exit')
    expect(over.r.seen).toEqual([piece('')])
    expect([...live.r.logs, ...over.r.logs].filter((l) => l.includes('did not end within'))).toEqual([])
  }))

  it('a reply with no ring_end: the hold ends where the replay starts, so the notice goes at once and the replay follows it, with no wait for the cap', onFakeClock(async () => {
    const r = rig({
      adopt: true,
      before: heldFrom(5000, 'the last screen\r\n'),
      connect: async (record, open) => {
        const c = await open(record)
        const request = c.request.bind(c)
        c.request = (msg, onReply) => request(msg, onReply && msg.t === 'term.attach'
          ? (m) => {
              const rest = { ...m }
              delete rest.ring_end
              onReply(rest)
            }
          : onReply)
        return c
      },
    })
    // Without the cap: settle never moves the clock on by HOLD_MAX_MS.
    await settle(() => r.text().endsWith('the last screen\r\n'), 'the replay')
    expect(r.text()).toBe(piece('the last screen\r\n'))
    expect(r.logs.filter((l) => l.includes('did not end within'))).toEqual([])
  }))

  it('a last line longer than the tab keeps: the notice, then the last of that line, cut at the start of one of its rows; with a prompt after it, the prompt too', onFakeClock(async () => {
    const long = 'x'.repeat(1_000_000)
    const shown: Array<[string, string]> = []
    for (const after of ['', '\r\n$ ']) {
      const { r, sent } = watched({ adopt: true, before: heldFrom(5000, `${numbered(200)}${long}${after}`) })
      await settle(() => sent.length > 0, 'the redraw')
      expect(r.seen).toHaveLength(1)
      expect(r.text().startsWith(piece('x'))).toBe(true)
      expect(r.text().endsWith(`x${after}`)).toBe(true)
      expect(r.logs.some((l) => l.includes('the oldest 200 lines of its replay, and the start of the line after them, are not shown either'))).toBe(true)
      shown.push([r.text(), after])
    }
    vi.useRealTimers()
    for (const [stream, after] of shown) {
      const rows = await rowsAfter(stream, 80, 24)
      expect(rows[0]).toBe(NOTICE)
      expect(rows[1]).toBe('x'.repeat(80))
      expect(rows.filter((row) => row !== '').at(-1)).toBe(after ? '$ ' : 'x'.repeat(80))
    }
  }))

  /** What a terminal like the tab's is left at after `stream`: the screen in use, three input modes, and its normal screen's rows. */
  async function stateAfter(stream: string, cols: number, rows: number) {
    const term = new Terminal({ cols, rows, scrollback: TERMINAL_SCROLLBACK_LINES, allowProposedApi: true })
    try {
      await new Promise<void>((res) => term.write(stream, res))
      const b = term.buffer.normal
      return {
        type: term.buffer.active.type,
        cursorKeys: term.modes.applicationCursorKeysMode,
        paste: term.modes.bracketedPasteMode,
        mouse: term.modes.mouseTrackingMode,
        normal: Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true) ?? ''),
      }
    } finally {
      term.dispose()
    }
  }

  it('a full-screen program started in the part that is shown: the tab ends on its screen, with its modes, and the notice is the first line of the normal screen', onFakeClock(async () => {
    const program = `\x1b[?1049h\x1b[?1h\x1b[?2004h\x1b[?1000h${`\x1b[H${'screen\r\n'.repeat(23)}`.repeat(600)}`
    const { r, sent } = watched({ adopt: true, before: heldFrom(5000, `${numbered(12_000)}${program}`) })
    await settle(() => sent.length > 0, 'the redraw')
    // What the program draws takes no row of the scrollback, so it is shown whole.
    expect(r.text().endsWith(program)).toBe(true)
    vi.useRealTimers()
    const s = await stateAfter(r.text(), 80, 24)
    expect(s).toMatchObject({ type: 'alternate', cursorKeys: true, paste: true, mouse: 'vt200' })
    expect(s.normal[0]).toBe(NOTICE)
    expect(s.normal).toContain('line 12000')
  }))

  it('attached again after falling behind, the full-screen program it showed ending in the part left out: the tab leaves its screen and modes, and the notice is on the normal screen, within reach', onFakeClock(async () => {
    const { r, sent } = watched()
    await settle(() => r.p.isAttached, 'the attach')
    const start = `\x1b[?1049h\x1b[?1h\x1b[?1000h${'\x1b[Hscreen\r\n'.repeat(3)}`
    r.h.output(start)
    await settle(() => r.text() === start, 'the program\'s start')
    r.h.fallBehind()
    // Nobody attached: the program draws on and ends, 12,000 lines follow, and the ring forgets the screens the tab was never shown.
    const screens = '\x1b[Hscreen\r\n'.repeat(500)
    r.h.output(`${screens}\x1b[?1000l\x1b[?1l\x1b[?1049l${numbered(12_000)}`)
    r.h.forget(Buffer.byteLength(start) + Buffer.byteLength(screens))
    await settle(() => sent.length > 0, 'the redraw')
    expect(r.text()).toContain(`${CANCEL}\x1b[?1049l${ATTRIBUTE_RESET}\r\n${NOTICE}\r\n\x1b[?1000l\x1b[?1l`)
    vi.useRealTimers()
    const s = await stateAfter(r.text(), 80, 24)
    expect(s).toMatchObject({ type: 'normal', cursorKeys: false, mouse: 'none' })
    expect(s.normal).toContain(NOTICE)
    expect(s.normal).toContain('line 12000')
  }))
  /*
   * 2.1.3-beta.13, plan section A1 (aicc_planning#374): a Windows console's
   * output is right only at the size it was made for, and a restored tab's
   * first size can differ for a moment from the one it settles at (93 columns
   * before its WebGL renderer, or a row short). So a take-over whose holder
   * offers the screen reads asks the holder's size first, and its replay,
   * cut or whole, waits for the tab to be at it; meanwhile no size goes to
   * the holder. The rig's connections ask for `screen` here, as the
   * manager's do for a plain terminal.
   */
  describe("a take-over waits for its tab to be at the holder's size (2.1.3-beta.13, plan section A1)", () => {
    /** The holder offers the screen reads, and its terminal is `cols` by `rows`. */
    const at = (cols: number, rows: number, setUp: (h: FakeHolder) => void) => (h: FakeHolder) => {
      setUp(h)
      h.caps = [...h.caps, 'screen']
      h.size = { cols, rows }
    }
    /** The lines about the size wait. */
    const sizeLines = (r: Rig) => r.logs.filter((l) => l.includes("holder's size"))

    for (const [what, cols, rows] of [['93 columns (the DOM renderer\'s cell)', 93, 27], ['26 rows', 103, 26]] as const) {
      it(`spawned at ${what}, its holder at 103x27, the start of its output gone: nothing reaches the tab and no size the holder until the tab is at 103x27; then one piece, notice first, counted at 103x27 with the cursor's row followed and started on the last row (plan section A2), and the redraw after it`, onFakeClock(async () => {
        const total = 12_000
        const { r, sent } = watched({ adopt: true, screen: true, cols, rows, before: at(103, 27, heldFrom(5000, numbered(total))) })
        await settle(() => r.p.isAttached, 'the attach')
        await turns()
        await vi.advanceTimersByTimeAsync(SIZE_WAIT_MAX_MS - 100)
        // The tab passes through its first size again on its way.
        r.p.resize(cols, rows)
        await turns()
        expect(r.text()).toBe('')
        expect(sent).toEqual([])
        expect(r.h.screenReads).toBe(1)
        r.clock.now += 120
        r.p.resize(103, 27)
        await settle(() => sent.length > 0, 'the redraw')
        // The rows less one come off for the empty rows between the notice and the last row.
        const kept = fits(27, 103) - 26
        expect(r.seen).toEqual([piece(`\x1b[27;1H${numbered(kept, total - kept + 1)}`)])
        // The redraw's first half is the first size the holder is sent, after the replay.
        expect(sent).toEqual([{ cols: 103, rows: 26, shown: r.text() }])
        await vi.advanceTimersByTimeAsync(300)
        await settle(() => resizes(r.h).length === 2, 'the holder to get both')
        expect(resizes(r.h)).toEqual([{ cols: 103, rows: 26 }, { cols: 103, rows: 27 }])
        expect(sizeLines(r)).toEqual([`[session-helper] ${r.h.sid}: the tab is at its holder's size 103x27, 120 ms after it started`])
        expect(r.logs).toContain(`[session-helper] ${r.h.sid}: the oldest ${total - kept} lines of its replay are not shown either, so the line saying so stays within the ${TERMINAL_SCROLLBACK_LINES} lines the tab keeps (rows counted at 103x27, the cursor's row followed)`)
        expect(r.exits).toEqual([])
        vi.useRealTimers()
        const shown = await rowsAfter(r.text(), 103, 27)
        expect(shown[0]).toBe(NOTICE)
        expect(shown.slice(1, 27)).toEqual([...Array(25).fill(''), `line ${total - kept + 1}`])
      }))
    }

    it("a whole replay (nothing lost): held too, and shown as it is, with no notice, once the tab is at the holder's size; then the take-over's one resize, at that size", onFakeClock(async () => {
      const { r, sent } = watched({ adopt: true, screen: true, cols: 93, rows: 27, before: at(103, 27, running('kept\r\n')) })
      await settle(() => r.p.isAttached, 'the attach')
      await turns()
      expect(r.text()).toBe('')
      expect(sent).toEqual([])
      r.p.resize(103, 27)
      await settle(() => sent.length > 0, 'the resize')
      expect(r.seen).toEqual(['kept\r\n'])
      expect(sent).toEqual([{ cols: 103, rows: 27, shown: 'kept\r\n' }])
      await vi.advanceTimersByTimeAsync(SIZE_WAIT_MAX_MS + HOLD_MAX_MS)
      expect(sent).toHaveLength(1)
      expect(r.logs.filter((l) => l.includes('did not'))).toEqual([])
    }))

    it("a tab at the holder's size from its start: no wait, the replay and the take-over's one resize as before, and the log says so", onFakeClock(async () => {
      const { r, sent } = watched({ adopt: true, screen: true, cols: 103, rows: 27, before: at(103, 27, running('kept\r\n')) })
      await settle(() => sent.length > 0 && r.text() === 'kept\r\n', 'the replay and the resize')
      expect(sizes(sent)).toEqual([{ cols: 103, rows: 27 }])
      expect(sizeLines(r)).toEqual([`[session-helper] ${r.h.sid}: the tab is at its holder's size 103x27, 0 ms after it started`])
    }))

    for (const [what, setUp, line] of [
      ['a holder that offers no screen reads', (h: FakeHolder) => { h.size = { cols: 103, rows: 27 } }, null],
      ['a screen read the holder answers with an error', (h: FakeHolder) => { at(103, 27, () => {})(h); h.screenAnswer = 'error' }, 'the screen is no longer kept'],
      ['a screen read whose answer does not read', (h: FakeHolder) => { at(103, 27, () => {})(h); h.screenAnswer = 'bad' }, 'the holder answered screen.read with a reply that does not read'],
    ] as const) {
      it(`${what}: shown as before, at once and at the tab's size, with the take-over's one resize`, onFakeClock(async () => {
        const { r, sent } = watched({ adopt: true, screen: true, cols: 93, rows: 27, before: (h) => { running('kept\r\n')(h); setUp(h) } })
        await settle(() => sent.length > 0 && r.text() === 'kept\r\n', 'the replay and the resize')
        expect(sizes(sent)).toEqual([{ cols: 93, rows: 27 }])
        expect(sizeLines(r)).toEqual(line === null ? [] : [`[session-helper] ${r.h.sid}: its holder's size could not be read (${line}), so its replay is shown at the tab's size`])
        expect(r.h.screenReads).toBe(line === null ? 0 : 1)
      }))
    }

    it(`a tab that never reaches the holder's size: ${SIZE_WAIT_MAX_MS} ms after the size was read, the replay is shown at the tab's size, one log line gives both sizes, and the redraw follows at the tab's size`, onFakeClock(async () => {
      const { r, sent } = watched({ adopt: true, screen: true, cols: 93, rows: 27, before: at(103, 27, heldFrom(5000, 'the last screen\r\n')) })
      await settle(() => r.p.isAttached, 'the attach')
      await turns()
      await vi.advanceTimersByTimeAsync(SIZE_WAIT_MAX_MS - 1)
      expect(r.text()).toBe('')
      expect(sent).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      await settle(() => sent.length > 0, 'the redraw')
      expect(r.seen).toEqual([piece('the last screen\r\n')])
      expect(sent).toEqual([{ cols: 93, rows: 26, shown: r.text() }])
      expect(sizeLines(r)).toEqual([`[session-helper] ${r.h.sid}: the tab did not reach its holder's size 103x27 within ${SIZE_WAIT_MAX_MS} ms (it is 93x27), so its replay is shown at the tab's size`])
      expect(r.logs.filter((l) => l.includes('did not end within'))).toEqual([])
    }))

    it("a replay whose end never comes: the tab reaching the holder's size shows nothing early, and what came of it is shown at the replay's own cap, as before", onFakeClock(async () => {
      const { r } = watched({ adopt: true, screen: true, cols: 93, rows: 27, before: at(103, 27, (h) => { heldFrom(5000, 'first half second half\r\n')(h); h.stallReplay = { at: 11 } }) })
      await settle(() => r.p.isAttached, 'the attach')
      await turns()
      r.p.resize(103, 27)
      await turns()
      expect(r.text()).toBe('')
      await vi.advanceTimersByTimeAsync(HOLD_MAX_MS)
      // At the holder's size, so from the last row (plan section A2).
      expect(r.seen).toEqual([piece('\x1b[27;1Hfirst half ')])
      expect(r.logs).toContain(`[session-helper] ${r.h.sid}: its replay did not end within ${HOLD_MAX_MS} ms, so what came of it is shown now`)
    }))

    it("ended while its holder's size is being read: no attach, the holder is ended, the tab gets its exit, and no line about the size", onFakeClock(async () => {
      const { r, sent } = watched({ adopt: true, screen: true, cols: 93, rows: 27, before: at(103, 27, (h) => { heldFrom(5000, 'the last screen\r\n')(h); h.screenAnswer = 'none' }) })
      await settle(() => r.h.screenReads === 1, 'the read')
      r.p.kill()
      await settle(() => r.h.ended && r.exits.length === 1, 'the end')
      await vi.advanceTimersByTimeAsync(SIZE_WAIT_MAX_MS + HOLD_MAX_MS)
      expect(r.h.attaches).toBe(0)
      expect(r.text()).toBe('')
      expect(sent).toEqual([])
      expect(sizeLines(r)).toEqual([])
    }))

    for (const [what, stop] of [...stops, ['its program exits', async (r: Rig) => { r.h.exitChild(3) }]] as Array<[string, (r: Rig) => Promise<void>]>) {
      it(`${what} while it waits for the holder's size: what was held is shown once, notice first, no size goes to the holder, and the wait's cap logs nothing later`, onFakeClock(async () => {
        const { r, sent } = watched({ adopt: true, screen: true, cols: 93, rows: 27, before: at(103, 27, heldFrom(5000, 'the last screen\r\n')) })
        await settle(() => r.p.isAttached, 'the attach')
        await turns()
        expect(r.text()).toBe('')
        await stop(r)
        await settle(() => !r.p.isAttached, 'the terminal to let go')
        await vi.advanceTimersByTimeAsync(SIZE_WAIT_MAX_MS + HOLD_MAX_MS)
        expect(r.seen[0]).toBe(piece('the last screen\r\n'))
        expect(r.text().split(NOTICE)).toHaveLength(2)
        expect(sent).toEqual([])
        expect(r.logs.filter((l) => l.includes('did not'))).toEqual([])
      }))
    }

    /*
     * 2.1.3-beta.13, plan section A2 (aicc_planning#374): with the tab at its
     * holder's size and nothing shown before, a replay's rows are counted
     * with the cursor's row followed, so a Windows console's wrapped lines
     * count the 3 rows the tab gives them, not 5; what is shown starts on the
     * tab's last row, and the rows less one come off the budget. A tab that
     * did not reach that size, one whose size changed since, and a replay
     * after output already shown keep today's count. A program that is over
     * gets it too when its tab started at that size: the wait ended before
     * the attach.
     */
    describe("counted with the cursor's row followed, the tab at its holder's size (2.1.3-beta.13, plan section A2)", () => {
      /** One line as a Windows console writes it at 103 by 27, 2.5 rows long (the recorded shape, tests/fixtures/replay/). */
      const consoleLine = (n: number) => {
        const text = `long ${n} ${'y'.repeat(250)}`
        const [a, b, c] = [text.slice(0, 103), text.slice(103, 206), text.slice(206)]
        return `${a}\r\n\x1b[26;103H${a.slice(-1)}${b}\r\n\x1b[26;103H${b.slice(-1)}${c}\r\n`
      }
      const consoleLines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => consoleLine(from + i)).join('')
      /** The rows a console line takes in the tab: its number and 93 y, then 103 y, then 54 y. */
      const lineRows = (n: number) => [`long ${n} ${'y'.repeat(93)}`, 'y'.repeat(103), 'y'.repeat(54)]
      const PROMPT = 'PS C:\\Users\\user\\work>\x1b[1C'
      /** About 2 MiB, as a full ring holds: lines 2667 to 9999, then the prompt. */
      const replay = `${consoleLines(2667, 9999)}${PROMPT}`
      const notShown = (r: Rig) => r.logs.filter((l) => l.includes('not shown either'))

      it("a 2 MiB replay at 103x27: about 3,320 whole lines of 3 rows from the last row, the notice at row 0, and still there after a screen of redraw and a screen more of output; the log counts the console's lines", onFakeClock(async () => {
        expect(Buffer.byteLength(replay)).toBeGreaterThan(2 * 1024 * 1024)
        const { r, sent } = watched({ adopt: true, screen: true, cols: 93, rows: 27, before: at(103, 27, heldFrom(5000, replay)) })
        await settle(() => r.p.isAttached, 'the attach')
        await turns()
        r.p.resize(103, 27)
        await settle(() => sent.length > 0, 'the redraw')
        // 10,000 less a screen, the notice's row and the 26 empty rows above the last is 9,946 rows: the prompt's, and 3,315 lines of 3.
        const kept = 3315
        expect(notShown(r)).toEqual([`[session-helper] ${r.h.sid}: the oldest ${10000 - kept - 2667} lines of its replay are not shown either, so the line saying so stays within the ${TERMINAL_SCROLLBACK_LINES} lines the tab keeps (rows counted at 103x27, the cursor's row followed)`])
        expect(r.seen).toHaveLength(1)
        expect(r.text() === piece(`\x1b[27;1H${consoleLines(10000 - kept, 9999)}${PROMPT}`)).toBe(true)
        vi.useRealTimers()
        const rows = await rowsAfter(r.text(), 103, 27)
        expect(rows.slice(0, 26)).toEqual([NOTICE, ...Array(25).fill('')])
        expect(rows.slice(26, 26 + 3 * kept)).toEqual(Array.from({ length: kept }, (_, i) => lineRows(10000 - kept + i)).flat())
        expect(rows.slice(26 + 3 * kept)).toEqual(['PS C:\\Users\\user\\work>'])
        // The redraw's screen and a screen more: 54 rows on, the notice is still the first row the tab keeps.
        expect((await rowsAfter(`${r.text()}${'more\r\n'.repeat(54)}`, 103, 27))[0]).toBe(NOTICE)
      }))

      it("a tab that never reaches its holder's size (103x28, the holder 103x27): today's count at the tab's size, 5 rows a console line and each line break a line, and what is shown follows the notice, not moved to the last row", onFakeClock(async () => {
        const { r, sent } = watched({ adopt: true, screen: true, cols: 103, rows: 28, before: at(103, 27, heldFrom(5000, replay)) })
        await settle(() => r.p.isAttached, 'the attach')
        // All of the replay in before the wait's cap (the replay's own cap, at the same moment, would show only a part).
        await turns(500)
        await vi.advanceTimersByTimeAsync(SIZE_WAIT_MAX_MS)
        await settle(() => sent.length > 0, 'the redraw')
        expect(r.logs.filter((l) => l.includes('did not end within'))).toEqual([])
        // 10,000 less a screen (28) and the notice's row is 9,971 rows: the prompt's, and 1,994 lines of 5.
        const kept = 1994
        expect(notShown(r)).toEqual([`[session-helper] ${r.h.sid}: the oldest ${3 * (10000 - kept - 2667)} lines of its replay are not shown either, so the line saying so stays within the ${TERMINAL_SCROLLBACK_LINES} lines the tab keeps (rows counted at 103x28)`])
        expect(r.seen).toHaveLength(1)
        expect(r.text() === piece(`${consoleLines(10000 - kept, 9999)}${PROMPT}`)).toBe(true)
      }))

      it("a tab that reached its holder's size, then left it and came back before the replay was all in: today's count, its size having changed since", onFakeClock(async () => {
        const { r, sent } = watched({ adopt: true, screen: true, cols: 93, rows: 27, before: at(103, 27, (h) => { heldFrom(5000, replay)(h); h.stallReplay = { at: Buffer.byteLength(consoleLines(2667, 8666)) } }) })
        await settle(() => r.p.isAttached, 'the attach')
        await turns()
        r.p.resize(103, 27)
        r.p.resize(120, 30)
        r.p.resize(103, 27)
        await settle(() => sent.length === 2, 'the two sizes after the wait')
        expect(r.text()).toBe('')
        await vi.advanceTimersByTimeAsync(HOLD_MAX_MS)
        // 10,000 less a screen and the notice's row is 9,972 rows: the cursor's empty row, the last row of the line before,
        // and 1,994 lines of 5.
        const kept = 1994
        expect(notShown(r)).toEqual([`[session-helper] ${r.h.sid}: the oldest ${3 * (8667 - kept - 2667)} lines of its replay are not shown either, so the line saying so stays within the ${TERMINAL_SCROLLBACK_LINES} lines the tab keeps (rows counted at 103x27)`])
        expect(r.seen).toHaveLength(1)
        expect(r.text() === piece(consoleLines(8667 - kept, 8666))).toBe(true)
      }))

      it('a replay after output already shown (attached again with a gap of its own): today\'s count, after a line break, not moved to the last row', onFakeClock(async () => {
        const { r, sent } = watched({ adopt: true, screen: true, cols: 103, rows: 27, before: at(103, 27, running('kept\r\n')) })
        await settle(() => sent.length > 0 && r.text() === 'kept\r\n', 'the replay and the resize')
        r.h.fallBehind()
        // Nobody attached: 12,000 lines, and the ring forgets what was shown and the first of them.
        r.h.output(numbered(12_000))
        r.h.forget(Buffer.byteLength('kept\r\n') + Buffer.byteLength(numbered(1)))
        await settle(() => r.h.attaches === 2 && sent.length > 1, 'the attach again and the redraw')
        const kept = fits(27, 103)
        expect(r.seen).toEqual(['kept\r\n', `${CANCEL}${ATTRIBUTE_RESET}\r\n${NOTICE}\r\n${numbered(kept, 12_000 - kept + 1)}`])
        expect(notShown(r)).toEqual([`[session-helper] ${r.h.sid}: the oldest ${12_000 - kept - 1} lines of its replay are not shown either, so the line saying so stays within the ${TERMINAL_SCROLLBACK_LINES} lines the tab keeps (rows counted at 103x27)`])
      }))

      it("a program that is over, its tab at its holder's size from its start: the wait ended before the attach, so its replay is counted with the cursor's row followed too and started on the last row; then its exit, and no redraw", onFakeClock(async () => {
        const total = 12_000
        const { r, sent } = watched({ adopt: true, screen: true, cols: 103, rows: 27, before: at(103, 27, (h) => { heldFrom(5000, numbered(total))(h); h.child = 'exited'; h.code = 7 }) })
        await settle(() => r.exits.length === 1, 'the exit')
        await vi.advanceTimersByTimeAsync(SIZE_WAIT_MAX_MS + HOLD_MAX_MS)
        // The rows less one come off for the empty rows between the notice and the last row.
        const kept = fits(27, 103) - 26
        expect(r.seen).toEqual([piece(`\x1b[27;1H${numbered(kept, total - kept + 1)}`)])
        expect(notShown(r)).toEqual([`[session-helper] ${r.h.sid}: the oldest ${total - kept} lines of its replay are not shown either, so the line saying so stays within the ${TERMINAL_SCROLLBACK_LINES} lines the tab keeps (rows counted at 103x27, the cursor's row followed)`])
        expect(sizeLines(r)).toEqual([`[session-helper] ${r.h.sid}: the tab is at its holder's size 103x27, 0 ms after it started`])
        expect(r.exits).toEqual([7])
        expect(sent).toEqual([])
      }))
    })
  })
})
