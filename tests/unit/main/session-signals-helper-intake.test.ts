// Hook events through the session helper (2.1.3-beta.8, plan section A4): a
// Claude Code session the helper holds sends its hook events (all but
// PreToolUse) through its holder, and the session helper manager hands each to
// the session signals module (helperHookEvent). Such an event must get what
// the hooks gateway gives its own, then the same fan-out:
//  - the same recorded payloads, fed through the gateway (HooksGateway's own
//    ingest, the code the utility process runs) and through the helper path,
//    give the same renderer HOOKS_EVENT payload and the same consumer calls
//    (the redaction and the bounding included);
//  - the feed history read (ipc/hooks-handlers.ts HOOKS_GET_BUFFER) returns
//    the helper ring too, in the order the events came;
//  - a crafted transcript_path is refused by sanitiseTranscriptPath and logged
//    by its length only; a usable one reaches the transcript route;
//  - events the holder dropped (`lost`) are logged once per session;
//  - an event is taken only while the gateway would take its own (on and
//    listening), read at each event, so intake follows the gateway's real
//    state and not what a toggle once answered.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { BrowserWindow, ipcMain } from 'electron'
import type { HookEvent } from '../../../src/shared/hook-types'
import type { RingBufferEntry } from '../../../src/main/hooks/hooks-types'
import { IPC } from '../../../src/shared/ipc-channels'
import { logWarn } from '../../../src/main/debug-logger'

vi.mock('../../../src/main/config-manager', () => ({ readConfig: () => null }))
// The hooks master switch's handler reads the live sessions; none here.
vi.mock('../../../src/main/pty-manager', () => ({ getActivePtySessionIds: () => [] }))

const { HooksGateway } = await import('../../../src/main/hooks/hooks-gateway')
const { HooksGatewayProxy } = await import('../../../src/main/services/hooks-gateway-proxy')
const { setGateway } = await import('../../../src/main/hooks/index')
const signals = await import('../../../src/main/session-signals/hooks')
const { startSessionSignals, onHookEvent, helperHookEvent, endHelperHooks, hookFeedBuffer } = await import('../../../src/main/session-signals')
const { registerHooksHandlers } = await import('../../../src/main/ipc/hooks-handlers')

const SID = 'abcdef0123456789abcdef01'
const TRANSCRIPT = 'C:\\Users\\someone\\.claude\\projects\\C--work-app\\8f0c2b1e-5d4a-4c3b-9a2f-1e0d9c8b7a65.jsonl'
const SK = `sk-ant-api03-${'A'.repeat(48)}`
const GHP = `ghp_${'b'.repeat(36)}`

/** Recorded payloads, as Claude Code writes them on a hook's standard input
 *  (and in a hook POST's body): one of each kind the helper carries, with
 *  secrets the redactor must take out, a body the feed must bound, and one
 *  the hook mode cut. */
