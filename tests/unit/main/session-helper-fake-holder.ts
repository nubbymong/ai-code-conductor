/**
 * A fake session helper for the app's client tests: holders that speak the
 * protocol (docs/remote/helper-protocol.md, sections 6, 7 and 15) over an
 * in-memory stream, and the helper's one-shot commands (version, hold, list,
 * selftest) as an exec. Records are written to the real store folder the
 * manager reads, as the helper writes them.
 */
import { randomBytes } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { Duplex, PassThrough } from 'stream'
import { FrameReader, encodeJsonFrame, encodeRawFrame, type HolderRecord } from '../../../src/main/session-helper/protocol'
import type { ExecResult } from '../../../src/main/session-helper/manager'

const hex = (bytes: number) => randomBytes(bytes).toString('hex')

/** Two ends of one in-memory connection. */
export function duplexPair(): [Duplex, Duplex] {
  const toB = new PassThrough()
  const toA = new PassThrough()
  return [Duplex.from({ readable: toA, writable: toB }), Duplex.from({ readable: toB, writable: toA })]
}

type Json = Record<string, unknown>

export class FakeConn {
  acked = false
  closed = false
  readonly frames: Json[] = []
  constructor(readonly holder: FakeHolder, readonly end: Duplex) {}
  sendJson(v: Json): void { if (!this.closed) this.end.write(encodeJsonFrame(v)) }
  sendRaw(b: Buffer): void {
    if (this.closed) return
    for (let i = 0; i < b.length; i += 65536) this.end.write(encodeRawFrame(b.subarray(i, i + 65536)))
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.end.end()
    this.holder.conns.delete(this)
    if (this.holder.attached === this) this.holder.attached = null
  }
}

export class FakeHolder {
  readonly nonce = hex(16)
  readonly endpoint: string
  readonly pid = 30000 + Math.floor(Math.random() * 10000)
  readonly started = Date.now()
  launch: Json | null = null
  child: 'waiting' | 'running' | 'exited' = 'waiting'
  code: number | null = null
  ring = Buffer.alloc(0)
  attached: FakeConn | null = null
  attaches = 0
  ended = false
  readonly conns = new Set<FakeConn>()
  readonly requests: Json[] = []
  readonly input: Buffer[] = []
  size: { cols: number; rows: number } | null = null

  constructor(readonly sid: string, readonly label: string, readonly store: string) {
    this.endpoint = `\\\\.\\pipe\\aicc-helper-${sid}-${hex(16)}`
  }

  record(): HolderRecord {
    return {
      v: 1, session: this.sid, label: this.label, pid: this.pid, endpoint: this.endpoint, nonce: this.nonce,
      helper: '0.1.0', started: this.started, away: 120, attached: !!this.attached, child: this.child, code: this.code,
    }
  }

  writeRecord(): void {
    fs.mkdirSync(this.store, { recursive: true })
    fs.writeFileSync(path.join(this.store, `${this.sid}.json`), JSON.stringify(this.record()))
  }

  /** The app connects: the holder speaks first. */
  connect(): Duplex {
    const [app, mine] = duplexPair()
    const conn = new FakeConn(this, mine)
    this.conns.add(conn)
    const hello = { proto: [1], helper: { version: '0.1.0' }, os: 'windows', arch: 'x86_64', caps: ['core', 'local'], session: { sid: this.sid, state: this.launch ? 'live' : 'new' } }
    mine.write(`AICC-HELLO ${this.nonce} ${JSON.stringify(hello)}\n`)
    const reader = new FrameReader('app_to_helper')
    mine.on('data', (chunk: Buffer) => {
      for (const f of reader.push(chunk)) {
        if (f.kind === 1) {
          if (conn === this.attached) this.input.push(f.bytes)
          continue
        }
        const m = f.json as Json
        conn.frames.push(m)
        if (!conn.acked) {
          if (m.t !== 'hello.ack') { conn.close(); return }
          conn.acked = true
          continue
        }
        this.requests.push(m)
        this.answer(conn, m)
      }
    })
    mine.on('end', () => conn.close())
    return app
  }

