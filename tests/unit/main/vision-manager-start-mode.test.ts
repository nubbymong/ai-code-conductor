/**
 * On Windows the vision browser is started through the session helper's start
 * mode (`aicc-helper start`, plan 2.1.3-beta.8 section C2), so it keeps none
 * of the app's handles. It is then not the app's child: it is tracked by the
 * pid and creation time the helper printed, and ended only while that pid
 * still has that creation time, never by its pid alone: through the helper's
 * end mode (`aicc-helper end`, a few milliseconds, no PowerShell), the one
 * beside the app or else the copy the session helper checked this run. A
 * record of its pid and creation time in the user data folder lets the next
 * start end one this run could not (#329). Without the helper, when the start
 * started nothing, for a browser named by a bare name, and on macOS and
 * Linux, the launch is the plain spawn it always was. A start that may have
 * started the browser without saying so is not followed by a second one.
 *
 * child_process, fs, net and Electron are replaced and the OS is a fake
 * process table behind the injected OwnerPorts: nothing here starts a program.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import * as path from 'path'
import * as nodeOs from 'os'
import { createHash } from 'crypto'
import type { OwnerPorts } from '../../../src/main/vision-browser-owner'

type HelperAnswer =
  | { kind: 'ok' }
  | { kind: 'exit'; code: number; stderr: string }
  | { kind: 'print'; stdout: string }
  | { kind: 'timeout' }
  | { kind: 'spawnError' }

const sys = vi.hoisted(() => ({
  platform: 'win32' as NodeJS.Platform,
  /** Files that exist. */
  present: new Set<string>(),
  /** Running processes: pid -> creation time. */
  procs: new Map<number, string>(),
  nextPid: 5000,
  nextCreated: 134078000000000000,
  answer: { kind: 'ok' } as HelperAnswer,
  /** Every awaited OS call fails, as a check that timed out does. */
  failAsync: false,
  /** The helper's end mode fails with this error (a timeout, an exit 1). */
  helperEndFails: null as Error | null,
  /** The user data folder: a real temp folder of this test, where the record goes. */
  userData: '',
  /** The per-user copy of the helper the session helper checked, once a test makes one. */
  copyExe: '',
  /** An installed app; false for a dev run. */
  isPackaged: true,
  execFiles: [] as Array<{ file: string; args: string[]; opts: Record<string, unknown> }>,
  spawns: [] as Array<{ executable: string; args: string[]; opts: Record<string, unknown> }>,
  runs: [] as Array<{ file: string; args: string[]; sync: boolean; timeoutMs: number; answer?: string }>,
  signals: [] as Array<[number, string]>,
  events: [] as string[],
}))
const log = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }))

vi.mock('child_process', async () => {
  const { EventEmitter: EE } = await import('events')
  return {
    execFile: (file: string, args: string[], opts: Record<string, unknown>, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      sys.execFiles.push({ file, args, opts })
      const a = sys.answer
      setImmediate(() => {
        // Node's own message for a failed execFile: the command line, then stderr.
        if (a.kind === 'exit') return cb(Object.assign(new Error(`Command failed: ${[file, ...args].join(' ')}${a.stderr ? `\n${a.stderr}` : ''}`), { code: a.code, killed: false, signal: null }), '', a.stderr)
        if (a.kind === 'print') return cb(null, a.stdout, '')
        if (a.kind === 'spawnError') {
          return cb(Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT', errno: -4058, syscall: `spawn ${file}`, path: file }), '', '')
        }
        // 'ok' and 'timeout' both start the browser; a timeout then says nothing.
        const pid = sys.nextPid++
        const created = String(sys.nextCreated += 10)
        sys.procs.set(pid, created)
        sys.events.push(`helper-start:${pid}`)
        if (a.kind === 'timeout') return cb(Object.assign(new Error('Command failed'), { code: null, killed: true, signal: 'SIGTERM' }), '', '')
        cb(null, `{"pid":${pid},"created":"${created}"}\r\n`, '')
      })
      return new EE()
    },
    spawn: (executable: string, args: string[], opts: Record<string, unknown>) => {
      sys.spawns.push({ executable, args, opts })
      const pid = sys.nextPid++
      sys.procs.set(pid, String(sys.nextCreated += 10))
      sys.events.push(`spawn:${pid}`)
      return Object.assign(new EE(), { pid, exitCode: null, signalCode: null, unref: () => {}, kill: () => true })
    },
    execFileSync: () => { throw new Error('test: execFileSync must not run') },
  }
})
// existsSync answers from the fake OS (the helper beside the app, the
// browser). Everything else is the real fs, used only in this test's own temp
// folder: the user data folder with the record, and a helper copy.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const existsSync = (p: string) => sys.present.has(p)
  return { ...actual, existsSync, default: { ...actual, existsSync } }
})
// Nothing is found listening, so a launch has nothing to free first.
vi.mock('net', () => ({
  Socket: class {
    private handlers: Record<string, (arg?: unknown) => void> = {}
    setTimeout() { /* noop */ }
    once(ev: string, cb: (arg?: unknown) => void) { this.handlers[ev] = cb; return this }
    connect() { queueMicrotask(() => this.handlers['error']?.(new Error('ECONNREFUSED'))) }
    destroy() { /* noop */ }
  },
}))
vi.mock('electron', () => ({
  app: {
    get isPackaged() { return sys.isPackaged },
    getAppPath: () => 'C:\\AICC\\resources\\app.asar',
    getPath: (name: string) => {
      if (name !== 'userData' || sys.userData === '') throw new Error(`test: no ${name} folder`)
      return sys.userData
    },
  },
  BrowserWindow: class {},
  nativeImage: {},
}))
vi.mock('../../../src/main/conductor-mcp-server', () => ({ getConductorMcpPort: () => 19333 }))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '/res' }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: log.info, logError: log.error, logWarn: vi.fn() }))

