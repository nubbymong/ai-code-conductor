// What a status line means, once it has been parsed and sanitised: the
// fan-out that decides it. Written against src/main/statusline-watcher.ts
// BEFORE the fan-out moved into the session signals module (2.1.3-beta.8,
// section A2), and green after the move too, so the move is shown to change
// nothing. Every case but the last eight drives the real fan-out through the
// watcher's own string entry (dispatchSSHStatuslineUpdate), the path the MCP
// /status ingest and the SSH sentinel take. The cases where a part throws
// call deliverStatus itself: the watcher's entry catches any throw, so only a
// direct call shows that the fan-out's own guards hold (the window send and
// the provider's step joined the three sinks in 2.1.3-beta.9, planning #324,
// and each one's first throw in a run is logged once). Only the colour
// decorator, the subagent check, Sentinel, the provider registry and the
// logger are stand-ins.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'

const h = vi.hoisted(() => ({
  // A real temp resources folder: startStatuslineWatcher makes <resources>/status
  // in it. Removed in afterAll.
  dir: (() => {
    const os = require('node:os'); const fs = require('node:fs'); const path = require('node:path')
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-signals-status-')) as string
  })(),
  log: [] as string[],
  background: false,
  backgroundAsked: [] as Array<[unknown, unknown]>,
  observed: [] as Array<Record<string, unknown>>,
  observeThrows: false,
  delivered: [] as Array<Record<string, unknown>>,
  providerAsked: [] as unknown[],
  providerThrows: false,
  warns: [] as string[],
}))

vi.mock('electron', () => ({ BrowserWindow: class {} }))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => h.dir, registerSetupHandlers: () => {} }))
// As the real decorator (src/main/account-color.ts): a NEW object carrying a
// colour when the payload names an account, and the SAME object when it does
// not. So a test can tell the decorated payload from the raw one, and a strip
// that deleted in place would reach the raw data here, as it would in the app.
vi.mock('../../../src/main/account-color', () => ({
  decorateStatuslineWithColour: (d: Record<string, unknown>) =>
    typeof d.accountEmail === 'string' && d.accountEmail.trim() ? { ...d, accountColour: 'mock-colour' } : d,
}))
vi.mock('../../../src/main/background-context', () => ({
  isBackgroundContext: (sid: unknown, tp: unknown) => { h.backgroundAsked.push([sid, tp]); return h.background },
}))
vi.mock('../../../src/main/sentinel/index', () => ({
  sentinelObserve: (o: Record<string, unknown>) => {
    h.log.push('sentinel')
    if (h.observeThrows) throw new Error('observer boom')
    h.observed.push(o)
  },
}))
vi.mock('../../../src/main/providers', () => {
  const provider = {
    deliverStatusline: (d: Record<string, unknown>) => {
      h.log.push('provider')
      if (h.providerThrows) throw new Error('provider boom')
      h.delivered.push(d)
    },
    healGlobalStatusline: () => {},
  }
  return {
    getProvider: () => provider,
    tryGetProvider: (id: unknown) => { h.providerAsked.push(id); return provider },
  }
})
// The logger's warnings are kept, so a case can count the fan-out's own lines.
vi.mock('../../../src/main/debug-logger', () => ({
  logWarn: (...a: unknown[]) => { h.warns.push(a.map(String).join(' ')) },
  logInfo: () => {}, logError: () => {}, logDebug: () => {},
}))

const { dispatchSSHStatuslineUpdate, setTranscriptPathSink, setStatuslineUsageSink, startStatuslineWatcher } =
  await import('../../../src/main/statusline-watcher')
const { deliverStatus, _resetStatusThrowLogForTest } = await import('../../../src/main/session-signals/status')

const TP = '/profiles/p1/projects/x/00000000-0000-4000-8000-000000000000.jsonl'
const BUCKETS = [{ key: 'session:', label: '5h', group: 'session', percent: 33, resetsAt: '', severity: 'normal' }]

let sent: Array<{ channel: string; payload: Record<string, unknown> }> = []
let destroyed = false
let sendThrows = false
const fakeWin = {
  isDestroyed: () => destroyed,
  webContents: {
    send: (channel: string, payload: Record<string, unknown>) => {
      h.log.push('window')
      if (sendThrows) throw new Error('send boom')
      sent.push({ channel, payload })
    },
  },
}
let transcripts: Array<[string, string]> = []
let usage: Array<{ sessionId: string; buckets: unknown; hasCredits: boolean; transcriptPath?: string }> = []
let stopWatcher: (() => void) | null = null

beforeEach(() => {
  h.log = []; h.background = false; h.backgroundAsked = []; h.observed = []; h.observeThrows = false; h.delivered = []; h.providerAsked = []; h.providerThrows = false; h.warns = []
  _resetStatusThrowLogForTest()
  sent = []; destroyed = false; sendThrows = false; transcripts = []; usage = []
  stopWatcher = startStatuslineWatcher(() => fakeWin as never)
  setTranscriptPathSink((sid, p) => { h.log.push('transcript'); transcripts.push([sid, p]) })
  setStatuslineUsageSink((sessionId, buckets, hasCredits, transcriptPath) => {
    h.log.push('usage'); usage.push({ sessionId, buckets, hasCredits, transcriptPath })
  })
})
afterEach(() => { stopWatcher?.(); stopWatcher = null })
afterAll(() => {
  if (!h.dir) return
  try { require('node:fs').rmSync(h.dir, { recursive: true, force: true }) } catch { /* best effort */ }
})

