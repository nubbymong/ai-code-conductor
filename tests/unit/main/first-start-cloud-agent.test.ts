// ADR-025: a cloud agent starts a claude.exe found in PATH's folders directly
// on Windows, on the main thread. Before that start it awaits the first-start
// warm-up of that same program, with Claude's --version environment, inside
// the agent's account hold (the account reads as in use while it runs, and the
// account refresh wait comes after it); an agent cancelled during the wait
// starts nothing and stays cancelled; one waiting on it when the app quits
// never starts; an npm claude.cmd (started through cmd.exe) is not warmed. The
// PATH walk's file test, the warm-up and child_process are faked, and the
// platform is forced: nothing is started.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import type { FirstStartEnvSource, FirstStartRun } from '../../../src/main/first-start-warmup'

const h = vi.hoisted(() => ({
  present: new Set<string>(),
  order: [] as string[],
  warm: [] as Array<{ program: string; env: () => unknown }>,
  gate: null as null | Promise<void>,
  /** A case's own warm-up in place of the fake below. */
  warmImpl: null as null | ((program: string, env: () => unknown) => Promise<unknown>),
  /** The folder that stands in for the account's home (it must exist). */
  home: '',
  inUseDuringWarm: null as null | boolean,
}))
const PROFILE_ID = 'profile-abc-123'

vi.mock('../../../src/main/provider-launch-gate', () => ({ providerLaunchRefusal: () => null, providerProbeRefusal: () => null }))
vi.mock('../../../src/main/managed-launch-diagnostics', () => ({ gateManagedLaunch: async () => ({ status: 'clean' }), peekGateVerdict: () => undefined }))
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn: (file: string) => {
    h.order.push(`spawn ${file}`)
    return { pid: 777, stdin: { on: vi.fn(), end: vi.fn(), write: vi.fn() }, stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, on: vi.fn(), kill: vi.fn() }
  },
  spawnSync: () => ({ status: 0 }),
  execSync: () => '',
}))
vi.mock('../../../src/main/windows-programs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/windows-programs')>()
  return {
    ...real,
    findOnWindowsPath: (names: string[], env: NodeJS.ProcessEnv, _stat?: unknown, order?: 'folder' | 'name') =>
      real.findOnWindowsPath(names, env, (p) => h.present.has(p.toLowerCase()), order),
    findOnWindowsPathAsync: async (names: string[], env: NodeJS.ProcessEnv, _stat?: unknown, order?: 'folder' | 'name') =>
      real.findOnWindowsPath(names, env, (p) => h.present.has(p.toLowerCase()), order),
  }
})
vi.mock('../../../src/main/config-manager', () => ({
  readConfig: () => null,
  readConfigChecked: () => ({ value: null, outcome: 'absent' }),
  writeConfig: () => true,
  getConfigDir: () => '/mock/CONFIG',
  ensureConfigDir: vi.fn(),
}))
vi.mock('../../../src/main/legacy-version-manager', () => ({
  resolveVersionBinary: () => null,
  isVersionInstalled: () => false,
  installVersion: async () => ({ ok: false, error: 'not in this test' }),
  legacyCliPin: () => undefined,
}))
vi.mock('../../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
  getPrimaryProfileId: () => null,
  getProfileConfigDir: (id: string) => (id === PROFILE_ID && h.home ? h.home : `/nonexistent/profiles/${id}`),
  setupProfileLinks: vi.fn(),
  listProfiles: () => [],
}))
// The agent's environment is not what these cases are about.
vi.mock('../../../src/main/pty-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/pty-manager')>()),
  withProfileHome: (env: Record<string, string>) => env,
}))
// The account hold and the account refresh wait are the real ones, recorded in order.
vi.mock('../../../src/main/profile-consumers', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/profile-consumers')>()
  return {
    ...real,
    acquireProfileConsumer: (id: string, opts?: { maxAgeMs?: number }) => { h.order.push(`hold ${id}`); return real.acquireProfileConsumer(id, opts) },
    waitForProfileRefresh: (id: string) => { h.order.push(`refresh-wait ${id}`); return real.waitForProfileRefresh(id) },
  }
})
vi.mock('../../../src/main/first-start-warmup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/first-start-warmup')>()),
  warmFirstStart: async (program: string, env: () => unknown) => {
    h.warm.push({ program, env })
    h.order.push(`warm ${program}`)
    if (h.warmImpl) return h.warmImpl(program, env)
    if (h.inUseDuringWarm === null) {
      const { isProfileInUseByLiveSession } = await import('../../../src/main/claude-account-identity')
      h.inUseDuringWarm = isProfileInUseByLiveSession(PROFILE_ID)
    }
    if (h.gate) await h.gate
    return { outcome: 'ran', exitCode: 0, timedOut: false }
  },
}))

