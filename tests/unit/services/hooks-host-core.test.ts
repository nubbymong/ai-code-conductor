import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FakeChildTransport } from '../../../src/main/services/service-transport'
import type { FromChildMessage } from '../../../src/main/services/service-transport'
import { createHooksHost } from '../../../src/main/services/hooks-host-core'
import type { HooksGatewayHostFace } from '../../../src/main/services/hooks-host-core'

/** A no-op gateway whose start() resolves to a bind failure. Lets the bind-failed
 *  path be exercised DETERMINISTICALLY (a real bind failure is not reliable — the
 *  gateway tries the port plus random offsets). */
function stubGateway(start: HooksGatewayHostFace['start']): HooksGatewayHostFace {
  return {
    registerSessionWithSecret: () => {},
    unregisterSession: () => {},
    start,
    stop: async () => {},
    setPermissionGateActive: () => {},
    metrics: () => ({ inFlight: 0, eventsTotal: 0, dropsTotal: 0 }),
    hasSecret: () => false,
    _handleRequestForTest: async () => ({ status: 200, body: '' }),
    permissionRegister: () => {},
  }
}

describe('createHooksHost', () => {
  it('a register control message populates the gateway secret map', () => {
    const t = new FakeChildTransport()
    const host = createHooksHost(t.asHostTransport(), { healthBeat: false })
    t.post({ type: 'register', sid: 's1', secret: 'sekret' })
    expect(host._gatewayHasSecret('s1')).toBe(true)
  })

  it('posts a digested event to the parent on a real ingest', async () => {
    const t = new FakeChildTransport()
    const host = createHooksHost(t.asHostTransport(), { healthBeat: false })
    t.post({ type: 'register', sid: 's1', secret: 'sekret' })
    await host._ingestForTest('s1', 'sekret')
    expect(t.parentMessages.some((m) => m.type === 'event')).toBe(true)
  })

  it('posts a transcript-path message to the parent when a hook POST carries transcript_path (Logs v2 T8)', async () => {
    const t = new FakeChildTransport()
    const host = createHooksHost(t.asHostTransport(), { healthBeat: false })
    t.post({ type: 'register', sid: 's1', secret: 'sekret' })
    await host._ingestForTest('s1', 'sekret', {
      session_id: 's1', hook_event_name: 'SessionStart',
      transcript_path: 'C:/Users/me/.claude/projects/F--proj/conv.jsonl',
    })
    expect(t.parentMessages).toContainEqual({
      type: 'transcript-path', sid: 's1', path: 'C:/Users/me/.claude/projects/F--proj/conv.jsonl',
    })
  })

  it('routes a held-open permission registration to the parent (B2)', () => {
    const t = new FakeChildTransport()
    const host = createHooksHost(t.asHostTransport(), { healthBeat: false })
    host._registerResponderForTest('req-1', () => {})
    expect(t.parentMessages).toContainEqual({ type: 'permission-open', requestId: 'req-1', sid: '' })
  })

  it('a permission-respond control message invokes the local responder (B2 round-trip)', () => {
    const t = new FakeChildTransport()
    const host = createHooksHost(t.asHostTransport(), { healthBeat: false })
    let got: string | undefined
    host._registerResponderForTest('req-1', (d) => { got = d })
    t.post({ type: 'permission-respond', requestId: 'req-1', decision: 'approved' })
    expect(got).toBe('approved')
  })

  it('a start control message binds the requested port and announces bound to the parent', async () => {
    const t = new FakeChildTransport()
    createHooksHost(t.asHostTransport(), { healthBeat: false })
    // port 0 -> ephemeral OS-assigned port; the child must announce the ACTUAL bound port
    t.post({ type: 'start', port: 0 })
    await vi.waitFor(() => {
      expect(t.parentMessages.some((m) => m.type === 'bound')).toBe(true)
    })
    const bound = t.parentMessages.find((m) => m.type === 'bound') as { type: 'bound'; port: number; pid: number }
    expect(bound.port).toBeGreaterThan(0)
    // clean up the real listening socket so the test doesn't leak a handle.
    // `stop` -> gateway.stop() closes the server asynchronously; give it a tick.
    t.post({ type: 'stop' })
    await new Promise((r) => setTimeout(r, 50))
  })

  it('forwards a log entry to the parent on stop', async () => {
    const t = new FakeChildTransport()
    createHooksHost(t.asHostTransport(), { healthBeat: false })
    t.post({ type: 'stop' })
    await vi.waitFor(() => {
      expect(t.parentMessages.some((m) => m.type === 'log' && (m as { entry: { code: string } }).entry.code === 'child-stop')).toBe(true)
    })
  })

  it('posts bind-failed (not bound) when the gateway cannot bind', async () => {
    const t = new FakeChildTransport()
    const gw = stubGateway(async () => ({
      enabled: false, listening: false, port: null, error: 'bind-failed after 5 attempts',
    }))
    createHooksHost(t.asHostTransport(), {
      healthBeat: false,
      createGateway: () => gw as unknown as never,
    } as never)
    t.post({ type: 'start', port: 19430 })
    await vi.waitFor(() => {
      expect(t.parentMessages.some((m) => m.type === 'bind-failed')).toBe(true)
    })
    const bf = t.parentMessages.find((m) => m.type === 'bind-failed') as { type: 'bind-failed'; error: string }
    expect(bf.error).toContain('bind-failed')
    expect(t.parentMessages.some((m) => m.type === 'bound')).toBe(false)
  })
})

