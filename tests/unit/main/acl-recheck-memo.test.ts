// aicc_planning#301: hardenDirAclWindows remembers a folder once a READ has
// shown its DACL owner-only, so a config or state write does not start icacls
// on the main thread for a folder it proved a moment ago. icacls, the folder's
// identity and the account name are all faked: this suite changes no ACL and
// starts no process, so it runs on every leg (unlike
// harden-dir-acl-windows.test.ts, which measures the real thing on Windows).
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

const realPlatform = process.platform
Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
const realDomain = process.env.USERDOMAIN
process.env.USERDOMAIN = 'TESTDOM'

const calls: string[][] = []
let failReads = false
let failWrites = false
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFileSync: vi.fn((_file: string, args: string[], opts?: { encoding?: string }) => {
    calls.push(args)
    const fail = () => { const e = new Error('icacls failed') as Error & { status: number }; e.status = 5; throw e }
    // A read (one argument, text wanted): an owner-only DACL.
    if (args.length === 1 && opts?.encoding) { if (failReads) fail(); return `${args[0]} TESTDOM\\tester:(OI)(CI)(F)\n` }
    if (failWrites) fail()
    return ''
  }),
}))

const os = (await import('node:os')).default
vi.spyOn(os, 'userInfo').mockReturnValue({ username: 'tester' } as never)

const DIR = 'C:\\res\\account-profiles\\p1\\.claude'
const fs = (await import('node:fs')).default
const identity = { dev: 1n, ino: 11n, birth: 100n }
const realStat = fs.statSync.bind(fs)
// Only the test folders are faked; any other caller gets the real statSync.
vi.spyOn(fs, 'statSync').mockImplementation(((p: unknown, o?: unknown) => {
  if (typeof p === 'string' && p.toLowerCase().startsWith(DIR.toLowerCase())) return { dev: identity.dev, ino: identity.ino, birthtimeNs: identity.birth }
  return (realStat as (a: unknown, b?: unknown) => unknown)(p, o)
}) as never)

const { hardenDirAclWindows, _resetAclStateForTest, _setAclClockForTest, _aclMemoSizeForTest, ACL_RECHECK_MS } = await import('../../../src/main/account-profiles')

let now = 1_000_000

/** The write (not proof), then the read that proves it: remembered from here. */
function settle(dir = DIR): void {
  expect(hardenDirAclWindows(dir)).toBe(true)
  expect(hardenDirAclWindows(dir)).toBe(true)
  calls.length = 0
}

beforeEach(() => {
  _resetAclStateForTest()
  _setAclClockForTest(() => now)
  calls.length = 0
  failReads = false
  failWrites = false
  identity.dev = 1n; identity.ino = 11n; identity.birth = 100n
})
afterAll(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  if (realDomain === undefined) delete process.env.USERDOMAIN; else process.env.USERDOMAIN = realDomain
})

describe('hardenDirAclWindows remembers a folder a read proved owner-only (#301)', () => {
  it('once proved, a write within the re-check interval starts no icacls', () => {
    settle()
    now += ACL_RECHECK_MS - 1
    expect(hardenDirAclWindows(DIR)).toBe(true)
    expect(calls).toEqual([])
  })

  it('a write that only applied grants is not remembered: the next call reads again', () => {
    expect(hardenDirAclWindows(DIR)).toBe(true) // nothing learned yet: the write path
    calls.length = 0
    hardenDirAclWindows(DIR)
    expect(calls.length).toBeGreaterThan(0)
  })

  it('a write whose read failed is not remembered either (the pair already learned)', () => {
    settle()
    now += ACL_RECHECK_MS // the entry is due: the next call goes to icacls
    failReads = true
    expect(hardenDirAclWindows(DIR)).toBe(true) // grants landed; the DACL was never read
    failReads = false
    calls.length = 0
    hardenDirAclWindows(DIR)
    expect(calls.length).toBeGreaterThan(0)
  })

  it('the same path spelled with other letter case is the same folder', () => {
    settle()
    expect(hardenDirAclWindows(DIR.toUpperCase())).toBe(true)
    expect(calls).toEqual([])
  })

  it('once the interval has passed, the next write reads the DACL again', () => {
    settle()
    now += ACL_RECHECK_MS
    hardenDirAclWindows(DIR)
    expect(calls.length).toBeGreaterThan(0)
  })

  it('a clock that went backwards does not stretch the interval', () => {
    settle()
    now -= 5
    hardenDirAclWindows(DIR)
    expect(calls.length).toBeGreaterThan(0)
  })

  it('a folder made again is hardened again: a new file id, creation time or volume', () => {
    for (const change of [() => { identity.ino = 12n }, () => { identity.birth = 101n }, () => { identity.dev = 2n }]) {
      identity.dev = 1n; identity.ino = 11n; identity.birth = 100n
      _resetAclStateForTest(); _setAclClockForTest(() => now)
      settle()
      change()
      hardenDirAclWindows(DIR)
      expect(calls.length).toBeGreaterThan(0)
    }
  })

  it('a folder replaced while it was being proved is not remembered', () => {
    expect(hardenDirAclWindows(DIR)).toBe(true) // the write: the pair is learned
    const real = vi.mocked(fs.statSync).getMockImplementation()!
    let n = 0
    vi.mocked(fs.statSync).mockImplementation(((p: unknown, o?: unknown) => {
      // before the read: folder A; after it: folder B at the same path
      if (typeof p === 'string' && p === DIR) return { dev: 1n, ino: n++ === 0 ? 11n : 99n, birthtimeNs: 100n }
      return real(p as never, o as never)
    }) as never)
    try {
      hardenDirAclWindows(DIR)
    } finally { vi.mocked(fs.statSync).mockImplementation(real) }
    calls.length = 0
    hardenDirAclWindows(DIR)
    expect(calls.length).toBeGreaterThan(0)
  })

  it('a hardening that failed is not remembered, and drops what was', () => {
    settle()
    identity.ino = 12n
    failReads = true; failWrites = true
    expect(hardenDirAclWindows(DIR)).toBe(false)
    failReads = false; failWrites = false
    identity.ino = 11n
    calls.length = 0
    hardenDirAclWindows(DIR)
    expect(calls.length).toBeGreaterThan(0)
  })

  it('a folder with no file id is never remembered', () => {
    identity.ino = 0n
    settle()
    hardenDirAclWindows(DIR)
    expect(calls.length).toBeGreaterThan(0)
  })

  it('remembers at most 256 folders, dropping the expired, then the oldest', () => {
    for (let i = 0; i < 300; i++) settle(`${DIR}\\f${i}`)
    expect(_aclMemoSizeForTest()).toBe(256)
    // the newest is still remembered; the first was dropped
    expect(hardenDirAclWindows(`${DIR}\\f299`)).toBe(true)
    expect(calls).toEqual([])
    hardenDirAclWindows(`${DIR}\\f0`)
    expect(calls.length).toBeGreaterThan(0)
  })

  it('another folder is not covered by the first one', () => {
    settle()
    hardenDirAclWindows(DIR + '2')
    expect(calls.length).toBeGreaterThan(0)
  })
})