const { composeProviders } = await import('../../../src/main/providers/compose')
const { initCloudAgentManager, dispatchAgent, cancelAgent, killAllAgents, listAgents, _resetCloudAgentLatchForTest } = await import('../../../src/main/cloud-agent-manager')
const { _resetClaudeWindowsLookupForTest } = await import('../../../src/main/claude-cli-probe')
const { createFirstStartWarmup } = await import('../../../src/main/first-start-warmup')
const { _resetProfileConsumersForTest, hasTransientProfileConsumer } = await import('../../../src/main/profile-consumers')
// The quit hold is the real one (quit-hold.ts).
const { beginQuitHold, _resetQuitHoldForTest } = await import('../../../src/main/quit-hold')

const EXE = 'C:\\Tools\\claude.exe'
const HOME_PREFIX = 'ccc-agent-home-'
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const saved = { path: process.env.PATH, root: process.env.SystemRoot }

beforeAll(() => { composeProviders() })
beforeEach(() => {
  h.order.length = 0
  h.warm.length = 0
  h.gate = null
  h.warmImpl = null
  h.home = ''
  h.inUseDuringWarm = null
  h.present = new Set()
  _resetProfileConsumersForTest()
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  process.env.PATH = 'C:\\Npm;C:\\Tools'
  process.env.SystemRoot = 'C:\\Windows'
  _resetClaudeWindowsLookupForTest()
  _resetCloudAgentLatchForTest()
  initCloudAgentManager(() => null)
})
afterEach(() => {
  killAllAgents()
  // TEST CLEANUP GUARD: only this suite's own folder, by its prefix and parent.
  if (h.home && h.home.startsWith(join(os.tmpdir(), HOME_PREFIX))) fs.rmSync(h.home, { recursive: true, force: true })
  Object.defineProperty(process, 'platform', hostPlatform)
  if (saved.path === undefined) delete process.env.PATH
  else process.env.PATH = saved.path
  if (saved.root === undefined) delete process.env.SystemRoot
  else process.env.SystemRoot = saved.root
  delete process.env.CCC_FIRST_START_MARK
})

describe('a cloud agent on Windows (ADR-025)', () => {
  it('awaits the warm-up of the claude.exe found in PATH\'s folders before it starts it', async () => {
    h.present = new Set([EXE.toLowerCase()])
    let release!: () => void
    h.gate = new Promise<void>((r) => { release = r })
    const dispatched = dispatchAgent({ name: 'A', description: 'Summarise.', projectPath: 'C:\\dev\\project' })
    await vi.waitFor(() => expect(h.warm).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 10))
    expect(h.order).toEqual([`warm ${EXE}`])
    release()
    expect(((await dispatched) as { status: string }).status).toBe('running')
    expect(h.order).toEqual([`warm ${EXE}`, `spawn ${EXE}`])
  })

  it('warms with Claude\'s --version environment, never the agent\'s own', async () => {
    h.present = new Set([EXE.toLowerCase()])
    process.env.CCC_FIRST_START_MARK = 'never reaches a CLI run'
    await dispatchAgent({ name: 'A', description: 'Summarise.', projectPath: 'C:\\dev\\project' })
    const env = (await (h.warm[0].env as () => Promise<{ env: Record<string, string> }> | { env: Record<string, string> })()).env
    expect(Object.keys(env).some((k) => k.toUpperCase().startsWith('CCC_'))).toBe(false)
    expect(env.NoDefaultCurrentDirectoryInExePath).toBe('1')
  })

  it('an agent cancelled while the warm-up runs starts nothing and stays cancelled', async () => {
    h.present = new Set([EXE.toLowerCase()])
    let release!: () => void
    h.gate = new Promise<void>((r) => { release = r })
    const dispatched = dispatchAgent({ name: 'A', description: 'Summarise.', projectPath: 'C:\\dev\\project' })
    await vi.waitFor(() => expect(h.warm).toHaveLength(1))
    for (const a of listAgents()) cancelAgent(a.id)
    release()
    const agent = (await dispatched) as { status: string; error?: string }
    expect(agent.status).toBe('cancelled')
    expect(agent.error).toBeUndefined()
    expect(h.order).toEqual([`warm ${EXE}`])
  })

  it('the account is held before the warm-up starts and reads as in use during it; the account refresh wait comes after it', async () => {
    h.present = new Set([EXE.toLowerCase()])
    // A fresh folder of this case's own: the account's home is only checked for being there.
    h.home = fs.mkdtempSync(join(os.tmpdir(), HOME_PREFIX))
    const agent = (await dispatchAgent({ name: 'A', description: 'Summarise.', projectPath: 'C:\\dev\\project', profileId: PROFILE_ID })) as { status: string; profileId?: string }
    expect(agent.profileId).toBe(PROFILE_ID)
    expect(agent.status).toBe('running')
    expect(h.order).toEqual([`hold ${PROFILE_ID}`, `warm ${EXE}`, `refresh-wait ${PROFILE_ID}`, `spawn ${EXE}`])
    // So a sign-out of the account during the warm-up is refused (claude-cli-auth.ts logoutClaudeCli).
    expect(h.inUseDuringWarm).toBe(true)
  })

  it('an agent waiting on the warm-up when the app quits never starts claude -p', async () => {
    h.present = new Set([EXE.toLowerCase()])
    // The real warm-up, with a fake worker and fake file reads.
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
    const dispatched = dispatchAgent({ name: 'A', description: 'Summarise.', projectPath: 'C:\\dev\\project', skipPermissions: true })
    let settled = false
    void dispatched.then(() => { settled = true }, () => { settled = true })
    await vi.waitFor(() => expect(answers).toHaveLength(1))
    // The quit (index.ts: flushPendingProviderCliKills, then killAllAgents and killAllPty).
    w.stopAll()
    killAllAgents()
    await new Promise((r) => setTimeout(r, 20))
    expect(h.order).toEqual([`warm ${EXE}`])
    expect(settled).toBe(false)
  })

  it('an npm claude.cmd, which cmd.exe starts, is not warmed', async () => {
    h.present = new Set(['c:\\npm\\claude.cmd'])
    await dispatchAgent({ name: 'A', description: 'Summarise.', projectPath: 'C:\\dev\\project' })
    expect(h.warm).toEqual([])
    expect(h.order).toEqual(['spawn C:\\Windows\\System32\\cmd.exe'])
  })
})

