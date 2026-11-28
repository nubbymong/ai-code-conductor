// nubbymong/aicc_planning#446 (2.1.3-beta.21, plan block 6): the tool host
// offers codex_review to a Claude Code tab through the session helper whose
// machine's record names Codex, and that tool runs the review on the tab's
// machine, never on this computer. Over a tool stream, as the session helper's
// manager hands one over (conductor-mcp-tool-stream.test.ts's stand-in: no
// port, nothing listens):
//  - a registered remote tab whose machine names Codex: codex_review is
//    listed, naming the machine; while this build records no PASS of the
//    probes PV1 and PV2 for the machine's architecture, a call is refused
//    with the reason and nothing runs anywhere; once it does, a call runs on
//    the machine (the remote deps' run), and no account of this computer is
//    asked for;
//  - the same tab on a machine whose record names no Codex: not listed;
//  - a tab never registered (its folder there was its home folder): the
//    tool, offered by the local rule, refuses it and runs nothing anywhere;
//  - the session's end takes the registration with it.

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

vi.mock('http', async (importOriginal) => {
  const real = await importOriginal<typeof import('http')>()
  const createServer = () => ({ listen: (_port: number, _host: string, done: () => void) => { done() }, on: () => {}, close: () => {}, requestTimeout: 0 })
  return { ...real, default: { ...real, createServer }, createServer }
})
vi.mock('../../../src/main/vision-manager', () => ({
  startGlobalVision: vi.fn(), stopGlobalVision: vi.fn(), isGlobalVisionRunning: vi.fn(() => false), getGlobalVisionConfig: vi.fn(),
  cleanupLegacyVisionMarkers: vi.fn(), getGlobalManager: vi.fn(() => null), launchBrowser: vi.fn(),
}))
vi.mock('../../../src/main/config-manager', () => ({
  readConfig: vi.fn(() => ({ codexEnabled: true, codexAnswered: true })),
  readConfigChecked: vi.fn(() => ({ value: { codexEnabled: true, codexAnswered: true }, outcome: 'ok' })),
  saveConfig: vi.fn(),
}))
// An account of this computer is asked for only by a review on this computer.
const prepareLaunch = vi.hoisted(() => vi.fn(async () => ({ ok: false, code: 'not-found', message: 'no account' })))
vi.mock('../../../src/main/provider-accounts', () => ({
  getAccountsService: () => ({ reviewReady: () => true, prepareLaunch }),
}))
vi.mock('../../../src/main/provider-launch-gate', () => ({ providerLaunchRefusal: () => null, providerProbeRefusal: () => null }))
vi.mock('../../../src/main/providers/core', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/providers/core')>()
  const { codexRemoteReview } = await import('../../../src/main/providers/codex/remote-review')
  return { ...real, tryGetProviderPackage: (id: string) => (id === 'codex' ? { review: { run: async () => ({ ok: false, code: 'failed', message: 'no local review here' }), remote: codexRemoteReview } } : real.tryGetProviderPackage(id as never)) }
})
// The running app's wiring gives no proof of its own: this build's
// REMOTE_REVIEW_PROVEN decides. A test past the gate gives one here, for that
// test only; unset, the call is the real one, unchanged.
const runningProof = vi.hoisted(() => ({ value: null as null | Record<string, { codex: string; git: string } | null> }))
vi.mock('../../../src/main/codex-review-remote', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/codex-review-remote')>()
  return {
    ...real,
    runRemoteCodexReview: (a: unknown, t: Parameters<typeof real.runRemoteCodexReview>[1], d: Parameters<typeof real.runRemoteCodexReview>[2], s?: AbortSignal) =>
      real.runRemoteCodexReview(a, t, d && d.proven === undefined && runningProof.value ? { ...d, proven: runningProof.value } : d, s),
  }
})
vi.mock('../../../src/main/update-watcher', () => ({ isPackagedApp: () => false, getProjectRootPath: vi.fn(() => ''), hasSourcePath: vi.fn(() => false) }))
const tmp = vi.hoisted(() => ({ dir: '' }))
vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  tmp.dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-remote-review-'))
  return { getResourcesDirectory: () => tmp.dir }
})
afterAll(() => {
  if (path.basename(tmp.dir).startsWith('ccc-remote-review-')) fs.rmSync(tmp.dir, { recursive: true, force: true })
})

const server = await import('../../../src/main/conductor-mcp-server')
const review = await import('../../../src/main/codex-review-mcp-tool')
const sessions = await import('../../../src/main/remote-helper/review-sessions')
type RemoteMachineRecord = import('../../../src/main/remote-helper/machines').RemoteMachineRecord

type Json = Record<string, any>
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await tick(5)
  }
}

class FakeLink {
  readonly sent: Json[] = []
  closed = false
  private onMessage: ((m: unknown) => void) | null = null
  private onClose: (() => void) | null = null
  send(m: Json): void { if (!this.closed) this.sent.push(m) }
  take(onMessage: (m: unknown) => void, onClose: () => void): void { this.onMessage = onMessage; this.onClose = onClose }
  close(): void { this.closed = true }
  endFromFarSide(): void { this.closed = true; this.onClose?.() }
  async call(id: number, method: string, params: Json = {}): Promise<Json> {
    this.onMessage?.({ jsonrpc: '2.0', id, method, params })
    await until(() => this.sent.some((m) => m.id === id), `the answer to ${method}`)
    return this.sent.find((m) => m.id === id)!
  }
  async tools(): Promise<Array<{ name: string; description: string }>> {
    await this.call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'remote-review-test', version: '0.0.0' } })
    this.onMessage?.({ jsonrpc: '2.0', method: 'notifications/initialized' })
    return (await this.call(2, 'tools/list')).result.tools
  }
}

