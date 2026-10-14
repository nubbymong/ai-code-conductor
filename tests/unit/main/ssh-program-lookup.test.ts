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
// node-pty, child_process and Electron are mocked: nothing is started and no
// host is dialled. Reads no file of the host's.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  platform: 'win32' as NodeJS.Platform,
  /** Candidates the fake file system holds; `every` makes every candidate a file. */
  files: new Set<string>(),
  every: false,
  ptySpawns: [] as Array<{ file: string; args: string[] }>,
  execFiles: [] as Array<{ file: string; args: string[] }>,
  logs: [] as string[],
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
vi.mock('../../../src/main/windows-programs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/windows-programs')>()
  findOnWindowsPath.mockImplementation((names: readonly string[], env: NodeJS.ProcessEnv, _stat?: unknown, order?: 'folder' | 'name') =>
    real.findOnWindowsPath(names, env, (p) => h.every || h.files.has(p), order))
  return { ...real, findOnWindowsPath }
})

const { spawnPty, endSshRemote, probeTmuxLive, sshProgram, SSH_NOT_ON_PATH } = await import('../../../src/main/pty-manager')
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
function setPath(...dirs: string[]): void { process.env.PATH = dirs.join(';') }

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
  findOnWindowsPath.mockClear()
})
afterEach(() => {
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
