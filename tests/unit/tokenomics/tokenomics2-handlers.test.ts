import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (e: any, a: any) => any>()
vi.mock('electron', () => ({ ipcMain: { handle: (ch: string, fn: any) => handlers.set(ch, fn) } }))

let stubSup: any
// 2.1.3-beta.4: the service's switch, the accounts it leaves out, and who
// asked to be told of a supervisor starting.
const svc = vi.hoisted(() => ({ off: false, excluded: [] as string[], starts: [] as Array<(sup: any) => void> }))
vi.mock('../../../src/main/tokenomics/tokenomics-service', () => ({
  getTokenomicsSupervisor: () => stubSup,
  isTokenomicsOff: () => svc.off,
  tokenomicsExcludedAccounts: () => [...svc.excluded],
  onTokenomicsStart: (cb: (sup: any) => void) => { svc.starts.push(cb); if (stubSup) cb(stubSup); return () => {} },
}))

import { registerTokenomics2Handlers } from '../../../src/main/ipc/tokenomics2-handlers'
import { IPC } from '../../../src/shared/ipc-channels'

const win = { isDestroyed: () => false, webContents: { send: vi.fn() } }

describe('tokenomics2 handlers', () => {
  beforeEach(() => {
    handlers.clear()
    svc.off = false; svc.excluded = []; svc.starts.length = 0
    const progressSubs: any[] = []; const completeSubs: any[] = []; const errorSubs: any[] = []; const readySubs: any[] = []
    win.webContents.send.mockClear()
    stubSup = {
      query: vi.fn(async (kind: string) => {
        if (kind === 'summary') return [{ kpis: {} }]
        if (kind === 'sessions') return [{ rows: [{ sessionId: 's1' }], nextCursor: null }]
        if (kind === 'session-detail') return [{ sessionId: 's1' }]
        if (kind === 'index-status') return [{ firstIndexComplete: true, indexing: false, filesDone: 1, filesTotal: 1, eventsTotal: 5, lastIndexAt: 1 }]
        return []
      }),
      getIndexStatus: vi.fn(() => ({ firstIndexComplete: false, indexing: false, filesDone: 0, filesTotal: 0, eventsTotal: 0, lastIndexAt: null, error: 'open failed' })),
      onIndexProgress: (cb: any) => { progressSubs.push(cb); return () => {} },
      onIndexComplete: (cb: any) => { completeSubs.push(cb); return () => {} },
      onIndexError: (cb: any) => { errorSubs.push(cb); return () => {} },
      onIndexReady: (cb: any) => { readySubs.push(cb); return () => {} },
      _progressSubs: progressSubs, _completeSubs: completeSubs, _errorSubs: errorSubs, _readySubs: readySubs,
    }
    registerTokenomics2Handlers(() => win as any)
  })

  it('summary handler validates + unwraps rows[0]', async () => {
    const r = await handlers.get(IPC.TOKENOMICS2_SUMMARY)!({}, { configId: 'a' })
    expect(r).toEqual({ kpis: {} })
    expect(stubSup.query).toHaveBeenCalledWith('summary', { configId: 'a' })
  })

  it('sessions handler returns the page', async () => {
    const r = await handlers.get(IPC.TOKENOMICS2_SESSIONS)!({}, {})
    expect(r.rows[0].sessionId).toBe('s1')
  })

  it('sessionDetail validates sessionId (rejects when missing)', async () => {
    const r = await handlers.get(IPC.TOKENOMICS2_SESSION_DETAIL)!({}, { sessionId: 's1' })
    expect(r.sessionId).toBe('s1')
    await expect(handlers.get(IPC.TOKENOMICS2_SESSION_DETAIL)!({}, {})).rejects.toBeTruthy()
  })

  it('indexStatus returns worker DB-truth', async () => {
    const r = await handlers.get(IPC.TOKENOMICS2_INDEX_STATUS)!({}, undefined)
    expect(r.firstIndexComplete).toBe(true)
    expect(r.eventsTotal).toBe(5)
  })

  it('rejects malformed summary args (Zod strict)', async () => {
    await expect(handlers.get(IPC.TOKENOMICS2_SUMMARY)!({}, { bogus: 1 })).rejects.toBeTruthy()
  })

  it('forwards index-progress/complete to the window', () => {
    stubSup._progressSubs[0]({ filesDone: 1, filesTotal: 2, eventsIngested: 3, phase: 'initial' })
    stubSup._completeSubs[0]({ firstIndex: true, eventsTotal: 5 })
    expect(win.webContents.send).toHaveBeenCalledWith(IPC.TOKENOMICS2_INDEX_PROGRESS, expect.anything())
    expect(win.webContents.send).toHaveBeenCalledWith(IPC.TOKENOMICS2_INDEX_COMPLETE, expect.anything())
  })

  it('forwards an uncorrelated worker fault on the INDEX_STATUS channel', () => {
    stubSup._errorSubs[0]({ firstIndexComplete: false, indexing: false, error: 'open failed', filesDone: 0, filesTotal: 0, eventsTotal: 0, lastIndexAt: null })
    expect(win.webContents.send).toHaveBeenCalledWith(IPC.TOKENOMICS2_INDEX_STATUS, expect.objectContaining({ error: 'open failed', indexing: false }))
  })

  it('indexStatus falls back to the supervisor status (with error) when the worker query rejects', async () => {
    stubSup.query = vi.fn(async () => { throw new Error('worker not ready') })
    const r = await handlers.get(IPC.TOKENOMICS2_INDEX_STATUS)!({}, undefined)
    expect(r.error).toBe('open failed')
    expect(r.indexing).toBe(false)
  })
})

