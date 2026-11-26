// 2.1.3-beta.15 (plan section B1, aicc_planning#397): a start with both helper
// switches off, no running mark and no agent record makes no manager, so the
// manager's own clean-up of old version folders never ran, and every update
// left its helper copy behind. removeOldCopiesWithHelperOff (manager.ts) runs
// then instead (app-wiring.ts begins it; session-helper-app-wiring.test.ts
// checks that wiring). Against the fake helper, in a temp folder.
//
// The cases:
//  1. an old version folder and a staging folder go, a listed holder's
//     version stays, anything else in the folder stays, no copy is made, and
//     one log line names what went;
//  2. a listing that fails, one that does not read, or no installed helper:
//     nothing is removed, and the log says why;
//  3. a user who never used the helper (no folder, or one with no version or
//     staging folder and no kept or store folder): nothing is listed;
//  4. a switch turned on while the listing is pending (a manager made then):
//     nothing is removed once the manager exists, and its copy is placed and
//     stays;
//  5. the manager's copy waits for the clean-up (deps.copyAfter), so a
//     clean-up that removes this build's folder never removes the copy made
//     in the same run;
//  6. a staging folder alone (a failed copy, then both switches off) is
//     enough to start the clean-up, and it goes, then the helper folder,
//     empty (2.1.3-beta.19).
//
// 2.1.3-beta.19 (plan section 6.5, aicc_planning#440): a run with a switch on
// leaves an empty kept folder and a store holding only its lock (beta.18's
// post-publish check), and the clean-up removed version and staging folders
// only. The cases:
//  7. version folders, an empty kept and a lock-only store: all go at one
//     start, then the helper folder, empty; one listing, one log line;
//  8. no version folder, an empty kept and a lock-only store (what beta.18
//     leaves): they go at one start; either alone goes too; the rest of the
//     helper folder stays, and so does the folder; a store with nothing in it
//     (its lock gone, the folder not: a removal that stopped half way) goes
//     at the next start too;
//  9. a store record, a kept record, the running mark or a listed holder:
//     the empty kept and the lock-only store both stay, with a version
//     folder there (it still goes) and without one (no listing is run, but
//     for the listed holder, which only the listing shows); so do both when
//     a switch is turned on while the version folders go (stop() asked a
//     third time, just before kept and store);
// 10. a kept or a store that holds anything else, or is a link: both stay,
//     and with nothing else to remove no listing is run.
//
// Not checked here: the manager's clean-up with a switch on (bringUp), which
// is as before (session-helper-manager.test.ts, session-helper-install.test.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const ptySpawn = vi.hoisted(() => vi.fn())
vi.mock('node-pty', () => ({ spawn: ptySpawn }))
vi.mock('../../../src/main/account-profiles', async (importOriginal) => {
  const fs = await import('node:fs')
  return {
    ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
    mkdirSecure: (d: string) => { fs.mkdirSync(d, { recursive: true }) },
    hardenCredentialDir: () => {},
    atomicWriteSecure: (f: string, data: string) => { fs.writeFileSync(f, data) },
  }
})
vi.mock('../../../src/main/conductor-mcp-server', () => ({}))

import { SessionHelperManager, removeOldCopiesWithHelperOff } from '../../../src/main/session-helper/manager'
import { versionFolderName } from '../../../src/main/session-helper/install'
import { heldSessionId } from '../../../src/main/session-helper/protocol'
import { FakeHelper, FakeHolder } from './session-helper-fake-holder'

const BUNDLED_BYTES = 'MZ the installed helper'
/** This build's copy, as a manager names it (the fake helper is 0.1.0). */
const THIS_BUILD = versionFolderName('0.1.0', createHash('sha256').update(BUNDLED_BYTES).digest('hex'))

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await tick(5)
  }
}

let dir: string
let bundled: string
let root: string
let helper: FakeHelper
let logs: string[]
const managers: SessionHelperManager[] = []
/** Every start a test began, awaited or not: the teardown waits for them. */
const starts: Promise<unknown>[] = []

const folder = (name: string) => mkdirSync(join(root, name), { recursive: true })
const names = () => readdirSync(root).sort()
const listCalls = () => helper.calls.filter((c) => c.args[0] === 'list')
const cleanUp = (over: Partial<Parameters<typeof removeOldCopiesWithHelperOff>[0]> = {}) =>
  removeOldCopiesWithHelperOff({ root, bundled, platform: 'win32', exec: async (file, args) => helper.exec(file, args), log: (m) => logs.push(m), stop: () => false, ...over })

