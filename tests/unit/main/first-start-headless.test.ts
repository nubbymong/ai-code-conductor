// ADR-025: a headless Claude Code run (Sentinel's checks and analysis, the
// Insights runs, onboarding's Find Claude) starts a claude.exe found in PATH's
// folders directly on Windows, on the main thread. Before that start it awaits
// the first-start warm-up of that same program, with Claude's --version
// environment; a run aborted during the wait answers at once, without
// waiting for the warm-up, and starts nothing; one waiting on it when the app
// quits never starts; an npm claude.cmd (started through cmd.exe) is not
// warmed. The lookup, the warm-up and child_process are faked and the
// platform is forced: nothing is started.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { FirstStartEnvSource, FirstStartRun } from '../../../src/main/first-start-warmup'

const h = vi.hoisted(() => ({
  bin: 'C:\\Users\\A\\.local\\bin\\claude.exe' as string | null,
  order: [] as string[],
  warm: [] as Array<{ program: string; env: () => unknown }>,
  gate: null as null | Promise<void>,
  /** A case's own warm-up in place of the fake below. */
  warmImpl: null as null | ((program: string, env: () => unknown) => Promise<unknown>),
}))
vi.mock('child_process', () => ({
  spawn: (file: string) => {
    h.order.push(`spawn ${file}`)
    const handlers = new Map<string, (...a: unknown[]) => void>()
    const child = {
      pid: 4242,
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: (ev: string, fn: (...a: unknown[]) => void) => { handlers.set(ev, fn); if (ev === 'close') setTimeout(() => fn(0), 0) },
      kill: vi.fn(),
    }
    return child
  },
  spawnSync: () => ({ status: 0 }),
}))
vi.mock('../../../src/main/claude-cli-probe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/claude-cli-probe')>()),
  recentClaudeOnWindows: () => h.bin,
  findClaudeOnWindowsAsync: async () => h.bin,
}))
// withProfileHome pulls in the heavy pty-manager graph (reaches electron); stub it.
vi.mock('../../../src/main/pty-manager', () => ({ withProfileHome: (env: Record<string, string>) => env }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/first-start-warmup', () => ({
  warmFirstStart: async (program: string, env: () => unknown) => {
    h.warm.push({ program, env })
    h.order.push(`warm ${program}`)
    if (h.warmImpl) return h.warmImpl(program, env)
    if (h.gate) await h.gate
    return { outcome: 'ran', exitCode: 0, timedOut: false }
  },
}))

const { spawnClaudeHeadless } = await import('../../../src/main/claude-headless')
// The quit hold is the real one (quit-hold.ts).
const { beginQuitHold, _resetQuitHoldForTest } = await import('../../../src/main/quit-hold')

const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const savedRoot = process.env.SystemRoot
beforeEach(() => {
  h.bin = 'C:\\Users\\A\\.local\\bin\\claude.exe'
  h.order.length = 0
  h.warm.length = 0
  h.gate = null
  h.warmImpl = null
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  process.env.SystemRoot = 'C:\\Windows'
})
afterEach(() => {
  Object.defineProperty(process, 'platform', hostPlatform)
  if (savedRoot === undefined) delete process.env.SystemRoot
  else process.env.SystemRoot = savedRoot
  delete process.env.CCC_FIRST_START_MARK
})

