/**
 * A helper tab's picture to its machine (plan 2.1.3-beta.21, phase 4;
 * ADR-032; docs/remote/helper-protocol.md section 15, capability `paste`),
 * with a fake holder and a fake ssh:
 *
 * - a helper tab's own connection acks `paste` when its holder offers it,
 *   and putPicture sends the picture by `file.put` on that connection, the
 *   one attached to the terminal: the name it takes (`paste-<n>.png` or
 *   `.jpg`), then its bytes on the paste channel; it answers the name and the
 *   hash, never a path, and nothing is typed into the session;
 * - each picture of the tab takes a higher number;
 * - refused, with nothing sent: before the tab reached its holder, and on a
 *   holder from before 2.1.3-beta.21 (no `paste`); the holder's refusal
 *   rejects with its code;
 * - a session folder the holder made for a picture goes at the tab's end
 *   (`unsession`, once its holder ended), though the tab wrote no files of
 *   its own there; a tab that stored no picture and wrote no files runs no
 *   unsession, as before.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { RemoteHelperPty, remoteLaunchSpec, remoteSessionId } from '../../../src/main/remote-helper/session'
import type { RemoteMachineRecord } from '../../../src/main/remote-helper/machines'
import { PASTE_CHANNEL, PASTE_NAME_RE } from '../../../src/main/session-helper/protocol'
import { FakeHolder, type FakeConn } from '../main/session-helper-fake-holder'
import { FakeSsh, result } from './fake-ssh'

const SHA = 'a'.repeat(64)
const INSTALL = 'f'.repeat(32)
const MACHINE: RemoteMachineRecord = {
  did: '0123456789abcdef0123456789abcdef', host: 'rocky.lan', port: 22, user: 'nick', label: 'Rocky', addedAt: 1,
  os: 'Linux', arch: 'x86_64', home: '/home/nick', shell: '/bin/bash', shellIsSh: true, claudePath: '/home/nick/.local/bin/claude',
  path: '/home/nick/.local/bin:/usr/bin:/bin', lang: null, helper: { path: 'linux-x64/aicc-helper', version: '0.1.0', sha256: SHA, folder: `0.1.0-${SHA.slice(0, 12)}` }, check: { at: 1, ok: true },
}
const OFFERS = ['core', 'local', 'hooks', 'mcp', 'away', 'screen', 'title', 'status', 'paste']

let work = ''
let store = ''
let logs: string[] = []
beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-paste-'))
  store = path.join(work, 'store')
  logs = []
})
afterEach(() => {
  if (work) fs.rmSync(work, { recursive: true, force: true })
})

async function until(what: string, ok: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!ok()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const picture = (n: number, seed = 1) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 13 + seed) & 0xff))

/** The fake host for one holder: the hold starts it (one that runs until it
 *  is ended, for `kept`), a bridge reaches it, each connection a bridge made
 *  is kept in order, and each `unsession` is counted (its session id). */
function hostOf(holder: FakeHolder, kept = false): { ssh: FakeSsh; unsessions: string[]; links: FakeConn[] } {
  const unsessions: string[] = []
  const links: FakeConn[] = []
  const ssh = new FakeSsh({
    answer: (c) => {
      const n = c.values[0]
      const record = { ...holder.record(), endpoint: `/tmp/aicc-1000/${holder.sid}-0123456789abcdef.sock`, ...(kept ? { away: null, lifetime: 'until-ended' } : {}) }
      if (c.script === 'hold') return { stdout: `AICC-HASH ${n} ok ${SHA}\n${JSON.stringify(record)}\n` }
      if (c.script === 'unsession') unsessions.push(c.values[3])
      return { stdout: result(n, {}) }
    },
    bridge: () => {
      if (holder.ended) return null
      const end = holder.connect()
      links.push([...holder.conns].at(-1)!)
      return end
    },
  })
  return { ssh, unsessions, links }
}

function tab(id: string, caps = OFFERS, kept = false) {
  const holder = new FakeHolder(remoteSessionId(id), id, store)
  holder.caps = caps
  const { ssh, unsessions, links } = hostOf(holder, kept)
  const spec = remoteLaunchSpec(MACHINE, { program: MACHINE.claudePath!, args: [], env: {} }, {}, '~', 100, 30)
  const pty = new RemoteHelperPty({ appPtyId: id, machine: MACHINE, installId: INSTALL, runner: ssh, spec, log: (m) => logs.push(m), ...(kept ? { kind: 'until-ended' as const } : {}) })
  return { holder, ssh, unsessions, links, pty }
}

