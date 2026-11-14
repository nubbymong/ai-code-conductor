// A finished run removes the temp folders it made, and only those.
//
// Covers tests/global-setup.ts and tests/helpers/vitest-run-tag.mjs. The teardown used
// to remove EVERY `ccc-vitest-*` folder in the machine temp folder, which took the
// working folders away from any other run going on at the same time. Now each run has
// a tag, the workers name their folders with it, and the teardown removes only the
// folders that carry it.
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
import { RUN_TAG_ENV, isRunTag, newRunTag, removeRunTempFolders, runTempPrefix } from '../../helpers/vitest-run-tag.mjs'
import globalSetup from '../../global-setup'

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
