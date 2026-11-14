// A finished run removes the temp folders it made, and only those.
//
// Covers tests/global-setup.ts and tests/helpers/vitest-run-tag.mjs. The teardown used
// to remove EVERY `ccc-vitest-*` folder in the machine temp folder, which took the
// working folders away from any other run going on at the same time. Now each run has
// a tag, the workers name their folders with it, and the teardown removes only the
// folders that carry it, plus any `ccc-vitest-*` folder untouched for 24 hours whose
// run's owner is gone (litter from a run that was killed). A run that is still going
// on is not litter however old its folders are: a watch run can last for days, and a
// write inside a folder that already exists does not move the modified time of the
// root above it. So global setup records the run's owner process in a small file per
// tag, the teardown removes it, and the age sweep keeps the folders of a run whose
// owner is alive. A folder with no record keeps the plain 24-hour rule.
//
// Everything made here is under this worker's own temp root (os.tmpdir() is redirected
// to it by tests/helpers/test-tmp.ts), never the machine temp folder: the removal step
// is run on a scratch folder of its own. Whether an owner is alive is always a fake
// here (a stub passed in, or a stub of process.kill that never calls through): no test
// signals a real process.
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { TEST_TMP_ROOT } from '../../helpers/test-tmp'
import { isolatedRoot } from '../../helpers/home-guard-core.mjs'
import {
  RUN_TAG_ENV,
  STALE_AFTER_MS,
  isOwnerAlive,
  isRunTag,
  newRunTag,
  readRunOwner,
  removeRunOwner,
  removeRunTempFolders,
  removeStaleTempFolders,
  runTempPrefix,
  writeRunOwner,
} from '../../helpers/vitest-run-tag.mjs'
import globalSetup, { sweepAfterRun } from '../../global-setup'

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-run-tag-'))

afterAll(() => {
  // TEST CLEANUP GUARD: this file's own scratch folder only.
  if (path.basename(SCRATCH).startsWith('ccc-run-tag-')) fs.rmSync(SCRATCH, { recursive: true, force: true })
})