describe('a helper tab sends a picture to its machine by file.put', () => {
  it('on its attached connection, which acked paste: the name it took and the hash come back, never a path, and nothing is typed', async () => {
    const t = tab('paste-round-trip')
    await until('attached', () => t.holder.attached !== null)
    expect(t.holder.attached!.ackedCaps).toContain('paste')
    const bytes = picture(70_000)
    const stored = await t.pty.putPicture(bytes, 'png')
    expect(Object.keys(stored).sort()).toEqual(['name', 'sha256'])
    expect(stored.name).toMatch(PASTE_NAME_RE)
    expect(stored.name.endsWith('.png')).toBe(true)
    expect(stored.sha256).toBe(sha(bytes))
    expect(t.holder.pictures).toHaveLength(1)
    expect(t.holder.pictures[0].name).toBe(stored.name)
    expect(t.holder.pictures[0].bytes.equals(bytes)).toBe(true)
    // The header on channel 0, the bytes on the paste channel only: nothing reached the program.
    const put = t.holder.requests.find((m) => m.t === 'file.put')!
    expect(put).toEqual({ t: 'file.put', id: put.id, name: stored.name, size: bytes.length, sha256: sha(bytes) })
    expect(t.holder.pictureChunks.every((c) => c.channel === PASTE_CHANNEL)).toBe(true)
    expect(t.holder.input).toEqual([])
    t.pty.kill()
    await t.pty.ended
  })

  it('each picture of the tab takes a higher number, and a jpg keeps its type', async () => {
    const t = tab('paste-numbers')
    await until('attached', () => t.holder.attached !== null)
    const a = await t.pty.putPicture(picture(10, 1), 'png')
    const b = await t.pty.putPicture(picture(20, 2), 'jpg')
    const n = (name: string) => Number(/^paste-([0-9]+)\./.exec(name)![1])
    expect(n(b.name)).toBeGreaterThan(n(a.name))
    expect(b.name.endsWith('.jpg')).toBe(true)
    expect(t.holder.pictures.map((p) => p.name)).toEqual([a.name, b.name])
    t.pty.kill()
    await t.pty.ended
  })

  it('refused, with nothing sent: on a holder from before 2.1.3-beta.21, whose hello offers no paste', async () => {
    const t = tab('paste-old-holder', OFFERS.slice(0, 8))
    await until('attached', () => t.holder.attached !== null)
    expect(t.holder.attached!.ackedCaps).not.toContain('paste')
    await expect(t.pty.putPicture(picture(10), 'png')).rejects.toMatchObject({ code: 'unknown-type' })
    expect(t.holder.requests.filter((m) => m.t === 'file.put')).toEqual([])
    expect(t.holder.pictureChunks).toEqual([])
    t.pty.kill()
    await t.pty.ended
  })

  it('only the tab\'s own connection asks for paste: the link of an End asks for none', async () => {
    const t = tab('paste-end-link', OFFERS, true)
    await until('attached', () => t.holder.attached !== null)
    const acks = () => t.links.map((c) => c.ackedCaps)
    expect(acks()[0]).toContain('paste')
    await expect(t.pty.end()).resolves.toEqual({ ok: true })
    expect(t.holder.ended).toBe(true)
    expect(t.links.length).toBe(2)
    expect(acks()[1]).toEqual(['core', 'local'])
  })

  it('refused before the tab reached its holder', async () => {
    const t = tab('paste-too-early')
    await expect(t.pty.putPicture(picture(10), 'png')).rejects.toMatchObject({ code: 'not-connected' })
    await until('attached', () => t.holder.attached !== null)
    expect(t.holder.requests.filter((m) => m.t === 'file.put')).toEqual([])
    t.pty.kill()
    await t.pty.ended
  })

  it('the holder\'s refusal rejects with its code', async () => {
    const t = tab('paste-refused')
    await until('attached', () => t.holder.attached !== null)
    t.holder.pasteRefusal = 'io'
    await expect(t.pty.putPicture(picture(10), 'png')).rejects.toMatchObject({ code: 'io' })
    expect(t.holder.pictures).toEqual([])
    t.pty.kill()
    await t.pty.ended
  })
})

describe('the session folder a picture needed goes at the tab\'s end', () => {
  it('a tab that wrote no files of its own but stored a picture: its folder\'s unsession runs once its holder ended', async () => {
    const t = tab('paste-folder-goes')
    await until('attached', () => t.holder.attached !== null)
    await t.pty.putPicture(picture(10), 'png')
    t.pty.kill()
    await t.pty.ended
    await until('the unsession', () => t.unsessions.length === 1)
    expect(t.unsessions).toEqual([t.pty.sid])
    expect(t.holder.ended).toBe(true)
  })

  it('a tab that stored no picture and wrote no files runs no unsession, as before', async () => {
    const t = tab('paste-no-folder')
    await until('attached', () => t.holder.attached !== null)
    t.pty.kill()
    await t.pty.ended
    await new Promise((r) => setTimeout(r, 50))
    expect(t.unsessions).toEqual([])
  })
})