const {
  launchBrowser, killSpawnedBrowser, stopGlobalVision, buildBrowserLaunchArgs, parseHelperStart, endRecordedVisionBrowser, _setVisionOwnerPortsForTest,
} = await import('../../../src/main/vision-manager')
const { HELPER_END_TIMEOUT_MS } = await import('../../../src/main/vision-browser-owner')
const { installHelperCopy, _forgetCheckedHelperCopyForTest } = await import('../../../src/main/session-helper/install')
const realFs = await vi.importActual<typeof import('fs')>('fs')

const RESOURCES = 'C:\\AICC\\resources'
// As session-helper/install.ts bundledHelperPath joins it for a packaged app.
const HELPER = path.join(RESOURCES, 'helper', 'aicc-helper.exe')
// And for a dev run: the Cargo build beside the app's own folder.
const DEV_HELPER = path.join('C:\\AICC\\resources\\app.asar', 'helper', 'target', 'release', 'aicc-helper.exe')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const CHROME_FOLDER = 'C:\\Program Files\\Google\\Chrome\\Application'
const POSIX_CHROME: Record<string, string> = {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  linux: '/usr/bin/google-chrome',
}
const TASKKILL = 'C:\\Windows\\System32\\taskkill.exe'
const POWERSHELL = /WindowsPowerShell\\v1\.0\\powershell\.exe$/

/** The fake OS. The helper's end mode and the PowerShell end both end the
 *  pid only while its creation time is the one they are given, as the real
 *  ones do. */
function answer(file: string, args: string[]): string {
  if (file === TASKKILL) {
    const pid = Number(args[args.indexOf('/PID') + 1])
    sys.events.push(`taskkill:${pid}`)
    if (!sys.procs.delete(pid)) throw new Error('exited with status 128')
    return 'SUCCESS\r\n'
  }
  if (file === HELPER || file === DEV_HELPER || (sys.copyExe !== '' && file === sys.copyExe)) {
    expect(args[0], 'only the end mode is run synchronously or awaited').toBe('end')
    const pid = Number(args[args.indexOf('--pid') + 1])
    const want = args[args.indexOf('--created') + 1]
    sys.events.push(`helper-end:${pid}`)
    if (sys.helperEndFails) throw sys.helperEndFails
    if (sys.procs.get(pid) === want) { sys.procs.delete(pid); return 'ended\r\n' }
    return 'left\r\n'
  }
  expect(file).toMatch(POWERSHELL)
  const script = args[args.length - 1]
  expect(script, 'only the verified end is asked for').toMatch(/taskkill/)
  const pid = Number(/ProcessId=(\d+)/.exec(script)?.[1])
  const want = /-eq '(\d+)'/.exec(script)?.[1]
  sys.events.push(`verified-end:${pid}`)
  if (sys.procs.get(pid) === want) { sys.procs.delete(pid); return 'ended\r\n' }
  return 'left\r\n'
}

type Run = { file: string; args: string[]; sync: boolean; timeoutMs: number; answer?: string }
const fakePorts: OwnerPorts = {
  get platform() { return sys.platform },
  systemRoot: 'C:\\Windows',
  // A real end takes a moment to answer; so does this one.
  run: async (file, args, timeoutMs) => {
    const r: Run = { file, args, sync: false, timeoutMs }
    sys.runs.push(r)
    await new Promise((res) => setTimeout(res, 5))
    if (sys.failAsync) throw new Error('timed out')
    r.answer = answer(file, args)
    return r.answer
  },
  runSync: (file, args, timeoutMs) => {
    const r: Run = { file, args, sync: true, timeoutMs }
    sys.runs.push(r)
    r.answer = answer(file, args)
    return r.answer
  },
  signal: (pid, sig) => { sys.signals.push([pid, sig]); sys.procs.delete(Math.abs(pid)) },
  exists: () => true,
  realpath: () => null,
  sleep: async () => { await new Promise((r) => setTimeout(r, 0)) },
  sleepSync: () => {},
  profileLock: () => 'free',
  pidGone: (pid) => !sys.procs.has(pid),
}

const tmp = () => process.env.TEMP || process.env.TMP || nodeOs.tmpdir()
const argsFor = (headless: boolean) => buildBrowserLaunchArgs(9222, path.join(tmp(), 'chrome-debug-9222'), headless)
const logged = (re: RegExp) => log.info.mock.calls.filter(([m]) => re.test(String(m)))
const realPlatform = process.platform
const setPlatform = (p: NodeJS.Platform) => {
  sys.platform = p
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}
/** Every kill by a pid alone: taskkill run directly, or a signal. */
const pidOnlyKills = () => [...sys.runs.filter((r) => r.file === TASKKILL), ...sys.signals]
/** The helper's end mode, as the app must call it for this pid and creation time. */
const helperEnd = (pid: number, created: string) => ['end', '--pid', String(pid), '--created', created]
/** Every line the helper start and end decisions log. */
const HELPER_LINES = /session helper|started directly|without a full path|app-started browser|exited within/