/** A folder with a file in it, so a removal has something to recurse into. */
function plant(dir: string, name: string): string {
  const p = path.join(dir, name)
  fs.mkdirSync(path.join(p, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(p, 'sub', 'file.txt'), 'x')
  return p
}

function fresh(): string {
  return fs.mkdtempSync(path.join(SCRATCH, 'case-'))
}

/** Set a folder's modified time `ageMs` into the past. Call it AFTER planting its contents. */
function age(dir: string, ageMs: number): void {
  const when = new Date(Date.now() - ageMs)
  fs.utimesSync(dir, when, when)
}

const HOUR = 60 * 60 * 1000

describe('the scratch folder is not the machine temp folder', () => {
  it('lives inside this worker\'s own temp root', () => {
    const inside = path.resolve(SCRATCH).toLowerCase().startsWith(path.resolve(TEST_TMP_ROOT).toLowerCase() + path.sep)
    expect(inside, `${SCRATCH} is not inside ${TEST_TMP_ROOT}`).toBe(true)
  })
})

describe('removeRunTempFolders', () => {
  it('removes this run\'s folders and leaves another run\'s, an untagged one and unrelated ones alone', () => {
    const tmp = fresh()
    const mine = newRunTag()
    let other = newRunTag()
    while (other === mine) other = newRunTag()

    const gone = [plant(tmp, `ccc-vitest-${mine}-AbCdEf`), plant(tmp, `ccc-vitest-${mine}-home-123456`)]
    const stay = [
      plant(tmp, `ccc-vitest-${other}-AbCdEf`),
      plant(tmp, `ccc-vitest-${other}-home-123456`),
      plant(tmp, 'ccc-vitest-legacy1'), // an old-style folder, made with no tag
      plant(tmp, `ccc-vitest-${mine}`), // this tag but no dash after it
      plant(tmp, `ccc-vitest-${mine}x-AbCdEf`), // starts like this tag, is not it
      plant(tmp, 'something-else'),
    ]

    const removed = removeRunTempFolders(tmp, mine)

    expect(removed.sort()).toEqual(gone.map((p) => path.basename(p)).sort())
    for (const p of gone) expect(fs.existsSync(p), `${p} should be removed`).toBe(false)
    for (const p of stay) expect(fs.existsSync(path.join(p, 'sub', 'file.txt')), `${p} should be left alone`).toBe(true)
  })

  it.each([
    ['an empty tag', ''],
    ['the bare prefix', 'ccc-vitest'],
    ['upper case', 'ABCDEF12'],
    ['too short', 'abc'],
    ['too long', 'aaaaaaaaa'],
    ['a path', '../x'],
    ['a tag with a tail', 'aaaaaaaa-extra'],
    ['undefined', undefined],
  ])('removes nothing without a well-formed tag (%s)', (_label, tag) => {
    const tmp = fresh()
    const folders = [
      plant(tmp, 'ccc-vitest-aaaaaaaa-AbCdEf'),
      plant(tmp, 'ccc-vitest-legacy1'),
      plant(tmp, 'ccc-vitest--x'),
    ]
    expect(removeRunTempFolders(tmp, tag as unknown as string)).toEqual([])
    for (const p of folders) expect(fs.existsSync(p), `${p} should be left alone`).toBe(true)
  })

  it('a temp folder that is not there is not an error', () => {
    expect(removeRunTempFolders(path.join(fresh(), 'missing'), newRunTag())).toEqual([])
  })
})

describe('removeStaleTempFolders', () => {
  it('removes a ccc-vitest folder untouched for over 24 hours and leaves a fresh one of another run', () => {
    expect(STALE_AFTER_MS).toBe(24 * HOUR)
    const tmp = fresh()
    const oldTagged = plant(tmp, `ccc-vitest-${newRunTag()}-AbCdEf`)
    const oldLegacy = plant(tmp, 'ccc-vitest-legacy1') // an old-style folder, made with no tag
    age(oldTagged, 25 * HOUR)
    age(oldLegacy, 25 * HOUR)
    const freshOtherRun = plant(tmp, `ccc-vitest-${newRunTag()}-AbCdEf`)
    const justUnder = plant(tmp, 'ccc-vitest-home-1') // 23 hours old: a run could still be on it
    age(justUnder, 23 * HOUR)
    const oldUnrelated = plant(tmp, 'something-else') // old, but not ours
    age(oldUnrelated, 48 * HOUR)

    const removed = removeStaleTempFolders(tmp)

    expect(removed.sort()).toEqual([path.basename(oldLegacy), path.basename(oldTagged)].sort())
    expect(fs.existsSync(oldTagged), 'old tagged folder should be removed').toBe(false)
    expect(fs.existsSync(oldLegacy), 'old untagged folder should be removed').toBe(false)
    for (const p of [freshOtherRun, justUnder, oldUnrelated]) {
      expect(fs.existsSync(path.join(p, 'sub', 'file.txt')), `${p} should be left alone`).toBe(true)
    }
  })

  it('leaves an old file named like one of its folders alone, and a missing temp folder is not an error', () => {
    const tmp = fresh()
    const file = path.join(tmp, 'ccc-vitest-oldfile')
    fs.writeFileSync(file, 'x')
    const when = new Date(Date.now() - 48 * HOUR)
    fs.utimesSync(file, when, when)
    expect(removeStaleTempFolders(tmp)).toEqual([])
    expect(fs.existsSync(file)).toBe(true)
    expect(removeStaleTempFolders(path.join(tmp, 'missing'))).toEqual([])
  })
})

describe('removeStaleTempFolders keeps the folders of a run whose owner is alive', () => {
  /** A tag no other test in this file uses, with its owner recorded as `pid`. */
  function ownedRun(tmp: string, pid = 4242): string {
    const tag = newRunTag()
    expect(writeRunOwner(tmp, tag, { pid, startedAt: Date.now() - 30 * HOUR })).toBe(true)
    return tag
  }

  it('an old folder whose owner is alive stays, root and isolated home alike', () => {
    const tmp = fresh()
    const tag = ownedRun(tmp)
    const root = plant(tmp, `ccc-vitest-${tag}-AbCdEf`)
    const home = plant(tmp, `ccc-vitest-${tag}-home-123456`)
    age(root, 25 * HOUR)
    age(home, 90 * HOUR)
    const isAlive = vi.fn<(owner: { pid: number; startedAt: number }) => boolean>(() => true)

    const removed = removeStaleTempFolders(tmp, STALE_AFTER_MS, Date.now(), isAlive)

    expect(removed).toEqual([])
    for (const p of [root, home]) expect(fs.existsSync(path.join(p, 'sub', 'file.txt')), `${p} should stay`).toBe(true)
    expect(isAlive).toHaveBeenCalled()
    for (const call of isAlive.mock.calls) expect(call[0]).toMatchObject({ pid: 4242 })
  })

  it('an old folder whose owner is gone is removed', () => {
    const tmp = fresh()
    const tag = ownedRun(tmp, 777)
    const root = plant(tmp, `ccc-vitest-${tag}-AbCdEf`)
    const home = plant(tmp, `ccc-vitest-${tag}-home-123456`)
    age(root, 25 * HOUR)
    age(home, 25 * HOUR)
    const isAlive = vi.fn(() => false)

    const removed = removeStaleTempFolders(tmp, STALE_AFTER_MS, Date.now(), isAlive)

    expect(removed.sort()).toEqual([path.basename(home), path.basename(root)].sort())
    expect(fs.existsSync(root)).toBe(false)
    expect(fs.existsSync(home)).toBe(false)
    expect(isAlive).toHaveBeenCalledWith(expect.objectContaining({ pid: 777 }))
  })

  it('an old folder with no owner record is removed by the plain 24-hour rule, with no liveness check', () => {
    const tmp = fresh()
    const tagged = plant(tmp, `ccc-vitest-${newRunTag()}-AbCdEf`) // a tag whose record was never written
    const untagged = plant(tmp, 'ccc-vitest-legacy1')
    const home = plant(tmp, 'ccc-vitest-home-123456')
    for (const p of [tagged, untagged, home]) age(p, 25 * HOUR)
    const isAlive = vi.fn(() => true)

    const removed = removeStaleTempFolders(tmp, STALE_AFTER_MS, Date.now(), isAlive)

    expect(removed.sort()).toEqual([tagged, untagged, home].map((p) => path.basename(p)).sort())
    expect(isAlive).not.toHaveBeenCalled()
  })

  it('a fresh folder of another run stays even when its owner is gone', () => {
    const tmp = fresh()
    const tag = ownedRun(tmp)
    const young = plant(tmp, `ccc-vitest-${tag}-AbCdEf`)
    const justUnder = plant(tmp, `ccc-vitest-${tag}-home-123456`)
    age(justUnder, 23 * HOUR)

    expect(removeStaleTempFolders(tmp, STALE_AFTER_MS, Date.now(), () => false)).toEqual([])
    for (const p of [young, justUnder]) expect(fs.existsSync(path.join(p, 'sub', 'file.txt')), `${p} should stay`).toBe(true)
  })

  it('judges each run by its own owner: a live run stays, a dead one beside it goes', () => {
    const tmp = fresh()
    const live = ownedRun(tmp, 111)
    const dead = ownedRun(tmp, 222)
    const liveRoot = plant(tmp, `ccc-vitest-${live}-AbCdEf`)
    const deadRoot = plant(tmp, `ccc-vitest-${dead}-AbCdEf`)
    age(liveRoot, 40 * HOUR)
    age(deadRoot, 40 * HOUR)

    const removed = removeStaleTempFolders(tmp, STALE_AFTER_MS, Date.now(), (owner) => owner.pid === 111)

    expect(removed).toEqual([path.basename(deadRoot)])
    expect(fs.existsSync(liveRoot)).toBe(true)
    expect(fs.existsSync(deadRoot)).toBe(false)
  })

  it('a liveness check that throws cannot say the run is over: the folder stays', () => {
    const tmp = fresh()
    const tag = ownedRun(tmp)
    const root = plant(tmp, `ccc-vitest-${tag}-AbCdEf`)
    age(root, 25 * HOUR)

    const removed = removeStaleTempFolders(tmp, STALE_AFTER_MS, Date.now(), () => {
      throw new Error('probe failed')
    })

    expect(removed).toEqual([])
    expect(fs.existsSync(root)).toBe(true)
  })

  it.each([
    ['not JSON', 'not json'],
    ['an empty object', '{}'],
    ['a pid of zero', JSON.stringify({ pid: 0, startedAt: 1 })],
    ['a negative pid', JSON.stringify({ pid: -5, startedAt: 1 })],
    ['a fractional pid', JSON.stringify({ pid: 1.5, startedAt: 1 })],
    ['a pid that is a string', JSON.stringify({ pid: '4242', startedAt: 1 })],
    ['no start time', JSON.stringify({ pid: 4242 })],
    ['a record that is far too big', JSON.stringify({ pid: 4242, startedAt: 1, pad: 'x'.repeat(5000) })],
  ])('an owner record that cannot be trusted (%s) is no record: the plain 24-hour rule applies', (_label, text) => {
    const tmp = fresh()
    const tag = newRunTag()
    fs.writeFileSync(path.join(tmp, `ccc-vitest-owner-${tag}.json`), text)
    const root = plant(tmp, `ccc-vitest-${tag}-AbCdEf`)
    age(root, 25 * HOUR)
    const isAlive = vi.fn(() => true)

    expect(readRunOwner(tmp, tag)).toBeNull()
    expect(removeStaleTempFolders(tmp, STALE_AFTER_MS, Date.now(), isAlive)).toEqual([path.basename(root)])
    expect(isAlive).not.toHaveBeenCalled()
  })

  it('an owner record that is a folder is no record', () => {
    const tmp = fresh()
    const tag = newRunTag()
    fs.mkdirSync(path.join(tmp, `ccc-vitest-owner-${tag}.json`))
    expect(readRunOwner(tmp, tag)).toBeNull()
  })

  it('an old owner record goes when its run is over, and stays while the run is alive or young', () => {
    const tmp = fresh()
    const deadTag = ownedRun(tmp, 222)
    const liveTag = ownedRun(tmp, 111)
    const youngDeadTag = ownedRun(tmp, 333)
    const record = (tag: string) => path.join(tmp, `ccc-vitest-owner-${tag}.json`)
    age(record(deadTag), 30 * HOUR)
    age(record(liveTag), 30 * HOUR)
    // youngDeadTag's record was just written: not old enough to look at.

    removeStaleTempFolders(tmp, STALE_AFTER_MS, Date.now(), (owner) => owner.pid === 111)

    expect(fs.existsSync(record(deadTag)), 'the old record of a dead run should be removed').toBe(false)
    expect(fs.existsSync(record(liveTag)), 'the old record of a live run should stay').toBe(true)
    expect(fs.existsSync(record(youngDeadTag)), 'a young record should stay').toBe(true)
  })

  it('an owner record is a file, never counted or removed as a folder', () => {
    const tmp = fresh()
    const tag = ownedRun(tmp, 222)
    const record = path.join(tmp, `ccc-vitest-owner-${tag}.json`)
    age(record, 30 * HOUR)
    // Only the folder pass can put a name in the result, and a record is not a folder.
    expect(removeStaleTempFolders(tmp, STALE_AFTER_MS, Date.now(), () => true)).toEqual([])
    expect(fs.existsSync(record)).toBe(true)
  })
})

describe('the owner record', () => {
  it('is written, read back, and removed', () => {
    const tmp = fresh()
    const tag = newRunTag()
    expect(readRunOwner(tmp, tag)).toBeNull()
    expect(writeRunOwner(tmp, tag, { pid: 1234, startedAt: 99 })).toBe(true)
    expect(readRunOwner(tmp, tag)).toEqual({ pid: 1234, startedAt: 99 })
    expect(fs.existsSync(path.join(tmp, `ccc-vitest-owner-${tag}.json`))).toBe(true)
    removeRunOwner(tmp, tag)
    expect(readRunOwner(tmp, tag)).toBeNull()
    expect(fs.existsSync(path.join(tmp, `ccc-vitest-owner-${tag}.json`))).toBe(false)
  })

  it('defaults to this process and the current time', () => {
    const tmp = fresh()
    const tag = newRunTag()
    const before = Date.now()
    expect(writeRunOwner(tmp, tag)).toBe(true)
    const owner = readRunOwner(tmp, tag)
    expect(owner?.pid).toBe(process.pid)
    expect(owner?.startedAt).toBeGreaterThanOrEqual(before)
  })

  it('is never written over a file that is already there, and never for a malformed tag', () => {
    const tmp = fresh()
    const tag = newRunTag()
    expect(writeRunOwner(tmp, tag, { pid: 1, startedAt: 1 })).toBe(true)
    expect(writeRunOwner(tmp, tag, { pid: 2, startedAt: 2 })).toBe(false)
    expect(readRunOwner(tmp, tag)).toEqual({ pid: 1, startedAt: 1 })
    expect(writeRunOwner(tmp, '../x', { pid: 1, startedAt: 1 })).toBe(false)
    expect(writeRunOwner(path.join(tmp, 'missing'), newRunTag(), { pid: 1, startedAt: 1 })).toBe(false)
    expect(fs.readdirSync(tmp)).toEqual([`ccc-vitest-owner-${tag}.json`])
  })

  it('removeRunOwner with a malformed tag removes nothing', () => {
    const tmp = fresh()
    const tag = newRunTag()
    writeRunOwner(tmp, tag, { pid: 1, startedAt: 1 })
    removeRunOwner(tmp, '')
    removeRunOwner(tmp, '../x')
    expect(readRunOwner(tmp, tag)).toEqual({ pid: 1, startedAt: 1 })
  })
})

describe('isOwnerAlive (process.kill is stubbed: nothing is ever signalled)', () => {
  const failWith = (code: string) => () => {
    throw Object.assign(new Error(code), { code })
  }

  it('is alive when the probe finds the process, and the probe is signal 0', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      expect(isOwnerAlive({ pid: 4242, startedAt: 1 })).toBe(true)
      expect(kill).toHaveBeenCalledWith(4242, 0)
    } finally {
      kill.mockRestore()
    }
  })

  it('is gone on ESRCH', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(failWith('ESRCH'))
    try {
      expect(isOwnerAlive({ pid: 4242, startedAt: 1 })).toBe(false)
    } finally {
      kill.mockRestore()
    }
  })

  it('is alive on EPERM (the process exists, it belongs to someone else) and on any other error', () => {
    for (const code of ['EPERM', 'EINVAL']) {
      const kill = vi.spyOn(process, 'kill').mockImplementation(failWith(code))
      try {
        expect(isOwnerAlive({ pid: 4242, startedAt: 1 }), code).toBe(true)
      } finally {
        kill.mockRestore()
      }
    }
  })
})

