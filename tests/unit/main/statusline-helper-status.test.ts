/**
 * The status line of a tab through the session helper on another machine
 * (plan 2.1.3-beta.18, section 3.2; aicc_planning#431),
 * statusline-watcher.ts dispatchHelperStatus: it is the tab's own (the
 * session id is set from the tab, never taken from the host), a path on that
 * host never reaches the transcript binder and no usage buckets reach the
 * usage sink, whatever the provider's mapping gave, and the shape filter
 * every status passes still bounds it.
 *
 * PURE: electron and the fan-out's neighbours are mocked, as in
 * session-signals-status.test.ts; a real temp resources folder is made for
 * the watcher and removed after.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'

const h = vi.hoisted(() => ({
  dir: (() => {
    const os = require('node:os'); const fs = require('node:fs'); const path = require('node:path')
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-helper-status-')) as string
  })(),
}))

vi.mock('electron', () => ({ BrowserWindow: class {} }))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => h.dir, registerSetupHandlers: () => {} }))
vi.mock('../../../src/main/account-color', () => ({ decorateStatuslineWithColour: (d: Record<string, unknown>) => d }))
vi.mock('../../../src/main/background-context', () => ({ isBackgroundContext: () => false }))
vi.mock('../../../src/main/sentinel/index', () => ({ sentinelObserve: () => {} }))
vi.mock('../../../src/main/providers', () => {
  const provider = { deliverStatusline: () => {}, healGlobalStatusline: () => {} }
  return { getProvider: () => provider, tryGetProvider: () => provider }
})
vi.mock('../../../src/main/debug-logger', () => ({ logWarn: () => {}, logInfo: () => {}, logError: () => {}, logDebug: () => {} }))

const { dispatchHelperStatus, setTranscriptPathSink, setStatuslineUsageSink, startStatuslineWatcher } = await import('../../../src/main/statusline-watcher')

let sent: Array<Record<string, unknown>> = []
const fakeWin = { isDestroyed: () => false, webContents: { send: (_ch: string, payload: Record<string, unknown>) => { sent.push(payload) } } }
let transcripts: Array<[string, string]> = []
let usage: string[] = []
let stopWatcher: (() => void) | null = null

beforeEach(() => {
  sent = []; transcripts = []; usage = []
  stopWatcher = startStatuslineWatcher(() => fakeWin as never)
  setTranscriptPathSink((sid, p) => { transcripts.push([sid, p]) })
  setStatuslineUsageSink((sessionId) => { usage.push(sessionId) })
})
afterEach(() => { stopWatcher?.(); stopWatcher = null })
afterAll(() => { try { require('node:fs').rmSync(h.dir, { recursive: true, force: true }) } catch { /* best effort */ } })

describe('a helper tab\'s status line (dispatchHelperStatus)', () => {
  it('reaches the strip once, as the tab\'s own', () => {
    dispatchHelperStatus('tab-remote', { model: 'Opus', modelId: 'claude-opus-4-1', contextUsedPercent: 12, rateLimitCurrent: 42, rateLimitCurrentResets: '2026-11-25T10:00:00.000Z' })
    expect(sent).toEqual([{ sessionId: 'tab-remote', model: 'Opus', modelId: 'claude-opus-4-1', contextUsedPercent: 12, rateLimitCurrent: 42, rateLimitCurrentResets: '2026-11-25T10:00:00.000Z' }])
  })

  it('a session id in what it is given is never taken: the tab\'s own wins', () => {
    dispatchHelperStatus('tab-remote', { sessionId: 'another-tab', model: 'Opus' } as Record<string, unknown>)
    expect(sent.map((s) => s.sessionId)).toEqual(['tab-remote'])
  })

  it('a transcript path (a path on the host) and usage buckets go to neither sink, nor to the strip', () => {
    dispatchHelperStatus('tab-remote', {
      model: 'Opus',
      transcriptPath: '/home/nick/.claude/projects/-home-nick-work/00000000-0000-4000-8000-000000000000.jsonl',
      usageBuckets: [{ key: 'session:', label: '5h', group: 'session', percent: 33, resetsAt: '', severity: 'normal' }],
    })
    expect(transcripts).toEqual([])
    expect(usage).toEqual([])
    expect(sent).toHaveLength(1)
    expect(sent[0].transcriptPath).toBeUndefined()
    expect(sent[0].usageBuckets).toBeUndefined()
  })

  it('the shape filter still bounds it: an over-long label and a value of the wrong type are dropped', () => {
    dispatchHelperStatus('tab-remote', { model: 'x'.repeat(300), contextUsedPercent: Number.NaN, costUsd: 1.5, rateLimitExtra: { enabled: true } } as Record<string, unknown>)
    expect(sent).toEqual([{ sessionId: 'tab-remote', costUsd: 1.5 }])
  })
})
