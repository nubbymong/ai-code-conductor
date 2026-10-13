/**
 * The claude.ai session chip said "expired" while the account worked (owner
 * report, 2026-10-11, on 2.1.1-beta.1 and beta.2).
 *
 * statusOf compares the expiry saved in the account's record with now, and the
 * record was written once, at sign-in. claude.ai renews the sessionKey cookie
 * while the account is in use, so the saved date went stale: the chip read
 * "expired", and the two "Open artifacts" items gated on an active status (the
 * sidebar menu, which reads accountWeb:webStatus, and Settings, which reads
 * accountWeb:status) stayed disabled, while the artifacts window, which uses
 * the cookie itself, worked.
 *
 * Both status reads now bring the saved expiry up to the live cookie's first.
 * These tests drive the REAL handlers, the REAL record store (over an in-memory
 * channel store) and the REAL refresh; Electron's partition cookie store is
 * faked, and each fake cookie carries a value, so the tests can show the value
 * never leaves the cookie store.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const S = vi.hoisted(() => {
  type Cookie = { name: string; value: string; domain: string; expirationDate?: number; session?: boolean }
  const state = {
    jars: {} as Record<string, Cookie[]>,
    /** Partitions fromPartition was asked for, in order. */
    partitions: [] as string[],
    /** When set, a cookie read waits on it (a read that is slow, or never lands). */
    gate: null as Promise<void> | null,
    /** Called as a cookie read starts (a test can act mid-read). */
    onRead: null as (() => void) | null,
    disk: {} as Record<string, unknown>,
    writes: 0,
    logs: [] as string[],
    clearing: new Set<string>(),
    handlers: {} as Record<string, (e: unknown, ...a: unknown[]) => unknown>,
  }
  return state
})

/**
 * RFC 6265 domain-match, as Electron applies a `url` filter: a host-only
 * cookie ('claude.ai') matches its host exactly; a domain cookie
 * ('.claude.ai') matches that host and its subdomains. Never a plain suffix
 * test, so 'claude.ai.other.example' is not claude.ai's.
 */