function makeManager(over: Partial<ConstructorParameters<typeof SessionHelperManager>[0]> = {}): SessionHelperManager {
  const m = new SessionHelperManager({
    platform: 'win32', root, bundled,
    exec: async (file, args) => helper.exec(file, args),
    openStream: async (endpoint) => helper.openStream(endpoint),
    spawnDirect: (file, args, o) => ptySpawn(file, args, o), conptySource: () => null, log: (m) => logs.push(m), ...over,
  })
  managers.push(m)
  const start = m.start.bind(m)
  m.start = (o) => { const p = start(o); starts.push(p); return p }
  return m
}

beforeEach(() => {
  ptySpawn.mockReset()
  dir = mkdtempSync(join(tmpdir(), 'aicc-helper-old-copies-'))
  mkdirSync(join(dir, 'install', 'helper'), { recursive: true })
  bundled = join(dir, 'install', 'helper', 'aicc-helper.exe')
  writeFileSync(bundled, BUNDLED_BYTES)
  root = join(dir, 'user', 'helper')
  helper = new FakeHelper()
  logs = []
})

afterEach(async () => {
  const quits = managers.splice(0).map((m) => { try { return m.shutdown() } catch { return null } })
  for (const h of helper.holders.values()) h.dropAll()
  let timer: NodeJS.Timeout | undefined
  await Promise.race([Promise.allSettled([...quits, ...starts.splice(0)]), new Promise<void>((r) => { timer = setTimeout(r, 3000) })]).finally(() => clearTimeout(timer))
  // The starts include the self-test each began (session-helper-manager.test.ts says why that matters): a folder that cannot go here is a real failure.
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 })
})

describe('the start-up clean-up of old helper copies with both switches off', () => {
  it('1. an old version folder and a staging folder go, a listed holder\'s version stays, the rest of the folder stays, no copy is made, and one log line names what went', async () => {
    folder(THIS_BUILD)
    folder('0.1.0-aaaaaaaaaaaa')
    folder('0.0.9-bbbbbbbbbbbb')
    folder('.new-0123456789ab')
    folder('dev')
    writeFileSync(join(root, '0.0.8-cccccccccccc'), 'a file, not a folder')
    writeFileSync(join(root, 'bindings.json'), '{}')
    // A holder of another version still runs: every folder of its version stays.
    const h = new FakeHolder(heldSessionId('abcdef0123456789abcdef01'), 'abcdef0123456789abcdef01', join(root, 'store'))
    h.helperVersion = '0.0.9'
    h.writeRecord()
    helper.holders.set(h.sid, h)

    const removed = await cleanUp()
    expect(removed.sort()).toEqual(['.new-0123456789ab', '0.1.0-aaaaaaaaaaaa', THIS_BUILD].sort())
    expect(names()).toEqual(['0.0.8-cccccccccccc', '0.0.9-bbbbbbbbbbbb', 'bindings.json', 'dev', 'store'])
    // Listed once, with the installed helper and the helper's own store; nothing else was asked of it.
    expect(helper.calls).toEqual([{ file: bundled, args: ['list', '--store', join(root, 'store')] }])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/removed old helper folder\(s\): /)
    for (const name of removed) expect(logs[0]).toContain(name)
  })

  it('2. a listing that fails, one that does not read, or no installed helper: nothing is removed, and the log says why', async () => {
    folder('0.1.0-aaaaaaaaaaaa')
    folder('.new-0123456789ab')
    const before = names()

    helper.listFails = true
    expect(await cleanUp()).toEqual([])
    expect(await cleanUp({ exec: async () => ({ code: 0, stdout: 'not a listing\n', stderr: '' }) })).toEqual([])
    const calls = helper.calls.length
    expect(await cleanUp({ bundled: join(dir, 'install', 'helper', 'gone.exe') })).toEqual([])
    // With no installed helper nothing is run.
    expect(helper.calls).toHaveLength(calls)

    expect(names()).toEqual(before)
    expect(logs).toHaveLength(3)
    for (const line of logs) expect(line).toMatch(/could not be listed, so no old helper folder is removed/)
  })

  it('3. a user who never used the helper: no folder, or one with no version or staging folder and no kept or store folder, lists nothing and removes nothing', async () => {
    expect(await cleanUp()).toEqual([])
    folder('dev')
    folder('0.1.0-not-a-hash')
    writeFileSync(join(root, '0.1.0-aaaaaaaaaaaa'), 'a file, not a folder')
    writeFileSync(join(root, 'bindings.json'), '{}')
    expect(await cleanUp()).toEqual([])
    expect(helper.calls).toEqual([])
    expect(logs).toEqual([])
    expect(names()).toEqual(['0.1.0-aaaaaaaaaaaa', '0.1.0-not-a-hash', 'bindings.json', 'dev'])
  })

  it('4. a switch turned on while the listing is pending: once the manager exists nothing is removed, and its copy is placed and stays', async () => {
    folder('0.0.7-dddddddddddd')
    let release!: () => void
    helper.listGate = new Promise<void>((r) => { release = r })
    let m: SessionHelperManager | null = null
    // No copyAfter here: only the clean-up's own stop keeps the copy.
    const done = cleanUp({ stop: () => m !== null })
    await until(() => listCalls().length === 1, 'the clean-up\'s listing')
    m = makeManager()
    void m.start({ atStartup: false, plain: true, agents: false })
    await until(() => existsSync(join(root, THIS_BUILD, 'aicc-helper.exe')), 'the manager\'s copy')
    release()
    helper.listGate = null
    expect(await done).toEqual([])
    await until(() => m!.serviceState().state === 'ready', 'the helper to be ready')
    expect(existsSync(join(root, THIS_BUILD, 'aicc-helper.exe'))).toBe(true)
    expect(logs.filter((l) => /with both settings off/.test(l))).toEqual([])
  })

  it('5. the manager\'s copy waits for the clean-up (copyAfter): a clean-up that removes this build\'s folder never removes the copy made in the same run', async () => {
    folder(THIS_BUILD)
    folder('0.0.7-dddddddddddd')
    let release!: () => void
    helper.listGate = new Promise<void>((r) => { release = r })
    // A stop that never answers true: only the wait keeps the copy.
    const done = cleanUp()
    await until(() => listCalls().length === 1, 'the clean-up\'s listing')
    const m = makeManager({ copyAfter: done })
    void m.start({ atStartup: false, plain: true, agents: false })
    await tick(100)
    // The copy waits: the installed helper was not even asked its version.
    expect(helper.calls.filter((c) => c.args[0] === 'version')).toEqual([])
    release()
    helper.listGate = null
    expect((await done).sort()).toEqual(['0.0.7-dddddddddddd', THIS_BUILD].sort())
    await until(() => m.serviceState().state === 'ready', 'the helper to be ready')
    expect(existsSync(join(root, THIS_BUILD, 'aicc-helper.exe'))).toBe(true)
    expect(names()).toContain(THIS_BUILD)
  })

  it('6. a staging folder alone is enough: the holders are listed once, and the folder goes, then the helper folder, empty', async () => {
    folder('.new-0123456789ab')
    expect(await cleanUp()).toEqual(['.new-0123456789ab'])
    expect(listCalls()).toHaveLength(1)
    expect(existsSync(root)).toBe(false)
  })
})

