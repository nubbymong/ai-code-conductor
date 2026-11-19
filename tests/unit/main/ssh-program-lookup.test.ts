// Every SSH start finds ssh.exe the way the app finds its other programs on
// Windows: the full path of the first ssh.exe in the folders PATH names in
// full (findOnWindowsPath), never a bare name, and nothing starts when there
// is none. The three places an SSH start happens are driven for real here: a
// session (spawnPty), its End exec (endSshRemote, both the key exec and the
// password PTY), and the liveness probe (probeTmuxLive, both shapes).
//
// findOnWindowsPath is the real one, watched, with a fake file system: the
// file test answers "a file" for the candidates a case puts there (or for
// every candidate). So what a case proves is the rule itself, at each site:
// a folder PATH names only relatively, or with an unexpanded %VAR%, is never
// read, whatever is in it. Off Windows the start stays `ssh` by name.
//
// 2.1.3-beta.9 (planning #310, item 5): the walk is also made off the main
// thread (ssh-program.ts lookForSshProgram, through the shared
// findOnWindowsPathAsync): at start, every SSH_PROGRAM_RECHECK_MS after it,
// after a PATH refresh, and when a start finds no answer kept. Its answer is
// kept for the PATH and the PATH refresh count it was made under. A start
// reads a kept answer younger than SSH_PROGRAM_KEEP_MS and walks nothing in
// place; with none kept, or one too old, it walks in place exactly as
// before, and never waits for the look. The look is the real
// findOnWindowsPathAsync, watched, over the same fake file system, and can
// be held (a folder on a share that does not answer). The recheck's timer is
// faked where a case drives it.
//
// node-pty, child_process, Electron and the registry read are mocked:
// nothing is started and no host is dialled. Reads no file of the host's.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  platform: 'win32' as NodeJS.Platform,
  /** Candidates the fake file system holds; `every` makes every candidate a file. */
  files: new Set<string>(),
  every: false,
  ptySpawns: [] as Array<{ file: string; args: string[] }>,
  execFiles: [] as Array<{ file: string; args: string[] }>,
  logs: [] as string[],
  /** Each file test of the look off the main thread waits for this, when set. */
  lookGate: null as Promise<void> | null,
  openLook: (): void => {},
  /** The user PATH the registry holds for a PATH refresh, or null for none. */
  registryUser: null as string | null,
}))

vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  platform: () => h.platform,
}))

vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[]) => {
    h.ptySpawns.push({ file, args })
    // Stop here: only what reached the start is read. Every SSH start
    // catches a throw from its spawn (a session rethrows it; End and the
    // probe settle on it).
    throw new Error('__spawn_captured__')
  },
}))

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: (file: string, args: string[], _opts: unknown, cb?: (err: Error | null, stdout: string, stderr: string) => void) => {
    h.execFiles.push({ file, args })
    queueMicrotask(() => cb?.(new Error('exit 255'), '', ''))
    return { unref: () => {} }
  },
}))

vi.mock('electron', () => ({
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  app: { getPath: () => '/tmp' },
}))
vi.mock('../../../src/main/watchdog/watchdog-manager', () => ({
  getWatchdogManager: () => ({ stopWatchdog: vi.fn(), noteRedrawTrigger: vi.fn() }),
}))
// The SSH session keeps the system ConPTY on every runner (ssh-spawn-callsite.test.ts).
vi.mock('../../../src/main/bundled-conpty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/bundled-conpty')>()),
  bundledConptyChoice: () => ({ kind: 'bundled', options: { useConpty: true, useConptyDll: true }, dir: '/np/prebuilds/win32-x64' }),
}))
vi.mock('../../../src/main/debug-logger', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/debug-logger')>()
  const capture = (...args: unknown[]) => { h.logs.push(args.map(String).join(' ')) }
  return { ...real, logDebug: capture, logTrace: capture, logInfo: capture, logWarn: capture, logError: capture }
})