function sentTo(host: string, domain: string): boolean {
  const d = domain.toLowerCase()
  const h = host.toLowerCase()
  return d.startsWith('.') ? h === d.slice(1) || h.endsWith(d) : h === d
}

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => { S.handlers[ch] = fn } },
  BrowserWindow: { fromWebContents: () => null },
  session: {
    fromPartition: (p: string) => {
      S.partitions.push(p)
      return {
        cookies: {
          // Applies BOTH filters as Electron does: `url` keeps only the
          // cookies that would be sent to that url's host, `name` the named
          // one. A read with no url gets every site's cookies in the jar.
          get: async (filter?: { url?: string; name?: string }) => {
            S.onRead?.()
            if (S.gate) await S.gate
            let all = [...(S.jars[p] ?? [])]
            if (typeof filter?.url === 'string') {
              const host = new URL(filter.url).hostname
              all = all.filter((c) => sentTo(host, c.domain))
            }
            if (typeof filter?.name === 'string') all = all.filter((c) => c.name === filter.name)
            return all.map((c) => ({ ...c }))
          },
        },
      }
    },
  },
}))
vi.mock('../../src/main/debug-logger', () => {
  const log = (...a: unknown[]) => { S.logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')) }
  return { logInfo: log, logWarn: log, logError: log, logDebug: log }
})
vi.mock('../../src/main/channel-storage', () => ({
  readJsonFile: (n: string, seed: () => unknown) => (S.disk[n] !== undefined ? JSON.parse(JSON.stringify(S.disk[n])) : seed()),
  writeJsonFile: (n: string, v: unknown) => { S.writes++; S.disk[n] = JSON.parse(JSON.stringify(v)); return true },
  peekJsonFile: (n: string) => (S.disk[n] !== undefined ? { kind: 'ok', value: S.disk[n] } : { kind: 'absent' }),
  quarantinedCopyOf: () => null,
}))
vi.mock('../../src/main/data-paths', () => ({ getDataDirectory: () => 'C:/fake/data' }))
vi.mock('../../src/main/provider-launch-gate', () => ({ providerLaunchRefusal: () => null, providerProbeRefusal: () => null }))
vi.mock('../../src/main/account-web/sign-in', () => ({
  cancelSignIn: () => {}, clearWebSession: async () => {}, getSignInState: () => ({ phase: 'idle' }), runSignIn: async () => ({ phase: 'idle' }),
  discardSignInRun: () => {}, detectAuthBrowsers: () => [],
  isClaudeWebClearing: (id: string) => S.clearing.has(id),
}))
vi.mock('../../src/main/account-web/artifacts', () => ({ closeArtifacts: () => {}, openArtifacts: () => ({ ok: true }) }))
vi.mock('../../src/main/account-web/claude-cli-auth', () => ({
  readClaudeCliAuth: async () => ({ authenticated: true, email: 'a@example.com' }),
  claudeAuthCommand: () => 'claude auth login',
}))
vi.mock('../../src/main/account-web/account-pane', () => ({
  openAccountPane: () => ({ ok: true }), closeAccountPane: () => true, closeAccountPanesForProfile: () => {},
  getAccountPaneState: () => null, reloadAccountPane: () => {}, setAccountPaneBounds: () => {}, setAccountPaneVisible: () => {},
}))
vi.mock('../../src/main/account-profiles', () => ({ listProfiles: () => [{ id: 'profile-chip1' }, { id: 'profile-chip2' }] }))
vi.mock('../../src/main/webview-manager', () => ({ closeWebview: () => {} }))

const { IPC } = await import('../../src/shared/ipc-channels')
const { webPartitionForProfile } = await import('../../src/shared/account-web-session')
const STORE = await import('../../src/main/account-web/session-store')
const { LIVE_EXPIRY_READ_BOUND_MS } = await import('../../src/main/account-web/web-session-expiry')
const { registerAccountWebHandlers } = await import('../../src/main/ipc/account-web-handlers')

const FILE = 'account-web-sessions.json'
const A = 'profile-chip1'
const B = 'profile-chip2'
const PART_A = webPartitionForProfile(A)
const DAY = 24 * 60 * 60 * 1000
/** Stands in for the live cookie's value: it must never leave the cookie store. */
const SECRET = 'sk-ant-sid01-COOKIE-VALUE-MUST-NOT-LEAK'

const FRAME = {}
const WIN = { isDestroyed: () => false, webContents: { mainFrame: FRAME, send: () => {} } }
const EV = { sender: WIN.webContents, senderFrame: FRAME }

type Web = { status: string; expiresAt?: number | null; accountEmail?: string | null; acquiredAt?: number; origin?: string; unavailable?: string }
type Answer = { ok: boolean; web?: Web }

async function webStatus(id: string): Promise<Answer> {
  return (await S.handlers[IPC.ACCOUNT_WEB_WEB_STATUS](EV, id)) as Answer
}
async function fullStatus(id: string): Promise<Answer> {
  return (await S.handlers[IPC.ACCOUNT_WEB_STATUS](EV, id)) as Answer
}

/** The record as signed in: its sessionKey expiry captured at that moment. */
function recordFor(id: string, expiresAt: number | null, acquiredAt = Date.now() - 40 * DAY) {
  return { profileId: id, accountEmail: 'a@example.com', acquiredAt, expiresAt, origin: 'in-app' as const }
}

function seedStore(sessions: unknown[], extra: Record<string, unknown> = {}): void {
  S.disk[FILE] = { schemaVersion: 4, sessions, authMethods: { [A]: 'sso' }, authBrowsers: { [A]: 'chrome' }, webSignInModes: {}, ...extra }
}

function sessionKey(expiresAtMs: number | null, domain = '.claude.ai'): { name: string; value: string; domain: string; expirationDate?: number; session?: boolean } {
  return expiresAtMs === null
    ? { name: 'sessionKey', value: SECRET, domain, session: true }
    : { name: 'sessionKey', value: SECRET, domain, expirationDate: expiresAtMs / 1000 }
}

function stored(id: string): Record<string, unknown> | undefined {
  const f = S.disk[FILE] as { sessions: Array<Record<string, unknown>> } | undefined
  return f?.sessions.find((s) => s.profileId === id)
}

/** Let a check that runs behind an answer finish (its cookie read is a
 *  resolved promise here unless a test gates it). */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  for (const k of Object.keys(S.jars)) delete S.jars[k]
  for (const k of Object.keys(S.disk)) delete S.disk[k]
  for (const k of Object.keys(S.handlers)) delete S.handlers[k]
  S.partitions.length = 0
  S.logs.length = 0
  S.writes = 0
  S.gate = null
  S.onRead = null
  S.clearing.clear()
  registerAccountWebHandlers(() => WIN as never)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the saved claude.ai expiry follows the live session cookie', () => {
  it('a renewed cookie turns a stale "expired" record active on the sidebar read (webStatus)', async () => {
    const renewed = Date.now() + 30 * DAY
    const acquiredAt = Date.now() - 40 * DAY
    seedStore([recordFor(A, Date.now() - DAY, acquiredAt)])
    S.jars[PART_A] = [sessionKey(renewed)]

    const res = await webStatus(A)

    expect(res.ok).toBe(true)
    expect(res.web?.status).toBe('active')
    expect(res.web?.expiresAt).toBe(renewed)
    // Only the expiry moved: the rest of the record and the account's settings are as they were.
    expect(stored(A)).toEqual({ ...recordFor(A, renewed, acquiredAt) })
    const f = S.disk[FILE] as Record<string, unknown>
    expect(f.authMethods).toEqual({ [A]: 'sso' })
    expect(f.authBrowsers).toEqual({ [A]: 'chrome' })
  })

  it('a renewed cookie turns it active on the Settings read (status) too', async () => {
    const renewed = Date.now() + 30 * DAY
    seedStore([recordFor(A, Date.now() - DAY)])
    S.jars[PART_A] = [sessionKey(renewed)]

    const res = await fullStatus(A)

    expect(res.ok).toBe(true)
    expect(res.web?.status).toBe('active')
    expect(stored(A)?.expiresAt).toBe(renewed)
  })

  it('a live session cookie with no expiry of its own reads active, as at sign-in', async () => {
    seedStore([recordFor(A, Date.now() - DAY)])
    S.jars[PART_A] = [sessionKey(null)]

    const res = await webStatus(A)

    expect(res.web?.status).toBe('active')
    expect(stored(A)?.expiresAt).toBeNull()
  })

  it('an unchanged expiry is not rewritten', async () => {
    const exp = Date.now() + 10 * DAY
    seedStore([recordFor(A, exp)])
    S.jars[PART_A] = [sessionKey(exp)]

    const res = await webStatus(A)
    await fullStatus(A)
    await settle()

    expect(res.web?.status).toBe('active')
    // The check ran (behind both answers), and found nothing to write.
    expect(S.partitions).toEqual([PART_A, PART_A])
    expect(S.writes).toBe(0)
  })

  it('touches only the account asked about', async () => {
    const renewed = Date.now() + 30 * DAY
    const bRecord = recordFor(B, Date.now() - 2 * DAY)
    seedStore([recordFor(A, Date.now() - DAY), bRecord])
    S.jars[PART_A] = [sessionKey(renewed)]
    S.jars[webPartitionForProfile(B)] = [sessionKey(renewed)]

    await webStatus(A)

    expect(stored(B)).toEqual(bRecord)
    expect(S.partitions).toEqual([PART_A])
  })
})

