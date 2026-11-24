// The tool host serves one session's tool calls over a tool stream through
// its holder (2.1.3-beta.11, plan section B1; conductor-mcp-server.ts
// serveToolStream), driven over a stand-in link the way the session helper's
// manager hands one over. No port: node's http.createServer is a stand-in for
// this file, so the server starts and stops but nothing listens.
//  - `initialize` and `tools/list` answer the tool set of the session's
//    record, the names its route gives it today, for a Claude Code record and
//    a Codex record;
//  - a session with no record is refused, and its link closed;
//  - a call whose arguments name another session acts as it does on the
//    routes today: for the stream's session only;
//  - releasing the session's record closes the link, and nothing more is
//    answered on it;
//  - with the server stopped (or a stream open when it stops) the stream is
//    refused (closed);
//  - a batch is taken as on the /mcp route, one over that route's 100
//    refused whole, but each message of a batch is read on its own (that
//    route refuses a whole body with one bad message): one that is not a
//    JSON-RPC message is answered Invalid Request when it has an id (an
//    answer never is), dropped otherwise;
//  - 2.1.3-beta.12, plan section B2 (the decision line): a stream its holder
//    gives back after an attach again starts with a call, not `initialize`
//    (the relay passed the CLI's handshake on the stream that went). A fresh
//    stream whose first message is a tool list, or a tool call, is answered
//    for the stream's session with no handshake, so serveToolStream is not
//    changed for it. If a bump of the MCP library starts to ask for the
//    handshake first, these cases go red before any held session's tools stop.
// Not checked here: what each tool does once called (the route tests own
// that); a holder or a relay (the session helper's tests own those).

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const standIn = vi.hoisted(() => ({ listens: 0 }))
vi.mock('http', async (importOriginal) => {
  const real = await importOriginal<typeof import('http')>()
  // A listener that never listens: listen answers at once, and nothing else happens.
  const createServer = () => ({
    listen: (_port: number, _host: string, done: () => void) => { standIn.listens++; done() },
    on: () => {},
    close: () => {},
    requestTimeout: 0,
  })
  return { ...real, default: { ...real, createServer }, createServer }
})

vi.mock('../../../src/main/vision-manager', () => ({
  startGlobalVision: vi.fn(),
  stopGlobalVision: vi.fn(),
  isGlobalVisionRunning: vi.fn(() => false),
  getGlobalVisionConfig: vi.fn(),
  cleanupLegacyVisionMarkers: vi.fn(),
  getGlobalManager: vi.fn(() => null),
  launchBrowser: vi.fn(),
}))

// Codex is set up and both reviews can run, so each record is offered its
// provider's own review tool: what tells the two tool sets apart.
vi.mock('../../../src/main/config-manager', () => ({
  readConfig: vi.fn(() => ({ codexEnabled: true, codexAnswered: true })),
  readConfigChecked: vi.fn(() => ({ value: { codexEnabled: true, codexAnswered: true }, outcome: 'ok' })),
  saveConfig: vi.fn(),
}))

vi.mock('../../../src/main/provider-accounts', () => ({
  getAccountsService: () => ({ reviewReady: () => true }),
}))

vi.mock('../../../src/main/update-watcher', () => ({
  isPackagedApp: () => false,
  getProjectRootPath: vi.fn(() => ''),
  hasSourcePath: vi.fn(() => false),
}))

/** The resources folder the server is given: made in the temp folder, removed after the file. */
const tmp = vi.hoisted(() => ({ dir: '' }))
vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  tmp.dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-tool-stream-'))
  return { getResourcesDirectory: () => tmp.dir }
})
afterAll(() => {
  if (path.basename(tmp.dir).startsWith('ccc-tool-stream-')) fs.rmSync(tmp.dir, { recursive: true, force: true })
})

const pushed = vi.hoisted(() => vi.fn((_win: unknown, _sessionId: string, _url: string) => true))
vi.mock('../../../src/main/webview-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/webview-manager')>()),
  pushAgentUrlToWebview: pushed,
}))

const server = await import('../../../src/main/conductor-mcp-server')
const { CODEX_CONDUCTOR_TOOLS, CANVAS_TOOL_NAMES, VISION_TOOL_NAMES } = await import('../../../src/main/providers/codex/conductor-tools')

type Json = Record<string, any>

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await tick(5)
  }
}

/** A tool stream as the manager hands one over: what the tool host sends is
 *  kept, and the test plays the CLI at the far end. */
