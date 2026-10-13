// A folder chosen in first-run setup must be a full (absolute) path.
// setDataDirectory and setResourcesDirectory answer false for an empty or
// blank path and for a relative one, before any folder is created and before
// anything is saved, so the setup screen stays on the folder step and says
// the folder could not be saved. Without this an empty Data Directory field
// was saved as an empty registry value (which reads back as absent, so setup
// showed again on the next start) and a relative one was created and saved
// relative to the app's working folder.
//
// The REAL data-paths and the REAL registry run here, with the platform
// forced to Windows or to Linux. reg.exe is never started (child_process is
// replaced outright), folder creation is a stub that records what it was
// asked, and the macOS/Linux config file lives in memory. The folders are
// literals that read the same on every host; whether one is a full path is
// judged by the forced platform's rules, not the host's.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'

const h = vi.hoisted(() => ({
  adds: [] as string[][],
  made: [] as string[],
  configWrites: [] as string[],
}))

vi.mock('child_process', () => ({
  execFileSync: (_file: string, args: string[]) => {
    if (args[0] === 'add') { h.adds.push([...args]); return '' }
    throw new Error('not there')
  },
}))
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  const stub = {
    mkdirSync: vi.fn((p: import('fs').PathLike) => { h.made.push(String(p)); return undefined }),
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => { throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }) }),
    writeFileSync: vi.fn((p: import('fs').PathOrFileDescriptor) => { h.configWrites.push(String(p)) }),
  }
  return { ...real, ...stub, default: { ...real, ...stub } }
})
vi.mock('../../../src/main/windows-programs', () => ({ systemTool: (rel: string) => `C:\\Windows\\System32\\${rel}` }))
vi.unmock('../../../src/main/data-paths')

const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

async function load(platform: 'win32' | 'linux') {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  vi.resetModules()
  const paths = await import('../../../src/main/data-paths')
  const { logInfo } = await import('../../../src/main/debug-logger')
  vi.mocked(logInfo).mockClear()
  const said = () => vi.mocked(logInfo).mock.calls.map((c) => String(c[0]))
  return { paths, said }
}

/** Nothing was created and nothing was saved. */
function expectNothingDone(label: string): void {
  expect(h.made, label).toEqual([])
  expect(h.adds, label).toEqual([])
  expect(h.configWrites, label).toEqual([])
}

function reset(): void {
  h.adds.length = 0
  h.made.length = 0
  h.configWrites.length = 0
}

beforeEach(() => {
  reset()
  // Folder creation must be the stub, or a relative literal below would be
  // created in the working folder.
  expect(vi.isMockFunction(fs.mkdirSync)).toBe(true)
  // The test home guard names a temp data folder (CCC_E2E_DATA_DIR), so
  // neither getter reads the real registry or the real LOCALAPPDATA.
  expect(process.env.CCC_E2E_DATA_DIR).toBeTruthy()
})
afterEach(() => {
  Object.defineProperty(process, 'platform', hostPlatform)
  vi.resetModules()
})

const WIN_NOT_FULL = ['ccc-data', '.\\ccc-data', '..\\ccc-data', 'C:ccc-data']
// C:\ccc-data is a full path only by Windows rules; on Linux it is a folder
// name in the working folder.
const POSIX_NOT_FULL = ['ccc-data', './ccc-data', '../ccc-data', '~/ccc-data', 'C:\\ccc-data']

describe('an empty or blank folder is refused before anything is created or saved', () => {
  // Mutation to prove this can fail: drop the check (an empty value is saved and answered as set).
  for (const platform of ['win32', 'linux'] as const) {
    it(`${platform}: the data and the resources directory`, async () => {
      const { paths, said } = await load(platform)
      const heard: string[] = []
      paths.onResourcesDirectoryChanged((dir) => heard.push(dir))
      for (const chosen of ['', '   ', '\t']) {
        reset()
        expect(paths.setDataDirectory(chosen), JSON.stringify(chosen)).toBe(false)
        expect(paths.setResourcesDirectory(chosen), JSON.stringify(chosen)).toBe(false)
        expectNothingDone(JSON.stringify(chosen))
      }
      expect(heard).toEqual([])
      expect(paths.isDataDirFromRegistry()).toBe(false)
      // The log says why. Mutation to prove this can fail: drop the blank check (the
      // full-path check alone refuses it too, but the log then gives the wrong reason).
      expect(said()).toContain('[setup] Data directory not set: the path is empty')
      expect(said()).toContain('[setup] Resources directory not set: the path is empty')
    })
  }
})

