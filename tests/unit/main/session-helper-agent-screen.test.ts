// 2.1.3-beta.14 B2 (aicc_planning#388): with the agent sessions' setting on, a
// held agent session of a provider the manager is given in deps.screens
// (app-wiring.ts gives Codex's) asks on its connections for the holder's
// screen reads and the screen's title, and its terminal hands out the read
// (HelperPty.screenRead). Through the real manager, HelperPty and
// HolderConnection, against the fake helper.
//
// The cases:
//  1. such a session's connection acks `screen` and `title`, and its read is
//     the holder's `screen.read`; a Claude Code session asks for neither;
//  2. without deps.screens a Codex session asks for neither, as before;
//  3. a holder that offers `screen` but not `title`: no read, so the pane
//     (2.1.3-beta.15: the title's spinner is the composer rule's only busy
//     sign while a reply streams);
//  4. after the connection drops and the terminal attaches again, the read
//     goes on the new connection;
//  5. a launch its holder refused starts the usual way, and has no read;
//  6. a read handed out earlier rejects once the terminal attaches again on a
//     connection without the title, and none is handed out after
//     (2.1.3-beta.15).
//
// Not checked here: what the composer rule makes of the read
// (tests/unit/main/codex-held-screen.test.ts) and the binding that asks for it
// at the run's first byte (tests/unit/main/launch-bindings-held-screen.test.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { IPty } from 'node-pty'

const ptySpawn = vi.hoisted(() => vi.fn())
vi.mock('node-pty', () => ({ spawn: ptySpawn }))
vi.mock('../../../src/main/account-profiles', async (importOriginal) => {
  const fs = await import('node:fs')
  return {
    ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
    mkdirSecure: (d: string) => { fs.mkdirSync(d, { recursive: true }) },
    hardenCredentialDir: () => {},
    atomicWriteSecure: (f: string, data: string) => { fs.writeFileSync(f, data) },
  }
})
vi.mock('../../../src/main/conductor-mcp-server', () => ({}))

import { SessionHelperManager, setSessionHelper, spawnAgentPty } from '../../../src/main/session-helper/manager'
import { HelperPty } from '../../../src/main/session-helper/helper-pty'
import { heldAgentSessionId } from '../../../src/main/session-helper/protocol'
import { FakeHelper } from './session-helper-fake-holder'

const CWD = 'C:\\Users\\someone\\project'
const CODEX = 'C:\\Users\\someone\\bin\\codex.exe'
const SHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const agentOpts = () => ({ name: 'xterm-256color', cols: 120, rows: 30, cwd: CWD, env: { Path: 'C:\\Windows' }, useConpty: true })
const codexTab = (sessionId: string) => ({ sessionId, kind: 'codex' as const })
const claudeTab = (sessionId: string) => ({ sessionId, kind: 'claude' as const })
const ON_AGENTS = { atStartup: true, plain: false, agents: true }

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await tick(5)
  }
}

function fakeDirect(): IPty {
  return { pid: 1, cols: 80, rows: 24, process: 'x', handleFlowControl: false, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), resize() {}, clear() {}, write() {}, kill() {}, pause() {}, resume() {} } as unknown as IPty
}

let dir: string
let bundled: string
let root: string
let helper: FakeHelper
const managers: SessionHelperManager[] = []

function makeManager(over: Partial<ConstructorParameters<typeof SessionHelperManager>[0]> = {}): SessionHelperManager {
  const m = new SessionHelperManager({
    platform: 'win32', root, bundled,
    exec: async (file, args) => helper.exec(file, args),
    openStream: async (endpoint) => helper.openStream(endpoint),
    spawnDirect: (file, args, o) => ptySpawn(file, args, o), newTabId: () => 'newtab0123456789abcdef01', conptySource: () => null, ...over,
  })
  managers.push(m)
  return m
}

async function startedWith(m: SessionHelperManager): Promise<SessionHelperManager> {
  await m.start(ON_AGENTS)
  await until(() => m.serviceState().state === 'ready', 'the helper to be ready')
  setSessionHelper(m)
  return m
}

beforeEach(() => {
  ptySpawn.mockReset()
  ptySpawn.mockImplementation(() => fakeDirect())
  dir = mkdtempSync(join(tmpdir(), 'aicc-helper-agent-screen-'))
  mkdirSync(join(dir, 'install', 'helper'), { recursive: true })
  bundled = join(dir, 'install', 'helper', 'aicc-helper.exe')
  writeFileSync(bundled, 'MZ the installed helper')
  root = join(dir, 'user', 'helper')
  helper = new FakeHelper()
  helper.holderCaps = ['core', 'local', 'hooks', 'mcp', 'screen', 'title']
})

afterEach(async () => {
  const quits = managers.splice(0).map((m) => { try { return m.shutdown() } catch { return null } })
  setSessionHelper(null)
  for (const h of helper.holders.values()) h.dropAll()
  let timer: NodeJS.Timeout | undefined
  await Promise.race([Promise.allSettled(quits), new Promise<void>((r) => { timer = setTimeout(r, 3000) })]).finally(() => clearTimeout(timer))
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }) } catch { /* the run's own temp folder goes with the run */ }
})

