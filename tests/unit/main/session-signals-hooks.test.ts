// What a hook event means: the session signals module is the one subscriber to
// the hooks gateway in main (ADR-030 component row 13; 2.1.3-beta.8, section
// A2). This pins that the move into the module changed no delivery:
//  - the module holds one subscription, on whichever gateway is set, and
//    follows a gateway set later (as the rules engine's onGateway did);
//  - every consumer gets each of the nine injected events once, in the order
//    the consumers registered, which is the order src/main/index.ts starts
//    them (read at 87cb630d and unchanged at 3e4a63e9: the rules engine, the
//    effort tracker, the canvas marker queue's turn boundary, the attention
//    dot, the conversation claim, then the Watchdog when its first session
//    starts);
//  - a consumer that throws stops none of the others; the Watchdog's
//    unsubscribe stops its delivery;
//  - a transcript path the gateway child reports reaches the route once,
//    through the real supervisor and proxy, and an event still reaches the
//    renderer's feed after the consumers.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HookEvent } from '../../../src/shared/hook-types'
import type { HooksGatewayLike } from '../../../src/main/hooks/index'
import { block } from '../../helpers/main-index-cut'

vi.mock('../../../src/main/config-manager', () => ({ readConfig: () => null }))
// The status half of the module is not under test here; its imports are stand-ins.
vi.mock('../../../src/main/account-color', () => ({ decorateStatuslineWithColour: (d: unknown) => d }))
vi.mock('../../../src/main/providers', () => ({ tryGetProvider: () => null, getProvider: () => null }))
vi.mock('../../../src/main/sentinel/index', () => ({ sentinelObserve: () => {} }))
vi.mock('../../../src/main/background-context', () => ({ isBackgroundContext: () => false }))

const { setGateway } = await import('../../../src/main/hooks/index')
const signals = await import('../../../src/main/session-signals/hooks')
const { startSessionSignals } = await import('../../../src/main/session-signals')
const { ServiceSupervisor } = await import('../../../src/main/services/service-supervisor')
const { FakeChildTransport } = await import('../../../src/main/services/service-transport')

const SRC = join(__dirname, '../../../src/main')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')
const uncommented = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '')

/** The nine events the per-session settings inject (session-hooks-writer.ts MVP_EVENTS). */
const NINE = (() => {
  const m = /export const MVP_EVENTS: HookEventKind\[\] = \[([\s\S]*?)\]/.exec(read('hooks/session-hooks-writer.ts'))
  return [...(m?.[1] ?? '').matchAll(/'(\w+)'/g)].map((x) => x[1])
})()

/** The consumers in the order src/main/index.ts registers them today. */
const TODAY = ['rules', 'effort', 'canvas-turn', 'attention', 'claim', 'watchdog'] as const

function fakeGateway() {
  const subs = new Set<(e: HookEvent) => void>()
  return {
    subscribe(cb: (e: HookEvent) => void): () => void { subs.add(cb); return () => { subs.delete(cb) } },
    emit(e: HookEvent): void { for (const cb of [...subs]) { try { cb(e) } catch { /* as the gateway does */ } } },
    subscribers(): number { return subs.size },
  }
}
const asGateway = (g: ReturnType<typeof fakeGateway>) => g as unknown as HooksGatewayLike
const ev = (event: string, sessionId = 'sess-1'): HookEvent => ({ sessionId, event, payload: { hook_event_name: event }, ts: 1 } as HookEvent)

beforeEach(() => {
  signals._resetHookSignalsForTest()
  // @ts-expect-error the gateway cleared, as before the app sets one
  setGateway(null)
})

describe('the module holds the one subscription to the hooks gateway', () => {
  it('reads all nine injected events from the settings writer', () => {
    expect(NINE).toEqual(['PreToolUse', 'PostToolUse', 'Notification', 'SessionStart', 'Stop', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'StopFailure'])
  })

  it('subscribes once, when the gateway is set, however often it is started', () => {
    const a = fakeGateway()
    signals.startHookSignals()
    expect(a.subscribers()).toBe(0)
    setGateway(asGateway(a))
    expect(a.subscribers()).toBe(1)
    signals.startHookSignals()
    expect(a.subscribers()).toBe(1)
  })

  it('a gateway set later is the one heard, and the one before it is dropped', () => {
    const a = fakeGateway(); const b = fakeGateway()
    setGateway(asGateway(a))
    signals.startHookSignals()
    const seen: string[] = []
    signals.onHookEvent((e) => { seen.push(e.event) })
    setGateway(asGateway(b))
    expect([a.subscribers(), b.subscribers()]).toEqual([0, 1])
    a.emit(ev('Stop')); b.emit(ev('SessionStart'))
    expect(seen).toEqual(['SessionStart'])
  })

  it('consumers do not subscribe to the gateway themselves', () => {
    const a = fakeGateway()
    setGateway(asGateway(a))
    signals.startHookSignals()
    for (let i = 0; i < 6; i++) signals.onHookEvent(() => {})
    expect(a.subscribers()).toBe(1)
  })
})