describe('a relative folder is refused before anything is created or saved', () => {
  // Mutation to prove this can fail: drop the full-path check, or make it after the folders are created.
  it('win32: a bare name, ./ or ../, and a drive with no backslash after it (C:name)', async () => {
    const { paths, said } = await load('win32')
    const heard: string[] = []
    paths.onResourcesDirectoryChanged((dir) => heard.push(dir))
    for (const chosen of WIN_NOT_FULL) {
      reset()
      expect(paths.setDataDirectory(chosen), chosen).toBe(false)
      expect(paths.setResourcesDirectory(chosen), chosen).toBe(false)
      expectNothingDone(chosen)
    }
    expect(heard).toEqual([])
    expect(paths.isDataDirFromRegistry()).toBe(false)
    expect(paths.getDataDirectory()).not.toBe('ccc-data')
    expect(said()).toContain('[setup] Data directory not set: the path is not a full path')
    expect(said()).toContain('[setup] Resources directory not set: the path is not a full path')
  })

  // Mutation to prove this can fail: judge a full path by the host's rules
  // (on a Windows host, C:\ccc-data is one).
  it('linux: a bare name, ./ or ../, ~ (which only a shell expands), and a Windows drive path', async () => {
    const { paths } = await load('linux')
    for (const chosen of POSIX_NOT_FULL) {
      reset()
      expect(paths.setDataDirectory(chosen), chosen).toBe(false)
      expect(paths.setResourcesDirectory(chosen), chosen).toBe(false)
      expectNothingDone(chosen)
    }
    expect(paths.isDataDirFromRegistry()).toBe(false)
  })

  it('a value that is not text at all is refused the same way', async () => {
    const { paths } = await load('win32')
    for (const chosen of [undefined, null, 42, {}]) {
      reset()
      expect(paths.setDataDirectory(chosen as unknown as string)).toBe(false)
      expect(paths.setResourcesDirectory(chosen as unknown as string)).toBe(false)
      expectNothingDone(String(chosen))
    }
  })
})

describe('a full path is set', () => {
  // Mutation to prove this can fail: judge a full path by the host's rules
  // (on a macOS or Linux host, C:\... is not one).
  it('win32: a drive path and a share', async () => {
    const { paths } = await load('win32')
    for (const chosen of ['C:\\ccc-test\\data', '\\\\server\\share\\ccc-test']) {
      reset()
      expect(paths.setDataDirectory(chosen), chosen).toBe(true)
      expect(h.made.length, chosen).toBeGreaterThan(0)
      expect(h.made.every((p) => p.startsWith(chosen)), chosen).toBe(true)
      expect(h.adds, chosen).toHaveLength(1)
      expect(h.adds[0][h.adds[0].indexOf('/d') + 1]).toBe(chosen)
      expect(paths.getDataDirectory()).toBe(chosen)
    }
    reset()
    expect(paths.setResourcesDirectory('C:\\ccc-test\\res')).toBe(true)
    expect(h.adds).toHaveLength(1)
    expect(paths.getResourcesDirectory()).toBe('C:\\ccc-test\\res')
  })

  it('linux: a path from the root', async () => {
    const { paths } = await load('linux')
    expect(paths.setDataDirectory('/ccc-test/data')).toBe(true)
    expect(h.made.length).toBeGreaterThan(0)
    expect(h.configWrites.some((p) => p.endsWith('platform-config.json'))).toBe(true)
    expect(paths.isDataDirFromRegistry()).toBe(true)
    expect(paths.getDataDirectory()).toBe('/ccc-test/data')
  })
})