/** The env vars that give a dev or E2E run its own data root, as the test process had them. */
const INSTANCE_ROOTS = ['CCC_DEV_DATA_DIR', 'CCC_E2E_DATA_DIR'] as const
const savedRoots = Object.fromEntries(INSTANCE_ROOTS.map((n) => [n, process.env[n]]))

beforeAll(() => { (process as unknown as { resourcesPath: string }).resourcesPath = RESOURCES })
afterAll(() => {
  delete (process as unknown as { resourcesPath?: string }).resourcesPath
  for (const name of INSTANCE_ROOTS) {
    if (savedRoots[name] === undefined) delete process.env[name]
    else process.env[name] = savedRoots[name]
  }
})

beforeEach(() => {
  setPlatform('win32')
  _setVisionOwnerPortsForTest(fakePorts)
  sys.helperEndFails = null
  sys.failAsync = false
  killSpawnedBrowser() // drop anything tracked by an earlier test
  _forgetCheckedHelperCopyForTest()
  sys.copyExe = ''
  sys.isPackaged = true
  // An installed app's run unless a test says otherwise: no dev or E2E data root.
  for (const name of INSTANCE_ROOTS) delete process.env[name]
  sys.userData = realFs.mkdtempSync(path.join(nodeOs.tmpdir(), 'aicc-vision-record-'))
  sys.present = new Set([HELPER, CHROME])
  sys.procs.clear()
  sys.answer = { kind: 'ok' }
  sys.execFiles.length = 0
  sys.spawns.length = 0
  sys.runs.length = 0
  sys.signals.length = 0
  sys.events.length = 0
  log.info.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  _setVisionOwnerPortsForTest(null)
  // Only this test's own temp folder.
  const made = sys.userData
  sys.userData = ''
  if (made !== '' && path.basename(made).startsWith('aicc-vision-record-')) realFs.rmSync(made, { recursive: true, force: true })
})

/** The record of the browser the helper started, as written in the user data folder. */
const recordFile = () => path.join(sys.userData, 'vision-started.json')
/** The record's text, or null when there is none. */
const recordText = (): string | null => {
  try { return realFs.readFileSync(recordFile(), 'utf8') } catch { return null }
}
const writeRecord = (text: string) => realFs.writeFileSync(recordFile(), text)
/** The record a start through the helper writes for this pid and creation time. */
const recordOf = (pid: number, created: string) => `{"pid":${pid},"created":"${created}"}\n`
/** A failure of the end mode as execFileSync and runAwait report one. */
const endTimedOut = () => Object.assign(new Error('timed out'), { timedOut: true })
const endExit1 = () => Object.assign(new Error('Command failed'), { status: 1, signal: null, stderr: 'aicc-helper: could not end process: Access is denied. (os error 5)\r\n' })
/** Every run of Windows PowerShell. */
const powershellRuns = () => sys.runs.filter((r) => POWERSHELL.test(r.file))

describe('Windows: the vision browser starts through the session helper', () => {
  it('runs the start mode with exactly the browser, its folder and its arguments, and never spawns it', async () => {
    const { pid } = await launchBrowser('chrome', 9222, undefined, true)
    expect(sys.spawns).toEqual([])
    expect(sys.execFiles).toHaveLength(1)
    const call = sys.execFiles[0]
    expect(call.file).toBe(HELPER)
    expect(call.args).toEqual(['start', '--hide', '--cwd', CHROME_FOLDER, '--', CHROME, ...argsFor(true)])
    expect(call.opts).toMatchObject({ windowsHide: true, timeout: 10_000 })
    expect(pid).toBe(5000)
    expect(logged(/The session helper started the vision browser \(pid 5000\)/)).toHaveLength(1)
  })

  it('a browser with a window is started without --hide', async () => {
    await launchBrowser('chrome', 9222, undefined, false)
    expect(sys.execFiles[0].args).toEqual(['start', '--cwd', CHROME_FOLDER, '--', CHROME, ...argsFor(false)])
    expect(sys.spawns).toEqual([])
  })
})