// Usage track MP9: the provider and account filters, and the accounts query.
describe('tokenomics2 handlers: provider and account (usage track MP9)', () => {
  beforeEach(() => {
    handlers.clear()
    svc.off = false; svc.excluded = []; svc.starts.length = 0
    stubSup = {
      query: vi.fn(async (kind: string) => {
        if (kind === 'summary') return [{ kpis: {} }]
        if (kind === 'sessions') return [{ rows: [], nextCursor: null }]
        if (kind === 'accounts') return [[{ provider: 'codex', accountKey: 'codex:external' }]]
        return []
      }),
      onIndexProgress: () => () => {}, onIndexComplete: () => () => {}, onIndexError: () => () => {}, onIndexReady: () => () => {},
    }
    registerTokenomics2Handlers(() => win as any)
  })

  it('summary and sessions take a provider and an account key, not recorded included', async () => {
    for (const f of [{ provider: 'codex', accountKey: 'codex:acct-0123abcd' }, { provider: 'claude' }, { accountKey: '' }, { accountKey: 'codex:external' }]) {
      await handlers.get(IPC.TOKENOMICS2_SUMMARY)!({}, f)
      expect(stubSup.query).toHaveBeenLastCalledWith('summary', f)
      await handlers.get(IPC.TOKENOMICS2_SESSIONS)!({}, { ...f, limit: 10 })
      expect(stubSup.query).toHaveBeenLastCalledWith('sessions', { ...f, limit: 10 })
    }
  })

  it('refuses an unknown provider and any account key that is not "" or provider:id, before the worker is asked', async () => {
    const bad: unknown[] = [
      { provider: 'gemini' }, { provider: '' }, { provider: 1 },
      { accountKey: 'codex' }, { accountKey: 'codex:' }, { accountKey: 'gemini:x' }, { accountKey: 'codex:a b' },
      { accountKey: "codex:x' OR 1=1" }, { accountKey: 'codex:' + 'a'.repeat(129) }, { accountKey: null }, { accountKey: 7 },
    ]
    for (const f of bad) {
      await expect(handlers.get(IPC.TOKENOMICS2_SUMMARY)!({}, f), JSON.stringify(f)).rejects.toBeTruthy()
      await expect(handlers.get(IPC.TOKENOMICS2_SESSIONS)!({}, f), JSON.stringify(f)).rejects.toBeTruthy()
    }
    expect(stubSup.query).not.toHaveBeenCalled()
  })

  it('the accounts query takes nothing and answers the list', async () => {
    expect(await handlers.get(IPC.TOKENOMICS2_ACCOUNTS)!({}, {})).toEqual([{ provider: 'codex', accountKey: 'codex:external' }])
    expect(stubSup.query).toHaveBeenLastCalledWith('accounts', {})
    expect(await handlers.get(IPC.TOKENOMICS2_ACCOUNTS)!({}, undefined)).toEqual([{ provider: 'codex', accountKey: 'codex:external' }])
    await expect(handlers.get(IPC.TOKENOMICS2_ACCOUNTS)!({}, { provider: 'codex' })).rejects.toBeTruthy()
    stubSup.query.mockResolvedValueOnce([])
    expect(await handlers.get(IPC.TOKENOMICS2_ACCOUNTS)!({}, {})).toEqual([])
  })
})