const findOnWindowsPath = vi.hoisted(() => vi.fn())
const findOnWindowsPathAsync = vi.hoisted(() => vi.fn())
vi.mock('../../../src/main/windows-programs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/windows-programs')>()
  findOnWindowsPath.mockImplementation((names: readonly string[], env: NodeJS.ProcessEnv, _stat?: unknown, order?: 'folder' | 'name') =>
    real.findOnWindowsPath(names, env, (p) => h.every || h.files.has(p), order))
  // The look off the main thread: the real walk over the same fake file
  // system, each file test held while `lookGate` is.
  findOnWindowsPathAsync.mockImplementation((names: readonly string[], env: NodeJS.ProcessEnv, _stat?: unknown, order?: 'folder' | 'name') =>
    real.findOnWindowsPathAsync(names, env, async (p) => {
      if (h.lookGate) await h.lookGate
      return h.every || h.files.has(p)
    }, order))
  return { ...real, findOnWindowsPath, findOnWindowsPathAsync }
})
vi.mock('../../../src/main/windows-registry-path', async (importOriginal) => {
  type Values = import('../../../src/main/windows-registry-path').RegistryPaths
  return {
    ...(await importOriginal<typeof import('../../../src/main/windows-registry-path')>()),
    readRegistryPaths: async (): Promise<Values> => ({ machine: null, user: h.registryUser ? { kind: 'String', data: h.registryUser } : null }),
  }
})

const { spawnPty, endSshRemote, probeTmuxLive } = await import('../../../src/main/pty-manager')
const {
  sshProgram, SSH_NOT_ON_PATH, SSH_PROGRAM_RECHECK_MS, SSH_PROGRAM_KEEP_MS, lookForSshProgram, _keptSshProgramForTest,
  startSshProgramLookup, lookForSshProgramAfterPathRefresh, _resetSshProgramForTest,
} = await import('../../../src/main/ssh-program')
const { noteWindowsPathRefresh } = await import('../../../src/main/windows-programs')
const { refreshWindowsPath } = await import('../../../src/main/windows-path-refresh')
const { registerProvider } = await import('../../../src/main/providers')
const { ClaudeProvider } = await import('../../../src/main/providers/claude')
registerProvider(new ClaudeProvider())

const fakeWin = { webContents: { send() {} }, isDestroyed: () => false } as never
const SSH = { username: 'me', host: 'box.example.com', port: 2222, remotePath: '~/proj' }
const KEY = { username: 'me', host: 'box.example.com', port: 2222 }
const PASSWORD = { ...KEY, password: 'pw' }

const TRUSTED = 'C:\\Tools\\OpenSSH'
const TRUSTED_SSH = 'C:\\Tools\\OpenSSH\\ssh.exe'
/** Folders PATH can name that are not fully qualified: the working folder,
 *  folders relative to it, a drive-relative and a root-relative folder, and
 *  an entry whose %VAR% was never expanded. */
const UNTRUSTED = ['.', '.\\tools', 'tools\\bin', 'C:tools', '\\tools', '%LOCALAPPDATA%\\OpenSSH']

const savedPath = process.env.PATH
const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!
function setPath(...dirs: string[]): void { process.env.PATH = dirs.join(';') }
/** Hold every file test of the look off the main thread until openLook(). */
function holdTheLook(): void {
  let open = (): void => {}
  h.lookGate = new Promise<void>((resolve) => { open = resolve })
  h.openLook = open
}

/** Every SSH start, each as a function that runs it and returns how it ended. */
const sites: Array<[string, () => Promise<unknown>]> = [
  ['a session', async () => { try { spawnPty(fakeWin, 'ssh-lookup-session', { ssh: SSH } as never); return 'started' } catch (e) { return (e as Error).message } }],
  ['End, key exec', () => endSshRemote('ssh-lookup-end-key', KEY)],
  ['End, password PTY', () => endSshRemote('ssh-lookup-end-pw', PASSWORD)],
  ['liveness probe, key exec', () => probeTmuxLive(KEY, ['a'])],
  ['liveness probe, password PTY', () => probeTmuxLive(PASSWORD, ['a'])],
]
/** The program each start was handed, in order. */
const started = (): string[] => [...h.ptySpawns, ...h.execFiles].map((s) => s.file)

beforeEach(() => {
  h.platform = 'win32'
  h.files = new Set()
  h.every = false
  h.ptySpawns.length = 0
  h.execFiles.length = 0
  h.logs.length = 0
  h.lookGate = null
  h.registryUser = null
  _resetSshProgramForTest()
  findOnWindowsPath.mockClear()
  findOnWindowsPathAsync.mockClear()
})
afterEach(() => {
  // A look a case left held ends, so the next case starts its own.
  h.openLook()
  // The recheck's timer goes before the timers are real again.
  _resetSshProgramForTest()
  vi.useRealTimers()
  Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM)
  if (savedPath === undefined) delete process.env.PATH
  else process.env.PATH = savedPath
})

