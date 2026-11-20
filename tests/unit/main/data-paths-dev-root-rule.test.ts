// The app's data and resources folders take the dev or end-to-end root by the
// one rule (src/main/dev-data-root.ts devDataRoot; aicc_planning#345), and the
// default data folder takes LOCALAPPDATA only when it is a full path.
//
// What changed, each case red before the change:
//   - an installed (packaged) app ignores CCC_DEV_DATA_DIR, as devSessionDataDir
//     and helperRootDir already did;
//   - a root that is not a full path is ignored, instead of putting the data
//     folder under the folder the app started in, and a relative end-to-end
//     root is not swapped for the dev root. A run that is not installed then
//     uses a `dev` folder inside the installed app's data folder, as
//     helperRootDir does, so it still keeps off that app's data; an installed
//     app uses its own folders;
//   - a relative LOCALAPPDATA gives the <home>\AppData\Local default.
// What did not change is proven by the existing data-path tests, run as they
// were (data-paths-dev.test.ts, data-paths.test.ts and the others).
//
// The REAL data-paths runs here. The registry is a stub that answers a fixed
// folder, or nothing, so no case reads the real registry. Packaged is read
// from where the code runs (runsFromAppArchive), which a test cannot move, so
// the packaged cases replace that one function and keep the rest of the leaf.
// The stub records the folder it is asked about, so the cases also pin that
// data-paths asks about its own folder.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as path from 'path'
import { homedir } from 'os'

const h = vi.hoisted(() => ({
  /** What the registry stub answers, by value name; absent: nothing saved. */
  registry: {} as Record<string, string>,
  /** True: the code reads as running from inside the app's archive. */
  packaged: false,
  /** Every folder runsFromAppArchive was asked about. */
  dirs: [] as string[],
}))

vi.mock('../../../src/main/registry', () => ({
  readRegistry: (name: string) => h.registry[name] ?? null,
  writeRegistry: () => false,
}))
vi.mock('../../../src/main/dev-data-root', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/dev-data-root')>()
  return {
    ...real,
    runsFromAppArchive: (dir: string) => {
      h.dirs.push(dir)
      return h.packaged || real.runsFromAppArchive(dir)
    },
  }
})
vi.unmock('../../../src/main/data-paths')

/** A full path on this computer, whichever it is. */
const full = (name: string) => path.join(process.platform === 'win32' ? 'C:\\' : '/', 'ccc-test', name)
const REG_DATA = full('registry-data')
const REG_RES = full('registry-resources')
/** The folder data-paths.ts sits in. */
const DATA_PATHS_DIR = path.resolve(__dirname, '..', '..', '..', 'src', 'main')

const VARS = ['CCC_E2E_DATA_DIR', 'CCC_DEV_DATA_DIR', 'LOCALAPPDATA'] as const
const saved: Record<string, string | undefined> = {}
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

async function load() {
  vi.resetModules()
  const mod = await import('../../../src/main/data-paths')
  const logger = await import('../../../src/main/debug-logger')
  return { mod, logInfo: vi.mocked(logger.logInfo) }
}

beforeEach(() => {
  for (const v of VARS) saved[v] = process.env[v]
  // The test home guard pins CCC_E2E_DATA_DIR before every test, and it
  // outranks the dev root: each case starts without it and sets what it needs.
  delete process.env.CCC_E2E_DATA_DIR
  delete process.env.CCC_DEV_DATA_DIR
  h.registry = { DataDirectory: REG_DATA, ResourcesDirectory: REG_RES }
  h.packaged = false
  h.dirs = []
})

afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v]
    else process.env[v] = saved[v]
  }
  Object.defineProperty(process, 'platform', hostPlatform)
  vi.resetModules()
})

