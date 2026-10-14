// ADR-025: the Accounts panel's `claude auth status` starts a claude.exe found
// in PATH's folders directly on Windows, on the main thread. Before that start
// it awaits the first-start warm-up of that same program, with Claude's
// --version environment (never the account's home); an npm claude.cmd
// (started through cmd.exe) is not warmed. The account stays held through the
// warm-up and the CLI run, and Claude Code switched off during the warm-up,
// or during an earlier wait with no warm-up, starts nothing. The lookup, the
// warm-up, the launch rule and the CLI start
// are faked and the platform is forced: nothing is started.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

const h = vi.hoisted(() => ({
  root: '',
  bin: 'C:\\Users\\A\\.local\\bin\\claude.exe',
  order: [] as string[],
  warm: [] as Array<{ program: string; env: () => unknown }>,
  gate: null as null | Promise<void>,
  /** When set, the CLI run answers only when the case calls finishRun. */
  holdRun: false,
  finishRun: null as null | (() => void),
  off: null as null | { code: 'provider-off'; providerId: 'claude'; message: string },
  /** When set, the PATH walk has no recent answer and runs until this settles. */
  lookupGate: null as null | Promise<void>,
  lookups: 0,
}))
type ExecCb = (err: Error | null, res?: { stdout: string; stderr: string }) => void
vi.mock('node:child_process', () => ({
  execFile: (file: string, _args: string[], _opts: unknown, cb: ExecCb) => {
    h.order.push(`start ${file}`)
    const answer = () => cb(null, { stdout: JSON.stringify({ loggedIn: true }), stderr: '' })
    if (h.holdRun) h.finishRun = answer
    else answer()
  },
}))
// Claude Code on, unless a case switches it off.
vi.mock('../../../src/main/provider-launch-gate', () => ({ providerProbeRefusal: () => h.off, providerLaunchRefusal: () => h.off }))
vi.mock('../../../src/main/claude-cli-probe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/claude-cli-probe')>()),
  recentClaudeOnWindows: () => (h.lookupGate ? null : h.bin),
  findClaudeOnWindowsAsync: async () => {
    h.lookups += 1
    if (h.lookupGate) await h.lookupGate
    return h.bin
  },
}))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/managed-launch-diagnostics', () => ({ gateManagedLaunch: async () => ({ status: 'clean' }), peekGateVerdict: () => ({ status: 'clean' }) }))
vi.mock('../../../src/main/account-profiles', async () => ({
  ...(await vi.importActual<typeof import('../../../src/main/account-profiles')>('../../../src/main/account-profiles')),
  getProfilesRoot: () => h.root,
  getProfileConfigDir: (id: string) => join(h.root, id),
  withProfileHome: (env: Record<string, string>) => env,
  profileCredentialFoldersChecked: () => true,
}))
vi.mock('../../../src/main/first-start-warmup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/first-start-warmup')>()),
  warmFirstStart: async (program: string, env: () => unknown) => {
    h.warm.push({ program, env })
    h.order.push(`warm ${program}`)
    if (h.gate) await h.gate
    return { outcome: 'ran', exitCode: 0, timedOut: false }
  },
}))

const { readClaudeCliAuth } = await import('../../../src/main/account-web/claude-cli-auth')
const { hasTransientProfileConsumer, PROFILE_CONSUMER_MAX_AGE_MS, _resetProfileConsumersForTest } = await import('../../../src/main/profile-consumers')
const { FIRST_START_CALLER_BOUND_MS } = await import('../../../src/main/first-start-warmup')
// The quit hold is the real one (quit-hold.ts).
const { beginQuitHold, _resetQuitHoldForTest } = await import('../../../src/main/quit-hold')

