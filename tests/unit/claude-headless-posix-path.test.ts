// A headless Claude Code run when macOS opens the app from the Dock or Finder:
// the app's PATH is launchd's (/usr/bin:/bin:/usr/sbin:/sbin), and Claude Code
// is in a folder only the login shell names (Homebrew, ~/.local/bin). The CLI
// probe finds it (`<login shell> -lc 'command -v claude'`), but the run started
// `sh -c claude` with the app's own PATH and exited 127. The run must start the
// Claude Code the probe found, with its folder first on PATH, and an npm claude
// (a `#!/usr/bin/env node` script) must find the node beside it.
//
// The runs are REAL: `sh -c claude` into a FAKE claude in a temp folder off
// PATH. Their environment is built from nothing (env -i style): withProfileHome
// is replaced by one that returns only a bare PATH and a fake HOME, so a run
// never sees this process's HOME, PATH or credentials. The probe's processes
// are never started: execFile, the probe's only process, answers
// `/bin/zsh -lc 'command -v claude'` itself (found, a plain miss, ended by its
// timeout, or never, as a child that ignores every signal but records it) and
// `which claude` (a plain miss, or h.whichAnswer), and records the options it
// was handed. spawn, the run's, is the real one, wrapped only to record what
// each start was handed. No real Claude Code starts. A case that leaves a
// probe hanging shortens the probe's own timeout and waits for it to settle,
// so no probe settles during a later case.
//
// The real runs are POSIX only (skipped on Windows, where a run starts Claude
// Code by the full path found in PATH's folders, with no shell). The cases
// that run on every OS start nothing: one proves a Windows run is untouched by
// the fix (it forces win32, the Windows lookup names a fake claude.exe, and the
// Windows start command only records what it was handed and refuses), one
// reads the options the probe hands its login shell, and the rest call
// withClaudeFolderOnPath. So on the owner's workstation this file starts
// nothing.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getEventListeners } from 'node:events'

const BARE = '/usr/bin:/bin:/usr/sbin:/sbin'

const h = vi.hoisted(() => ({
  env: {} as Record<string, string>,
  answer: null as string | null,
  /** How the login shell gives no answer: ended by its timeout (after
   *  delayMs), or never answering at all. */
  noAnswer: null as 'timeout' | 'hang' | null,
  /** What `which claude` prints (null: a plain miss). */
  whichAnswer: null as string | null,
  delayMs: 0,
  asked: [] as string[],
  /** The options each probe process was handed. */
  execOpts: [] as Array<Record<string, unknown>>,
  /** The signals a login shell that never answers was sent. */
  killed: [] as string[],
  /** What each run's start was handed (the real spawn starts it). */
  spawned: [] as Array<{ file: string; PATH: string | undefined }>,
  /** os.platform() while set (the Windows case's probe asks as on macOS). */
  osPlatform: null as NodeJS.Platform | null,
  winBin: 'C:\\Users\\A\\.local\\bin\\claude.exe',
  winRefused: 'test: the Windows start is recorded here, never run',
  /** What each Windows start command was handed. */
  winStarts: [] as Array<{ program: string; PATH: string | undefined }>,
}))