describe('delivery is what the gateway gave each consumer before', () => {
  function wireToday(opts: { throwing?: string } = {}) {
    const gw = fakeGateway()
    setGateway(asGateway(gw))
    signals.startHookSignals()
    const log: string[] = []
    const got = new Map<string, string[]>()
    const unsub = new Map<string, () => void>()
    for (const name of TODAY) {
      got.set(name, [])
      unsub.set(name, signals.onHookEvent((e, source) => {
        log.push(`${name}:${e.event}:${source}`)
        got.get(name)!.push(e.event)
        if (opts.throwing === name) throw new Error(`${name} boom`)
      }))
    }
    return { gw, log, got, unsub }
  }

  it('every consumer gets each of the nine events once, in today\'s registration order', () => {
    const { gw, log, got } = wireToday()
    for (const e of NINE) gw.emit(ev(e))
    expect(log).toEqual(NINE.flatMap((e) => TODAY.map((n) => `${n}:${e}:gateway`)))
    for (const n of TODAY) expect(got.get(n)).toEqual(NINE)
  })

  it('a consumer that throws stops none of the others, for any event', () => {
    for (const thrower of TODAY) {
      signals._resetHookSignalsForTest()
      const { gw, got } = wireToday({ throwing: thrower })
      for (const e of NINE) expect(() => gw.emit(ev(e))).not.toThrow()
      for (const n of TODAY) expect(got.get(n), `${n} with ${thrower} throwing`).toEqual(NINE)
    }
  })

  it('the Watchdog\'s unsubscribe stops its delivery; subscribing again puts it last', () => {
    const { gw, got, unsub, log } = wireToday()
    unsub.get('watchdog')!()
    gw.emit(ev('StopFailure'))
    expect(got.get('watchdog')).toEqual([])
    expect(got.get('claim')).toEqual(['StopFailure'])
    const late: string[] = []
    signals.onHookEvent((e) => { late.push(e.event); log.push(`watchdog-again:${e.event}`) })
    log.length = 0
    gw.emit(ev('StopFailure'))
    expect(late).toEqual(['StopFailure'])
    expect(log.at(-1)).toBe('watchdog-again:StopFailure')
  })

  it('a consumer registered while an event is delivered hears from the next event on', () => {
    const gw = fakeGateway()
    setGateway(asGateway(gw))
    signals.startHookSignals()
    const late: string[] = []
    signals.onHookEvent(() => { if (late.length === 0) signals.onHookEvent((e) => { late.push(e.event) }) })
    gw.emit(ev('SessionStart'))
    expect(late).toEqual([])
    gw.emit(ev('Stop'))
    expect(late).toEqual(['Stop'])
  })

  it('the same consumer registered twice hears each event once, as with the gateway\'s own set', () => {
    const gw = fakeGateway()
    setGateway(asGateway(gw))
    signals.startHookSignals()
    const seen: string[] = []
    const cb = (e: HookEvent) => { seen.push(e.event) }
    signals.onHookEvent(cb); signals.onHookEvent(cb)
    gw.emit(ev('Stop'))
    expect(seen).toEqual(['Stop'])
  })

  it('hookEvent is the entry for any transport, and passes the source on', () => {
    const seen: Array<[string, string]> = []
    signals.onHookEvent((e, source) => { seen.push([e.event, source]) })
    signals.hookEvent(ev('Notification'), 'gateway')
    expect(seen).toEqual([['Notification', 'gateway']])
  })
})

describe('the production gateway half: the real supervisor and proxy, a fake gateway child', () => {
  let sup: InstanceType<typeof ServiceSupervisor> | undefined
  afterEach(async () => { await sup?.getProxy()?.stop(); sup = undefined })

  function boot(route: (sid: string, p: string) => void) {
    const transport = new FakeChildTransport()
    const emitted: Array<[string, unknown]> = []
    const order: string[] = []
    // As src/main/index.ts: the module first, then the supervisor whose
    // transcript path goes through it, then the gateway set.
    startSessionSignals({ onTranscriptPath: route })
    sup = new ServiceSupervisor({
      forkChild: () => ({ transport, kill: () => {}, onExit: () => {} }),
      defaultPort: 0,
      // The renderer feed; the supervisor's own health pushes are not hook events.
      emit: (channel: string, payload: unknown) => { emitted.push([channel, payload]); if (channel.startsWith('hooks:')) order.push(`renderer:${channel}`) },
      onTranscriptPath: (sessionId, path) => signals.transcriptPath(sessionId, path, 'gateway'),
    })
    setGateway(sup.start())
    return { transport, emitted, order }
  }

  it('a transcript path the child reports reaches the route once', () => {
    const routed: Array<[string, string]> = []
    const { transport } = boot((sid, p) => { routed.push([sid, p]) })
    transport.emitToParent({ type: 'transcript-path', sid: 'sess-1', path: '/home/u/.claude/projects/x/a.jsonl' })
    expect(routed).toEqual([['sess-1', '/home/u/.claude/projects/x/a.jsonl']])
  })

  it('a route that throws is caught by the supervisor, as before, and the next event still arrives', () => {
    const { transport } = boot(() => { throw new Error('route boom') })
    const seen: string[] = []
    signals.onHookEvent((e) => { seen.push(e.event) })
    expect(() => transport.emitToParent({ type: 'transcript-path', sid: 'sess-1', path: '/p.jsonl' })).not.toThrow()
    transport.emitToParent({ type: 'event', entry: ev('Stop') })
    expect(seen).toEqual(['Stop'])
  })

  it('each event reaches every consumer once, then the renderer feed, unchanged', () => {
    const { transport, emitted, order } = boot(() => {})
    for (const name of TODAY) signals.onHookEvent((e) => { order.push(`${name}:${e.event}`) })
    transport.emitToParent({ type: 'event', entry: ev('UserPromptSubmit') })
    expect(order).toEqual([...TODAY.map((n) => `${n}:UserPromptSubmit`), 'renderer:hooks:event'])
    expect(emitted.filter(([c]) => c === 'hooks:event')).toHaveLength(1)
  })
})

