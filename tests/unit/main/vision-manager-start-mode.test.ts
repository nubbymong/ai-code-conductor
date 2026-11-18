/**
 * On Windows the vision browser is started through the session helper's start
 * mode (`aicc-helper start`, plan 2.1.3-beta.8 section C2), so it keeps none
 * of the app's handles. It is then not the app's child: it is tracked by the
 * pid and creation time the helper printed, and ended only while that pid
 * still has that creation time, never by its pid alone. Without the helper,
 * when the start fails, for a browser named by a bare name, and on macOS and
 * Linux, the launch is the plain spawn it always was.
 *
 * child_process, fs, net and Electron are replaced and the OS is a fake
 * process table behind the injected OwnerPorts: nothing here starts a program.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import * as path from 'path'
import * as nodeOs from 'os'
import type { OwnerPorts } from '../../../src/main/vision-browser-owner'

type HelperAnswer =
  | { kind: 'ok' }
  | { kind: 'fail'; stderr: string }
  | { kind: 'print'; stdout: string }

const sys = vi.hoisted(() => ({
  platform: 'win32' as NodeJS.Platform,
  /** Files that exist. */
  present: new Set<string>(),
  /** Running processes: pid -> creation time. */
  procs: new Map<number, string>(),
  nextPid: 5000,
  nextCreated: 134078000000000000,
  answer: { kind: 'ok' } as HelperAnswer,
  /** Every awaited OS call fails, as a PowerShell that timed out does. */
  failAsync: false,
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
        if (a.kind === 'fail') return cb(Object.assign(new Error('Command failed'), { code: 1 }), '', a.stderr)
        if (a.kind === 'print') return cb(null, a.stdout, '')
        const pid = sys.nextPid++
        const created = String(sys.nextCreated += 10)
        sys.procs.set(pid, created)
        sys.events.push(`helper-start:${pid}`)
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
// Nothing listens on the debug port, so a launch has nothing to free first.
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
const { windowsEndScript, OWNER_SYNC_KILL_TIMEOUT_MS, OWNER_QUERY_TIMEOUT_MS } = await import('../../../src/main/vision-browser-owner')

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

/** The fake OS: the verified end script ends the pid only while its creation
 *  time is the one the script names, as the real one does. */