// os.platform() picks the probe's branch (claude-cli-probe.ts runProbe). The
// Windows case asks it as on macOS, so the probe's last answer is a POSIX path
// on every host. Everything else in os is the real one.
vi.mock('os', async (importOriginal) => {
  const real = await importOriginal<typeof import('os')>()
  const platform = (): NodeJS.Platform => h.osPlatform ?? real.platform()
  return { ...real, platform, default: { ...real, platform } }
})
// The Windows lookup names a fake claude.exe. The probe and its last answer
// are the real ones.
vi.mock('../../src/main/claude-cli-probe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/claude-cli-probe')>()),
  recentClaudeOnWindows: () => null,
  findClaudeOnWindowsAsync: async () => h.winBin,
}))
// The Windows start command records the environment it was handed and
// refuses, so a Windows run here starts nothing.
vi.mock('../../src/main/windows-programs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/windows-programs')>()),
  windowsStartCommand: (program: string, _args: readonly string[], env: Record<string, string | undefined>) => {
    h.winStarts.push({ program, PATH: env.PATH })
    return { refused: h.winRefused }
  },
}))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(), logDebug: vi.fn() }))
// env -i: the run's environment is h.env alone, never this process's.
vi.mock('../../src/main/pty-manager', () => ({ withProfileHome: () => ({ ...h.env }) }))
vi.mock('../../src/main/managed-launch-diagnostics', () => ({ gateManagedLaunch: async () => ({ status: 'clean' }), peekGateVerdict: () => undefined }))
vi.mock('../../src/main/profile-consumers', () => ({ acquireProfileConsumer: () => null, pendingProfileRefresh: () => null }))
vi.mock('../../src/main/profile-id', () => ({ profileIdFromHome: () => null }))
// The probe asks a sh-family login shell, zsh as on macOS (named, never started).
vi.mock('../../src/main/login-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/login-shell')>()),
  loginShellWithOwnPath: () => null,
  shFamilyLoginShell: () => '/bin/zsh',
}))
// execFile is only the probe's (claude-cli-probe.ts probeOnce): it answers
// `command -v claude` with h.answer and `which claude` with h.whichAnswer
// (none: a plain miss, a non-zero exit as execFile reports one), after
// h.delayMs, and starts no process. h.noAnswer makes the login shell give no
// answer instead. spawn, the run's, is the real one, recorded.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>()
  const execFile = (file: string, args: string[], opts: Record<string, unknown>, cb: (err: Error | null, stdout: string) => void): object => {
    h.asked.push([file, ...args].join(' '))
    h.execOpts.push(opts)
    const login = file === '/bin/zsh' && args[0] === '-lc' && args[1] === 'command -v claude'
    if (login && h.noAnswer === 'hang') return { kill: (signal: string) => { h.killed.push(signal); return true } }
    const answer = login ? h.answer : file === 'which' ? h.whichAnswer : null
    setTimeout(() => {
      if (login && h.noAnswer === 'timeout') return cb(Object.assign(new Error('Command failed (ended by its timeout)'), { code: null, killed: true, signal: 'SIGTERM' }), '')
      return answer ? cb(null, answer + '\n') : cb(Object.assign(new Error('Command failed'), { code: 1, killed: false, signal: null }), '')
    }, h.delayMs)
    return {}
  }
  const spawn = (file: string, args: readonly string[], opts: { env?: Record<string, string> }): unknown => {
    h.spawned.push({ file, PATH: opts?.env?.PATH })
    return (real.spawn as (...a: unknown[]) => unknown)(file, args, opts)
  }
  return { ...real, execFile, spawn }
})

const { spawnClaudeHeadless, withClaudeFolderOnPath, _setProbeWaitForTest } = await import('../../src/main/claude-headless')
const { probeClaudeCli, claudeFoundByLastProbe, claudeProbeInFlight, _resetClaudeCliProbeForTest, _setProbeStepTimeoutForTest } = await import('../../src/main/claude-cli-probe')

const IS_WIN = process.platform === 'win32'
const PREFIX = 'ccc-headless-posix-path-'
let dir = ''
let home = ''
/** Native-style Claude Code: a program in a folder off the bare PATH. */
let nativeBin = ''
/** npm-style Claude Code: `#!/usr/bin/env node`, with a node beside it. */
let npmBin = ''

const sh = (lines: string[]): string => lines.join('\n') + '\n'
/** Never start a real Claude Code: a case that expects `claude: not found` runs only when the bare PATH has none. */
const bareHasClaude = (): boolean => BARE.split(':').some((d) => fs.existsSync(path.join(d, 'claude')))
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

