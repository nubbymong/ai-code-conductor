/**
 * Where the app keeps the record of its run, app-run.json (aicc_planning#330,
 * #334). At start-up the app hands the session helper's console-hosts mode the
 * record of the run before, and the helper ends the console hosts that run
 * left. The record follows the rule vision-started.json follows (#727): the
 * user data folder for an installed app, and an E2E or dev run's own data root
 * otherwise. A dev run shares the user data folder with an installed app on
 * the same computer (docs/dev-alongside-prod.md), so before this it read the
 * installed app's record, handed its pid to the helper, and wrote its own
 * record over it. A data root that is not absolute gives no record at all.
 *
 * This drives the real start-up call, endLeftoverConsoleHostsAtStart, with
 * real files in a temp folder. child_process and Electron are replaced, and
 * the helper is an empty file that is never run: nothing here starts a program.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const sys = vi.hoisted(() => ({
  isPackaged: true,
  userData: '',
  helper: '',
  /** Each run of the helper: its file and arguments. */
  runs: [] as { file: string; args: string[] }[],
  /** The clean-quit callbacks the app registered. */
  quits: [] as (() => void)[],
  logs: [] as string[],
}))

/** The creation time the helper reports for this process. */
const CREATED = '134080000000000100'

vi.mock('child_process', () => ({
  execFile: (file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    sys.runs.push({ file, args })
    setImmediate(() => cb(null, `{"pid":${process.pid},"created":"${CREATED}","ended":0}\n`, ''))
  },
}))
vi.mock('electron', () => ({
  app: {
    get isPackaged() { return sys.isPackaged },
    getAppPath: () => path.dirname(sys.helper),
    getPath: (name: string) => {
      if (name !== 'userData' || sys.userData === '') throw new Error(`test: no ${name} folder`)
      return sys.userData
    },
    once: (event: string, fn: () => void) => { if (event === 'will-quit') sys.quits.push(fn) },
  },
}))
vi.mock('../../../src/main/debug-logger', () => ({
  logInfo: (line: string) => { sys.logs.push(line) },
  logError: (line: string) => { sys.logs.push(`ERROR ${line}`) },
}))
vi.mock('../../../src/main/session-helper/install', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/session-helper/install')>()),
  bundledHelperPath: () => sys.helper,
}))

const { endLeftoverConsoleHostsAtStart, RUN_RECORD_FILE } = await import('../../../src/main/console-host-leftovers')

const ROOTS = ['CCC_DEV_DATA_DIR', 'CCC_E2E_DATA_DIR'] as const
const savedRoots = Object.fromEntries(ROOTS.map((n) => [n, process.env[n]]))
const realPlatform = process.platform
const PREFIX = 'aicc-run-record-'
const RELATIVE_ROOT = 'aicc-run-record-relative-root'
let base = ''

/** The record an installed app wrote for its own run. */
const INSTALLED = '{"pid":7007,"created":"134078000000000500"}'
const recordIn = (dir: string): string | null => {
  try { return fs.readFileSync(path.join(dir, RUN_RECORD_FILE), 'utf8') } catch { return null }
}
const thisRun = `{"pid":${process.pid},"created":"${CREATED}"}`
const folder = (name: string): string => {
  const dir = path.join(base, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
/** Start-up runs in the background: wait until it has recorded this run. */
const started = async (): Promise<void> => {
  endLeftoverConsoleHostsAtStart()
  await vi.waitFor(() => expect(sys.quits.length).toBe(1))
}
/** Start-up that is expected to do nothing: give it time to, then look. */
const startedNothing = async (): Promise<void> => {
  endLeftoverConsoleHostsAtStart()
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  for (const name of ROOTS) delete process.env[name]
  base = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX))
  sys.isPackaged = true
  sys.userData = folder('userData')
  sys.helper = path.join(folder('app'), 'aicc-helper.exe')
  fs.writeFileSync(sys.helper, '')
  // The installed app on this computer has recorded its run.
  fs.writeFileSync(path.join(sys.userData, RUN_RECORD_FILE), INSTALLED)
  sys.runs.length = 0
  sys.quits.length = 0
  sys.logs.length = 0
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  // Only this test's own temp folder.
  const made = base
  base = ''
  if (made !== '' && path.basename(made).startsWith(PREFIX)) fs.rmSync(made, { recursive: true, force: true })
})

