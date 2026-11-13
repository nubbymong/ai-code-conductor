// [host] The Windows folder-rights step (hardenDirAclWindows, which is
// hardenCredentialDir on Windows) started icacls on every call, and it is
// called on every config write, at every session start and for each session's
// settings, MCP config and hooks. Each start is a program start on the main
// thread; under scanner load one can take seconds, which froze the window. A
// folder this run has PROVEN owner-only is now remembered for ten minutes: the
// next calls for it start nothing.
//
// What these cases hold it to:
//   - one way in: an icacls read that showed the owner-only list. A write is
//     never remembered, read back or not, nor a failed step or the fallback's
//     "not proven" answer; a folder that needed hardening costs a read and a
//     write, then one read, then nothing;
//   - the folder is the same one by path, in any letter case and with or
//     without a trailing separator;
//   - after ten minutes the next call reads again, and the ten minutes are
//     counted on a clock that only moves forward, whatever the system clock
//     is set to;
//   - a folder removed and made again under the same name is another folder
//     and is read again (the canvas plugin's tree is rebuilt that way), also
//     when that happens during the very read that would have proven it;
//   - a link, or anything that is not a folder, is never remembered;
//   - a write into the folder that fails forgets it at once, whichever writer
//     it was;
//   - a call that starts icacls is named to the jank detector, once.
//
// Host-safe: icacls is a fake in memory (`node:child_process` is mocked, and
// every other program start throws). The folders are plain temp folders of
// the test's own, made so the step can read their file identity; no access
// list on this machine is read or written and no link is made (a link is
// simulated by what lstat is made to report). The step only runs its Windows
// half on Windows, so the cases run there (this machine and the Windows legs
// of CI). The real-ACL twin is tests/unit/harden-dir-acl-windows.test.ts (VM
// and CI only).
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

interface Folder {
  /** What a read prints, one entry per line. */
  entries: string[]
  reads: number
  writes: number
  /** Reads end with "access denied". */
  unreadable?: boolean
  /** Writes end with "access denied". */
  refuseWrites?: boolean
  /** A write that names a principal to remove fails as a name that does not
   *  resolve, and every other write succeeds but changes nothing: the shape
   *  that sends the step to its "not proven" answer. */
  unprovable?: boolean
}

const h = vi.hoisted(() => ({
  folders: new Map<string, Folder>(),
  /** Every invocation's argv, in order. */
  calls: [] as string[][],
  /** Runs inside each invocation, before it answers. */
  onCall: null as null | (() => void),
  /** The app's resources folder for the config writers: a temp folder of this file's own. */
  resources: '',
}))

const DOMAIN = 'TESTDOM'
const SYSTEM = 'NT AUTHORITY\\SYSTEM'
const USERS = 'BUILTIN\\Users'
const AUTH_USERS = 'NT AUTHORITY\\Authenticated Users'
/** As the file system compares names: resolved, in one letter case. */
const keyOf = (p: string) => path.win32.resolve(p).toLowerCase()

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const no = (file: unknown) => { throw new Error(`no process in this test: ${String(file)}`) }
  const fail = (status: number) => Object.assign(new Error(`icacls exit ${status}`), { status })
  const execFileSync = vi.fn((file: unknown, args: unknown) => {
    if (typeof file !== 'string' || path.win32.basename(file).toLowerCase() !== 'icacls.exe' || !Array.isArray(args)) return no(file)
    const target = String(args[0])
    const ops = (args as string[]).slice(1)
    h.calls.push([target, ...ops])
    h.onCall?.()
    const f = h.folders.get(keyOf(target))
    if (!f) throw fail(2)
    if (ops.length === 0) {
      f.reads++
      if (f.unreadable) throw fail(5)
      // The path as it was given, then the first entry; the rest indented.
      return [`${target} ${f.entries[0] ?? ''}`, ...f.entries.slice(1).map((e) => `${' '.repeat(target.length + 1)}${e}`), '', 'Successfully processed 1 files; Failed processing 0 files'].join('\r\n')
    }
    if (f.refuseWrites) throw fail(5)
    if (f.unprovable) {
      if (ops.includes('/remove')) throw fail(1332)
      f.writes++
      return ''
    }
    f.writes++
    // Every write the step makes ends with the user and SYSTEM, owner-only.
    f.entries = ownerOnly()
    return ''
  })
  const stubs = { execFileSync, execFile: vi.fn(no), spawn: vi.fn(no), spawnSync: vi.fn(no), execSync: vi.fn(no), exec: vi.fn(no), fork: vi.fn(no) }
  return { ...real, ...stubs, default: { ...real, ...stubs } }
})