describe('a held agent session\'s screen read', () => {
  it('1. a provider in deps.screens: its connection acks screen and title, and its read is the holder\'s screen.read; a Claude Code session asks for neither', async () => {
    await startedWith(makeManager({ screens: { codex: true } }))
    const id = 'abcdef0123456789abcdefb1'
    const p = spawnAgentPty(codexTab(id), CODEX, [], agentOpts()) as HelperPty
    expect(p).toBeInstanceOf(HelperPty)
    expect(p.screenRead).toBeUndefined()
    const h = await attachedHolder(heldAgentSessionId(id, 'codex'), p)
    // No hooks or tool functions are given here, so only the screen reads are asked for.
    expect(h.attached!.ackedCaps).toEqual(['core', 'local', 'screen', 'title'])
    const read = p.screenRead!
    const rows = await read()
    expect(h.screenReads).toBe(1)
    // title null: the fake holder answers none (not modelled). A title in the answer is checked at the connection (session-helper-screen-title.test.ts) and at the rule (codex-held-screen.test.ts).
    expect({ cols: rows.cols, rows: rows.rows, lines: rows.lines.length, cut: rows.cut, title: rows.title }).toEqual({ cols: 120, rows: 30, lines: 30, cut: false, title: null })

    const cid = 'abcdef0123456789abcdefb2'
    const q = spawnAgentPty(claudeTab(cid), SHELL, [], agentOpts()) as HelperPty
    const hc = await attachedHolder(heldAgentSessionId(cid, 'claude'), q)
    expect(hc.attached!.ackedCaps).toEqual(['core', 'local'])
    expect(q.screenRead).toBeUndefined()
  })

  it('2. without deps.screens a Codex session asks for neither, as before', async () => {
    await startedWith(makeManager())
    const id = 'abcdef0123456789abcdefb3'
    const p = spawnAgentPty(codexTab(id), CODEX, [], agentOpts()) as HelperPty
    const h = await attachedHolder(heldAgentSessionId(id, 'codex'), p)
    expect(h.attached!.ackedCaps).toEqual(['core', 'local'])
    expect(p.screenRead).toBeUndefined()
  })

  it('3. a holder that offers screen but not title: no read, so the pane', async () => {
    helper.holderCaps = ['core', 'local', 'hooks', 'mcp', 'screen']
    await startedWith(makeManager({ screens: { codex: true } }))
    const id = 'abcdef0123456789abcdefb4'
    const p = spawnAgentPty(codexTab(id), CODEX, [], agentOpts()) as HelperPty
    const h = await attachedHolder(heldAgentSessionId(id, 'codex'), p)
    expect(h.attached!.ackedCaps).toEqual(['core', 'local', 'screen'])
    expect(p.screenRead).toBeUndefined()
    expect(h.screenReads).toBe(0)
  })

  it('4. after the connection drops and the terminal attaches again, the read goes on the new connection', async () => {
    await startedWith(makeManager({ screens: { codex: true } }))
    const id = 'abcdef0123456789abcdefb5'
    const p = spawnAgentPty(codexTab(id), CODEX, [], agentOpts()) as HelperPty
    const h = await attachedHolder(heldAgentSessionId(id, 'codex'), p)
    const read = p.screenRead!
    const first = h.attached!
    h.fallBehind()
    await until(() => h.attaches === 2 && p.isAttached, 'the attach again')
    expect(h.attached).not.toBe(first)
    await read()
    expect(h.screenReads).toBe(1)
    expect(h.attached!.frames.filter((f) => f.t === 'screen.read')).toHaveLength(1)
    expect(first.frames.filter((f) => f.t === 'screen.read')).toHaveLength(0)
  })

  it('5. a launch its holder refused starts the usual way, and has no read', async () => {
    helper.holdBusy = true
    await startedWith(makeManager({ screens: { codex: true } }))
    const p = spawnAgentPty(codexTab('abcdef0123456789abcdefb6'), CODEX, [], agentOpts()) as HelperPty
    await until(() => ptySpawn.mock.calls.length === 1, 'the usual start')
    expect(p.throughHelper).toBe(false)
    expect(p.screenRead).toBeUndefined()
  })

  it('6. a read handed out earlier rejects once the terminal attaches again on a connection without the title, and none is handed out after', async () => {
    await startedWith(makeManager({ screens: { codex: true } }))
    const id = 'abcdef0123456789abcdefb7'
    const p = spawnAgentPty(codexTab(id), CODEX, [], agentOpts()) as HelperPty
    const h = await attachedHolder(heldAgentSessionId(id, 'codex'), p)
    const read = p.screenRead!
    // The holder's next hello offers the screen but not the title.
    h.caps = ['core', 'local', 'hooks', 'mcp', 'screen']
    h.fallBehind()
    await until(() => h.attaches === 2 && p.isAttached, 'the attach again')
    expect(h.attached!.ackedCaps).toEqual(['core', 'local', 'screen'])
    await expect(read()).rejects.toThrow(/no connection reads its holder's screen now/)
    expect(p.screenRead).toBeUndefined()
    expect(h.screenReads).toBe(0)
  })
})

/** The holder of `sid`, once `p` is attached to it. */
async function attachedHolder(sid: string, p: HelperPty) {
  await until(() => !!helper.holders.get(sid)?.attached && p.isAttached, 'the session to attach')
  return helper.holders.get(sid)!
}