describe('Windows: a browser the helper started is ended only by its pid and start time', () => {
  it('the quit ends it through the helper\'s end mode, synchronously and bounded, never by its pid alone and with no PowerShell', async () => {
    const { pid } = await launchBrowser('chrome', 9222, undefined, true)
    const created = sys.procs.get(pid) as string
    expect(sys.runs).toEqual([])
    killSpawnedBrowser()
    expect(sys.runs).toHaveLength(1)
    expect(sys.runs[0]).toMatchObject({ file: HELPER, args: helperEnd(pid, created), sync: true, timeoutMs: HELPER_END_TIMEOUT_MS, answer: 'ended\r\n' })
    expect(sys.procs.has(pid)).toBe(false)
    expect(pidOnlyKills()).toEqual([])
    expect(logged(new RegExp(`Ended the app-started browser \\(pid ${pid}\\)`))).toHaveLength(1)
    // Safe to call again: nothing is tracked now.
    killSpawnedBrowser()
    expect(sys.runs).toHaveLength(1)
  })

  it('once its pid has another start time, the quit leaves that process alone, and says nothing', async () => {
    const { pid } = await launchBrowser('chrome', 9222, undefined, true)
    // The browser ended and another process took its pid.
    sys.procs.set(pid, '134078999999999990')
    killSpawnedBrowser()
    expect(sys.runs.map((r) => r.answer)).toEqual(['left\r\n'])
    expect(sys.procs.get(pid)).toBe('134078999999999990')
    expect(pidOnlyKills()).toEqual([])
    expect(logged(/app-started browser/)).toEqual([])
  })

  it('once no process has its pid, the quit runs nothing at all', async () => {
    const { pid } = await launchBrowser('chrome', 9222, undefined, true)
    sys.procs.delete(pid)
    killSpawnedBrowser()
    expect(sys.runs).toEqual([])
    expect(logged(/app-started browser/)).toEqual([])
  })

  it('a quit end that fails or times out is logged with its reason, as distinct from a browser that was left, and nothing is ended by its pid alone', async () => {
    for (const [what, fails, reason] of [
      ['a timeout', endTimedOut, 'no answer within 5 s'],
      ['an exit 1', endExit1, 'it exited with status 1: aicc-helper: could not end process: Access is denied. (os error 5)'],
    ] as const) {
      log.info.mockClear()
      sys.helperEndFails = null
      const { pid } = await launchBrowser('chrome', 9222, undefined, true)
      sys.helperEndFails = fails()
      killSpawnedBrowser()
      expect(sys.procs.has(pid), what).toBe(true)
      expect(logged(/Could not check the app-started browser/).map(([m]) => m), what).toEqual([
        `[vision] Could not check the app-started browser (pid ${pid}) at exit, so it was not ended (${reason}); the next start ends it if it still runs`,
      ])
      expect(logged(/Ended the app-started browser/), what).toEqual([])
      expect(pidOnlyKills(), what).toEqual([])
    }
  })

  // #329, the cause (C1): an uninstall for all users removed the helper
  // beside the app while this user's copy of the app ran. The quit then ran
  // the PowerShell end, which asks WMI: for a sign-in that may not read it,
  // that held the main process for 5 s and ended nothing.
  it('with the helper beside the app gone and no checked copy, the quit runs nothing, answers at once, and keeps the record for the next start', async () => {
    const { pid } = await launchBrowser('chrome', 9222, undefined, true)
    const created = sys.procs.get(pid) as string
    sys.present.delete(HELPER)
    killSpawnedBrowser()
    expect(sys.runs).toEqual([])
    expect(sys.procs.get(pid)).toBe(created)
    expect(recordText()).toBe(recordOf(pid, created))
    expect(logged(/Could not check the app-started browser/).map(([m]) => m)).toEqual([
      `[vision] Could not check the app-started browser (pid ${pid}) at exit, so it was not ended (there is no session helper to end it with); the next start ends it if it still runs`,
    ])
    expect(pidOnlyKills()).toEqual([])
    // The next start, with the helper installed again: ended through it, by pid and start time.
    sys.present.add(HELPER)
    await endRecordedVisionBrowser()
    expect(sys.runs).toHaveLength(1)
    expect(sys.runs[0]).toMatchObject({ file: HELPER, args: helperEnd(pid, created), sync: false, timeoutMs: HELPER_END_TIMEOUT_MS, answer: 'ended\r\n' })
    expect(sys.procs.has(pid)).toBe(false)
    expect(recordText()).toBeNull()
    expect(powershellRuns()).toEqual([])
  })

  // A real copy is hashed, and the end runs only a helper named by a
  // drive-absolute path, which a temp file has only on a Windows host. The
  // copy's own check runs on every OS (session-helper-install.test.ts).
  it.skipIf(process.platform !== 'win32')('with the helper beside the app gone, the quit ends the browser through the copy the session helper checked this run', async () => {
    // The session helper's copy, put in place and checked as a holder start does.
    const bundled = path.join(sys.userData, 'install', 'aicc-helper.exe')
    realFs.mkdirSync(path.dirname(bundled), { recursive: true })
    realFs.writeFileSync(bundled, 'MZ the installed helper')
    const sha256 = createHash('sha256').update('MZ the installed helper').digest('hex')
    const copy = await installHelperCopy({ bundled, root: path.join(sys.userData, 'helper'), version: '0.1.0', sha256, platform: 'win32' })
    sys.copyExe = copy.exe
    const { pid } = await launchBrowser('chrome', 9222, undefined, true)
    const created = sys.procs.get(pid) as string
    sys.present.delete(HELPER)
    killSpawnedBrowser()
    expect(sys.runs).toHaveLength(1)
    expect(sys.runs[0]).toMatchObject({ file: copy.exe, args: helperEnd(pid, created), sync: true, timeoutMs: HELPER_END_TIMEOUT_MS, answer: 'ended\r\n' })
    expect(sys.procs.has(pid)).toBe(false)
    expect(recordText()).toBeNull()
    expect(pidOnlyKills()).toEqual([])
    // A copy that no longer matches is not run: the quit answers at once and keeps the record.
    sys.present.add(HELPER)
    const second = await launchBrowser('chrome', 9222, undefined, true)
    sys.present.delete(HELPER)
    realFs.writeFileSync(copy.exe, 'MZ something else')
    sys.runs.length = 0
    killSpawnedBrowser()
    expect(sys.runs).toEqual([])
    expect(sys.procs.has(second.pid)).toBe(true)
    expect(recordText()).toBe(recordOf(second.pid, sys.procs.get(second.pid) as string))
  })

  it('a relaunch ends the one before through the awaited end, before the next start', async () => {
    const first = await launchBrowser('chrome', 9222, undefined, true)
    const created = sys.procs.get(first.pid) as string
    const second = await launchBrowser('chrome', 9222, undefined, true)
    expect(sys.runs).toHaveLength(1)
    expect(sys.runs[0]).toMatchObject({ file: HELPER, args: helperEnd(first.pid, created), sync: false, timeoutMs: HELPER_END_TIMEOUT_MS, answer: 'ended\r\n' })
    expect(sys.events).toEqual([`helper-start:${first.pid}`, `helper-end:${first.pid}`, `helper-start:${second.pid}`])
    expect(pidOnlyKills()).toEqual([])
    // The second is the one tracked now.
    killSpawnedBrowser()
    expect(sys.events[sys.events.length - 1]).toBe(`helper-end:${second.pid}`)
    expect(sys.procs.size).toBe(0)
  })

  it('a stop ends it through the awaited end', async () => {
    const { pid } = await launchBrowser('chrome', 9222, undefined, true)
    const created = sys.procs.get(pid) as string
    await stopGlobalVision()
    expect(sys.runs).toHaveLength(1)
    expect(sys.runs[0]).toMatchObject({ file: HELPER, args: helperEnd(pid, created), sync: false, answer: 'ended\r\n' })
    expect(sys.procs.has(pid)).toBe(false)
    expect(pidOnlyKills()).toEqual([])
    killSpawnedBrowser()
    expect(sys.runs).toHaveLength(1)
  })

  it('a stop whose check does not answer keeps it tracked, with one line in the log, so the quit still ends it by pid and start time', async () => {
    const { pid } = await launchBrowser('chrome', 9222, undefined, true)
    const created = sys.procs.get(pid) as string
    sys.failAsync = true
    await stopGlobalVision()
    expect(sys.procs.has(pid), 'the failed check ended it').toBe(true)
    expect(logged(new RegExp(`Could not check the app-started browser \\(pid ${pid}\\), so it was not ended`))).toHaveLength(1)
    killSpawnedBrowser()
    const sync = sys.runs.filter((r) => r.sync)
    expect(sync).toHaveLength(1)
    expect(sync[0]).toMatchObject({ file: HELPER, args: helperEnd(pid, created), answer: 'ended\r\n' })
    expect(sys.procs.has(pid)).toBe(false)
    expect(pidOnlyKills()).toEqual([])
  })

  it('a stop that finds its pid with another start time stops tracking it: the quit runs nothing more', async () => {
    const { pid } = await launchBrowser('chrome', 9222, undefined, true)
    sys.procs.set(pid, '134078999999999990')
    await stopGlobalVision()
    expect(sys.runs.map((r) => r.answer)).toEqual(['left\r\n'])
    killSpawnedBrowser()
    expect(sys.runs).toHaveLength(1)
    expect(sys.procs.get(pid)).toBe('134078999999999990')
  })

  it('a quit that comes while a stop is still checking still ends it, synchronously', async () => {
    const { pid } = await launchBrowser('chrome', 9222, undefined, true)
    // before-quit calls stopGlobalVision without waiting, then killSpawnedBrowser.
    const stopping = stopGlobalVision()
    killSpawnedBrowser()
    expect(sys.procs.has(pid), 'the quit did not end it').toBe(false)
    expect(sys.runs.find((r) => r.sync)?.answer).toBe('ended\r\n')
    await stopping
    expect(pidOnlyKills()).toEqual([])
  })
})

