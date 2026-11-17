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
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, rmdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { IPty } from 'node-pty'
import { HolderConnection, HolderError, INPUT_FRAMES_PER_PING, unixEndpointFolderProblem } from '../../../src/main/session-helper/connection'
import { HelperPty, LOST_EXIT_CODE, type HelperPtyDriver } from '../../../src/main/session-helper/helper-pty'
import { RAW_MAX, heldSessionId, type HolderRecord, type LaunchSpec } from '../../../src/main/session-helper/protocol'
import { FakeHolder, duplexPair, type ConnEvent } from './session-helper-fake-holder'

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