function answer(file: string, args: string[]): string {
  if (file === TASKKILL) {
    const pid = Number(args[args.indexOf('/PID') + 1])
    sys.events.push(`taskkill:${pid}`)
    if (!sys.procs.delete(pid)) throw new Error('exited with status 128')
    return 'SUCCESS\r\n'
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

const fakePorts: OwnerPorts = {
  get platform() { return sys.platform },
  systemRoot: 'C:\\Windows',
  // A real PowerShell takes a while to answer; so does this one.
  run: async (file, args, timeoutMs) => {
    const r: { file: string; args: string[]; sync: boolean; timeoutMs: number; answer?: string } = { file, args, sync: false, timeoutMs }
    sys.runs.push(r)
    await new Promise((res) => setTimeout(res, 5))
    if (sys.failAsync) throw new Error('timed out')
    r.answer = answer(file, args)
    return r.answer
  },
  runSync: (file, args, timeoutMs) => {
    const r: { file: string; args: string[]; sync: boolean; timeoutMs: number; answer?: string } = { file, args, sync: true, timeoutMs }
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

beforeAll(() => { (process as unknown as { resourcesPath: string }).resourcesPath = RESOURCES })
afterAll(() => { delete (process as unknown as { resourcesPath?: string }).resourcesPath })

beforeEach(() => {
  setPlatform('win32')
  _setVisionOwnerPortsForTest(fakePorts)
  killSpawnedBrowser() // drop anything tracked by an earlier test
  sys.present = new Set([HELPER, CHROME])
  sys.procs.clear()
  sys.answer = { kind: 'ok' }
  sys.failAsync = false
  sys.execFiles.length = 0
  sys.spawns.length = 0
  sys.runs.length = 0
  sys.signals.length = 0
  sys.events.length = 0
  log.info.mockClear()
})

afterEach(() => {
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

  it('it is tracked by the printed pid and start time: the quit ends it by both, synchronously, never by its pid alone', async () => {
    const { pid } = await launchBrowser('chrome', 9222, undefined, true)
    const created = sys.procs.get(pid) as string
    expect(sys.runs).toEqual([])
    killSpawnedBrowser()
    expect(sys.runs).toHaveLength(1)
    expect(sys.runs[0]).toMatchObject({ sync: true, timeoutMs: OWNER_SYNC_KILL_TIMEOUT_MS, answer: 'ended\r\n' })
    expect(sys.runs[0].file).toMatch(POWERSHELL)
    expect(sys.runs[0].args[sys.runs[0].args.length - 1]).toBe(windowsEndScript(pid, created))
    expect(sys.procs.has(pid)).toBe(false)
    expect(pidOnlyKills()).toEqual([])
    // Safe to call again: nothing is tracked now.
    killSpawnedBrowser()
    expect(sys.runs).toHaveLength(1)
  })

  it('once its pid has another start time, the quit leaves that process alone', async () => {
    const { pid } = await launchBrowser('chrome', 9222, undefined, true)
    // The browser ended and another process took its pid.
    sys.procs.set(pid, '134078999999999990')
    killSpawnedBrowser()
    expect(sys.runs.map((r) => r.answer)).toEqual(['left\r\n'])
    expect(sys.procs.get(pid)).toBe('134078999999999990')
    expect(pidOnlyKills()).toEqual([])
  })

  it('a relaunch ends the one before through the awaited verified end, before the next start', async () => {
    const first = await launchBrowser('chrome', 9222, undefined, true)
    const created = sys.procs.get(first.pid) as string
    const second = await launchBrowser('chrome', 9222, undefined, true)
    expect(sys.runs).toHaveLength(1)
    expect(sys.runs[0]).toMatchObject({ sync: false, timeoutMs: OWNER_QUERY_TIMEOUT_MS, answer: 'ended\r\n' })
    expect(sys.runs[0].args[sys.runs[0].args.length - 1]).toBe(windowsEndScript(first.pid, created))
    expect(sys.events).toEqual([`helper-start:${first.pid}`, `verified-end:${first.pid}`, `helper-start:${second.pid}`])
    expect(pidOnlyKills()).toEqual([])
    // The second is the one tracked now.
    killSpawnedBrowser()
    expect(sys.events[sys.events.length - 1]).toBe(`verified-end:${second.pid}`)
    expect(sys.procs.size).toBe(0)
  })

  it('a stop ends it through the awaited verified end', async () => {
    const { pid } = await launchBrowser('chrome', 9222, undefined, true)
    const created = sys.procs.get(pid) as string
    await stopGlobalVision()
    expect(sys.runs).toHaveLength(1)
    expect(sys.runs[0]).toMatchObject({ sync: false, answer: 'ended\r\n' })
    expect(sys.runs[0].args[sys.runs[0].args.length - 1]).toBe(windowsEndScript(pid, created))
    expect(sys.procs.has(pid)).toBe(false)
    expect(pidOnlyKills()).toEqual([])
    killSpawnedBrowser()
    expect(sys.runs).toHaveLength(1)
  })

  it('a stop whose check does not answer keeps it tracked, so the quit still ends it by pid and start time', async () => {
    const { pid } = await launchBrowser('chrome', 9222, undefined, true)
    const created = sys.procs.get(pid) as string
    sys.failAsync = true
    await stopGlobalVision()
    expect(sys.procs.has(pid), 'the failed check ended it').toBe(true)
    killSpawnedBrowser()
    const sync = sys.runs.filter((r) => r.sync)
    expect(sync).toHaveLength(1)
    expect(sync[0].args[sync[0].args.length - 1]).toBe(windowsEndScript(pid, created))
    expect(sync[0].answer).toBe('ended\r\n')
    expect(sys.procs.has(pid)).toBe(false)
    expect(pidOnlyKills()).toEqual([])
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

describe('Windows: every other case is the plain spawn, as before', () => {
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

  it('a start that fails: spawned, with the helper\'s reason in the log', async () => {
    sys.answer = { kind: 'fail', stderr: 'aicc-helper: could not start C:\\x: CreateProcessW: Access is denied.' }
    await launchBrowser('chrome', 9222, undefined, true)
    expect(sys.execFiles).toHaveLength(1)
    expectPlainSpawn(CHROME)
    expect(logged(/could not start the vision browser \(aicc-helper: could not start .*Access is denied\.\)/)).toHaveLength(1)
  })

  it('an answer that is not one: spawned', async () => {
    sys.answer = { kind: 'print', stdout: 'started\n' }
    await launchBrowser('chrome', 9222, undefined, true)
    expectPlainSpawn(CHROME)
    expect(logged(/could not start the vision browser \(its answer could not be read\)/)).toHaveLength(1)
  })

  it('a browser named by a bare name (found on PATH): spawned, and the helper is never asked', async () => {
    sys.present = new Set([HELPER])
    await launchBrowser('chrome', 9222, undefined, true)
    expect(sys.execFiles).toEqual([])
    expectPlainSpawn('chrome')
    expect(logged(/named without a full path \(chrome\)/)).toHaveLength(1)
  })
})

describe.each(['darwin', 'linux'] as const)('%s: the plain spawn, unchanged', (platform) => {
  it('spawns the browser and never asks the helper', async () => {
    setPlatform(platform)
    sys.present = new Set([HELPER, POSIX_CHROME[platform]])
    await launchBrowser('chrome', 9222, undefined, true)
    expect(sys.execFiles).toEqual([])
    expect(sys.spawns.map((s) => s.executable)).toEqual([POSIX_CHROME[platform]])
    expect(logged(/session helper/)).toEqual([])
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