// #329: a browser the app could not end (an end that could not tell, or an
// app ended from outside) is ended at the next start, for every user: by the
// pid and creation time recorded at its start, through the helper's end mode
// alone, with no PowerShell and no WMI.
describe('Windows: the record of the browser the helper started', () => {
  it('a start through the helper writes its pid and creation time; an end that answers ended or left removes it; one that cannot tell keeps it', async () => {
    const first = await launchBrowser('chrome', 9222, undefined, true)
    expect(recordText()).toBe(recordOf(first.pid, sys.procs.get(first.pid) as string))
    killSpawnedBrowser() // ended
    expect(recordText()).toBeNull()

    const second = await launchBrowser('chrome', 9222, undefined, true)
    sys.procs.set(second.pid, '134078999999999990') // another process has its pid now
    killSpawnedBrowser() // left
    expect(recordText()).toBeNull()

    const third = await launchBrowser('chrome', 9222, undefined, true)
    const created = sys.procs.get(third.pid) as string
    sys.helperEndFails = endExit1()
    killSpawnedBrowser() // could not tell
    expect(recordText()).toBe(recordOf(third.pid, created))

    // The awaited end at a stop keeps it the same way, and removes it once it answers.
    // The next launch ends that one first, by its record.
    sys.helperEndFails = null
    const fourth = await launchBrowser('chrome', 9222, undefined, true)
    expect(sys.procs.has(third.pid)).toBe(false)
    expect(recordText()).toBe(recordOf(fourth.pid, sys.procs.get(fourth.pid) as string))
    sys.failAsync = true
    await stopGlobalVision()
    expect(recordText()).toBe(recordOf(fourth.pid, sys.procs.get(fourth.pid) as string))
    sys.failAsync = false
    await stopGlobalVision()
    expect(recordText()).toBeNull()
    expect(pidOnlyKills()).toEqual([])
  })

  it('at start-up a recorded browser is ended through the helper\'s end mode by its pid and creation time, with no PowerShell, and the record removed', async () => {
    sys.procs.set(7000, '134078000000000500')
    writeRecord(recordOf(7000, '134078000000000500'))
    await endRecordedVisionBrowser()
    expect(sys.runs).toEqual([{ file: HELPER, args: helperEnd(7000, '134078000000000500'), sync: false, timeoutMs: HELPER_END_TIMEOUT_MS, answer: 'ended\r\n' }])
    expect(sys.procs.has(7000)).toBe(false)
    expect(recordText()).toBeNull()
    expect(logged(/an earlier start recorded/).map(([m]) => m)).toEqual([
      '[vision] Ended the vision browser an earlier start recorded (pid 7000), by its pid and start time',
    ])
    expect(pidOnlyKills()).toEqual([])
    expect(powershellRuns()).toEqual([])
  })

  it('a recorded pid that another process has now is left running, and the record removed: never by its pid alone', async () => {
    sys.procs.set(7001, '134078999999999990')
    writeRecord(recordOf(7001, '134078000000000500'))
    await endRecordedVisionBrowser()
    expect(sys.runs.map((r) => r.answer)).toEqual(['left\r\n'])
    expect(sys.procs.get(7001)).toBe('134078999999999990')
    expect(recordText()).toBeNull()
    // A pid no process has: nothing is run at all.
    writeRecord(recordOf(7002, '134078000000000500'))
    sys.runs.length = 0
    await endRecordedVisionBrowser()
    expect(sys.runs).toEqual([])
    expect(recordText()).toBeNull()
    expect(pidOnlyKills()).toEqual([])
  })

  it('an end that cannot tell, or no helper to end it with, keeps the record and runs no PowerShell', async () => {
    sys.procs.set(7003, '134078000000000500')
    writeRecord(recordOf(7003, '134078000000000500'))
    sys.helperEndFails = endTimedOut()
    await endRecordedVisionBrowser()
    expect(sys.procs.has(7003)).toBe(true)
    expect(recordText()).toBe(recordOf(7003, '134078000000000500'))
    expect(logged(/Could not check the vision browser an earlier start recorded/).map(([m]) => m)).toEqual([
      '[vision] Could not check the vision browser an earlier start recorded (pid 7003), so it was not ended (no answer within 5 s); its record is kept for the next try',
    ])
    sys.helperEndFails = null
    sys.present.delete(HELPER)
    sys.runs.length = 0
    await endRecordedVisionBrowser()
    expect(sys.runs).toEqual([])
    expect(sys.procs.has(7003)).toBe(true)
    expect(recordText()).toBe(recordOf(7003, '134078000000000500'))
    expect(logged(/there is no session helper to end it with/)).toHaveLength(1)
    expect(powershellRuns()).toEqual([])
  })

  it('a record that does not read, or is too large, is removed and ends nothing', async () => {
    sys.procs.set(7004, '134078000000000500')
    for (const text of [
      'not json', '', '{}', '{"pid":7004}', '{"pid":"7004","created":"134078000000000500"}', '{"pid":7004,"created":"13407800000000050a"}',
      '{"created":"134078000000000500","pid":7004}', '{"pid":7004,"created":"134078000000000500","extra":1}',
      `${recordOf(7004, '134078000000000500')}${' '.repeat(300)}`,
    ]) {
      log.info.mockClear()
      writeRecord(text)
      await endRecordedVisionBrowser()
      expect(sys.runs, JSON.stringify(text)).toEqual([])
      expect(recordText(), JSON.stringify(text)).toBeNull()
      expect(logged(/could not be read; it was removed and nothing was ended/), JSON.stringify(text)).toHaveLength(1)
    }
    expect(sys.procs.has(7004)).toBe(true)
  })

  it('a launch ends a recorded browser before its scan by profile and its start', async () => {
    sys.procs.set(7005, '134078000000000500')
    writeRecord(recordOf(7005, '134078000000000500'))
    const { pid } = await launchBrowser('chrome', 9222, undefined, true)
    expect(sys.events).toEqual(['helper-end:7005', `helper-start:${pid}`])
    expect(sys.procs.has(7005)).toBe(false)
    // The record names the new browser now.
    expect(recordText()).toBe(recordOf(pid, sys.procs.get(pid) as string))
  })

  // A dev run on the same computer shares the user data folder with the
  // installed app (docs/dev-alongside-prod.md): it must never end that app's browser.
  it('a dev or E2E run keeps the record in its own data root, and never reads or ends the browser an installed app recorded in the shared user data folder', async () => {
    sys.procs.set(7007, '134078000000000500')
    writeRecord(recordOf(7007, '134078000000000500'))
    const appsBrowser = () => {
      expect(sys.procs.get(7007), "the installed app's browser").toBe('134078000000000500')
      expect(recordText(), "the installed app's record").toBe(recordOf(7007, '134078000000000500'))
    }
    const recordIn = (root: string): string | null => {
      try { return realFs.readFileSync(path.join(root, 'vision-started.json'), 'utf8') } catch { return null }
    }

    // A dev run: not packaged, its own data root, the Cargo build as its helper.
    sys.isPackaged = false
    const devRoot = path.join(sys.userData, 'dev-data')
    realFs.mkdirSync(devRoot)
    process.env.CCC_DEV_DATA_DIR = devRoot
    sys.present = new Set([DEV_HELPER, CHROME])
    await endRecordedVisionBrowser()
    expect(sys.runs).toEqual([])
    const dev = await launchBrowser('chrome', 9222, undefined, true)
    const devCreated = sys.procs.get(dev.pid) as string
    expect(sys.events).toEqual([`helper-start:${dev.pid}`])
    expect(recordIn(devRoot)).toBe(recordOf(dev.pid, devCreated))
    appsBrowser()
    // Its next start ends its own recorded browser, and nothing of the installed app's.
    await endRecordedVisionBrowser()
    expect(sys.runs).toEqual([{ file: DEV_HELPER, args: helperEnd(dev.pid, devCreated), sync: false, timeoutMs: HELPER_END_TIMEOUT_MS, answer: 'ended\r\n' }])
    expect(recordIn(devRoot)).toBeNull()
    appsBrowser()

    // An E2E run: its own data root, packaged or not.
    sys.isPackaged = true
    delete process.env.CCC_DEV_DATA_DIR
    const e2eRoot = path.join(sys.userData, 'e2e-data')
    realFs.mkdirSync(e2eRoot)
    process.env.CCC_E2E_DATA_DIR = e2eRoot
    sys.present = new Set([HELPER, CHROME])
    sys.runs.length = 0
    await endRecordedVisionBrowser()
    expect(sys.runs).toEqual([])
    const e2e = await launchBrowser('chrome', 9222, undefined, true)
    expect(recordIn(e2eRoot)).toBe(recordOf(e2e.pid, sys.procs.get(e2e.pid) as string))
    appsBrowser()

    // A root that is not absolute gives no record at all, never one in the working folder.
    process.env.CCC_E2E_DATA_DIR = 'aicc-relative-root'
    killSpawnedBrowser()
    const third = await launchBrowser('chrome', 9222, undefined, true)
    expect(sys.procs.has(third.pid)).toBe(true)
    expect(realFs.existsSync(path.resolve('aicc-relative-root'))).toBe(false)
    appsBrowser()
  })

  it('off Windows nothing is recorded, and a record is left as it is', async () => {
    setPlatform('linux')
    sys.present = new Set([HELPER, POSIX_CHROME.linux])
    writeRecord(recordOf(7006, '134078000000000500'))
    await launchBrowser('chrome', 9222, undefined, true)
    await endRecordedVisionBrowser()
    expect(sys.runs).toEqual([])
    expect(recordText()).toBe(recordOf(7006, '134078000000000500'))
  })
})