class FakeLink {
  readonly sent: Json[] = []
  closed = false
  takes = 0
  private onMessage: ((m: unknown) => void) | null = null
  private onClose: (() => void) | null = null
  send(m: Json): void { if (!this.closed) this.sent.push(m) }
  take(onMessage: (m: unknown) => void, onClose: () => void): void {
    this.takes++
    this.onMessage = onMessage
    this.onClose = onClose
  }
  close(): void { this.closed = true }
  /** The CLI sends one message. */
  fromCli(m: unknown): void { if (!this.closed) this.onMessage?.(m) }
  /** The stream ends from the far side (the relay went, or the holder's connection). */
  endFromFarSide(): void { this.closed = true; this.onClose?.() }
  /** One request from the CLI, and the answer the tool host sends it. */
  async call(id: number, method: string, params: Json = {}): Promise<Json> {
    this.fromCli({ jsonrpc: '2.0', id, method, params })
    await until(() => this.sent.some((m) => m.id === id), `the answer to ${method}`)
    return this.sent.find((m) => m.id === id)!
  }
  async initialized(): Promise<Json> {
    const answer = await this.call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tool-stream-test', version: '0.0.0' } })
    this.fromCli({ jsonrpc: '2.0', method: 'notifications/initialized' })
    return answer
  }
  async toolNames(): Promise<string[]> {
    const answer = await this.call(2, 'tools/list')
    return (answer.result.tools as Array<{ name: string }>).map((t) => t.name).sort()
  }
}

/** What a session of each provider is offered on its route today (the SSE
 *  route for Claude Code, /mcp for Codex): every tool on, each offered the
 *  other provider's review (conductor-mcp-provider-binding.test.ts holds the
 *  Codex list to what that route lists). */
const CODEX_NAMES = CODEX_CONDUCTOR_TOOLS.map((t) => t.name).sort()
const CLAUDE_NAMES = ['fetch_host_screenshot', 'codex_review', 'open_in_app_browser', ...CANVAS_TOOL_NAMES, ...VISION_TOOL_NAMES].sort()

/** The browser the vision tools reach: it says which session each command was for. */
const vision = {
  executeCommand: vi.fn(async (cmd: { command: string; args: string[]; sessionId?: string }) => ({ ok: true, data: { for: cmd.sessionId ?? null } })),
  isConnected: () => true,
  getBrowser: () => 'chrome',
  getDebugPort: () => 0,
}
const links: FakeLink[] = []
const newLink = () => { const l = new FakeLink(); links.push(l); return l }

beforeEach(async () => {
  pushed.mockClear()
  vision.executeCommand.mockClear()
  // No port: the listener is the stand-in above, and it is what started.
  const before = standIn.listens
  await server.startMcpServer(0, () => vision as never, () => ({}) as never)
  expect(standIn.listens).toBe(before + 1)
})
afterEach(() => {
  server.stopMcpServer()
  for (const l of links.splice(0)) l.endFromFarSide()
})

describe('a tool stream answers the tool set of its session\'s record', () => {
  it('a Claude Code record: initialize, then the names its SSE route gives it', async () => {
    server.issueMcpSessionToken('ts-claude-1', 'claude')
    const link = newLink()
    expect(server.serveToolStream('ts-claude-1', link)).toBe(true)
    expect(link.takes).toBe(1)
    const init = await link.initialized()
    expect(init.result.serverInfo).toEqual({ name: 'conductor', version: '1.1.0' })
    expect(await link.toolNames()).toEqual(CLAUDE_NAMES)
    expect(link.closed).toBe(false)
  })

  it('a Codex record: the names its /mcp route gives it', async () => {
    server.issueMcpSessionToken('ts-codex-1', 'codex')
    const link = newLink()
    expect(server.serveToolStream('ts-codex-1', link)).toBe(true)
    await link.initialized()
    expect(await link.toolNames()).toEqual(CODEX_NAMES)
  })

  it('a Codex record kept for its launch: a later Claude issue for the same id still gets the Codex set', async () => {
    server.issueMcpSessionToken('ts-codex-2', 'codex')
    server.issueMcpSessionToken('ts-codex-2', 'claude')
    const link = newLink()
    expect(server.serveToolStream('ts-codex-2', link)).toBe(true)
    await link.initialized()
    expect(await link.toolNames()).toEqual(CODEX_NAMES)
  })
})