vi.mock('../../../src/main/debug-logger', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/debug-logger')>()
  return { ...real, logWarn: () => {}, logInfo: () => {}, logError: () => {} }
})
// The config writers below write under a temp folder, never the app's own.
vi.mock('../../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => h.resources,
  registerSetupHandlers: () => {},
}))

import {
  hardenDirAclWindows, hardenCredentialDir, forgetHardenedDir, atomicWriteSecure, copyCredentialFile,
  _icaclsCallsForTest, _resetAclStateForTest,
} from '../../../src/main/account-profiles'
import { writeConfig, ensureConfigDir, getConfigDir } from '../../../src/main/config-manager'
import { saveSessionState } from '../../../src/main/session-state'
import { mainThreadOpSince, noteMainThreadOp, _setMainThreadClockForTest, _resetMainThreadOpsForTest } from '../../../src/main/main-thread-ops'

const USER = (() => { try { return os.userInfo().username } catch { return '' } })()
const ME = `${DOMAIN}\\${USER}`
const TEN_MINUTES = 10 * 60 * 1000
const OP = 'icacls.exe on one folder'

/** The list the step writes: the user and SYSTEM, full control, passed down. */
function ownerOnly(): string[] { return [`${ME}:(OI)(CI)(F)`, `${SYSTEM}:(OI)(CI)(F)`] }
/** A folder still on its parent's list: nothing of the user's or SYSTEM's own. */
function inherited(): string[] { return [`${USERS}:(I)(OI)(CI)(RX)`, `${AUTH_USERS}:(I)(OI)(CI)(M)`] }

let root = ''
h.resources = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-acl-memo-res-'))
const inTemp = (p: string) => !!p && path.resolve(p).startsWith(path.resolve(os.tmpdir()) + path.sep)

/** A real, empty temp folder, and what the fake prints for it. */
function folder(name: string, entries: string[], over: Partial<Folder> = {}): { dir: string; f: Folder } {
  const dir = path.join(root, name)
  fs.mkdirSync(dir)
  const f: Folder = { entries, reads: 0, writes: 0, ...over }
  h.folders.set(keyOf(dir), f)
  return { dir, f }
}

/** How many icacls runs `run` started (the module's own count, and the fake's). */
function started(run: () => void): number {
  const before = _icaclsCallsForTest()
  const seen = h.calls.length
  run()
  const n = _icaclsCallsForTest() - before
  expect(h.calls.length - seen, 'the module\'s count and the fake\'s agree').toBe(n)
  return n
}

/** Teaches the module this machine's pair on a folder of its own, as the first
 *  harden of a run does. */
function learnPair(): void {
  const { dir } = folder('learn', inherited())
  expect(hardenDirAclWindows(dir)).toBe(true)
}

/** A folder already remembered: read once, and the next call starts nothing. */
function remembered(name: string): { dir: string; f: Folder } {
  const made = folder(name, ownerOnly())
  expect(started(() => expect(hardenDirAclWindows(made.dir)).toBe(true))).toBe(1)
  expect(started(() => hardenDirAclWindows(made.dir))).toBe(0)
  return made
}

