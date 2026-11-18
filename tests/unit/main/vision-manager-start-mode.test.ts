/**
 * On Windows the vision browser is started through the session helper's start
 * mode (`aicc-helper start`, plan 2.1.3-beta.8 section C2), so it keeps none
 * of the app's handles. It is then not the app's child: it is tracked by the
 * pid and creation time the helper printed, and ended only while that pid
 * still has that creation time, never by its pid alone: through the helper's
 * end mode (`aicc-helper end`, a few milliseconds, no PowerShell), or the
 * PowerShell end when the helper is gone. Without the helper, when the start
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
  /** The helper's end mode fails with this message (a timeout, an exit 1). */
  helperEndFails: null as string | null,
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
        if (a.kind === 'exit') return cb(Object.assign(new Error('Command failed'), { code: a.code, killed: false, signal: null }), '', a.stderr)
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
vi.mock('fs', () => ({ existsSync: (p: string) => sys.present.has(p) }))
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
  app: { isPackaged: true, getAppPath: () => 'C:\\AICC\\resources\\app.asar' },
  BrowserWindow: class {},
  nativeImage: {},
}))
vi.mock('../../../src/main/conductor-mcp-server', () => ({ getConductorMcpPort: () => 19333 }))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '/res' }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: log.info, logError: log.error, logWarn: vi.fn() }))

const {
  launchBrowser, killSpawnedBrowser, stopGlobalVision, buildBrowserLaunchArgs, parseHelperStart, _setVisionOwnerPortsForTest,
} = await import('../../../src/main/vision-manager')
const { windowsEndScript, OWNER_SYNC_KILL_TIMEOUT_MS, HELPER_END_TIMEOUT_MS } = await import('../../../src/main/vision-browser-owner')

const RESOURCES = 'C:\\AICC\\resources'
// As session-helper/install.ts bundledHelperPath joins it for a packaged app.
const HELPER = path.join(RESOURCES, 'helper', 'aicc-helper.exe')
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
  if (file === HELPER) {
    expect(args[0], 'only the end mode is run synchronously or awaited').toBe('end')
    const pid = Number(args[args.indexOf('--pid') + 1])
    const want = args[args.indexOf('--created') + 1]
    sys.events.push(`helper-end:${pid}`)
    if (sys.helperEndFails) throw new Error(sys.helperEndFails)
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

beforeAll(() => { (process as unknown as { resourcesPath: string }).resourcesPath = RESOURCES })
afterAll(() => { delete (process as unknown as { resourcesPath?: string }).resourcesPath })

beforeEach(() => {
  setPlatform('win32')
  _setVisionOwnerPortsForTest(fakePorts)
  sys.helperEndFails = null
  sys.failAsync = false
  killSpawnedBrowser() // drop anything tracked by an earlier test
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
})

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

  it('a quit end that fails or times out is logged, as distinct from a browser that was left, and nothing is ended by its pid alone', async () => {
    for (const why of ['timed out', 'exited with status 1']) {
      log.info.mockClear()
      sys.helperEndFails = null
      const { pid } = await launchBrowser('chrome', 9222, undefined, true)
      sys.helperEndFails = why
      killSpawnedBrowser()
      expect(sys.procs.has(pid), why).toBe(true)
      expect(logged(new RegExp(`Could not check the app-started browser \\(pid ${pid}\\) at exit, so it was not ended`)), why).toHaveLength(1)
      expect(logged(/Ended the app-started browser/), why).toEqual([])
      expect(pidOnlyKills(), why).toEqual([])
    }
  })

  it('with the helper gone by the quit, the PowerShell end checks the same pid and start time, bounded', async () => {
    const { pid } = await launchBrowser('chrome', 9222, undefined, true)
    const created = sys.procs.get(pid) as string
    sys.present.delete(HELPER)
    killSpawnedBrowser()
    expect(sys.runs).toHaveLength(1)
    expect(sys.runs[0].file).toMatch(POWERSHELL)
    expect(sys.runs[0]).toMatchObject({ sync: true, timeoutMs: OWNER_SYNC_KILL_TIMEOUT_MS, answer: 'ended\r\n' })
    expect(sys.runs[0].args[sys.runs[0].args.length - 1]).toBe(windowsEndScript(pid, created))
    expect(pidOnlyKills()).toEqual([])
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

  it('Windows could not load the helper (a DLL it needs is missing: 0xC0000135, which Node reports as 3221225781): spawned, with one line in the log', async () => {
    sys.answer = { kind: 'exit', code: 3221225781, stderr: '' }
    await launchBrowser('chrome', 9222, undefined, true)
    expect(sys.execFiles).toHaveLength(1)
    expectPlainSpawn(CHROME)
    expect(logged(/could not start the vision browser \(Command failed\)/)).toHaveLength(1)
    expect(logged(/did not say whether/)).toEqual([])
  })

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