describe('Windows: one look, 2 s after a start through the helper', () => {
  it('a browser that has already exited is logged, as a spawned one is, and no longer tracked', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { pid } = await launchBrowser('chrome', 9222, undefined, true)
    // It handed off to another browser holding its profile, and exited.
    sys.procs.delete(pid)
    vi.advanceTimersByTime(1999)
    expect(logged(/exited within/)).toEqual([])
    vi.advanceTimersByTime(1)
    expect(logged(new RegExp(`The vision browser \\(pid ${pid}\\) exited within 2 s of its start`))).toHaveLength(1)
    // Another process takes the pid. A browser still tracked would now cost the
    // quit a check of it; one no longer tracked costs nothing.
    sys.procs.set(pid, '134078999999999990')
    killSpawnedBrowser()
    expect(sys.runs).toEqual([])
  })

  it('a browser that still runs: nothing is logged, and it stays tracked', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { pid } = await launchBrowser('chrome', 9222, undefined, true)
    const created = sys.procs.get(pid) as string
    vi.advanceTimersByTime(2000)
    expect(logged(/exited within/)).toEqual([])
    killSpawnedBrowser()
    expect(sys.runs).toHaveLength(1)
    expect(sys.runs[0]).toMatchObject({ file: HELPER, args: helperEnd(pid, created), answer: 'ended\r\n' })
  })
})