  private answer(conn: FakeConn, m: Json): void {
    const re = m.id
    const err = (code: string, text: string) => conn.sendJson({ t: 'error', re, code, text })
    switch (m.t) {
      case 'ping':
        conn.sendJson({ t: 'pong', re })
        return
      case 'term.launch':
        if (this.launch) return err('busy', 'this holder has launched its session already')
        this.launch = m
        this.child = 'running'
        this.writeRecord()
        conn.sendJson({ t: 'term.launched', re, pid: 4242 })
        return
      case 'term.attach': {
        if (!this.launch) return err('not-found', 'nothing launched')
        const from = Number(m.from)
        if (from > this.ring.length) return err('bad-field', 'from is past the ring')
        if (this.attached && this.attached !== conn) {
          const old = this.attached
          old.sendJson({ t: 'error', code: 'replaced', text: 'a newer connection attached to this terminal' })
          old.close()
        }
        this.attached = conn
        this.attaches++
        conn.sendJson({ t: 'term.attached', re, from, ring_start: 0, ring_end: this.ring.length, truncated: false, running: this.child !== 'exited', ...(this.child === 'exited' ? { code: this.code } : {}) })
        conn.sendRaw(this.ring.subarray(from))
        return
      }
      case 'term.resize':
        if (conn !== this.attached) return err('not-connected', 'not attached')
        this.size = { cols: Number(m.cols), rows: Number(m.rows) }
        conn.sendJson({ t: 'term.resized', re })
        return
      case 'term.end':
        this.ended = true
        this.child = 'exited'
        conn.sendJson({ t: 'term.ended', re })
        try { fs.rmSync(path.join(this.store, `${this.sid}.json`), { force: true }) } catch { /* gone */ }
        setTimeout(() => { for (const c of [...this.conns]) c.close() }, 5)
        return
      default:
        err('unknown-type', String(m.t))
    }
  }

  /** The program writes. */
  output(text: string): void {
    const b = Buffer.from(text, 'utf8')
    this.ring = Buffer.concat([this.ring, b])
    this.attached?.sendRaw(b)
  }

  /** The program ends by itself. */
  exitChild(code: number): void {
    this.child = 'exited'
    this.code = code
    this.writeRecord()
    this.attached?.sendJson({ t: 'term.exit', code })
  }

  /** The app is gone (a crash): every connection drops, the holder stays. */
  dropAll(): void {
    for (const c of [...this.conns]) c.close()
  }
}

/** The helper's commands and its holders, as one fake. */
export class FakeHelper {
  readonly holders = new Map<string, FakeHolder>()
  readonly calls: Array<{ file: string; args: string[] }> = []
  version = 'aicc-helper 0.1.0'
  selfTestOk = true
  /** A holder that has launched already, so it answers a launch with busy. */
  holdBusy = false

  exec = async (file: string, args: string[]): Promise<ExecResult> => {
    this.calls.push({ file, args })
    const [cmd] = args
    const opt = (name: string) => args[args.indexOf(name) + 1]
    if (cmd === 'version') return { code: 0, stdout: `${this.version}\n`, stderr: '' }
    if (cmd === 'hold') {
      const sid = opt('--session')
      const existing = this.holders.get(sid)
      if (existing && !existing.ended) return { code: 1, stdout: '', stderr: 'a holder for this session is already running\n' }
      const h = new FakeHolder(sid, opt('--label'), opt('--store'))
      if (this.holdBusy) h.launch = { t: 'term.launch' }
      h.writeRecord()
      this.holders.set(sid, h)
      return { code: 0, stdout: `${JSON.stringify(h.record())}\n`, stderr: '' }
    }
    if (cmd === 'list') {
      const sessions = [...this.holders.values()].filter((h) => !h.ended).map((h) => h.record())
      return { code: 0, stdout: `${JSON.stringify({ v: 1, sessions, removed: 0, skipped: 0 })}\n`, stderr: '' }
    }
    if (cmd === 'selftest') {
      const nonce = opt('--nonce')
      const checks = [
        { name: 'frame-codec', ok: true },
        { name: 'local-transport', ok: this.selfTestOk, ...(this.selfTestOk ? {} : { detail: 'the pipe did not open' }) },
      ]
      return { code: this.selfTestOk ? 0 : 1, stdout: `AICC-RESULT ${nonce} ${JSON.stringify({ ok: this.selfTestOk, helper: '0.1.0', os: 'windows', arch: 'x86_64', checks })}\n`, stderr: '' }
    }
    return { code: 2, stdout: '', stderr: 'unknown command' }
  }

  openStream = async (endpoint: string): Promise<Duplex> => {
    const h = [...this.holders.values()].find((x) => x.endpoint === endpoint && !x.ended)
    if (!h) throw new Error('no holder at that endpoint')
    return h.connect()
  }

  holds(): number {
    return this.calls.filter((c) => c.args[0] === 'hold').length
  }
}
