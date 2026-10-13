// macOS and Linux have no registry: writeRegistry saves its values in a small
// config file (platform-config.json under the home folder). When that file
// cannot be written (a read-only or full home folder, a folder that cannot be
// created), writeRegistry answers false, as the Windows registry branch does
// for a value reg.exe did not save. setDataDirectory and setResourcesDirectory
// then answer false too, and first-run setup stays on the folder step instead
// of reporting the folder as set.
//
// Nothing is written to disk: fs is replaced by an in-memory stand-in for the
// four calls registry.ts and data-paths.ts make, and the platform is forced
// to Linux. The folders are literals that read the same on every host.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'

const h = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirs: new Set<string>(),
  writes: [] as string[],
  /** An error code the config file's write throws, or null when it is written. */
  writeFails: null as string | null,
  /** An error code creating the config file's folder throws, or null. */
  configDirFails: null as string | null,
}))

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  const fail = (code: string) => Object.assign(new Error(`${code}: operation refused`), { code })
  const stub = {
    existsSync: vi.fn((p: import('fs').PathLike) => h.files.has(String(p)) || h.dirs.has(String(p))),
    readFileSync: vi.fn((p: import('fs').PathOrFileDescriptor) => {
      const text = h.files.get(String(p))
      if (text === undefined) throw fail('ENOENT')
      return text
    }),
    writeFileSync: vi.fn((p: import('fs').PathOrFileDescriptor, data: unknown) => {
      h.writes.push(String(p))
      if (h.writeFails) throw fail(h.writeFails)
      h.files.set(String(p), String(data))
    }),
    mkdirSync: vi.fn((p: import('fs').PathLike) => {
      const dir = String(p)
      if (h.configDirFails && /[\\/]\.ai-code-conductor$/.test(dir)) throw fail(h.configDirFails)
      h.dirs.add(dir)
      return undefined
    }),
  }
  return { ...real, ...stub, default: { ...real, ...stub } }
})
vi.mock('child_process', () => ({ execFileSync: () => { throw new Error('reg.exe is not started on Linux') } }))
vi.mock('../../../src/main/windows-programs', () => ({ systemTool: (rel: string) => `C:\\Windows\\System32\\${rel}` }))
vi.unmock('../../../src/main/data-paths')

const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

async function load() {
  vi.resetModules()
  const registry = await import('../../../src/main/registry')
  const paths = await import('../../../src/main/data-paths')
  return { registry, paths }
}

beforeEach(() => {
  h.files.clear()
  h.dirs.clear()
  h.writes.length = 0
  h.writeFails = null
  h.configDirFails = null
  // Every file call must be the in-memory stand-in.
  expect(vi.isMockFunction(fs.writeFileSync)).toBe(true)
  expect(vi.isMockFunction(fs.mkdirSync)).toBe(true)
  expect(process.env.CCC_E2E_DATA_DIR).toBeTruthy()
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', hostPlatform)
  vi.resetModules()
})

describe('macOS/Linux: a config file that could not be written is not answered as saved', () => {
  // Mutation to prove this can fail: let writeFallbackConfig keep its error to itself again.
  it('the write is refused (EACCES, ENOSPC, EROFS): writeRegistry answers false', async () => {
    const { registry } = await load()
    for (const code of ['EACCES', 'ENOSPC', 'EROFS']) {
      h.writeFails = code
      h.writes.length = 0
      expect(registry.writeRegistry('DataDirectory', '/ccc-test/data'), code).toBe(false)
      expect(h.writes, code).toHaveLength(1)
      expect(h.writes[0], code).toMatch(/platform-config\.json$/)
    }
    expect(registry.readRegistry('DataDirectory')).toBeNull()
  })

  // Mutation to prove this can fail: catch the folder's error apart from the write's and go on.
  it('the config file\'s folder cannot be created: writeRegistry answers false and nothing is written', async () => {
    h.configDirFails = 'EACCES'
    const { registry } = await load()
    expect(registry.writeRegistry('DataDirectory', '/ccc-test/data')).toBe(false)
    expect(h.writes).toEqual([])
  })

  // Mutation to prove this can fail: ignore writeRegistry's answer in data-paths.
  it('setDataDirectory and setResourcesDirectory answer false and set nothing', async () => {
    h.writeFails = 'EACCES'
    const { paths } = await load()
    const heard: string[] = []
    paths.onResourcesDirectoryChanged((dir) => heard.push(dir))
    expect(paths.setDataDirectory('/ccc-test/data')).toBe(false)
    expect(paths.isDataDirFromRegistry()).toBe(false)
    expect(paths.getDataDirectory()).not.toBe('/ccc-test/data')
    expect(paths.setResourcesDirectory('/ccc-test/res')).toBe(false)
    expect(heard).toEqual([])
    expect(paths.getResourcesDirectory()).not.toBe('/ccc-test/res')
  })

  it('a config file that is written: answered true, and the value reads back', async () => {
    const { registry, paths } = await load()
    expect(registry.writeRegistry('ResourcesDirectory', '/ccc-test/res')).toBe(true)
    expect(registry.readRegistry('ResourcesDirectory')).toBe('/ccc-test/res')
    expect(paths.setDataDirectory('/ccc-test/data')).toBe(true)
    expect(paths.isDataDirFromRegistry()).toBe(true)
    expect(registry.readRegistry('DataDirectory')).toBe('/ccc-test/data')
    // One file holds both values.
    const written = [...h.files.entries()].filter(([p]) => p.endsWith('platform-config.json'))
    expect(written).toHaveLength(1)
    expect(JSON.parse(written[0][1])).toEqual({ ResourcesDirectory: '/ccc-test/res', DataDirectory: '/ccc-test/data' })
  })
})