describe('runTempPrefix', () => {
  it('carries the run tag, and the plain prefix when there is none or it is malformed', () => {
    const tag = newRunTag()
    expect(runTempPrefix('', { [RUN_TAG_ENV]: tag })).toBe(`ccc-vitest-${tag}-`)
    expect(runTempPrefix('home-', { [RUN_TAG_ENV]: tag })).toBe(`ccc-vitest-${tag}-home-`)
    expect(runTempPrefix('', {})).toBe('ccc-vitest-')
    expect(runTempPrefix('home-', {})).toBe('ccc-vitest-home-')
    expect(runTempPrefix('home-', { [RUN_TAG_ENV]: '../x' })).toBe('ccc-vitest-home-')
  })
})

describe('sweepAfterRun (the teardown global setup returns)', () => {
  it('removes this run\'s folders and a stray mock folder, and nothing of another run or an old-style one', () => {
    const scratch = fresh()
    const mine = newRunTag()
    let other = newRunTag()
    while (other === mine) other = newRunTag()

    const gone = [plant(scratch, `ccc-vitest-${mine}-a`), plant(scratch, 'mock')]
    const stay = [
      plant(scratch, `ccc-vitest-${other}-a`),
      plant(scratch, 'ccc-vitest-legacy1'),
      plant(scratch, 'something-else'),
    ]

    sweepAfterRun(mine, scratch, [scratch])

    for (const p of gone) expect(fs.existsSync(p), `${p} should be removed`).toBe(false)
    for (const p of stay) expect(fs.existsSync(path.join(p, 'sub', 'file.txt')), `${p} should be left alone`).toBe(true)
  })

  it('also removes a ccc-vitest folder older than 24 hours, but not a young one of another run', () => {
    const scratch = fresh()
    const oldFolder = plant(scratch, `ccc-vitest-${newRunTag()}-old`)
    age(oldFolder, 25 * HOUR)
    const young = plant(scratch, `ccc-vitest-${newRunTag()}-young`)

    sweepAfterRun(newRunTag(), scratch, [scratch])

    expect(fs.existsSync(oldFolder), 'the old folder should be removed').toBe(false)
    expect(fs.existsSync(path.join(young, 'sub', 'file.txt')), 'the young folder should be left alone').toBe(true)
  })
})

