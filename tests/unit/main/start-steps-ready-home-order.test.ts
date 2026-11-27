// At start the home kept ready for the next new profile is made and checked
// before the start's profile steps only when those steps may make an account
// (the first-run capture: no primary account listed, and this computer's own
// sign-in names one). Otherwise the steps run once the listed profiles are
// checked, and the ready home is checked after them: what waits for the steps
// (a tab started at start on no account, the account list) never waits for a
// check it does not use. On the GitHub Windows runner that check's Windows
// PowerShell call took 8.4 s, and in run 46028075097 ran to its 30 s limit
// and was asked once more, while the Snap check's first Claude Code tab
// waited for it (snap-windows.spec.ts D1).
//
// The real account-profiles module, its owner-only rule replaced through the
// test seam (so it applies on every platform); no process starts
// (child_process faked) and nothing is linked: the steps here only record.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function fakeChildProcess(real: Record<string, unknown>) {
  const execFileSync = vi.fn((file: string) => { throw new Error(`no process in this test: ${file}`) })
  const execFile = vi.fn((file: string, _a: unknown, _o: unknown, cb: (e: Error | null, o: string, eo: string) => void) => { cb(new Error(`no process in this test: ${file}`), '', '') })
  return { ...real, execFileSync, execFile, default: { ...real, execFileSync, execFile } }
}
vi.mock('node:child_process', async (importOriginal) => fakeChildProcess(await importOriginal()))
vi.mock('child_process', async (importOriginal) => fakeChildProcess(await importOriginal()))

const ap = await import('../../../src/main/account-profiles')

const PREFIX = 'ccc-start-ready-home-'
const P = 'profile-mabc125-a1b2c5'
let base = ''
let shared = ''

const readySet = () => {
  const ready = path.join(ap.getProfilesRoot(), '.owner-only-ready')
  return [ready, path.join(ready, '.claude'), path.join(ready, 'identity')]
}

/** A rule that makes and passes every folder it is asked about, and holds
 *  its answer for the ready home until released. */
function heldReadyRule() {
  const asked: string[][] = []
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const rule = async (dirs: readonly string[]) => {
    asked.push([...dirs])
    if (path.basename(dirs[0] ?? '') === '.owner-only-ready') await gate
    return dirs.map((dir) => {
      if (!fs.existsSync(dir) && fs.existsSync(path.dirname(dir))) fs.mkdirSync(dir)
      return { dir, ok: true, detail: 'owner-only' }
    })
  }
  return { rule, asked, release, askedReady: () => asked.some((d) => d[0] === readySet()[0]) }
}

/** Whether `p` settles within `ms` (a held start does not). */
const settlesWithin = (p: Promise<unknown>, ms: number) =>
  Promise.race([p.then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))])

/** This computer's own sign-in, naming an account (the home root's .claude.json). */
const ownSignIn = () => fs.writeFileSync(path.join(path.dirname(shared), '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'own@example.test' } }))

beforeEach(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)))
  const res = path.join(base, 'res')
  shared = path.join(base, 'home', '.claude')
  fs.mkdirSync(res, { recursive: true })
  fs.mkdirSync(shared, { recursive: true })
  ap._setRootsForTest({ resourcesDir: res, sharedRoot: shared })
  ap._setCredentialFolderRuleForTest(null)
})

afterEach(async () => {
  // Let a ready-home check started after the steps end inside this test's folder.
  await new Promise((r) => setTimeout(r, 30))
  ap._setCredentialFolderRuleForTest(null)
  ap._setRootsForTest(null)
  // TEST CLEANUP GUARD: this suite's own temp folder only.
  if (path.basename(base).startsWith(PREFIX)) fs.rmSync(base, { recursive: true, force: true })
})

describe('at start the ready home is checked before the profile steps only when they may make an account', () => {
  it('no account to make (none listed, no sign-in of this computer\'s own): the steps run, and what waits for them goes on, while the ready home\'s check is still held; that check still runs, after them', async () => {
    const { rule, release, askedReady } = heldReadyRule()
    ap._setCredentialFolderRuleForTest(rule)
    const order: string[] = []
    const start = ap.startOwnerOnlyCredentialFolders(() => { order.push('steps') }, rule)
    const waiter = ap.startProfileStepsSettled().then(() => { order.push('waiter') })
    expect(await settlesWithin(start, 1000)).toBe(true)
    await waiter
    expect(order).toEqual(['steps', 'waiter'])
    expect(ap.startProfileStepsPending()).toBe(false)
    // The ready home is still made and checked, after the steps.
    expect(askedReady()).toBe(true)
    expect(ap.credentialFoldersVerdict(readySet()).ok).toBe(false)
    release()
    await vi.waitFor(() => { expect(ap.credentialFoldersVerdict(readySet()).ok).toBe(true) })
  })

  it('a primary account listed: no account to make, even with this computer\'s own sign-in; the steps do not wait for the ready home', async () => {
    ownSignIn()
    fs.mkdirSync(path.join(ap.getProfileConfigDir(P), '.claude'), { recursive: true })
    ap.upsertProfile({ id: P, name: 'A', accountEmail: 'own@example.test', createdAt: 1, isPrimary: true } as never)
    const { rule, release, asked } = heldReadyRule()
    ap._setCredentialFolderRuleForTest(rule)
    const order: string[] = []
    const start = ap.startOwnerOnlyCredentialFolders(() => { order.push('steps') }, rule)
    expect(await settlesWithin(start, 1000)).toBe(true)
    expect(order).toEqual(['steps'])
    // The listed profile's folders were checked before the steps.
    expect(asked[0]).toEqual([ap.getProfileConfigDir(P), path.join(ap.getProfileConfigDir(P), '.claude'), path.join(ap.getProfileConfigDir(P), 'identity')])
    release()
  })

  it('an account to make (no primary listed, and this computer\'s own sign-in names one): the steps wait for the ready home, checked first, as the first-run capture writes into it', async () => {
    ownSignIn()
    const { rule, release } = heldReadyRule()
    ap._setCredentialFolderRuleForTest(rule)
    const seen: Array<{ step: string; readyChecked: boolean }> = []
    const start = ap.startOwnerOnlyCredentialFolders(() => { seen.push({ step: 'steps', readyChecked: ap.credentialFoldersVerdict(readySet()).ok }) }, rule)
    expect(await settlesWithin(start, 300)).toBe(false)
    expect(seen).toEqual([])
    expect(ap.startProfileStepsPending()).toBe(true)
    release()
    await start
    expect(seen).toEqual([{ step: 'steps', readyChecked: true }])
  })
})