const savedDomain = process.env.USERDOMAIN
beforeEach(() => {
  process.env.USERDOMAIN = DOMAIN
  h.folders.clear()
  h.calls.length = 0
  h.onCall = null
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-acl-memo-'))
  // The ten minutes are counted on performance.now(); the system clock (Date)
  // is faked beside it so a case can set it apart from the time that passed.
  vi.useFakeTimers({ toFake: ['performance', 'Date'] })
  _resetAclStateForTest()
})
afterEach(() => {
  if (savedDomain === undefined) delete process.env.USERDOMAIN
  else process.env.USERDOMAIN = savedDomain
  vi.useRealTimers()
  vi.restoreAllMocks()
  _resetMainThreadOpsForTest()
  if (inTemp(root)) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})
afterAll(() => {
  if (inTemp(h.resources)) fs.rmSync(h.resources, { recursive: true, force: true })
})

describe.runIf(process.platform === 'win32')('a folder proven owner-only is not read again for ten minutes', () => {
  it('the first folder of a run: read, write and the read-back that learns the pair, then one read, then no icacls: the same path, another letter case, a trailing separator', () => {
    expect(USER, 'this test needs the account name').not.toBe('')
    const { dir, f } = folder('config', inherited())

    // The first call hardens it as it always did: read, write, read back. The
    // read-back teaches the module its pair; it does not make the folder
    // remembered, and neither does the write.
    expect(started(() => expect(hardenDirAclWindows(dir)).toBe(true))).toBe(3)
    expect(f.writes).toBe(1)
    expect(f.entries).toEqual(ownerOnly())
    // The next call's read is the proof.
    expect(started(() => expect(hardenDirAclWindows(dir)).toBe(true)), 'the call after the write').toBe(1)

    const spellings = [dir, dir.toUpperCase(), dir.toLowerCase(), dir + path.sep, dir + path.sep + path.sep, path.join(dir, 'x', '..'), dir.replace(/\\/g, '/')]
    const n = started(() => {
      for (const s of spellings) {
        expect(hardenDirAclWindows(s), s).toBe(true)
        expect(hardenCredentialDir(s), s).toBe(true)
      }
    })
    expect(n, 'a proven folder starts no icacls').toBe(0)
    expect(f.reads).toBe(3)
    expect(f.writes).toBe(1)
  })

  it('a folder whose first read shows the owner-only list is remembered from that read', () => {
    learnPair()
    const { dir, f } = folder('already', ownerOnly())
    expect(started(() => expect(hardenDirAclWindows(dir)).toBe(true))).toBe(1)
    expect(f.writes).toBe(0)
    expect(started(() => { for (let i = 0; i < 5; i++) expect(hardenDirAclWindows(dir)).toBe(true) })).toBe(0)
  })

  it('a folder that needed hardening costs a read and a write, then one read, then nothing', () => {
    learnPair()
    const { dir, f } = folder('written', inherited())
    // The pair is known, so this call reads and writes and reads nothing back.
    expect(started(() => expect(hardenDirAclWindows(dir)).toBe(true))).toBe(2)
    expect(f.writes).toBe(1)
    expect(started(() => expect(hardenDirAclWindows(dir)).toBe(true)), 'the call after the write').toBe(1)
    expect(started(() => expect(hardenDirAclWindows(dir)).toBe(true)), 'the call after that read').toBe(0)
    expect(f.writes).toBe(1)
  })

  it('after ten minutes the next call reads again, and that read is remembered in its turn', () => {
    learnPair()
    const { dir, f } = folder('expiring', ownerOnly())
    expect(started(() => hardenDirAclWindows(dir))).toBe(1)

    vi.advanceTimersByTime(TEN_MINUTES - 1)
    expect(started(() => expect(hardenDirAclWindows(dir)).toBe(true)), 'one millisecond short of ten minutes').toBe(0)

    vi.advanceTimersByTime(1)
    expect(started(() => expect(hardenDirAclWindows(dir)).toBe(true)), 'ten minutes on').toBe(1)
    expect(f.writes).toBe(0)
    // Counted from that read, not from the first.
    vi.advanceTimersByTime(TEN_MINUTES - 1)
    expect(started(() => expect(hardenDirAclWindows(dir)).toBe(true))).toBe(0)
    vi.advanceTimersByTime(1)
    expect(started(() => expect(hardenDirAclWindows(dir)).toBe(true))).toBe(1)
  })

  it('a list changed from outside is found, and repaired, once the ten minutes are over', () => {
    learnPair()
    const { dir, f } = folder('changed', ownerOnly())
    hardenDirAclWindows(dir)
    f.entries = [...ownerOnly(), `${AUTH_USERS}:(OI)(CI)(F)`]
    vi.advanceTimersByTime(TEN_MINUTES)
    expect(hardenDirAclWindows(dir)).toBe(true)
    expect(f.writes).toBe(1)
    expect(f.entries).toEqual(ownerOnly())
  })

  it('the system clock set back with no call in between, then run forward: the folder is still read again after ten minutes of real time', () => {
    learnPair()
    const { dir } = remembered('clock-back')
    // Set back an hour (a time sync after resume, a corrected clock). Then 69
    // minutes pass: the system clock reads nine minutes after the proof.
    vi.setSystemTime(Date.now() - 60 * 60 * 1000)
    vi.advanceTimersByTime(69 * 60 * 1000)
    expect(started(() => expect(hardenDirAclWindows(dir)).toBe(true))).toBe(1)
  })

  it('the system clock set forward does not expire a folder early', () => {
    learnPair()
    const { dir } = remembered('clock-forward')
    vi.setSystemTime(Date.now() + 60 * 60 * 1000)
    expect(started(() => expect(hardenDirAclWindows(dir)).toBe(true))).toBe(0)
  })

  it('a step that fails is not remembered: every call starts icacls again until one succeeds', () => {
    learnPair()
    const { dir, f } = folder('denied', inherited(), { unreadable: true, refuseWrites: true })
    for (let i = 0; i < 3; i++) {
      expect(started(() => expect(hardenDirAclWindows(dir)).toBe(false)), `failed call ${i + 1}`).toBeGreaterThan(0)
    }
    // Readable and writable now: hardened, then read once and remembered.
    f.unreadable = false
    f.refuseWrites = false
    expect(hardenDirAclWindows(dir)).toBe(true)
    expect(f.entries).toEqual(ownerOnly())
    expect(started(() => expect(hardenDirAclWindows(dir)).toBe(true))).toBe(1)
    expect(started(() => expect(hardenDirAclWindows(dir)).toBe(true))).toBe(0)
  })

  it('the fallback\'s "not proven" answer is not remembered', () => {
    const { dir, f } = folder('unprovable', inherited(), { unprovable: true })
    for (let i = 0; i < 3; i++) {
      expect(started(() => expect(hardenDirAclWindows(dir)).toBe(false)), `unproven call ${i + 1}`).toBeGreaterThan(0)
    }
    expect(f.entries).toEqual(inherited())
  })

  it('forgetHardenedDir forces the next call to read again, by the same path rules', () => {
    learnPair()
    const { dir, f } = remembered('forgotten')

    forgetHardenedDir(dir.toUpperCase() + path.sep)
    expect(started(() => expect(hardenDirAclWindows(dir)).toBe(true))).toBe(1)
    expect(started(() => hardenDirAclWindows(dir))).toBe(0)

    // Forgetting a folder that was never remembered, or something that is no
    // path at all, does nothing and does not throw.
    expect(() => forgetHardenedDir(path.join(root, 'never-seen'))).not.toThrow()
    expect(() => forgetHardenedDir(undefined as unknown as string)).not.toThrow()
    expect(started(() => hardenDirAclWindows(dir))).toBe(0)
    expect(f.writes).toBe(0)
  })

  it('forgetting one folder leaves the others remembered', () => {
    learnPair()
    const a = folder('a', ownerOnly())
    const b = folder('b', ownerOnly())
    hardenDirAclWindows(a.dir)
    hardenDirAclWindows(b.dir)
    forgetHardenedDir(a.dir)
    expect(started(() => hardenDirAclWindows(b.dir))).toBe(0)
    expect(started(() => hardenDirAclWindows(a.dir))).toBe(1)
  })

  it('a folder removed and made again under the same name is another folder: it is read again and repaired', () => {
    // The canvas plugin's tree is wiped and rebuilt, which puts the new folder
    // back on its parent's list. A memo keyed by the path alone would call it
    // done.
    learnPair()
    const { dir, f } = remembered('rebuilt')

    fs.rmdirSync(dir)
    fs.mkdirSync(dir)
    f.entries = inherited()

    expect(started(() => expect(hardenDirAclWindows(dir)).toBe(true))).toBe(2)
    expect(f.writes).toBe(1)
    expect(f.entries).toEqual(ownerOnly())
  })

  it('a folder swapped in during the read that would prove it is not remembered: the next call reads the new folder and repairs it', () => {
    learnPair()
    const { dir, f } = folder('swapped', ownerOnly())
    // While icacls reads the folder, another program removes it and makes it
    // again. The read still prints the old folder's owner-only list.
    h.onCall = () => { h.onCall = null; fs.rmdirSync(dir); fs.mkdirSync(dir) }
    expect(started(() => expect(hardenDirAclWindows(dir)).toBe(true))).toBe(1)
    // The folder now at the path is on its parent's list, and was never read.
    f.entries = inherited()
    expect(started(() => expect(hardenDirAclWindows(dir)).toBe(true)), 'the new folder is read, not answered from memory').toBe(2)
    expect(f.entries).toEqual(ownerOnly())
  })

  it('a folder moved away during the read, with another made in its place, is not remembered: put back afterwards, it is read again', () => {
    learnPair()
    const { dir, f } = folder('moved', ownerOnly())
    const aside = path.join(root, 'moved-aside')
    // While icacls reads the folder, another program moves it away and makes
    // another at the path. The read prints the first folder's owner-only
    // list, and the folder at the path when the read ends is the other one.
    h.onCall = () => { h.onCall = null; fs.renameSync(dir, aside); fs.mkdirSync(dir) }
    expect(started(() => expect(hardenDirAclWindows(dir)).toBe(true))).toBe(1)
    // The first folder is put back. It is the one whose identity was taken
    // before the read, but the read did not end on it, so nothing was
    // remembered for the path: this call reads.
    fs.rmdirSync(dir)
    fs.renameSync(aside, dir)
    expect(started(() => expect(hardenDirAclWindows(dir)).toBe(true)), 'read again, not answered from memory').toBe(1)
    expect(f.writes).toBe(0)
    // That read began and ended on the same folder, and is remembered.
    expect(started(() => hardenDirAclWindows(dir))).toBe(0)
  })

  it('a folder that is not there is never remembered, whatever icacls says of its name', () => {
    learnPair()
    const ghost = path.join(root, 'not-made')
    h.folders.set(keyOf(ghost), { entries: ownerOnly(), reads: 0, writes: 0 })
    for (let i = 0; i < 3; i++) {
      expect(started(() => expect(hardenDirAclWindows(ghost)).toBe(true)), `call ${i + 1}`).toBe(1)
    }
  })

  /** lstat reports `dir` as `kind` from now on; no link is made. */
  function lstatReports(dir: string, kind: { link: boolean; folder: boolean }): void {
    const realLstat = fs.lstatSync
    vi.spyOn(fs, 'lstatSync').mockImplementation(((p: unknown, ...rest: unknown[]) => {
      const st = (realLstat as (...a: unknown[]) => fs.Stats)(p, ...rest)
      if (typeof p === 'string' && keyOf(p) === keyOf(dir)) {
        st.isSymbolicLink = () => kind.link
        st.isDirectory = () => kind.folder
      }
      return st
    }) as typeof fs.lstatSync)
  }

  it.each([
    ['a link', { link: true, folder: false }],
    ['not a folder', { link: false, folder: false }],
  ])('%s at the path is never remembered: every call reads, whatever the read shows', (_what, kind) => {
    learnPair()
    const { dir } = folder('linked', ownerOnly())
    lstatReports(dir, kind)
    for (let i = 0; i < 3; i++) {
      expect(started(() => expect(hardenDirAclWindows(dir)).toBe(true)), `call ${i + 1}`).toBe(1)
    }
  })

  it('a remembered folder that becomes a link is read again, every call', () => {
    learnPair()
    const { dir } = remembered('relinked')
    lstatReports(dir, { link: true, folder: false })
    expect(started(() => expect(hardenDirAclWindows(dir)).toBe(true))).toBe(1)
    expect(started(() => expect(hardenDirAclWindows(dir)).toBe(true))).toBe(1)
  })

  it('holds a bounded number of folders: past it the one remembered longest ago is read again', () => {
    learnPair()
    const MAX = 512
    const first = folder('d0', ownerOnly())
    hardenDirAclWindows(first.dir)
    const rest: string[] = []
    for (let i = 1; i <= MAX; i++) {
      const { dir } = folder(`d${i}`, ownerOnly())
      rest.push(dir)
      hardenDirAclWindows(dir)
    }
    // The newest are still remembered; the first has gone.
    expect(started(() => { hardenDirAclWindows(rest[MAX - 1]); hardenDirAclWindows(rest[1]) })).toBe(0)
    expect(started(() => expect(hardenDirAclWindows(first.dir)).toBe(true))).toBe(1)
  })
})

