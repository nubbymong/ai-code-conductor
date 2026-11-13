// [host] aicc_planning B1 (from #307): first-run capture does nothing when the
// saved accounts list (profiles.json) cannot be read. Read through
// listProfiles, a failed read was an empty list, which looked like a first
// run: the user's global sign-in was captured again into a new account and
// that copy marked primary, on top of the accounts already saved.
//
// Host-safe: the capture itself and the primary mark are recorded fakes (no
// account folder, link or access list is ever made), every program start is
// refused, and the only files are a profiles.json and a .claude.json in a
// temp folder of the test's own.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const no = (file: unknown) => { throw new Error(`no process in this test: ${String(file)}`) }
  const stubs = { execFileSync: vi.fn(no), execFile: vi.fn(no), spawn: vi.fn(no), spawnSync: vi.fn(no), execSync: vi.fn(no), exec: vi.fn(no), fork: vi.fn(no) }
  return { ...real, ...stubs, default: { ...real, ...stubs } }
})

const h = vi.hoisted(() => ({
  captured: [] as Array<string | undefined>,
  primary: [] as string[],
  warn: [] as string[],
  globalEmail: 'me@example.com' as string | null,
}))

vi.mock('../../../src/main/account-profiles', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/account-profiles')>()
  return {
    ...real,
    // The two things first-run capture does to the list, recorded and not done.
    captureGlobalLogin: (name?: string) => { h.captured.push(name); return { id: 'profile-captured', name: '', accountEmail: h.globalEmail ?? '', createdAt: 9 } },
    setPrimaryProfile: (id: string) => { h.primary.push(id) },
  }
})
vi.mock('../../../src/main/claude-account-identity', () => ({ getDefaultAccountEmail: () => h.globalEmail }))
vi.mock('../../../src/main/debug-logger', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/debug-logger')>()
  return { ...real, logWarn: (...a: unknown[]) => { h.warn.push(a.map(String).join(' ')) }, logInfo: () => {}, logError: () => {} }
})

import { _setRootsForTest, getProfilesRoot } from '../../../src/main/account-profiles'
import { runFirstRunCapture } from '../../../src/main/first-run-accounts'

const A = { id: 'profile-a1', name: 'Home', accountEmail: 'a@example.com', createdAt: 1, isPrimary: true }
const B = { id: 'profile-b2', name: 'Work', accountEmail: 'b@example.com', createdAt: 2 }
const TWO = JSON.stringify({ profiles: [A, B] }, null, 2)

let tmp = ''
let file = ''
const realRead = fs.readFileSync

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-b1-firstrun-'))
  _setRootsForTest({ resourcesDir: path.join(tmp, 'resources'), sharedRoot: path.join(tmp, 'home', '.claude') })
  file = path.join(getProfilesRoot(), 'profiles.json')
  h.captured.length = 0
  h.primary.length = 0
  h.warn.length = 0
  h.globalEmail = 'me@example.com'
  // No link is made in this file, whatever the code under test does.
  vi.spyOn(fs, 'symlinkSync').mockImplementation(() => { throw new Error('no link in this test') })
})
afterEach(() => {
  vi.restoreAllMocks()
  _setRootsForTest(null)
  if (tmp && path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(tmp, { recursive: true, force: true })
  tmp = ''
})

function seed(text: string): Buffer {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return realRead(file)
}

/** Every read of profiles.json fails as a file another program holds. */
function failReadsOfProfiles(code: string): void {
  vi.spyOn(fs, 'readFileSync').mockImplementation(((p: unknown, ...rest: unknown[]) => {
    if (typeof p === 'string' && path.resolve(p) === path.resolve(file)) throw Object.assign(new Error(`${code}: simulated, open '${p}'`), { code })
    return (realRead as (...a: unknown[]) => unknown)(p, ...rest)
  }) as typeof fs.readFileSync)
}

function expectNothingDone(before: Buffer): void {
  expect(h.captured, 'the global sign-in was captured').toEqual([])
  expect(h.primary, 'an account was marked primary').toEqual([])
  vi.mocked(fs.readFileSync).mockRestore?.()
  expect(realRead(file).equals(before), 'profiles.json changed').toBe(true)
  expect(fs.readdirSync(path.dirname(file))).toEqual(['profiles.json'])
  expect(h.warn).toHaveLength(1)
  expect(h.warn[0]).toMatch(/^\[profiles\] first-run capture skipped: /)
}

describe('first-run capture with an accounts list that cannot be read (B1)', () => {
  it.each(['EBUSY', 'EPERM'])('a read that fails with %s: nothing is captured, nothing marked primary, nothing written', (code) => {
    // Two accounts saved, neither of them the global sign-in: with the list
    // read as empty this looked like a first run.
    const before = seed(TWO)
    failReadsOfProfiles(code)
    expect(() => runFirstRunCapture()).not.toThrow()
    expectNothingDone(before)
  })

  it.each([
    ['cut short', TWO.slice(0, TWO.length - 40)],
    ['empty', ''],
    ['without a profiles list', JSON.stringify({ accounts: [A, B] })],
  ])('a file that is %s: nothing is captured, nothing marked primary, nothing written', (_what, text) => {
    const before = seed(text)
    expect(() => runFirstRunCapture()).not.toThrow()
    expectNothingDone(before)
  })
})

describe('first-run capture with a list that reads (the cases above can fail)', () => {
  it('no file yet and a global sign-in: it is captured and marked primary', () => {
    runFirstRunCapture()
    expect(h.captured).toHaveLength(1)
    expect(h.primary).toEqual(['profile-captured'])
    expect(h.warn).toEqual([])
  })

  it('a primary already saved: nothing is captured or marked', () => {
    seed(TWO)
    runFirstRunCapture()
    expect(h.captured).toEqual([])
    expect(h.primary).toEqual([])
    expect(h.warn).toEqual([])
  })

  it('no primary, and the global sign-in is already an account: that account is marked, nothing is captured', () => {
    seed(JSON.stringify({ profiles: [{ ...A, isPrimary: false }, { ...B, accountEmail: 'Me@Example.com' }] }))
    runFirstRunCapture()
    expect(h.captured).toEqual([])
    expect(h.primary).toEqual([B.id])
  })

  it('no primary and no global sign-in: nothing is captured or marked', () => {
    seed(JSON.stringify({ profiles: [{ ...A, isPrimary: false }] }))
    h.globalEmail = null
    runFirstRunCapture()
    expect(h.captured).toEqual([])
    expect(h.primary).toEqual([])
  })
})
