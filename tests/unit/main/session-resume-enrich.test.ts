import { describe, it, expect, vi } from 'vitest'
import { enrichSessionStateWithResumeTargets } from '../../../src/main/session-resume-enrich'
import type { ResumeEnrichDeps } from '../../../src/main/session-resume-enrich'
import type { SessionState } from '../../../src/main/session-state'

// #397 Group 1: main-side enrichment is the single write choke point that stamps
// each Claude session's exact-conversation resume target, so EVERY renderer writer
// persists a resumable record — not only the graceful-close path.
// #480: it must use the EXACT bind (never the heuristic), with a hooks-off
// fallback, so it can never persist a cross-prone guess in the default config.

function state(sessions: any[]): SessionState {
  return { sessions, activeSessionId: sessions[0]?.id, savedAt: 1 } as unknown as SessionState
}

const okTarget = { uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', cwd: 'C:/proj' }
const EXACT = '/x/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'
const HEUR = '/x/heuristic-sibling.jsonl'

/** Default deps: hooks ON, an exact path available, and a heuristic path that
 *  MUST NOT be consulted while hooks are on. Override per test. */
function mkDeps(over: Partial<ResumeEnrichDeps> = {}): ResumeEnrichDeps {
  return {
    getExactResumeTarget: () => EXACT,
    getLatestTranscriptPath: () => HEUR,
    isExactBindSourceActive: () => true,
    resolveResumeTargetFromTranscript: () => okTarget,
    ...over,
  }
}

describe('enrichSessionStateWithResumeTargets', () => {
  it('stamps uuid+cwd on a Claude session from the EXACT bind', () => {
    const s = state([{ id: 's1', provider: 'claude' }])
    enrichSessionStateWithResumeTargets(s, mkDeps())
    expect(s.sessions[0]).toMatchObject({ resumeUuid: okTarget.uuid, resumeCwd: okTarget.cwd })
  })

  it('treats an absent provider as claude (default) and enriches it', () => {
    const s = state([{ id: 's1' }])
    enrichSessionStateWithResumeTargets(s, mkDeps())
    expect(s.sessions[0].resumeUuid).toBe(okTarget.uuid)
  })

  it('#480 hooks-on: NEVER consults the heuristic path (no cross)', () => {
    const s = state([{ id: 's1', provider: 'claude' }])
    const getLatest = vi.fn(() => HEUR)
    enrichSessionStateWithResumeTargets(s, mkDeps({ getExactResumeTarget: () => null, getLatestTranscriptPath: getLatest }))
    expect(getLatest).not.toHaveBeenCalled()
    expect(s.sessions[0].resumeUuid).toBeUndefined()
  })

  it('#480 hooks-off: falls back to the heuristic path', () => {
    const s = state([{ id: 's1', provider: 'claude' }])
    const getLatest = vi.fn(() => HEUR)
    enrichSessionStateWithResumeTargets(s, mkDeps({
      getExactResumeTarget: () => null,
      isExactBindSourceActive: () => false,
      getLatestTranscriptPath: getLatest,
    }))
    expect(getLatest).toHaveBeenCalledWith('s1')
    expect(s.sessions[0].resumeUuid).toBe(okTarget.uuid)
  })

  it('skips shell-only sessions', () => {
    const s = state([{ id: 's1', provider: 'claude', shellOnly: true }])
    const getExact = vi.fn(() => EXACT)
    enrichSessionStateWithResumeTargets(s, mkDeps({ getExactResumeTarget: getExact }))
    expect(getExact).not.toHaveBeenCalled()
    expect(s.sessions[0].resumeUuid).toBeUndefined()
  })

  it('skips non-Claude (codex) sessions', () => {
    const s = state([{ id: 's1', provider: 'codex' }])
    const getExact = vi.fn(() => EXACT)
    enrichSessionStateWithResumeTargets(s, mkDeps({ getExactResumeTarget: getExact }))
    expect(getExact).not.toHaveBeenCalled()
    expect(s.sessions[0].resumeUuid).toBeUndefined()
  })

  it('KEEPS the existing target when there is no exact bind (hooks on, no fallback)', () => {
    const s = state([{ id: 's1', provider: 'claude', resumeUuid: 'old-uuid', resumeCwd: 'C:/old' }])
    enrichSessionStateWithResumeTargets(s, mkDeps({ getExactResumeTarget: () => null }))
    expect(s.sessions[0]).toMatchObject({ resumeUuid: 'old-uuid', resumeCwd: 'C:/old' })
  })

  it('KEEPS the existing target when the transcript does not resolve a target and the bind names that same conversation', () => {
    const s = state([{ id: 's1', provider: 'claude', resumeUuid: okTarget.uuid, resumeCwd: 'C:/old' }])
    enrichSessionStateWithResumeTargets(s, mkDeps({ resolveResumeTargetFromTranscript: () => null }))
    expect(s.sessions[0]).toMatchObject({ resumeUuid: okTarget.uuid, resumeCwd: 'C:/old' })
  })

  // aicc_planning#104: the file name still says which
  // conversation the session is on. A target for another one is older (the
  // session moved on with /clear or /resume), and reopening it would silently
  // resume the wrong conversation, so none is saved: the picker, as before.
  it('DROPS the existing target when the transcript does not resolve and the bind names another conversation', () => {
    const s = state([{ id: 's1', provider: 'claude', resumeUuid: '11111111-2222-4333-8444-555555555555', resumeCwd: 'C:/old' }])
    enrichSessionStateWithResumeTargets(s, mkDeps({ resolveResumeTargetFromTranscript: () => null }))
    expect(s.sessions[0].resumeUuid).toBeUndefined()
    expect(s.sessions[0].resumeCwd).toBeUndefined()
  })

  it('never throws on a per-session dep failure; leaves that record unchanged and continues', () => {
    const s = state([
      { id: 'bad', provider: 'claude', resumeUuid: 'keep' },
      { id: 'good', provider: 'claude' },
    ])
    enrichSessionStateWithResumeTargets(s, mkDeps({
      getExactResumeTarget: (id) => {
        if (id === 'bad') throw new Error('binder blew up')
        return EXACT
      },
    }))
    expect(s.sessions[0].resumeUuid).toBe('keep')          // untouched despite the throw
    expect(s.sessions[1].resumeUuid).toBe(okTarget.uuid)   // later session still enriched
  })

  it('is a whole no-op on a non-array sessions field', () => {
    const s = { sessions: undefined, savedAt: 1 } as unknown as SessionState
    expect(() => enrichSessionStateWithResumeTargets(s, mkDeps())).not.toThrow()
  })
})

// aicc_planning#104: TerminalView takes a restored session's target off its
// record at the first spawn, so the renderer's record carries none from then
// on. One failed lookup at save time (a transcript head that cannot be read, a
// binder that has not bound yet) used to save the session with no target, and
// the next launch started it fresh. Main now carries the target the session
// had in the state it saved before, but only ever the conversation the session
// is still on.
describe('enrichSessionStateWithResumeTargets carries the last saved target (aicc_planning#104)', () => {
  const T1 = { uuid: '97f30254-1111-4111-8111-111111111111', cwd: 'F:/platform_v9' }
  const T2 = { uuid: '8923cf93-2222-4222-8222-222222222222', cwd: 'F:/platform_v9' }
  const T3 = { uuid: '0b0b0b0b-3333-4333-8333-333333333333', cwd: 'F:/elsewhere' }
  const pathOf = (t: { uuid: string }) => `C:\\Users\\u\\.claude\\projects\\F--platform-v9\\${t.uuid}.jsonl`
  const prev = (sessions: any[]) => state(sessions)
  const unreadable = { resolveResumeTargetFromTranscript: () => null }
  /** A binder is running (logging on at start). */
  const live = { isBinderAvailable: () => true }
  const targetOf = (s: SessionState, i = 0) => ({ uuid: s.sessions[i].resumeUuid, cwd: s.sessions[i].resumeCwd })
  const none = { uuid: undefined, cwd: undefined }

  it('no bind yet: a record with no target takes the one it was last saved with', () => {
    const s = state([{ id: 'rune', provider: 'claude' }])
    enrichSessionStateWithResumeTargets(s, mkDeps({ getExactResumeTarget: () => null, ...live }), prev([{ id: 'rune', provider: 'claude', resumeUuid: T1.uuid, resumeCwd: T1.cwd }]))
    expect(targetOf(s)).toEqual(T1)
  })

  // With no binder, or the hooks off, a move to another conversation (/clear,
  // /resume) would never reach main as a new bind, so a target carried with no
  // bind could outlive its conversation: none, as before #104.
  it('no binder running (logging off at start): a record with no target keeps none', () => {
    const s = state([{ id: 'rune', provider: 'claude' }])
    enrichSessionStateWithResumeTargets(s, mkDeps({ getExactResumeTarget: () => null, isBinderAvailable: () => false }), prev([{ id: 'rune', provider: 'claude', resumeUuid: T1.uuid, resumeCwd: T1.cwd }]))
    expect(targetOf(s)).toEqual(none)
    const absent = state([{ id: 'rune', provider: 'claude' }])
    enrichSessionStateWithResumeTargets(absent, mkDeps({ getExactResumeTarget: () => null }), prev([{ id: 'rune', provider: 'claude', resumeUuid: T1.uuid, resumeCwd: T1.cwd }]))
    expect(targetOf(absent)).toEqual(none)
  })

  it('hooks off and no bind: a record with no target keeps none', () => {
    const s = state([{ id: 'rune', provider: 'claude' }])
    enrichSessionStateWithResumeTargets(s, mkDeps({ getExactResumeTarget: () => null, isExactBindSourceActive: () => false, getLatestTranscriptPath: () => null, ...live }), prev([{ id: 'rune', provider: 'claude', resumeUuid: T1.uuid, resumeCwd: T1.cwd }]))
    expect(targetOf(s)).toEqual(none)
  })

  it("no bind yet: the record's own target wins over the last saved one", () => {
    const s = state([{ id: 'rune', provider: 'claude', resumeUuid: T3.uuid, resumeCwd: T3.cwd }])
    enrichSessionStateWithResumeTargets(s, mkDeps({ getExactResumeTarget: () => null, ...live }), prev([{ id: 'rune', provider: 'claude', resumeUuid: T1.uuid, resumeCwd: T1.cwd }]))
    expect(targetOf(s)).toEqual(T3)
  })

  it('bound, head unreadable, same conversation as last saved: kept (a session started this run included)', () => {
    const s = state([{ id: 'new', provider: 'claude' }])
    enrichSessionStateWithResumeTargets(s, mkDeps({ getExactResumeTarget: () => pathOf(T2), ...unreadable }), prev([{ id: 'new', provider: 'claude', resumeUuid: T2.uuid, resumeCwd: T2.cwd }]))
    expect(targetOf(s)).toEqual(T2)
  })

  it('the conversation id is matched whatever its case', () => {
    const s = state([{ id: 'new', provider: 'claude' }])
    enrichSessionStateWithResumeTargets(s, mkDeps({ getExactResumeTarget: () => pathOf({ uuid: T2.uuid.toUpperCase() }), ...unreadable }), prev([{ id: 'new', provider: 'claude', resumeUuid: T2.uuid, resumeCwd: T2.cwd }]))
    expect(targetOf(s)).toEqual(T2)
  })

  it('bound to ANOTHER conversation whose head cannot be read: never the older one, none is saved', () => {
    const s = state([{ id: 'rune', provider: 'claude' }])
    enrichSessionStateWithResumeTargets(s, mkDeps({ getExactResumeTarget: () => pathOf(T2), ...unreadable }), prev([{ id: 'rune', provider: 'claude', resumeUuid: T1.uuid, resumeCwd: T1.cwd }]))
    expect(targetOf(s)).toEqual(none)
  })

  it('hooks off: the heuristic bind is read the same way', () => {
    const deps = mkDeps({ getExactResumeTarget: () => null, isExactBindSourceActive: () => false, getLatestTranscriptPath: () => pathOf(T2), ...unreadable })
    const kept = state([{ id: 'a', provider: 'claude' }])
    enrichSessionStateWithResumeTargets(kept, deps, prev([{ id: 'a', provider: 'claude', resumeUuid: T2.uuid, resumeCwd: T2.cwd }]))
    expect(targetOf(kept)).toEqual(T2)
    const dropped = state([{ id: 'a', provider: 'claude' }])
    enrichSessionStateWithResumeTargets(dropped, deps, prev([{ id: 'a', provider: 'claude', resumeUuid: T1.uuid, resumeCwd: T1.cwd }]))
    expect(targetOf(dropped)).toEqual(none)
  })

  it('a bind whose file name is no conversation id says nothing: the last saved target is carried', () => {
    const s = state([{ id: 'rune', provider: 'claude' }])
    enrichSessionStateWithResumeTargets(s, mkDeps({ getExactResumeTarget: () => '/x/not-a-conversation.jsonl', ...unreadable, ...live }), prev([{ id: 'rune', provider: 'claude', resumeUuid: T1.uuid, resumeCwd: T1.cwd }]))
    expect(targetOf(s)).toEqual(T1)
  })

  it('a lookup that resolves always wins over the last saved target', () => {
    const s = state([{ id: 'rune', provider: 'claude' }])
    enrichSessionStateWithResumeTargets(s, mkDeps({ getExactResumeTarget: () => pathOf(T2), resolveResumeTargetFromTranscript: () => T2 }), prev([{ id: 'rune', provider: 'claude', resumeUuid: T1.uuid, resumeCwd: T1.cwd }]))
    expect(targetOf(s)).toEqual(T2)
  })

  it('each session carries only its own; a session not in the earlier state gets nothing', () => {
    const s = state([{ id: 'a', provider: 'claude' }, { id: 'b', provider: 'claude' }, { id: 'c', provider: 'claude' }])
    enrichSessionStateWithResumeTargets(s, mkDeps({ getExactResumeTarget: () => null, ...live }), prev([
      { id: 'a', provider: 'claude', resumeUuid: T1.uuid, resumeCwd: T1.cwd },
      { id: 'b', provider: 'claude', resumeUuid: T2.uuid, resumeCwd: T2.cwd },
    ]))
    expect(targetOf(s, 0)).toEqual(T1)
    expect(targetOf(s, 1)).toEqual(T2)
    expect(targetOf(s, 2)).toEqual(none)
  })

  it('carries only a conversation id with a directory, and never from a Codex or terminal-only record', () => {
    const s = state([{ id: 'bad', provider: 'claude' }, { id: 'nocwd', provider: 'claude' }, { id: 'cx', provider: 'claude' }, { id: 'sh', provider: 'claude' }])
    enrichSessionStateWithResumeTargets(s, mkDeps({ getExactResumeTarget: () => null, ...live }), prev([
      { id: 'bad', provider: 'claude', resumeUuid: 'not-a-conversation', resumeCwd: 'C:/x' },
      { id: 'nocwd', provider: 'claude', resumeUuid: T1.uuid },
      { id: 'cx', provider: 'codex', resumeUuid: T2.uuid, resumeCwd: T2.cwd },
      { id: 'sh', provider: 'claude', shellOnly: true, resumeUuid: T3.uuid, resumeCwd: T3.cwd },
    ]))
    for (let i = 0; i < 4; i++) expect(targetOf(s, i)).toEqual(none)
  })

  it('a Codex or terminal-only session is never given a carried Claude target', () => {
    const s = state([{ id: 'cx', provider: 'codex' }, { id: 'sh', provider: 'claude', shellOnly: true }])
    enrichSessionStateWithResumeTargets(s, mkDeps({ getExactResumeTarget: () => null, ...live }), prev([
      { id: 'cx', provider: 'claude', resumeUuid: T1.uuid, resumeCwd: T1.cwd },
      { id: 'sh', provider: 'claude', resumeUuid: T2.uuid, resumeCwd: T2.cwd },
    ]))
    expect(targetOf(s, 0)).toEqual(none)
    expect(targetOf(s, 1)).toEqual(none)
  })

  it('an earlier state that cannot be read carries nothing and never throws', () => {
    const s = state([{ id: 'rune', provider: 'claude' }])
    const broken = { get sessions() { throw new Error('gone') } } as unknown as SessionState
    expect(() => enrichSessionStateWithResumeTargets(s, mkDeps({ getExactResumeTarget: () => null, ...live }), broken)).not.toThrow()
    expect(targetOf(s)).toEqual(none)
  })
})

// aicc_planning#104: /clear or /resume moves the session to T2
// with no save, then its bind is dropped (the CLI exits or crashes with the tab
// open, or a Restart's next run has not bound yet). With no live bind, the last
// exact bind main saw (kept across the run's end) decides, read like a live
// one, so neither the target last saved (T1) nor, on an exit flush, the
// record's own earlier one can bring T1 back.
describe('enrichSessionStateWithResumeTargets reads the last exact bind when the live one is gone (aicc_planning#104)', () => {
  const T1 = { uuid: '97f30254-1111-4111-8111-111111111111', cwd: 'F:/platform_v9' }
  const T2 = { uuid: '8923cf93-2222-4222-8222-222222222222', cwd: 'F:/platform_v9' }
  const T3 = { uuid: '0b0b0b0b-3333-4333-8333-333333333333', cwd: 'F:/elsewhere' }
  const pathOf = (t: { uuid: string }) => `C:\\Users\\u\\.claude\\projects\\F--platform-v9\\${t.uuid}.jsonl`
  /** Only these transcripts' heads can be read. */
  const readable = (...ts: Array<{ uuid: string; cwd: string }>) => ({
    resolveResumeTargetFromTranscript: (p: string) => {
      const t = ts.find((x) => pathOf(x) === p)
      return t ? { ...t } : null
    },
  })
  const unbound = { getExactResumeTarget: () => null, isBinderAvailable: () => true }
  const lastBind = (t: { uuid: string }) => ({ getLastExactResumeTarget: () => pathOf(t) })
  const savedOn = (t: { uuid: string; cwd: string }) => state([{ id: 'rune', provider: 'claude', resumeUuid: t.uuid, resumeCwd: t.cwd }])
  const targetOf = (s: SessionState) => ({ uuid: s.sessions[0].resumeUuid, cwd: s.sessions[0].resumeCwd })
  const none = { uuid: undefined, cwd: undefined }

  it('the last exact bind T2 can be read: T2, not the T1 the session was last saved with', () => {
    const s = state([{ id: 'rune', provider: 'claude' }])
    enrichSessionStateWithResumeTargets(s, mkDeps({ ...unbound, ...lastBind(T2), ...readable(T1, T2) }), savedOn(T1))
    expect(targetOf(s)).toEqual(T2)
  })

  it('the last exact bind T2 cannot be read: none, never the older T1', () => {
    const s = state([{ id: 'rune', provider: 'claude' }])
    enrichSessionStateWithResumeTargets(s, mkDeps({ ...unbound, ...lastBind(T2), ...readable(T1) }), savedOn(T1))
    expect(targetOf(s)).toEqual(none)
  })

  it('the last exact bind cannot be read but is the conversation last saved: kept', () => {
    const s = state([{ id: 'rune', provider: 'claude' }])
    enrichSessionStateWithResumeTargets(s, mkDeps({ ...unbound, ...lastBind(T2), ...readable() }), savedOn(T2))
    expect(targetOf(s)).toEqual(T2)
  })

  it("an exit flush's own earlier target T1 gives way to the last exact bind T2, or to none when T2 cannot be read", () => {
    const read = savedOn(T1)
    enrichSessionStateWithResumeTargets(read, mkDeps({ ...unbound, ...lastBind(T2), ...readable(T1, T2) }), read)
    expect(targetOf(read)).toEqual(T2)
    const unread = savedOn(T1)
    enrichSessionStateWithResumeTargets(unread, mkDeps({ ...unbound, ...lastBind(T2), ...readable(T1) }), unread)
    expect(targetOf(unread)).toEqual(none)
    const same = savedOn(T1)
    enrichSessionStateWithResumeTargets(same, mkDeps({ ...unbound, ...lastBind(T1), ...readable() }), same)
    expect(targetOf(same)).toEqual(T1)
  })

  it('a live bind wins, and the last exact bind is not read', () => {
    const s = state([{ id: 'rune', provider: 'claude' }])
    const getLast = vi.fn(() => pathOf(T2))
    enrichSessionStateWithResumeTargets(s, mkDeps({ getExactResumeTarget: () => pathOf(T3), getLastExactResumeTarget: getLast, ...readable(T2, T3) }), savedOn(T1))
    expect(targetOf(s)).toEqual(T3)
    expect(getLast).not.toHaveBeenCalled()
  })

  it('hooks off: a live heuristic bind wins over the last exact bind', () => {
    const s = state([{ id: 'rune', provider: 'claude' }])
    enrichSessionStateWithResumeTargets(s, mkDeps({ ...unbound, isExactBindSourceActive: () => false, getLatestTranscriptPath: () => pathOf(T3), ...lastBind(T2), ...readable(T2, T3) }), savedOn(T1))
    expect(targetOf(s)).toEqual(T3)
  })

  it('no exact bind this run: the carry is unchanged (a restored session before its first bind)', () => {
    const s = state([{ id: 'rune', provider: 'claude' }])
    enrichSessionStateWithResumeTargets(s, mkDeps({ ...unbound, getLastExactResumeTarget: () => null, ...readable() }), savedOn(T1))
    expect(targetOf(s)).toEqual(T1)
  })
})

// P3.5 (row 34): a Codex session keeps the conversation it is on (pty-manager's
// kept conversation), and session:save persists it the way it persists a
// Claude tab's, so a relaunch resumes it (`codex resume <id>`).
describe('enrichSessionStateWithResumeTargets for a Codex session (P3.5)', () => {
  const CODEX = { uuid: '019dd000-0001-7000-8000-0000000000e1', cwd: 'C:/p/demo' }

  it('persists the conversation the tab is on, from its provider, never from the Claude binder', () => {
    const s = state([{ id: 's1', provider: 'codex' }])
    const getExact = vi.fn(() => EXACT)
    enrichSessionStateWithResumeTargets(s, mkDeps({ getExactResumeTarget: getExact, getProviderResumeTarget: () => CODEX }))
    expect(getExact).not.toHaveBeenCalled()
    expect(s.sessions[0]).toMatchObject({ resumeUuid: CODEX.uuid, resumeCwd: CODEX.cwd })
  })

  it('keeps what the record carried while the tab is on no known conversation', () => {
    const s = state([{ id: 's1', provider: 'codex', resumeUuid: CODEX.uuid, resumeCwd: 'C:/old' }])
    enrichSessionStateWithResumeTargets(s, mkDeps({ getProviderResumeTarget: () => null }))
    expect(s.sessions[0]).toMatchObject({ resumeUuid: CODEX.uuid, resumeCwd: 'C:/old' })
  })

  it('persists only a conversation id, with a directory', () => {
    const s = state([{ id: 's1', provider: 'codex' }, { id: 's2', provider: 'codex' }])
    enrichSessionStateWithResumeTargets(s, mkDeps({ getProviderResumeTarget: (id) => (id === 's1' ? { uuid: '--resume', cwd: 'C:/p' } : { uuid: CODEX.uuid, cwd: '' }) }))
    expect(s.sessions[0].resumeUuid).toBeUndefined()
    expect(s.sessions[1].resumeUuid).toBeUndefined()
  })

  it('never for a shell-only tab, and a Claude tab never takes it', () => {
    const provider = vi.fn(() => CODEX)
    const s = state([{ id: 's1', provider: 'codex', shellOnly: true }, { id: 's2', provider: 'claude' }])
    enrichSessionStateWithResumeTargets(s, mkDeps({ getExactResumeTarget: () => null, getProviderResumeTarget: provider }))
    expect(provider).not.toHaveBeenCalled()
    expect(s.sessions[0].resumeUuid).toBeUndefined()
    expect(s.sessions[1].resumeUuid).toBeUndefined()
  })
})

// P3.6 (ADR-009 round 1, B1; owner decision): the Codex conversations whose
// claim was not certain are saved with the state, so a relaunch that resumes
// one still never has it carried by a Switch account. Main writes the list at
// every save (only the ones a saved session is on) and reads it back at load.
describe('enrichSessionStateWithResumeTargets keeps the uncertain claims (P3.6)', () => {
  const ON = '019dd000-0001-7000-8000-0000000000f1'
  const GONE = '019dd000-0001-7000-8000-0000000000f2'

  it('writes those a saved session is on, whatever their case; drops the rest; and removes the list when none is left', () => {
    const s = state([{ id: 's1', provider: 'codex' }, { id: 's2', provider: 'codex' }])
    enrichSessionStateWithResumeTargets(s, mkDeps({
      getProviderResumeTarget: (id) => (id === 's1' ? { uuid: ON, cwd: 'C:/p' } : null),
      getUncertainProviderConversations: () => [ON.toUpperCase(), GONE],
    }))
    expect(s.codexUncertainConversations).toEqual([ON.toUpperCase()])
    const later = state([{ id: 's1', provider: 'codex', resumeUuid: GONE, resumeCwd: 'C:/p' }])
    later.codexUncertainConversations = [ON]
    enrichSessionStateWithResumeTargets(later, mkDeps({ getProviderResumeTarget: () => null, getUncertainProviderConversations: () => [ON] }))
    expect(later.codexUncertainConversations).toBeUndefined()
  })

  it('without the source, the saved list is left as it is; a source that throws leaves it too', () => {
    const s = state([{ id: 's1', provider: 'codex', resumeUuid: ON, resumeCwd: 'C:/p' }])
    s.codexUncertainConversations = [ON]
    enrichSessionStateWithResumeTargets(s, mkDeps())
    expect(s.codexUncertainConversations).toEqual([ON])
    enrichSessionStateWithResumeTargets(s, mkDeps({ getUncertainProviderConversations: () => { throw new Error('x') } }))
    expect(s.codexUncertainConversations).toEqual([ON])
  })

  // ADR-009 round 2 (C8): the list is main's own; where the saved sessions
  // cannot be read, main's whole list is written, never the renderer's.
  it('saved sessions that cannot be read: main\'s whole list is written, replacing the one the renderer sent', () => {
    const odd = { id: 's1', provider: 'codex' }
    Object.defineProperty(odd, 'resumeUuid', { get() { throw new Error('unreadable') }, enumerable: true })
    const s = state([odd])
    s.codexUncertainConversations = ['019dd000-0001-7000-8000-0000000000f9']
    enrichSessionStateWithResumeTargets(s, mkDeps({ getUncertainProviderConversations: () => [ON, GONE] }))
    expect(s.codexUncertainConversations).toEqual([ON, GONE])
  })
})

// P3.7 (row 36): each conversation's running time, main's own, is saved with
// the state at every save (whichever tabs are open: a closed tab's
// conversation can be resumed later), so a relaunch carries it on.
describe('enrichSessionStateWithResumeTargets saves the conversations\' running time (P3.7)', () => {
  const MAIN = [{ id: '019dd000-0001-7000-8000-0000000000f1', ms: 5_000, until: 100 }]

  it('writes main\'s list, replacing the one the renderer sent; an empty one removes it', () => {
    const s = state([{ id: 's1', provider: 'codex' }])
    s.conversationRunningTimes = [{ id: '019dd000-0001-7000-8000-0000000000f9', ms: 999_999, until: 5 }]
    enrichSessionStateWithResumeTargets(s, mkDeps({ getConversationRunningTimes: () => MAIN }))
    expect(s.conversationRunningTimes).toEqual(MAIN)
    enrichSessionStateWithResumeTargets(s, mkDeps({ getConversationRunningTimes: () => [] }))
    expect(s.conversationRunningTimes).toBeUndefined()
  })

  it('without the source, the saved list is left as it is', () => {
    const s = state([{ id: 's1', provider: 'codex' }])
    s.conversationRunningTimes = MAIN
    enrichSessionStateWithResumeTargets(s, mkDeps())
    expect(s.conversationRunningTimes).toEqual(MAIN)
  })

  // Review fix 5: the list is main's own; when main cannot give it, none is
  // written, never the renderer's (unlike the uncertain list, which keeps the
  // state's own copy when its getter throws: the test above).
  it('a source that throws or gives no list: the list the renderer sent is removed', () => {
    const s = state([{ id: 's1', provider: 'codex' }])
    s.conversationRunningTimes = MAIN
    enrichSessionStateWithResumeTargets(s, mkDeps({ getConversationRunningTimes: () => { throw new Error('x') } }))
    expect(s.conversationRunningTimes).toBeUndefined()
    s.conversationRunningTimes = MAIN
    enrichSessionStateWithResumeTargets(s, mkDeps({ getConversationRunningTimes: () => 'not a list' as never }))
    expect(s.conversationRunningTimes).toBeUndefined()
  })
})