describe('an installed app ignores CCC_DEV_DATA_DIR', () => {
  it('the data and resources folders are the registry\'s, not the dev root', async () => {
    h.packaged = true
    process.env.CCC_DEV_DATA_DIR = full('dev')
    const { mod } = await load()
    expect(mod.getDataDirectory()).toBe(REG_DATA)
    expect(mod.getResourcesDirectory()).toBe(REG_RES)
    // "Installed" is read from data-paths' own folder: an installed app runs
    // it from inside its archive, while its program and working folders are not.
    expect(h.dirs.map((d) => path.resolve(d))).toContain(DATA_PATHS_DIR)
  })

  it('a full end-to-end root is still used, packaged or not', async () => {
    h.packaged = true
    process.env.CCC_E2E_DATA_DIR = full('e2e')
    process.env.CCC_DEV_DATA_DIR = full('dev')
    const { mod } = await load()
    expect(mod.getDataDirectory()).toBe(full('e2e'))
    expect(mod.isDataDirFromRegistry()).toBe(true)
    expect(mod.getResourcesDirectory()).toBe(path.join(full('e2e'), 'resources'))
  })
})

describe('a root that is not a full path is ignored', () => {
  it('a relative dev root: a dev folder inside the installed app\'s data folder, and the log says why', async () => {
    process.env.CCC_DEV_DATA_DIR = path.join('rel', 'dev')
    const { mod, logInfo } = await load()
    expect(mod.getDataDirectory()).toBe(path.join(REG_DATA, 'dev'))
    // Treated as configured, as a dev root is: the setup wizard is skipped.
    expect(mod.isDataDirFromRegistry()).toBe(true)
    // Never the installed app's resources folder, even though the registry names one.
    expect(mod.getResourcesDirectory()).toBe(path.join(REG_DATA, 'dev', 'resources'))
    expect(logInfo).toHaveBeenCalledWith('[setup] CCC_DEV_DATA_DIR ignored: it is not a full path')
  })

  it('a relative end-to-end root is not swapped for a full dev root', async () => {
    process.env.CCC_E2E_DATA_DIR = path.join('rel', 'e2e')
    process.env.CCC_DEV_DATA_DIR = full('dev')
    const { mod, logInfo } = await load()
    expect(mod.getDataDirectory()).toBe(path.join(REG_DATA, 'dev'))
    expect(mod.getResourcesDirectory()).toBe(path.join(REG_DATA, 'dev', 'resources'))
    expect(logInfo).toHaveBeenCalledWith('[setup] CCC_E2E_DATA_DIR ignored: it is not a full path')
  })

  it('with nothing saved, the dev folder is inside the default data folder', async () => {
    h.registry = {}
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    process.env.LOCALAPPDATA = path.join(homedir(), 'local-app-data')
    process.env.CCC_DEV_DATA_DIR = path.join('rel', 'dev')
    const { mod } = await load()
    const data = mod.getDataDirectory()
    expect(path.basename(data)).toBe('dev')
    expect(path.dirname(path.dirname(data))).toBe(process.env.LOCALAPPDATA)
    expect(mod.isDataDirFromRegistry()).toBe(true)
    expect(mod.getResourcesDirectory()).toBe(path.join(data, 'resources'))
  })

  it('an installed app with a relative end-to-end root uses its own folders', async () => {
    h.packaged = true
    process.env.CCC_E2E_DATA_DIR = path.join('rel', 'e2e')
    const { mod, logInfo } = await load()
    expect(mod.getDataDirectory()).toBe(REG_DATA)
    expect(mod.getResourcesDirectory()).toBe(REG_RES)
    expect(logInfo).toHaveBeenCalledWith('[setup] CCC_E2E_DATA_DIR ignored: it is not a full path')
  })
})

describe('the default data folder on Windows takes LOCALAPPDATA only when it is a full path', () => {
  // The platform is Windows for these cases on every host. Nothing is saved in
  // the registry and no root applies, so the default folder is used. Which of
  // its names (the current one or an older one) depends on what exists; the
  // folder it sits in is what these cases judge.
  beforeEach(() => {
    h.registry = {}
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  })

  it('a relative LOCALAPPDATA: the folder is under <home>\\AppData\\Local, not the working folder', async () => {
    process.env.LOCALAPPDATA = path.join('rel', 'local')
    const { mod } = await load()
    expect(path.dirname(mod.getDataDirectory())).toBe(path.join(homedir(), 'AppData', 'Local'))
  })

  it('a full LOCALAPPDATA is used as it is', async () => {
    process.env.LOCALAPPDATA = path.join(homedir(), 'local-app-data')
    const { mod } = await load()
    expect(path.dirname(mod.getDataDirectory())).toBe(process.env.LOCALAPPDATA)
    expect(mod.isDataDirFromRegistry()).toBe(false)
  })
})
