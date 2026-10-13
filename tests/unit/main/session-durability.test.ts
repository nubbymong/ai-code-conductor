import { describe, it, expect, vi } from 'vitest'
import { createSessionDurability } from '../../../src/main/session-durability'
import { makeTranscriptBinder } from '../../../src/main/logging/transcript-binder'
import type { SessionState } from '../../../src/main/session-state'

// #397: the cross-exit durability core. These pin F1 (a cleared set is never
// resurrected by the exit flush), N3 (an honest log on a latch-refused flush), and
// the fail-safe rules the adversarial-review lead required.

const target = { uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', cwd: 'C:/p' }

function make(saveImpl?: (s: SessionState) => boolean, log?: (m: string) => void) {
  const save = vi.fn(saveImpl ?? (() => true))
  const enrichDeps = {
    // #480: exact bind is the source; heuristic is the hooks-off fallback only.
    getExactResumeTarget: () => '/x/f.jsonl',
    getLatestTranscriptPath: () => '/x/f.jsonl',
    isExactBindSourceActive: () => true,
    resolveResumeTargetFromTranscript: () => target,
  }
  const d = createSessionDurability({ enrichDeps, save, log })
  return { d, save }
}

const state = (): SessionState =>
  ({ sessions: [{ id: 's1', provider: 'claude' } as any], activeSessionId: 's1', savedAt: 1 } as SessionState)

describe('createSessionDurability', () => {
  it('saveEnriched enriches from the binder, caches, and returns the save result', () => {
    const { d, save } = make()
    expect(d.saveEnriched(state())).toBe(true)
    expect(save).toHaveBeenCalledOnce()
    expect(d.peek()?.sessions[0]).toMatchObject({ resumeUuid: target.uuid, resumeCwd: target.cwd })
  })

  it('flushOnExit persists the cached state', () => {
    const { d, save } = make()
    d.saveEnriched(state())
    save.mockClear()
    d.flushOnExit('before-quit')
    expect(save).toHaveBeenCalledOnce()
  })

  it('flushOnExit is a no-op before anything was saved this run', () => {
    const { d, save } = make()
    d.flushOnExit('before-quit')
    expect(save).not.toHaveBeenCalled()
  })

  it('F1: flushOnExit does NOT resurrect a set after noteCleared()', () => {
    const { d, save } = make()
    d.saveEnriched(state())
    d.noteCleared(true)
    save.mockClear()
    d.flushOnExit('before-quit')
    expect(save).not.toHaveBeenCalled()
    expect(d.peek()).toBeNull()
  })

  it('N3: flushOnExit logs REFUSED (not success) when the save is refused by the latch', () => {
    const log = vi.fn()
    const { d } = make(() => false, log)
    d.saveEnriched(state())
    log.mockClear()
    d.flushOnExit('SIGTERM')
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0][0]).toMatch(/REFUSED/)
  })

  it('flushOnExit re-persists on every exit path (no dedup — a suspend then a later exit both flush)', () => {
    const { d, save } = make()
    d.saveEnriched(state())
    save.mockClear()
    d.flushOnExit('powerMonitor suspend') // app keeps running after this
    d.flushOnExit('before-quit')          // a later real exit must still flush fresh
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('flushOnExit swallows a save throw and reports it', () => {
    const log = vi.fn()
    let throwNow = false
    const { d } = make(() => { if (throwNow) throw new Error('disk gone'); return true }, log)
    d.saveEnriched(state()) // seeds cache, save returns true
    throwNow = true
    log.mockClear()
    expect(() => d.flushOnExit('before-quit')).not.toThrow()
    expect(log.mock.calls[0][0]).toMatch(/failed/)
  })
})

// P3.6 (ADR-009 round 2, C4): the session:load path. Main's own records in
// the saved state (the conversations whose claim was not certain) are read
// back before any restored session respawns, and a read-back that fails
// never fails the load. What main takes from the state is pty-manager's
// (tests/wp1/launch-handoff-pty.test.ts, kept across a relaunch).
describe('createSessionDurability load', () => {
  const enrichDeps = {
    getExactResumeTarget: () => null,
    getLatestTranscriptPath: () => null,
    isExactBindSourceActive: () => true,
    resolveResumeTargetFromTranscript: () => null,
  }

  it('returns the saved state and hands it to main to read back, once', () => {
    const s = state()
    const readBack = vi.fn()
    const d = createSessionDurability({ enrichDeps, save: () => true, load: () => s, readBack })
    expect(d.load()).toBe(s)
    expect(readBack).toHaveBeenCalledTimes(1)
    expect(readBack).toHaveBeenCalledWith(s)
  })

  it('a read-back that throws still returns the state, and says so', () => {
    const s = state()
    const log = vi.fn()
    const d = createSessionDurability({ enrichDeps, save: () => true, load: () => s, readBack: () => { throw new Error('bad list') }, log })
    expect(d.load()).toBe(s)
    expect(log.mock.calls.map((c) => String(c[0])).join(' ')).toMatch(/could not be read back: bad list/)
  })

  it('nothing saved: null, and main is handed null; no load source: null', () => {
    const readBack = vi.fn()
    expect(createSessionDurability({ enrichDeps, save: () => true, load: () => null, readBack }).load()).toBeNull()
    expect(readBack).toHaveBeenCalledWith(null)
    expect(createSessionDurability({ enrichDeps, save: () => true }).load()).toBeNull()
  })
})

// aicc_planning#104, through the core as session:save runs it: the renderer's
// record carries a restored target only until the spawn takes it, then none.
// A save whose lookup gives no target keeps the conversation the session was
// last saved with, the session's CURRENT one only: the case
// (restored on T1, /clear or /resume moves the bind to T2, then T2's head
// cannot be read) must save T2 or nothing, never T1.
describe('createSessionDurability keeps a session on its conversation (aicc_planning#104)', () => {
  const T1 = { uuid: '97f30254-1111-4111-8111-111111111111', cwd: 'F:/platform_v9' }
  const T2 = { uuid: '8923cf93-2222-4222-8222-222222222222', cwd: 'F:/platform_v9' }
  const pathOf = (t: { uuid: string }) => `C:/Users/u/.claude/projects/F--platform-v9/${t.uuid}.jsonl`

  /** A fake binder: `bound` is the conversation the session's transcript is,
   *  `readable` whether its head can be read at this save. */
  function rig() {
    const b: { bound: { uuid: string; cwd: string } | null; readable: boolean } = { bound: null, readable: true }
    const save = vi.fn((_s: SessionState) => true)
    const d = createSessionDurability({
      enrichDeps: {
        getExactResumeTarget: () => (b.bound ? pathOf(b.bound) : null),
        getLatestTranscriptPath: () => null,
        isExactBindSourceActive: () => true,
        isBinderAvailable: () => true,
        resolveResumeTargetFromTranscript: (p: string) => (b.readable && b.bound && p === pathOf(b.bound) ? { ...b.bound } : null),
      },
      save,
    })
    const written = () => {
      const s = save.mock.calls.at(-1)![0].sessions[0]
      return s ? { uuid: s.resumeUuid, cwd: s.resumeCwd } : undefined
    }
    return { b, d, save, written }
  }
  const rec = (o: Record<string, unknown> = {}): SessionState =>
    ({ sessions: [{ id: 'rune', provider: 'claude', ...o } as any], activeSessionId: 'rune', savedAt: 1 } as SessionState)
  const restored = () => rec({ resumeUuid: T1.uuid, resumeCwd: T1.cwd })
  const none = { uuid: undefined, cwd: undefined }

  it('restored on T1: kept after the spawn takes it, before the first bind and when its head cannot be read', () => {
    const { b, d, written } = rig()
    d.saveEnriched(restored()) // the restore's immediate save
    d.saveEnriched(rec()) // the spawn took the target; no bind yet
    expect(written()).toEqual(T1)
    b.bound = T1
    b.readable = false
    d.saveEnriched(rec())
    expect(written()).toEqual(T1)
  })

  it('a /clear moves the bind to T2 and a later save cannot read T2: T2 is kept, never T1', () => {
    const { b, d, written } = rig()
    d.saveEnriched(restored())
    b.bound = T1
    d.saveEnriched(rec())
    b.bound = T2 // /clear or /resume inside the tab
    d.saveEnriched(rec())
    expect(written()).toEqual(T2)
    b.readable = false
    d.saveEnriched(rec())
    expect(written()).toEqual(T2)
    d.flushOnExit('before-quit')
    expect(written()).toEqual(T2)
  })

  it('moved to T2 whose head was never read: nothing is saved, not the older T1 (the picker, as before)', () => {
    const { b, d, written } = rig()
    d.saveEnriched(restored())
    b.bound = T2
    b.readable = false
    d.saveEnriched(rec())
    expect(written()).toEqual(none)
    d.flushOnExit('before-quit') // the exit flush re-reads the bind too
    expect(written()).toEqual(none)
    b.bound = null // and a later run with no bind yet does not bring T1 back
    d.saveEnriched(rec())
    expect(written()).toEqual(none)
  })

  it('a session started this run: one failed lookup after its first saved target keeps it', () => {
    const { b, d, written } = rig()
    b.bound = T2
    d.saveEnriched(rec())
    expect(written()).toEqual(T2)
    b.readable = false
    d.saveEnriched(rec())
    expect(written()).toEqual(T2)
  })

  it('an in-session Restart (no bind until the new run binds) keeps the conversation it was on', () => {
    const { b, d, written } = rig()
    d.saveEnriched(restored())
    b.bound = T2
    d.saveEnriched(rec())
    b.bound = null
    d.saveEnriched(rec())
    expect(written()).toEqual(T2)
  })

  it('a clear carries nothing into the next save', () => {
    const { d, written } = rig()
    d.saveEnriched(restored())
    d.noteCleared(true)
    d.saveEnriched(rec())
    expect(written()).toEqual(none)
  })

  it('a session saved closed carries nothing into a later session with its id', () => {
    const { d, save, written } = rig()
    d.saveEnriched(restored())
    d.saveEnriched({ sessions: [], activeSessionId: null, savedAt: 2 } as SessionState)
    expect(save.mock.calls.at(-1)![0].sessions).toEqual([])
    d.saveEnriched(rec())
    expect(written()).toEqual(none)
  })
})

// aicc_planning#104, through the core with the REAL transcript
// binder: a move to T2 that reached main as an exact bind but no save, then the
// bind dropped (endRun when the CLI exits or crashes with the tab open;
// registerRun at a Restart). Every later save, and the exit flush, must save T2
// or none, never the T1 the session left. beta.2 saved none at the renderer save
// and T1 at a flush-only exit.
describe('createSessionDurability with the transcript binder: a move no save saw, then the bind dropped (aicc_planning#104)', () => {
  const T1 = { uuid: '97f30254-1111-4111-8111-111111111111', cwd: 'F:/platform_v9' }
  const T2 = { uuid: '8923cf93-2222-4222-8222-222222222222', cwd: 'F:/platform_v9' }
  const T3 = { uuid: '0b0b0b0b-3333-4333-8333-333333333333', cwd: 'F:/platform_v9' }
  const pathOf = (t: { uuid: string }) => `C:/Users/u/.claude/projects/F--platform-v9/${t.uuid}.jsonl`
  const none = { uuid: undefined, cwd: undefined }

  function rig() {
    let now = 0
    let nextId = 1
    const timers = new Map<number, { at: number; cb: () => void }>()
    const advance = (ms: number) => {
      now += ms
      for (const [id, t] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now && timers.delete(id)) t.cb()
      }
    }
    const binder = makeTranscriptBinder({
      supervisor: { bindTranscript: () => {} },
      canonicalize: (p: string) => (p.endsWith('.jsonl') ? p : null),
      heuristicBinder: { bindOnce: () => null, forget: () => {} },
      setTimer: (cb: () => void, ms: number) => { const id = nextId++; timers.set(id, { at: now + ms, cb }); return id },
      clearTimer: (id: unknown) => { timers.delete(id as number) },
      debounceMs: 100,
      heuristicDelayMs: 20_000,
    })
    /** Conversations whose transcript head cannot be read at a save. */
    const unreadable = new Set<string>()
    const save = vi.fn((_s: SessionState) => true)
    const d = createSessionDurability({
      enrichDeps: {
        getExactResumeTarget: (id: string) => binder.getExactResumeTarget(id),
        getLatestTranscriptPath: (id: string) => binder.getLatestTranscriptPath(id),
        isExactBindSourceActive: () => true,
        isBinderAvailable: () => true,
        getLastExactResumeTarget: (id: string) => binder.getLastExactResumeTarget(id),
        resolveResumeTargetFromTranscript: (p: string) => {
          const t = [T1, T2, T3].find((x) => pathOf(x) === p)
          return t && !unreadable.has(t.uuid) ? { ...t } : null
        },
      },
      save,
      retainSessions: (open: ReadonlySet<string>) => binder.retainLastExact(open),
    })
    /** A hook or status line reports the session's transcript; the debounce settles. */
    const bind = (t: { uuid: string }) => { binder.notifyTranscriptPath('rune', pathOf(t)); advance(100) }
    const written = (id = 'rune') => {
      const s = save.mock.calls.at(-1)![0].sessions.find((x) => x.id === id)
      return s ? { uuid: s.resumeUuid, cwd: s.resumeCwd } : undefined
    }
    return { binder, d, bind, unreadable, written }
  }
  const rec = (o: Record<string, unknown> = {}, extra: unknown[] = []): SessionState =>
    ({ sessions: [{ id: 'rune', provider: 'claude', ...o }, ...extra] as any, activeSessionId: 'rune', savedAt: 1 } as SessionState)
  const anotherTab = [{ id: 'other', provider: 'claude' }]

  /** Bound to T1 and saved (another tab opened), then /clear binds T2 with no save. */
  function movedWithNoSave() {
    const r = rig()
    r.binder.registerRun('rune', T1.cwd, 1)
    r.bind(T1)
    r.d.saveEnriched(rec())
    expect(r.written()).toEqual(T1)
    r.bind(T2)
    return r
  }

  it('the CLI exits after a move no save saw: a later save and the exit flush save T2, never T1', () => {
    const { binder, d, written } = movedWithNoSave()
    binder.endRun('rune') // /exit or a crash: the tab stays open
    d.saveEnriched(rec({}, anotherTab)) // the user opens another tab
    expect(written()).toEqual(T2)
    d.flushOnExit('before-quit')
    expect(written()).toEqual(T2)
  })

  it("the same with T2's head unreadable after the exit: none (the picker), never T1", () => {
    const { binder, d, unreadable, written } = movedWithNoSave()
    binder.endRun('rune')
    unreadable.add(T2.uuid)
    d.saveEnriched(rec({}, anotherTab))
    expect(written()).toEqual(none)
    d.flushOnExit('before-quit')
    expect(written()).toEqual(none)
  })

  it("a non-graceful quit with no save after the exit: the flush saves T2 over main's own earlier T1, or none when T2 cannot be read", () => {
    const read = movedWithNoSave()
    read.binder.endRun('rune')
    read.d.flushOnExit('render-process-gone')
    expect(read.written()).toEqual(T2)
    const unread = movedWithNoSave()
    unread.binder.endRun('rune')
    unread.unreadable.add(T2.uuid)
    unread.d.flushOnExit('render-process-gone')
    expect(unread.written()).toEqual(none)
  })

  it('the Restart gap, the next run registered first: a save before its resume-bind commits saves T2, and the resume-bind keeps it', () => {
    const { binder, d, bind, written } = movedWithNoSave()
    binder.registerRun('rune', T2.cwd, 2) // the respawn resets the bind
    d.saveEnriched(rec()) // e.g. the account pin saved at the Restart
    expect(written()).toEqual(T2)
    d.flushOnExit('before-quit')
    expect(written()).toEqual(T2)
    bind(T2) // the respawn's resume-bind
    d.saveEnriched(rec())
    expect(written()).toEqual(T2)
  })

  it('the Restart gap, the old run ended first (endRun, then registerRun): T2, never T1', () => {
    const { binder, d, unreadable, written } = movedWithNoSave()
    binder.endRun('rune')
    binder.registerRun('rune', T2.cwd, 2)
    d.saveEnriched(rec())
    expect(written()).toEqual(T2)
    unreadable.add(T2.uuid)
    d.saveEnriched(rec())
    expect(written()).toEqual(T2) // T2 is now what it was last saved with
  })

  it('a restored session with no exact bind this run keeps its restored target (unchanged)', () => {
    const { binder, d, written } = rig()
    d.saveEnriched(rec({ resumeUuid: T1.uuid, resumeCwd: T1.cwd })) // the restore's immediate save
    binder.registerRun('rune', T1.cwd, 1) // the spawn takes the target; no bind yet
    d.saveEnriched(rec())
    expect(written()).toEqual(T1)
    d.flushOnExit('before-quit')
    expect(written()).toEqual(T1)
  })

  it("a closed session's last bind goes with it: a later session with its id is not given it", () => {
    const { binder, d, bind, written } = rig()
    bind(T2)
    d.saveEnriched(rec())
    binder.endRun('rune')
    d.saveEnriched({ sessions: [], activeSessionId: null, savedAt: 2 } as SessionState) // the tab closed
    d.saveEnriched(rec({ resumeUuid: T3.uuid, resumeCwd: T3.cwd }))
    expect(written()).toEqual(T3)
    d.saveEnriched({ sessions: [], activeSessionId: null, savedAt: 3 } as SessionState)
    d.saveEnriched(rec())
    expect(written()).toEqual(none)
  })
})