describe('a session that really expired still reads expired', () => {
  it('no session cookie in the partition (Chromium drops an expired one): the record is left as it is', async () => {
    const rec = recordFor(A, Date.now() - DAY)
    seedStore([rec])
    S.jars[PART_A] = [{ name: '__cf_bm', value: 'x', domain: '.claude.ai', expirationDate: (Date.now() + 30 * 60_000) / 1000 }]

    expect((await webStatus(A)).web?.status).toBe('expired')
    expect((await fullStatus(A)).web?.status).toBe('expired')
    expect(stored(A)).toEqual(rec)
    expect(S.writes).toBe(0)
  })

  it('a cookie still listed with a past expiry reads expired', async () => {
    const past = Date.now() - 60_000
    seedStore([recordFor(A, Date.now() - DAY)])
    S.jars[PART_A] = [sessionKey(past)]

    const res = await webStatus(A)

    expect(res.web?.status).toBe('expired')
    expect(stored(A)?.expiresAt).toBe(past)
  })

  it('a live cookie that has expired turns an active record expired by the next read', async () => {
    const past = Date.now() - 60_000
    seedStore([recordFor(A, Date.now() + 10 * DAY)])
    S.jars[PART_A] = [sessionKey(past)]

    // An active record answers from the file; its check runs behind the answer.
    expect((await webStatus(A)).web?.status).toBe('active')
    await vi.waitFor(() => expect(stored(A)?.expiresAt).toBe(past))
    expect((await webStatus(A)).web?.status).toBe('expired')
  })

  it("a sessionKey another site set in the partition never counts (the read is scoped to claude.ai)", async () => {
    // A signed-out account view may roam to an identity provider's pages, so
    // the partition can hold other sites' cookies, one of them named sessionKey.
    const rec = recordFor(A, Date.now() - DAY)
    seedStore([rec])
    S.jars[PART_A] = [
      sessionKey(Date.now() + 365 * DAY, '.idp.example'),
      sessionKey(Date.now() + 365 * DAY, 'claude.ai.other.example'),
    ]

    expect((await webStatus(A)).web?.status).toBe('expired')
    expect((await fullStatus(A)).web?.status).toBe('expired')
    await settle()
    expect(stored(A)).toEqual(rec)
    expect(S.writes).toBe(0)
  })
})

