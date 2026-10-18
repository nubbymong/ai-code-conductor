// aicc_planning#301: hardenDirAclWindows remembers a folder it proved
// owner-only, so a config or state write does not start icacls on the main
// thread for a folder it checked a moment ago. icacls and the folder's
// identity are both faked: this suite changes no ACL and starts no process,
// so it runs on every leg (unlike harden-dir-acl-windows.test.ts).
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

const realPlatform = process.platform
Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

const calls: string[][] = []
let failWrites = false
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFileSync: vi.fn((_file: string, args: string[], opts?: { encoding?: string }) => {
    calls.push(args)
    // A read (one argument, text wanted): an owner-only DACL.
    if (args.length === 1 && opts?.encoding) return `${args[0]} SOMEONE:(OI)(CI)(F)\n`
    if (failWrites) { const e = new Error('icacls failed') as Error & { status: number }; e.status = 5; throw e }
    return ''
  }),
}))

const fs = (await import('node:fs')).default
const identity = { ino: 11n, birth: 100n }
vi.spyOn(fs, 'statSync').mockImplementation(((_p: unknown) => ({ dev: 1n, ino: identity.ino, birthtimeNs: identity.birth })) as never)

const { hardenDirAclWindows, _resetAclStateForTest, _setAclClockForTest, ACL_RECHECK_MS } = await import('../../../src/main/account-profiles')

let now = 1_000_000
const DIR = 'C:\\res\\account-profiles\\p1\\.claude'

beforeEach(() => {
  _resetAclStateForTest()
  _setAclClockForTest(() => now)
  calls.length = 0
  failWrites = false
  identity.ino = 11n
  identity.birth = 100n
})
afterAll(() => { Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true }) })

describe('hardenDirAclWindows remembers a folder it proved owner-only (#301)', () => {
  it('a second write to the same folder within the re-check interval starts no icacls', () => {
    expect(hardenDirAclWindows(DIR)).toBe(true)
    expect(calls.length).toBeGreaterThan(0)
    calls.length = 0
    now += ACL_RECHECK_MS - 1
    expect(hardenDirAclWindows(DIR)).toBe(true)
    expect(calls).toEqual([])
  })

  it('the same path spelled with other letter case is the same folder', () => {
    hardenDirAclWindows(DIR)
    calls.length = 0
    expect(hardenDirAclWindows(DIR.toUpperCase())).toBe(true)
    expect(calls).toEqual([])
  })

  it('once the interval has passed, the next write reads the DACL again', () => {
    hardenDirAclWindows(DIR)
    calls.length = 0
    now += ACL_RECHECK_MS
    hardenDirAclWindows(DIR)
    expect(calls.length).toBeGreaterThan(0)
  })

  it('a folder deleted and made again (a new identity) is hardened again at once', () => {
    hardenDirAclWindows(DIR)
    calls.length = 0
    identity.ino = 12n
    hardenDirAclWindows(DIR)
    expect(calls.length).toBeGreaterThan(0)
    calls.length = 0
    identity.ino = 11n
    identity.birth = 101n
    hardenDirAclWindows(DIR)
    expect(calls.length).toBeGreaterThan(0)
  })

  it('a hardening that failed is not remembered', () => {
    failWrites = true
    expect(hardenDirAclWindows(DIR)).toBe(false)
    failWrites = false
    calls.length = 0
    hardenDirAclWindows(DIR)
    expect(calls.length).toBeGreaterThan(0)
  })

  it('a folder with no file id is never remembered', () => {
    identity.ino = 0n
    hardenDirAclWindows(DIR)
    calls.length = 0
    hardenDirAclWindows(DIR)
    expect(calls.length).toBeGreaterThan(0)
  })

  it('another folder is not covered by the first one', () => {
    hardenDirAclWindows(DIR)
    calls.length = 0
    hardenDirAclWindows(DIR + '2')
    expect(calls.length).toBeGreaterThan(0)
  })
})
