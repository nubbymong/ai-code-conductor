// A folder chosen in first-run setup counts as set only once the registry has
// saved it. setDataDirectory and setResourcesDirectory answer false, keep the
// folder they had and tell no listener when the registry write is refused
// before reg.exe starts (a folder name holding a line or paragraph separator,
// which registry.ts does not save) or when reg.exe itself fails. The setup
// screen reads that false and stays on the folder step.
//
// The REAL data-paths and the REAL registry run here. reg.exe is never
// started: child_process is replaced outright and the platform is forced to
// Windows. The folders are Windows-shaped literals (C:\ccc-test\...), the same
// on every host, and folder creation is stubbed, so nothing is created on disk
// and no host path (a POSIX temp path starts with /, which registry.ts refuses)
// reaches the registry. The stub is checked before each test.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'

const h = vi.hoisted(() => ({
  adds: [] as string[][],
  /** reg.exe's answer to `add`: '' when it saves, a throw when it fails. */
  add: (): string => '',
  /** Every folder data-paths asked to create (none is created). */
  made: [] as string[],
}))

vi.mock('child_process', () => ({
  execFileSync: (_file: string, args: string[]) => {
    if (args[0] === 'add') { h.adds.push([...args]); return h.add() }
    throw new Error('not there')
  },
}))
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  const mkdirSync = vi.fn((p: import('fs').PathLike) => { h.made.push(String(p)); return undefined })
  return { ...real, default: { ...real, mkdirSync }, mkdirSync }
})
vi.mock('../../../src/main/windows-programs', () => ({ systemTool: (rel: string) => `C:\\Windows\\System32\\${rel}` }))
vi.unmock('../../../src/main/data-paths')

const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const LS = String.fromCharCode(0x2028)
const DATA = 'C:\\ccc-test\\data'
const RES = 'C:\\ccc-test\\res'

async function load() {
  vi.resetModules()
  return import('../../../src/main/data-paths')
}

beforeEach(() => {
  h.adds.length = 0
  h.made.length = 0
  h.add = () => ''
  // Folder creation must be the stub, or the literals above would be created.
  expect(vi.isMockFunction(fs.mkdirSync)).toBe(true)
  // The test home guard names a temp data folder (CCC_E2E_DATA_DIR) before
  // each test. getDataDirectory and getResourcesDirectory answer from it when
  // nothing was set, so neither reads the real registry or the real
  // LOCALAPPDATA, and a folder that was set wins over it from the cache.
  expect(process.env.CCC_E2E_DATA_DIR).toBeTruthy()
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', hostPlatform)
  vi.resetModules()
})

describe('a data directory the registry did not save is not reported as set', () => {
  // Mutation to prove this can fail: ignore writeRegistry's answer.
  it('a folder name holding U+2028: refused before reg.exe starts, answered false, not set', async () => {
    const paths = await load()
    const chosen = `${DATA}${LS}dir`
    expect(paths.setDataDirectory(chosen)).toBe(false)
    expect(h.adds).toEqual([])
    expect(paths.isDataDirFromRegistry()).toBe(false)
    expect(paths.getDataDirectory()).not.toBe(chosen)
  })

  // Mutation to prove this can fail: set the cache before reading writeRegistry's answer.
  it('reg.exe fails: answered false, not set', async () => {
    h.add = () => { throw new Error('reg.exe failed') }
    const paths = await load()
    expect(paths.setDataDirectory(DATA)).toBe(false)
    expect(h.adds).toHaveLength(1)
    expect(paths.isDataDirFromRegistry()).toBe(false)
    expect(paths.getDataDirectory()).not.toBe(DATA)
  })

  it('a folder the registry saves is set', async () => {
    const paths = await load()
    expect(paths.setDataDirectory(DATA)).toBe(true)
    expect(h.made.length).toBeGreaterThan(0)
    expect(h.made.every((p) => p.startsWith(DATA))).toBe(true)
    expect(h.adds).toHaveLength(1)
    expect(h.adds[0][h.adds[0].indexOf('/d') + 1]).toBe(DATA)
    expect(paths.isDataDirFromRegistry()).toBe(true)
    expect(paths.getDataDirectory()).toBe(DATA)
  })
})

describe('a resources directory the registry did not save is not reported as set', () => {
  // Mutation to prove this can fail: ignore writeRegistry's answer.
  it('a folder name holding U+2028: refused before reg.exe starts, answered false, not set, no listener told', async () => {
    const paths = await load()
    const heard: string[] = []
    paths.onResourcesDirectoryChanged((dir) => heard.push(dir))
    const chosen = `${RES}${LS}dir`
    expect(paths.setResourcesDirectory(chosen)).toBe(false)
    expect(h.adds).toEqual([])
    expect(heard).toEqual([])
    expect(paths.getResourcesDirectory()).not.toBe(chosen)
  })

  // Mutation to prove this can fail: tell the listeners before reading writeRegistry's answer.
  it('reg.exe fails: answered false, not set, no listener told', async () => {
    h.add = () => { throw new Error('reg.exe failed') }
    const paths = await load()
    const heard: string[] = []
    paths.onResourcesDirectoryChanged((dir) => heard.push(dir))
    expect(paths.setResourcesDirectory(RES)).toBe(false)
    expect(h.adds).toHaveLength(1)
    expect(heard).toEqual([])
    expect(paths.getResourcesDirectory()).not.toBe(RES)
  })

  it('a folder the registry saves is set and the listeners are told', async () => {
    const paths = await load()
    const heard: string[] = []
    paths.onResourcesDirectoryChanged((dir) => heard.push(dir))
    expect(paths.setResourcesDirectory(RES)).toBe(true)
    expect(h.made.length).toBeGreaterThan(0)
    expect(h.made.every((p) => p.startsWith(RES))).toBe(true)
    expect(h.adds).toHaveLength(1)
    expect(heard).toEqual([RES])
    expect(paths.getResourcesDirectory()).toBe(RES)
  })
})
