import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import { HooksGateway } from '../../../src/main/hooks/hooks-gateway'

// The gateway answers every hook request at once with an empty {} (no
// decision). Its permission hold, dormant since v1.5.17 (nothing set its flag
// and nothing answered a held request), was deleted in 2.1.3-beta.14
// (aicc_planning#358), and its tests with it: the permission wire value, the
// defer outcome, the hold while the flag was on, and the requestId it added.

function post(port: number, sid: string, token: string, body: object): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(
      { host: '127.0.0.1', port, path: `/hook/${sid}`, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-ccc-hook-token': token } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b })) },
    )
    req.on('error', reject)
    req.end(data)
  })
}

describe('pre-buffer auth', () => {
  let gw: HooksGateway
  afterEach(async () => { await gw?.stop() })

  // The token rides in a header, so auth is verified BEFORE the body is buffered:
  // a wrong token returns 404 and the (large) body is never ingested.
  it('rejects a wrong token with 404 and never ingests the body', async () => {
    gw = new HooksGateway({ emit: () => {}, defaultPort: 0 })
    const { port } = await gw.start()
    gw.registerSession('auth1')
    const big = { session_id: 'auth1', hook_event_name: 'PostToolUse', tool_name: 'Read', filler: 'x'.repeat(100_000) }
    const res = await post(port!, 'auth1', 'WRONG-TOKEN', big)
    expect(res.status).toBe(404)
    expect(gw.getBuffer('auth1')).toHaveLength(0)   // body never reached ingest
  })

  it('rejects an unknown session id with 404 before buffering', async () => {
    gw = new HooksGateway({ emit: () => {}, defaultPort: 0 })
    const { port } = await gw.start()
    const res = await post(port!, 'never-registered', 'any', { hook_event_name: 'PostToolUse', tool_name: 'Read' })
    expect(res.status).toBe(404)
  })
})

describe('every request answered at once', () => {
  let gw: HooksGateway
  afterEach(async () => { await gw?.stop() })

  it('a non-Bash PreToolUse is fire-and-forget (returns promptly)', async () => {
    gw = new HooksGateway({ emit: () => {}, defaultPort: 0 })
    const { port } = await gw.start()
    const secret = gw.registerSession('s2')
    const res = await post(port!, 's2', secret, { event: 'PreToolUse', tool_name: 'Edit', payload: { requestId: 'e1' } })
    expect(res.status).toBe(200)
    expect(res.body).toBe('{}')
  })

  // Regression lock for the v1.5.16 flood: Bash PreToolUse used to be held open
  // UNCONDITIONALLY (the old `isPreToolUseBash` path). Bash must be
  // fire-and-forget too -- otherwise CCC is back to being the gate and the
  // flood/stall returns. If someone re-adds a Bash hold, this test fails (the
  // post would hang).
  it('a Bash PreToolUse is ALSO fire-and-forget (no hold)', async () => {
    gw = new HooksGateway({ emit: () => {}, defaultPort: 0 })
    const { port } = await gw.start()
    const secret = gw.registerSession('s2b')
    const res = await post(port!, 's2b', secret, { event: 'PreToolUse', tool_name: 'Bash', payload: { requestId: 'b1', tool_input: { command: 'git status' } } })
    expect(res.status).toBe(200)
    expect(res.body).toBe('{}')
    expect(gw.getBuffer('s2b')).toHaveLength(1)   // ingested, and answered at once
  })

  // Claude Code's real hook POST uses `hook_event_name` (not `event`) and
  // snake_case fields. Before this was handled, ingest dropped EVERY live hook
  // -> the events feed + tray were silently dead. Lock the real shape here since
  // the real-Claude integration test is opt-in and skipped in CI.
  it('ingests Claude real-shape payloads (hook_event_name + tool_name)', async () => {
    gw = new HooksGateway({ emit: () => {}, defaultPort: 0 })
    const { port } = await gw.start()
    const secret = gw.registerSession('s5')
    const res = await post(port!, 's5', secret, {
      session_id: 's5', hook_event_name: 'PostToolUse', tool_name: 'Read',
      tool_input: { file_path: 'F:/x/package.json' }, tool_use_id: 'toolu_abc',
    })
    expect(res.status).toBe(200)   // PostToolUse is fire-and-forget
    const buf = gw.getBuffer('s5')
    expect(buf).toHaveLength(1)
    expect(buf[0].event).toBe('PostToolUse')
    expect(buf[0].toolName).toBe('Read')
  })
})