describe('on Windows every SSH start runs ssh.exe by the full path found in the folders PATH names', () => {
  it.each(sites)('%s: starts the ssh.exe found in a fully qualified PATH folder, by its full path', async (_name, run) => {
    setPath(...UNTRUSTED, TRUSTED)
    h.every = true
    await run()
    expect(started()).toEqual([TRUSTED_SSH])
    // Through the shared lookup, asked for ssh.exe in the app's own PATH.
    expect(findOnWindowsPath).toHaveBeenCalledTimes(1)
    expect(findOnWindowsPath.mock.calls[0][0]).toEqual(['ssh.exe'])
    expect(findOnWindowsPath.mock.calls[0][1]).toBe(process.env)
  })

  it.each(sites)('%s: never reads a folder PATH names relatively or with an unexpanded variable, and starts nothing', async (_name, run) => {
    setPath(...UNTRUSTED)
    // Whatever those folders hold, an ssh.exe in each of them included.
    h.every = true
    await run()
    expect(started()).toEqual([])
    expect(findOnWindowsPath).toHaveBeenCalledTimes(1)
  })

  it.each(sites)('%s: with no ssh.exe in any PATH folder (one only in the working folder), starts nothing', async (_name, run) => {
    setPath(TRUSTED, 'D:\\Other')
    await run()
    expect(started()).toEqual([])
  })

  it('PATH order decides between two fully qualified folders that both hold ssh.exe', async () => {
    setPath('D:\\Git\\usr\\bin', TRUSTED)
    h.files = new Set(['D:\\Git\\usr\\bin\\ssh.exe', TRUSTED_SSH])
    await probeTmuxLive(KEY, ['a'])
    expect(started()).toEqual(['D:\\Git\\usr\\bin\\ssh.exe'])
  })
})

describe('what a start with no ssh.exe to run says', () => {
  beforeEach(() => { setPath(...UNTRUSTED); h.every = true })

  it('a session fails with the not-found message, before anything starts', async () => {
    expect(() => spawnPty(fakeWin, 'ssh-lookup-msg', { ssh: SSH } as never)).toThrow(SSH_NOT_ON_PATH)
    expect(SSH_NOT_ON_PATH).toMatch(/^ssh was not found in a folder PATH names \(ssh\.exe\)\./)
    expect(started()).toEqual([])
  })

  it('End resolves failed (never rejects) and logs why', async () => {
    await expect(endSshRemote('ssh-lookup-end-msg', KEY)).resolves.toBe('failed')
    await expect(endSshRemote('ssh-lookup-end-msg-pw', PASSWORD)).resolves.toBe('failed')
    expect(h.logs.filter((l) => l.includes(SSH_NOT_ON_PATH))).toHaveLength(2)
  })

  it('the liveness probe resolves unverified (never rejects, never "all dead") and logs why', async () => {
    await expect(probeTmuxLive(KEY, ['a'])).resolves.toEqual({ outcome: 'unverified', liveSessionIds: [] })
    await expect(probeTmuxLive(PASSWORD, ['a'])).resolves.toEqual({ outcome: 'unverified', liveSessionIds: [] })
    expect(h.logs.filter((l) => l.includes(SSH_NOT_ON_PATH))).toHaveLength(2)
  })
})

describe('off Windows nothing changes', () => {
  it.each(['linux', 'darwin'] as const)('%s: every SSH start runs ssh by name, and no Windows lookup is made', async (platform) => {
    h.platform = platform
    for (const [, run] of sites) await run()
    expect(started()).toEqual(['ssh', 'ssh', 'ssh', 'ssh', 'ssh'])
    expect(findOnWindowsPath).not.toHaveBeenCalled()
  })
})

describe('sshProgram', () => {
  it('answers the full path on Windows, `ssh` elsewhere, and throws the not-found message on Windows with none', () => {
    h.files = new Set([TRUSTED_SSH])
    expect(sshProgram('win32', { PATH: `.;${TRUSTED}` })).toBe(TRUSTED_SSH)
    expect(sshProgram('linux', { PATH: '/usr/bin' })).toBe('ssh')
    expect(sshProgram('darwin', {})).toBe('ssh')
    expect(() => sshProgram('win32', { PATH: '.;tools' })).toThrow(SSH_NOT_ON_PATH)
    expect(() => sshProgram('win32', {})).toThrow(SSH_NOT_ON_PATH)
  })
})