afterAll(() => {
  for (const name of ROOTS) {
    if (savedRoots[name] === undefined) delete process.env[name]
    else process.env[name] = savedRoots[name]
  }
})

describe('the record of the run, app-run.json, follows the data root rule of vision-started.json (aicc_planning#334)', () => {
  it('an installed app reads and writes its record in the user data folder, as before', async () => {
    await started()
    expect(sys.runs).toEqual([{ file: sys.helper, args: ['console-hosts', '--pid', '7007', '--created', '134078000000000500'] }])
    expect(recordIn(sys.userData)).toBe(thisRun)
    sys.quits[0]()
    expect(recordIn(sys.userData)).toBeNull()
  })

  it('an installed app keeps to the user data folder even when CCC_DEV_DATA_DIR is set', async () => {
    const dev = folder('dev-data')
    process.env.CCC_DEV_DATA_DIR = dev
    await started()
    expect(sys.runs[0].args).toEqual(['console-hosts', '--pid', '7007', '--created', '134078000000000500'])
    expect(recordIn(sys.userData)).toBe(thisRun)
    expect(recordIn(dev)).toBeNull()
  })

  it('a dev run keeps its record in its own data root, and never reads, hands on or replaces the installed app\'s', async () => {
    sys.isPackaged = false
    const dev = folder('dev-data')
    process.env.CCC_DEV_DATA_DIR = dev
    await started()
    // No record of a dev run yet: the helper is given no earlier run.
    expect(sys.runs).toEqual([{ file: sys.helper, args: ['console-hosts'] }])
    expect(recordIn(dev)).toBe(thisRun)
    expect(recordIn(sys.userData), "the installed app's record").toBe(INSTALLED)
    // A clean quit removes the dev run's record, and only that.
    sys.quits[0]()
    expect(recordIn(dev)).toBeNull()
    expect(recordIn(sys.userData), "the installed app's record").toBe(INSTALLED)

    // The next dev start reads the record of the dev run before it.
    fs.writeFileSync(path.join(dev, RUN_RECORD_FILE), '{"pid":5151,"created":"134079000000000300"}')
    sys.runs.length = 0
    sys.quits.length = 0
    await started()
    expect(sys.runs[0].args).toEqual(['console-hosts', '--pid', '5151', '--created', '134079000000000300'])
    expect(recordIn(dev)).toBe(thisRun)
    expect(recordIn(sys.userData), "the installed app's record").toBe(INSTALLED)
  })

  it('an E2E run keeps its record in its own data root, packaged or not', async () => {
    for (const packaged of [true, false]) {
      sys.isPackaged = packaged
      const e2e = folder(`e2e-data-${packaged}`)
      process.env.CCC_E2E_DATA_DIR = e2e
      sys.runs.length = 0
      sys.quits.length = 0
      await started()
      expect(sys.runs[0].args, `packaged: ${packaged}`).toEqual(['console-hosts'])
      expect(recordIn(e2e), `packaged: ${packaged}`).toBe(thisRun)
      expect(recordIn(sys.userData), "the installed app's record").toBe(INSTALLED)
    }
  })

  it('a data root that is not absolute gives no record: nothing is read or written, and the helper is not run', async () => {
    sys.isPackaged = false
    process.env.CCC_DEV_DATA_DIR = RELATIVE_ROOT
    await startedNothing()
    expect(sys.runs).toEqual([])
    expect(sys.quits).toEqual([])
    expect(recordIn(sys.userData), "the installed app's record").toBe(INSTALLED)
    expect(fs.existsSync(path.resolve(RELATIVE_ROOT)), 'nothing made under the working folder').toBe(false)
    expect(sys.logs.filter((l) => l.startsWith('ERROR'))).toEqual([])
  })
})