describe.runIf(process.platform === 'win32')('a write into a remembered folder that fails forgets the folder', () => {
  /** A name in `dir` that no file can be written over: a folder holds it. */
  function taken(dir: string, name: string): string {
    const p = path.join(dir, name)
    fs.mkdirSync(p, { recursive: true })
    return p
  }

  it('atomicWriteSecure: a write that succeeds forgets nothing, one that fails makes the next call read again', () => {
    learnPair()
    const { dir } = remembered('written-into')
    atomicWriteSecure(path.join(dir, 'ok.json'), '{}')
    expect(started(() => hardenDirAclWindows(dir)), 'after a write that succeeded').toBe(0)

    expect(() => atomicWriteSecure(taken(dir, 'taken.json'), '{}')).toThrow()
    expect(started(() => expect(hardenDirAclWindows(dir)).toBe(true)), 'after a write that failed').toBe(1)
  })

  it('a credential file copy that fails forgets its folder', () => {
    learnPair()
    const { dir } = remembered('credentials')
    const src = path.join(root, 'source.json')
    fs.writeFileSync(src, '{}')
    expect(() => copyCredentialFile(src, taken(dir, '.credentials.json'))).toThrow()
    expect(started(() => expect(hardenDirAclWindows(dir)).toBe(true))).toBe(1)
  })

  /** The app's CONFIG folder, made and remembered as owner-only. */
  function rememberedConfig(): string {
    learnPair()
    const dir = getConfigDir()
    h.folders.set(keyOf(dir), { entries: ownerOnly(), reads: 0, writes: 0 })
    expect(started(() => ensureConfigDir())).toBe(1)
    expect(started(() => ensureConfigDir()), 'CONFIG is remembered').toBe(0)
    return dir
  }

  it('writeConfig: a config write that fails answers false and CONFIG is read again before the next write', () => {
    const dir = rememberedConfig()
    expect(writeConfig('settings', { ok: true })).toBe(true)
    expect(started(() => ensureConfigDir()), 'after a config write that succeeded').toBe(0)

    taken(dir, 'commands.json')
    expect(writeConfig('commands', { no: true })).toBe(false)
    expect(started(() => ensureConfigDir()), 'after a config write that failed').toBe(1)
  })

  it('saveSessionState: a session-state save that fails answers false and CONFIG is read again before the next write', () => {
    const dir = rememberedConfig()
    taken(dir, 'session-state.json')
    const noise = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(saveSessionState({ sessions: [], savedAt: 1 } as unknown as Parameters<typeof saveSessionState>[0])).toBe(false)
    expect(noise).toHaveBeenCalled()
    expect(started(() => ensureConfigDir()), 'after a save that failed').toBe(1)
  })
})