const RECORDED: Array<Record<string, unknown>> = [
  {
    session_id: '8f0c2b1e-5d4a-4c3b-9a2f-1e0d9c8b7a65', transcript_path: TRANSCRIPT, cwd: 'C:\\work\\app', permission_mode: 'default',
    hook_event_name: 'PostToolUse', tool_name: 'Edit',
    tool_input: { file_path: 'C:\\work\\app\\src\\config.ts', old_string: 'const key = ""', new_string: `const key = "${SK}"` },
    tool_response: { filePath: 'C:\\work\\app\\src\\config.ts', success: true, structuredPatch: `${'+ line of the diff\n'.repeat(900)}password: hunter2hunter2 ${GHP}` },
  },
  { session_id: '8f0c', transcript_path: TRANSCRIPT, cwd: 'C:\\work\\app', hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' },
  { session_id: '8f0c', transcript_path: TRANSCRIPT, cwd: 'C:\\work\\app', hook_event_name: 'UserPromptSubmit', prompt: `use the token ${GHP} to push` },
  { session_id: '8f0c', transcript_path: TRANSCRIPT, cwd: 'C:\\work\\app', hook_event_name: 'SessionStart', source: 'startup' },
  { session_id: '8f0c', transcript_path: TRANSCRIPT, cwd: 'C:\\work\\app', hook_event_name: 'Stop', stop_hook_active: false },
  { session_id: '8f0c', transcript_path: TRANSCRIPT, hook_event_name: 'SubagentStop', agent_type: 'reviewer' },
  { session_id: '8f0c', transcript_path: TRANSCRIPT, hook_event_name: 'StopFailure', error: 'overloaded_error' },
  // A tool name over the 128-character limit, and a top-level file path long
  // enough that the summary (`<tool> <file>`) is cut at 256.
  { session_id: '8f0c', transcript_path: TRANSCRIPT, hook_event_name: 'PostToolUse', tool_name: `mcp__${'t'.repeat(295)}`, file_path: `C:\\work\\app\\${'d'.repeat(1000)}.ts` },
  { session_id: '8f0c', transcript_path: TRANSCRIPT, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { cut: 26 }, tool_response: { cut: 102402 }, cut: true },
]

let emit: ReturnType<typeof vi.fn>
let routed: Array<[string, string]>
let seen: Array<[HookEvent, string]>
let gw: InstanceType<typeof HooksGateway>
let secret: string

beforeEach(() => {
  signals._resetHookSignalsForTest()
  vi.mocked(logWarn).mockClear()
  vi.mocked(ipcMain.handle).mockClear()
  emit = vi.fn()
  routed = []
  seen = []
  // As src/main/index.ts wires it: one emit for the gateway and the module,
  // and the gateway's transcript path through the module.
  gw = new HooksGateway({ defaultPort: 0, emit, onTranscriptPath: (sid, p) => signals.transcriptPath(sid, p, 'gateway') })
  secret = gw.registerSession(SID)
  // On and listening, as the gateway is whenever a session's hooks were
  // switched to the helper (no port is bound here).
  vi.spyOn(gw, 'status').mockReturnValue({ enabled: true, listening: true, port: 19334 })
  setGateway(gw)
  startSessionSignals({ onTranscriptPath: (sid, p) => routed.push([sid, p]), emit })
  onHookEvent((e, source) => { seen.push([e, source]) })
})

afterEach(() => { vi.restoreAllMocks() })

/** One body through the gateway's own ingest, as a hook POST. */
async function viaGateway(payload: Record<string, unknown>): Promise<void> {
  const r = await gw._handleRequestForTest({ remoteAddress: '127.0.0.1', url: `/hook/${SID}`, headers: { 'x-ccc-hook-token': secret }, body: JSON.stringify(payload) })
  expect(r.status).toBe(200)
}
const feedEvents = () => emit.mock.calls.filter((c) => c[0] === IPC.HOOKS_EVENT).map((c) => c[1] as HookEvent)

describe('a helper event gets what the gateway gives its own', () => {
  it('the same recorded payloads give the same HOOKS_EVENT payload and the same consumer calls, redacted and bounded alike', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    for (const payload of RECORDED) {
      emit.mockClear()
      seen.length = 0
      routed.length = 0
      await viaGateway(payload)
      helperHookEvent(SID, { kind: payload.hook_event_name as string, payload: structuredClone(payload) })
      const [fromGateway, fromHelper] = feedEvents()
      const what = String(payload.hook_event_name)
      expect(fromHelper, what).toEqual(fromGateway)
      expect(seen.map(([e, source]) => source), what).toEqual(['gateway', 'helper'])
      expect(seen[1][0], what).toEqual(seen[0][0])
      // The transcript route heard both, the same path.
      expect(routed, what).toEqual([[SID, TRANSCRIPT], [SID, TRANSCRIPT]])
      // No secret reached the window or a consumer.
      const sent = JSON.stringify(fromHelper)
      expect(sent, what).not.toContain(SK)
      expect(sent, what).not.toContain(GHP)
      expect(sent, what).not.toContain('hunter2hunter2')
      // The scalars lifted from the body are bounded on the helper path too.
      expect(fromHelper.toolName?.length ?? 0, what).toBeLessThanOrEqual(128)
      expect(fromHelper.summary!.length, what).toBeLessThanOrEqual(256)
      if (typeof payload.file_path === 'string') {
        expect(fromHelper.toolName).toBe(`mcp__${'t'.repeat(123)}`)
        expect(fromHelper.summary).toHaveLength(256)
        expect(fromHelper.summary!.endsWith('…')).toBe(true)
      }
    }
    // The large body was bounded for the feed, as the gateway bounds it.
    const big = feedEvents()
    expect(big).toHaveLength(2)
    expect(Buffer.byteLength(JSON.stringify(big[1].payload))).toBeLessThanOrEqual(8192)
  })

  it('the feed history read returns the helper ring too, in the order the events came; the gateway ring alone for a session with none', async () => {
    registerHooksHandlers(gw)
    const handler = vi.mocked(ipcMain.handle).mock.calls.find((c) => c[0] === IPC.HOOKS_GET_BUFFER)![1] as (e: unknown, req: { sessionId: string }) => Promise<HookEvent[]>
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1000)
    await viaGateway({ session_id: 'c', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } })
    // The gateway's ring alone: exactly what the gateway answers.
    expect(await handler(null, { sessionId: SID })).toEqual(gw.getBuffer(SID))
    expect(hookFeedBuffer(SID, gw.getBuffer(SID))).toEqual(gw.getBuffer(SID))
    now.mockReturnValue(2000)
    helperHookEvent(SID, { kind: 'PostToolUse', payload: { session_id: 'c', hook_event_name: 'PostToolUse', tool_name: 'Bash' } })
    now.mockReturnValue(3000)
    await viaGateway({ session_id: 'c', hook_event_name: 'PreToolUse', tool_name: 'Read' })
    now.mockReturnValue(4000)
    helperHookEvent(SID, { kind: 'Stop', payload: { session_id: 'c', hook_event_name: 'Stop' } })
    const read = await handler(null, { sessionId: SID })
    expect(read.map((e) => [e.event, e.toolName, e.ts])).toEqual([['PreToolUse', 'Bash', 1000], ['PostToolUse', 'Bash', 2000], ['PreToolUse', 'Read', 3000], ['Stop', undefined, 4000]])
    // Another session's read is the gateway's alone.
    expect(await handler(null, { sessionId: 'abcdef0123456789abcdef02' })).toEqual([])
    // The session's run through the helper ended: its ring goes.
    endHelperHooks(SID)
    expect((await handler(null, { sessionId: SID })).map((e) => e.ts)).toEqual([1000, 3000])
  })

  it('the history keeps the order the events reached main, not their clocks: the same millisecond, or a clock set back', async () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(5000)
    helperHookEvent(SID, { kind: 'UserPromptSubmit', payload: { session_id: 'c', hook_event_name: 'UserPromptSubmit' } })
    await viaGateway({ session_id: 'c', hook_event_name: 'PreToolUse', tool_name: 'Bash' })
    now.mockReturnValue(4000) // the clock went back
    helperHookEvent(SID, { kind: 'PostToolUse', payload: { session_id: 'c', hook_event_name: 'PostToolUse', tool_name: 'Bash' } })
    await viaGateway({ session_id: 'c', hook_event_name: 'PreToolUse', tool_name: 'Read' })
    const read = hookFeedBuffer(SID, gw.getBuffer(SID))
    expect(read.map((e) => [e.event, e.toolName ?? null, e.ts])).toEqual([
      ['UserPromptSubmit', null, 5000], ['PreToolUse', 'Bash', 5000], ['PostToolUse', 'Bash', 4000], ['PreToolUse', 'Read', 4000],
    ])
    // And the newest are the last to come, so the cap keeps them.
    for (let i = 0; i < 999; i++) helperHookEvent(SID, { kind: 'Stop', payload: { hook_event_name: 'Stop', n: i } })
    now.mockReturnValue(1)
    helperHookEvent(SID, { kind: 'Notification', payload: { hook_event_name: 'Notification' } })
    const capped = hookFeedBuffer(SID, gw.getBuffer(SID))
    expect(capped).toHaveLength(1000)
    expect(capped[capped.length - 1].event).toBe('Notification')
  })

  it('a ring over its cap drops the oldest and says so once, as the gateway does', () => {
    for (let i = 0; i < 1001; i++) helperHookEvent(SID, { kind: 'Stop', payload: { hook_event_name: 'Stop', n: i } })
    const ring = hookFeedBuffer(SID, [])
    expect(ring).toHaveLength(1000)
    expect((ring[0].payload as { n: number }).n).toBe(1)
    helperHookEvent(SID, { kind: 'Stop', payload: { hook_event_name: 'Stop', n: 1001 } })
    expect(emit.mock.calls.filter((c) => c[0] === IPC.HOOKS_DROPPED)).toEqual([[IPC.HOOKS_DROPPED, { sessionId: SID }]])
  })
})