beforeAll(() => {
  if (IS_WIN) return
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)))
  home = path.join(dir, 'home')
  nativeBin = path.join(dir, 'native', 'bin')
  npmBin = path.join(dir, 'npm', 'bin')
  for (const d of [home, nativeBin, npmBin]) fs.mkdirSync(d, { recursive: true })
  // Records the PATH and HOME it was started with, and answers as Claude Code does.
  fs.writeFileSync(path.join(nativeBin, 'claude'), sh([
    '#!/bin/sh',
    'printf "%s" "$PATH" > "$(dirname "$0")/path.txt"',
    'printf "%s" "$HOME" > "$(dirname "$0")/home.txt"',
    'echo "2.1.999 (Claude Code)"',
  ]), { mode: 0o755 })
  // An npm install: the CLI is a node script, and node is in the same folder
  // (this one marks that it was the node used, then runs this test's node).
  fs.writeFileSync(path.join(npmBin, 'claude'), sh([
    '#!/usr/bin/env node',
    "console.log('2.1.998 (Claude Code)')",
  ]), { mode: 0o755 })
  fs.writeFileSync(path.join(npmBin, 'node'), sh([
    '#!/bin/sh',
    ': > "$(dirname "$0")/node-used.txt"',
    `exec ${JSON.stringify(process.execPath)} "$@"`,
  ]), { mode: 0o755 })
})
afterAll(() => {
  // TEST CLEANUP GUARD: only this suite's own folder, by its prefix and parent.
  if (dir && path.basename(dir).startsWith(PREFIX) && path.dirname(dir) === fs.realpathSync.native(os.tmpdir())) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
})
beforeEach(() => {
  _resetClaudeCliProbeForTest()
  _setProbeWaitForTest(null)
  _setProbeStepTimeoutForTest(null)
  h.env = { PATH: BARE, HOME: home }
  h.answer = null
  h.noAnswer = null
  h.whichAnswer = null
  h.delayMs = 0
  h.asked = []
  h.execOpts = []
  h.killed = []
  h.spawned = []
  h.osPlatform = null
  h.winStarts = []
  // TEST CLEANUP GUARD: on Windows the folders are never made, and these joins would name files in the cwd.
  if (dir) for (const f of [path.join(nativeBin, 'path.txt'), path.join(nativeBin, 'home.txt'), path.join(npmBin, 'node-used.txt')]) fs.rmSync(f, { force: true })
})

const read = (f: string): string => fs.readFileSync(f, 'utf8')

describe.skipIf(IS_WIN)('a headless run under the bare PATH launchd gives starts the Claude Code the CLI probe found (POSIX only)', () => {
  it('a Claude Code only the login shell finds: its folder first on PATH, nothing else from this process', async () => {
    h.answer = path.join(nativeBin, 'claude')
    expect((await probeClaudeCli()).path).toBe(h.answer)
    const res = await spawnClaudeHeadless(['--version'], 30_000)
    expect(res.code, res.stderr).toBe(0)
    expect(res.stdout).toContain('2.1.999 (Claude Code)')
    expect(read(path.join(nativeBin, 'path.txt'))).toBe(`${nativeBin}:${BARE}`)
    expect(read(path.join(nativeBin, 'home.txt'))).toBe(home)
    // The run started no login shell of its own: the one probe asked once.
    expect(h.asked).toEqual(['/bin/zsh -lc command -v claude'])
  }, 60_000)

  it('an npm Claude Code (#!/usr/bin/env node) finds the node in its own folder', async () => {
    h.answer = path.join(npmBin, 'claude')
    await probeClaudeCli()
    const res = await spawnClaudeHeadless(['--version'], 30_000)
    expect(res.code, res.stderr).toBe(0)
    expect(res.stdout).toContain('2.1.998 (Claude Code)')
    expect(fs.existsSync(path.join(npmBin, 'node-used.txt'))).toBe(true)
  }, 60_000)

  it('a run that starts while the probe is still asking (Sentinel at start) waits for its answer', async () => {
    h.answer = path.join(nativeBin, 'claude')
    h.delayMs = 300
    const probe = probeClaudeCli()
    const res = await spawnClaudeHeadless(['--version'], 30_000)
    expect(res.code, res.stderr).toBe(0)
    expect(read(path.join(nativeBin, 'path.txt'))).toBe(`${nativeBin}:${BARE}`)
    expect((await probe).path).toBe(h.answer)
    expect(h.asked).toEqual(['/bin/zsh -lc command -v claude'])
  }, 60_000)

  it('a PATH that already names the folder is left exactly as it is', async () => {
    h.answer = path.join(nativeBin, 'claude')
    h.env = { PATH: `${BARE}:${nativeBin}`, HOME: home }
    await probeClaudeCli()
    const res = await spawnClaudeHeadless(['--version'], 30_000)
    expect(res.code, res.stderr).toBe(0)
    expect(read(path.join(nativeBin, 'path.txt'))).toBe(`${BARE}:${nativeBin}`)
  }, 60_000)

  it('nothing found and no probe running: the run starts as before (claude by name in the bare PATH)', async (ctx) => {
    // Never start a real Claude Code: only when the bare PATH has none.
    if (BARE.split(':').some((d) => fs.existsSync(path.join(d, 'claude')))) ctx.skip()
    await probeClaudeCli()
    const res = await spawnClaudeHeadless(['--version'], 30_000)
    expect(res.code).toBe(127)
    expect(fs.existsSync(path.join(nativeBin, 'path.txt'))).toBe(false)
    expect(h.asked).toEqual(['/bin/zsh -lc command -v claude', 'which claude'])
  }, 60_000)
})