// planning #309, item 2: hooks turned off and on again in Settings is a `stop`
// then a `start` to the same child. The stop ended the one-second heartbeat and
// the jank monitor; the start has to bring both back, or the Services card's
// live counters stay frozen.
describe('createHooksHost: the heartbeat across a stop and a start', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function beatingHost() {
    const t = new FakeChildTransport()
    const counters = { inFlight: 0, eventsTotal: 0, dropsTotal: 0 }
    const gw = stubGateway(async () => ({ enabled: true, listening: true, port: 19430 }))
    gw.metrics = () => ({ ...counters })
    createHooksHost(t.asHostTransport(), { createGateway: () => gw })
    const beats = () => t.parentMessages.filter((m) => m.type === 'health') as
      Array<Extract<FromChildMessage, { type: 'health' }>>
    return { t, counters, beats }
  }

  it('beats again after a stop and a start, with the live counters', () => {
    const { t, counters, beats } = beatingHost()
    vi.advanceTimersByTime(1000)
    expect(beats()).toHaveLength(1)
    t.post({ type: 'stop' })
    vi.advanceTimersByTime(5000)
    expect(beats()).toHaveLength(1)            // stopped: nothing is sent
    t.post({ type: 'start', port: 19430 })
    counters.inFlight = 2
    counters.eventsTotal = 30
    vi.advanceTimersByTime(2000)
    expect(beats()).toHaveLength(3)            // one a second again
    expect(beats().at(-1)).toMatchObject({ inFlight: 2, eventsTotal: 30, dropsTotal: 0 })
    t.post({ type: 'stop' })
  })

  it('counts stalls again after a stop and a start', () => {
    const { t, beats } = beatingHost()
    t.post({ type: 'stop' })
    t.post({ type: 'start', port: 19430 })
    // The clock jumps three seconds with no timer firing: the event loop was
    // blocked. The jank monitor's next tick is that late, which is one stall.
    vi.setSystemTime(Date.now() + 3000)
    vi.advanceTimersByTime(1000)
    expect(beats().at(-1)?.stallsLastMin).toBe(1)
    t.post({ type: 'stop' })
  })

  it('a start with the heartbeat already running does not double it', () => {
    const { t, beats } = beatingHost()
    t.post({ type: 'start', port: 19430 })     // the first start: the beat has run since the host was made
    t.post({ type: 'start', port: 19430 })
    vi.advanceTimersByTime(3000)
    expect(beats()).toHaveLength(3)
    t.post({ type: 'stop' })
    vi.advanceTimersByTime(3000)
    expect(beats()).toHaveLength(3)            // and one stop ends it
  })

  it('with the heartbeat switched off, a start does not turn it on', () => {
    const t = new FakeChildTransport()
    const gw = stubGateway(async () => ({ enabled: true, listening: true, port: 19430 }))
    createHooksHost(t.asHostTransport(), { healthBeat: false, createGateway: () => gw })
    t.post({ type: 'start', port: 19430 })
    vi.advanceTimersByTime(3000)
    expect(t.parentMessages.some((m) => m.type === 'health')).toBe(false)
  })
})