describe('a headless Claude Code run on Windows (ADR-025)', () => {
  it('awaits the warm-up of the claude.exe found in PATH\'s folders before it starts it', async () => {
    let release!: () => void
    h.gate = new Promise<void>((r) => { release = r })
    const run = spawnClaudeHeadless(['--version'], 10_000)
    await vi.waitFor(() => expect(h.warm).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 10))
    expect(h.order).toEqual(['warm C:\\Users\\A\\.local\\bin\\claude.exe'])
    release()
    expect((await run).code).toBe(0)
    expect(h.order).toEqual(['warm C:\\Users\\A\\.local\\bin\\claude.exe', 'spawn C:\\Users\\A\\.local\\bin\\claude.exe'])
  })

  it('warms with Claude\'s --version environment, never the run\'s own', async () => {
    process.env.CCC_FIRST_START_MARK = 'never reaches a CLI run'
    await spawnClaudeHeadless(['--version'], 10_000)
    const env = (await (h.warm[0].env as () => Promise<{ env: Record<string, string> }> | { env: Record<string, string> })()).env
    expect(Object.keys(env).some((k) => k.toUpperCase().startsWith('CCC_'))).toBe(false)
    expect(env.NoDefaultCurrentDirectoryInExePath).toBe('1')
  })

  it('a run aborted while the warm-up runs starts nothing', async () => {
    let release!: () => void
    h.gate = new Promise<void>((r) => { release = r })
    const ac = new AbortController()
    const run = spawnClaudeHeadless(['-p'], 10_000, 'prompt', null, ac.signal)
    await vi.waitFor(() => expect(h.warm).toHaveLength(1))
    ac.abort()
    release()
    const res = await run
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('Aborted')
    expect(h.order).toEqual(['warm C:\\Users\\A\\.local\\bin\\claude.exe'])
  })

  it('a run aborted during the warm-up answers at once, without waiting for the warm-up to return', async () => {
    h.gate = new Promise<void>(() => { /* a warm-up that has not returned */ })
    const ac = new AbortController()
    const run = spawnClaudeHeadless(['-p'], 10_000, 'prompt', null, ac.signal)
    await vi.waitFor(() => expect(h.warm).toHaveLength(1))
    ac.abort()
    // Every promise step the abort sets off runs before the next timer.
    const res = await Promise.race([run, new Promise((r) => setTimeout(() => r('still waiting'), 0))])
    expect(res).toEqual({ code: 1, stdout: '', stderr: '\nAborted' })
    expect(h.order).toEqual(['warm C:\\Users\\A\\.local\\bin\\claude.exe'])
  })

  it('a run waiting on the warm-up when the app quits never starts claude', async () => {
    // The real warm-up, with a fake worker and fake file reads.
    const { createFirstStartWarmup } = await vi.importActual<typeof import('../../../src/main/first-start-warmup')>('../../../src/main/first-start-warmup')
    const answers: Array<(r: FirstStartRun) => void> = []
    const w = createFirstStartWarmup({
      platform: () => 'win32',
      realpath: async (p) => p,
      stat: async () => ({ size: 1, mtimeMs: 1, dev: '1', ino: '1', isFile: true }),
      startWorker: () => {
        let answer!: (r: FirstStartRun) => void
        const result = new Promise<FirstStartRun>((r) => { answer = r })
        answers.push(answer)
        // What the real worker answers once the quit ended its program.
        return { result, stop: () => answer({ exitCode: null, timedOut: false, spawnError: 'worker-ended' }) }
      },
      log: () => {},
      now: () => Date.now(),
    })
    h.warmImpl = (program, env) => w.warm(program, env as FirstStartEnvSource)
    // No abort signal: Sentinel's version checks and the Insights runs pass none.
    const run = spawnClaudeHeadless(['-p'], 10_000, 'prompt')
    let settled = false
    void run.then(() => { settled = true }, () => { settled = true })
    await vi.waitFor(() => expect(answers).toHaveLength(1))
    // The quit (index.ts: the warm-ups are flushed with the other provider CLI kills).
    w.stopAll()
    await new Promise((r) => setTimeout(r, 20))
    expect(h.order).toEqual(['warm C:\\Users\\A\\.local\\bin\\claude.exe'])
    expect(settled).toBe(false)
  })

  it('a run aborted before its start asks for no warm-up', async () => {
    const ac = new AbortController()
    ac.abort()
    const res = await spawnClaudeHeadless(['-p'], 10_000, 'prompt', null, ac.signal)
    expect(res).toEqual({ code: 1, stdout: '', stderr: '\nAborted' })
    expect(h.warm).toEqual([])
    expect(h.order).toEqual([])
  })

  it('an npm claude.cmd, which cmd.exe starts, is not warmed', async () => {
    h.bin = 'C:\\Npm\\claude.cmd'
    await spawnClaudeHeadless(['--version'], 10_000)
    expect(h.warm).toEqual([])
    expect(h.order).toEqual(['spawn C:\\Windows\\System32\\cmd.exe'])
  })
})

// A run asks for a warm-up only for a direct claude.exe on Windows, so on
// macOS and Linux, and for an npm claude.cmd, the warm-up's latch alone would
// not hold it after the quit teardown. The quit hold,
// which the teardown sets with that latch, holds every run, whatever the
// platform or the program; an abort still answers at once.
describe('a headless run asked for after the quit teardown', () => {
  /** 'pending' when `p` has not settled once every step it could take has run. */
  const stateOf = (p: Promise<unknown>) => Promise.race([p.then(() => 'settled', () => 'settled'), new Promise((r) => setTimeout(() => r('pending'), 20))])
  beforeEach(() => { _resetQuitHoldForTest() })
  afterEach(() => { _resetQuitHoldForTest() })

  it.each([
    ['an npm claude.cmd on Windows', 'win32', 'C:\\Npm\\claude.cmd'],
    ['a direct claude.exe on Windows', 'win32', 'C:\\Users\\A\\.local\\bin\\claude.exe'],
    ['macOS', 'darwin', null],
    ['Linux', 'linux', null],
  ] as Array<[string, NodeJS.Platform, string | null]>)('%s: starts nothing and is never answered', async (_label, platform, bin) => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    if (bin) h.bin = bin
    beginQuitHold()
    const run = spawnClaudeHeadless(['-p'], 10_000, 'prompt')
    expect(await stateOf(run)).toBe('pending') // the candidate: a spawn on macOS, Linux and for claude.cmd
    expect(h.order.filter((o) => o.startsWith('spawn '))).toEqual([])
  })

  it('a held run still answers an abort at once, and starts nothing', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    beginQuitHold()
    const ac = new AbortController()
    const run = spawnClaudeHeadless(['-p'], 10_000, 'prompt', null, ac.signal)
    expect(await stateOf(run)).toBe('pending')
    ac.abort()
    const res = await Promise.race([run, new Promise((r) => setTimeout(() => r('still waiting'), 0))])
    expect(res).toEqual({ code: 1, stdout: '', stderr: '\nAborted' })
    expect(h.order).toEqual([])
  })

  it('before the teardown, the same run on Linux starts (the control)', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    expect((await spawnClaudeHeadless(['-p'], 10_000, 'prompt')).code).toBe(0)
    expect(h.order).toEqual(['spawn claude'])
  })
})