describe('sweepAfterRun and the owner record', () => {
  it('removes this run\'s own owner record, and leaves another run\'s', () => {
    const scratch = fresh()
    const mine = newRunTag()
    const other = newRunTag()
    writeRunOwner(scratch, mine, { pid: 111, startedAt: Date.now() })
    writeRunOwner(scratch, other, { pid: 222, startedAt: Date.now() })

    sweepAfterRun(mine, scratch, [scratch], () => true)

    expect(readRunOwner(scratch, mine), 'its own record should go').toBeNull()
    expect(readRunOwner(scratch, other), 'another run\'s record should stay').toEqual(expect.objectContaining({ pid: 222 }))
  })

  it('keeps an old folder of another run that is still alive, and takes an old folder of one that is not', () => {
    const scratch = fresh()
    const live = newRunTag()
    const dead = newRunTag()
    writeRunOwner(scratch, live, { pid: 111, startedAt: Date.now() - 50 * HOUR })
    writeRunOwner(scratch, dead, { pid: 222, startedAt: Date.now() - 50 * HOUR })
    const liveRoot = plant(scratch, `ccc-vitest-${live}-AbCdEf`)
    const deadRoot = plant(scratch, `ccc-vitest-${dead}-AbCdEf`)
    age(liveRoot, 50 * HOUR)
    age(deadRoot, 50 * HOUR)

    sweepAfterRun(newRunTag(), scratch, [scratch], (owner) => owner.pid === 111)

    expect(fs.existsSync(path.join(liveRoot, 'sub', 'file.txt')), 'the live run\'s old folder should stay').toBe(true)
    expect(fs.existsSync(deadRoot), 'the dead run\'s old folder should be removed').toBe(false)
  })
})