describe('Windows: a start that started nothing is the plain spawn, as before', () => {
  function expectPlainSpawn(executable: string, headless = true): void {
    expect(sys.spawns).toHaveLength(1)
    expect(sys.spawns[0].executable).toBe(executable)
    expect(sys.spawns[0].args).toEqual(argsFor(headless))
    expect(sys.spawns[0].opts).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: headless })
  }

  it('no helper in this install: spawned, with one line in the log', async () => {
    sys.present.delete(HELPER)
    await launchBrowser('chrome', 9222, undefined, true)
    expect(sys.execFiles).toEqual([])
    expectPlainSpawn(CHROME)
    expect(logged(/session helper is not in this install/)).toHaveLength(1)
    // It is the app's own child again, ended as before: taskkill by its pid.
    killSpawnedBrowser()
    expect(sys.runs.map((r) => r.file)).toEqual([TASKKILL])
  })

  it('the helper refused or could not start it (exit 1): spawned, with the helper\'s reason in the log', async () => {
    sys.answer = { kind: 'exit', code: 1, stderr: 'aicc-helper: could not start C:\\x: CreateProcessW: Access is denied.' }
    await launchBrowser('chrome', 9222, undefined, true)
    expect(sys.execFiles).toHaveLength(1)
    expectPlainSpawn(CHROME)
    expect(logged(/could not start the vision browser \(aicc-helper: could not start .*Access is denied\.\)/)).toHaveLength(1)
  })

  it('the helper could not read its command line (exit 2): spawned', async () => {
    sys.answer = { kind: 'exit', code: 2, stderr: 'aicc-helper: unknown option --x' }
    await launchBrowser('chrome', 9222, undefined, true)
    expectPlainSpawn(CHROME)
    expect(logged(/could not start the vision browser \(aicc-helper: unknown option --x\)/)).toHaveLength(1)
  })

  it('the helper itself could not be run: spawned', async () => {
    sys.answer = { kind: 'spawnError' }
    await launchBrowser('chrome', 9222, undefined, true)
    expectPlainSpawn(CHROME)
    expect(logged(/could not start the vision browser \(spawn .*ENOENT\)/)).toHaveLength(1)
  })

  for (const [what, code, hex] of [
    ['a DLL it needs is missing, such as the Visual C++ runtime', 3221225781, '0xC0000135'],
    ['a DLL lacks a function it needs', 3221225785, '0xC0000139'],
    ['it is not a program this Windows can run', 3221225595, '0xC000007B'],
    ['a DLL it needs failed to start', 3221225794, '0xC0000142'],
  ] as Array<[string, number, string]>) {
    it(`Windows could not load the helper (${what}: ${hex}, which Node reports as ${code}): spawned, with one line in the log that names the status`, async () => {
      sys.answer = { kind: 'exit', code, stderr: '' }
      await launchBrowser('chrome', 9222, undefined, true)
      expect(sys.execFiles).toHaveLength(1)
      expectPlainSpawn(CHROME)
      // The helper never ran, so Node's "Command failed: <helper> start ..."
      // says nothing about why; the status does.
      expect(logged(/session helper/).map(([m]) => m)).toEqual([
        `[vision] Windows could not load the session helper (status ${hex}); the vision browser is started directly`,
      ])
      expect(logged(/could not start the vision browser \(Command failed/)).toEqual([])
      expect(logged(/did not say whether/)).toEqual([])
    })
  }

  it('a browser named by a bare name (found on PATH): spawned, and the helper is never asked', async () => {
    sys.present = new Set([HELPER])
    await launchBrowser('chrome', 9222, undefined, true)
    expect(sys.execFiles).toEqual([])
    expectPlainSpawn('chrome')
    expect(logged(/named without a full path \(chrome\)/)).toHaveLength(1)
  })
})

