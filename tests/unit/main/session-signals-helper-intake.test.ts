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
//  - nothing is taken while the hooks master switch is off.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { BrowserWindow, ipcMain } from 'electron'
import type { HookEvent } from '../../../src/shared/hook-types'
import { IPC } from '../../../src/shared/ipc-channels'
import { logWarn } from '../../../src/main/debug-logger'

vi.mock('../../../src/main/config-manager', () => ({ readConfig: () => null }))
// The hooks master switch's handler reads the live sessions; none here.
vi.mock('../../../src/main/pty-manager', () => ({ getActivePtySessionIds: () => [] }))

const { HooksGateway } = await import('../../../src/main/hooks/hooks-gateway')
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

  it('with the hooks master switch off, nothing is taken and the helper rings go; back on, events are taken again', async () => {
    // The switch's status goes to every window; there is none here.
    Object.assign(BrowserWindow, { getAllWindows: () => [] })
    registerHooksHandlers(gw)
    const toggle = vi.mocked(ipcMain.handle).mock.calls.find((c) => c[0] === IPC.HOOKS_TOGGLE)![1] as (e: unknown, req: { enabled: boolean }) => Promise<unknown>
    helperHookEvent(SID, { kind: 'Stop', payload: { hook_event_name: 'Stop' } })
    expect(hookFeedBuffer(SID, [])).toHaveLength(1)
    await toggle(null, { enabled: false })
    expect(hookFeedBuffer(SID, [])).toEqual([])
    emit.mockClear()
    seen.length = 0
    helperHookEvent(SID, { kind: 'Notification', payload: { hook_event_name: 'Notification', transcript_path: TRANSCRIPT } })
    expect(seen).toEqual([])
    expect(feedEvents()).toEqual([])
    expect(routed).toEqual([])
    signals.setHelperHooksTaken(true)
    helperHookEvent(SID, { kind: 'Notification', payload: { hook_event_name: 'Notification' } })
    expect(seen).toHaveLength(1)
  })
})