describe('the answer kept from the look made off the main thread (planning #310, item 5)', () => {
  // Mutation to prove this can fail: sshProgram walks in place whatever is
  // kept (the code before beta.9), or the look passes a file test of its own.
  it.each(sites)('%s: with an answer kept, starts that ssh.exe and walks nothing in place', async (_name, run) => {
    setPath(...UNTRUSTED, TRUSTED)
    h.every = true
    await lookForSshProgram()
    // One look, for ssh.exe in the app's own PATH, through the shared folder
    // test (no file test of its own).
    expect(findOnWindowsPathAsync).toHaveBeenCalledTimes(1)
    expect(findOnWindowsPathAsync.mock.calls[0][0]).toEqual(['ssh.exe'])
    expect(findOnWindowsPathAsync.mock.calls[0][1]).toBe(process.env)
    expect(findOnWindowsPathAsync.mock.calls[0][2]).toBeUndefined()
    await run()
    expect(started()).toEqual([TRUSTED_SSH])
    expect(findOnWindowsPath).not.toHaveBeenCalled()
  })

  it('the same ssh.exe in every case for one PATH: walked in place, kept, dropped by a refresh, kept again', async () => {
    const GIT = 'D:\\Git\\usr\\bin'
    setPath(...UNTRUSTED, GIT, TRUSTED)
    h.files = new Set([`${GIT}\\ssh.exe`, TRUSTED_SSH])
    const inPlace = sshProgram()
    expect(findOnWindowsPath).toHaveBeenCalledTimes(1)
    await lookForSshProgram()
    const kept = sshProgram()
    expect(findOnWindowsPath, 'the kept answer walks nothing in place').toHaveBeenCalledTimes(1)
    noteWindowsPathRefresh()
    const afterRefresh = sshProgram()
    expect(findOnWindowsPath, 'a refresh dropped it: in place again').toHaveBeenCalledTimes(2)
    await lookForSshProgram()
    const keptAgain = sshProgram()
    expect(findOnWindowsPath).toHaveBeenCalledTimes(2)
    expect([inPlace, kept, afterRefresh, keptAgain]).toEqual([`${GIT}\\ssh.exe`, `${GIT}\\ssh.exe`, `${GIT}\\ssh.exe`, `${GIT}\\ssh.exe`])
  })

  // Mutation to prove this can fail: keep the answer for the PATH alone,
  // without the PATH refresh count.
  it('a PATH refresh drops the kept answer: the next start walks in place, as before', async () => {
    setPath(TRUSTED)
    h.files = new Set([TRUSTED_SSH])
    await lookForSshProgram()
    expect(_keptSshProgramForTest()).toBe(TRUSTED_SSH)
    noteWindowsPathRefresh()
    expect(_keptSshProgramForTest()).toBeUndefined()
    await probeTmuxLive(KEY, ['a'])
    expect(started()).toEqual([TRUSTED_SSH])
    expect(findOnWindowsPath).toHaveBeenCalledTimes(1)
  })

  // Mutation to prove this can fail: keep the answer for the refresh count
  // alone, without the PATH it was found under.
  it('a changed PATH drops it too: the start walks the PATH there is now', async () => {
    setPath(TRUSTED)
    h.files = new Set([TRUSTED_SSH, 'D:\\Other\\ssh.exe'])
    await lookForSshProgram()
    setPath('D:\\Other', TRUSTED)
    expect(_keptSshProgramForTest()).toBeUndefined()
    await probeTmuxLive(KEY, ['a'])
    expect(started()).toEqual(['D:\\Other\\ssh.exe'])
    expect(findOnWindowsPath).toHaveBeenCalledTimes(1)
  })

  // Mutation to prove this can fail: a walk in place keeps its answer.
  it('with the look still under way, every start walks in place as before and none waits for it', async () => {
    setPath(TRUSTED)
    h.files = new Set([TRUSTED_SSH])
    holdTheLook()
    const look = lookForSshProgram()
    for (const [, run] of sites) await run()
    expect(started()).toEqual([TRUSTED_SSH, TRUSTED_SSH, TRUSTED_SSH, TRUSTED_SSH, TRUSTED_SSH])
    expect(findOnWindowsPath).toHaveBeenCalledTimes(5)
    // The walk in place keeps nothing: only the look does, once it ends.
    expect(_keptSshProgramForTest()).toBeUndefined()
    h.openLook()
    await look
    expect(_keptSshProgramForTest()).toBe(TRUSTED_SSH)
  })

  // Mutation to prove this can fail: a look keeps what it found, none included.
  it('a look that finds none keeps nothing, and a start still refuses with SSH_NOT_ON_PATH', async () => {
    setPath(...UNTRUSTED)
    h.every = true
    await lookForSshProgram()
    expect(_keptSshProgramForTest()).toBeUndefined()
    expect(() => spawnPty(fakeWin, 'ssh-kept-none', { ssh: SSH } as never)).toThrow(SSH_NOT_ON_PATH)
    expect(findOnWindowsPath).toHaveBeenCalledTimes(1)
    expect(started()).toEqual([])
  })

  it('a look that finds none drops the answer kept for the same PATH', async () => {
    setPath(TRUSTED)
    h.files = new Set([TRUSTED_SSH])
    await lookForSshProgram()
    expect(_keptSshProgramForTest()).toBe(TRUSTED_SSH)
    h.files = new Set()
    await lookForSshProgram()
    expect(_keptSshProgramForTest()).toBeUndefined()
    expect(() => sshProgram()).toThrow(SSH_NOT_ON_PATH)
  })

  // Mutation to prove this can fail: a second ask begins a look of its own.
  it('one look at a time for one PATH: a second ask while it is under way joins it', async () => {
    setPath(TRUSTED)
    h.files = new Set([TRUSTED_SSH])
    holdTheLook()
    const first = lookForSshProgram()
    const second = lookForSshProgram()
    expect(second).toBe(first)
    expect(findOnWindowsPathAsync).toHaveBeenCalledTimes(1)
    h.openLook()
    await first
    expect(_keptSshProgramForTest()).toBe(TRUSTED_SSH)
  })

  // Mutation to prove this can fail: let any look that ends keep its answer,
  // so the one begun before the refresh, which ends last, replaces the newer.
  it('a look begun before a PATH refresh keeps nothing once a newer look has begun, even when it ends last', async () => {
    setPath('D:\\A', 'D:\\B', TRUSTED)
    h.files = new Set([TRUSTED_SSH, 'D:\\Other\\ssh.exe'])
    holdTheLook()
    const before = lookForSshProgram()
    setPath('D:\\Other')
    noteWindowsPathRefresh()
    const after = lookForSshProgram()
    expect(after).not.toBe(before)
    expect(findOnWindowsPathAsync).toHaveBeenCalledTimes(2)
    h.openLook()
    await Promise.all([before, after])
    expect(_keptSshProgramForTest()).toBe('D:\\Other\\ssh.exe')
  })

  // Mutation to prove this can fail: drop the new look a start makes when
  // the kept answer is old.
  it('a kept answer older than SSH_PROGRAM_RECHECK_MS is still used, and starts a new look for the starts after it', async () => {
    const FIRST = 'D:\\First'
    setPath(FIRST, TRUSTED)
    h.files = new Set([TRUSTED_SSH])
    await lookForSshProgram()
    findOnWindowsPathAsync.mockClear()
    const now = performance.now()
    expect(sshProgram('win32', process.env, now)).toBe(TRUSTED_SSH)
    expect(findOnWindowsPathAsync, 'a fresh answer starts no look').not.toHaveBeenCalled()
    // An ssh.exe put in an earlier PATH folder since the look.
    h.files.add(`${FIRST}\\ssh.exe`)
    expect(sshProgram('win32', process.env, now + SSH_PROGRAM_RECHECK_MS)).toBe(TRUSTED_SSH)
    expect(findOnWindowsPathAsync).toHaveBeenCalledTimes(1)
    await lookForSshProgram()
    expect(sshProgram()).toBe(`${FIRST}\\ssh.exe`)
    expect(findOnWindowsPath, 'never a walk in place').not.toHaveBeenCalled()
  })

  // Mutation to prove this can fail: drop the start-up call, or the call
  // after a refresh (windows-path-refresh.ts refreshWindowsPath).
  it('the look starts at start, and again after each PATH refresh, on the PATH there is then; never after a refresh before start', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const NEW = 'D:\\New'
    setPath(TRUSTED)
    h.files = new Set([`${NEW}\\ssh.exe`])
    lookForSshProgramAfterPathRefresh()
    expect(findOnWindowsPathAsync, 'no look before start').not.toHaveBeenCalled()
    startSshProgramLookup()
    expect(findOnWindowsPathAsync).toHaveBeenCalledTimes(1)
    await lookForSshProgram() // joins the look under way
    expect(findOnWindowsPathAsync).toHaveBeenCalledTimes(1)
    expect(_keptSshProgramForTest(), 'none on that PATH').toBeUndefined()
    // The refresh adds the folder that holds ssh.exe.
    h.registryUser = NEW
    await refreshWindowsPath()
    expect(findOnWindowsPathAsync).toHaveBeenCalledTimes(2)
    await lookForSshProgram() // joins the look the refresh started
    expect(findOnWindowsPathAsync).toHaveBeenCalledTimes(2)
    expect(_keptSshProgramForTest()).toBe(`${NEW}\\ssh.exe`)
    await probeTmuxLive(KEY, ['a'])
    expect(started()).toEqual([`${NEW}\\ssh.exe`])
    expect(findOnWindowsPath).not.toHaveBeenCalled()
  })

  // Mutation to prove this can fail: no look every SSH_PROGRAM_RECHECK_MS.
  it('once started on Windows, the look is made again every SSH_PROGRAM_RECHECK_MS; never before start, never off Windows, and one timer only', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    setPath(TRUSTED)
    h.files = new Set([TRUSTED_SSH])
    vi.advanceTimersByTime(3 * SSH_PROGRAM_RECHECK_MS)
    expect(findOnWindowsPathAsync, 'nothing before start').not.toHaveBeenCalled()
    h.platform = 'linux'
    startSshProgramLookup()
    vi.advanceTimersByTime(3 * SSH_PROGRAM_RECHECK_MS)
    expect(findOnWindowsPathAsync, 'nothing off Windows').not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    _resetSshProgramForTest()
    h.platform = 'win32'
    startSshProgramLookup()
    await lookForSshProgram() // joins the start-up look
    expect(findOnWindowsPathAsync).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(SSH_PROGRAM_RECHECK_MS - 1)
    expect(findOnWindowsPathAsync).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(findOnWindowsPathAsync).toHaveBeenCalledTimes(2)
    await lookForSshProgram() // joins the recheck
    vi.advanceTimersByTime(SSH_PROGRAM_RECHECK_MS)
    expect(findOnWindowsPathAsync).toHaveBeenCalledTimes(3)
    await lookForSshProgram()
    startSshProgramLookup()
    expect(vi.getTimerCount(), 'a second start makes no second timer').toBe(1)
    expect(_keptSshProgramForTest()).toBe(TRUSTED_SSH)
  })

  // Mutation to prove this and the next can fail: no look every
  // SSH_PROGRAM_RECHECK_MS (and, for this one, a look that finds none keeps
  // the old answer).
  it('an ssh.exe removed after the look is not run once the recheck has looked again: the next start refuses with SSH_NOT_ON_PATH', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    setPath(TRUSTED)
    h.files = new Set([TRUSTED_SSH])
    startSshProgramLookup()
    await lookForSshProgram()
    expect(_keptSshProgramForTest()).toBe(TRUSTED_SSH)
    // Git for Windows uninstalled, say: the file goes.
    h.files.delete(TRUSTED_SSH)
    vi.advanceTimersByTime(SSH_PROGRAM_RECHECK_MS)
    expect(findOnWindowsPathAsync, 'the recheck looked again').toHaveBeenCalledTimes(2)
    await lookForSshProgram() // joins the recheck
    expect(findOnWindowsPathAsync).toHaveBeenCalledTimes(2)
    expect(_keptSshProgramForTest()).toBeUndefined()
    expect(() => spawnPty(fakeWin, 'ssh-recheck-gone', { ssh: SSH } as never)).toThrow(SSH_NOT_ON_PATH)
    expect(started()).toEqual([])
  })

  it('an ssh.exe removed after the look, with another later on PATH: once the recheck has looked again, the next start runs the other', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const LATER = 'D:\\Later'
    setPath(TRUSTED, LATER)
    h.files = new Set([TRUSTED_SSH, `${LATER}\\ssh.exe`])
    startSshProgramLookup()
    await lookForSshProgram()
    expect(_keptSshProgramForTest()).toBe(TRUSTED_SSH)
    h.files.delete(TRUSTED_SSH)
    vi.advanceTimersByTime(SSH_PROGRAM_RECHECK_MS)
    expect(findOnWindowsPathAsync, 'the recheck looked again').toHaveBeenCalledTimes(2)
    await lookForSshProgram() // joins the recheck
    expect(findOnWindowsPathAsync).toHaveBeenCalledTimes(2)
    expect(_keptSshProgramForTest()).toBe(`${LATER}\\ssh.exe`)
    await probeTmuxLive(KEY, ['a'])
    expect(started()).toEqual([`${LATER}\\ssh.exe`])
    expect(findOnWindowsPath, 'read from the kept answer').not.toHaveBeenCalled()
  })

  // Mutation to prove this can fail: run a kept answer whatever its age.
  it('a kept answer SSH_PROGRAM_KEEP_MS old is not run: the start walks in place, as before, runs what that finds, and starts a new look', async () => {
    const FIRST = 'D:\\First'
    setPath(FIRST, TRUSTED)
    h.files = new Set([TRUSTED_SSH])
    await lookForSshProgram()
    findOnWindowsPathAsync.mockClear()
    const now = performance.now()
    // An ssh.exe put in an earlier PATH folder since the look.
    h.files.add(`${FIRST}\\ssh.exe`)
    // A second under the limit (the look ended a moment before `now`).
    expect(sshProgram('win32', process.env, now + SSH_PROGRAM_KEEP_MS - 1000), 'still run under the limit').toBe(TRUSTED_SSH)
    expect(findOnWindowsPath).not.toHaveBeenCalled()
    expect(sshProgram('win32', process.env, now + SSH_PROGRAM_KEEP_MS)).toBe(`${FIRST}\\ssh.exe`)
    expect(findOnWindowsPath, 'walked in place').toHaveBeenCalledTimes(1)
    expect(findOnWindowsPathAsync, 'one new look, joined by the second start').toHaveBeenCalledTimes(1)
  })

  it('a kept answer SSH_PROGRAM_KEEP_MS old whose ssh.exe has gone: the start refuses with SSH_NOT_ON_PATH, as a walk in place does', async () => {
    setPath(TRUSTED)
    h.files = new Set([TRUSTED_SSH])
    await lookForSshProgram()
    h.files.delete(TRUSTED_SSH)
    const now = performance.now()
    expect(() => sshProgram('win32', process.env, now + SSH_PROGRAM_KEEP_MS)).toThrow(SSH_NOT_ON_PATH)
    expect(findOnWindowsPath).toHaveBeenCalledTimes(1)
  })

  // Mutation to prove this can fail: drop the look a start makes when no
  // answer is kept.
  it('once started, a start with no answer kept starts a look: an ssh.exe that appears after the start-up look found none is read from the next start on', async () => {
    setPath(TRUSTED)
    startSshProgramLookup()
    await lookForSshProgram() // joins the start-up look, which finds none
    expect(_keptSshProgramForTest()).toBeUndefined()
    // Windows' OpenSSH feature added, with no PATH change.
    h.files = new Set([TRUSTED_SSH])
    holdTheLook()
    await probeTmuxLive(KEY, ['a'])
    expect(started()).toEqual([TRUSTED_SSH])
    expect(findOnWindowsPath, 'that start walked in place').toHaveBeenCalledTimes(1)
    expect(findOnWindowsPathAsync, 'and started a look').toHaveBeenCalledTimes(2)
    const look = lookForSshProgram() // joins it
    expect(findOnWindowsPathAsync).toHaveBeenCalledTimes(2)
    h.openLook()
    await look
    expect(_keptSshProgramForTest()).toBe(TRUSTED_SSH)
    await probeTmuxLive(KEY, ['a'])
    expect(started()).toEqual([TRUSTED_SSH, TRUSTED_SSH])
    expect(findOnWindowsPath, 'the next start walked nothing in place').toHaveBeenCalledTimes(1)
  })

  // Mutation to prove this can fail: the look runs whatever the platform.
  it('off Windows nothing is looked for and nothing is kept', async () => {
    h.platform = 'linux'
    startSshProgramLookup()
    await lookForSshProgram()
    expect(findOnWindowsPathAsync).not.toHaveBeenCalled()
    expect(sshProgram()).toBe('ssh')
  })
})
