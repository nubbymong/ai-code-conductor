// A finished run removes the temp folders it made, and only those.
//
// Covers tests/global-setup.ts and tests/helpers/vitest-run-tag.mjs. The teardown used
// to remove EVERY `ccc-vitest-*` folder in the machine temp folder, which took the
// working folders away from any other run going on at the same time. Now each run has
// a tag, the workers name their folders with it, and the teardown removes only the
// folders that carry it, plus any `ccc-vitest-*` folder untouched for 24 hours (litter
// from a run that was killed), which no live run's folder can be.
//
// Everything made here is under this worker's own temp root (os.tmpdir() is redirected
// to it by tests/helpers/test-tmp.ts), never the machine temp folder: the removal step
// is run on a scratch folder of its own.
import { afterAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { TEST_TMP_ROOT } from '../../helpers/test-tmp'
import { isolatedRoot } from '../../helpers/home-guard-core.mjs'
import {
  RUN_TAG_ENV,
  STALE_AFTER_MS,
  isRunTag,
  newRunTag,
  removeRunTempFolders,
  removeStaleTempFolders,
  runTempPrefix,
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