describe('today\'s registration order, as src/main/index.ts starts the consumers', () => {
  const index = uncommented(read('index.ts'))
  const at = (needle: string | RegExp, from = 0): number => {
    if (typeof needle === 'string') return index.indexOf(needle, from)
    const m = new RegExp(needle.source, 'g'); m.lastIndex = from
    return m.exec(index)?.index ?? -1
  }

  it('the rules engine, the module, the gateway, then effort, canvas turn, attention, the claim and the Watchdog', () => {
    const rules = at('startRulesEngine()')
    const module = at('startSessionSignals({ onTranscriptPath: routeTranscriptPath })')
    const gateway = at('setGateway(')
    const effort = at('startEffortTracker()')
    const canvas = at('startCanvasMarkerQueue({')
    const attention = at('startAttentionSource(')
    const claim = at(/onHookEvent\(\(e\) => \{ try \{ note\w+HookEvent\(e\) \} catch/)
    const watchdog = at('initWatchdogManager({')
    const seq = [rules, module, gateway, effort, canvas, attention, claim, watchdog]
    expect(seq.every((i) => i >= 0), JSON.stringify(seq)).toBe(true)
    expect([...seq].sort((x, y) => x - y)).toEqual(seq)
  })

  it('the canvas turn boundary registers inside the queue\'s start, from the hook stream', () => {
    const canvas = block(index, at('startCanvasMarkerQueue({'))
    expect(canvas).toMatch(/subscribe: \(cb\) => \{\s*onHookEvent\(\(e\) => \{ if \(e\.sessionId\) cb\(e\.sessionId, e\.event\) \}\)\s*\}/)
  })

  it('the supervisor\'s transcript path goes through the module', () => {
    expect(index).toMatch(/new ServiceSupervisor\(\{[^}]*onTranscriptPath: \(sessionId, path\) => transcriptPath\(sessionId, path, 'gateway'\) \}\)/)
  })

  it('main subscribes to the gateway nowhere but through the module', () => {
    expect(index).not.toMatch(/\.subscribe\(\(e\)/)
    expect((index.match(/onHookEvent\(/g) ?? []).length).toBe(2)   // the canvas turn boundary and the claim
  })

  const startBody = (file: string, head: string) => {
    const src = uncommented(read(file))
    const i = src.indexOf(head)
    expect(i, `${head} in ${file}`).toBeGreaterThanOrEqual(0)
    // From the head's own last brace, so a default parameter's {} is not taken for the body.
    return { src, body: block(src, i + head.length - 1) }
  }

  it('each other consumer registers once, in its own start', () => {
    for (const [file, head] of [
      ['channel-rules.ts', 'export function startRulesEngine(): void {'],
      ['effort-tracker.ts', 'export function startEffortTracker(): void {'],
      ['attention-source.ts', 'export function startAttentionSource(opts: AttentionSourceOptions = {}): void {'],
      ['watchdog/watchdog-manager.ts', 'private ensureHookSubscription(): void {'],
    ] as const) {
      const { src, body } = startBody(file, head)
      expect((src.match(/\bonHookEvent\(/g) ?? []).length, file).toBe(1)
      expect(body, file).toMatch(/\bonHookEvent\(/)
    }
  })

  it('the Watchdog keeps its late subscribe and its unsubscribe at teardown', () => {
    const { body } = startBody('watchdog/watchdog-manager.ts', 'private ensureHookSubscription(): void {')
    expect(body).toMatch(/if \(this\.hookUnsub\) return\s*this\.hookUnsub = onHookEvent\(/)
    const dispose = startBody('watchdog/watchdog-manager.ts', 'disposeAll(): void {').body
    expect(dispose).toMatch(/this\.hookUnsub\(\)\s*this\.hookUnsub = null/)
  })
})