describe.skipIf(IS_WIN)('the wait for a running probe has a bound and ends on an abort (POSIX only)', () => {
  it('a probe that never answers: once the bound passes the run starts without its answer, as before the fix', async (ctx) => {
    if (bareHasClaude()) ctx.skip()
    h.noAnswer = 'hang'
    _setProbeWaitForTest(300)
    // Long enough that the hung probe cannot settle before a slow runner's `sh` start returns.
    _setProbeStepTimeoutForTest(2_000)
    const probe = probeClaudeCli()
    const t0 = Date.now()
    const res = await spawnClaudeHeadless(['--version'], 30_000)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250)
    expect(res.code).toBe(127)
    expect(h.spawned).toEqual([{ file: 'claude', PATH: BARE }])
    // The probe goes on; only the run stopped waiting for it.
    expect(claudeProbeInFlight()).toBe(probe)
    await probe
  }, 10_000)

  it('a probe that answers within the bound: the run uses its answer, and the wait clears its timer', async () => {
    h.answer = path.join(nativeBin, 'claude')
    h.delayMs = 100
    _setProbeWaitForTest(4_321)
    const setSpy = vi.spyOn(globalThis, 'setTimeout')
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    try {
      const probe = probeClaudeCli()
      const res = await spawnClaudeHeadless(['--version'], 30_000)
      expect(res.code, res.stderr).toBe(0)
      expect(read(path.join(nativeBin, 'path.txt'))).toBe(`${nativeBin}:${BARE}`)
      const wait = setSpy.mock.calls.findIndex((c) => c[1] === 4_321)
      expect(wait).toBeGreaterThanOrEqual(0)
      expect(clearSpy).toHaveBeenCalledWith(setSpy.mock.results[wait].value)
      await probe
    } finally {
      setSpy.mockRestore()
      clearSpy.mockRestore()
    }
  }, 60_000)

  it('a run aborted while it waits answers at once and starts nothing', async () => {
    h.answer = path.join(nativeBin, 'claude')
    h.delayMs = 3000
    const probe = probeClaudeCli()
    const ac = new AbortController()
    const t0 = Date.now()
    const run = spawnClaudeHeadless(['--version'], 30_000, undefined, null, ac.signal)
    setTimeout(() => ac.abort(), 50)
    expect(await run).toEqual({ code: 1, stdout: '', stderr: '\nAborted' })
    expect(Date.now() - t0).toBeLessThan(1500)
    // Nothing starts once the probe answers either.
    expect((await probe).path).toBe(h.answer)
    expect(h.spawned).toEqual([])
    expect(fs.existsSync(path.join(nativeBin, 'path.txt'))).toBe(false)
  }, 15_000)

  it('a run that waited and ended with no abort leaves no listener of the wait on its signal', async (ctx) => {
    if (bareHasClaude()) ctx.skip()
    // A run that never waits (a path is known): what the run itself leaves on its signal.
    h.answer = path.join(nativeBin, 'claude')
    await probeClaudeCli()
    const plain = new AbortController()
    expect((await spawnClaudeHeadless(['--version'], 30_000, undefined, null, plain.signal)).code).toBe(0)
    const baseline = getEventListeners(plain.signal, 'abort').length

    // Waited, and the probe answered.
    _resetClaudeCliProbeForTest()
    h.delayMs = 100
    const answered = new AbortController()
    const first = probeClaudeCli()
    expect((await spawnClaudeHeadless(['--version'], 30_000, undefined, null, answered.signal)).code).toBe(0)
    await first
    expect(getEventListeners(answered.signal, 'abort')).toHaveLength(baseline)

    // Waited, and the bound passed.
    _resetClaudeCliProbeForTest()
    h.noAnswer = 'hang'
    _setProbeWaitForTest(200)
    _setProbeStepTimeoutForTest(100)
    const bounded = new AbortController()
    const second = probeClaudeCli()
    expect((await spawnClaudeHeadless(['--version'], 30_000, undefined, null, bounded.signal)).code).toBe(127)
    expect(getEventListeners(bounded.signal, 'abort')).toHaveLength(baseline)
    expect(answered.signal.aborted || bounded.signal.aborted).toBe(false)
    await second
  }, 30_000)
})

