// A hook event of a tab through the session helper on another machine (plan
// 2.1.3-beta.18, section 3.2; aicc_planning#431): helperHookEvent with
// `remote`. Its transcript path is a path on that host: the consumers get it
// as display text in the payload (the canvas marker queue and the
// background-context rule compare it), and the transcript binder is never
// handed it. A local held session's event still hands its path to the binder
// (the control). The rest is a helper event as before: the feed, the ring,
// the consumers, for the tab's id.
//
// PURE: the real gateway object for its on-and-listening answer (no port
// bound), as session-signals-helper-intake.test.ts sets it up.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { HookEvent } from '../../../src/shared/hook-types'
import { IPC } from '../../../src/shared/ipc-channels'

vi.mock('../../../src/main/config-manager', () => ({ readConfig: () => null }))
vi.mock('../../../src/main/pty-manager', () => ({ getActivePtySessionIds: () => [] }))

const { HooksGateway } = await import('../../../src/main/hooks/hooks-gateway')
const { setGateway } = await import('../../../src/main/hooks/index')
const { RING_BUFFER_CAP } = await import('../../../src/main/hooks/hooks-types')
const { logWarn } = await import('../../../src/main/debug-logger')
const signals = await import('../../../src/main/session-signals/hooks')
const { startSessionSignals, onHookEvent, helperHookEvent, hookFeedBuffer, endHelperHooks } = await import('../../../src/main/session-signals')
const { RemoteDriver, remoteSessionId } = await import('../../../src/main/remote-helper/session')
type RemoteSignalDeps = import('../../../src/main/remote-helper').RemoteSignalDeps
type RemoteMachineRecord = import('../../../src/main/remote-helper/machines').RemoteMachineRecord

const TAB = 'tab-remote-1'
const REMOTE_TRANSCRIPT = '/home/nick/.claude/projects/-home-nick-work/8f0c2b1e-5d4a-4c3b-9a2f-1e0d9c8b7a65.jsonl'

let emit: ReturnType<typeof vi.fn>
let routed: Array<[string, string]>
let seen: Array<[HookEvent, string]>

beforeEach(() => {
  signals._resetHookSignalsForTest()
  emit = vi.fn()
  routed = []
  seen = []
  const gw = new HooksGateway({ defaultPort: 0, emit, onTranscriptPath: (sid, p) => signals.transcriptPath(sid, p, 'gateway') })
  vi.spyOn(gw, 'status').mockReturnValue({ enabled: true, listening: true, port: 19334 })
  setGateway(gw)
  startSessionSignals({ onTranscriptPath: (sid, p) => routed.push([sid, p]), emit })
  onHookEvent((e, source) => { seen.push([e, source]) })
})
afterEach(() => { vi.restoreAllMocks() })