const SHA = 'a'.repeat(64)
const MACHINE: RemoteMachineRecord = {
  did: '0123456789abcdef0123456789abcdef', host: 'rocky.lan', port: 22, user: 'nick', label: 'Rocky', addedAt: 1,
  os: 'Linux', arch: 'x86_64', home: '/home/nick', shell: '/bin/bash', shellIsSh: true, claudePath: '/home/nick/.local/bin/claude',
  path: '/usr/bin:/bin', lang: null, helper: { path: 'linux-x64/aicc-helper', version: '0.1.0', sha256: SHA, folder: `0.1.0-${SHA.slice(0, 12)}` }, check: { at: 1, ok: true },
  codex: { path: '/home/nick/.npm-global/bin/codex', version: '0.157.1' }, git: '2.47.1',
}
const machine = { value: MACHINE as RemoteMachineRecord }
const run = vi.fn(async () => ({ outcome: { code: 0, signal: null, timeout: false, cut: false }, stdout: `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Reviewed on the machine.' } })}\n`, stderr: '', timedOut: false, cancelled: false }))
const read = vi.fn(async () => ({ ok: true as const, kind: 'diff' as const, diff: 'diff --git a/x b/x\n+x\n' }))
const links: FakeLink[] = []

beforeEach(async () => {
  machine.value = MACHINE
  runningProof.value = null
  run.mockClear()
  read.mockClear()
  prepareLaunch.mockClear()
  review.setRemoteReviewDeps({ machine: () => machine.value, read: read as never, run: run as never, env: () => ({}) })
  await server.startMcpServer(0, () => null as never, () => ({}) as never)
})
afterEach(() => {
  server.stopMcpServer()
  review.setRemoteReviewDeps(null)
  for (const l of links.splice(0)) l.endFromFarSide()
})

/** A remote tab's tool stream, as its holder hands it over: the record a
 *  credential would make, with none made (remote-machines-handlers.ts). */
function stream(sid: string): FakeLink {
  server.recordHeldToolSession(sid, 'claude')
  const link = new FakeLink()
  links.push(link)
  expect(server.serveToolStream(sid, link)).toBe(true)
  return link
}

describe('codex_review for a Claude Code tab through the session helper', () => {
  it('with no PASS of the probes recorded for the machine\'s architecture: offered, and a call is refused with the reason; nothing runs anywhere', async () => {
    runningProof.value = { x86_64: null, aarch64: null }
    expect(sessions.registerRemoteReviewSession('rr-mcp-0', { did: MACHINE.did, cwd: '/home/nick/proj' }, MACHINE.home)).toBe(true)
    const link = stream('rr-mcp-0')
    expect((await link.tools()).map((t) => t.name)).toContain('codex_review')
    const answer = await link.call(3, 'tools/call', { name: 'codex_review', arguments: { mode: 'working' } })
    expect(answer.result.isError).toBe(true)
    expect(answer.result.content[0].text).toBe('Codex review refused: reviews on Linux x86-64 machines have not been proven yet (probes PV1 and PV2, helper/probes/README.md). Nothing ran there or on this computer.')
    expect(read).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(prepareLaunch).not.toHaveBeenCalled()
  })

  it('is offered naming the machine, and runs the review there: no account of this computer is asked for', async () => {
    runningProof.value = { x86_64: { codex: '0.157.1', git: '2.47.1' }, aarch64: null }
    expect(sessions.registerRemoteReviewSession('rr-mcp-1', { did: MACHINE.did, cwd: '/home/nick/proj' }, MACHINE.home)).toBe(true)
    const link = stream('rr-mcp-1')
    const tool = (await link.tools()).find((t) => t.name === 'codex_review')
    expect(tool, 'codex_review is listed').toBeDefined()
    expect(tool!.description).toContain('Rocky (nick@rocky.lan:22)')
    const answer = await link.call(3, 'tools/call', { name: 'codex_review', arguments: { mode: 'working' } })
    const text = answer.result.content[0].text as string
    expect(answer.result.isError).toBeFalsy()
    expect(text).toContain('Reviewed on the machine.')
    expect(text).toContain("Codex review on Rocky (nick@rocky.lan:22), with Rocky (nick@rocky.lan:22)'s own Codex sign-in")
    expect(read).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(1)
    expect(prepareLaunch).not.toHaveBeenCalled()
  })

  it('is not offered while the machine\'s record names no Codex', async () => {
    sessions.registerRemoteReviewSession('rr-mcp-2', { did: MACHINE.did, cwd: '/home/nick/proj' }, MACHINE.home)
    const noCodex = { ...MACHINE }
    delete (noCodex as Partial<RemoteMachineRecord>).codex
    machine.value = noCodex
    const link = stream('rr-mcp-2')
    expect((await link.tools()).map((t) => t.name)).not.toContain('codex_review')
  })

  it('a tab that was never registered (its folder there was its home folder) is refused, and nothing runs anywhere', async () => {
    expect(sessions.registerRemoteReviewSession('rr-mcp-3', { did: MACHINE.did, cwd: '/home/nick' }, MACHINE.home)).toBe(false)
    const link = stream('rr-mcp-3')
    const answer = await link.call(3, 'tools/call', { name: 'codex_review', arguments: { mode: 'working' } })
    expect(answer.result.isError).toBe(true)
    expect(run).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    expect(prepareLaunch).not.toHaveBeenCalled()
  })

  it('goes with the session', async () => {
    sessions.registerRemoteReviewSession('rr-mcp-4', { did: MACHINE.did, cwd: '/home/nick/proj' }, MACHINE.home)
    server.unregisterCodexReviewSession('rr-mcp-4')
    expect(sessions.remoteReviewTarget('rr-mcp-4')).toBeNull()
  })
})