describe('2.1.3-beta.19 (6.5): the empty kept folder and the lock-only store a run with a switch on left, at a start with both switches off', () => {
  const LOCK = join('store', '.lock')
  /** What beta.18 leaves (its post-publish check): kept, empty, and store holding only its lock (0 bytes). */
  const leftovers = () => {
    folder('kept')
    folder('store')
    writeFileSync(join(root, LOCK), '')
  }
  const left = () => ({ kept: existsSync(join(root, 'kept')), store: existsSync(join(root, 'store')), lock: existsSync(join(root, LOCK)) })
  const KEPT_SID = 'ag0123456789abcdef0123456789abcd'

  it('7. version folders, an empty kept and a lock-only store: all gone after one start, then the helper folder, empty; one listing and one log line naming them', async () => {
    folder('0.1.0-aaaaaaaaaaaa')
    folder('.new-0123456789ab')
    leftovers()
    expect((await cleanUp()).sort()).toEqual(['.new-0123456789ab', '0.1.0-aaaaaaaaaaaa', 'kept', 'store'])
    expect(existsSync(root)).toBe(false)
    expect(helper.calls).toEqual([{ file: bundled, args: ['list', '--store', join(root, 'store')] }])
    expect(logs).toHaveLength(1)
    for (const name of ['.new-0123456789ab', '0.1.0-aaaaaaaaaaaa', 'kept (empty)', 'store (no record)', 'the helper folder itself']) expect(logs[0]).toContain(name)
  })

  it('8. no version folder, an empty kept and a lock-only store (what beta.18 leaves): gone after one start; either alone goes too; the rest of the folder stays', async () => {
    leftovers()
    expect((await cleanUp()).sort()).toEqual(['kept', 'store'])
    expect(existsSync(root)).toBe(false)
    expect(listCalls()).toHaveLength(1)

    leftovers()
    writeFileSync(join(root, 'bindings.json'), '{}')
    rmSync(join(root, 'kept'), { recursive: true })
    expect(await cleanUp()).toEqual(['store'])
    expect(names()).toEqual(['bindings.json'])

    leftovers()
    rmSync(join(root, 'store'), { recursive: true })
    expect(await cleanUp()).toEqual(['kept'])
    expect(names()).toEqual(['bindings.json'])
    expect(listCalls()).toHaveLength(3)
    expect(logs).toHaveLength(3)
    expect(logs[1]).not.toContain('the helper folder itself')
  })

  // A removal that took the lock and then could not take the folder (on
  // Windows a holder still ending has the store as its working folder) leaves
  // a store with nothing in it: the next start takes it, with an empty kept.
  it('8. a store with nothing in it (its lock gone, the folder not) and an empty kept go at the next start', async () => {
    folder('kept')
    folder('store')
    expect((await cleanUp()).sort()).toEqual(['kept', 'store'])
    expect(existsSync(root)).toBe(false)
    expect(listCalls()).toHaveLength(1)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('store (no record)')
  })

  // Each situation keeps both: what it puts there may need the store or its lock.
  const needs: Array<[string, () => string]> = [
    ['a store record (a plain terminal\'s, not listed)', () => {
      const h = new FakeHolder(heldSessionId('fedcba9876543210fedcba98'), 'fedcba9876543210fedcba98', join(root, 'store'))
      h.writeRecord()
      return join(root, 'store', `${h.sid}.json`)
    }],
    ['a kept record', () => {
      writeFileSync(join(root, 'kept', `${KEPT_SID}.json`), JSON.stringify({ v: 1, session: KEPT_SID }))
      return join(root, 'kept', `${KEPT_SID}.json`)
    }],
    ['the running mark', () => {
      writeFileSync(join(root, 'app-running.json'), JSON.stringify({ v: 1, pid: 1, at: 0 }))
      return join(root, 'app-running.json')
    }],
  ]
  for (const [what, make] of needs) {
    for (const withVersion of [true, false]) {
      it(`9. ${what}${withVersion ? ', with a version folder' : ', with no version folder'}: the empty kept and the lock-only store both stay`, async () => {
        leftovers()
        const made = make()
        if (withVersion) folder('0.1.0-aaaaaaaaaaaa')
        expect(await cleanUp()).toEqual(withVersion ? ['0.1.0-aaaaaaaaaaaa'] : [])
        expect(left()).toEqual({ kept: true, store: true, lock: true })
        expect(existsSync(made)).toBe(true)
        // A start with nothing to remove runs no exec.
        expect(listCalls()).toHaveLength(withVersion ? 1 : 0)
        expect(logs).toHaveLength(withVersion ? 1 : 0)
      })
    }
  }

  it('9. a listed holder (only the listing shows it): the empty kept and the lock-only store both stay', async () => {
    leftovers()
    const h = new FakeHolder(heldSessionId('0123456789abcdef01234567'), '0123456789abcdef01234567', join(root, 'store'))
    helper.holders.set(h.sid, h)
    expect(await cleanUp()).toEqual([])
    expect(left()).toEqual({ kept: true, store: true, lock: true })
    expect(listCalls()).toHaveLength(1)
    expect(logs).toEqual([])
  })

  it('9. a switch turned on while the version folders go (a manager made then): the empty kept and the lock-only store both stay', async () => {
    leftovers()
    folder('0.1.0-aaaaaaaaaaaa')
    // Asked at the entry, after the listing, and just before kept and store: only the third answers true.
    let asked = 0
    expect(await cleanUp({ stop: () => ++asked > 2 })).toEqual(['0.1.0-aaaaaaaaaaaa'])
    expect(asked).toBe(3)
    expect(left()).toEqual({ kept: true, store: true, lock: true })
    expect(logs).toHaveLength(1)
  })

  it('10. a kept or a store holding anything else, or a link: both stay, and with nothing else to remove no listing is run', async () => {
    const elsewhere = join(dir, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, '.lock'), '')
    const cases: Array<[string, () => void]> = [
      ['a folder in kept', () => folder(join('kept', 'x'))],
      ['a temporary file in store', () => writeFileSync(join(root, 'store', 'pt0123.json.12.tmp'), '')],
      ['a folder named .lock', () => { rmSync(join(root, LOCK)); folder(LOCK) }],
      ['a store that is a link', () => { rmSync(join(root, 'store'), { recursive: true }); symlinkSync(elsewhere, join(root, 'store'), 'junction') }],
    ]
    for (const [what, make] of cases) {
      leftovers()
      make()
      const before = names()
      expect(await cleanUp(), what).toEqual([])
      expect(names(), what).toEqual(before)
      expect(existsSync(join(root, 'kept')), what).toBe(true)
      rmSync(root, { recursive: true })
    }
    expect(existsSync(join(elsewhere, '.lock'))).toBe(true)
    expect(helper.calls).toEqual([])
    expect(logs).toEqual([])
  })
})