// An agent asks for a warm-up only for a direct claude.exe on Windows, so on
// macOS and Linux, and for an npm claude.cmd, the warm-up's latch alone would
// not hold it after the quit teardown. The quit hold,
// which the teardown sets with that latch, holds every agent, whatever the
// platform or the program: the prompt file is removed, and the dispatch is
// never answered.
describe('a cloud agent asked for after the quit teardown', () => {
  /** 'pending' when `p` has not settled once every step it could take has run. */
  const stateOf = (p: Promise<unknown>) => Promise.race([p.then(() => 'settled', () => 'settled'), new Promise((r) => setTimeout(() => r('pending'), 20))])
  /** Whether the newest agent's prompt file is in the temp folder. */
  const promptFileLeft = () => fs.existsSync(join(os.tmpdir(), `ccc-agent-${listAgents()[0]?.id}.txt`))
  beforeEach(() => { _resetQuitHoldForTest() })
  afterEach(() => { _resetQuitHoldForTest() })

  it.each([
    ['an npm claude.cmd on Windows', 'win32', 'c:\\npm\\claude.cmd'],
    ['a direct claude.exe on Windows', 'win32', EXE.toLowerCase()],
    ['Linux', 'linux', null],
  ] as Array<[string, NodeJS.Platform, string | null]>)('%s: starts nothing, leaves no prompt file, and is never answered', async (_label, platform, present) => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    if (present) h.present = new Set([present])
    beginQuitHold()
    const dispatched = dispatchAgent({ name: 'A', description: 'Summarise.', projectPath: 'C:\\dev\\project' })
    expect(await stateOf(dispatched)).toBe('pending') // the candidate: a spawn on Linux and for claude.cmd
    expect(h.order.filter((o) => o.startsWith('spawn '))).toEqual([])
    expect(listAgents()[0]?.name).toBe('A')
    expect(promptFileLeft()).toBe(false)
  })

  // The agent's account hold never expires (maxAgeMs Infinity), so a held
  // dispatch that kept it would leave the account in use for good after a
  // quit that was cancelled. Mutation to prove this can fail: drop
  // releaseProfile() from the held branch in cloud-agent-manager.ts.
  it('on Linux, an agent on an account lets the account go, and is never answered', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    // A fresh folder of this case's own: the account's home is only checked for being there.
    h.home = fs.mkdtempSync(join(os.tmpdir(), HOME_PREFIX))
    beginQuitHold()
    const dispatched = dispatchAgent({ name: 'A', description: 'Summarise.', projectPath: 'C:\\dev\\project', profileId: PROFILE_ID })
    expect(await stateOf(dispatched)).toBe('pending')
    // The account was held on the way (the hold comes before the refresh
    // wait), and is let go once the quit hold stops the start.
    expect(h.order).toEqual([`hold ${PROFILE_ID}`, `refresh-wait ${PROFILE_ID}`])
    expect(hasTransientProfileConsumer(PROFILE_ID)).toBe(false)
    expect(promptFileLeft()).toBe(false)
  })

  it('before the teardown, the same agent on Linux starts (the control)', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const agent = (await dispatchAgent({ name: 'A', description: 'Summarise.', projectPath: 'C:\\dev\\project' })) as { status: string }
    expect(agent.status).toBe('running')
    expect(h.order).toEqual(['spawn claude'])
  })
})