describe.skipIf(IS_WIN)('a probe with no answer to go by keeps the path found before it (POSIX only)', () => {
  it('a login shell ended by its timeout keeps the kept path, and a run still starts that Claude Code', async () => {
    const found = path.join(nativeBin, 'claude')
    h.answer = found
    await probeClaudeCli()
    h.answer = null
    h.noAnswer = 'timeout'
    expect((await probeClaudeCli()).installed).toBe(false)
    // The kept file's check runs after the probe settles.
    await sleep(100)
    expect(claudeFoundByLastProbe()).toBe(found)
    const res = await spawnClaudeHeadless(['--version'], 30_000)
    expect(res.code, res.stderr).toBe(0)
    expect(read(path.join(nativeBin, 'path.txt'))).toBe(`${nativeBin}:${BARE}`)
  }, 60_000)

  it('a plain not found clears it, and so does no answer once the kept file is gone', async () => {
    h.answer = path.join(nativeBin, 'claude')
    await probeClaudeCli()
    h.answer = null
    await probeClaudeCli()
    expect(claudeFoundByLastProbe()).toBeNull()

    const goneBin = path.join(dir, 'gone', 'bin')
    const gone = path.join(goneBin, 'claude')
    fs.mkdirSync(goneBin, { recursive: true })
    fs.writeFileSync(gone, sh(['#!/bin/sh', 'exit 0']), { mode: 0o755 })
    h.answer = gone
    await probeClaudeCli()
    expect(claudeFoundByLastProbe()).toBe(gone)
    fs.rmSync(gone)
    h.answer = null
    h.noAnswer = 'timeout'
    await probeClaudeCli()
    await vi.waitFor(() => expect(claudeFoundByLastProbe()).toBeNull())
  })

  it('a login shell that never exits still settles after its timeout and a grace, is ended with SIGKILL, and keeps the kept path', async () => {
    const found = path.join(nativeBin, 'claude')
    h.answer = found
    await probeClaudeCli()
    h.answer = null
    h.noAnswer = 'hang'
    _setProbeStepTimeoutForTest(200)
    const t0 = Date.now()
    const second = await probeClaudeCli()
    const took = Date.now() - t0
    expect(second.installed).toBe(false)
    expect(took).toBeGreaterThanOrEqual(1100)
    expect(took).toBeLessThan(5000)
    expect(h.killed).toEqual(['SIGKILL'])
    // Settled: a later run does not join it and wait out its bound.
    expect(claudeProbeInFlight()).toBeNull()
    await sleep(100)
    expect(claudeFoundByLastProbe()).toBe(found)
  }, 10_000)
})

describe.skipIf(IS_WIN)('only a path a run may put on PATH is kept for a run (POSIX only)', () => {
  it.each([
    ['a stray line a login profile printed', '/usr/local/bin/brew'],
    ['a path with a C1 control character in its folder', '/opt/a\x85b/claude'],
    ['a name, not a path', 'claude'],
  ])('%s keeps the good path found before it, and a run still starts that Claude Code', async (_label, stray) => {
    const found = path.join(nativeBin, 'claude')
    h.answer = found
    await probeClaudeCli()
    h.answer = stray
    // The probe still reports what the login shell printed, for its other uses.
    expect((await probeClaudeCli()).path).toBe(stray)
    await sleep(100)
    expect(claudeFoundByLastProbe()).toBe(found)
    const res = await spawnClaudeHeadless(['--version'], 30_000)
    expect(res.code, res.stderr).toBe(0)
    expect(read(path.join(nativeBin, 'path.txt'))).toBe(`${nativeBin}:${BARE}`)
  }, 60_000)

  it('a line a login profile printed first puts nothing on PATH, so a claude beside it never runs', async (ctx) => {
    if (bareHasClaude()) ctx.skip()
    const shared = path.join(dir, 'shared')
    fs.mkdirSync(shared, { recursive: true })
    fs.writeFileSync(path.join(shared, 'claude'), sh(['#!/bin/sh', 'echo planted']), { mode: 0o755 })
    // The login profile printed one absolute path before `command -v` answered.
    h.answer = path.join(shared, 'some-profile-line')
    expect((await probeClaudeCli()).path).toBe(h.answer)
    const res = await spawnClaudeHeadless(['--version'], 30_000)
    expect(res.code).toBe(127)
    expect(res.stdout).not.toContain('planted')
    expect(h.spawned).toEqual([{ file: 'claude', PATH: BARE }])
  }, 60_000)
})