const ID = 'profile-abc-123'
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const savedRoot = process.env.SystemRoot
beforeEach(() => {
  h.root = fs.mkdtempSync(join(os.tmpdir(), 'ccc-first-start-auth-'))
  fs.mkdirSync(join(h.root, ID))
  h.bin = 'C:\\Users\\A\\.local\\bin\\claude.exe'
  h.order.length = 0
  h.warm.length = 0
  h.gate = null
  h.holdRun = false
  h.finishRun = null
  h.off = null
  h.lookupGate = null
  h.lookups = 0
  _resetProfileConsumersForTest()
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  process.env.SystemRoot = 'C:\\Windows'
})
afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(process, 'platform', hostPlatform)
  if (savedRoot === undefined) delete process.env.SystemRoot
  else process.env.SystemRoot = savedRoot
  delete process.env.CCC_FIRST_START_MARK
  // TEST CLEANUP GUARD: only this suite's own folder, by its prefix and parent.
  if (h.root.startsWith(join(os.tmpdir(), 'ccc-first-start-auth-'))) fs.rmSync(h.root, { recursive: true, force: true })
})

describe('the Accounts panel\'s claude auth status on Windows (ADR-025)', () => {
  it('awaits the warm-up of the claude.exe found in PATH\'s folders before it starts it', async () => {
    let release!: () => void
    h.gate = new Promise<void>((r) => { release = r })
    const read = readClaudeCliAuth(ID)
    await vi.waitFor(() => expect(h.warm).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 10))
    expect(h.order).toEqual([`warm ${h.bin}`])
    release()
    expect((await read).source).toBe('cli-status')
    expect(h.order).toEqual([`warm ${h.bin}`, `start ${h.bin}`])
  })

  it('warms with Claude\'s --version environment, never the account\'s home', async () => {
    process.env.CCC_FIRST_START_MARK = 'never reaches a CLI run'
    await readClaudeCliAuth(ID)
    const env = (await (h.warm[0].env as () => Promise<{ env: Record<string, string> }> | { env: Record<string, string> })()).env
    expect(Object.keys(env).some((k) => k.toUpperCase().startsWith('CCC_'))).toBe(false)
    expect(env.NoDefaultCurrentDirectoryInExePath).toBe('1')
    expect(JSON.stringify(env)).not.toContain(h.root.replace(/\\/g, '\\\\'))
  })

  it('the account stays held through a warm-up and a status run longer than the default 30 s hold', async () => {
    // Only the clock is fake: a hold's age is read from Date.now().
    vi.useFakeTimers({ toFake: ['Date'] })
    const t0 = Date.now()
    let release!: () => void
    h.gate = new Promise<void>((r) => { release = r })
    h.holdRun = true
    const read = readClaudeCliAuth(ID)
    try {
      await vi.waitFor(() => expect(h.warm).toHaveLength(1))
      expect(hasTransientProfileConsumer(ID)).toBe(true)
      // Still in the warm-up, past the default hold (the steps before it, the PATH walk and the
      // project gate, take their own time).
      vi.setSystemTime(t0 + PROFILE_CONSUMER_MAX_AGE_MS + 1_000)
      expect(hasTransientProfileConsumer(ID)).toBe(true)
      release()
      await vi.waitFor(() => expect(h.finishRun).not.toBeNull())
      // The warm-up's longest wait, then the CLI's own 10 s time limit, both under way.
      vi.setSystemTime(t0 + PROFILE_CONSUMER_MAX_AGE_MS + FIRST_START_CALLER_BOUND_MS + 10_000)
      expect(hasTransientProfileConsumer(ID)).toBe(true)
    } finally {
      // Whatever was checked above, the probe ends here, so no later case joins it.
      h.holdRun = false
      release()
      h.finishRun?.()
    }
    expect((await read).source).toBe('cli-status')
    expect(hasTransientProfileConsumer(ID)).toBe(false)
  })

  it('Claude Code switched off during the warm-up: the status is not read in the account\'s home', async () => {
    let release!: () => void
    h.gate = new Promise<void>((r) => { release = r })
    const read = readClaudeCliAuth(ID)
    try {
      await vi.waitFor(() => expect(h.warm).toHaveLength(1))
      h.off = { code: 'provider-off', providerId: 'claude', message: 'Claude Code is off. Turn it on in Settings, Accounts.' }
    } finally {
      release()
    }
    expect(await read).toEqual({ authenticated: false, notChecked: 'Claude Code is off. Turn it on in Settings, Accounts.' })
    expect(h.order).toEqual([`warm ${h.bin}`])
    expect(hasTransientProfileConsumer(ID)).toBe(false)
  })

  it('Claude Code switched off during an earlier wait, with no warm-up (an npm claude.cmd): the status is not read either', async () => {
    // The PATH walk with no recent answer stands in for every wait before the run (a token
    // refresh under way, the project gate, the sign-in folder check); none of them warms.
    h.bin = 'C:\\Npm\\claude.cmd'
    let release!: () => void
    h.lookupGate = new Promise<void>((r) => { release = r })
    const read = readClaudeCliAuth(ID)
    try {
      await vi.waitFor(() => expect(h.lookups).toBe(1))
      h.off = { code: 'provider-off', providerId: 'claude', message: 'Claude Code is off. Turn it on in Settings, Accounts.' }
    } finally {
      release()
    }
    expect(await read).toEqual({ authenticated: false, notChecked: 'Claude Code is off. Turn it on in Settings, Accounts.' })
    expect(h.warm).toEqual([])
    expect(h.order).toEqual([])
    expect(hasTransientProfileConsumer(ID)).toBe(false)
  })

  it('an npm claude.cmd, which cmd.exe starts, is not warmed', async () => {
    h.bin = 'C:\\Npm\\claude.cmd'
    await readClaudeCliAuth(ID)
    expect(h.warm).toEqual([])
    expect(h.order).toEqual(['start C:\\Windows\\System32\\cmd.exe'])
  })
})