// 2.1.3-beta.4: Tokenomics as an optional service. Switched off there is no
// supervisor and every handler answers that plainly; the page's Rescan; the
// accounts Settings leaves out, added to every query here; and the pushes of
// a supervisor started later.
describe('tokenomics2 handlers: the optional service (2.1.3-beta.4)', () => {
  const A = 'claude:acct-a'
  function stub(): any {
    const subs = { progress: [] as any[], complete: [] as any[], error: [] as any[], ready: [] as any[] }
    return {
      query: vi.fn(async (kind: string) => {
        if (kind === 'summary') return [{ kpis: {} }]
        if (kind === 'sessions') return [{ rows: [{ sessionId: 's1' }], nextCursor: null }]
        if (kind === 'session-detail') return [{ sessionId: 's1' }]
        if (kind === 'accounts') return [[{ provider: 'claude', accountKey: A }]]
        return []
      }),
      // True: a worker is there, or will be, to read everything again.
      rescan: vi.fn(() => true),
      getIndexStatus: vi.fn(() => ({ firstIndexComplete: false, indexing: true, filesDone: 0, filesTotal: 0, eventsTotal: 0, lastIndexAt: null })),
      onIndexProgress: (cb: any) => { subs.progress.push(cb); return () => {} },
      onIndexComplete: (cb: any) => { subs.complete.push(cb); return () => {} },
      onIndexError: (cb: any) => { subs.error.push(cb); return () => {} },
      onIndexReady: (cb: any) => { subs.ready.push(cb); return () => {} },
      _subs: subs,
    }
  }
  beforeEach(() => {
    handlers.clear()
    svc.off = false; svc.excluded = []; svc.starts.length = 0
    win.webContents.send.mockClear()
    stubSup = stub()
  })

  it('switched off, every handler answers "off" and nothing is asked of a supervisor', async () => {
    stubSup = undefined
    svc.off = true
    registerTokenomics2Handlers(() => win as any)
    expect(await handlers.get(IPC.TOKENOMICS2_SUMMARY)!({}, { configId: 'a' })).toBeNull()
    expect(await handlers.get(IPC.TOKENOMICS2_SESSIONS)!({}, {})).toEqual({ rows: [], nextCursor: null })
    expect(await handlers.get(IPC.TOKENOMICS2_SESSION_DETAIL)!({}, { sessionId: 's1' })).toBeNull()
    expect(await handlers.get(IPC.TOKENOMICS2_ACCOUNTS)!({}, {})).toEqual([])
    expect(await handlers.get(IPC.TOKENOMICS2_ACCOUNTS)!({}, { includeExcluded: true })).toEqual([])
    expect(await handlers.get(IPC.TOKENOMICS2_RESCAN)!({}, undefined)).toEqual({ ok: false, reason: 'off' })
    const status = await handlers.get(IPC.TOKENOMICS2_INDEX_STATUS)!({}, undefined)
    expect(status).toMatchObject({ off: true, indexing: false, firstIndexComplete: false })
  })

  it('switched off, a supervisor still shutting down is not asked either, and arguments are still checked', async () => {
    svc.off = true
    registerTokenomics2Handlers(() => win as any)
    expect(await handlers.get(IPC.TOKENOMICS2_SUMMARY)!({}, {})).toBeNull()
    expect(await handlers.get(IPC.TOKENOMICS2_RESCAN)!({}, undefined)).toEqual({ ok: false, reason: 'off' })
    expect(stubSup.query).not.toHaveBeenCalled()
    expect(stubSup.rescan).not.toHaveBeenCalled()
    await expect(handlers.get(IPC.TOKENOMICS2_SUMMARY)!({}, { bogus: 1 })).rejects.toBeTruthy()
    await expect(handlers.get(IPC.TOKENOMICS2_SESSION_DETAIL)!({}, {})).rejects.toBeTruthy()
  })

  it('switched on with no supervisor (it could not start): queries reject at once, the status is the plain default, Rescan says so', async () => {
    stubSup = undefined
    registerTokenomics2Handlers(() => win as any)
    await expect(handlers.get(IPC.TOKENOMICS2_SUMMARY)!({}, {})).rejects.toThrow(/not running/)
    const status = await handlers.get(IPC.TOKENOMICS2_INDEX_STATUS)!({}, undefined)
    expect(status.off).toBeUndefined()
    expect(await handlers.get(IPC.TOKENOMICS2_RESCAN)!({}, undefined)).toEqual({ ok: false, reason: 'not-running' })
  })

  it('Rescan asks the supervisor once and says it started', async () => {
    registerTokenomics2Handlers(() => win as any)
    expect(await handlers.get(IPC.TOKENOMICS2_RESCAN)!({}, undefined)).toEqual({ ok: true })
    expect(stubSup.rescan).toHaveBeenCalledTimes(1)
  })

  // The page shows "Rescanning" and disables the button on a yes, until a
  // pass says it is done: a yes with no worker left to run that pass would
  // leave it so until the app is started again.
  it('Rescan says it is not running when the supervisor has no worker left to read again', async () => {
    stubSup.rescan = vi.fn(() => false)
    registerTokenomics2Handlers(() => win as any)
    expect(await handlers.get(IPC.TOKENOMICS2_RESCAN)!({}, undefined)).toEqual({ ok: false, reason: 'not-running' })
    expect(stubSup.rescan).toHaveBeenCalledTimes(1)
  })

  it('the accounts Settings leaves out ride with every query; with none, the query is as the page sent it', async () => {
    registerTokenomics2Handlers(() => win as any)
    await handlers.get(IPC.TOKENOMICS2_SUMMARY)!({}, { configId: 'a' })
    expect(stubSup.query).toHaveBeenLastCalledWith('summary', { configId: 'a' })

    svc.excluded = [A]
    await handlers.get(IPC.TOKENOMICS2_SUMMARY)!({}, { configId: 'a' })
    expect(stubSup.query).toHaveBeenLastCalledWith('summary', { configId: 'a', excludeAccountKeys: [A] })
    await handlers.get(IPC.TOKENOMICS2_SESSIONS)!({}, { limit: 10 })
    expect(stubSup.query).toHaveBeenLastCalledWith('sessions', { limit: 10, excludeAccountKeys: [A] })
    await handlers.get(IPC.TOKENOMICS2_SESSION_DETAIL)!({}, { sessionId: 's1' })
    expect(stubSup.query).toHaveBeenLastCalledWith('session-detail', { sessionId: 's1', excludeAccountKeys: [A] })
    await handlers.get(IPC.TOKENOMICS2_ACCOUNTS)!({}, {})
    expect(stubSup.query).toHaveBeenLastCalledWith('accounts', { excludeAccountKeys: [A] })
  })

  it('Settings asks for the accounts left out too, to offer putting them back; nothing else is taken from the page', async () => {
    svc.excluded = [A]
    registerTokenomics2Handlers(() => win as any)
    await handlers.get(IPC.TOKENOMICS2_ACCOUNTS)!({}, { includeExcluded: true })
    expect(stubSup.query).toHaveBeenLastCalledWith('accounts', {})
    await handlers.get(IPC.TOKENOMICS2_ACCOUNTS)!({}, { includeExcluded: false })
    expect(stubSup.query).toHaveBeenLastCalledWith('accounts', { excludeAccountKeys: [A] })
    stubSup.query.mockClear()
    // The page cannot name the accounts to leave out, or to put back.
    for (const bad of [{ excludeAccountKeys: [] }, { excludeAccountKeys: [A] }, { includeExcluded: true }]) {
      await expect(handlers.get(IPC.TOKENOMICS2_SUMMARY)!({}, bad), JSON.stringify(bad)).rejects.toBeTruthy()
      await expect(handlers.get(IPC.TOKENOMICS2_SESSIONS)!({}, bad), JSON.stringify(bad)).rejects.toBeTruthy()
    }
    await expect(handlers.get(IPC.TOKENOMICS2_SESSION_DETAIL)!({}, { sessionId: 's1', excludeAccountKeys: [] })).rejects.toBeTruthy()
    await expect(handlers.get(IPC.TOKENOMICS2_ACCOUNTS)!({}, { includeExcluded: 'yes' })).rejects.toBeTruthy()
    await expect(handlers.get(IPC.TOKENOMICS2_ACCOUNTS)!({}, { excludeAccountKeys: [] })).rejects.toBeTruthy()
    expect(stubSup.query).not.toHaveBeenCalled()
  })

  it('a worker that comes up pushes what the index holds on the INDEX_STATUS channel', () => {
    registerTokenomics2Handlers(() => win as any)
    stubSup._subs.ready[0]({ firstIndexComplete: true, indexing: false, filesDone: 0, filesTotal: 0, eventsTotal: 9, lastIndexAt: null })
    expect(win.webContents.send).toHaveBeenCalledWith(IPC.TOKENOMICS2_INDEX_STATUS, expect.objectContaining({ firstIndexComplete: true, eventsTotal: 9 }))
  })

  it('a supervisor started later (switched on while the app runs) has its pushes forwarded like the first', () => {
    stubSup = undefined
    svc.off = true
    registerTokenomics2Handlers(() => win as any)
    expect(svc.starts).toHaveLength(1)
    // Switched on: the service tells the handlers of the new supervisor.
    const later = stub()
    svc.off = false
    stubSup = later
    svc.starts[0](later)
    later._subs.progress[0]({ filesDone: 1, filesTotal: 2, eventsIngested: 3, phase: 'initial' })
    later._subs.complete[0]({ firstIndex: false, drained: true, filesFailed: 0, eventsTotal: 5 })
    later._subs.error[0]({ firstIndexComplete: false, indexing: false, error: 'open failed', filesDone: 0, filesTotal: 0, eventsTotal: 0, lastIndexAt: null })
    later._subs.ready[0]({ firstIndexComplete: true, indexing: false, filesDone: 0, filesTotal: 0, eventsTotal: 5, lastIndexAt: null })
    expect(win.webContents.send).toHaveBeenCalledWith(IPC.TOKENOMICS2_INDEX_PROGRESS, expect.objectContaining({ filesDone: 1 }))
    expect(win.webContents.send).toHaveBeenCalledWith(IPC.TOKENOMICS2_INDEX_COMPLETE, expect.objectContaining({ drained: true }))
    expect(win.webContents.send).toHaveBeenCalledWith(IPC.TOKENOMICS2_INDEX_STATUS, expect.objectContaining({ error: 'open failed' }))
    expect(win.webContents.send).toHaveBeenCalledWith(IPC.TOKENOMICS2_INDEX_STATUS, expect.objectContaining({ firstIndexComplete: true }))
  })
})