// Logs v2 (Task 8): the gateway is the earliest + exact transcript discovery
// source. Claude Code's real hook POSTs carry `transcript_path` on every event
// (incl. SessionStart). The gateway lifts it BEFORE redaction and forwards it via
// an injectable onTranscriptPath callback so the binder can tail the file.
describe('hooks gateway transcript discovery', () => {
  let gw: HooksGateway
  afterEach(async () => { await gw?.stop() })

  it('fires onTranscriptPath with the session id + transcript_path on a real-shape POST', async () => {
    const calls: Array<{ sid: string; path: string }> = []
    gw = new HooksGateway({
      emit: () => {},
      defaultPort: 0,
      onTranscriptPath: (sid, path) => calls.push({ sid, path }),
    })
    const { port } = await gw.start()
    const secret = gw.registerSession('t1')
    const res = await post(port!, 't1', secret, {
      session_id: 't1', hook_event_name: 'SessionStart',
      transcript_path: 'C:/Users/me/.claude/projects/F--proj/abc-uuid.jsonl',
    })
    expect(res.status).toBe(200)
    expect(calls).toEqual([{ sid: 't1', path: 'C:/Users/me/.claude/projects/F--proj/abc-uuid.jsonl' }])
  })

  it('lifts the RAW transcript_path before redaction while still redacting other secrets', async () => {
    const calls: Array<{ sid: string; path: string }> = []
    let emitted: { payload?: Record<string, unknown> } = {}
    gw = new HooksGateway({
      emit: (_ch, payload) => { emitted = { payload: (payload as { payload?: Record<string, unknown> }).payload } },
      defaultPort: 0,
      onTranscriptPath: (sid, path) => calls.push({ sid, path }),
    })
    const { port } = await gw.start()
    const secret = gw.registerSession('t2')
    const res = await post(port!, 't2', secret, {
      session_id: 't2', hook_event_name: 'PreToolUse', tool_name: 'Bash',
      transcript_path: 'C:/Users/me/.claude/projects/F--proj/xyz.jsonl',
      tool_input: { command: 'curl -H "api_key: sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' },
    })
    expect(res.status).toBe(200)
    // The path is forwarded raw (un-redacted, un-mutated).
    expect(calls).toEqual([{ sid: 't2', path: 'C:/Users/me/.claude/projects/F--proj/xyz.jsonl' }])
    // The stored/emitted payload still has secrets scrubbed (redaction untouched).
    const cmd = (emitted.payload?.tool_input as { command?: string } | undefined)?.command ?? ''
    expect(cmd).toContain('[REDACTED]')
    expect(cmd).not.toContain('sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  })

  it('does not fire onTranscriptPath when transcript_path is absent', async () => {
    const calls: Array<{ sid: string; path: string }> = []
    gw = new HooksGateway({
      emit: () => {},
      defaultPort: 0,
      onTranscriptPath: (sid, path) => calls.push({ sid, path }),
    })
    const { port } = await gw.start()
    const secret = gw.registerSession('t3')
    await post(port!, 't3', secret, { session_id: 't3', hook_event_name: 'PostToolUse', tool_name: 'Read' })
    expect(calls).toHaveLength(0)
  })

  it('does not fire onTranscriptPath when transcript_path is a non-string', async () => {
    const calls: Array<{ sid: string; path: string }> = []
    gw = new HooksGateway({
      emit: () => {},
      defaultPort: 0,
      onTranscriptPath: (sid, path) => calls.push({ sid, path }),
    })
    const { port } = await gw.start()
    const secret = gw.registerSession('t4')
    await post(port!, 't4', secret, { session_id: 't4', hook_event_name: 'PostToolUse', transcript_path: 123 })
    expect(calls).toHaveLength(0)
  })
})