describe.runIf(process.platform === 'win32')('a call that starts icacls is named to the jank detector', () => {
  it('a stall during a call names it; a remembered folder notes nothing', () => {
    let t = 5_000
    _setMainThreadClockForTest(() => t)
    learnPair()
    _resetMainThreadOpsForTest()
    _setMainThreadClockForTest(() => t)

    const { dir } = folder('slow', ownerOnly())
    const since = t
    // The read holds the thread for 1.8 s, as one does under scanner load.
    h.onCall = () => { t += 1_800 }
    expect(hardenDirAclWindows(dir)).toBe(true)
    h.onCall = null
    expect(mainThreadOpSince(since)).toBe(OP)
    // It ended with the call: a stall that begins after it is not its. (Time
    // moves on first: an operation never ended would still be in flight.)
    const ended = t
    t += 10_000
    expect(mainThreadOpSince(ended + 1)).toBeNull()

    // A remembered folder starts nothing, so there is nothing to name.
    _resetMainThreadOpsForTest()
    _setMainThreadClockForTest(() => t)
    expect(started(() => hardenDirAclWindows(dir))).toBe(0)
    expect(mainThreadOpSince(0)).toBeNull()
  })

  it('a call that fails still ends its operation', () => {
    let t = 9_000
    _setMainThreadClockForTest(() => t)
    const { dir } = folder('failing', inherited(), { unreadable: true, refuseWrites: true })
    h.onCall = () => { t += 700 }
    expect(hardenDirAclWindows(dir)).toBe(false)
    h.onCall = null
    // Time moves on first: an operation never ended would still be in flight.
    const ended = t
    t += 10_000
    expect(mainThreadOpSince(ended + 1)).toBeNull()
    expect(mainThreadOpSince(ended - 1)).toBe(OP)
  })

  it('one operation per call, however many runs it takes: hardening eight folders does not push a slow program start out of the detector\'s list', () => {
    let t = 1_000
    _setMainThreadClockForTest(() => t)
    learnPair()
    _resetMainThreadOpsForTest()
    _setMainThreadClockForTest(() => t)

    const since = t
    const end = noteMainThreadOp('start of other.exe')
    t += 1_900
    end()
    // Eight new folders, a read and a write each: sixteen icacls runs.
    h.onCall = () => { t += 20 }
    for (let i = 0; i < 8; i++) {
      const { dir } = folder(`session-${i}`, inherited())
      expect(started(() => expect(hardenDirAclWindows(dir)).toBe(true))).toBe(2)
    }
    h.onCall = null
    expect(mainThreadOpSince(since), 'the 1.9 s start is still the longest operation the detector knows').toBe('start of other.exe')
  })
})

describe.runIf(process.platform !== 'win32')('off Windows the step has nothing to remember', () => {
  it('hardenDirAclWindows answers false and starts nothing, and forgetHardenedDir is harmless', () => {
    const dir = fs.mkdtempSync(path.join(root, 'posix-'))
    expect(started(() => expect(hardenDirAclWindows(dir)).toBe(false))).toBe(0)
    expect(() => forgetHardenedDir(dir)).not.toThrow()
  })
})