describe('a stream is refused, and its link closed, when there is nothing to serve', () => {
  it('a session with no record (never issued, or released) is refused and its link closed', async () => {
    for (const sid of ['ts-never', 'ts-released']) {
      if (sid === 'ts-released') {
        server.issueMcpSessionToken(sid, 'claude')
        server.releaseMcpSessionProvider(sid)
      }
      const link = newLink()
      expect(server.serveToolStream(sid, link), sid).toBe(false)
      expect(link.closed, sid).toBe(true)
      link.fromCli({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      await tick(30)
      expect(link.sent, sid).toEqual([])
    }
  })

  it('with the server stopped the stream is refused; one open when it stops is closed', async () => {
    server.issueMcpSessionToken('ts-stop', 'claude')
    const open = newLink()
    expect(server.serveToolStream('ts-stop', open)).toBe(true)
    await open.initialized()
    server.stopMcpServer()
    expect(open.closed).toBe(true)
    const later = newLink()
    expect(server.serveToolStream('ts-stop', later)).toBe(false)
    expect(later.closed).toBe(true)
  })
})

describe('the stream acts for its own session only', () => {
  it('a call whose arguments name another session is refused, as on the routes; one that names none acts for the stream\'s session', async () => {
    server.issueMcpSessionToken('ts-own', 'claude')
    server.issueMcpSessionToken('ts-other', 'claude')
    const link = newLink()
    expect(server.serveToolStream('ts-own', link)).toBe(true)
    await link.initialized()
    const refused = await link.call(3, 'tools/call', { name: 'open_in_app_browser', arguments: { url: 'https://example.com/', sessionId: 'ts-other' } })
    expect(refused.result.isError).toBe(true)
    expect(JSON.parse(refused.result.content[0].text)).toEqual({ ok: false, error: 'sessionId does not match this session; the in-app browser push acts only on the authenticated session.' })
    expect(pushed).not.toHaveBeenCalled()
    const own = await link.call(4, 'tools/call', { name: 'open_in_app_browser', arguments: { url: 'https://example.com/' } })
    expect(own.result.isError).toBeFalsy()
    expect(pushed.mock.calls.map(([, sid, url]) => [sid, url])).toEqual([['ts-own', 'https://example.com/']])
    // A vision call is for the stream's session's own browser target.
    const nav = await link.call(5, 'tools/call', { name: 'vision_navigate', arguments: { url: 'https://example.com/' } })
    expect(JSON.parse(nav.result.content[0].text)).toEqual({ ok: true, data: { for: 'ts-own' } })
    expect(vision.executeCommand.mock.calls.map(([cmd]) => cmd.sessionId)).toEqual(['ts-own'])
  })

  it('two sessions\' streams at once: each is answered for its own session, on its own link', async () => {
    server.issueMcpSessionToken('ts-a', 'claude')
    server.issueMcpSessionToken('ts-b', 'codex')
    const a = newLink()
    const b = newLink()
    expect(server.serveToolStream('ts-a', a)).toBe(true)
    expect(server.serveToolStream('ts-b', b)).toBe(true)
    await a.initialized()
    await b.initialized()
    await b.call(6, 'tools/call', { name: 'vision_status', arguments: {} })
    await a.call(6, 'tools/call', { name: 'vision_status', arguments: {} })
    expect(vision.executeCommand.mock.calls.map(([cmd]) => cmd.sessionId)).toEqual(['ts-b', 'ts-a'])
    expect(a.sent.filter((m) => m.id === 6)).toHaveLength(1)
    expect(b.sent.filter((m) => m.id === 6)).toHaveLength(1)
  })
})

describe('a stream ends with its session', () => {
  it('releasing the session\'s record closes its link, and nothing more is answered on it; another session\'s stream goes on', async () => {
    server.issueMcpSessionToken('ts-end', 'claude')
    server.issueMcpSessionToken('ts-stays', 'claude')
    const ending = newLink()
    const staying = newLink()
    expect(server.serveToolStream('ts-end', ending)).toBe(true)
    expect(server.serveToolStream('ts-stays', staying)).toBe(true)
    await ending.initialized()
    await staying.initialized()
    server.releaseMcpSessionProvider('ts-end')
    expect(ending.closed).toBe(true)
    expect(staying.closed).toBe(false)
    const before = ending.sent.length
    ending.closed = false // a link that would still carry a message, were the stream open
    ending.fromCli({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} })
    await tick(30)
    expect(ending.sent).toHaveLength(before)
    expect(await staying.toolNames()).toEqual(CLAUDE_NAMES)
  })

  it('the next launch under the same id gets a stream of its own; the earlier one stays closed', async () => {
    server.issueMcpSessionToken('ts-relaunch', 'codex')
    const first = newLink()
    expect(server.serveToolStream('ts-relaunch', first)).toBe(true)
    await first.initialized()
    server.releaseMcpSessionProvider('ts-relaunch')
    server.issueMcpSessionToken('ts-relaunch', 'claude')
    expect(first.closed).toBe(true)
    const next = newLink()
    expect(server.serveToolStream('ts-relaunch', next)).toBe(true)
    await next.initialized()
    expect(await next.toolNames()).toEqual(CLAUDE_NAMES)
  })

  it('the far side ending the stream ends it here too: a later message is not answered', async () => {
    server.issueMcpSessionToken('ts-far', 'claude')
    const link = newLink()
    expect(server.serveToolStream('ts-far', link)).toBe(true)
    await link.initialized()
    link.endFromFarSide()
    link.closed = false
    const before = link.sent.length
    link.fromCli({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} })
    await tick(30)
    expect(link.sent).toHaveLength(before)
  })
})