describe('the transcript path, the lost count, and the master switch', () => {
  it('a crafted transcript_path is refused by sanitiseTranscriptPath and logged by its length only; the event still goes on', () => {
    const crafted: unknown[] = [
      `${TRANSCRIPT}\u0000.png`,
      `${TRANSCRIPT}\n[hooks] forged log line`,
      `C:\\${'a'.repeat(5000)}.jsonl`,
      '',
      42,
      { path: TRANSCRIPT },
    ]
    for (const tp of crafted) {
      vi.mocked(logWarn).mockClear()
      seen.length = 0
      helperHookEvent(SID, { kind: 'Stop', payload: { hook_event_name: 'Stop', transcript_path: tp } })
      expect(routed, String(tp)).toEqual([])
      expect(seen, String(tp)).toHaveLength(1)
      const lines = vi.mocked(logWarn).mock.calls.map((c) => String(c[0]))
      expect(lines, String(tp)).toHaveLength(1)
      expect(lines[0]).toMatch(/^\[hooks\] dropped an unusable transcript_path from the session helper sid=abcdef0123456789abcdef01 type=\w+ length=(\d+|n\/a)$/)
      if (typeof tp === 'string' && tp.length > 0) expect(lines[0]).not.toContain(tp.slice(0, 20))
    }
  })

  it('the events the holder dropped are logged once per session, and again after its run ended', () => {
    helperHookEvent(SID, { kind: 'Notification', payload: { hook_event_name: 'Notification' }, lost: 44 })
    helperHookEvent(SID, { kind: 'Stop', payload: { hook_event_name: 'Stop' }, lost: 3 })
    helperHookEvent(SID, { kind: 'Stop', payload: { hook_event_name: 'Stop' } })
    const lostLines = () => vi.mocked(logWarn).mock.calls.map((c) => String(c[0])).filter((l) => l.includes('dropped') && l.includes('hook event'))
    expect(lostLines()).toEqual([`[hooks] the session helper dropped 44 hook event(s) of ${SID} while the app was not attached`])
    expect(seen).toHaveLength(3)
    endHelperHooks(SID)
    helperHookEvent(SID, { kind: 'Stop', payload: { hook_event_name: 'Stop' }, lost: 2 })
    expect(lostLines()).toHaveLength(2)
  })

  it("taken only while the gateway is on and listening, read at each event: a start that gave up waiting, then a late bind, an off, and a child's restart", async () => {
    // The switch's status goes to every window; there is none here.
    Object.assign(BrowserWindow, { getAllWindows: () => [] })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      // The gateway as production runs it: the proxy in main, its child out of
      // process (a transport the test answers for; no child is forked).
      const proxy = new HooksGatewayProxy({ transport: { post: () => {}, onMessage: () => {}, kill: () => {} }, defaultPort: 19334, emit })
      setGateway(proxy)
      registerHooksHandlers(proxy)
      const toggle = vi.mocked(ipcMain.handle).mock.calls.find((c) => c[0] === IPC.HOOKS_TOGGLE)![1] as (e: unknown, req: { enabled: boolean }) => Promise<{ enabled: boolean; listening: boolean }>
      const taken = () => {
        seen.length = 0
        emit.mockClear()
        routed.length = 0
        helperHookEvent(SID, { kind: 'Notification', payload: { hook_event_name: 'Notification', transcript_path: TRANSCRIPT } })
        const n = seen.length
        // Taken means all of it; not taken means none of it.
        expect(feedEvents()).toHaveLength(n)
        expect(routed).toHaveLength(n)
        return n === 1
      }
      // Wanted on, its child not bound yet: none.
      expect(taken()).toBe(false)
      // A toggle on whose child does not bind within the proxy's 4 s wait
      // answers not listening: still none.
      const on = toggle(null, { enabled: true })
      await vi.advanceTimersByTimeAsync(4000)
      expect(await on).toMatchObject({ enabled: true, listening: false })
      expect(taken()).toBe(false)
      // The child binds later (a slow fork under load): taken, with no toggle.
      proxy.handleChildMessage({ type: 'bound', port: 19334, pid: 4242 })
      expect(taken()).toBe(true)
      // One of the session's own gateway events (its PreToolUse), as the child forwards it.
      proxy.handleChildMessage({ type: 'event', entry: { sessionId: SID, event: 'PreToolUse', toolName: 'Bash', summary: 'Bash', payload: {}, ts: 1 } })
      expect(hookFeedBuffer(SID, proxy.getBuffer(SID)).map((e) => e.event)).toEqual(['Notification', 'PreToolUse'])
      // Off: none taken. Both rings stay, as the proxy with its child out of
      // process keeps its own at a stop, so the history read still agrees; the
      // session's end drops them.
      await toggle(null, { enabled: false })
      expect(taken()).toBe(false)
      expect(hookFeedBuffer(SID, proxy.getBuffer(SID)).map((e) => e.event)).toEqual(['Notification', 'PreToolUse'])
      // On again, and bound at once: taken.
      const again = toggle(null, { enabled: true })
      proxy.handleChildMessage({ type: 'bound', port: 19334, pid: 4243 })
      expect(await again).toMatchObject({ enabled: true, listening: true })
      expect(taken()).toBe(true)
      // The child died and is restarted (not listening until it binds again): none, then taken.
      proxy.rebindTransport({ post: () => {}, onMessage: () => {}, kill: () => {} })
      expect(taken()).toBe(false)
      proxy.handleChildMessage({ type: 'bound', port: 19334, pid: 4244 })
      expect(taken()).toBe(true)
      endHelperHooks(SID)
      proxy.unregisterSession(SID)
      expect(hookFeedBuffer(SID, proxy.getBuffer(SID))).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  /** The switch's handler, as registered for `gateway`, and the history read. */
  function handlersOf(gateway: Parameters<typeof registerHooksHandlers>[0]) {
    Object.assign(BrowserWindow, { getAllWindows: () => [] })
    registerHooksHandlers(gateway)
    const calls = vi.mocked(ipcMain.handle).mock.calls
    const toggle = calls.find((c) => c[0] === IPC.HOOKS_TOGGLE)![1] as (e: unknown, req: { enabled: boolean }) => Promise<unknown>
    const read = calls.find((c) => c[0] === IPC.HOOKS_GET_BUFFER)![1] as (e: unknown, req: { sessionId: string }) => Promise<HookEvent[]>
    return { toggle, read }
  }
  const droppedSays = () => emit.mock.calls.filter((c) => c[0] === IPC.HOOKS_DROPPED).length

  it("the switch going off with the in-process HooksGateway (a boot with it saved off, then turned on): the gateway clears its rings at its stop, so the helper's go too; no split history", async () => {
    const { toggle, read } = handlersOf(gw)
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1000)
    await viaGateway({ session_id: 'c', hook_event_name: 'PreToolUse', tool_name: 'Bash' })
    now.mockReturnValue(2000)
    helperHookEvent(SID, { kind: 'PostToolUse', payload: { session_id: 'c', hook_event_name: 'PostToolUse', tool_name: 'Bash' } })
    expect((await read(null, { sessionId: SID })).map((e) => e.event)).toEqual(['PreToolUse', 'PostToolUse'])
    // A helper ring over its cap says so once.
    for (let i = 0; i < 1000; i++) helperHookEvent(SID, { kind: 'Stop', payload: { hook_event_name: 'Stop', n: i } })
    expect(droppedSays()).toBe(1)
    await toggle(null, { enabled: false })
    // The gateway's ring is gone, so the helper's is: not eight kinds without their PreToolUse.
    expect(gw.getBuffer(SID)).toEqual([])
    expect(await read(null, { sessionId: SID })).toEqual([])
    // The overflow mark went with the ring, as the gateway's latch does: a ring
    // that overflows again says so again.
    for (let i = 0; i < 1001; i++) helperHookEvent(SID, { kind: 'Stop', payload: { hook_event_name: 'Stop', n: i } })
    expect(droppedSays()).toBe(2)
  })

  it('the switch going off with the proxy in its in-process fallback (after its fail-open): its stop stops that gateway, which clears its rings, so the helper rings go too', async () => {
    // The fallback gateway is a real HooksGateway; its bind is the test's.
    vi.spyOn(HooksGateway.prototype, 'start').mockResolvedValue({ enabled: true, listening: true, port: 19334 })
    vi.spyOn(HooksGateway.prototype, 'status').mockReturnValue({ enabled: true, listening: true, port: 19334 })
    const proxy = new HooksGatewayProxy({ transport: { post: () => {}, onMessage: () => {}, kill: () => {} }, defaultPort: 19334, emit })
    setGateway(proxy)
    proxy.failOpen()
    expect(proxy.isInProcessFallback()).toBe(true)
    const { toggle, read } = handlersOf(proxy)
    helperHookEvent(SID, { kind: 'PostToolUse', payload: { session_id: 'c', hook_event_name: 'PostToolUse', tool_name: 'Bash' } })
    expect((await read(null, { sessionId: SID })).map((e) => e.event)).toEqual(['PostToolUse'])
    await toggle(null, { enabled: false })
    expect(proxy.getBuffer(SID)).toEqual([])
    expect(await read(null, { sessionId: SID })).toEqual([])
  })

  /** The proxy as production runs it before a fail-open (its child out of
   *  process, bound), and the in-process gateway it falls back to, which the
   *  test binds for (no socket). `secret` is the held session's gateway token,
   *  minted by the proxy as pty-manager's spawn path does. */
  function proxyBeforeFailOpen() {
    vi.spyOn(HooksGateway.prototype, 'start').mockResolvedValue({ enabled: true, listening: true, port: 19334 })
    vi.spyOn(HooksGateway.prototype, 'status').mockReturnValue({ enabled: true, listening: true, port: 19334 })
    const proxy = new HooksGatewayProxy({ transport: { post: () => {}, onMessage: () => {}, kill: () => {} }, defaultPort: 19334, emit })
    setGateway(proxy)
    const token = proxy.registerSession(SID)
    proxy.handleChildMessage({ type: 'bound', port: 19334, pid: 4242 })
    /** A gateway event of a session, as the child forwards it. */
    const fromChild = (sessionId: string, event: RingBufferEntry['event'], toolName: string, ts: number) =>
      proxy.handleChildMessage({ type: 'event', entry: { sessionId, event, toolName, summary: toolName, payload: {}, ts } })
    /** A hook POST taken by the in-process gateway the fail-open started. */
    const viaFallback = async (payload: Record<string, unknown>) => {
      const inProcess = (proxy as unknown as { inProcess: InstanceType<typeof HooksGateway> }).inProcess
      const r = await inProcess._handleRequestForTest({ remoteAddress: '127.0.0.1', url: `/hook/${SID}`, headers: { 'x-ccc-hook-token': token }, body: JSON.stringify(payload) })
      expect(r.status).toBe(200)
    }
    return { proxy, fromChild, viaFallback }
  }

  it("the proxy's fail-open keeps the history it held: a held session's read has both rings, in the order the events came (not their clocks), before and after it", async () => {
    const { proxy, fromChild, viaFallback } = proxyBeforeFailOpen()
    const { read } = handlersOf(proxy)
    const now = vi.spyOn(Date, 'now')
    const shape = async () => (await read(null, { sessionId: SID })).map((e) => [e.event, e.toolName ?? null, e.ts])
    // A helper event, then the session's PreToolUse as the child forwards it
    // (its clock is behind the helper event's, as two clocks may be).
    now.mockReturnValue(9000)
    helperHookEvent(SID, { kind: 'PostToolUse', payload: { session_id: 'c', hook_event_name: 'PostToolUse', tool_name: 'Bash' } })
    fromChild(SID, 'PreToolUse', 'Read', 1000)
    const both = [['PostToolUse', 'Bash', 9000], ['PreToolUse', 'Read', 1000]]
    expect(await shape()).toEqual(both)
    proxy.failOpen()
    expect(proxy.isInProcessFallback()).toBe(true)
    // The fallback's ring holds the PreToolUse from before it, not an empty one,
    // and the read still has both, not the helper's alone.
    expect(proxy.getBuffer(SID).map((e) => e.event)).toEqual(['PreToolUse'])
    expect(await shape()).toEqual(both)
    // And after it: a helper event, and a PreToolUse the fallback takes itself.
    now.mockReturnValue(2000)
    helperHookEvent(SID, { kind: 'Stop', payload: { session_id: 'c', hook_event_name: 'Stop' } })
    now.mockReturnValue(3000)
    await viaFallback({ session_id: 'c', hook_event_name: 'PreToolUse', tool_name: 'Grep' })
    expect(await shape()).toEqual([...both, ['Stop', null, 2000], ['PreToolUse', 'Grep', 3000]])
  })

  it("the proxy's fail-open keeps the PreToolUse history of a session with no helper ring too, and a session's end still drops it", async () => {
    const { proxy, fromChild } = proxyBeforeFailOpen()
    const { read } = handlersOf(proxy)
    fromChild(SID, 'PreToolUse', 'Bash', 1000)
    fromChild(SID, 'PostToolUse', 'Bash', 2000)
    const before = proxy.getBuffer(SID)
    expect(before.map((e) => e.event)).toEqual(['PreToolUse', 'PostToolUse'])
    proxy.failOpen()
    expect(proxy.getBuffer(SID)).toEqual(before)
    expect(await read(null, { sessionId: SID })).toEqual(before)
    // Another session of the app had none.
    expect(await read(null, { sessionId: 'abcdef0123456789abcdef02' })).toEqual([])
    proxy.unregisterSession(SID)
    expect(await read(null, { sessionId: SID })).toEqual([])
  })

  it("HooksGateway.seedBuffers keeps the entries it is given as they are, in order and in front of any it holds, within the ring's bound", async () => {
    const mk = (n: number): RingBufferEntry => ({ sessionId: SID, event: 'Stop', summary: 'Stop', payload: {}, ts: n }) as RingBufferEntry
    const seeded = Array.from({ length: 1003 }, (_, i) => mk(i))
    const g = new HooksGateway({ defaultPort: 0, emit })
    g.seedBuffers(new Map([[SID, seeded], ['abcdef0123456789abcdef02', []]]))
    // The newest 1000, the very objects (the history read ranks them by object).
    const ring = g.getBuffer(SID)
    expect(ring).toHaveLength(1000)
    expect(ring[0]).toBe(seeded[3])
    expect(ring[999]).toBe(seeded[1002])
    expect(g.getBuffer('abcdef0123456789abcdef02')).toEqual([])
    // In front of what the gateway took itself.
    await viaGateway({ session_id: 'c', hook_event_name: 'PreToolUse', tool_name: 'Bash' })
    const older = mk(-1)
    gw.seedBuffers(new Map([[SID, [older]]]))
    const own = gw.getBuffer(SID)
    expect(own).toHaveLength(2)
    expect(own[0]).toBe(older)
    expect(own[1].event).toBe('PreToolUse')
  })

  it('at boot with the hooks switch saved off (a gateway that was never started, so never listening), nothing is taken', () => {
    setGateway(new HooksGateway({ defaultPort: 0, emit }))
    emit.mockClear()
    helperHookEvent(SID, { kind: 'Stop', payload: { hook_event_name: 'Stop', transcript_path: TRANSCRIPT } })
    expect(seen).toEqual([])
    expect(feedEvents()).toEqual([])
    expect(routed).toEqual([])
    expect(hookFeedBuffer(SID, [])).toEqual([])
  })
})