describe('global setup', () => {
  it('puts a fresh tag in the environment, and returns the teardown', () => {
    const before = process.env[RUN_TAG_ENV]
    try {
      const teardown = globalSetup()
      const tag = process.env[RUN_TAG_ENV]
      expect(isRunTag(tag), `tag was ${String(tag)}`).toBe(true)
      expect(tag).not.toBe(before)
      expect(typeof teardown).toBe('function')
    } finally {
      if (isRunTag(process.env[RUN_TAG_ENV])) removeRunOwner(os.tmpdir(), process.env[RUN_TAG_ENV] as string)
      if (before === undefined) delete process.env[RUN_TAG_ENV]
      else process.env[RUN_TAG_ENV] = before
    }
  })

  it('records this process as the owner of the run it starts', () => {
    const before = process.env[RUN_TAG_ENV]
    const insideTestRoot = path.resolve(os.tmpdir()).toLowerCase().startsWith(path.resolve(TEST_TMP_ROOT).toLowerCase())
    expect(insideTestRoot, `${os.tmpdir()} is not this worker's temp root`).toBe(true)
    let tag: string | undefined
    try {
      globalSetup()
      tag = process.env[RUN_TAG_ENV]
      expect(isRunTag(tag), `tag was ${String(tag)}`).toBe(true)
      const owner = readRunOwner(os.tmpdir(), tag as string)
      expect(owner, 'no owner record').not.toBeNull()
      expect(owner?.pid).toBe(process.pid)
      expect(owner?.startedAt).toBeLessThanOrEqual(Date.now())
    } finally {
      if (isRunTag(tag)) removeRunOwner(os.tmpdir(), tag as string)
      if (before === undefined) delete process.env[RUN_TAG_ENV]
      else process.env[RUN_TAG_ENV] = before
    }
  })

  it('the tag reached this worker: its temp root and isolated home are named with it', () => {
    const tag = process.env[RUN_TAG_ENV]
    expect(isRunTag(tag), `tag was ${String(tag)}`).toBe(true)
    expect(path.basename(TEST_TMP_ROOT).startsWith(`ccc-vitest-${tag}-`), path.basename(TEST_TMP_ROOT)).toBe(true)
    const home = isolatedRoot()
    expect(home, 'no isolated home').toBeTruthy()
    expect(path.basename(home as string).startsWith(`ccc-vitest-${tag}-home-`), path.basename(home as string)).toBe(true)
  })
})