describe('a stream given back after an attach again: its first message is a call, with no initialize (2.1.3-beta.12, plan section B2)', () => {
  /** Only answers went to the CLI: no message the tool host started itself. */
  const onlyAnswers = (link: FakeLink, ids: number[]) => expect(link.sent.map((m) => m.id)).toEqual(ids)

  it('a tool list first: the tool set of the session\'s record, for a Claude Code record and a Codex record', async () => {
    server.issueMcpSessionToken('ts-back-claude', 'claude')
    server.issueMcpSessionToken('ts-back-codex', 'codex')
    const claude = newLink()
    const codex = newLink()
    expect(server.serveToolStream('ts-back-claude', claude)).toBe(true)
    expect(server.serveToolStream('ts-back-codex', codex)).toBe(true)
    expect(await claude.toolNames()).toEqual(CLAUDE_NAMES)
    expect(await codex.toolNames()).toEqual(CODEX_NAMES)
    onlyAnswers(claude, [2])
    onlyAnswers(codex, [2])
    expect(claude.closed).toBe(false)
    expect(codex.closed).toBe(false)
  })

  it('a tool call first: it acts for the stream\'s session; one whose arguments name another session is refused, as on the routes', async () => {
    server.issueMcpSessionToken('ts-back-own', 'claude')
    server.issueMcpSessionToken('ts-back-other', 'claude')
    const link = newLink()
    expect(server.serveToolStream('ts-back-own', link)).toBe(true)
    const nav = await link.call(7, 'tools/call', { name: 'vision_navigate', arguments: { url: 'https://example.com/' } })
    expect(JSON.parse(nav.result.content[0].text)).toEqual({ ok: true, data: { for: 'ts-back-own' } })
    expect(vision.executeCommand.mock.calls.map(([cmd]) => cmd.sessionId)).toEqual(['ts-back-own'])
    // Another stream, given back, whose first call claims the other session.
    const claims = newLink()
    expect(server.serveToolStream('ts-back-own', claims)).toBe(true)
    const refused = await claims.call(8, 'tools/call', { name: 'open_in_app_browser', arguments: { url: 'https://example.com/', sessionId: 'ts-back-other' } })
    expect(refused.result.isError).toBe(true)
    expect(JSON.parse(refused.result.content[0].text)).toEqual({ ok: false, error: 'sessionId does not match this session; the in-app browser push acts only on the authenticated session.' })
    expect(pushed).not.toHaveBeenCalled()
    onlyAnswers(link, [7])
    onlyAnswers(claims, [8])
  })
})