describe.skipIf(IS_WIN)('an answer of which never feeds the PATH (POSIX only)', () => {
  it('a claude only which names (another project) is reported, but never kept or put on PATH', async (ctx) => {
    if (bareHasClaude()) ctx.skip()
    const other = path.join(dir, 'other-project', 'node_modules', '.bin')
    fs.mkdirSync(other, { recursive: true })
    fs.writeFileSync(path.join(other, 'claude'), sh(['#!/bin/sh', 'echo other-project']), { mode: 0o755 })
    h.whichAnswer = path.join(other, 'claude')
    h.delayMs = 100
    const probe = probeClaudeCli()
    // The run waits for the probe: the login shell says not found, which names the other project.
    const res = await spawnClaudeHeadless(['--version'], 30_000)
    expect((await probe).path).toBe(h.whichAnswer)
    expect(claudeFoundByLastProbe()).toBeNull()
    expect(res.code).toBe(127)
    expect(res.stdout).not.toContain('other-project')
    expect(h.spawned).toEqual([{ file: 'claude', PATH: BARE }])
  }, 60_000)

  it('after a login shell with no answer, a which answer leaves the good kept path as it is', async () => {
    const found = path.join(nativeBin, 'claude')
    h.answer = found
    await probeClaudeCli()
    h.answer = null
    h.noAnswer = 'timeout'
    h.whichAnswer = path.join(dir, 'elsewhere', 'claude')
    expect((await probeClaudeCli()).path).toBe(h.whichAnswer)
    await sleep(100)
    expect(claudeFoundByLastProbe()).toBe(found)
  })
})

describe('the login-shell probe runs in the home folder (every OS; nothing starts)', () => {
  it('hands the login shell the home folder as its working folder, never the folder the app runs in', async () => {
    h.answer = '/opt/homebrew/bin/claude'
    // The probe asks as on macOS (its POSIX branch), on every host.
    h.osPlatform = 'darwin'
    let probe: ReturnType<typeof probeClaudeCli>
    try { probe = probeClaudeCli() } finally { h.osPlatform = null }
    expect((await probe).path).toBe('/opt/homebrew/bin/claude')
    expect(h.asked).toEqual(['/bin/zsh -lc command -v claude'])
    expect(h.execOpts[0]).toMatchObject({ cwd: os.homedir() })
  })
})