describe('Windows: a start that may have started the browser without saying so is not followed by a second one', () => {
  for (const [what, helperAnswer, reason] of [
    ['the helper timed out', { kind: 'timeout' }, /no answer within 10 s/],
    ['it exited 0 with an answer that is not one', { kind: 'print', stdout: 'started\n' }, /its answer could not be read/],
    ['it exited 3', { kind: 'exit', code: 3, stderr: 'aicc-helper: something else' }, /aicc-helper: something else/],
    ['it crashed once it ran (0xC0000005, which Node reports as 3221225477)', { kind: 'exit', code: 3221225477, stderr: '' }, /Command failed/],
  ] as Array<[string, HelperAnswer, RegExp]>) {
    it(`${what}: no spawn, one line in the log, and the launch fails`, async () => {
      sys.answer = helperAnswer
      await expect(launchBrowser('chrome', 9222, undefined, true)).rejects.toThrow(/did not say whether it started the vision browser/)
      expect(sys.execFiles).toHaveLength(1)
      expect(sys.spawns).toEqual([])
      const lines = logged(/did not say whether it started the vision browser/)
      expect(lines).toHaveLength(1)
      expect(String(lines[0][0])).toMatch(reason)
      expect(logged(/started directly/)).toEqual([])
      // Nothing is tracked, so nothing is ended by a pid it does not know.
      killSpawnedBrowser()
      expect(sys.runs).toEqual([])
    })
  }
})

describe.each(['darwin', 'linux'] as const)('%s: the plain spawn, unchanged', (platform) => {
  it('spawns the browser, never asks the helper, and logs no helper decision', async () => {
    setPlatform(platform)
    sys.present = new Set([HELPER, POSIX_CHROME[platform]])
    await launchBrowser('chrome', 9222, undefined, true)
    expect(sys.execFiles).toEqual([])
    expect(sys.spawns.map((s) => s.executable)).toEqual([POSIX_CHROME[platform]])
    expect(logged(HELPER_LINES)).toEqual([])
  })
})

describe('the start mode\'s answer is read strictly', () => {
  it('takes exactly a pid and a creation time of digits', () => {
    expect(parseHelperStart('{"pid":4242,"created":"134078123456789010"}\r\n')).toEqual({ pid: 4242, created: '134078123456789010' })
    for (const bad of [
      '', 'started', '{}', '[]', 'null',
      '{"pid":4242}', '{"created":"1"}',
      '{"created":"1","pid":4242}',
      '{"pid":4242,"created":"1","extra":1}',
      '{"pid":"4242","created":"1"}', '{"pid":0,"created":"1"}', '{"pid":-1,"created":"1"}', '{"pid":1.5,"created":"1"}',
      '{"pid":4294967296,"created":"1"}',
      '{"pid":4242,"created":1}', '{"pid":4242,"created":""}', '{"pid":4242,"created":"12a"}', '{"pid":4242,"created":"123456789012345678901"}',
      '{"pid":4242,"created":"1"}\n{"pid":4243,"created":"1"}',
    ]) {
      expect(parseHelperStart(bad), bad).toBeNull()
    }
  })
})