describe('a stream reads a message as the /mcp route reads a body', () => {
  const invalid = (id: number, message = 'Invalid Request') => ({ jsonrpc: '2.0', id, error: { code: -32600, message } })
  const ping = (id: number) => ({ jsonrpc: '2.0', id, method: 'ping' })
  const answered = (link: FakeLink, ids: number[]) => ids.every((id) => link.sent.some((m) => m.id === id))

  it('a batch on a Codex stream: each call in it is answered', async () => {
    server.issueMcpSessionToken('ts-batch', 'codex')
    const link = newLink()
    expect(server.serveToolStream('ts-batch', link)).toBe(true)
    await link.initialized()
    link.fromCli([{ jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} }, ping(11)])
    await until(() => answered(link, [10, 11]), 'the answers to the batch')
    expect((link.sent.find((m) => m.id === 10)!.result.tools as Array<{ name: string }>).map((t) => t.name).sort()).toEqual(CODEX_NAMES)
    expect(link.sent.find((m) => m.id === 11)).toEqual({ jsonrpc: '2.0', id: 11, result: {} })
    expect(link.closed).toBe(false)
  })

  it('one that is not a JSON-RPC message is answered Invalid Request when it has an id, and dropped otherwise; an answer is never answered', async () => {
    server.issueMcpSessionToken('ts-invalid', 'codex')
    const link = newLink()
    expect(server.serveToolStream('ts-invalid', link)).toBe(true)
    await link.initialized()
    const before = link.sent.length
    link.fromCli({ id: 12, method: 'tools/list' }) // no jsonrpc
    link.fromCli({ method: 'tools/list' }) // no id either: dropped
    link.fromCli({ jsonrpc: '2.0', id: 13, result: 5 }) // a malformed answer: answering it could answer the CLI's own call 13
    link.fromCli([ping(14), { id: 15, method: 'ping' }]) // in a batch, each on its own
    await until(() => answered(link, [12, 14, 15]), 'the answers')
    await tick(30)
    expect(link.sent.find((m) => m.id === 12)).toEqual(invalid(12))
    expect(link.sent.find((m) => m.id === 14)).toEqual({ jsonrpc: '2.0', id: 14, result: {} })
    expect(link.sent.find((m) => m.id === 15)).toEqual(invalid(15))
    expect(link.sent).toHaveLength(before + 3)
    expect(link.closed).toBe(false)
  })

  it('a batch of 100 is taken; one of 101, which the /mcp route refuses, is refused whole: each call in it is answered Invalid Request', async () => {
    server.issueMcpSessionToken('ts-big-batch', 'claude')
    const link = newLink()
    expect(server.serveToolStream('ts-big-batch', link)).toBe(true)
    await link.initialized()
    const hundred = Array.from({ length: 100 }, (_, i) => ping(100 + i))
    link.fromCli(hundred)
    await until(() => answered(link, hundred.map((m) => m.id)), 'the answers to the batch of 100')
    expect(hundred.map((m) => link.sent.find((s) => s.id === m.id))).toEqual(hundred.map((m) => ({ jsonrpc: '2.0', id: m.id, result: {} })))
    const before = link.sent.length
    const over = Array.from({ length: 101 }, (_, i) => ping(300 + i))
    link.fromCli(over)
    await until(() => answered(link, over.map((m) => m.id)), 'the answers to the batch of 101')
    await tick(30)
    expect(link.sent.slice(before)).toEqual(over.map((m) => invalid(m.id, 'Invalid Request: Batch must not exceed 100 messages')))
    expect(link.closed).toBe(false)
  })
})

// 2.1.3-beta.17, plan section B1 (S16 steps 5 and 6, aicc_planning#412): a
// restored tab that takes over a session an update kept running makes the
// session's record with no credential (recordHeldToolSession), and a stream
// its holder gives back is served with `toolsChanged`: the CLI is told its
// tool list may have changed once the server is connected.
describe('a stream given back to a take-over (S16 steps 5 and 6)', () => {
  it('a record made with no credential: a stream is served the record\'s tool set, a tool list first with no handshake (as a stream given back starts)', async () => {
    server.recordHeldToolSession('ts-held-1', 'claude')
    expect(server.mcpSessionProvider('ts-held-1')).toBe('claude')
    const link = newLink()
    expect(server.serveToolStream('ts-held-1', link)).toBe(true)
    expect(await link.toolNames()).toEqual(CLAUDE_NAMES)
    // Released with the session, as a launch's record is.
    server.releaseMcpSessionProvider('ts-held-1')
    expect(link.closed).toBe(true)
    expect(server.mcpSessionProvider('ts-held-1')).toBeNull()
  })

  it('toolsChanged: the CLI is sent notifications/tools/list_changed once, then is answered as before', async () => {
    server.recordHeldToolSession('ts-held-2', 'claude')
    const link = newLink()
    expect(server.serveToolStream('ts-held-2', link, { toolsChanged: true })).toBe(true)
    await until(() => link.sent.length > 0, 'the notification')
    expect(link.sent).toEqual([{ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }])
    expect(await link.toolNames()).toEqual(CLAUDE_NAMES)
    expect(link.sent.filter((m) => m.method === 'notifications/tools/list_changed')).toHaveLength(1)
  })

  it('without toolsChanged nothing is sent before the CLI asks', async () => {
    server.recordHeldToolSession('ts-held-3', 'claude')
    const link = newLink()
    expect(server.serveToolStream('ts-held-3', link)).toBe(true)
    await tick(30)
    expect(link.sent).toEqual([])
  })

  it('a credential issued later in the same launch (its status line\'s address) keeps the record\'s launch: the stream served before goes on', async () => {
    server.recordHeldToolSession('ts-held-4', 'claude')
    const link = newLink()
    expect(server.serveToolStream('ts-held-4', link)).toBe(true)
    server.issueMcpSessionToken('ts-held-4', 'claude')
    expect(await link.toolNames()).toEqual(CLAUDE_NAMES)
    expect(link.closed).toBe(false)
  })
})