// The status asks for a warm-up only for a direct claude.exe on Windows, so
// on macOS and Linux, and for an npm claude.cmd, the warm-up's latch alone
// does not hold it after the quit teardown.
// The quit hold, which the teardown sets with that latch, holds it whatever
// the platform or the program, and through the runner too: nothing starts in
// the account's home, the account is let go, and the probe is never answered.
describe('claude auth status asked for after the quit teardown', () => {
  /** 'pending' when `p` has not settled once every step it could take has run. */
  const stateOf = (p: Promise<unknown>) => Promise.race([p.then(() => 'settled', () => 'settled'), new Promise((r) => setTimeout(() => r('pending'), 20))])
  // A profile of each case's own: a held probe stays the one in flight for its profile.
  let n = 0
  const freshProfile = (): string => {
    const id = `profile-quit-${++n}`
    fs.mkdirSync(join(h.root, id))
    return id
  }
  beforeEach(() => { _resetQuitHoldForTest() })
  afterEach(() => { _resetQuitHoldForTest() })

  it.each([
    ['an npm claude.cmd on Windows', 'win32', 'C:\\Npm\\claude.cmd'],
    ['a direct claude.exe on Windows', 'win32', 'C:\\Users\\A\\.local\\bin\\claude.exe'],
    ['Linux', 'linux', null],
  ] as Array<[string, NodeJS.Platform, string | null]>)('%s: nothing starts, the account is let go, and the probe is never answered', async (_label, platform, bin) => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    if (bin) h.bin = bin
    const id = freshProfile()
    beginQuitHold()
    const read = readClaudeCliAuth(id)
    expect(await stateOf(read)).toBe('pending') // the candidate: a start on Linux and for claude.cmd
    expect(h.order.filter((o) => o.startsWith('start '))).toEqual([])
    expect(hasTransientProfileConsumer(id)).toBe(false)
  })

  // Mutation to prove this can fail: on the runner route, return the held
  // promise outside the try/finally that lets the account go.
  it('through the runner (the provider-neutral check): nothing runs, and the account is let go', async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true }), timedOut: false }))
    const id = freshProfile()
    beginQuitHold()
    const read = readClaudeCliAuth(id, { cwd: h.root, run })
    expect(await stateOf(read)).toBe('pending')
    expect(run).not.toHaveBeenCalled()
    expect(hasTransientProfileConsumer(id)).toBe(false)
  })

  it('before the teardown, the same status on Linux is read (the control)', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    expect((await readClaudeCliAuth(freshProfile())).source).toBe('cli-status')
    expect(h.order.filter((o) => o.startsWith('start '))).toHaveLength(1)
  })
})