const dispatch = (payload: Record<string, unknown>) =>
  dispatchSSHStatuslineUpdate(JSON.stringify({ sessionId: 'sess-1', ...payload }))
/** The fan-out itself, on a payload as the watcher hands it over. */
const deliver = (payload: Record<string, unknown>) =>
  deliverStatus({ sessionId: 'sess-1', ...payload } as never, () => fakeWin as never)

/** A full status line: model fields, a transcript, usage and an account. */
const full = (extra: Record<string, unknown> = {}) => ({
  model: 'Opus Display', modelId: 'model-id-raw', effortLevel: 'high', contextPercent: 41,
  transcriptPath: TP, usageBuckets: BUCKETS, accountEmail: 'someone@example.com', ...extra,
})

describe('the status line fan-out (characterisation, kept across the move into the session signals module)', () => {
  it('the window gets the colour-decorated payload on statusline:update, and the provider the same copy', () => {
    dispatch(full())
    expect(sent).toHaveLength(1)
    expect(sent[0].channel).toBe('statusline:update')
    expect(sent[0].payload).toEqual({
      sessionId: 'sess-1', model: 'Opus Display', modelId: 'model-id-raw', effortLevel: 'high', contextPercent: 41,
      transcriptPath: TP, usageBuckets: BUCKETS, accountEmail: 'someone@example.com', accountColour: 'mock-colour',
    })
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]).toBe(sent[0].payload)
    expect(h.providerAsked).toEqual(['claude'])
  })

  it('the subagent check is asked about the raw session and transcript', () => {
    dispatch(full())
    expect(h.backgroundAsked).toEqual([['sess-1', TP]])
  })

  it('a background context removes model, modelId and effortLevel from the display copy only', () => {
    h.background = true
    dispatch(full())
    const shown = sent[0].payload
    expect(shown).not.toHaveProperty('model')
    expect(shown).not.toHaveProperty('modelId')
    expect(shown).not.toHaveProperty('effortLevel')
    // Everything else on the display copy still flows, colour included.
    expect(shown).toMatchObject({ sessionId: 'sess-1', contextPercent: 41, transcriptPath: TP, usageBuckets: BUCKETS, accountColour: 'mock-colour' })
    expect(h.delivered[0]).toBe(shown)
    // The raw data is untouched: Sentinel still sees the agent's raw model id,
    // and the sinks still get the raw transcript and usage.
    expect(h.observed).toEqual([{ kind: 'model', value: 'model-id-raw', source: 'statusline' }])
    expect(transcripts).toEqual([['sess-1', TP]])
    expect(usage).toEqual([{ sessionId: 'sess-1', buckets: BUCKETS, hasCredits: false, transcriptPath: TP }])
  })

  it('a background context with no account colour still strips only the display copy', () => {
    // No account, so the decorator hands back the raw object itself: the strip
    // must copy before it deletes, or the raw data loses its model fields.
    h.background = true
    dispatch(full({ accountEmail: undefined }))
    const shown = sent[0].payload
    expect(shown).not.toHaveProperty('model')
    expect(shown).not.toHaveProperty('modelId')
    expect(shown).not.toHaveProperty('effortLevel')
    expect(shown).not.toHaveProperty('accountColour')
    expect(h.delivered[0]).toBe(shown)
    // Sentinel still reads the raw model id, and the sinks the raw data.
    expect(h.observed).toEqual([{ kind: 'model', value: 'model-id-raw', source: 'statusline' }])
    expect(transcripts).toEqual([['sess-1', TP]])
    expect(usage).toEqual([{ sessionId: 'sess-1', buckets: BUCKETS, hasCredits: false, transcriptPath: TP }])
  })

  it('the transcript path and usage sinks get the raw data', () => {
    dispatch(full({ rateLimitExtra: { enabled: true, limitUsd: 50, usedUsd: 1.5, utilization: 3 } }))
    expect(transcripts).toEqual([['sess-1', TP]])
    expect(usage).toEqual([{ sessionId: 'sess-1', buckets: BUCKETS, hasCredits: true, transcriptPath: TP }])
  })

  it('no transcript path, no transcript sink; no usage buckets, no usage sink', () => {
    dispatch({ model: 'Opus Display', usageBuckets: [] })
    expect(transcripts).toEqual([])
    expect(usage).toEqual([])
    expect(sent).toHaveLength(1)
  })

  it('Sentinel sees modelId before model, then model alone, and nothing without either', () => {
    dispatch({ model: 'Opus Display', modelId: 'model-id-raw' })
    dispatch({ model: 'Opus Display' })
    dispatch({ contextPercent: 5 })
    expect(h.observed).toEqual([
      { kind: 'model', value: 'model-id-raw', source: 'statusline' },
      { kind: 'model', value: 'Opus Display', source: 'statusline' },
    ])
  })

  it('the parts run in one order: window, provider, transcript sink, usage sink, Sentinel', () => {
    dispatch(full())
    expect(h.log).toEqual(['window', 'provider', 'transcript', 'usage', 'sentinel'])
  })

  it('a destroyed window is skipped and the rest of the fan-out still runs', () => {
    destroyed = true
    dispatch(full())
    expect(sent).toEqual([])
    expect(h.log).toEqual(['provider', 'transcript', 'usage', 'sentinel'])
  })

  it('the fan-out logs nothing of its own when nothing throws', () => {
    dispatch(full())
    dispatch(full({ accountEmail: undefined }))
    expect(h.warns.filter((l) => l.startsWith('[status-fan-out]'))).toEqual([])
  })

  it('a throwing transcript sink does not stop the usage sink or Sentinel', () => {
    setTranscriptPathSink(() => { h.log.push('transcript'); throw new Error('transcript boom') })
    expect(() => deliver(full())).not.toThrow()
    expect(h.log).toEqual(['window', 'provider', 'transcript', 'usage', 'sentinel'])
    expect(usage).toHaveLength(1)
    expect(h.observed).toHaveLength(1)
  })

  it('a throwing usage sink does not stop Sentinel', () => {
    setStatuslineUsageSink(() => { h.log.push('usage'); throw new Error('usage boom') })
    expect(() => deliver(full())).not.toThrow()
    expect(h.log).toEqual(['window', 'provider', 'transcript', 'usage', 'sentinel'])
    expect(h.observed).toHaveLength(1)
  })

  it('a throwing Sentinel observer does not break the fan-out', () => {
    h.observeThrows = true
    expect(() => deliver(full())).not.toThrow()
    expect(h.log).toEqual(['window', 'provider', 'transcript', 'usage', 'sentinel'])
  })

  // planning #324: the window send and the provider's deliverStatusline are
  // guarded as the three sinks are, each on its own.
  it('a window whose send throws does not stop the provider, the transcript sink, the usage sink or Sentinel, in order', () => {
    sendThrows = true
    expect(() => deliver(full())).not.toThrow()
    expect(h.log).toEqual(['window', 'provider', 'transcript', 'usage', 'sentinel'])
    expect(sent).toEqual([])
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]).toMatchObject({ sessionId: 'sess-1', accountColour: 'mock-colour' })
    expect(transcripts).toEqual([['sess-1', TP]])
    expect(usage).toEqual([{ sessionId: 'sess-1', buckets: BUCKETS, hasCredits: false, transcriptPath: TP }])
    expect(h.observed).toEqual([{ kind: 'model', value: 'model-id-raw', source: 'statusline' }])
  })

  it('a provider whose deliverStatusline throws does not stop the transcript sink, the usage sink or Sentinel, in order', () => {
    h.providerThrows = true
    expect(() => deliver(full())).not.toThrow()
    expect(h.log).toEqual(['window', 'provider', 'transcript', 'usage', 'sentinel'])
    expect(sent).toHaveLength(1)
    expect(transcripts).toEqual([['sess-1', TP]])
    expect(usage).toEqual([{ sessionId: 'sess-1', buckets: BUCKETS, hasCredits: false, transcriptPath: TP }])
    expect(h.observed).toEqual([{ kind: 'model', value: 'model-id-raw', source: 'statusline' }])
  })

  it('with both throwing, the transcript sink, the usage sink and Sentinel still run, in order', () => {
    sendThrows = true
    h.providerThrows = true
    expect(() => deliver(full())).not.toThrow()
    expect(h.log).toEqual(['window', 'provider', 'transcript', 'usage', 'sentinel'])
    expect(transcripts).toHaveLength(1)
    expect(usage).toHaveLength(1)
    expect(h.observed).toHaveLength(1)
  })

  it('a window lookup that throws is guarded with the send, and the rest still runs', () => {
    const lookupThrows = () => { throw new Error('window lookup boom') }
    expect(() => deliverStatus({ sessionId: 'sess-1', ...full() } as never, lookupThrows as never)).not.toThrow()
    expect(h.log).toEqual(['provider', 'transcript', 'usage', 'sentinel'])
  })

  // Mutations to prove this can fail: drop the log line from either catch,
  // or log on every throw (no once-per-run latch).
  it('two ticks where both steps throw: one log line per step, and every part still runs both times, in order', () => {
    sendThrows = true
    h.providerThrows = true
    deliver(full())
    deliver(full())
    const lines = h.warns.filter((l) => l.startsWith('[status-fan-out]'))
    expect(lines).toEqual([
      '[status-fan-out] The window send threw; the rest of the fan-out still ran (logged once per run): send boom',
      '[status-fan-out] The provider step threw; the rest of the fan-out still ran (logged once per run): provider boom',
    ])
    const once = ['window', 'provider', 'transcript', 'usage', 'sentinel']
    expect(h.log).toEqual([...once, ...once])
    expect(transcripts).toHaveLength(2)
    expect(usage).toHaveLength(2)
    expect(h.observed).toHaveLength(2)
  })
})