describe('what a status answer waits for', () => {
  it('an active record answers from the file at once, while its live check is still reading', async () => {
    vi.useFakeTimers()
    const saved = Date.now() + 2 * DAY
    seedStore([recordFor(A, saved)])
    S.jars[PART_A] = [sessionKey(Date.now() + 30 * DAY)]
    S.gate = new Promise<void>(() => {})

    let web: Answer | undefined
    let full: Answer | undefined
    void webStatus(A).then((r) => { web = r })
    void fullStatus(A).then((r) => { full = r })
    // No time passes: only the promises already settled run.
    await vi.advanceTimersByTimeAsync(0)

    expect(web?.web?.status).toBe('active')
    expect(web?.web?.expiresAt).toBe(saved)
    expect(full?.web?.status).toBe('active')
    // The check was still started, for the next read.
    expect(S.partitions).toEqual([PART_A, PART_A])
    await vi.advanceTimersByTimeAsync(LIVE_EXPIRY_READ_BOUND_MS + 10)
  })

  it('the check behind an active answer brings the saved expiry up to date for the next read', async () => {
    const saved = Date.now() + 2 * DAY
    const renewed = Date.now() + 30 * DAY
    seedStore([recordFor(A, saved)])
    S.jars[PART_A] = [sessionKey(renewed)]

    expect((await webStatus(A)).web?.expiresAt).toBe(saved)
    await vi.waitFor(() => expect(stored(A)?.expiresAt).toBe(renewed))
    const next = await webStatus(A)
    expect(next.web?.status).toBe('active')
    expect(next.web?.expiresAt).toBe(renewed)
  })
})