describe('a remote tab\'s hook event (helperHookEvent, remote)', () => {
  it('reaches the consumers and the feed for the tab, its transcript path in the payload as text, and never the transcript binder', () => {
    helperHookEvent(TAB, { kind: 'SessionStart', payload: { hook_event_name: 'SessionStart', session_id: 's1', transcript_path: REMOTE_TRANSCRIPT, source: 'startup' } }, { remote: true })
    helperHookEvent(TAB, { kind: 'Notification', payload: { hook_event_name: 'Notification', session_id: 's1', transcript_path: REMOTE_TRANSCRIPT, message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' } }, { remote: true })
    expect(routed).toEqual([])
    expect(seen.map(([e, source]) => [e.sessionId, e.event, source])).toEqual([[TAB, 'SessionStart', 'helper'], [TAB, 'Notification', 'helper']])
    expect((seen[0][0].payload as Record<string, unknown>).transcript_path).toBe(REMOTE_TRANSCRIPT)
    const feed = emit.mock.calls.filter((c) => c[0] === IPC.HOOKS_EVENT).map((c) => (c[1] as HookEvent).event)
    expect(feed).toEqual(['SessionStart', 'Notification'])
    expect(hookFeedBuffer(TAB, []).map((e) => e.event)).toEqual(['SessionStart', 'Notification'])
  })

  it('the control: a local held session\'s event hands its transcript path to the binder, as before', () => {
    helperHookEvent('tab-local-1', { kind: 'SessionStart', payload: { hook_event_name: 'SessionStart', session_id: 's1', transcript_path: REMOTE_TRANSCRIPT, source: 'startup' } })
    expect(routed).toEqual([['tab-local-1', REMOTE_TRANSCRIPT]])
  })
})

// Reviewer finding (3.2's fix round): a remote tab's hook state was never
// ended. Its events fill the module's ring and its overflow and lost-event
// marks under the tab's id, and only endHelperHooks clears them; nothing
// called it for a remote tab. A Restart reuses the tab's id, so its Hooks feed
// mixed in the last run's events, and its HOOKS_DROPPED notice and lost-event
// warning never fired again. Here the tab's end goes through the real driver
// (RemoteDriver.ending, once its holder ended) with the app's side as
// ipc/remote-machines-handlers.ts gives it.
describe('a remote tab\'s run ends its hook state (RemoteDriver.ending)', () => {
  const ID = 'tab-remote-restart'
  const MACHINE: RemoteMachineRecord = {
    did: '0123456789abcdef0123456789abcdef', host: 'rocky.lan', port: 22, user: 'nick', label: 'Rocky', addedAt: 1,
    os: 'Linux', arch: 'x86_64', home: '/home/nick', shell: '/bin/bash', shellIsSh: true, claudePath: '/home/nick/.local/bin/claude',
    path: '/usr/bin:/bin', lang: null, helper: { version: '0.1.0', sha256: 'a'.repeat(64), folder: `0.1.0-${'a'.repeat(12)}` }, check: { at: 1, ok: true },
  }
  /** The app's side as remote-machines-handlers.ts gives it, for the hooks. */
  const deps: RemoteSignalDeps = {
    toolsServed: () => false,
    status: () => {},
    event: (id, e) => helperHookEvent(id, e, { remote: true }),
    serve: () => false,
    ended: (id) => endHelperHooks(id),
  }
  const dropped = () => emit.mock.calls.filter((c) => c[0] === IPC.HOOKS_DROPPED && (c[1] as { sessionId: string }).sessionId === ID).length
  const lostWarned = () => vi.mocked(logWarn).mock.calls.filter((c) => String(c[0]).includes(`hook event(s) of ${ID} while`)).length
  const stop = (seq: number, lost?: number) => ({ seq, kind: 'Stop' as const, payload: { hook_event_name: 'Stop', session_id: 'run' }, ...(lost ? { lost } : {}) })

  it('after its end a Restart\'s Hooks feed holds only its own run\'s events, and its overflow and lost-event notices fire again', async () => {
    const lostBefore = lostWarned()
    // Run 1: an event after two the holder lost, then more than the ring holds.
    deps.event(ID, stop(1, 2))
    for (let i = 0; i < RING_BUFFER_CAP; i++) deps.event(ID, { seq: i + 2, kind: 'Notification', payload: { hook_event_name: 'Notification', session_id: 'run', message: `one ${i}` } })
    expect([dropped(), lostWarned() - lostBefore]).toEqual([1, 1])
    expect(hookFeedBuffer(ID, [])).toHaveLength(RING_BUFFER_CAP)

    // The tab closes: its holder ended, then the driver's end.
    const driver = new RemoteDriver({ appPtyId: ID, machine: MACHINE, installId: 'f'.repeat(32), runner: {} as never, spec: { argv: ['/bin/sh'], cwd: '/home/nick', env: {}, cols: 80, rows: 24 }, log: () => {}, signals: deps })
    driver.ending(remoteSessionId(ID), Promise.resolve())
    const start = Date.now()
    while (hookFeedBuffer(ID, []).length > 0 && Date.now() - start < 2000) await new Promise((r) => setTimeout(r, 10))

    // Run 2, a Restart (the same tab id): only its own events, and its notices again.
    deps.event(ID, { seq: 1, kind: 'SessionStart', payload: { hook_event_name: 'SessionStart', session_id: 'run', source: 'startup' }, lost: 1 })
    expect(hookFeedBuffer(ID, []).map((e) => e.event)).toEqual(['SessionStart'])
    expect(lostWarned() - lostBefore).toBe(2)
    for (let i = 0; i < RING_BUFFER_CAP; i++) deps.event(ID, stop(i + 2))
    expect(dropped()).toBe(2)
  })
})