// Every OS: the platform is forced to win32 and nothing is started (see the header).
describe('a headless run on Windows is untouched by the POSIX PATH fix (every OS)', () => {
  const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  afterEach(() => { Object.defineProperty(process, 'platform', hostPlatform) })

  it('does not wait on a running probe, does not use its last answer, and hands the Windows start PATH unchanged', async () => {
    const WIN_PATH = 'C:\\Windows\\System32;C:\\Users\\A\\AppData\\Roaming\\npm'
    const MAC_CLAUDE = '/opt/homebrew/bin/claude'
    h.env = { PATH: WIN_PATH, SystemRoot: 'C:\\Windows' }
    h.answer = MAC_CLAUDE
    h.delayMs = 300
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    // The probe asks as on macOS, so its answer is the folder a POSIX run would put first.
    const probeAsOnMac = (): ReturnType<typeof probeClaudeCli> => {
      h.osPlatform = 'darwin'
      try { return probeClaudeCli() } finally { h.osPlatform = null }
    }
    const refused = { code: 1, stdout: '', stderr: h.winRefused }

    // (a) Nothing known and a probe still asking: a POSIX run would wait for it.
    const probe = probeAsOnMac()
    const first = await Promise.race([spawnClaudeHeadless(['--version'], 10_000), new Promise((r) => setTimeout(() => r('still waiting'), 20))])
    expect(first).toEqual(refused)
    expect(claudeProbeInFlight()).toBe(probe)
    expect((await probe).path).toBe(MAC_CLAUDE)

    // (b) A remembered answer: a POSIX run would put /opt/homebrew/bin first.
    expect(claudeFoundByLastProbe()).toBe(MAC_CLAUDE)
    expect(await spawnClaudeHeadless(['--version'], 10_000)).toEqual(refused)

    // (c) Both Windows starts were handed the run's PATH as it was, and
    // neither run asked a probe of its own.
    expect(h.winStarts).toEqual([{ program: h.winBin, PATH: WIN_PATH }, { program: h.winBin, PATH: WIN_PATH }])
    expect(h.asked).toEqual(['/bin/zsh -lc command -v claude'])
  })
})

describe('withClaudeFolderOnPath (the PATH a POSIX run starts with)', () => {
  it('puts the folder the probe named first, keeps the rest, and leaves its input as it was', () => {
    const env = { PATH: BARE, HOME: '/Users/someone', LANG: 'en_GB.UTF-8' }
    const out = withClaudeFolderOnPath(env, '/opt/homebrew/bin/claude')
    expect(out).toEqual({ PATH: `/opt/homebrew/bin:${BARE}`, HOME: '/Users/someone', LANG: 'en_GB.UTF-8' })
    expect(env.PATH).toBe(BARE)
    expect(withClaudeFolderOnPath({ PATH: BARE }, '/Users/someone/.local/bin/claude').PATH).toBe(`/Users/someone/.local/bin:${BARE}`)
  })

  it.each([
    ['no path found', { PATH: BARE }, null],
    ['the folder already on PATH', { PATH: `/usr/local/bin:/opt/homebrew/bin:${BARE}` }, '/opt/homebrew/bin/claude'],
    ['a name, not a path (command -v of a function)', { PATH: BARE }, 'claude'],
    ['an alias line (command -v of an alias)', { PATH: BARE }, "alias claude='/opt/x/claude'"],
    ['a folder with a colon (no PATH entry can name it)', { PATH: BARE }, '/opt/a:b/claude'],
    ['no PATH at all', {}, '/opt/homebrew/bin/claude'],
    ['an empty PATH (an empty entry would mean the folder the run starts in)', { PATH: '' }, '/opt/homebrew/bin/claude'],
    ['a file not named claude (a line a login profile printed)', { PATH: BARE }, '/etc/passwd'],
    ['a name that only begins with claude', { PATH: BARE }, '/opt/x/claude-old'],
    ['a folder with a NUL', { PATH: BARE }, '/opt/a\0b/claude'],
    ['a folder with a tab', { PATH: BARE }, '/opt/a\tb/claude'],
    ['a folder with a newline', { PATH: BARE }, '/opt/a\nb/claude'],
    ['a folder with a carriage return', { PATH: BARE }, '/opt/a\rb/claude'],
    ['a folder with an escape (a terminal colour code)', { PATH: BARE }, '/opt/a\x1b[31mb/claude'],
    ['a folder with a DEL', { PATH: BARE }, '/opt/a\x7fb/claude'],
    ['a folder with a C1 next line', { PATH: BARE }, '/opt/a\x85b/claude'],
    ['a folder with a C1 control sequence introducer', { PATH: BARE }, '/opt/a\x9b31mb/claude'],
    ['a folder with a Unicode line separator', { PATH: BARE }, '/opt/a\u2028b/claude'],
    ['a folder with a Unicode paragraph separator', { PATH: BARE }, '/opt/a\u2029b/claude'],
  ] as Array<[string, Record<string, string>, string | null]>)('%s: the environment itself, unchanged', (_label, env, claudePath) => {
    const before = { ...env }
    expect(withClaudeFolderOnPath(env, claudePath)).toBe(env)
    expect(env).toEqual(before)
  })
})
