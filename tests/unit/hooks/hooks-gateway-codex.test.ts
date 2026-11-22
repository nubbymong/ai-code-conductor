// P3.10 (row 63): the Hooks gateway takes a Codex session's hook events the way
// it takes Claude Code's: loopback only, the session's token, the same caps,
// and an answer at once. Until 2.1.3-beta.14 the forwarder marked its requests
// so that the gateway's permission hold left them alone (Codex runs the app's
// hooks asynchronously and reads no answer); that hold was dormant for Claude
// Code too, and it was deleted with the marker (aicc_planning#358). So a
// PermissionRequest, Codex's or one in Claude Code's shape, is answered at
// once and ingested, and a request that still carries the old marker (a
// forwarder copy from an earlier version) is taken the same way.
import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import { HooksGateway } from '../../../src/main/hooks/hooks-gateway'
import type { HookEvent } from '../../../src/shared/hook-types'

/** How long a request may take to be answered before it counts as held. */
const HELD_AFTER_MS = 1500

/** Post one hook request. One the gateway has not answered within
 *  HELD_AFTER_MS is given up (its socket closed) and reads as status -1. */
function post(port: number, sid: string, token: string, body: object, extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: string; ms: number }> {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(
      { host: '127.0.0.1', port, path: `/hook/${sid}`, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-ccc-hook-token': token, ...extraHeaders } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { clearTimeout(held); resolve({ status: res.statusCode ?? 0, body: b, ms: Date.now() - t0 }) }) },
    )
    const held = setTimeout(() => { req.destroy(); resolve({ status: -1, body: '', ms: Date.now() - t0 }) }, HELD_AFTER_MS)
    req.on('error', (err) => { clearTimeout(held); reject(err) })
    req.end(data)
  })
}

/** The header the forwarder sent before 2.1.3-beta.14. */
const OLD_MARKER = { 'x-ccc-hook-client': 'codex' }
const codexPermission = {
  session_id: '01a0ef12-02ef-7fd2-93be-e5cbe9eaa3e6', hook_event_name: 'PermissionRequest', model: 'gpt-6-astra',
  permission_mode: 'default', turn_id: 't1', tool_name: 'shell', tool_input: { command: 'npm test' }, tool_use_id: 'call_1',
}

describe('HooksGateway: a Codex session\'s events', () => {
  let gw: HooksGateway
  afterEach(async () => { await gw?.stop() })

  it('a Codex PermissionRequest, sent with no marker as the forwarder sends it now, is answered at once and ingested for its subscribers', async () => {
    gw = new HooksGateway({ emit: () => {}, defaultPort: 0 })
    const seen: HookEvent[] = []
    gw.subscribe((e) => seen.push(e))
    const { port } = await gw.start()
    const secret = gw.registerSession('codex-1')
    const res = await post(port!, 'codex-1', secret, codexPermission)
    expect(res.status).toBe(200)
    expect(res.body).toBe('{}')
    expect(seen.map((e) => e.event)).toEqual(['PermissionRequest'])
    expect(seen[0].sessionId).toBe('codex-1')
  })

  it('a PermissionRequest in Claude Code\'s shape is answered at once too, and its payload is ingested as sent: the gateway holds no request open', async () => {
    gw = new HooksGateway({ emit: () => {}, defaultPort: 0 })
    const { port } = await gw.start()
    const secret = gw.registerSession('claude-1')
    const spec = await post(port!, 'claude-1', secret, { event: 'PermissionRequest', sessionId: 'claude-1', tool_name: 'Bash', payload: { tool_input: { command: 'rm -rf build' } } })
    expect(spec.status).toBe(200)
    expect(spec.body).toBe('{}')
    const real = await post(port!, 'claude-1', secret, { session_id: 'claude-1', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })
    expect(real.status).toBe(200)
    expect(real.body).toBe('{}')
    const buf = gw.getBuffer('claude-1')
    expect(buf.map((e) => e.event)).toEqual(['PermissionRequest', 'PermissionRequest'])
    // No request id is made up and added to what was sent.
    for (const e of buf) expect((e.payload as { requestId?: unknown }).requestId).toBeUndefined()
  })

  it('a request that still carries the old marker is answered and ingested the same way', async () => {
    gw = new HooksGateway({ emit: () => {}, defaultPort: 0 })
    const seen: HookEvent[] = []
    gw.subscribe((e) => seen.push(e))
    const { port } = await gw.start()
    const secret = gw.registerSession('codex-4')
    const res = await post(port!, 'codex-4', secret, codexPermission, OLD_MARKER)
    expect(res.status).toBe(200)
    expect(res.body).toBe('{}')
    expect(seen.map((e) => e.event)).toEqual(['PermissionRequest'])
  })

  it('a wrong token is refused and nothing is ingested, marker or not', async () => {
    gw = new HooksGateway({ emit: () => {}, defaultPort: 0 })
    const seen: HookEvent[] = []
    gw.subscribe((e) => seen.push(e))
    const { port } = await gw.start()
    gw.registerSession('codex-2')
    for (const headers of [{}, OLD_MARKER]) {
      const res = await post(port!, 'codex-2', 'not-the-token-at-all-000000', codexPermission, headers)
      expect(res.status).toBe(404)
    }
    expect(seen).toEqual([])
  })

  it('a Codex event hands its transcript_path to the transcript sink before redaction, as Claude\'s do', async () => {
    const paths: Array<[string, string]> = []
    gw = new HooksGateway({ emit: () => {}, defaultPort: 0, onTranscriptPath: (sid, p) => paths.push([sid, p]) })
    const { port } = await gw.start()
    const secret = gw.registerSession('codex-3')
    const tp = 'C:\\Users\\User\\res\\codex-realms\\r1\\sessions\\2026\\09\\29\\rollout-2026-09-29T14-28-50-01a0ef12-02ef-7fd2-93be-e5cbe9eaa3e6.jsonl'
    await post(port!, 'codex-3', secret, { session_id: '01a0ef12-02ef-7fd2-93be-e5cbe9eaa3e6', hook_event_name: 'SessionStart', source: 'startup', transcript_path: tp, cwd: 'C:\\p' })
    expect(paths).toEqual([['codex-3', tp]])
  })
})
