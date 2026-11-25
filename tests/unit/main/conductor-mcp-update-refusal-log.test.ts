/// <reference types="vite/client" />
// vm:B1f (2.1.3-beta.17): at an app update the kill of every PTY releases each
// session's record, and a Claude Code CLI the update keeps running goes on
// posting its status line to the old app until it exits. That POST /status is
// refused as before (403), and is logged at info, not as a warning. Every
// other refusal of a session holding no record is still a warning: a session
// never issued, another route of a session the update handed over, and a
// session issued again after the hand-over. The real server on a loopback
// port, driven over raw HTTP; the log lines are captured from debug-logger.
import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest'
import * as http from 'http'

const SECRET = 'b1'.repeat(32)
const h = vi.hoisted(() => ({ warn: [] as string[], info: [] as string[] }))

vi.mock('../../../src/main/debug-logger', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/debug-logger')>()
  return {
    ...real,
    logInfo: (...a: unknown[]) => { h.info.push(a.map(String).join(' ')) },
    logWarn: (...a: unknown[]) => { h.warn.push(a.map(String).join(' ')) },
  }
})
vi.mock('../../../src/main/install-secret', () => ({ getInstallSecret: () => SECRET }))
vi.mock('../../../src/main/vision-manager', () => ({
  startGlobalVision: vi.fn(), stopGlobalVision: vi.fn(), isGlobalVisionRunning: vi.fn(() => false),
  getGlobalVisionConfig: vi.fn(), cleanupLegacyVisionMarkers: vi.fn(), getGlobalManager: vi.fn(() => null), launchBrowser: vi.fn(),
}))
vi.mock('../../../src/main/config-manager', () => ({
  readConfig: vi.fn(() => null),
  readConfigChecked: vi.fn(() => ({ value: {}, outcome: 'ok' })),
  saveConfig: vi.fn(),
}))
vi.mock('../../../src/main/provider-accounts', () => ({ getAccountsService: () => ({ reviewReady: () => false }) }))
vi.mock('../../../src/main/update-watcher', () => ({ isPackagedApp: () => false, getProjectRootPath: vi.fn(() => ''), hasSourcePath: vi.fn(() => false) }))
vi.mock('../../../src/main/statusline-watcher', () => ({ dispatchSSHStatuslineUpdate: vi.fn() }))
vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-update-refusal-log-'))
  return { getResourcesDirectory: () => dir }
})

type ServerModule = typeof import('../../../src/main/conductor-mcp-server')
let server: ServerModule
let port = 0

/** A fresh run of the app's server: a new load of the module, so no session
 *  is noted or logged from an earlier case. */
beforeEach(async () => {
  server?.stopMcpServer()
  vi.resetModules()
  server = await import('../../../src/main/conductor-mcp-server')
  // Its own range, below 32768 where Linux's outgoing ports start: no other MCP test or outgoing socket takes it.
  port = 28000 + Math.floor(Math.random() * 1000)
  await server.startMcpServer(port, () => null)
  h.warn.length = 0
  h.info.length = 0
})
afterAll(() => { server?.stopMcpServer() })

const q = (sid: string, token: string) => `cccSessionId=${encodeURIComponent(sid)}&token=${token}`

async function statusPost(sid: string, token: string): Promise<number> {
  const r = await fetch(`http://127.0.0.1:${port}/status?${q(sid, token)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"model":{"display_name":"test"}}' })
  await r.text()
  return r.status
}

function sseStatus(sid: string, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/sse?${q(sid, token)}`, (res) => { resolve(res.statusCode ?? 0); res.destroy() })
    req.on('error', reject)
  })
}

const refusedLines = (lines: string[], sid: string) => lines.filter((l) => l.includes('Refused') && l.includes(`sid=${sid})`))

describe('a status post refused after an app update handed its session over (vm:B1f)', () => {
  it('is refused as before and logged at info, once, never as a warning', async () => {
    const token = server.issueMcpSessionToken('upd-kept', 'claude')
    expect(await statusPost('upd-kept', token)).toBe(204)
    server.noteUpdateHandOver()
    // The update's kill (pty-manager.ts killAllPty -> cleanupSessionResources).
    server.releaseMcpSessionProvider('upd-kept')
    expect(await statusPost('upd-kept', token)).toBe(403)
    expect(await statusPost('upd-kept', token)).toBe(403)
    expect(refusedLines(h.warn, 'upd-kept')).toEqual([])
    expect(refusedLines(h.info, 'upd-kept')).toEqual([
      '[vision-mcp] Refused POST /status (sid=upd-kept): no credential is issued to this session now (released at the app update\'s hand-over)',
    ])
  })

  it('a session never issued in this run is still a warning, also after the hand-over is noted', async () => {
    server.issueMcpSessionToken('upd-other', 'claude')
    server.noteUpdateHandOver()
    const unissued = server.mcpSessionToken('upd-never')
    expect(await statusPost('upd-never', unissued)).toBe(403)
    expect(refusedLines(h.info, 'upd-never')).toEqual([])
    expect(refusedLines(h.warn, 'upd-never')).toEqual([
      '[vision-mcp] Refused POST /status (sid=upd-never): no credential is issued to this session now',
    ])
  })

  it('another route of a session the update handed over is still a warning', async () => {
    const token = server.issueMcpSessionToken('upd-sse', 'claude')
    server.noteUpdateHandOver()
    server.releaseMcpSessionProvider('upd-sse')
    expect(await sseStatus('upd-sse', token)).toBe(403)
    expect(refusedLines(h.info, 'upd-sse')).toEqual([])
    expect(refusedLines(h.warn, 'upd-sse')).toEqual([
      '[vision-mcp] Refused GET /sse (sid=upd-sse): no credential is issued to this session now',
    ])
  })

  it('a session issued again after the hand-over (the update did not start) is a warning once it ends', async () => {
    server.issueMcpSessionToken('upd-again', 'claude')
    server.noteUpdateHandOver()
    server.releaseMcpSessionProvider('upd-again')
    const token = server.issueMcpSessionToken('upd-again', 'claude')
    server.releaseMcpSessionProvider('upd-again')
    expect(await statusPost('upd-again', token)).toBe(403)
    expect(refusedLines(h.info, 'upd-again')).toEqual([])
    expect(refusedLines(h.warn, 'upd-again')).toHaveLength(1)
  })
})