describe('what the refresh never does', () => {
  it('never lets the cookie value reach the record, a log line or an IPC answer', async () => {
    seedStore([recordFor(A, Date.now() - DAY)])
    S.jars[PART_A] = [sessionKey(Date.now() + 30 * DAY)]

    const a = await webStatus(A)
    const b = await fullStatus(A)

    expect(a.web?.status).toBe('active')
    expect(JSON.stringify(a)).not.toContain(SECRET)
    expect(JSON.stringify(b)).not.toContain(SECRET)
    expect(JSON.stringify(S.disk)).not.toContain(SECRET)
    expect(S.logs.join('\n')).not.toContain(SECRET)
    // The update is logged (without the value): the one trace of a write.
    expect(S.logs.some((l) => l.includes('expiry updated from the live session'))).toBe(true)
  })

  it('reads no partition, and so makes none, for an account with no record', async () => {
    seedStore([])
    expect((await webStatus(A)).web?.status).toBe('none')
    expect((await fullStatus(A)).web?.status).toBe('none')
    expect(S.partitions).toEqual([])
    expect(S.writes).toBe(0)
  })

  it('reads and writes nothing while the account web session is being wiped', async () => {
    const rec = recordFor(A, Date.now() - DAY)
    seedStore([rec])
    S.jars[PART_A] = [sessionKey(Date.now() + 30 * DAY)]
    S.clearing.add(A)

    expect((await webStatus(A)).web?.status).toBe('expired')
    expect(S.partitions).toEqual([])
    expect(stored(A)).toEqual(rec)
  })

  it('does not write when a wipe starts during the cookie read', async () => {
    const rec = recordFor(A, Date.now() - DAY)
    seedStore([rec])
    S.jars[PART_A] = [sessionKey(Date.now() + 30 * DAY)]
    S.onRead = () => { S.clearing.add(A) }

    await webStatus(A)

    expect(stored(A)).toEqual(rec)
    expect(S.writes).toBe(0)
  })

  it('never writes over a record replaced while the cookie was being read (a new sign-in)', async () => {
    seedStore([recordFor(A, Date.now() - DAY)])
    S.jars[PART_A] = [sessionKey(Date.now() + 30 * DAY)]
    const fresh = { ...recordFor(A, Date.now() + 29 * DAY, Date.now()), origin: 'in-app' as const }
    S.onRead = () => { STORE.saveWebSession(fresh) }

    await webStatus(A)

    expect(stored(A)).toEqual(fresh)
  })

  it('never brings back a record removed while the cookie was being read (a sign-out)', async () => {
    seedStore([recordFor(A, Date.now() - DAY)])
    S.jars[PART_A] = [sessionKey(Date.now() + 30 * DAY)]
    S.onRead = () => { STORE.removeWebSession(A) }

    const res = await webStatus(A)

    expect(stored(A)).toBeUndefined()
    expect(res.web?.status).toBe('none')
  })

  it('a cookie read that never lands does not hold up the answer', async () => {
    vi.useFakeTimers()
    const rec = recordFor(A, Date.now() - DAY)
    seedStore([rec])
    S.jars[PART_A] = [sessionKey(Date.now() + 30 * DAY)]
    S.gate = new Promise<void>(() => {})

    let answer: Answer | undefined
    void webStatus(A).then((r) => { answer = r })
    await vi.advanceTimersByTimeAsync(LIVE_EXPIRY_READ_BOUND_MS + 10)

    expect(answer?.ok).toBe(true)
    expect(answer?.web?.status).toBe('expired')
    expect(stored(A)).toEqual(rec)
  })

  it('leaves a record store written by a newer build alone, and reads no partition for it', async () => {
    S.disk[FILE] = { schemaVersion: 99, sessions: [recordFor(A, Date.now() - DAY)] }
    S.jars[PART_A] = [sessionKey(Date.now() + 30 * DAY)]

    const res = await webStatus(A)

    expect(res.web?.unavailable).toMatch(/newer version/)
    expect(S.partitions).toEqual([])
    expect(S.writes).toBe(0)
  })
})

describe('refreshWebSessionExpiry (the store write)', () => {
  it('writes only expiresAt, over the record it was given', () => {
    const rec = recordFor(A, 1_000)
    seedStore([rec])
    expect(STORE.refreshWebSessionExpiry(A, rec, 5_000)).toBe(true)
    expect(stored(A)).toEqual({ ...rec, expiresAt: 5_000 })
  })

  it('never creates a record', () => {
    seedStore([])
    expect(STORE.refreshWebSessionExpiry(A, { acquiredAt: 1, expiresAt: 1 }, 5_000)).toBe(false)
    expect(stored(A)).toBeUndefined()
    expect(S.writes).toBe(0)
  })

  it('refuses a record that is no longer the one read', () => {
    const rec = recordFor(A, 1_000, 100)
    seedStore([rec])
    expect(STORE.refreshWebSessionExpiry(A, { acquiredAt: 99, expiresAt: 1_000 }, 5_000)).toBe(false)
    expect(STORE.refreshWebSessionExpiry(A, { acquiredAt: 100, expiresAt: 999 }, 5_000)).toBe(false)
    expect(stored(A)).toEqual(rec)
  })

  it('refuses a value that is not a finite epoch-ms or null', () => {
    const rec = recordFor(A, 1_000)
    seedStore([rec])
    expect(STORE.refreshWebSessionExpiry(A, rec, Number.NaN)).toBe(false)
    expect(STORE.refreshWebSessionExpiry(A, rec, Number.POSITIVE_INFINITY)).toBe(false)
    expect(stored(A)).toEqual(rec)
  })

  it('refuses a store written by a newer build', () => {
    S.disk[FILE] = { schemaVersion: 99, sessions: [recordFor(A, 1_000)] }
    expect(STORE.refreshWebSessionExpiry(A, recordFor(A, 1_000), 5_000)).toBe(false)
    expect(S.writes).toBe(0)
  })
})
